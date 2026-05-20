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
    pub skill_prompt_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextStatusDto {
    pub used_tokens: u32,
    pub total_tokens: u32,
    pub percentage: f32,
    pub message_count: u32,
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
}
