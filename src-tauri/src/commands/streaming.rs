/**
 * @file commands/streaming.rs
 * @description Runtime model streaming commands.
 *
 * These commands do not mutate persisted conversation entities directly.
 * Instead, they bridge provider HTTP streams into frontend channel events while
 * the frontend continues to own placeholder creation, completion, and failure
 * persistence through the existing message commands.
 */

use tauri::{ipc::Channel, State};
use tokio::sync::watch;

use crate::dto::streaming::{ModelStreamEventDto, StartModelStreamInput};
use crate::error::AppError;
use crate::services::model_stream_service::{self, ModelStreamOutcome};
use crate::state::AppState;

// ============================================================================
// Commands
// ============================================================================

/**
 * Start a provider-backed model stream and forward normalized events over IPC.
 *
 * The command stores a cancellation sender in AppState so abort_model_stream
 * can request shutdown without exposing provider credentials to the frontend.
 */
#[tauri::command]
pub async fn start_model_stream(
    state: State<'_, AppState>,
    input: StartModelStreamInput,
    channel: Channel<ModelStreamEventDto>,
) -> Result<(), AppError> {
    let start = std::time::Instant::now();
    let request_id = input.request_id.clone();
    let provider_id = input.provider_id.clone();
    let model_id = input.model_id.clone();

    let mut active_streams = state.active_model_streams.lock().await;
    if active_streams.contains_key(&request_id) {
        let _ = channel.send(ModelStreamEventDto::Failed {
            request_id: request_id.clone(),
            code: "STREAM_ALREADY_ACTIVE".to_string(),
            message: "A stream with the same requestId is already active".to_string(),
            retriable: true,
        });
        return Ok(());
    }

    let (cancel_tx, cancel_rx) = watch::channel(false);
    active_streams.insert(request_id.clone(), cancel_tx);
    drop(active_streams);

    let resolved = match model_stream_service::resolve_stream_request(
        &state.db,
        state.key_store.as_ref(),
        &input,
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(failure) => {
            state.active_model_streams.lock().await.remove(&request_id);
            let _ = channel.send(failure.to_event(&request_id));
            tracing::warn!(
                cmd = "start_model_stream",
                request_id = %request_id,
                provider_id = %provider_id,
                model_id = %model_id,
                error_code = %failure.code,
                message = %failure.message,
                duration_ms = start.elapsed().as_millis() as u64,
                "validation_failed"
            );
            return Ok(());
        }
    };

    let result =
        model_stream_service::stream_model_response(&resolved, &channel, cancel_rx).await;
    state.active_model_streams.lock().await.remove(&request_id);

    match result {
        Ok(ModelStreamOutcome::Completed { usage }) => {
            let _ = channel.send(ModelStreamEventDto::Completed {
                request_id: request_id.clone(),
                usage,
            });
            tracing::info!(
                cmd = "start_model_stream",
                request_id = %request_id,
                provider_id = %provider_id,
                model_id = %model_id,
                duration_ms = start.elapsed().as_millis() as u64,
                "completed"
            );
        }
        Ok(ModelStreamOutcome::Cancelled) => {
            tracing::info!(
                cmd = "start_model_stream",
                request_id = %request_id,
                provider_id = %provider_id,
                model_id = %model_id,
                duration_ms = start.elapsed().as_millis() as u64,
                "cancelled"
            );
        }
        Err(failure) => {
            let _ = channel.send(failure.to_event(&request_id));
            tracing::warn!(
                cmd = "start_model_stream",
                request_id = %request_id,
                provider_id = %provider_id,
                model_id = %model_id,
                error_code = %failure.code,
                message = %failure.message,
                duration_ms = start.elapsed().as_millis() as u64,
                "failed"
            );
        }
    }

    Ok(())
}

/**
 * Request cancellation of an active model stream.
 *
 * Missing request IDs are treated as no-ops because the stream may have just
 * completed or failed locally before the abort request reached the backend.
 */
#[tauri::command]
pub async fn abort_model_stream(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), AppError> {
    let sender = {
        let active_streams = state.active_model_streams.lock().await;
        active_streams.get(&request_id).cloned()
    };

    if let Some(sender) = sender {
        let _ = sender.send(true);
    }

    tracing::info!(cmd = "abort_model_stream", request_id = %request_id, "ok");
    Ok(())
}
