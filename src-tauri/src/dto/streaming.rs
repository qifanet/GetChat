/**
 * @file dto/streaming.rs
 * @description DTOs for runtime model streaming between the Tauri backend
 *              and the frontend streaming controller.
 *
 * These DTOs are intentionally separate from persisted message DTOs because
 * they represent transient transport events rather than database entities.
 */

use serde::{Deserialize, Serialize};

use super::common::{GenerationParamsDto, TokenUsageDto, ToolCallDto, ToolDefinitionDto};

// ============================================================================
// Input Types
// ============================================================================

/**
 * A single prompt message that will be forwarded to a model provider.
 *
 * Supports both plain text messages and tool-calling messages:
 *   - role="user"/"system": content is the text, tool_calls is None
 *   - role="assistant" with tool calls: content may be empty, tool_calls has the calls
 *   - role="tool": content is the tool result, tool_call_id links to the call
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPromptMessageDto {
    /// Source DB message id when this prompt entry comes from a persisted
    /// message. Runtime-only tool loop messages keep this empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/**
 * Context window status for a conversation branch.
 * Returned by get_context_status for frontend visualization.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTokenBreakdownDto {
    pub system_tokens: u32,
    pub tool_prompt_tokens: u32,
    pub user_tokens: u32,
    pub assistant_tokens: u32,
    pub tool_tokens: u32,
    pub compressed_context_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextStatusDto {
    /// Estimate of the actual next model request after applying the same
    /// deterministic prompt budget trimming used before sending.
    pub used_tokens: u32,
    /// Untrimmed full-path estimate for diagnostics and compression decisions.
    pub raw_used_tokens: u32,
    pub total_tokens: u32,
    pub percentage: f32,
    pub raw_percentage: f32,
    pub message_count: u32,
    pub raw_message_count: u32,
    pub prompt_budget_tokens: u32,
    pub breakdown: ContextTokenBreakdownDto,
}

/**
 * Input for starting a provider-backed model stream.
 *
 * Unlike the persisted assistant placeholder commands, this DTO is purely
 * runtime-focused: it identifies the provider/model pair, carries the prompt
 * context, and binds the request to a request_id for cancellation/tracking.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartModelStreamInput {
    pub request_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub prompt_messages: Vec<ModelPromptMessageDto>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_params: Option<GenerationParamsDto>,

    /// Available tool definitions to send to the model.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinitionDto>,

    /// Tool selection strategy: "auto" | "none" | "required".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<String>,

    /// Conversation ID for context-aware tools (e.g. todo scoping).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,

    /// Current branch ID for branch-aware context compression.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,

    /// Skill name activated by the user via slash command (Tier 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activated_skill: Option<String>,
}

// ============================================================================
// Output Event Types
// ============================================================================

/**
 * Runtime streaming event emitted over a Tauri IPC channel.
 *
 * The frontend converts these transport events into calls to:
 *   - onStreamChunk()
 *   - onToolCall()
 *   - onToolResult()
 *   - completeStream()
 *   - failStream()
 *
 * This keeps the frontend renderer/store architecture provider-agnostic.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModelStreamEventDto {
    Chunk {
        #[serde(rename = "requestId")]
        request_id: String,
        chunk: String,
    },
    /// Emitted when the model requests a tool invocation.
    ToolCall {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(rename = "functionName")]
        function_name: String,
        arguments: String,
    },
    /// Emitted when a tool execution completes (success or failure).
    ToolResult {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        result: String,
        success: bool,
    },
    Completed {
        #[serde(rename = "requestId")]
        request_id: String,

        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsageDto>,

        /// "stop" for normal completion, "tool_calls" when model requested tools.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        finish_reason: Option<String>,

        /// Final tool calls when finish_reason is "tool_calls".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ToolCallDto>>,

        /// Hidden provider reasoning payload used only for later provider replay.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_content: Option<String>,
    },
    Failed {
        #[serde(rename = "requestId")]
        request_id: String,
        code: String,
        message: String,
        retriable: bool,
    },
    /// Emitted when a destructive tool requires user approval before execution.
    ApprovalRequired {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "approvalId")]
        approval_id: String,
        #[serde(rename = "functionName")]
        function_name: String,
        description: String,
        #[serde(rename = "timeoutSecs")]
        timeout_secs: u32,
    },
    /// Emitted before an automatic retry attempt after a retriable provider error.
    Retrying {
        #[serde(rename = "requestId")]
        request_id: String,
        /// Current retry attempt number (1-based).
        attempt: u32,
        /// Maximum number of retry attempts.
        #[serde(rename = "maxAttempts")]
        max_attempts: u32,
        /// Seconds until the next retry attempt.
        #[serde(rename = "nextRetryInSecs")]
        next_retry_in_secs: u32,
        /// Short summary of the error that triggered this retry.
        #[serde(rename = "errorSummary")]
        error_summary: String,
    },
    /// Emitted when the backend is performing mid-loop context compression.
    /// The frontend should show a non-blocking "Optimizing context..." indicator.
    ContextCompressing {
        #[serde(rename = "requestId")]
        request_id: String,
        /// Compression level being applied (1, 2, or 3).
        level: u8,
        /// Approximate usage ratio that triggered compression (0.0-1.0).
        #[serde(rename = "usageRatio")]
        usage_ratio: f32,
    },
    /// Emitted when a mid-loop compression attempt is intentionally skipped.
    /// This clears the frontend "optimizing context" state without showing a
    /// success card.
    ContextCompressionSkipped {
        #[serde(rename = "requestId")]
        request_id: String,
        reason: String,
        /// Usage ratio at the time compression was skipped (0.0-1.0).
        #[serde(rename = "usageRatio")]
        usage_ratio: f32,
    },
    /// Emitted on each ReAct-loop context-budget check so the frontend can
    /// reflect the in-flight request size without waiting for polling.
    ContextStatusUpdated {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "usedTokens")]
        used_tokens: u32,
        #[serde(rename = "totalTokens")]
        total_tokens: u32,
        percentage: f32,
        #[serde(rename = "messageCount")]
        message_count: u32,
    },
    /// Emitted after mid-loop context compression completes.
    ContextCompressed {
        #[serde(rename = "requestId")]
        request_id: String,
        /// Number of message groups that were summarized into the compressed context.
        #[serde(rename = "compressedCount")]
        compressed_count: u32,
        /// Estimated token savings from compression.
        #[serde(rename = "tokensSaved")]
        tokens_saved: u32,
        /// Updated usage ratio after compression (0.0-1.0).
        #[serde(rename = "newUsageRatio")]
        new_usage_ratio: f32,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_events_serialize_camel_case_fields() {
        let value = serde_json::to_value(ModelStreamEventDto::ContextCompressing {
            request_id: "req_1".to_string(),
            level: 2,
            usage_ratio: 0.75,
        })
        .expect("context compressing event should serialize");

        assert_eq!(value.get("kind").and_then(serde_json::Value::as_str), Some("CONTEXT_COMPRESSING"));
        assert!(value.get("usageRatio").is_some());
        assert!(value.get("usage_ratio").is_none());

        let value = serde_json::to_value(ModelStreamEventDto::ContextCompressed {
            request_id: "req_1".to_string(),
            compressed_count: 3,
            tokens_saved: 1200,
            new_usage_ratio: 0.42,
        })
        .expect("context compressed event should serialize");

        assert!(value.get("compressedCount").is_some());
        assert!(value.get("tokensSaved").is_some());
        assert!(value.get("newUsageRatio").is_some());
        assert!(value.get("compressed_count").is_none());
        assert!(value.get("tokens_saved").is_none());
        assert!(value.get("new_usage_ratio").is_none());

        let value = serde_json::to_value(ModelStreamEventDto::ContextStatusUpdated {
            request_id: "req_1".to_string(),
            used_tokens: 12_000,
            total_tokens: 64_000,
            percentage: 18.75,
            message_count: 8,
        })
        .expect("context status event should serialize");

        assert_eq!(value.get("kind").and_then(serde_json::Value::as_str), Some("CONTEXT_STATUS_UPDATED"));
        assert!(value.get("usedTokens").is_some());
        assert!(value.get("totalTokens").is_some());
        assert!(value.get("messageCount").is_some());
        assert!(value.get("used_tokens").is_none());

        let value = serde_json::to_value(ModelStreamEventDto::ContextCompressionSkipped {
            request_id: "req_1".to_string(),
            reason: "NO_EFFECTIVE_SAVINGS".to_string(),
            usage_ratio: 0.91,
        })
        .expect("context skipped event should serialize");

        assert_eq!(value.get("kind").and_then(serde_json::Value::as_str), Some("CONTEXT_COMPRESSION_SKIPPED"));
        assert!(value.get("usageRatio").is_some());
        assert!(value.get("usage_ratio").is_none());
    }
}
