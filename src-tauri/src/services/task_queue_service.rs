/**
 * @file services/task_queue_service.rs
 * @description Task Queue service for background task orchestration (v1.5.0)
 * 
 * Minimal implementation for v1.5.0:
 * - Serial task execution (one at a time)
 * - No persistent queue polling (tasks created on-demand)
 * - PARALLEL_FORK tasks only for now
 */

use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::dto::task_queue::TaskType;
use crate::error::AppError;
use crate::repositories::task_queue::TaskQueueRepository;

#[allow(dead_code)]
pub struct TaskQueueService {
    pool: SqlitePool,
    active_task: Arc<Mutex<Option<String>>>,
}

impl TaskQueueService {
    #[allow(dead_code)]
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            active_task: Arc::new(Mutex::new(None)),
        }
    }

    #[allow(dead_code)]
    pub async fn enqueue_task(
        &self,
        conversation_id: &str,
        task_type: TaskType,
        config: serde_json::Value,
        parent_fork_id: Option<String>,
    ) -> Result<String, AppError> {
        let task_id = format!("task_{}", uuid::Uuid::new_v4().simple());
        let config_json = serde_json::to_string(&config)
            .map_err(|e| AppError::invariant_violation(format!("Failed to serialize config: {}", e)))?;
        
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        
        TaskQueueRepository::create(
            &self.pool,
            &task_id,
            conversation_id,
            task_type.as_str(),
            &config_json,
            parent_fork_id.as_deref(),
            now,
        ).await?;

        tracing::info!(
            task_id = %task_id,
            conversation_id = %conversation_id,
            task_type = %task_type.as_str(),
            "task enqueued"
        );

        Ok(task_id)
    }

    #[allow(dead_code)]
    pub async fn is_active(&self) -> bool {
        self.active_task.lock().await.is_some()
    }
}
