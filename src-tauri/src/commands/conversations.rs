/**
 * @file commands/conversations.rs
 * @description Conversation management commands with structured logging.
 *
 * Commands delegate to snapshot_service for complex operations
 * and call repositories directly for simple CRUD.
 *
 * Logging: info on success (with duration_ms), warn on error (with error_code).
 */

use tauri::State;

use crate::dto::conversations::{ConversationSummaryDto, CreateConversationInput, LoadConversationSnapshotInput};
use crate::error::AppError;
use crate::repositories::{compressed_contexts, conversations};
use crate::services::snapshot_service;
use crate::state::AppState;

// ============================================================================
// Commands
// ============================================================================

/** List all active conversation summaries for the sidebar. */
#[tauri::command]
pub async fn list_conversation_summaries(
    state: State<'_, AppState>,
) -> Result<Vec<ConversationSummaryDto>, AppError> {
    let start = std::time::Instant::now();
    let result = snapshot_service::list_conversation_summaries(&state.db).await;
    match &result {
        Ok(list) => tracing::debug!(cmd = "list_conversation_summaries", count = list.len(), duration_ms = start.elapsed().as_millis() as u64),
        Err(e) => tracing::warn!(
            cmd = "list_conversation_summaries",
            error_code = %e.code,
            message = %e.message,
            details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64,
            "error"
        ),
    }
    result
}

/** Create a new conversation with an optional initial user message. */
#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    input: CreateConversationInput,
) -> Result<ConversationSummaryDto, AppError> {
    let start = std::time::Instant::now();
    let has_initial_msg = input.initial_user_message.as_ref().is_some_and(|s| !s.is_empty());
    let result = snapshot_service::create_conversation(&state.db, &input).await;
    match &result {
        Ok(dto) => tracing::info!(
            cmd = "create_conversation", conv_id = %dto.id,
            branch_id = ?dto.mainline_branch_id, has_initial_msg,
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "create_conversation",
            error_code = %e.code,
            message = %e.message,
            details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64,
            "error"
        ),
    }
    result
}

/** Load the full conversation snapshot (entities + indexes) for the workspace. */
#[tauri::command]
pub async fn load_conversation_snapshot(
    state: State<'_, AppState>,
    input: LoadConversationSnapshotInput,
) -> Result<crate::dto::conversations::ConversationSnapshotDto, AppError> {
    let start = std::time::Instant::now();
    let conv_id = input.conversation_id.clone();
    let result = snapshot_service::load_snapshot(&state.db, &input).await;
    match &result {
        Ok(snap) => tracing::info!(
            cmd = "load_conversation_snapshot", conv_id = %conv_id,
            msg_count = ?snap.entities.messages.len(),
            branch_count = ?snap.entities.branches.len(),
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "load_conversation_snapshot",
            conv_id = %conv_id,
            error_code = %e.code,
            message = %e.message,
            details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64,
            "error"
        ),
    }
    result
}

