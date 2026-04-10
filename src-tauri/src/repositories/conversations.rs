/**
 * @file repositories/conversations.rs
 * @description Conversation CRUD and aggregate queries.
 *
 * Aggregate counts (activeBranchCount, etc.) are computed via SQL COUNT
 * with filtered JOINs — not stored columns.
 */

use sqlx::{Executor, FromRow, Sqlite};

// ============================================================================
// Row Types
// ============================================================================

#[derive(Debug, FromRow)]
pub struct ConversationRow {
    pub id: String,
    pub title: String,
    pub mainline_branch_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_opened_at: i64,
    pub archived_at: Option<i64>,
}

/** Row for list_summaries — includes aggregate counts from JOINs */
#[derive(Debug, FromRow)]
pub struct ConversationSummaryRow {
    pub id: String,
    pub title: String,
    pub mainline_branch_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_opened_at: i64,
    pub archived_at: Option<i64>,
    pub active_branch_count: i32,
    pub archived_branch_count: i32,
    pub total_message_count: i32,
}

// ============================================================================
// Queries
// ============================================================================

/** Find a single conversation by ID. */
pub async fn find_by_id<'e, E>(executor: E, id: &str) -> sqlx::Result<Option<ConversationRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ConversationRow>("SELECT * FROM conversations WHERE id = ?")
        .bind(id)
        .fetch_optional(executor)
        .await
}

/** List all conversation summaries with aggregate counts, ordered by last opened. */
pub async fn list_summaries<'e, E>(
    executor: E,
) -> sqlx::Result<Vec<ConversationSummaryRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ConversationSummaryRow>(
        "SELECT
            c.id, c.title, c.mainline_branch_id,
            c.created_at, c.updated_at, c.last_opened_at, c.archived_at,
            COUNT(DISTINCT CASE WHEN b.status = 'ACTIVE' THEN b.id END) AS active_branch_count,
            COUNT(DISTINCT CASE WHEN b.status = 'ARCHIVED' THEN b.id END) AS archived_branch_count,
            COUNT(DISTINCT m.id) AS total_message_count
         FROM conversations c
         LEFT JOIN branches b ON b.conversation_id = c.id
         LEFT JOIN messages m ON m.conversation_id = c.id
         WHERE c.archived_at IS NULL
         GROUP BY c.id
         ORDER BY c.last_opened_at DESC",
    )
    .fetch_all(executor)
    .await
}

/** Get a single conversation summary with aggregate counts by ID. */
pub async fn get_summary<'e, E>(
    executor: E,
    id: &str,
) -> sqlx::Result<Option<ConversationSummaryRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ConversationSummaryRow>(
        "SELECT
            c.id, c.title, c.mainline_branch_id,
            c.created_at, c.updated_at, c.last_opened_at, c.archived_at,
            COUNT(DISTINCT CASE WHEN b.status = 'ACTIVE' THEN b.id END) AS active_branch_count,
            COUNT(DISTINCT CASE WHEN b.status = 'ARCHIVED' THEN b.id END) AS archived_branch_count,
            COUNT(DISTINCT m.id) AS total_message_count
         FROM conversations c
         LEFT JOIN branches b ON b.conversation_id = c.id
         LEFT JOIN messages m ON m.conversation_id = c.id
         WHERE c.id = ?
         GROUP BY c.id",
    )
    .bind(id)
    .fetch_optional(executor)
    .await
}

/** Insert a new conversation. Returns nothing (caller knows the ID). */
pub async fn insert<'e, E>(
    executor: E,
    id: &str,
    title: &str,
    now_secs: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, ?, NULL, ?, ?, ?)",
    )
    .bind(id)
    .bind(title)
    .bind(now_secs)
    .bind(now_secs)
    .bind(now_secs)
    .execute(executor)
    .await?;

    Ok(())
}

/** Update the mainline branch pointer. Non-destructive: only changes this one column. */
pub async fn set_mainline_branch<'e, E>(
    executor: E,
    conversation_id: &str,
    branch_id: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE conversations SET mainline_branch_id = ?, updated_at = unixepoch()
         WHERE id = ?",
    )
    .bind(branch_id)
    .bind(conversation_id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Update timestamps to indicate the conversation was just opened. */
pub async fn touch_last_opened<'e, E>(executor: E, conversation_id: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE conversations SET last_opened_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ?",
    )
    .bind(conversation_id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Update conversation updated_at timestamp (called after message/branch mutations). */
pub async fn touch<'e, E>(
    executor: E,
    conversation_id: &str,
    now_secs: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind(now_secs)
        .bind(conversation_id)
        .execute(executor)
        .await?;

    Ok(())
}

/** Update conversation title. */
pub async fn update_title<'e, E>(executor: E, id: &str, title: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE conversations SET title = ?, updated_at = unixepoch() WHERE id = ?",
    )
    .bind(title)
    .bind(id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Archive or unarchive a conversation. Set archived_at = NULL to unarchive. */
pub async fn set_archived<'e, E>(
    executor: E,
    id: &str,
    archived_at: Option<i64>,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE conversations SET archived_at = ?, updated_at = unixepoch() WHERE id = ?",
    )
    .bind(archived_at)
    .bind(id)
    .execute(executor)
    .await?;

    Ok(())
}
