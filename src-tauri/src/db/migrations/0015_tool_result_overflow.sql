-- Migration 0015: Tool-result overflow store
-- Version: 0015
-- Date: 2026-09-06
-- Purpose: Persist the full content of tool results that were truncated in
-- the prompt (M3.3). The prompt keeps an 8K inline excerpt plus an
-- `overflow:<id>` reference; the read_tool_result tool fetches the full
-- content on demand (JIT retrieval).

CREATE TABLE IF NOT EXISTS tool_result_overflow (
    id TEXT PRIMARY KEY,
    tool_call_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_result_overflow_call ON tool_result_overflow(tool_call_id);
