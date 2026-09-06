/**
 * @file repositories/task_queue.rs
 * @description Task Queue persistence (v1.5.0).
 *
 * M4.1 added resilience semantics on top of the 0013 table: `attempts` counts
 * restart recoveries and 429 backoff cycles, `next_run_at` schedules PAUSED
 * wake-ups. The scheduler is the only writer of RUNNING/PAUSED transitions;
 * commands only enqueue and cancel.
 */

use sqlx::{Row, SqlitePool};

use crate::dto::task_queue::{TaskQueueItemDto, TaskStatus, TaskType};
use crate::error::AppError;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct TaskQueueRow {
    pub id: String,
    pub conversation_id: String,
    pub task_type: String,
    pub status: String,
    pub parent_fork_id: Option<String>,
    pub config_json: String,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
    pub priority: i64,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub attempts: i64,
    pub next_run_at: Option<i64>,
}

const ROW_COLUMNS: &str =
    "id, conversation_id, task_type, status, parent_fork_id, config_json, result_json, \
     error_message, priority, created_at, started_at, completed_at, attempts, next_run_at";

fn row_from_row(row: &sqlx::sqlite::SqliteRow) -> TaskQueueRow {
    TaskQueueRow {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        task_type: row.get("task_type"),
        status: row.get("status"),
        parent_fork_id: row.get("parent_fork_id"),
        config_json: row.get("config_json"),
        result_json: row.get("result_json"),
        error_message: row.get("error_message"),
        priority: row.get("priority"),
        created_at: row.get("created_at"),
        started_at: row.get("started_at"),
        completed_at: row.get("completed_at"),
        attempts: row.get("attempts"),
        next_run_at: row.get("next_run_at"),
    }
}

impl TaskQueueRow {
    pub fn to_dto(self) -> Result<TaskQueueItemDto, AppError> {
        let task_type = TaskType::from_str(&self.task_type)
            .ok_or_else(|| AppError::invariant_violation(format!("Invalid task_type: {}", self.task_type)))?;

        let status = TaskStatus::from_str(&self.status)
            .ok_or_else(|| AppError::invariant_violation(format!("Invalid status: {}", self.status)))?;

        let config: serde_json::Value = serde_json::from_str(&self.config_json)
            .map_err(|e| AppError::invariant_violation(format!("Invalid config_json: {}", e)))?;

        let result = self.result_json
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| AppError::invariant_violation(format!("Invalid result_json: {}", e)))?;

        Ok(TaskQueueItemDto {
            id: self.id,
            conversation_id: self.conversation_id,
            task_type,
            status,
            parent_fork_id: self.parent_fork_id,
            config,
            result,
            error_message: self.error_message,
            created_at: self.created_at,
            started_at: self.started_at,
            completed_at: self.completed_at,
            attempts: self.attempts,
            next_run_at: self.next_run_at,
        })
    }
}

/** Fetch a task row by id. */
pub async fn find_by_id(pool: &SqlitePool, id: &str) -> Result<Option<TaskQueueRow>, AppError> {
    let sql = format!("SELECT {ROW_COLUMNS} FROM task_queue WHERE id = ?");
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(|row| row_from_row(&row));
    Ok(row)
}

pub struct TaskQueueRepository;

