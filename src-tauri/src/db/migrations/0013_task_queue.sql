-- Migration: Add task_queue table for background task management
-- Version: 0013
-- Date: 2026-06-02
-- Purpose: Support Task Queue architecture for parallel branch fork and other background tasks

CREATE TABLE IF NOT EXISTS task_queue (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    parent_fork_id TEXT,
    config_json TEXT NOT NULL,
    result_json TEXT,
    error_message TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
CREATE INDEX IF NOT EXISTS idx_task_queue_conv ON task_queue(conversation_id);
CREATE INDEX IF NOT EXISTS idx_task_queue_parent_fork ON task_queue(parent_fork_id);
