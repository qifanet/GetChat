/**
 * @file commands/messages.rs
 * @description Message creation and lifecycle commands with structured logging.
 *
 * Commands delegate entirely to snapshot_service and prompt_service.
 * No SQL or domain logic in this layer.
 *
 * Logging: info on success (with conv_id/msg_id/request_id/duration_ms),
 *          warn on error (with error_code).
 */

use tauri::State;

use crate::dto::messages::{
    BuildPromptMessagesInput, CompleteAssistantMessageInput,
    CreateAssistantPlaceholderForBranchInput, CreateAssistantVariantPlaceholderInput,
    CreateUserMessageInput, FailAssistantMessageInput, MessageDto,
};
use crate::error::AppError;
use crate::services::{prompt_service, snapshot_service};
use crate::state::AppState;

// ============================================================================
// Commands
// ============================================================================

/** Create a user message and append to the current branch. */
#[tauri::command]
pub async fn create_user_message(
    state: State<'_, AppState>,
    input: CreateUserMessageInput,
) -> Result<MessageDto, AppError> {
    let start = std::time::Instant::now();
    let conv_id = input.conversation_id.clone();
    let branch_id = input.branch_id.clone();
    let result = snapshot_service::create_user_message(&state.db, &input).await;
    match &result {
        Ok(msg) => tracing::info!(
            cmd = "create_user_message", conv_id = %conv_id, branch_id = %branch_id,
            msg_id = %msg.id, depth = msg.depth,
            parent_id = ?msg.parent_id,
            content_length = msg.content.text.len(),
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "create_user_message", conv_id = %conv_id, branch_id = %branch_id,
            error_code = %e.code, message = %e.message, details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}

/**
 * Create a STREAMING assistant placeholder appended to the branch head.
 * Updates branch head to the new placeholder.
 */
#[tauri::command]
pub async fn create_assistant_placeholder_for_branch(
    state: State<'_, AppState>,
    input: CreateAssistantPlaceholderForBranchInput,
) -> Result<MessageDto, AppError> {
    let start = std::time::Instant::now();
    let conv_id = input.conversation_id.clone();
    let branch_id = input.branch_id.clone();
    let request_id = input.request_id.clone();
    let result = snapshot_service::create_assistant_placeholder_for_branch(&state.db, &input).await;
    match &result {
        Ok(msg) => tracing::info!(
            cmd = "create_assistant_placeholder_for_branch",
            conv_id = %conv_id, branch_id = %branch_id,
            msg_id = %msg.id, request_id = %request_id,
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "create_assistant_placeholder_for_branch",
            conv_id = %conv_id, branch_id = %branch_id,
            request_id = %request_id, error_code = %e.code,
            message = %e.message, details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}

/**
 * Create a STREAMING assistant variant placeholder (regenerate).
 * Does NOT update branch head — variant is a sibling, not a branch extension.
 */
#[tauri::command]
pub async fn create_assistant_variant_placeholder(
    state: State<'_, AppState>,
    input: CreateAssistantVariantPlaceholderInput,
) -> Result<MessageDto, AppError> {
    let start = std::time::Instant::now();
    let conv_id = input.conversation_id.clone();
    let parent_msg_id = input.parent_message_id.clone();
    let request_id = input.request_id.clone();
    let result = snapshot_service::create_assistant_variant_placeholder(&state.db, &input).await;
    match &result {
        Ok(msg) => tracing::info!(
            cmd = "create_assistant_variant_placeholder",
            conv_id = %conv_id, parent_msg_id = %parent_msg_id,
            msg_id = %msg.id, request_id = %request_id,
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "create_assistant_variant_placeholder",
            conv_id = %conv_id, parent_msg_id = %parent_msg_id,
            request_id = %request_id, error_code = %e.code,
            message = %e.message, details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}

/**
 * Complete a streaming assistant message.
 * Commits final text and token usage. Status: STREAMING → COMPLETED.
 */
#[tauri::command]
pub async fn complete_assistant_message(
    state: State<'_, AppState>,
    input: CompleteAssistantMessageInput,
) -> Result<MessageDto, AppError> {
    let start = std::time::Instant::now();
    let msg_id = input.message_id.clone();
    let content_length = input.content_text.len();
    let result = snapshot_service::complete_assistant_message(&state.db, &input).await;
    match &result {
        Ok(_) => tracing::info!(
            cmd = "complete_assistant_message", msg_id = %msg_id,
            content_length, duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "complete_assistant_message", msg_id = %msg_id,
            error_code = %e.code, message = %e.message, details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}

/**
 * Fail a streaming assistant message.
 * Preserves partial content and records error details. Status: STREAMING → FAILED.
 */
#[tauri::command]
pub async fn fail_assistant_message(
    state: State<'_, AppState>,
    input: FailAssistantMessageInput,
) -> Result<MessageDto, AppError> {
    let start = std::time::Instant::now();
    let msg_id = input.message_id.clone();
    let error_code_input = input.error_code.clone();
    let partial_length = input.partial_content_text.as_ref().map(|s| s.len()).unwrap_or(0);
    let result = snapshot_service::fail_assistant_message(&state.db, &input).await;
    match &result {
        Ok(_) => tracing::info!(
            cmd = "fail_assistant_message", msg_id = %msg_id,
            error_code = %error_code_input, partial_length,
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "fail_assistant_message", msg_id = %msg_id,
            error_code = %e.code, message = %e.message, details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}

/**
 * Build the prompt message array by walking the tree from a leaf to root.
 * Returns messages in chronological order, filtered for prompt suitability.
 */
#[tauri::command]
pub async fn build_prompt_messages(
    state: State<'_, AppState>,
    input: BuildPromptMessagesInput,
) -> Result<Vec<prompt_service::PromptMessage>, AppError> {
    let start = std::time::Instant::now();
    let conv_id = input.conversation_id.clone();
    let up_to_msg_id = input.up_to_message_id.clone();
    let result = prompt_service::build_prompt_messages(&state.db, &input).await;
    match &result {
        Ok(msgs) => {
            tracing::info!(
                cmd = "build_prompt_messages",
                conv_id = %conv_id,
                up_to_msg_id = %up_to_msg_id,
                prompt_count = msgs.len(),
                duration_ms = start.elapsed().as_millis() as u64,
                "prompt_messages_built"
            );
            for (i, msg) in msgs.iter().enumerate() {
                tracing::debug!(
                    index = i,
                    role = %msg.role,
                    content_len = msg.content.len(),
                    "prompt_entry"
                );
            }
        }
        Err(e) => tracing::warn!(
            cmd = "build_prompt_messages", conv_id = %conv_id,
            error_code = %e.code, message = %e.message, details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}

/** Hard delete a variant/candidate assistant message. */
#[tauri::command]
pub async fn delete_message(
    state: State<'_, AppState>,
    message_id: String,
) -> Result<(), AppError> {
    let start = std::time::Instant::now();
    let result = snapshot_service::delete_variant_message(&state.db, &message_id).await;
    match &result {
        Ok(()) => tracing::info!(
            cmd = "delete_message", msg_id = %message_id,
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "delete_message", msg_id = %message_id,
            error_code = %e.code, message = %e.message,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}

/** Edit a user message inline — replaces content and deletes assistant children. */
#[tauri::command]
pub async fn edit_user_message_inline(
    state: State<'_, AppState>,
    message_id: String,
    new_content: String,
) -> Result<MessageDto, AppError> {
    let start = std::time::Instant::now();
    let result = snapshot_service::edit_user_message_inline(&state.db, &message_id, &new_content).await;
    match &result {
        Ok(_) => tracing::info!(
            cmd = "edit_user_message_inline", msg_id = %message_id,
            content_length = new_content.len(),
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "edit_user_message_inline", msg_id = %message_id,
            error_code = %e.code, message = %e.message,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}