impl TaskQueueRepository {
    #[allow(dead_code)]
    pub async fn create(
        pool: &SqlitePool,
        id: &str,
        conversation_id: &str,
        task_type: &str,
        config_json: &str,
        parent_fork_id: Option<&str>,
        created_at: i64,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO task_queue (id, conversation_id, task_type, status, config_json, parent_fork_id, priority, created_at)
             VALUES (?, ?, ?, 'QUEUED', ?, ?, 0, ?)"
        )
        .bind(id)
        .bind(conversation_id)
        .bind(task_type)
        .bind(config_json)
        .bind(parent_fork_id)
        .bind(created_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    /**
     * Atomically claim a QUEUED task whose schedule is due.
     *
     * The claim doubles as the guard: the UPDATE only lands when the row is
     * still QUEUED, so a concurrent scheduler or a racing cancel cannot dual-run
     * it. Tasks whose conversation already has a RUNNING task are skipped so a
     * conversation never has two streams racing into its message tree.
     */
    pub async fn claim_due(pool: &SqlitePool, now: i64) -> Result<Option<TaskQueueRow>, AppError> {
        let sql = format!(
            "SELECT {ROW_COLUMNS} FROM task_queue \
             WHERE id = (SELECT id FROM task_queue \
                         WHERE status = 'QUEUED' \
                           AND (next_run_at IS NULL OR next_run_at <= ?) \
                           AND conversation_id NOT IN (SELECT conversation_id FROM task_queue WHERE status = 'RUNNING') \
                         ORDER BY priority DESC, created_at ASC LIMIT 1)"
        );
        let candidate = sqlx::query(&sql)
            .bind(now)
            .fetch_optional(pool)
            .await?
            .map(|row| row_from_row(&row));

        let Some(candidate) = candidate else {
            return Ok(None);
        };

        let claimed = sqlx::query(
            "UPDATE task_queue SET status = 'RUNNING', started_at = COALESCE(started_at, ?) \
             WHERE id = ? AND status = 'QUEUED'",
        )
        .bind(now)
        .bind(&candidate.id)
        .execute(pool)
        .await?;

        if claimed.rows_affected() == 0 {
            // Cancelled between the select and the claim — nothing to run.
            return Ok(None);
        }
        Ok(Some(candidate))
    }

    /** Mark a task COMPLETED with its result payload. */
    pub async fn mark_completed(
        pool: &SqlitePool,
        id: &str,
        result_json: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE task_queue SET status = 'COMPLETED', completed_at = ?, result_json = ?, error_message = NULL \
             WHERE id = ?",
        )
        .bind(now_secs())
        .bind(result_json)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /** Mark a task FAILED (terminal) with the error text. */
    pub async fn mark_failed(pool: &SqlitePool, id: &str, error_message: &str) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE task_queue SET status = 'FAILED', completed_at = ?, error_message = ? WHERE id = ?",
        )
        .bind(now_secs())
        .bind(error_message)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /** Mark a RUNNING task CANCELLED (scheduler-side abort of an active stream). */
    pub async fn mark_cancelled(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE task_queue SET status = 'CANCELLED', completed_at = ? \
             WHERE id = ? AND status = 'RUNNING'",
        )
        .bind(now_secs())
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /**
     * Pause a task for a rate-limit backoff: bumps attempts, schedules the
     * wake-up, and records the reason for the frontend hint.
     */
    pub async fn pause_for_retry(
        pool: &SqlitePool,
        id: &str,
        next_run_at: i64,
        reason: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE task_queue SET status = 'PAUSED', next_run_at = ?, attempts = attempts + 1, error_message = ? \
             WHERE id = ?",
        )
        .bind(next_run_at)
        .bind(reason)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /** Re-queue PAUSED tasks whose backoff has elapsed. Returns how many woke. */
    pub async fn resume_due_paused(pool: &SqlitePool, now: i64) -> Result<u64, AppError> {
        let result = sqlx::query(
            "UPDATE task_queue SET status = 'QUEUED' WHERE status = 'PAUSED' AND next_run_at <= ?",
        )
        .bind(now)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /**
     * Startup recovery: re-queue tasks left RUNNING by an unclean shutdown and
     * bump their attempt counter. The pre-restart worker is gone; a RUNNING row
     * can never progress on its own.
     */
    pub async fn reset_running_for_startup(pool: &SqlitePool) -> Result<u64, AppError> {
        let result = sqlx::query(
            "UPDATE task_queue SET status = 'QUEUED', attempts = attempts + 1 WHERE status = 'RUNNING'",
        )
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /** Merge a progress object into config_json under the reserved "progress" key. */
    pub async fn update_progress(pool: &SqlitePool, id: &str, progress: serde_json::Value) -> Result<(), AppError> {
        let Some(row) = find_by_id(pool, id).await? else {
            return Ok(());
        };
        let mut config: serde_json::Value = serde_json::from_str(&row.config_json).unwrap_or_else(|_| serde_json::json!({}));
        {
            let obj = config.as_object_mut()
                .ok_or_else(|| AppError::invariant_violation("task config_json is not an object"))?;
            let entry = obj.entry("progress".to_string()).or_insert_with(|| serde_json::json!({}));
            match (entry.as_object_mut(), progress.as_object()) {
                (Some(existing), Some(incoming)) => existing.extend(incoming.clone()),
                _ => *entry = progress,
            }
        }
        let updated = serde_json::to_string(&config)
            .map_err(|e| AppError::invariant_violation(format!("Failed to serialize config: {e}")))?;
        sqlx::query("UPDATE task_queue SET config_json = ? WHERE id = ?")
            .bind(&updated)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<TaskQueueRow>, AppError> {
        let sql = format!("SELECT {ROW_COLUMNS} FROM task_queue ORDER BY created_at DESC");
        let rows = sqlx::query(&sql)
            .fetch_all(pool)
            .await?
            .iter()
            .map(row_from_row)
            .collect();
        Ok(rows)
    }

    /**
     * Cancel a QUEUED/PAUSED task row. Returns false when the task was not in
     * a cancellable state (already RUNNING — the scheduler cancels those via
     * the stream watch channel — or already settled).
     */
    pub async fn cancel(pool: &SqlitePool, id: &str) -> Result<bool, AppError> {
        let result = sqlx::query(
            "UPDATE task_queue SET status = 'CANCELLED', completed_at = ? \
             WHERE id = ? AND status IN ('QUEUED', 'PAUSED')",
        )
        .bind(now_secs())
        .bind(id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        // init_test_pool applies migrations through 0017 (incl. task_queue).
        crate::test_support::init_test_pool().await
    }

    async fn insert_task(pool: &SqlitePool, id: &str, conversation_id: &str) {
        // task_queue has a FK to conversations — create the parent row first.
        // OR IGNORE: several tests queue multiple tasks in one conversation.
        sqlx::query("INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, 't', 0, 0)")
            .bind(conversation_id)
            .execute(pool)
            .await
            .unwrap();
        TaskQueueRepository::create(pool, id, conversation_id, "PARALLEL_FORK", "{}", None, 0)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn claim_due_sets_running_and_respects_schedule() {
        let pool = test_pool().await;
        insert_task(&pool, "task_a", "conv_a").await;

        // Not yet due: schedule a future wake-up, then claim before it.
        sqlx::query("UPDATE task_queue SET next_run_at = 100 WHERE id = 'task_a'")
            .execute(&pool)
            .await
            .unwrap();
        let none = TaskQueueRepository::claim_due(&pool, 0).await.unwrap();
        assert!(none.is_none(), "task scheduled in the future must not be claimed");

        // Due once the wake-up time arrives.
        let claimed = TaskQueueRepository::claim_due(&pool, 100).await.unwrap();
        let task = claimed.expect("due task must be claimed");
        assert_eq!(task.id, "task_a");
        let row = find_by_id(&pool, "task_a").await.unwrap().unwrap();
        assert_eq!(row.status, "RUNNING");

        // A second claim must not hand out the same RUNNING task.
        let again = TaskQueueRepository::claim_due(&pool, 200).await.unwrap();
        assert!(again.is_none(), "RUNNING task must not be claimed twice");
    }

    #[tokio::test]
    async fn claim_due_skips_conversation_with_running_task() {
        let pool = test_pool().await;
        insert_task(&pool, "task_1", "conv_x").await;
        insert_task(&pool, "task_2", "conv_x").await;

        let first = TaskQueueRepository::claim_due(&pool, 1).await.unwrap().unwrap();
        assert_eq!(first.id, "task_1");

        let second = TaskQueueRepository::claim_due(&pool, 2).await.unwrap();
        assert!(
            second.is_none(),
            "a conversation with a RUNNING task must not get a second claim"
        );
    }

    #[tokio::test]
    async fn pause_for_retry_bumps_attempts_and_resume_requeues() {
        let pool = test_pool().await;
        insert_task(&pool, "task_p", "conv_p").await;
        assert!(TaskQueueRepository::claim_due(&pool, 1).await.unwrap().is_some());

        TaskQueueRepository::pause_for_retry(&pool, "task_p", 100, "429").await.unwrap();
        let paused = find_by_id(&pool, "task_p").await.unwrap().unwrap();
        assert_eq!(paused.status, "PAUSED");
        assert_eq!(paused.attempts, 1);
        assert_eq!(paused.next_run_at, Some(100));

        // Backoff not elapsed — stays paused.
        assert_eq!(TaskQueueRepository::resume_due_paused(&pool, 50).await.unwrap(), 0);
        // Elapsed — requeued.
        assert_eq!(TaskQueueRepository::resume_due_paused(&pool, 100).await.unwrap(), 1);
        let resumed = find_by_id(&pool, "task_p").await.unwrap().unwrap();
        assert_eq!(resumed.status, "QUEUED");
    }

    #[tokio::test]
    async fn startup_recovery_requeues_running_with_attempt_bump() {
        let pool = test_pool().await;
        insert_task(&pool, "task_r", "conv_r").await;
        assert!(TaskQueueRepository::claim_due(&pool, 1).await.unwrap().is_some());

        TaskQueueRepository::reset_running_for_startup(&pool).await.unwrap();
        let row = find_by_id(&pool, "task_r").await.unwrap().unwrap();
        assert_eq!(row.status, "QUEUED");
        assert_eq!(row.attempts, 1);
    }

    #[tokio::test]
    async fn cancel_allows_queued_and_paused_only() {
        let pool = test_pool().await;
        insert_task(&pool, "task_q", "conv_q").await;
        insert_task(&pool, "task_x", "conv_x2").await;
        assert!(TaskQueueRepository::claim_due(&pool, 1).await.unwrap().is_some()); // task_q → RUNNING

        TaskQueueRepository::pause_for_retry(&pool, "task_x", 999, "429").await.unwrap();

        // RUNNING cannot be cancelled through the SQL path.
        TaskQueueRepository::cancel(&pool, "task_q").await.unwrap();
        assert_eq!(find_by_id(&pool, "task_q").await.unwrap().unwrap().status, "RUNNING");

        // PAUSED can.
        TaskQueueRepository::cancel(&pool, "task_x").await.unwrap();
        assert_eq!(find_by_id(&pool, "task_x").await.unwrap().unwrap().status, "CANCELLED");
    }

    #[tokio::test]
    async fn update_progress_merges_without_clobbering_config() {
        let pool = test_pool().await;
        insert_task(&pool, "task_g", "conv_g").await;

        TaskQueueRepository::update_progress(&pool, "task_g", serde_json::json!({"phase": "STREAMING"}))
            .await
            .unwrap();
        TaskQueueRepository::update_progress(&pool, "task_g", serde_json::json!({"iterations": 2}))
            .await
            .unwrap();

        let row = find_by_id(&pool, "task_g").await.unwrap().unwrap();
        let config: serde_json::Value = serde_json::from_str(&row.config_json).unwrap();
        assert_eq!(config["progress"]["phase"], "STREAMING");
        assert_eq!(config["progress"]["iterations"], 2);
    }
}
