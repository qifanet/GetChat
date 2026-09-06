/**
 * @file commands/agent_runs.rs
 * @description Agent run audit commands (v1.5.0 M5.1).
 *
 * `list_agent_runs` powers the loop-metrics panel and the settings list;
 * `export_agent_run` returns one full trail as JSON for download. Both are
 * read-only over the audit repository — the runner's auditor is the only
 * writer.
 */

use tauri::State;

use crate::dto::agent_runs::AgentRunDto;
use crate::error::AppError;
use crate::repositories::agent_runs as repo;
use crate::state::AppState;

#[tauri::command]
pub async fn list_agent_runs(
    state: State<'_, AppState>,
    conversation_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AgentRunDto>, AppError> {
    let rows = repo::find_recent(&state.db, conversation_id.as_deref(), limit).await?;
    Ok(rows.into_iter().map(AgentRunDto::from_row).collect())
}

/// Full audit trail of one run for JSON export; 404 when the id is unknown.
#[tauri::command]
pub async fn export_agent_run(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<AgentRunDto, AppError> {
    let row = repo::find_by_id(&state.db, &run_id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("agent run not found: {run_id}")))?;
    Ok(AgentRunDto::from_row(row))
}
