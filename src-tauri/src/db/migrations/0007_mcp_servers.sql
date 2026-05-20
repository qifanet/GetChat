CREATE TABLE IF NOT EXISTS mcp_servers (
    name          TEXT PRIMARY KEY,
    command       TEXT NOT NULL,
    args_json     TEXT NOT NULL DEFAULT '[]',
    env_json      TEXT NOT NULL DEFAULT '{}',
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
