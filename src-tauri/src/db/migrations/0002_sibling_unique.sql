-- ============================================================================
-- BranchFlow SQLite Schema — Migration 0002
-- Version: 0002
-- Description: Add defensive unique constraint on sibling_index to prevent
--              duplicate sibling indices under the same parent message.
--
-- Rationale:
--   sibling_index is computed as MAX(sibling_index) + 1 within a transaction.
--   In a single-user desktop app, concurrent writes to the same parent are
--   practically impossible. However, this constraint provides a safety net:
--   - Prevents data corruption if a bug causes duplicate indices
--   - Makes the invariant enforceable at the DB level
--   - Catches errors early instead of producing silent tree corruption
--
-- Note: parent_message_id can be NULL (root messages). NULL values are not
-- considered equal in SQLite, so the unique index only applies to non-NULL
-- parents. Root messages (parent_message_id IS NULL) use conversation_id
-- + sibling_index for uniqueness instead.
-- ============================================================================

-- For non-root messages: unique (parent_message_id, sibling_index) combination.
-- This is the critical constraint — no two children of the same parent can
-- share a sibling_index. Without this, tree traversal order becomes ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_parent_sibling_unique
    ON messages(parent_message_id, sibling_index)
    WHERE parent_message_id IS NOT NULL;

-- For root messages: unique (conversation_id, sibling_index) combination.
-- Root messages have no parent, so we use conversation_id to scope them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_root_sibling_unique
    ON messages(conversation_id, sibling_index)
    WHERE parent_message_id IS NULL;
