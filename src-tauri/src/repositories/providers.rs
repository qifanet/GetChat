/**
 * @file repositories/providers.rs
 * @description Provider configuration CRUD.
 *
 * Security note: api_key_ref is stored here but never returned to the frontend.
 * The service layer replaces it with has_api_key: bool.
 */

use sqlx::{Executor, FromRow, Sqlite};

// ============================================================================
// Row Type
// ============================================================================

#[derive(Debug, FromRow)]
pub struct ProviderRow {
    pub id: String,
    pub r#type: String,
    pub name: String,
    pub base_url: String,
    pub api_key_ref: String,
    pub default_model_id: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

// ============================================================================
// Queries
// ============================================================================

/** Find a provider by ID. */
pub async fn find_by_id<'e, E>(executor: E, id: &str) -> sqlx::Result<Option<ProviderRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ProviderRow>("SELECT * FROM providers WHERE id = ?")
        .bind(id)
        .fetch_optional(executor)
        .await
}

/** List all providers, ordered by name. */
pub async fn list_all<'e, E>(executor: E) -> sqlx::Result<Vec<ProviderRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ProviderRow>("SELECT * FROM providers ORDER BY name")
        .fetch_all(executor)
        .await
}

/** Insert a new provider. */
pub async fn insert<'e, E>(
    executor: E,
    id: &str,
    provider_type: &str,
    name: &str,
    base_url: &str,
    api_key_ref: &str,
    default_model_id: &str,
    enabled: bool,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO providers (id, type, name, base_url, api_key_ref, default_model_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())",
    )
    .bind(id)
    .bind(provider_type)
    .bind(name)
    .bind(base_url)
    .bind(api_key_ref)
    .bind(default_model_id)
    .bind(enabled)
    .execute(executor)
    .await?;

    Ok(())
}

/** Update an existing provider's mutable fields. */
pub async fn update<'e, E>(
    executor: E,
    id: &str,
    provider_type: &str,
    name: &str,
    base_url: &str,
    api_key_ref: &str,
    default_model_id: &str,
    enabled: bool,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE providers SET type = ?, name = ?, base_url = ?, api_key_ref = ?,
         default_model_id = ?, enabled = ?, updated_at = unixepoch()
         WHERE id = ?",
    )
    .bind(provider_type)
    .bind(name)
    .bind(base_url)
    .bind(api_key_ref)
    .bind(default_model_id)
    .bind(enabled)
    .bind(id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Delete a provider by ID. */
pub async fn delete_by_id<'e, E>(executor: E, id: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM providers WHERE id = ?")
        .bind(id)
        .execute(executor)
        .await?;

    Ok(())
}
