/**
 * @file commands/task_queue.rs
 * @description Task Queue commands for background task management (v1.5.0)
 */

use tauri::State;

use crate::state::AppState;
use crate::dto::task_queue::TaskQueueItemDto;
use crate::error::AppError;
use crate::repositories::task_queue::TaskQueueRepository;

#[tauri::command]
pub async fn list_task_queue(state: State<'_, AppState>) -> Result<Vec<TaskQueueItemDto>, AppError> {
    let pool = &state.db;
    let rows = TaskQueueRepository::list_all(pool).await?;
    let dtos = rows
        .into_iter()
        .map(|row| row.to_dto())
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dtos)
}

/**
 * Cancel a queued, paused, or running task. Routing goes through the
 * scheduler so a RUNNING task's stream is aborted (watch signal) and its row
 * is marked CANCELLED by the worker, while QUEUED/PAUSED rows are cancelled
 * directly in the repository.
 */
#[tauri::command]
pub async fn cancel_task(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let cancelled = state.task_queue.cancel(&task_id).await?;
    if !cancelled {
        tracing::warn!(
            cmd = "cancel_task",
            task_id = %task_id,
            "task not in a cancellable state (already settled or unknown)"
        );
    }
    Ok(())
}
