-- ============================================================================
-- BranchFlow SQLite Schema — Initial Migration
-- Version: 0001
-- Description: Core tables for a local-first AI exploration workbench with
--              non-destructive branching, message tree, and provider management.
-- ============================================================================

-- ============================================================================
-- DESIGN RATIONALE
-- ============================================================================
--
-- Why NO branch_messages mapping table?
--   A branch is a named path pointer defined by two endpoints:
--     fork_point_message_id  (shared ancestor — where paths diverge)
--     head_message_id        (current tip — where the branch ends)
--   The full message list is derived by walking the tree upward from head
--   to fork_point using parent_message_id. Storing an explicit mapping would
--   duplicate the tree structure and create consistency risks on every edit.
--
-- Why NO variants table?
--   A variant (regenerate result) is simply multiple assistant messages
--   sharing the same parent_message_id — they are siblings in the message
--   tree, not a separate entity. A variant is "promoted" to a branch only
--   when the user continues from it, at which point a branch record is
--   created with fork_source_type = 'VARIANT'.
--
-- Why no is_mainline column in branches?
--   conversations.mainline_branch_id is the single source of truth.
--   Setting mainline only updates this one column — no branch rows change.
--   This prevents dual-indicator consistency bugs.
--
-- Why api_key_ref instead of api_key in providers?
--   Plaintext API keys must never reside in the database file. api_key_ref
--   stores a reference to the OS secure storage (keychain / Credential
--   Manager / libsecret). The frontend receives only the ref, never the key.
--
-- Circular FK note:
--   conversations.mainline_branch_id → branches.id
--   branches.conversation_id → conversations.id
--   This circular reference is valid — SQLite stores FK declarations
--   regardless of table creation order. Application code resolves the
--   dependency via transactions (create conversation → create branch →
--   set mainline_branch_id).
-- ============================================================================


-- ============================================================================
-- 1. app_kv — Global key-value store
-- ============================================================================
-- Stores application-level configuration such as:
--   - last_workspace: JSON blob for workspace restoration on launch
--   - theme, language, sidebar_width, etc.
-- NOT for large or frequently-updated data (use dedicated tables for those).
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_kv (
    key         TEXT NOT NULL PRIMARY KEY,
    value_json  TEXT NOT NULL DEFAULT '{}',
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);


-- ============================================================================
-- 2. providers — AI provider configurations
-- ============================================================================
-- Each provider describes an API endpoint and its connection details.
-- api_key_ref is a lookup key for OS secure storage — NEVER store plaintext.
-- ============================================================================

CREATE TABLE IF NOT EXISTS providers (
    id                TEXT NOT NULL PRIMARY KEY,
    type              TEXT NOT NULL,              -- 'OPENAI_COMPATIBLE' | 'OLLAMA'
    name              TEXT NOT NULL,              -- Display name (e.g. "GPT-4o Workspace")
    base_url          TEXT NOT NULL DEFAULT '',   -- API base URL
    api_key_ref       TEXT NOT NULL DEFAULT '',   -- Secure storage reference (NOT plaintext)
    default_model_id  TEXT NOT NULL DEFAULT '',   -- Default model for this provider
    enabled           INTEGER NOT NULL DEFAULT 1, -- 0 = disabled, 1 = enabled
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),

    CHECK (enabled IN (0, 1))
);


-- ============================================================================
-- 3. conversations — Conversation containers
-- ============================================================================
-- A conversation groups messages and branches into a single workspace.
-- mainline_branch_id is the SOLE mainline indicator — toggling mainline
-- only changes this column, no branch rows are modified.
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
    id                  TEXT NOT NULL PRIMARY KEY,
    title               TEXT NOT NULL DEFAULT '',
    mainline_branch_id  TEXT,                     -- FK → branches.id (nullable for new conversations)
    created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_opened_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    archived_at         INTEGER                   -- NULL = active, epoch seconds = archived

    -- FK to branches.id is intentionally omitted here to avoid DDL ordering
    -- issues with the circular dependency. Application-level transactions
    -- guarantee referential integrity.
);


-- ============================================================================
-- 4. messages — Message tree (core data structure)
-- ============================================================================
-- Messages form a tree via parent_message_id. Branches are pointers into
-- this tree — they do NOT own or map to specific messages.
--
-- Status lifecycle:
--   STREAMING → COMPLETED  (normal completion)
--   STREAMING → FAILED     (error with optional retry)
--   STREAMING → ABORTED    (user cancelled)
--
-- edited_from_message_id enables non-destructive edit traceability:
--   When a user edits a historical message, a NEW message is created with
--   edited_from_message_id pointing to the original. The original is never
--   modified.
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    id                      TEXT NOT NULL PRIMARY KEY,
    conversation_id         TEXT NOT NULL,
    role                    TEXT NOT NULL,                -- 'USER' | 'ASSISTANT' | 'SYSTEM'
    status                  TEXT NOT NULL DEFAULT 'COMPLETED', -- 'STREAMING' | 'COMPLETED' | 'FAILED' | 'ABORTED'
    parent_message_id       TEXT,                         -- NULL = root message, forms the tree
    depth                   INTEGER NOT NULL DEFAULT 0,   -- Tree depth (root = 0)
    sibling_index           INTEGER NOT NULL DEFAULT 0,   -- Order among siblings sharing the same parent
    content_text            TEXT NOT NULL DEFAULT '',      -- Message text content
    content_format          TEXT NOT NULL DEFAULT 'MARKDOWN', -- 'MARKDOWN' | 'PLAIN'
    provider_id             TEXT,                          -- Which provider generated this (assistant only)
    model_id                TEXT,                          -- Which model was used (assistant only)
    request_id              TEXT,                          -- Streaming correlation ID (unique per request)
    generation_params_json  TEXT NOT NULL DEFAULT '{}',    -- Model parameters (temperature, top_p, etc.)
    usage_json              TEXT NOT NULL DEFAULT '{}',    -- Token usage stats after completion
    error_code              TEXT,                          -- Machine-readable error code
    error_message           TEXT,                          -- Human-readable error description
    error_retriable         INTEGER,                       -- 1 = retriable, 0 = permanent, NULL = no error
    edited_from_message_id  TEXT,                          -- Non-destructive edit: points to original message
    created_at              INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at              INTEGER NOT NULL DEFAULT (strftime('%s','now')),

    CHECK (role IN ('USER', 'ASSISTANT', 'SYSTEM')),
    CHECK (status IN ('STREAMING', 'COMPLETED', 'FAILED', 'ABORTED')),
    CHECK (content_format IN ('MARKDOWN', 'PLAIN')),
    CHECK (error_retriable IS NULL OR error_retriable IN (0, 1)),

    FOREIGN KEY (conversation_id)      REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_message_id)    REFERENCES messages(id)      ON DELETE RESTRICT,
    FOREIGN KEY (edited_from_message_id) REFERENCES messages(id)    ON DELETE SET NULL
);


