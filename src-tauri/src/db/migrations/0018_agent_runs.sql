-- 0018: Agent run audit trail (v1.5.0 M5.1, ARCHITECTURE.md debt B6).
-- One row per ReAct run (id == request_id). Turns/approvals accumulate as
-- JSON documents so a finished run reads back as one record; incremental
-- updates after each turn keep the trail durable across crashes.
CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT,
    model_id TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    turns_json TEXT NOT NULL DEFAULT '[]',
    approvals_json TEXT NOT NULL DEFAULT '[]',
    outcome TEXT,
    outcome_detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
    ON agent_runs(conversation_id, started_at DESC);
