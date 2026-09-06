/**
 * @file commands/proposal.rs
 * @description Proposal commands for parallel fork review (v1.5.0)
 */

use tauri::State;
use crate::state::AppState;
use crate::dto::proposal::{ProposalBranchDto, ProposalDto};
use crate::error::AppError;
use crate::repositories::proposal::ProposalRepository;
use crate::services::snapshot_service;

#[tauri::command]
pub async fn get_proposal(
    proposal_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ProposalDto>, AppError> {
    let pool = &state.db;
    ProposalRepository::find_by_id(pool, &proposal_id).await
}

#[tauri::command]
pub async fn list_proposals(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ProposalDto>, AppError> {
    let pool = &state.db;
    ProposalRepository::list_by_conversation(pool, &conversation_id).await
}

/**
 * Execute an approved parallel-fork proposal (M4.4, end-to-end).
 *
 * For every selected branch the command materializes the full branch skeleton
 * in one transaction (`create_parallel_fork_branch`: branch row + initial user
 * message + STREAMING assistant placeholder as branch head), then enqueues a
 * PARALLEL_FORK task whose worker drives the model stream into the
 * placeholder. The command returns immediately with the task ids — streams
 * progress in the background and the frontend observes via task events.
 */
#[tauri::command]
pub async fn execute_parallel_fork(
    proposal_id: String,
    branches: Vec<ProposalBranchDto>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    let pool = &state.db;

    // 1. Find proposal
    let proposal = ProposalRepository::find_by_id(pool, &proposal_id)
        .await?
        .ok_or_else(|| AppError::not_found("Proposal not found"))?;

    // 2. Materialize each branch skeleton, then enqueue its stream task.
    let mut task_ids = Vec::new();
    for (idx, branch) in branches.iter().enumerate() {
        let prepared = snapshot_service::create_parallel_fork_branch(
            pool,
            &proposal.conversation_id,
            &branch.branch_name,
            &branch.initial_message,
            &branch.model_id,
        )
        .await?;

        let task_id = format!("task_{}", uuid::Uuid::new_v4().simple());
        let config = serde_json::json!({
            "branch_id": prepared.branch_id,
            "branch_name": branch.branch_name,
            "initial_message": branch.initial_message,
            "model_id": prepared.model_id,
            "provider_id": prepared.provider_id,
            "request_id": prepared.request_id,
            "user_message_id": prepared.user_message_id,
            "assistant_message_id": prepared.assistant_message_id,
        });
        let config_json = serde_json::to_string(&config)
            .map_err(|error| AppError::invariant_violation(format!("Failed to serialize config: {error}")))?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        crate::repositories::task_queue::TaskQueueRepository::create(
            pool,
            &task_id,
            &proposal.conversation_id,
            "PARALLEL_FORK",
            &config_json,
            Some(proposal_id.as_str()),
            now,
        )
        .await?;
        state.task_queue.enqueue(&task_id).await;

        task_ids.push(task_id);

        tracing::info!(
            proposal_id = %proposal_id,
            branch_idx = idx,
            branch_id = %prepared.branch_id,
            task_id = %task_ids[idx],
            "Parallel fork branch task created"
        );
    }

    // 3. Update proposal status
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    ProposalRepository::update_status(pool, &proposal_id, "EXECUTED", Some(now)).await?;

    tracing::info!(
        proposal_id = %proposal_id,
        task_count = task_ids.len(),
        "Parallel fork proposal executed"
    );

    Ok(task_ids)
}
