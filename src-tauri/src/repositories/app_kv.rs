/**
 * @file repositories/app_kv.rs
 * @description Simple key-value store for global app configuration.
 *
 * Used for: last_workspace, theme, language, sidebar preferences, etc.
 * NOT for large or frequently-updated data.
 */

use sqlx::{Executor, Sqlite};

// ============================================================================
// Queries
// ============================================================================

/** Get a value by key. Returns the JSON string or None if not found. */
pub async fn get<'e, E>(executor: E, key: &str) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value_json FROM app_kv WHERE key = ?")
            .bind(key)
            .fetch_optional(executor)
            .await?;

    Ok(row.map(|(v,)| v))
}

/** Set a value. Upserts the row. */
pub async fn set<'e, E>(executor: E, key: &str, value_json: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO app_kv (key, value_json, updated_at) VALUES (?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = unixepoch()",
    )
    .bind(key)
    .bind(value_json)
    .execute(executor)
    .await?;

    Ok(())
}

/** Delete a key. No-op if the key doesn't exist. */
pub async fn delete<'e, E>(executor: E, key: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM app_kv WHERE key = ?")
        .bind(key)
        .execute(executor)
        .await?;

    Ok(())
}
