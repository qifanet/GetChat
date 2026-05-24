/**
 * @file services/importance_scorer.rs
 * @description Rule-based importance scoring for conversation messages.
 *
 * Phase 2 of context management: each message receives an importance score
 * in [0.0, 1.0] that determines retention priority during compression.
 *
 * Scoring is entirely rule-based (no AI calls) for speed and determinism.
 * Scores are computed on-the-fly during compression rather than persisted,
 * because the same message's relative importance shifts as the conversation
 * grows.
 */

use crate::services::prompt_service::PromptMessage;

// ============================================================================
// Score Types
// ============================================================================

/// Importance score in the range [0.0, 1.0].
pub type Score = f32;

/// Categorized message kind for scoring.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MessageKind {
    /// User-authored message.
    User,
    /// Assistant message with substantial content (code, explanation, plan).
    AssistantSubstantive,
    /// Assistant message that is a brief acknowledgement or filler.
    AssistantTrivial,
    /// Tool call result marked as successful.
    ToolResultSuccess,
    /// Tool call result marked as failed.
    ToolResultFailed,
    /// Synthetic system prompt or compressed context summary.
    SystemPrefix,
}

/// Compression level determines which messages survive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CompressionLevel {
    /// usage < 60%: no compression needed.
    None,
    /// usage >= 60%: summarize messages with score < 0.3.
    Level1,
    /// usage >= 80%: summarize messages with score < 0.6.
    Level2,
    /// usage >= 95%: emergency — keep only score >= 0.8 + latest summary.
    Level3,
}

impl CompressionLevel {
    pub fn from_usage_ratio(ratio: f32) -> Self {
        if ratio >= 0.95 {
            CompressionLevel::Level3
        } else if ratio >= 0.80 {
            CompressionLevel::Level2
        } else if ratio >= 0.60 {
            CompressionLevel::Level1
        } else {
            CompressionLevel::None
        }
    }

    /// Minimum score a message must have to survive at this compression level.
    pub fn retention_threshold(&self) -> Score {
        match self {
            CompressionLevel::None => 0.0,
            CompressionLevel::Level1 => 0.3,
            CompressionLevel::Level2 => 0.6,
            CompressionLevel::Level3 => 0.8,
        }
    }
}

// ============================================================================
// Classification
// ============================================================================

/// Classify a prompt message into a scoring category.
pub fn classify_message(msg: &PromptMessage) -> MessageKind {
    let role = msg.role.trim().to_ascii_uppercase();

    // Synthetic prefixes (system prompt, skills, compressed context) are
    // always retained — they score high but are handled separately.
    if msg.source_message_id.is_none() {
        return MessageKind::SystemPrefix;
    }

    match role.as_str() {
        "USER" => MessageKind::User,
        "ASSISTANT" => {
            if is_trivial_assistant_response(&msg.content) {
                MessageKind::AssistantTrivial
            } else {
                MessageKind::AssistantSubstantive
            }
        }
        "TOOL" => {
            if is_failed_tool_result(&msg.content) {
                MessageKind::ToolResultFailed
            } else {
                MessageKind::ToolResultSuccess
            }
        }
        _ => MessageKind::SystemPrefix,
    }
}

/// Detect trivial assistant responses (acknowledgements, short confirmations).
fn is_trivial_assistant_response(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return true;
    }

    // Very short responses are likely trivial
    let char_count = trimmed.chars().count();
    if char_count <= 20 {
        return true;
    }

    // Common trivial patterns
    let lower = trimmed.to_ascii_lowercase();
    let trivial_prefixes = [
        "好的",
        "明白",
        "了解",
        "收到",
        "没问题",
        "是的",
        "对",
        "ok",
        "sure",
        "yes",
        "got it",
        "understood",
        "i see",
        "noted",
        "done",
        "correct",
        "right",
        "好的，",
        "好的!",
        "没问题，",
    ];

    // Check if the entire response (after trimming punctuation) is trivial
    let stripped = lower
        .trim_end_matches('.')
        .trim_end_matches('!')
        .trim_end_matches('。')
        .trim_end_matches('！');
    if trivial_prefixes.iter().any(|p| stripped == *p) {
        return true;
    }

    // Short response ending with period/exclamation that starts with a trivial prefix
    if char_count <= 60 && trivial_prefixes.iter().any(|p| lower.starts_with(p)) {
        return true;
    }

    false
}

