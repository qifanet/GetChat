/**
 * @file dto/messages.rs
 * @description Message DTOs, sub-DTOs, and all message-related input types.
 *
 * MessageDto matches frontend MessageNode interface:
 *   - parentId forms the tree structure
 *   - childIds is a runtime index built at snapshot load time
 *   - generation is only present for ASSISTANT messages with provider/model info
 *   - error is only present for FAILED messages
 *   - editedFromMessageId is only present for non-destructive edit messages
 *
 * The DB stores flat columns; the repository layer assembles the nested DTO structure.
 */

use serde::{Deserialize, Serialize};

use super::common::{ContentFormat, MessageRole, MessageStatus, TokenUsageDto};

// ============================================================================
// Sub-DTOs (nested structures in MessageDto)
// ============================================================================

/**
 * Message content container.
 * Matches frontend MessageContent interface.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageContentDto {
    pub text: String,
    pub format: ContentFormat,

    /**
     * Ordered content blocks used to render inline tool calls at their
     * original stream positions. Omitted for plain text-only messages.
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<ContentBlockDto>>,
}

/**
 * Ordered content block persisted with a completed assistant message.
 * Matches frontend ContentBlock exactly.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlockDto {
    Text {
        content: String,
    },
    ToolCall {
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(rename = "functionName")]
        function_name: String,
        args: String,
    },
    ToolResult {
        #[serde(rename = "callId")]
        call_id: String,
        result: String,
        success: bool,
    },
}

/**
 * Metadata about how an assistant message was generated.
 * Matches frontend MessageGenerationMeta interface.
 *
 * Only present for ASSISTANT messages that have provider_id/model_id set.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageGenerationDto {
    pub provider_id: String,
    pub model_id: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,

    /**
     * Generation parameters used for this request.
     * Stored as JSON in the DB; deserialized here for structured access.
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsageDto>,
}

/**
 * Error information attached to a failed message.
 * Matches frontend MessageError interface.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageErrorDto {
    pub code: String,
    pub message: String,
    pub retriable: bool,
}

// ============================================================================
// Output DTO
// ============================================================================

/**
 * A single node in the conversation message tree.
 * Matches frontend MessageNode interface exactly.
 *
 * Tree structure:
 *   - parentId forms the tree (NULL = root)
 *   - childIds is built at snapshot load time by inverting parentId
 *   - depth is computed during tree walk
 *
 * Default immutability: once created, content and parentId do not change.
 * Normal "edits" create new nodes with edited_from_message_id pointing to the original.
 *
 * Exception: direct_overwrite_user_message is a deliberately destructive,
 * user-selected command that may mutate a historical USER node. Keep that
 * exception narrow; do not expose generic message patch commands.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub conversation_id: String,

    pub role: MessageRole,
    pub status: MessageStatus,

    /** NULL for root messages; forms the tree structure */
    pub parent_id: Option<String>,

    /**
     * Runtime index: list of child message IDs.
     * Built at snapshot load time by scanning all messages' parentId.
     * NOT stored in the database.
     */
    #[serde(default)]
    pub child_ids: Vec<String>,

    /** Depth from root (0 for root messages). Computed at load time. */
    pub depth: i32,

    pub content: MessageContentDto,

    pub created_at: i64,
    pub updated_at: i64,

    /** Only present for ASSISTANT messages with provider/model metadata */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<MessageGenerationDto>,

    /** Only present for FAILED messages */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MessageErrorDto>,

    /**
     * Non-destructive edit traceability.
     * Points to the original message this was derived from.
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_from_message_id: Option<String>,

    /** Tool calls associated with this assistant message (populated from tool_calls table). */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<crate::dto::common::ToolCallResultDto>>,
}

// ============================================================================
// Input Types
// ============================================================================

