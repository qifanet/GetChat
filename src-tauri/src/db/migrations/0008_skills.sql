CREATE TABLE IF NOT EXISTS skill_definitions (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    trigger_type    TEXT NOT NULL DEFAULT 'MANUAL',
    prompt_template TEXT NOT NULL DEFAULT '',
    variables_json  TEXT NOT NULL DEFAULT '[]',
    bound_tools     TEXT NOT NULL DEFAULT '[]',
    scope           TEXT NOT NULL DEFAULT 'GLOBAL',
    source_type     TEXT NOT NULL DEFAULT 'USER',
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