/// Detect failed tool results from content patterns.
fn is_failed_tool_result(content: &str) -> bool {
    if content.is_empty() {
        return true;
    }

    let lower = content.to_ascii_lowercase();
    let failure_indicators = [
        "\"error\"",
        "\"success\":false",
        "\"ok\":false",
        "\"status\":\"error\"",
        "\"status\":\"failed\"",
        "command failed",
        "not found",
        "permission denied",
        "no such file",
        "exit code",
    ];

    failure_indicators.iter().any(|ind| lower.contains(ind))
}

// ============================================================================
// Scoring
// ============================================================================

/// Heuristic patterns for content-based score adjustments.
const CODE_INDICATORS: &[&str] = &[
    "```", "fn ", "function ", "class ", "import ", "const ", "let ", "var ",
    "def ", "return ", "pub ", "#include", "package ", "use ", "<>", "{}",
    "()", "=>", "->",
];

const DECISION_KEYWORDS: &[&str] = &[
    "决定", "采用", "选择", "方案", "架构", "最终",
    "decided", "decision", "chosen", "will use", "going with",
    "the plan", "approach", "strategy", "architect",
];

/// Score a message given its classified kind and content.
fn score_by_kind(kind: MessageKind, content: &str) -> Score {
    let base = match kind {
        MessageKind::User => 0.8,
        MessageKind::AssistantSubstantive => 0.7,
        MessageKind::AssistantTrivial => 0.1,
        MessageKind::ToolResultSuccess => 0.3,
        MessageKind::ToolResultFailed => 0.2,
        MessageKind::SystemPrefix => 0.95,
    };

    let mut bonus: Score = 0.0;

    match kind {
        MessageKind::User => {
            if contains_code(content) {
                bonus += 0.1;
            }
            if contains_decision_keywords(content) {
                bonus += 0.1;
            }
        }
        MessageKind::AssistantSubstantive => {
            if contains_code(content) {
                bonus += 0.15;
            }
        }
        MessageKind::ToolResultSuccess => {
            if contains_key_data(content) {
                bonus += 0.2;
            }
        }
        MessageKind::AssistantTrivial | MessageKind::ToolResultFailed | MessageKind::SystemPrefix => {}
    }

    (base + bonus).min(1.0)
}

fn contains_code(content: &str) -> bool {
    // Code fence is a strong signal
    if content.contains("```") {
        return true;
    }
    // Heuristic: 2+ code indicators
    let hits = CODE_INDICATORS.iter().filter(|pat| content.contains(*pat)).count();
    hits >= 2
}

fn contains_decision_keywords(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    DECISION_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

/// Detect tool results containing substantive data (file contents, structured output).
fn contains_key_data(content: &str) -> bool {
    if content.is_empty() {
        return false;
    }
    let char_count = content.chars().count();
    // Long tool results likely contain useful data
    if char_count > 500 {
        return true;
    }
    // JSON with keys suggests structured data
    let lower = content.to_ascii_lowercase();
    lower.contains("\"path\"") || lower.contains("\"content\"") || lower.contains("\"result\"")
}

// ============================================================================
// Group Scoring
// ============================================================================

/// A scored prompt group with its importance score.
#[derive(Debug)]
pub struct ScoredGroup<'a> {
    /// Index in the original group list.
    pub index: usize,
    /// Messages in this group.
    pub messages: &'a [PromptMessage],
    /// The maximum score among messages in this group.
    pub score: Score,
}

/// Score a list of prompt groups (one group = one persisted message).
///
/// Each group's score is the maximum score of its individual messages.
/// This ensures that an assistant message with important code gets a high
/// score even if its tool results are less important.
pub fn score_groups(groups: &[Vec<PromptMessage>]) -> Vec<ScoredGroup<'_>> {
    groups
        .iter()
        .enumerate()
        .map(|(index, msgs)| {
            let mut best_score: Score = 0.0;
            for msg in msgs {
                let kind = classify_message(msg);
                let score = score_by_kind(kind, &msg.content);
                if score > best_score {
                    best_score = score;
                }
            }
            ScoredGroup {
                index,
                messages: msgs,
                score: best_score,
            }
        })
        .collect()
}

