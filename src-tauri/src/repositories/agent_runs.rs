/**
 * @file repositories/agent_runs.rs
 * @description Agent run audit trail persistence (v1.5.0 M5.1, debt B6).
 *
 * One row per ReAct run (id == request_id). The runner's auditor writes
 * incrementally — start on `run_started`, `turns_json`/`approvals_json`
 * snapshots after each turn or approval, outcome on every exit path — so a
 * crash mid-run still leaves the turns recorded so far.
 *
 * All writers are best-effort: audit failures log a warning and never fail
 * the stream they observe.
 */

use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct AgentRunRow {
    pub id: String,
    pub conversation_id: String,
    pub branch_id: Option<String>,
    pub model_id: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub turns_json: String,
    pub approvals_json: String,
    pub outcome: Option<String>,
    pub outcome_detail: Option<String>,
}

const ROW_COLUMNS: &str =
    "id, conversation_id, branch_id, model_id, started_at, finished_at, turns_json, \
     approvals_json, outcome, outcome_detail";

fn row_from_row(row: &sqlx::sqlite::SqliteRow) -> AgentRunRow {
    AgentRunRow {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        branch_id: row.get("branch_id"),
        model_id: row.get("model_id"),
        started_at: row.get("started_at"),
        finished_at: row.get("finished_at"),
        turns_json: row.get("turns_json"),
        approvals_json: row.get("approvals_json"),
        outcome: row.get("outcome"),
        outcome_detail: row.get("outcome_detail"),
    }
}

/// Insert the row for a run that just started. Idempotent per run id.
pub async fn insert_started(
    pool: &SqlitePool,
    id: &str,
    conversation_id: &str,
    branch_id: Option<&str>,
    model_id: Option<&str>,
    started_at: i64,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT OR IGNORE INTO agent_runs \
         (id, conversation_id, branch_id, model_id, started_at, turns_json, approvals_json) \
         VALUES (?, ?, ?, ?, ?, '[]', '[]')",
    )
    .bind(id)
    .bind(conversation_id)
    .bind(branch_id)
    .bind(model_id)
    .bind(started_at)
    .execute(pool)
    .await
    .map_err(|e| AppError::db_error(format!("agent_runs insert_started failed: {e}")))?;
    Ok(())
}

/// Replace the turns JSON document with the auditor's current snapshot.
pub async fn update_turns(pool: &SqlitePool, id: &str, turns_json: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE agent_runs SET turns_json = ? WHERE id = ?")
        .bind(turns_json)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::db_error(format!("agent_runs update_turns failed: {e}")))?;
    Ok(())
}

/// Replace the approvals JSON document with the auditor's current snapshot.
pub async fn update_approvals(
    pool: &SqlitePool,
    id: &str,
    approvals_json: &str,
) -> Result<(), AppError> {
    sqlx::query("UPDATE agent_runs SET approvals_json = ? WHERE id = ?")
        .bind(approvals_json)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::db_error(format!("agent_runs update_approvals failed: {e}")))?;
    Ok(())
}

/// Stamp the terminal outcome. Only the first write wins so late/idempotent
/// calls (e.g. a cancel racing completion) cannot rewrite history.
pub async fn finish(
    pool: &SqlitePool,
    id: &str,
    outcome: &str,
    outcome_detail: Option<&str>,
    finished_at: i64,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE agent_runs \
         SET outcome = ?, outcome_detail = ?, finished_at = ? \
         WHERE id = ? AND outcome IS NULL",
    )
    .bind(outcome)
    .bind(outcome_detail)
    .bind(finished_at)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::db_error(format!("agent_runs finish failed: {e}")))?;
    Ok(())
}

#[allow(dead_code)]
pub async fn find_by_id(pool: &SqlitePool, id: &str) -> Result<Option<AgentRunRow>, AppError> {
    let sql = format!("SELECT {ROW_COLUMNS} FROM agent_runs WHERE id = ?");
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::db_error(format!("agent_runs find_by_id failed: {e}")))?;
    Ok(row.map(|r| row_from_row(&r)))
}

