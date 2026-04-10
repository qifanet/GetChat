/**
 * @file services/invariant_service.rs
 * @description Debug-only database invariant checker.
 *
 * Runs a battery of diagnostic SQL queries to detect data integrity violations.
 * Each check is a self-contained query that returns violating rows.
 * Zero rows = invariant holds; any rows = violation.
 *
 * Design decisions:
 *   - Pure SQL checks wherever possible (single round-trip, no Rust logic needed)
 *   - Rust logic only for checks that require multi-step reasoning or computed thresholds
 *   - Sample rows capped at 10 to avoid large payloads
 *   - All checks are read-only; no mutations performed
 *
 * Usage: Called from debug command only. Not part of normal application flow.
 */

use sqlx::{Column, Row, SqlitePool};

use crate::dto::debug::{InvariantCheck, InvariantCheckResult};
use crate::error::AppError;

// ============================================================================
// Check Definitions
// ============================================================================

/** A single invariant check definition: code, label, and the SQL to detect violations. */
struct CheckDef {
    code: &'static str,
    label: &'static str,
    sql: &'static str,
}

/** Maximum number of sample rows returned per check. */
const MAX_SAMPLE_ROWS: i64 = 10;

/** Threshold in seconds for "stale" streaming messages (5 minutes). */
const STALE_STREAMING_THRESHOLD_SECS: i64 = 300;

/** Returns all invariant check definitions in logical order. */
fn all_checks() -> Vec<CheckDef> {
    vec![
        // ── 1. Message tree integrity ──────────────────────────────────
        CheckDef {
            code: "CROSS_CONV_PARENT_MESSAGE",
            label: "messages.parent_message_id must not reference a different conversation",
            sql: "
                SELECT m1.id, m1.conversation_id, m1.parent_message_id,
                       m2.conversation_id AS parent_conv_id
                FROM messages m1
                JOIN messages m2 ON m1.parent_message_id = m2.id
                WHERE m1.conversation_id != m2.conversation_id
                LIMIT ?
            ",
        },

        // ── 2. Branch head integrity ───────────────────────────────────
        CheckDef {
            code: "CROSS_CONV_BRANCH_HEAD",
            label: "branches.head_message_id must reference a message in the same conversation",
            sql: "
                SELECT b.id AS branch_id, b.conversation_id AS branch_conv_id,
                       b.head_message_id, m.conversation_id AS msg_conv_id
                FROM branches b
                JOIN messages m ON b.head_message_id = m.id
                WHERE b.conversation_id != m.conversation_id
                LIMIT ?
            ",
        },

        // ── 3a. Active conversation missing mainline ───────────────────
        CheckDef {
            code: "ACTIVE_CONV_NO_MAINLINE",
            label: "Active conversations must have a mainline_branch_id",
            sql: "
                SELECT c.id, c.title
                FROM conversations c
                WHERE c.mainline_branch_id IS NULL AND c.archived_at IS NULL
                LIMIT ?
            ",
        },

        // ── 3b. Mainline branch does not exist ─────────────────────────
        CheckDef {
            code: "MAINLINE_BRANCH_MISSING",
            label: "conversations.mainline_branch_id must reference an existing branch",
            sql: "
                SELECT c.id, c.mainline_branch_id
                FROM conversations c
                LEFT JOIN branches b ON c.mainline_branch_id = b.id
                WHERE c.mainline_branch_id IS NOT NULL AND b.id IS NULL
                LIMIT ?
            ",
        },

        // ── 3c. Mainline branch in wrong conversation ──────────────────
        CheckDef {
            code: "MAINLINE_BRANCH_WRONG_CONV",
            label: "conversations.mainline_branch_id must belong to the same conversation",
            sql: "
                SELECT c.id AS conv_id, c.mainline_branch_id,
                       b.conversation_id AS branch_belongs_to
                FROM conversations c
                JOIN branches b ON c.mainline_branch_id = b.id
                WHERE c.id != b.conversation_id
                LIMIT ?
            ",
        },

        // ── 3d. Mainline branch is ARCHIVED ────────────────────────────
        CheckDef {
            code: "MAINLINE_BRANCH_ARCHIVED",
            label: "conversations.mainline_branch_id must point to an ACTIVE branch",
            sql: "
                SELECT c.id AS conv_id, c.mainline_branch_id, b.status
                FROM conversations c
                JOIN branches b ON c.mainline_branch_id = b.id
                WHERE b.status = 'ARCHIVED'
                LIMIT ?
            ",
        },

        // ── 4a. edited_from cross-conversation ─────────────────────────
        CheckDef {
            code: "EDITED_FROM_CROSS_CONV",
            label: "messages.edited_from_message_id must reference same conversation",
            sql: "
                SELECT m1.id, m1.conversation_id, m1.edited_from_message_id,
                       m2.conversation_id AS source_conv_id
                FROM messages m1
                JOIN messages m2 ON m1.edited_from_message_id = m2.id
                WHERE m1.conversation_id != m2.conversation_id
                LIMIT ?
            ",
        },

        // ── 4b. edited_from must point to USER message ─────────────────
        CheckDef {
            code: "EDITED_FROM_NOT_USER",
            label: "messages.edited_from_message_id must reference a USER role message",
            sql: "
                SELECT m1.id, m1.edited_from_message_id, m2.role AS source_role
                FROM messages m1
                JOIN messages m2 ON m1.edited_from_message_id = m2.id
                WHERE m2.role != 'USER'
                LIMIT ?
            ",
        },

        // ── 5a. fork_point_message_id cross-conversation ───────────────
        CheckDef {
            code: "CROSS_CONV_FORK_POINT",
            label: "branches.fork_point_message_id must reference same conversation",
            sql: "
                SELECT b.id AS branch_id, b.conversation_id AS branch_conv_id,
                       b.fork_point_message_id, m.conversation_id AS msg_conv_id
                FROM branches b
                JOIN messages m ON b.fork_point_message_id = m.id
                WHERE b.conversation_id != m.conversation_id
                LIMIT ?
            ",
        },

        // ── 5b. fork_source_message_id cross-conversation ──────────────
        CheckDef {
            code: "CROSS_CONV_FORK_SOURCE",
            label: "branches.fork_source_message_id must reference same conversation",
            sql: "
                SELECT b.id AS branch_id, b.conversation_id AS branch_conv_id,
                       b.fork_source_message_id, m.conversation_id AS msg_conv_id
                FROM branches b
                JOIN messages m ON b.fork_source_message_id = m.id
                WHERE b.conversation_id != m.conversation_id
                LIMIT ?
            ",
        },

        // ── 6. Stale streaming messages ────────────────────────────────
        CheckDef {
            code: "STALE_STREAMING_MESSAGES",
            label: "Messages stuck in STREAMING status (app restart should clean these)",
            sql: "
                SELECT id, conversation_id, created_at, updated_at
                FROM messages
                WHERE status = 'STREAMING'
                  AND updated_at < unixepoch() - ?
                LIMIT ?
            ",
        },

        // ── 7a. Active conversation with no branches at all ────────────
        CheckDef {
            code: "ACTIVE_CONV_NO_BRANCHES",
            label: "Active conversations must have at least one branch",
            sql: "
                SELECT c.id, c.title
                FROM conversations c
                LEFT JOIN branches b ON b.conversation_id = c.id
                WHERE c.archived_at IS NULL AND b.id IS NULL
                LIMIT ?
            ",
        },

        // ── 7b. Active conversation with no ACTIVE branches ────────────
        CheckDef {
            code: "ACTIVE_CONV_NO_ACTIVE_BRANCHES",
            label: "Active conversations must have at least one ACTIVE branch",
            sql: "
                SELECT c.id, c.title
                FROM conversations c
                WHERE c.archived_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM branches b
                    WHERE b.conversation_id = c.id AND b.status = 'ACTIVE'
                  )
                LIMIT ?
            ",
        },
    ]
}

