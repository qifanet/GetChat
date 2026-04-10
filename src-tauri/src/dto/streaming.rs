/**
 * @file dto/streaming.rs
 * @description DTOs for runtime model streaming between the Tauri backend
 *              and the frontend streaming controller.
 *
 * These DTOs are intentionally separate from persisted message DTOs because
 * they represent transient transport events rather than database entities.
 */

use serde::{Deserialize, Serialize};

use super::common::{GenerationParamsDto, TokenUsageDto};

// ============================================================================
// Input Types
// ============================================================================

/**
 * A single prompt message that will be forwarded to a model provider.
 *
 * The frontend currently builds prompt arrays from persisted messages, then the
 * backend normalizes the role names to provider-compatible lowercase values.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPromptMessageDto {
    pub role: String,
    pub content: String,
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
}

// ============================================================================
// Output Event Types
// ============================================================================

/**
 * Runtime streaming event emitted over a Tauri IPC channel.
 *
 * The frontend converts these transport events into calls to:
 *   - onStreamChunk()
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
    Completed {
        #[serde(rename = "requestId")]
        request_id: String,

        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsageDto>,
    },
    Failed {
        #[serde(rename = "requestId")]
        request_id: String,
        code: String,
        message: String,
        retriable: bool,
    },
}