// ============================================================================
// Compression Plan
// ============================================================================

/// Decision for a single group during compression planning.
#[derive(Debug, Clone, PartialEq)]
pub enum GroupAction {
    /// Keep this group verbatim in the prompt.
    Keep,
    /// Include this group in the compression input (to be summarized).
    Compress,
    /// Drop this group entirely (emergency compression only).
    Drop,
}

/// A compression plan specifying what to do with each group.
#[derive(Debug)]
pub struct CompressionPlan<'a> {
    pub level: CompressionLevel,
    pub actions: Vec<(usize, GroupAction, &'a [PromptMessage])>,
    /// Total groups planned for compression.
    pub compress_count: usize,
    /// Total groups kept verbatim.
    pub keep_count: usize,
    /// Total groups dropped entirely.
    pub drop_count: usize,
}

/// Plan compression actions for scored groups.
///
/// Strategy:
///   - The latest `keep_recent` groups are always kept (recency bias).
///   - Among older groups, actions are determined by score vs. threshold.
///   - At Level 3, groups below the retention threshold are dropped entirely.
pub fn plan_compression<'a>(
    scored: &'a [ScoredGroup<'_>],
    level: CompressionLevel,
    keep_recent: usize,
) -> CompressionPlan<'a> {
    if level == CompressionLevel::None || scored.is_empty() {
        let actions: Vec<_> = scored
            .iter()
            .map(|sg| (sg.index, GroupAction::Keep, sg.messages))
            .collect();
        return CompressionPlan {
            level,
            actions,
            compress_count: 0,
            keep_count: scored.len(),
            drop_count: 0,
        };
    }

    let threshold = level.retention_threshold();
    let total = scored.len();
    let recent_start = total.saturating_sub(keep_recent);

    let mut compress_count = 0;
    let mut keep_count = 0;
    let mut drop_count = 0;
    let mut actions = Vec::with_capacity(total);

    for sg in scored {
        let action = if sg.index >= recent_start {
            // Recent groups always kept
            GroupAction::Keep
        } else if sg.score >= threshold {
            // Score high enough to survive
            GroupAction::Keep
        } else if level == CompressionLevel::Level3 {
            // Emergency: drop low-score groups entirely
            GroupAction::Drop
        } else {
            // Level 1/2: compress into summary
            GroupAction::Compress
        };

        match action {
            GroupAction::Keep => keep_count += 1,
            GroupAction::Compress => compress_count += 1,
            GroupAction::Drop => drop_count += 1,
        }

        actions.push((sg.index, action, sg.messages));
    }

    CompressionPlan {
        level,
        actions,
        compress_count,
        keep_count,
        drop_count,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn test_msg(id: &str, role: &str, content: &str) -> PromptMessage {
        PromptMessage {
            source_message_id: if id.is_empty() {
                None
            } else {
                Some(id.to_string())
            },
            role: role.to_string(),
            content: content.to_string(),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    fn score_message(msg: &PromptMessage) -> Score {
        let kind = classify_message(msg);
        score_by_kind(kind, &msg.content)
    }

    #[test]
    fn compression_level_from_ratio() {
        assert_eq!(CompressionLevel::from_usage_ratio(0.5), CompressionLevel::None);
        assert_eq!(CompressionLevel::from_usage_ratio(0.6), CompressionLevel::Level1);
        assert_eq!(CompressionLevel::from_usage_ratio(0.8), CompressionLevel::Level2);
        assert_eq!(CompressionLevel::from_usage_ratio(0.95), CompressionLevel::Level3);
    }

    #[test]
    fn user_message_base_score() {
        let msg = test_msg("u1", "USER", "How do I implement auth?");
        assert_eq!(score_message(&msg), 0.8);
    }

    #[test]
    fn user_message_with_code_bonus() {
        let msg = test_msg("u1", "USER", "Here is my code:\n```rust\nfn main() {}\n```");
        let score = score_message(&msg);
        assert!(score >= 0.9, "expected >= 0.9, got {}", score);
    }

    #[test]
    fn user_message_with_decision_bonus() {
        let msg = test_msg("u1", "USER", "We decided to use JWT for authentication");
        let score = score_message(&msg);
        assert!(score >= 0.9, "expected >= 0.9, got {}", score);
    }

    #[test]
    fn trivial_assistant_low_score() {
        let msg = test_msg("a1", "ASSISTANT", "好的");
        assert_eq!(score_message(&msg), 0.1);
    }

    #[test]
    fn substantive_assistant_base_score() {
        let msg = test_msg("a1", "ASSISTANT", "You should implement authentication using middleware.");
        let score = score_message(&msg);
        assert!(score >= 0.7, "expected >= 0.7, got {}", score);
    }

    #[test]
    fn assistant_with_code_bonus() {
        let msg = test_msg(
            "a1",
            "ASSISTANT",
            "Here's the implementation:\n```rust\nfn auth() -> Result<()> { Ok(()) }\n```",
        );
        let score = score_message(&msg);
        assert!(score >= 0.85, "expected >= 0.85, got {}", score);
    }

    #[test]
    fn tool_result_success_base() {
        let msg = test_msg("t1", "TOOL", "{\"ok\":true,\"data\":\"short\"}");
        assert_eq!(score_message(&msg), 0.3);
    }

    #[test]
    fn tool_result_success_with_key_data() {
        let long_content = (0..100).map(|i| format!("line {}", i)).collect::<Vec<_>>().join("\n");
        let msg = test_msg("t1", "TOOL", &long_content);
        let score = score_message(&msg);
        assert!(score >= 0.5, "expected >= 0.5, got {}", score);
    }

    #[test]
    fn tool_result_failed() {
        let msg = test_msg("t1", "TOOL", "{\"error\":\"file not found\"}");
        assert_eq!(score_message(&msg), 0.2);
    }

    #[test]
    fn system_prefix_high_score() {
        let msg = test_msg("", "SYSTEM", "You are a helpful assistant");
        assert_eq!(score_message(&msg), 0.95);
    }

    #[test]
    fn plan_level1_compresses_low_score() {
        let groups = vec![
            vec![test_msg("t1", "TOOL", "{\"error\":\"fail\"}")], // score 0.2
            vec![test_msg("u1", "USER", "important question")],  // score 0.8
            vec![test_msg("a1", "ASSISTANT", "好的")],            // score 0.1
            vec![test_msg("u2", "USER", "latest question")],     // score 0.8
        ];

        let scored = score_groups(&groups);
        let plan = plan_compression(&scored, CompressionLevel::Level1, 2);

        // Last 2 groups are kept (recent)
        // Group 0 (score 0.2 < 0.3): compress
        // Group 1 (score 0.8 >= 0.3): keep
        assert_eq!(plan.compress_count, 1);
        assert!(plan.keep_count >= 2);
    }

    #[test]
    fn plan_level3_drops_low_score() {
        let groups = vec![
            vec![test_msg("t1", "TOOL", "{\"error\":\"fail\"}")], // score 0.2
            vec![test_msg("u1", "USER", "important decision")],  // score ~0.9
            vec![test_msg("a1", "ASSISTANT", "ok")],             // score 0.1
            vec![test_msg("u2", "USER", "latest question")],     // score 0.8
        ];

        let scored = score_groups(&groups);
        let plan = plan_compression(&scored, CompressionLevel::Level3, 2);

        // Last 2 groups are kept
        // Group 0 (score 0.2 < 0.8): drop
        // Group 1 (score 0.9 >= 0.8): keep
        assert_eq!(plan.drop_count, 1);
        assert!(plan.keep_count >= 2);
    }

    #[test]
    fn score_capped_at_one() {
        let msg = test_msg(
            "u1",
            "USER",
            "We decided to use the following approach:\n```rust\nfn main() {}\n```",
        );
        let score = score_message(&msg);
        assert!(score <= 1.0, "expected <= 1.0, got {}", score);
    }
}
