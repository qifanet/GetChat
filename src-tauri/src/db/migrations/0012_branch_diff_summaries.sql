-- Store AI-generated branch diff summaries for reuse.
CREATE TABLE IF NOT EXISTS branch_diff_summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_a_id TEXT NOT NULL,
    branch_b_id TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- Each branch pair keeps only the latest summary.
CREATE UNIQUE INDEX IF NOT EXISTS idx_diff_branches
    ON branch_diff_summaries(conversation_id, branch_a_id, branch_b_id);
