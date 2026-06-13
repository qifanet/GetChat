-- Migration 0014: Proposals table for parallel fork review
-- Version: 0014
-- Date: 2026-06-10
-- Purpose: Store parallel fork proposals for user review and approval

CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    fork_point_message_id TEXT NOT NULL,
    proposal_type TEXT NOT NULL DEFAULT 'PARALLEL_FORK',
    status TEXT NOT NULL DEFAULT 'PENDING',
    branches_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    executed_at INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_proposals_conversation ON proposals(conversation_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
