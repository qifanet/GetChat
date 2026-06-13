/**
 * @file dto/task_queue.rs
 * @description Task Queue DTOs for background task management (v1.5.0)
 */

use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskType {
    ParallelFork,
    TitleGeneration,
}

impl TaskType {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskType::ParallelFork => "PARALLEL_FORK",
            TaskType::TitleGeneration => "TITLE_GENERATION",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "PARALLEL_FORK" => Some(TaskType::ParallelFork),
            "TITLE_GENERATION" => Some(TaskType::TitleGeneration),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Queued => "QUEUED",
            TaskStatus::Running => "RUNNING",
            TaskStatus::Paused => "PAUSED",
            TaskStatus::Completed => "COMPLETED",
            TaskStatus::Failed => "FAILED",
            TaskStatus::Cancelled => "CANCELLED",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "QUEUED" => Some(TaskStatus::Queued),
            "RUNNING" => Some(TaskStatus::Running),
            "PAUSED" => Some(TaskStatus::Paused),
            "COMPLETED" => Some(TaskStatus::Completed),
            "FAILED" => Some(TaskStatus::Failed),
            "CANCELLED" => Some(TaskStatus::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueItemDto {
    pub id: String,
    pub conversation_id: String,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub parent_fork_id: Option<String>,
    pub config: serde_json::Value,
    pub result: Option<serde_json::Value>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}