/** Rename a conversation. Returns the updated summary DTO. */
#[tauri::command]
pub async fn rename_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    title: String,
) -> Result<ConversationSummaryDto, AppError> {
    let start = std::time::Instant::now();
    // Verify existence
    conversations::find_by_id(&state.db, &conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    // User manual rename → set title_source to USER_SET
    conversations::update_title_user_set(&state.db, &conversation_id, &title).await?;

    tracing::info!(
        cmd = "rename_conversation", conv_id = %conversation_id,
        title_len = title.len(), duration_ms = start.elapsed().as_millis() as u64, "ok"
    );

    // Re-fetch to get updated summary with new timestamp
    snapshot_service::get_conversation_summary(&state.db, &conversation_id).await
}

/** Archive a conversation. Sets archived_at to current timestamp. Returns updated summary. */
#[tauri::command]
pub async fn archive_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ConversationSummaryDto, AppError> {
    let start = std::time::Instant::now();
    let conv = conversations::find_by_id(&state.db, &conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    if conv.archived_at.is_some() {
        tracing::warn!(cmd = "archive_conversation", conv_id = %conversation_id, "rejected: already_archived");
        return Err(AppError::conflict("Conversation is already archived"));
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    conversations::set_archived(&state.db, &conversation_id, Some(now)).await?;

    tracing::info!(
        cmd = "archive_conversation", conv_id = %conversation_id,
        duration_ms = start.elapsed().as_millis() as u64, "ok"
    );

    snapshot_service::get_conversation_summary(&state.db, &conversation_id).await
}

/** Unarchive a conversation. Sets archived_at to NULL. Returns updated summary. */
#[tauri::command]
pub async fn unarchive_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ConversationSummaryDto, AppError> {
    let start = std::time::Instant::now();
    let conv = conversations::find_by_id(&state.db, &conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    if conv.archived_at.is_none() {
        tracing::warn!(cmd = "unarchive_conversation", conv_id = %conversation_id, "rejected: not_archived");
        return Err(AppError::conflict("Conversation is not archived"));
    }

    conversations::set_archived(&state.db, &conversation_id, None).await?;

    tracing::info!(
        cmd = "unarchive_conversation", conv_id = %conversation_id,
        duration_ms = start.elapsed().as_millis() as u64, "ok"
    );

    snapshot_service::get_conversation_summary(&state.db, &conversation_id).await
}

/**
 * Delete a conversation and all its data.
 * Uses deferred FK checks so a conversation-level delete can remove the
 * entire message tree in one transaction without weakening message-level
 * RESTRICT semantics for normal operations.
 */
#[tauri::command]
pub async fn delete_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), AppError> {
    let start = std::time::Instant::now();
    // Verify existence
    conversations::find_by_id(&state.db, &conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    let mut tx = state.db.begin().await.map_err(AppError::from)?;

    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;

    compressed_contexts::delete_by_conversation(&mut *tx, &conversation_id)
        .await
        .map_err(AppError::from)?;

    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(&conversation_id)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;

    tx.commit().await.map_err(AppError::from)?;

    tracing::info!(
        cmd = "delete_conversation", conv_id = %conversation_id,
        duration_ms = start.elapsed().as_millis() as u64, "ok"
    );

    Ok(())
}

/**
 * Auto-generate a conversation title using the helper AI model.
 * Called from the frontend after the first assistant reply completes.
 * Returns the generated title, or null if generation was skipped.
 */
#[tauri::command]
pub async fn generate_conversation_title(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<crate::services::helper_ai_service::TitleGenerationResult>, AppError> {
    tracing::info!(conv_id = %conversation_id, "cmd: generate_conversation_title invoked");
    crate::services::helper_ai_service::generate_conversation_title(&state, &conversation_id).await
}

/// Generate an AI summary of the differences between two branches.
#[tauri::command]
pub async fn generate_branch_diff_summary(
    state: State<'_, AppState>,
    conversation_id: String,
    left_branch_id: String,
    right_branch_id: String,
) -> Result<Option<crate::services::helper_ai_service::DiffSummaryResult>, AppError> {
    tracing::info!(
        conv_id = %conversation_id,
        left = %left_branch_id,
        right = %right_branch_id,
        "cmd: generate_branch_diff_summary invoked"
    );
    crate::services::helper_ai_service::generate_branch_diff_summary(
        &state,
        &conversation_id,
        &left_branch_id,
        &right_branch_id,
    )
    .await
}

fn normalize_workspace_path(workspace_path: Option<String>) -> Result<Option<String>, AppError> {
    let Some(path) = workspace_path else {
        return Ok(None);
    };
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let canonical = std::path::PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|e| {
            AppError::invalid_argument(format!(
                "Workspace path must be an existing directory: {e}"
            ))
        })?;

    if !canonical.is_dir() {
        return Err(AppError::invalid_argument(
            "Workspace path must point to an existing directory",
        ));
    }

    Ok(Some(canonical.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn set_conversation_workspace(
    state: State<'_, AppState>,
    conversation_id: String,
    workspace_path: Option<String>,
) -> Result<(), AppError> {
    let start = std::time::Instant::now();

    conversations::find_by_id(&state.db, &conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    let canonical_workspace_path = normalize_workspace_path(workspace_path)?;
    let path_arg = canonical_workspace_path.as_deref();
    conversations::set_workspace_path(&state.db, &conversation_id, path_arg).await?;

    tracing::info!(
        cmd = "set_conversation_workspace",
        conv_id = %conversation_id,
        path = ?canonical_workspace_path,
        duration_ms = start.elapsed().as_millis() as u64,
        "ok"
    );

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItemDto {
    pub id: String,
    pub content: String,
    pub status: String,
}

#[tauri::command]
pub async fn read_todo_items(conversation_id: Option<String>) -> Vec<TodoItemDto> {
    // Todos are scoped per conversation; without a conversation id there is
    // nothing meaningful to show (the legacy global-lookup was removed with
    // the M1 session-scoping work).
    let items = match conversation_id {
        Some(id) => crate::services::tool_executor::read_todos_for_conversation(&id),
        None => Vec::new(),
    };
    items.into_iter().map(|t| TodoItemDto {
        id: t.id,
        content: t.content,
        status: t.status,
    }).collect()
}

#[tauri::command]
pub async fn import_conversations(
    state: State<'_, AppState>,
    input: crate::services::import_service::ImportInput,
) -> Result<crate::services::import_service::ImportResult, AppError> {
    let start = std::time::Instant::now();
    let format = input.format.clone();
    let result = crate::services::import_service::import_conversations(&state.db, &input).await;
    match &result {
        Ok(r) => tracing::info!(
            cmd = "import_conversations",
            format = %format,
            imported = r.imported_count,
            skipped = r.skipped_count,
            errors = r.errors.len(),
            duration_ms = start.elapsed().as_millis() as u64,
            "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "import_conversations",
            format = %format,
            error = %e.message,
            duration_ms = start.elapsed().as_millis() as u64,
            "error"
        ),
    }
    result
}
