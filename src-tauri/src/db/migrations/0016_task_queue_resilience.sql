-- 0016: Task queue resilience (M4.1/M4.2).
-- attempts tracks restart recovery and 429 backoff cycles; next_run_at is the
-- scheduled wake-up for PAUSED tasks (rate-limit Retry-After). Existing columns
-- are unchanged; the scheduler treats a NULL next_run_at as immediately due.

ALTER TABLE task_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_queue ADD COLUMN next_run_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_task_queue_next_run_at ON task_queue(next_run_at);
