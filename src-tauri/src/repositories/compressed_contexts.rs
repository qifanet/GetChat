/**
 * @file compressed_contexts.rs
 * @description Repository for compressed_contexts table — stores conversation
 * context summaries created when the token count exceeds the model's window.
 */

use sqlx::{Executor, Sqlite, SqlitePool};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CompressedContextRow {
    pub id: String,
    pub conversation_id: String,
    pub branch_id: String,
    pub summary_text: String,
    pub compressed_message_ids: String,
    pub token_count: i64,
    pub created_at: String,
}

pub async fn create<'e, E>(executor: E, row: &CompressedContextRow) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO compressed_contexts (id, conversation_id, branch_id, summary_text, compressed_message_ids, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.conversation_id)
    .bind(&row.branch_id)
    .bind(&row.summary_text)
    .bind(&row.compressed_message_ids)
    .bind(row.token_count)
    .bind(&row.created_at)
    .execute(executor)
    .await?;
    Ok(())
}

pub async fn find_latest_by_branch(
    pool: &SqlitePool,
    conversation_id: &str,
    branch_id: &str,
) -> sqlx::Result<Option<CompressedContextRow>> {
    sqlx::query_as::<_, CompressedContextRow>(
        "SELECT * FROM compressed_contexts
         WHERE conversation_id = ? AND branch_id = ?
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(conversation_id)
    .bind(branch_id)
    .fetch_optional(pool)
    .await
}

pub async fn delete_by_conversation<'e, E>(executor: E, conversation_id: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM compressed_contexts WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(executor)
        .await?;
    Ok(())
}

pub async fn delete_by_branch<'e, E>(
    executor: E,
    conversation_id: &str,
    branch_id: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM compressed_contexts WHERE conversation_id = ? AND branch_id = ?")
        .bind(conversation_id)
        .bind(branch_id)
        .execute(executor)
        .await?;
    Ok(())
}
