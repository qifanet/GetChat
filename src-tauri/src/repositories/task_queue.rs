/**
 * @file repositories/task_queue.rs
 * @description Task Queue repository for background task persistence (v1.5.0)
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
        })
    }
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

    #[allow(dead_code)]
    pub async fn find_next_queued(pool: &SqlitePool) -> Result<Option<TaskQueueRow>, AppError> {
        let row = sqlx::query(
            "SELECT id, conversation_id, task_type, status, parent_fork_id, config_json, result_json, error_message, priority, created_at, started_at, completed_at
             FROM task_queue
             WHERE status = 'QUEUED'
             ORDER BY priority DESC, created_at ASC
             LIMIT 1"
        )
        .fetch_optional(pool)
        .await?
        .map(|row| TaskQueueRow {
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
        });
        Ok(row)
    }

    #[allow(dead_code)]
    pub async fn update_status(
        pool: &SqlitePool,
        id: &str,
        status: &str,
        started_at: Option<i64>,
        completed_at: Option<i64>,
        result_json: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE task_queue
             SET status = ?, started_at = ?, completed_at = ?, result_json = ?, error_message = ?
             WHERE id = ?"
        )
        .bind(status)
        .bind(started_at)
        .bind(completed_at)
        .bind(result_json)
        .bind(error_message)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<TaskQueueRow>, AppError> {
        let rows = sqlx::query(
            "SELECT id, conversation_id, task_type, status, parent_fork_id, config_json, result_json, error_message, priority, created_at, started_at, completed_at
             FROM task_queue
             ORDER BY created_at DESC"
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| TaskQueueRow {
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
        })
        .collect();
        Ok(rows)
    }

    pub async fn cancel(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE task_queue
             SET status = 'CANCELLED'
             WHERE id = ? AND status = 'QUEUED'"
        )
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn get_next_queued(pool: &SqlitePool) -> Result<Option<TaskQueueRow>, AppError> {
        Self::find_next_queued(pool).await
    }

    pub async fn set_status(pool: &SqlitePool, id: &str, status: &str) -> Result<(), AppError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let (started_at, completed_at) = match status {
            "RUNNING" => (Some(now), None),
            "COMPLETED" | "FAILED" | "CANCELLED" => (None, Some(now)),
            _ => (None, None),
        };

        Self::update_status(pool, id, status, started_at, completed_at, None, None).await
    }

    pub async fn set_status_with_error(
        pool: &SqlitePool,
        id: &str,
        status: &str,
        error_message: &str,
    ) -> Result<(), AppError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        Self::update_status(pool, id, status, None, Some(now), None, Some(error_message)).await
    }
}
