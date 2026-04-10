/**
 * @file commands/branches.rs
 * @description Branch management commands with domain validation and structured logging.
 *
 * Domain rules enforced:
 *   - set_mainline_branch: target must be ACTIVE
 *   - archive_branch: target must not be the current mainline
 *   - create_branch: delegates domain validation to snapshot_service
 *
 * Logging: info on success (with conv_id/branch_id/duration_ms), warn on rejection.
 */

use tauri::State;

use crate::dto::branches::{
    BranchDto, CreateBranchInput, RenameBranchInput, SetBranchHeadMessageInput,
    SetBranchPreferredModelInput, SetMainlineBranchInput, SetMainlineResult,
};
use crate::error::AppError;
use crate::repositories::{branches, conversations, messages, provider_models};
use crate::services::snapshot_service;
use crate::state::AppState;

// ============================================================================
// Commands
// ============================================================================

/** Create a new branch from an existing message. Non-destructive. */
#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    input: CreateBranchInput,
) -> Result<BranchDto, AppError> {
    let start = std::time::Instant::now();
    let conv_id = input.conversation_id.clone();
    let fork_type = format!("{:?}", input.fork_source_type);
    let result = snapshot_service::create_branch(&state.db, &input).await;
    match &result {
        Ok(dto) => tracing::info!(
            cmd = "create_branch", conv_id = %conv_id,
            branch_id = %dto.id, fork_source_type = %fork_type,
            fork_point_msg_id = ?dto.fork_point_message_id,
            duration_ms = start.elapsed().as_millis() as u64, "ok"
        ),
        Err(e) => tracing::warn!(
            cmd = "create_branch", conv_id = %conv_id,
            fork_source_type = %fork_type, error_code = %e.code,
            message = %e.message, details = ?e.details,
            duration_ms = start.elapsed().as_millis() as u64, "error"
        ),
    }
    result
}