// ============================================================================
// Row to JSON conversion
// ============================================================================

/**
 * Convert a SQLite row to a JSON object.
 * Handles INTEGER → Number, TEXT → String, NULL → Null.
 * Sufficient for diagnostic output (not for precision-dependent use cases).
 */
fn row_to_json(row: &sqlx::sqlite::SqliteRow) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        let name = col.name();
        let value = if let Ok(v) = row.try_get::<i64, _>(i) {
            serde_json::Value::Number(v.into())
        } else if let Ok(v) = row.try_get::<String, _>(i) {
            serde_json::Value::String(v)
        } else {
            serde_json::Value::Null
        };
        map.insert(name.to_string(), value);
    }
    serde_json::Value::Object(map)
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run all database invariant checks.
 *
 * Each check executes a diagnostic SQL query. If the query returns rows,
 * those represent violations. The result includes:
 *   - ok: true iff all checks passed
 *   - checks: ordered list of all check results with sample rows
 *   - checked_at: timestamp of when checks were run
 */
pub async fn check_all_invariants(pool: &SqlitePool) -> Result<InvariantCheckResult, AppError> {
    let checks = all_checks();
    let mut results = Vec::with_capacity(checks.len());

    for def in checks {
        // Special handling for stale streaming check: pass threshold as parameter
        let rows = if def.code == "STALE_STREAMING_MESSAGES" {
            sqlx::query(def.sql)
                .bind(STALE_STREAMING_THRESHOLD_SECS)
                .bind(MAX_SAMPLE_ROWS)
                .fetch_all(pool)
                .await
                .map_err(|e| AppError::db_error(format!("Invariant check {} failed: {}", def.code, e)))?
        } else {
            sqlx::query(def.sql)
                .bind(MAX_SAMPLE_ROWS)
                .fetch_all(pool)
                .await
                .map_err(|e| AppError::db_error(format!("Invariant check {} failed: {}", def.code, e)))?
        };

        let row_count = rows.len() as i64;
        let sample_rows: Vec<serde_json::Value> = rows.iter().map(row_to_json).collect();

        results.push(InvariantCheck {
            code: def.code.to_string(),
            label: def.label.to_string(),
            passed: row_count == 0,
            row_count,
            sample_rows,
        });
    }

    let ok = results.iter().all(|c| c.passed);
    let checked_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System clock before UNIX epoch")
        .as_millis() as i64;

    Ok(InvariantCheckResult {
        ok,
        checks: results,
        checked_at,
    })
}