-- ============================================================================
-- 5. branches — Named path pointers into the message tree
-- ============================================================================
-- A branch does NOT duplicate or map messages. It is defined by:
--   fork_point_message_id  — the shared ancestor where divergence begins
--   head_message_id        — the current tip of this branch
-- The full path is computed at snapshot-load time by walking parent_message_id
-- from head back to fork_point.
--
-- fork_source_type distinguishes WHY the branch was created:
--   HISTORY_ASSISTANT  — user continued from a historical assistant message
--   HISTORY_USER_EDIT  — user edited a historical user message
--   CURRENT_LEAF       — user explicitly created a new branch from the leaf
--   VARIANT            — user continued from a variant assistant with downstream conflict
-- ============================================================================

CREATE TABLE IF NOT EXISTS branches (
    id                      TEXT NOT NULL PRIMARY KEY,
    conversation_id         TEXT NOT NULL,
    name                    TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE' | 'ARCHIVED'
    source_branch_id        TEXT,                            -- Which branch this forked from
    fork_point_message_id   TEXT,                            -- Shared ancestor message
    fork_source_type        TEXT NOT NULL DEFAULT 'CURRENT_LEAF', -- 'HISTORY_ASSISTANT' | 'HISTORY_USER_EDIT' | 'CURRENT_LEAF' | 'VARIANT'
    fork_source_message_id  TEXT,                            -- The specific message that triggered the fork
    head_message_id         TEXT,                            -- Current tip of this branch path
    color                   TEXT NOT NULL DEFAULT '',        -- UI display color (hex)
    summary                 TEXT NOT NULL DEFAULT '',        -- Branch summary text
    created_at              INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at              INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    archived_at             INTEGER,                        -- NULL = active, epoch seconds = archived

    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
    CHECK (fork_source_type IN ('ROOT', 'HISTORY_ASSISTANT', 'HISTORY_USER_EDIT', 'CURRENT_LEAF', 'VARIANT')),

    FOREIGN KEY (conversation_id)        REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (source_branch_id)       REFERENCES branches(id)      ON DELETE SET NULL,
    FOREIGN KEY (fork_point_message_id)  REFERENCES messages(id)      ON DELETE RESTRICT,
    FOREIGN KEY (fork_source_message_id) REFERENCES messages(id)      ON DELETE SET NULL,
    FOREIGN KEY (head_message_id)        REFERENCES messages(id)      ON DELETE RESTRICT
);


-- ============================================================================
-- INDEXES
-- ============================================================================

-- Core tree traversal: find children of a message in sibling order.
-- This is the most critical index — every path walk and tree query uses it.
CREATE INDEX IF NOT EXISTS idx_messages_parent_sibling
    ON messages(parent_message_id, sibling_index);

-- Conversation message lookup: list all messages in a conversation.
CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id);

-- Branch listing: active branches for a conversation, sorted by recency.
CREATE INDEX IF NOT EXISTS idx_branches_conv_status_updated
    ON branches(conversation_id, status, updated_at DESC);

-- Sibling branch discovery: find all branches that fork from the same point.
-- Used by selectSiblingBranches and compare mode.
CREATE INDEX IF NOT EXISTS idx_branches_fork_point
    ON branches(fork_point_message_id);

-- Branch head lookup: find which branch a message belongs to (by its tip).
CREATE INDEX IF NOT EXISTS idx_branches_head
    ON branches(head_message_id);

-- Streaming correlation: request_id must be unique when present.
-- Partial index — NULL request_ids are excluded (user/system messages).
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_request_id
    ON messages(request_id) WHERE request_id IS NOT NULL;

-- Non-destructive edit tracing: find all edits derived from a source message.
CREATE INDEX IF NOT EXISTS idx_messages_edited_from
    ON messages(edited_from_message_id) WHERE edited_from_message_id IS NOT NULL;

-- Conversation recency sorting: order conversations by last opened time.
CREATE INDEX IF NOT EXISTS idx_conversations_last_opened
    ON conversations(last_opened_at DESC);

-- Conversation archive filtering: distinguish active from archived.
CREATE INDEX IF NOT EXISTS idx_conversations_archived
    ON conversations(archived_at) WHERE archived_at IS NOT NULL;
