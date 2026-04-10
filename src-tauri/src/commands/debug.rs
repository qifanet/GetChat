/**
 * @file commands/debug.rs
 * @description Debug-only diagnostic commands for development and integration testing.
 *
 * These commands are NOT part of the normal application flow.
 * They exist to:
 *   - Verify database integrity during development
 *   - Diagnose data pollution after integration tests
 *   - Support dev panels and test harnesses
 *
 * Do NOT call these from production UI components.
 */

use tauri::State;

use crate::dto::debug::InvariantCheckResult;
use crate::error::AppError;
use crate::services::invariant_service;
use crate::state::AppState;

// ============================================================================
// Commands
// ============================================================================

/**
 * Run all database invariant checks and return structured results.
 *
 * Checks include:
 *   - Cross-conversation message/branch references
 *   - Mainline branch integrity (exists, same conversation, active)
 *   - Non-destructive edit traceability (edited_from is USER, same conversation)
 *   - Stale streaming messages (stuck > 5 minutes)
 *   - Active conversations without branches
 *
 * Returns InvariantCheckResult with:
 *   - ok: true iff all checks passed
 *   - checks: ordered list of all check results
 *   - checked_at: timestamp of when checks were run
 */
#[tauri::command]
pub async fn check_db_invariants(
    state: State<'_, AppState>,
) -> Result<InvariantCheckResult, AppError> {
    invariant_service::check_all_invariants(&state.db).await
}