/// Most recent runs, newest first. `conversation_id` filters to one
/// conversation; `limit` defaults to 20 when `None` or non-positive.
pub async fn find_recent(
    pool: &SqlitePool,
    conversation_id: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<AgentRunRow>, AppError> {
    let limit = limit.filter(|l| *l > 0).unwrap_or(20);
    let rows = match conversation_id {
        Some(conversation_id) => {
            let sql = format!(
                "SELECT {ROW_COLUMNS} FROM agent_runs WHERE conversation_id = ? \
                 ORDER BY started_at DESC LIMIT ?"
            );
            sqlx::query(&sql)
                .bind(conversation_id)
                .bind(limit)
                .fetch_all(pool)
                .await
        }
        None => {
            let sql = format!(
                "SELECT {ROW_COLUMNS} FROM agent_runs ORDER BY started_at DESC LIMIT ?"
            );
            sqlx::query(&sql).bind(limit).fetch_all(pool).await
        }
    };
    rows.map_err(|e| AppError::db_error(format!("agent_runs find_recent failed: {e}")))
        .map(|rows| rows.iter().map(row_from_row).collect())
}

/// Parse a JSON document column defensively (audit data must stay readable
/// even if a partial write ever landed).
#[allow(dead_code)]
pub fn parse_json_or_empty(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Array(vec![]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::init_test_pool;

    async fn sample_run(pool: &SqlitePool, id: &str) {
        insert_started(pool, id, "conv_audit", Some("branch_audit"), Some("model-x"), 100)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn start_turn_finish_roundtrip() {
        let pool = init_test_pool().await;
        sample_run(&pool, "run_1").await;

        update_turns(&pool, "run_1", r#"[{"turn":0,"toolCalls":[]}]"#).await.unwrap();
        update_approvals(&pool, "run_1", r#"[{"decision":"APPROVED"}]"#).await.unwrap();
        finish(&pool, "run_1", "COMPLETED", None, 200).await.unwrap();

        let row = find_by_id(&pool, "run_1").await.unwrap().unwrap();
        assert_eq!(row.conversation_id, "conv_audit");
        assert_eq!(row.started_at, 100);
        assert_eq!(row.finished_at, Some(200));
        assert_eq!(row.outcome.as_deref(), Some("COMPLETED"));
        assert!(row.turns_json.contains("\"turn\":0"));

        let recent = find_recent(&pool, Some("conv_audit"), None).await.unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "run_1");
    }

    #[tokio::test]
    async fn finish_is_first_write_wins() {
        let pool = init_test_pool().await;
        sample_run(&pool, "run_2").await;

        finish(&pool, "run_2", "COMPLETED", None, 200).await.unwrap();
        // A racing cancel (or duplicate settle) must not rewrite the outcome.
        finish(&pool, "run_2", "CANCELLED", None, 300).await.unwrap();

        let row = find_by_id(&pool, "run_2").await.unwrap().unwrap();
        assert_eq!(row.outcome.as_deref(), Some("COMPLETED"));
        assert_eq!(row.finished_at, Some(200));
    }

    #[tokio::test]
    async fn find_recent_orders_newest_first_and_limits() {
        let pool = init_test_pool().await;
        for (id, started_at) in [("run_a", 100), ("run_b", 200), ("run_c", 300)] {
            insert_started(&pool, id, "conv_audit", None, None, started_at)
                .await
                .unwrap();
        }

        let all = find_recent(&pool, Some("conv_audit"), None).await.unwrap();
        let ids: Vec<&str> = all.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["run_c", "run_b", "run_a"]);

        let limited = find_recent(&pool, Some("conv_audit"), Some(2)).await.unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].id, "run_c");

        // Other conversations stay isolated.
        assert!(find_recent(&pool, Some("conv_other"), None).await.unwrap().is_empty());
    }
}
