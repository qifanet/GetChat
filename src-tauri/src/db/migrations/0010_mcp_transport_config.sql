-- 0010: MCP transport-aware configuration
-- Extends the original stdio-only mcp_servers table so settings can store
-- Streamable HTTP / legacy SSE style server metadata without losing backward
-- compatibility with existing command/args/env rows.

ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio';
ALTER TABLE mcp_servers ADD COLUMN url TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_servers ADD COLUMN headers_json TEXT NOT NULL DEFAULT '{}';
