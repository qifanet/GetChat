-- Phase E: add context_window_kb to provider_models, local_path to skills,
-- and create compressed_contexts table for context management.

-- 1. Context window size per model (unit: K tokens, default 64K)
ALTER TABLE provider_models ADD COLUMN context_window_kb INTEGER NOT NULL DEFAULT 64;

-- 2. Local filesystem path for skill definitions
ALTER TABLE skill_definitions ADD COLUMN local_path TEXT NOT NULL DEFAULT '';

-- 3. Compressed context summaries (replaces older messages with a summary)
CREATE TABLE IF NOT EXISTS compressed_contexts (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id       TEXT NOT NULL,
    summary_text    TEXT NOT NULL DEFAULT '',
    compressed_message_ids TEXT NOT NULL DEFAULT '[]',
    token_count     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_compressed_contexts_branch
    ON compressed_contexts(conversation_id, branch_id);