/**
 * Input for creating a user message.
 *
 * Non-destructive design:
 *   - Creates a NEW message node; existing messages are never modified
 *   - For edit-fork: set edited_from_message_id to the original message
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserMessageInput {
    pub conversation_id: String,
    pub branch_id: String,

    pub content_text: String,

    /**
     * Parent message ID. NULL for root messages (first message in conversation).
     * For non-root messages, this is the current head of the branch.
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,

    /**
     * Set only for HISTORY_USER_EDIT fork.
     * Points to the original message this is an edit of.
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_from_message_id: Option<String>,
}

/**
 * Input for the explicit destructive history-edit exception.
 *
 * This is intentionally narrower than a generic update_message command:
 *   - only USER/COMPLETED messages can be overwritten
 *   - service layer verifies conversation + branch path membership
 *   - downstream current-path descendants may be truncated before regenerate
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectOverwriteUserMessageInput {
    pub conversation_id: String,
    pub branch_id: String,
    pub message_id: String,
    pub content_text: String,
}

/**
 * Input for creating an assistant streaming placeholder.
 * The placeholder is appended to the current branch head.
 *
 * Lifecycle:
 *   1. Command creates a STREAMING status message
 *   2. Frontend receives the placeholder and starts streaming display
 *   3. On completion: complete_assistant_message updates status and content
 *   4. On failure: fail_assistant_message sets error info
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssistantPlaceholderForBranchInput {
    pub conversation_id: String,
    pub branch_id: String,

    pub provider_id: String,
    pub model_id: String,
    pub request_id: String,

    /** Generation parameters as JSON (temperature, top_p, etc.) */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_params: Option<serde_json::Value>,
}

/**
 * Input for creating an assistant variant placeholder (regenerate).
 *
 * This creates a STREAMING placeholder as a SIBLING of an existing assistant
 * message (same parent_message_id). It does NOT update the branch head.
 *
 * Variant is NOT a branch. It only becomes a branch if the user continues
 * from it with downstream conflict (see buildSendPlan Rule 4).
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssistantVariantPlaceholderInput {
    pub conversation_id: String,

    /**
     * The parent message ID (typically a user message).
     * The new assistant variant will be a sibling of existing assistants
     * with the same parent.
     */
    pub parent_message_id: String,

    pub provider_id: String,
    pub model_id: String,
    pub request_id: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_params: Option<serde_json::Value>,
}

/**
 * Input for completing an assistant message (stream finished successfully).
 *
 * Sets status to COMPLETED and commits the final text.
 * This is the ONLY time message content is written.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteAssistantMessageInput {
    pub message_id: String,

    /** Runtime request id that owns this streaming placeholder. */
    pub request_id: String,

    /** Final accumulated text from the stream */
    pub content_text: String,

    /** Ordered text/tool blocks captured during streaming. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_blocks: Option<Vec<ContentBlockDto>>,

    /** Token usage statistics from the API response */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,

    /** Hidden reasoning payload required by some provider thinking modes. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,

    /** Tool calls to persist from the ReAct Loop */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallResultInput>>,
}

/** A single tool call result to persist alongside an assistant message. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResultInput {
    pub call_id: String,
    pub function_name: String,
    pub arguments_json: String,
    pub result_json: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/**
 * Input for failing an assistant message (stream error).
 *
 * Preserves any partial content that was streamed before the error.
 * Sets status to FAILED with error details for frontend display.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailAssistantMessageInput {
    pub message_id: String,

    /** Runtime request id that owns this streaming placeholder. */
    pub request_id: String,

    pub error_code: String,
    pub error_message: String,

    /** Whether the user can retry this request */
    pub error_retriable: bool,

    /** Partial text streamed before the error occurred */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial_content_text: Option<String>,

    /** Partial ordered text/tool blocks captured before the failure. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial_content_blocks: Option<Vec<ContentBlockDto>>,

    /** Tool calls that completed or failed before the stream failed. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallResultInput>>,
}

/**
 * Input for building the prompt message array to send to a model.
 *
 * Walks the message tree from the root to the specified message,
 * collecting messages in chronological order for the API request.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildPromptMessagesInput {
    pub conversation_id: String,

    /** Walk from root to this message to build the prompt context */
    pub up_to_message_id: String,

    /** Optional token budget to limit context length */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_budget: Option<i32>,

    /** Optional branch ID for loading compressed context summary */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
}
