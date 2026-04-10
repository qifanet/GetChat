/**
 * @file repositories/branches.rs
 * @description Branch CRUD operations.
 *
 * Branches are path pointers (fork_point + head), not message mappings.
 * is_mainline is NOT a DB column — it's derived from conversations.mainline_branch_id
 * in the service layer.
 */

use sqlx::{Executor, FromRow, Sqlite};

// ============================================================================
// Row Type
// ============================================================================

#[derive(Debug, FromRow)]
pub struct BranchRow {
    pub id: String,
    pub conversation_id: String,
    pub name: String,
    pub status: String,
    pub source_branch_id: Option<String>,
    pub fork_point_message_id: Option<String>,
    pub fork_source_type: String,
    pub fork_source_message_id: Option<String>,
    pub head_message_id: Option<String>,
    pub preferred_model_id: String,
    pub color: String,
    pub summary: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

// ============================================================================
// Queries
// ============================================================================

/** Find a branch by ID. */
pub async fn find_by_id<'e, E>(executor: E, id: &str) -> sqlx::Result<Option<BranchRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, BranchRow>("SELECT * FROM branches WHERE id = ?")
        .bind(id)
        .fetch_optional(executor)
        .await
}

/** List all branches for a conversation. */
pub async fn list_by_conversation<'e, E>(
    executor: E,
    conversation_id: &str,
) -> sqlx::Result<Vec<BranchRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, BranchRow>(
        "SELECT * FROM branches WHERE conversation_id = ? ORDER BY created_at",
    )
    .bind(conversation_id)
    .fetch_all(executor)
    .await
}

/** Insert a new branch. */
pub async fn insert<'e, E>(
    executor: E,
    id: &str,
    conversation_id: &str,
    name: &str,
    status: &str,
    source_branch_id: Option<&str>,
    fork_point_message_id: Option<&str>,
    fork_source_type: &str,
    fork_source_message_id: Option<&str>,
    head_message_id: Option<&str>,
    preferred_model_id: Option<&str>,
    now_secs: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, source_branch_id,
         fork_point_message_id, fork_source_type, fork_source_message_id,
         head_message_id, preferred_model_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(conversation_id)
    .bind(name)
    .bind(status)
    .bind(source_branch_id)
    .bind(fork_point_message_id)
    .bind(fork_source_type)
    .bind(fork_source_message_id)
    .bind(head_message_id)
    .bind(preferred_model_id.unwrap_or(""))
    .bind(now_secs)
    .bind(now_secs)
    .execute(executor)
    .await?;

    Ok(())
}

/** Update branch head message. Called after creating a new message on this branch. */
pub async fn update_head<'e, E>(
    executor: E,
    branch_id: &str,
    head_message_id: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE branches SET head_message_id = ?, updated_at = unixepoch() WHERE id = ?",
    )
    .bind(head_message_id)
    .bind(branch_id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Point a branch head at a specific persisted message. */
pub async fn update_head_optional<'e, E>(
    executor: E,
    branch_id: &str,
    head_message_id: Option<&str>,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE branches SET head_message_id = ?, updated_at = unixepoch() WHERE id = ?",
    )
    .bind(head_message_id)
    .bind(branch_id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Rename a branch. */
pub async fn update_name<'e, E>(executor: E, branch_id: &str, name: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE branches SET name = ?, updated_at = unixepoch() WHERE id = ?",
    )
    .bind(name)
    .bind(branch_id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Update branch status. Automatically sets/clears archived_at. */
pub async fn update_status<'e, E>(executor: E, id: &str, status: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE branches SET status = ?, archived_at = CASE WHEN ? = 'ARCHIVED' THEN unixepoch() ELSE NULL END, updated_at = unixepoch() WHERE id = ?",
    )
    .bind(status)
    .bind(status)
    .bind(id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Persist the preferred model profile for a branch. */
pub async fn update_preferred_model<'e, E>(
    executor: E,
    branch_id: &str,
    preferred_model_id: Option<&str>,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE branches
         SET preferred_model_id = ?, updated_at = unixepoch()
         WHERE id = ?",
    )
    .bind(preferred_model_id.unwrap_or(""))
    .bind(branch_id)
    .execute(executor)
    .await?;

    Ok(())
}
