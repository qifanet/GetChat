-- 0005: Tool Calling support
-- Adds tool_definitions, tool_calls tables and extends messages/provider_models for tool use.

-- ========== messages 表扩展 ==========
-- content_type: 'TEXT' (default) for normal messages, 'TOOL_RESULT' for tool execution results
-- tool_call_id: only for TOOL_RESULT messages, links to tool_calls.call_id
-- tool_name: only for TOOL_RESULT messages, the tool function name
-- content_blocks_json: optional ordered text/tool block sequence for inline tool rendering
ALTER TABLE messages ADD COLUMN content_type TEXT NOT NULL DEFAULT 'TEXT';
ALTER TABLE messages ADD COLUMN tool_call_id TEXT;
ALTER TABLE messages ADD COLUMN tool_name TEXT;
ALTER TABLE messages ADD COLUMN content_blocks_json TEXT NOT NULL DEFAULT '';

-- ========== 新增: tool_definitions ==========
-- Unified registry for built-in tools and MCP-discovered tools
CREATE TABLE IF NOT EXISTS tool_definitions (
    id                TEXT NOT NULL PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    display_name      TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    parameters_schema TEXT NOT NULL DEFAULT '{}',
    source_type       TEXT NOT NULL DEFAULT 'BUILTIN',
    source_server_id  TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ========== 新增: tool_calls ==========
-- Records each tool invocation tied to an assistant message
CREATE TABLE IF NOT EXISTS tool_calls (
    id                TEXT NOT NULL PRIMARY KEY,
    message_id        TEXT NOT NULL,
    call_id           TEXT NOT NULL,
    function_name     TEXT NOT NULL,
    arguments_json    TEXT NOT NULL DEFAULT '',
    result_json       TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'PENDING',
    error_message     TEXT,
    started_at        INTEGER,
    completed_at      INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_call_id ON tool_calls(call_id);

-- ========== provider_models 扩展 ==========
-- capabilities_json: { "toolCalling": true, "vision": false, ... }
ALTER TABLE provider_models ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}';
