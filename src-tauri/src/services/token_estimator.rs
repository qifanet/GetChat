/**
 * @file services/token_estimator.rs
 * @description Character-based token estimation for context window management.
 *
 * Uses simple heuristic:
 *   - CJK characters: ~0.8 token per char
 *   - ASCII letters/digits: ~4 chars per token
 *   - JSON punctuation/whitespace: discounted to avoid tool-output overcount
 *
 * This is intentionally imprecise — actual tokenization depends on the model's
 * BPE vocabulary. The estimate is used for context budgeting, not billing.
 */

use crate::dto::common::ToolDefinitionDto;
use crate::dto::streaming::ContextTokenBreakdownDto;
use crate::dto::streaming::ModelPromptMessageDto;
use crate::services::prompt_service::PromptMessage;
use serde_json::{json, Value};

const MESSAGE_FORMAT_OVERHEAD_TOKENS: u32 = 4;
const REQUEST_FORMAT_OVERHEAD_TOKENS: u32 = 12;
const REQUEST_ESTIMATE_SAFETY_MULTIPLIER: f32 = 1.05;

/// Estimate the number of tokens in a text string using conservative
/// character-class heuristics.
///
/// This intentionally favors context-safety over billing accuracy, but avoids
/// the previous over-counting of JSON-heavy tool results where every quote,
/// comma, and bracket was scored too aggressively.
pub fn estimate_tokens(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }
    let mut total: f32 = 0.0;
    for ch in text.chars() {
        if ch.is_ascii() {
            match ch {
                ' ' | '\t' | '\n' | '\r' => total += 0.05,
                '{' | '}' | '[' | ']' | '(' | ')' | ',' | ':' | ';' | '"' => total += 0.18,
                '0'..='9' => total += 0.25,
                'A'..='Z' | 'a'..='z' | '_' | '-' => total += 0.25,
                _ => total += 0.22,
            }
        } else if is_cjk(ch) {
            total += 0.8;
        } else {
            total += 0.5;
        }
    }
    total.ceil() as u32
}

fn normalize_role_for_provider(role: &str) -> &'static str {
    match role {
        "SYSTEM" | "system" => "system",
        "USER" | "user" => "user",
        "ASSISTANT" | "assistant" => "assistant",
        "TOOL" | "tool" => "tool",
        _ => "user",
    }
}

fn prompt_message_provider_json(msg: &PromptMessage) -> Value {
    let role = normalize_role_for_provider(&msg.role);
    let mut value = json!({
        "role": role,
        "content": &msg.content,
    });

    if let Some(reasoning_content) = msg
        .reasoning_content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        value["reasoning_content"] = json!(reasoning_content);
    }
    if let Some(tool_calls) = &msg.tool_calls {
        value["tool_calls"] = json!(tool_calls);
    }
    if let Some(tool_call_id) = &msg.tool_call_id {
        value["tool_call_id"] = json!(tool_call_id);
    }
    if let Some(name) = &msg.name {
        value["name"] = json!(name);
    }

    value
}

fn dto_message_provider_json(msg: &ModelPromptMessageDto) -> Value {
    let role = normalize_role_for_provider(&msg.role);
    let mut value = json!({
        "role": role,
        "content": &msg.content,
    });

    if let Some(reasoning_content) = msg
        .reasoning_content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        value["reasoning_content"] = json!(reasoning_content);
    }
    if let Some(tool_calls) = &msg.tool_calls {
        value["tool_calls"] = json!(tool_calls);
    }
    if let Some(tool_call_id) = &msg.tool_call_id {
        value["tool_call_id"] = json!(tool_call_id);
    }
    if let Some(name) = &msg.name {
        value["name"] = json!(name);
    }

    value
}

fn apply_request_safety_margin(tokens: u32) -> u32 {
    ((tokens as f32) * REQUEST_ESTIMATE_SAFETY_MULTIPLIER).ceil() as u32
}

/// Estimate tokens for one prompt message including model-format overhead.
pub fn estimate_prompt_message_tokens(msg: &PromptMessage) -> u32 {
    MESSAGE_FORMAT_OVERHEAD_TOKENS
        + estimate_tokens(&prompt_message_provider_json(msg).to_string())
}

/// Full token estimation for `ModelPromptMessageDto` — accounts for all fields
/// including tool_calls, reasoning_content, tool_call_id, and name.
pub fn estimate_dto_message_tokens(msg: &ModelPromptMessageDto) -> u32 {
    MESSAGE_FORMAT_OVERHEAD_TOKENS
        + estimate_tokens(&dto_message_provider_json(msg).to_string())
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
}

/// Estimate tokens used by tool definitions sent alongside chat messages.
pub fn estimate_tool_definitions_tokens(tools: &[ToolDefinitionDto]) -> u32 {
    if tools.is_empty() {
        return 0;
    }

    // Tool definitions are sent as a JSON array beside chat messages. Estimating
    // the serialized shape keeps UI status and ReAct checks on the same basis.
    6 + estimate_tokens(&serde_json::to_string(tools).unwrap_or_default())
}

/// Estimate a full runtime model request: chat messages, tool definitions, and
/// request-level formatting overhead. This is the preferred entry point for
/// ReAct loop context-budget checks.
pub fn estimate_model_request_tokens(
    messages: &[ModelPromptMessageDto],
    tools: &[ToolDefinitionDto],
) -> u32 {
    let message_tokens: u32 = messages.iter().map(estimate_dto_message_tokens).sum();
    let raw = message_tokens
        .saturating_add(estimate_tool_definitions_tokens(tools))
        .saturating_add(REQUEST_FORMAT_OVERHEAD_TOKENS);
    apply_request_safety_margin(raw)
}

/// Estimate a full request from persisted prompt messages. Used by context UI
/// status so it stays consistent with runtime streaming checks.
pub fn estimate_prompt_model_request_tokens(
    messages: &[PromptMessage],
    tools: &[ToolDefinitionDto],
) -> u32 {
    let message_tokens: u32 = messages.iter().map(estimate_prompt_message_tokens).sum();
    let raw = message_tokens
        .saturating_add(estimate_tool_definitions_tokens(tools))
        .saturating_add(REQUEST_FORMAT_OVERHEAD_TOKENS);
    apply_request_safety_margin(raw)
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
        // "Hello world" = 10 letters * 0.25 + 1 space * 0.05 = 2.55 → ceil = 3
        let tokens = estimate_tokens("Hello world");
        assert_eq!(tokens, 3);
    }

    #[test]
    fn test_estimate_cjk() {
        // "你好世界" = 4 CJK chars * 0.8 = 3.2 → 4
        let tokens = estimate_tokens("你好世界");
        assert_eq!(tokens, 4);
    }

    #[test]
    fn test_estimate_mixed() {
        // "Hello 你好" = 5 letters * 0.25 + 1 space * 0.05 + 2 CJK * 0.8 = 2.9 → 3
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

        // [Always-Active Rules] is now classified as system_tokens
        assert!(breakdown.system_tokens > 0);
        assert!(breakdown.user_tokens > 0);
        assert!(breakdown.tool_tokens > 0);
        let message_total: u32 = messages.iter().map(estimate_prompt_message_tokens).sum();
        assert_eq!(
            sum_context_token_breakdown(&breakdown),
            message_total
        );
    }
}
