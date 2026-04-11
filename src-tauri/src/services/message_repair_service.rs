/**
 * @file services/message_repair_service.rs
 * @description Startup repair service for inflight streaming messages.
 *
 * When the app is killed or crashes during streaming, messages with
 * status = STREAMING are left in the database. On next startup, these
 * "zombie" messages have no runtime registry or model connection to
 * complete them, so they would appear as permanently "generating" in the UI.
 *
 * This service runs during app initialization (before any snapshot loading)
 * and marks all orphaned STREAMING messages as ABORTED with a structured
 * error code that the frontend can use for display and retry logic.
 *
 * Design decisions:
 *   - No time threshold needed: after restart, ALL STREAMING messages are
 *     zombies (the runtime registry is in-memory and does not survive restart)
 *   - Uses ABORTED (not FAILED) because the model generation was interrupted,
 *     not due to an API error — the distinction helps the frontend decide
 *     whether to auto-retry
 *   - error_retriable = true so the UI can offer a "Retry" button
 *   - Partial text in content_text is preserved (not cleared)
 *   - Runs as a DB-only operation (no secure storage or network calls)
 */

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::repositories::messages;

/** Result of the inflight repair operation. */
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    /** Number of zombie streaming messages repaired */
    pub repaired_count: u64,
}

/**
 * Repair all inflight streaming messages from a previous app session.
 *
 * Must be called during bootstrap, AFTER DB connection is established
 * but BEFORE any snapshot loading or UI rendering.
 *
 * Returns the count of repaired messages for logging/diagnostics.
 */
pub async fn repair_inflight_messages(pool: &SqlitePool) -> Result<RepairResult, AppError> {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System clock before UNIX epoch")
        .as_secs() as i64;

    let repaired = messages::repair_inflight_streaming(pool, now_secs)
        .await
        .map_err(AppError::from)?;

    if repaired > 0 {
        tracing::warn!(
            "Repaired {} zombie streaming message(s) from previous session",
            repaired
        );
    } else {
        tracing::debug!("No zombie streaming messages found");
    }

    Ok(RepairResult {
        repaired_count: repaired,
    })
}
