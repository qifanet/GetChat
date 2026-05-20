/**
 * @file services/token_estimator.rs
 * @description Character-based token estimation for context window management.
 *
 * Uses simple heuristic:
 *   - CJK characters: ~2 chars per token
 *   - Non-CJK characters: ~3 chars per token
 *
 * This is intentionally imprecise — actual tokenization depends on the model's
 * BPE vocabulary. The estimate is used for context budgeting, not billing.
 */

use crate::dto::common::ToolDefinitionDto;
use crate::dto::streaming::ContextTokenBreakdownDto;
use crate::services::prompt_service::PromptMessage;

/// Estimate the number of tokens in a text string.
///
/// CJK characters (Unicode ranges for Han, Hiragana, Katakana, Hangul, CJK
/// punctuation) are counted at ~0.5 tokens per char. All other characters
/// are counted at ~0.33 tokens per char (≈3 chars per token).
pub fn estimate_tokens(text: &str) -> u32 {
    let mut cjk_chars: u32 = 0;
    let mut other_chars: u32 = 0;

    for ch in text.chars() {
        if is_cjk(ch) {
            cjk_chars += 1;
        } else {
            other_chars += 1;
        }
    }

    // CJK: ~2 chars per token → chars / 2
    // Non-CJK: ~3 chars per token → chars / 3
    let cjk_tokens = (cjk_chars + 1) / 2;
    let other_tokens = (other_chars + 2) / 3;
    cjk_tokens + other_tokens
}

/// Estimate tokens for one prompt message including model-format overhead.
pub fn estimate_prompt_message_tokens(msg: &PromptMessage) -> u32 {
    // Each message has overhead for role label, formatting, etc. (~4 tokens)
    let mut total: u32 = 4;
    total += estimate_tokens(&msg.content);
    if let Some(reasoning_content) = &msg.reasoning_content {
        total += estimate_tokens(reasoning_content);
    }
    if let Some(name) = &msg.name {
        total += estimate_tokens(name);
    }
    if let Some(tool_calls) = &msg.tool_calls {
        for tc in tool_calls {
            total += estimate_tokens(&tc.function.name);
            total += estimate_tokens(&tc.function.arguments);
        }
    }
    if let Some(tool_call_id) = &msg.tool_call_id {
        total += estimate_tokens(tool_call_id);
    }
    total
}

/// Estimate context usage by category for UI diagnostics.
pub fn estimate_messages_token_breakdown(messages: &[PromptMessage]) -> ContextTokenBreakdownDto {
    let mut breakdown = ContextTokenBreakdownDto {
        system_tokens: 0,
        tool_prompt_tokens: 0,
        user_tokens: 0,
        assistant_tokens: 0,
        tool_tokens: 0,
        compressed_context_tokens: 0,
        skill_prompt_tokens: 0,
    };

    for msg in messages {
        let tokens = estimate_prompt_message_tokens(msg);
        let role = msg.role.trim().to_ascii_uppercase();

        if msg.source_message_id.is_none()
            && msg.content.starts_with("[Compressed Context Summary]")
        {
            breakdown.compressed_context_tokens += tokens;
            continue;
        }

        if msg.source_message_id.is_none() && msg.content.starts_with("[Always-Active Rules]") {
            breakdown.skill_prompt_tokens += tokens;
            continue;
        }

        match role.as_str() {
            "SYSTEM" => breakdown.system_tokens += tokens,
            "USER" => breakdown.user_tokens += tokens,
            "ASSISTANT" => breakdown.assistant_tokens += tokens,
            "TOOL" => breakdown.tool_tokens += tokens,
            _ => breakdown.system_tokens += tokens,
        }
    }

    breakdown
}

pub fn sum_context_token_breakdown(breakdown: &ContextTokenBreakdownDto) -> u32 {
    breakdown.system_tokens
        + breakdown.tool_prompt_tokens
        + breakdown.user_tokens
        + breakdown.assistant_tokens
        + breakdown.tool_tokens
        + breakdown.compressed_context_tokens
        + breakdown.skill_prompt_tokens
}

/// Estimate tokens used by tool definitions sent alongside chat messages.
pub fn estimate_tool_definitions_tokens(tools: &[ToolDefinitionDto]) -> u32 {
    tools
        .iter()
        .map(|tool| {
            // Function/tool definitions are serialized beside messages and also
            // consume context budget, even though they are not chat messages.
            6 + estimate_tokens(&tool.function.name)
                + estimate_tokens(&tool.function.description)
                + estimate_tokens(&tool.function.parameters.to_string())
        })
        .sum()
}

/// Check if a character falls within CJK Unicode ranges.
fn is_cjk(ch: char) -> bool {
    matches!(
        ch,
        '\u{4E00}'..='\u{9FFF}'      // CJK Unified Ideographs
        | '\u{3400}'..='\u{4DBF}'    // CJK Unified Ideographs Extension A
        | '\u{20000}'..='\u{2A6DF}'  // CJK Unified Ideographs Extension B
        | '\u{2A700}'..='\u{2B73F}'  // CJK Unified Ideographs Extension C
        | '\u{2B740}'..='\u{2B81F}'  // CJK Unified Ideographs Extension D
        | '\u{F900}'..='\u{FAFF}'    // CJK Compatibility Ideographs
        | '\u{3040}'..='\u{309F}'    // Hiragana
        | '\u{30A0}'..='\u{30FF}'    // Katakana
        | '\u{AC00}'..='\u{D7AF}'    // Hangul Syllables
        | '\u{FF00}'..='\u{FFEF}'    // Fullwidth Forms (CJK punctuation etc.)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_ascii() {
        // "Hello world" = 11 chars, all non-CJK → ceil(11/3) = 4
        let tokens = estimate_tokens("Hello world");
        assert_eq!(tokens, 4);
    }

    #[test]
    fn test_estimate_cjk() {
        // "你好世界" = 4 CJK chars → ceil(4/2) = 2
        let tokens = estimate_tokens("你好世界");
        assert_eq!(tokens, 2);
    }

    #[test]
    fn test_estimate_mixed() {
        // "Hello 你好" = 5 non-CJK chars (including space) + 2 CJK chars
        // non-CJK: ceil(5/3) = 2, CJK: ceil(2/2) = 1, total = 3
        let tokens = estimate_tokens("Hello 你好");
        assert_eq!(tokens, 3);
    }

    #[test]
    fn test_empty_string() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn test_breakdown_matches_message_total() {
        let messages = vec![
            PromptMessage {
                source_message_id: None,
                role: "SYSTEM".to_string(),
                content: "[Always-Active Rules]\nBe concise".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
            PromptMessage {
                source_message_id: Some("msg_user".to_string()),
                role: "USER".to_string(),
                content: "Hello".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
            PromptMessage {
                source_message_id: Some("msg_tool".to_string()),
                role: "TOOL".to_string(),
                content: "{}".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: Some("call_1".to_string()),
                name: Some("read_file".to_string()),
            },
        ];

        let breakdown = estimate_messages_token_breakdown(&messages);

        assert!(breakdown.skill_prompt_tokens > 0);
        assert!(breakdown.user_tokens > 0);
        assert!(breakdown.tool_tokens > 0);
        let message_total: u32 = messages.iter().map(estimate_prompt_message_tokens).sum();
        assert_eq!(
            sum_context_token_breakdown(&breakdown),
            message_total
        );
    }
}
