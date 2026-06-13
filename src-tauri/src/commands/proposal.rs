/**
 * @file commands/proposal.rs
 * @description Proposal commands for parallel fork review (v1.5.0)
 */

use tauri::State;
use crate::state::AppState;
use crate::dto::proposal::{ProposalDto, ProposalBranchDto};
use crate::error::AppError;
use crate::repositories::proposal::ProposalRepository;

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

    // 2. Create branches and tasks
    let mut task_ids = Vec::new();

    for (idx, branch) in branches.iter().enumerate() {
        // Create branch
        let branch_id = format!("branch_{}", uuid::Uuid::new_v4().simple());
        
        // TODO: Call branch creation logic
        // For now, just create task entry
        let task_id = format!("task_{}", uuid::Uuid::new_v4().simple());
        
        let config = serde_json::json!({
            "branch_id": branch_id,
            "branch_name": branch.branch_name,
            "initial_message": branch.initial_message,
            "model_id": branch.model_id,
        });

        let config_json = serde_json::to_string(&config)
            .map_err(|e| AppError::invariant_violation(format!("Failed to serialize config: {}", e)))?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        crate::repositories::task_queue::TaskQueueRepository::create(
            pool,
            &task_id,
            &proposal.conversation_id,
            "PARALLEL_FORK",
            &config_json,
            None,
            now,
        ).await?;

        task_ids.push(task_id);

        tracing::info!(
            proposal_id = %proposal_id,
            branch_idx = idx,
            task_id = %task_ids[idx],
            "Parallel fork branch task created"
        );
    }

    // 3. Update proposal status
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    ProposalRepository::update_status(pool, &proposal_id, "EXECUTED", Some(now)).await?;

    tracing::info!(
        proposal_id = %proposal_id,
        task_count = task_ids.len(),
        "Parallel fork proposal executed"
    );

    Ok(task_ids)
}
