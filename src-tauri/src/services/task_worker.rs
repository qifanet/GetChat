/**
 * @file services/task_worker.rs
 * @description Background task worker for executing queued tasks (v1.5.0)
 */

use std::sync::Arc;
use sqlx::SqlitePool;
use tokio::time::{sleep, Duration};
use crate::repositories::task_queue::TaskQueueRepository;

pub struct TaskWorker {
    pool: SqlitePool,
}

impl TaskWorker {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn start(self: Arc<Self>) {
        tracing::info!("TaskWorker started");
        
        loop {
            if let Err(e) = self.process_next_task().await {
                tracing::error!("TaskWorker error: {}", e);
            }
            sleep(Duration::from_secs(1)).await;
        }
    }

    async fn process_next_task(&self) -> Result<(), String> {
        // Fetch next QUEUED task
        let task = TaskQueueRepository::get_next_queued(&self.pool).await
            .map_err(|e| e.to_string())?;
        
        let Some(task) = task else {
            return Ok(());
        };

        tracing::info!(
            task_id = %task.id,
            task_type = %task.task_type,
            "TaskWorker: Processing task"
        );

        // Update to RUNNING
        TaskQueueRepository::set_status(&self.pool, &task.id, "RUNNING").await
            .map_err(|e| e.to_string())?;

        // Execute based on task type
        let result = match task.task_type.as_str() {
            "PARALLEL_FORK" => self.execute_parallel_fork(task.clone()).await,
            _ => {
                tracing::warn!(task_type = %task.task_type, "Unknown task type");
                Err("Unknown task type".to_string())
            }
        };

        // Update status based on result
        match result {
            Ok(_) => {
                TaskQueueRepository::set_status(&self.pool, &task.id, "COMPLETED").await
                    .map_err(|e| e.to_string())?;
                tracing::info!(task_id = %task.id, "Task completed successfully");
            }
            Err(e) => {
                TaskQueueRepository::set_status_with_error(&self.pool, &task.id, "FAILED", &e).await
                    .map_err(|e| e.to_string())?;
                tracing::error!(task_id = %task.id, error = %e, "Task failed");
            }
        }

        Ok(())
    }

    async fn execute_parallel_fork(&self, task: crate::repositories::task_queue::TaskQueueRow) -> Result<(), String> {
        use crate::repositories::{branches, messages};
        use crate::services::snapshot_service;
        
        // Parse config
        let config: serde_json::Value = serde_json::from_str(&task.config_json)
            .map_err(|e| e.to_string())?;
        
        let branch_name = config.get("branch_name")
            .and_then(|v| v.as_str())
            .ok_or("Missing branch_name")?;
        
        let initial_message = config.get("initial_message")
            .and_then(|v| v.as_str())
            .ok_or("Missing initial_message")?;

        let model_id = config.get("model_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        tracing::info!(
            task_id = %task.id,
            branch_name = %branch_name,
            conversation_id = %task.conversation_id,
            "Creating branch"
        );

        // 1. Load current conversation snapshot to get mainline head
        let input = crate::dto::conversations::LoadConversationSnapshotInput {
            conversation_id: task.conversation_id.clone(),
        };
        let snapshot = snapshot_service::load_snapshot(&self.pool, &input).await
            .map_err(|e| format!("Failed to load snapshot: {}", e))?;

        let mainline_branch = snapshot.entities.branches.values()
            .find(|b| b.is_mainline)
            .ok_or("No mainline branch found")?;

        let fork_point_message_id = mainline_branch.head_message_id.clone()
            .ok_or("Mainline branch has no head message")?;

        // 2. Create new branch
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        
        let now_secs = (now_ms / 1000) as i64;

        let branch_id = format!("branch_{}", uuid::Uuid::new_v4().simple());

        branches::insert(
            &self.pool,
            &branch_id,
            &task.conversation_id,
            branch_name,
            "ACTIVE",
            Some(&mainline_branch.id),
            Some(&fork_point_message_id),
            "CURRENT_LEAF",
            Some(&fork_point_message_id),
            Some(&fork_point_message_id),
            model_id,
            now_secs,
        ).await.map_err(|e| format!("Failed to create branch: {}", e))?;

        tracing::info!(
            task_id = %task.id,
            branch_id = %branch_id,
            "Branch created, creating user message"
        );

        // 3. Create user message
        // Use a unique sibling_index by deriving from the task id hash
        // to avoid UNIQUE constraint collision with other parallel fork tasks
        let user_message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let sibling_idx = (task.id.as_bytes().iter().fold(0u32, |acc, &b| acc.wrapping_add(b as u32)) % 1000) as i32;

        messages::insert_user_message(
            &self.pool,
            &user_message_id,
            &task.conversation_id,
            Some(&fork_point_message_id),
            1,
            sibling_idx,
            initial_message,
            None,
            now_secs,
        ).await.map_err(|e| format!("Failed to create user message: {}", e))?;

        // 4. Update branch head
        branches::update_head(&self.pool, &branch_id, &user_message_id).await
            .map_err(|e| format!("Failed to update branch head: {}", e))?;

        tracing::info!(
            task_id = %task.id,
            branch_id = %branch_id,
            user_message_id = %user_message_id,
            "Parallel fork completed successfully"
        );

        Ok(())
    }
}