/** Rename a branch. Returns the updated branch DTO. */
#[tauri::command]
pub async fn rename_branch(
    state: State<'_, AppState>,
    input: RenameBranchInput,
) -> Result<BranchDto, AppError> {
    let start = std::time::Instant::now();
    branches::find_by_id(&state.db, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    branches::update_name(&state.db, &input.branch_id, &input.name).await?;

    // Re-fetch to get updated timestamp
    let updated = branches::find_by_id(&state.db, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found after rename"))?;

    // Compute is_mainline
    let conv = conversations::find_by_id(&state.db, &updated.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;
    let is_mainline = conv.mainline_branch_id.as_ref() == Some(&updated.id);

    tracing::info!(
        cmd = "rename_branch", conv_id = %updated.conversation_id,
        branch_id = %input.branch_id, name_len = input.name.len(),
        duration_ms = start.elapsed().as_millis() as u64, "ok"
    );

    Ok(snapshot_service::map_branch_row_public(&updated, is_mainline))
}

/** Persist the preferred model profile for a branch. */
#[tauri::command]
pub async fn set_branch_preferred_model(
    state: State<'_, AppState>,
    input: SetBranchPreferredModelInput,
) -> Result<BranchDto, AppError> {
    let start = std::time::Instant::now();
    let _branch = branches::find_by_id(&state.db, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    if let Some(model_id) = input.model_id.as_deref() {
        provider_models::find_by_id(&state.db, model_id)
            .await?
            .ok_or_else(|| AppError::not_found("Model profile not found"))?;
    }

    branches::update_preferred_model(&state.db, &input.branch_id, input.model_id.as_deref())
        .await?;

    let updated = branches::find_by_id(&state.db, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found after model update"))?;
    let conv = conversations::find_by_id(&state.db, &updated.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;
    let is_mainline = conv.mainline_branch_id.as_ref() == Some(&updated.id);

    tracing::info!(
        cmd = "set_branch_preferred_model",
        conv_id = %updated.conversation_id,
        branch_id = %updated.id,
        preferred_model_id = ?input.model_id,
        duration_ms = start.elapsed().as_millis() as u64,
        "ok"
    );

    Ok(snapshot_service::map_branch_row_public(&updated, is_mainline))
}

/** Promote an existing message to the branch head after a regenerate flow. */
#[tauri::command]
pub async fn set_branch_head_message(
    state: State<'_, AppState>,
    input: SetBranchHeadMessageInput,
) -> Result<BranchDto, AppError> {
    let start = std::time::Instant::now();
    let branch = branches::find_by_id(&state.db, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;
    let message = messages::find_by_id(&state.db, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Message not found"))?;

    if message.conversation_id != branch.conversation_id {
        return Err(AppError::invalid_argument(
            "Message does not belong to the same conversation as the branch",
        ));
    }

    branches::update_head_optional(&state.db, &input.branch_id, Some(&input.message_id)).await?;

    let updated = branches::find_by_id(&state.db, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found after head update"))?;
    let conv = conversations::find_by_id(&state.db, &updated.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;
    let is_mainline = conv.mainline_branch_id.as_ref() == Some(&updated.id);

    tracing::info!(
        cmd = "set_branch_head_message",
        conv_id = %updated.conversation_id,
        branch_id = %updated.id,
        message_id = %input.message_id,
        duration_ms = start.elapsed().as_millis() as u64,
        "ok"
    );

    Ok(snapshot_service::map_branch_row_public(&updated, is_mainline))
}

/**
 * Archive a branch.
 *
 * Domain rule: cannot archive the current mainline branch.
 * Returns CONFLICT if the target is mainline.
 * Returns the updated branch DTO on success.
 */
#[tauri::command]
pub async fn archive_branch(
    state: State<'_, AppState>,
    branch_id: String,
) -> Result<BranchDto, AppError> {
    let start = std::time::Instant::now();
    let branch = branches::find_by_id(&state.db, &branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    if branch.status == "ARCHIVED" {
        tracing::warn!(cmd = "archive_branch", branch_id = %branch_id, "rejected: already_archived");
        return Err(AppError::conflict("Branch is already archived"));
    }

    // Domain rule: cannot archive the mainline branch
    let conv = conversations::find_by_id(&state.db, &branch.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    if conv.mainline_branch_id.as_ref() == Some(&branch_id) {
        tracing::warn!(cmd = "archive_branch", branch_id = %branch_id, conv_id = %conv.id, "rejected: is_mainline");
        return Err(AppError::conflict(
            "Cannot archive the mainline branch. Set a different mainline first.",
        ));
    }

    branches::update_status(&state.db, &branch_id, "ARCHIVED").await?;

    tracing::info!(
        cmd = "archive_branch", conv_id = %conv.id,
        branch_id = %branch_id, duration_ms = start.elapsed().as_millis() as u64, "ok"
    );

    // Re-fetch to get updated status and archived_at
    let updated = branches::find_by_id(&state.db, &branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found after archive"))?;

    Ok(snapshot_service::map_branch_row_public(&updated, false))
}

/** Unarchive a branch. Returns the updated branch DTO. */
#[tauri::command]
pub async fn unarchive_branch(
    state: State<'_, AppState>,
    branch_id: String,
) -> Result<BranchDto, AppError> {
    let start = std::time::Instant::now();
    let branch = branches::find_by_id(&state.db, &branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    if branch.status != "ARCHIVED" {
        tracing::warn!(cmd = "unarchive_branch", branch_id = %branch_id, "rejected: not_archived");
        return Err(AppError::conflict("Branch is not archived"));
    }

    branches::update_status(&state.db, &branch_id, "ACTIVE").await?;

    // Re-fetch to get updated status and cleared archived_at
    let updated = branches::find_by_id(&state.db, &branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found after unarchive"))?;

    // Compute is_mainline
    let conv = conversations::find_by_id(&state.db, &updated.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;
    let is_mainline = conv.mainline_branch_id.as_ref() == Some(&updated.id);

    tracing::info!(
        cmd = "unarchive_branch", conv_id = %conv.id,
        branch_id = %branch_id, duration_ms = start.elapsed().as_millis() as u64, "ok"
    );

    Ok(snapshot_service::map_branch_row_public(&updated, is_mainline))
}

/**
 * Set the mainline branch for a conversation.
 *
 * Non-destructive: only updates conversations.mainline_branch_id.
 * Domain rule: target branch must be ACTIVE.
 * Returns SetMainlineResult with IDs needed to update all branches' isMainline.
 */
#[tauri::command]
pub async fn set_mainline_branch(
    state: State<'_, AppState>,
    input: SetMainlineBranchInput,
) -> Result<SetMainlineResult, AppError> {
    let start = std::time::Instant::now();

    // Verify conversation
    let conv = conversations::find_by_id(&state.db, &input.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    // Verify branch exists and belongs to conversation
    let branch = branches::find_by_id(&state.db, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    if branch.conversation_id != input.conversation_id {
        return Err(AppError::invalid_argument(
            "Branch does not belong to this conversation",
        ));
    }

    // Domain rule: only ACTIVE branches can be mainline
    if branch.status != "ACTIVE" {
        tracing::warn!(
            cmd = "set_mainline_branch", conv_id = %input.conversation_id,
            branch_id = %input.branch_id, branch_status = %branch.status, "rejected: not_active"
        );
        return Err(AppError::invalid_argument(
            "Only active branches can be set as mainline",
        ));
    }

    // Save the old mainline ID before updating
    let old_mainline_branch_id = conv.mainline_branch_id.clone();

    conversations::set_mainline_branch(&state.db, &input.conversation_id, &input.branch_id)
        .await?;

    // Build the new mainline BranchDto
    let new_mainline = snapshot_service::map_branch_row_public(&branch, true);

    tracing::info!(
        cmd = "set_mainline_branch", conv_id = %input.conversation_id,
        old_branch_id = ?old_mainline_branch_id, new_branch_id = %input.branch_id,
        duration_ms = start.elapsed().as_millis() as u64, "ok"
    );

    Ok(SetMainlineResult {
        old_mainline_branch_id,
        new_mainline_branch: new_mainline,
    })
}
