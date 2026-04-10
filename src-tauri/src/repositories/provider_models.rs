/**
 * @file repositories/provider_models.rs
 * @description Provider model profile CRUD used by provider settings and
 * runtime model resolution.
 *
 * Provider models are persisted separately from providers so one provider can
 * expose multiple request/display name pairs while still using a stable
 * system-generated model profile ID everywhere else in the app.
 */

use sqlx::{Executor, FromRow, Sqlite};

// ============================================================================
// Row Type
// ============================================================================

#[derive(Debug, FromRow)]
pub struct ProviderModelRow {
    pub id: String,
    pub provider_id: String,
    pub request_name: String,
    pub display_name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// ============================================================================
// Queries
// ============================================================================

/** Find a single provider model by its stable ID. */
pub async fn find_by_id<'e, E>(
    executor: E,
    id: &str,
) -> sqlx::Result<Option<ProviderModelRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ProviderModelRow>("SELECT * FROM provider_models WHERE id = ?")
        .bind(id)
        .fetch_optional(executor)
        .await
}

/** List all models for one provider ordered by creation time. */
pub async fn list_by_provider_id<'e, E>(
    executor: E,
    provider_id: &str,
) -> sqlx::Result<Vec<ProviderModelRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ProviderModelRow>(
        "SELECT * FROM provider_models WHERE provider_id = ? ORDER BY created_at, display_name",
    )
    .bind(provider_id)
    .fetch_all(executor)
    .await
}

/** Insert a new provider model profile. */
pub async fn insert<'e, E>(
    executor: E,
    id: &str,
    provider_id: &str,
    request_name: &str,
    display_name: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO provider_models (id, provider_id, request_name, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, unixepoch(), unixepoch())",
    )
    .bind(id)
    .bind(provider_id)
    .bind(request_name)
    .bind(display_name)
    .execute(executor)
    .await?;

    Ok(())
}

/** Update an existing provider model profile. */
pub async fn update<'e, E>(
    executor: E,
    id: &str,
    request_name: &str,
    display_name: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE provider_models
         SET request_name = ?, display_name = ?, updated_at = unixepoch()
         WHERE id = ?",
    )
    .bind(request_name)
    .bind(display_name)
    .bind(id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Delete all models for a provider that are not present in the keep-set. */
pub async fn delete_missing_for_provider<'e, E>(
    executor: E,
    provider_id: &str,
    keep_ids: &[String],
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    if keep_ids.is_empty() {
        sqlx::query("DELETE FROM provider_models WHERE provider_id = ?")
            .bind(provider_id)
            .execute(executor)
            .await?;
        return Ok(());
    }

    let placeholders = vec!["?"; keep_ids.len()].join(", ");
    let sql = format!(
        "DELETE FROM provider_models WHERE provider_id = ? AND id NOT IN ({placeholders})"
    );
    let mut query = sqlx::query(&sql).bind(provider_id);
    for keep_id in keep_ids {
        query = query.bind(keep_id);
    }
    query.execute(executor).await?;

    Ok(())
}
