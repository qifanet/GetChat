/**
 * @file dto/debug.rs
 * @description DTOs for debug-only diagnostic commands.
 *
 * These types are used exclusively by the debug invariant checker.
 * They are NOT part of the normal application flow and should never
 * be called from production UI components.
 */

use serde::{Deserialize, Serialize};

// ============================================================================
// Output DTOs
// ============================================================================

/**
 * Result of running all database invariant checks.
 *
 * Designed for dev panels and integration test diagnostics:
 *   - ok = true means ALL checks passed (zero issues)
 *   - Each InvariantCheck is independent; partial failures are reported individually
 *   - sampleRows provides up to 10 violating rows for quick diagnosis
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvariantCheckResult {
    /** true iff all checks passed (issues is empty) */
    pub ok: bool,

    /** Ordered list of all checks performed */
    pub checks: Vec<InvariantCheck>,

    /** Unix timestamp (ms) when checks were run */
    pub checked_at: i64,
}

/**
 * A single invariant check with its result.
 *
 * Each check runs a diagnostic SQL query. If the query returns rows,
 * those represent violations. rowCount=0 means the invariant holds.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvariantCheck {
    /** Machine-readable check identifier (e.g., "CROSS_CONV_PARENT_MESSAGE") */
    pub code: String,

    /** Human-readable description of what this check verifies */
    pub label: String,

    /** true iff rowCount == 0 (no violations found) */
    pub passed: bool,

    /** Number of rows violating this invariant */
    pub row_count: i64,

    /** Up to 10 sample violating rows as JSON objects */
    pub sample_rows: Vec<serde_json::Value>,
}
