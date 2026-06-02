/**
 * @file repositories/mcp_servers.rs
 * @description MCP server configuration persistence.
 *
 * Stores MCP server configs (name, command, args, env, enabled) in SQLite
 * so they survive app restarts.
 */

use sqlx::{Executor, Sqlite};

// ============================================================================
// Row type
// ============================================================================

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct McpServerRow {
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args_json: String,
    pub env_json: String,
    pub url: String,
    pub headers_json: String,
    #[allow(dead_code)]
    pub enabled: bool,
}

// ============================================================================
// Queries
// ============================================================================

/** Load all saved MCP server configurations. */
pub async fn list_all<'e, E>(executor: E) -> sqlx::Result<Vec<McpServerRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, McpServerRow>(
        "SELECT name, transport, command, args_json, env_json, url, headers_json, enabled FROM mcp_servers ORDER BY created_at",
    )
    .fetch_all(executor)
    .await
}

/** Load one saved MCP server configuration by name. */
pub async fn find_by_name<'e, E>(executor: E, name: &str) -> sqlx::Result<Option<McpServerRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, McpServerRow>(
        "SELECT name, transport, command, args_json, env_json, url, headers_json, enabled FROM mcp_servers WHERE name = ?",
    )
    .bind(name)
    .fetch_optional(executor)
    .await
}

/** Insert or update an MCP server configuration. */
pub async fn upsert<'e, E>(
    executor: E,
    name: &str,
    transport: &str,
    command: &str,
    args_json: &str,
    env_json: &str,
    url: &str,
    headers_json: &str,
    enabled: bool,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO mcp_servers (name, transport, command, args_json, env_json, url, headers_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
         ON CONFLICT(name) DO UPDATE SET
            transport = excluded.transport,
            command = excluded.command,
            args_json = excluded.args_json,
            env_json = excluded.env_json,
            url = excluded.url,
            headers_json = excluded.headers_json,
            enabled = excluded.enabled,
            updated_at = unixepoch()",
    )
    .bind(name)
    .bind(transport)
    .bind(command)
    .bind(args_json)
    .bind(env_json)
    .bind(url)
    .bind(headers_json)
    .bind(enabled)
    .execute(executor)
    .await?;

    Ok(())
}


