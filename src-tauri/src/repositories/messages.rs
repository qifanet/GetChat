/**
 * @file repositories/messages.rs
 * @description Message CRUD and tree traversal queries.
 *
 * Key responsibilities:
 *   - Insert messages with computed depth/sibling_index
 *   - Transition streaming messages to COMPLETED/FAILED/ABORTED
 *   - Query for sibling_index computation
 *   - List messages for snapshot loading
 *
 * Does NOT enforce domain rules (that's the service layer).
 */

use sqlx::{Executor, FromRow, Sqlite};

// ============================================================================
// Row Type
// ============================================================================

#[derive(Debug, Clone, FromRow)]
pub struct MessageRow {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub status: String,
    pub parent_message_id: Option<String>,
    pub depth: i32,
    pub sibling_index: i32,
    pub content_text: String,
    pub reasoning_content: String,
    pub content_format: String,
    pub content_type: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub content_blocks_json: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub request_id: Option<String>,
    pub generation_params_json: String,
    pub usage_json: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_retriable: Option<i32>,
    pub edited_from_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ============================================================================
// Queries
// ============================================================================

/** Find a single message by ID. */
pub async fn find_by_id<'e, E>(executor: E, id: &str) -> sqlx::Result<Option<MessageRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, MessageRow>("SELECT * FROM messages WHERE id = ?")
        .bind(id)
        .fetch_optional(executor)
        .await
}

/** List all messages for a conversation, ordered by depth + sibling_index. */
pub async fn list_by_conversation<'e, E>(
    executor: E,
    conversation_id: &str,
) -> sqlx::Result<Vec<MessageRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, MessageRow>(
        "SELECT * FROM messages WHERE conversation_id = ?
         ORDER BY depth, sibling_index",
    )
    .bind(conversation_id)
    .fetch_all(executor)
    .await
}

/** Insert a user message (always COMPLETED status). */
pub async fn insert_user_message<'e, E>(
    executor: E,
    id: &str,
    conversation_id: &str,
    parent_message_id: Option<&str>,
    depth: i32,
    sibling_index: i32,
    content_text: &str,
    edited_from_message_id: Option<&str>,
    now_secs: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id,
         depth, sibling_index, content_text, content_format, edited_from_message_id,
         created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', ?, ?, ?, ?, 'MARKDOWN', ?, ?, ?)",
    )
    .bind(id)
    .bind(conversation_id)
    .bind(parent_message_id)
    .bind(depth)
    .bind(sibling_index)
    .bind(content_text)
    .bind(edited_from_message_id)
    .bind(now_secs)
    .bind(now_secs)
    .execute(executor)
    .await?;

    Ok(())
}

/** Insert an assistant STREAMING placeholder (for branch or variant). */
pub async fn insert_assistant_placeholder<'e, E>(
    executor: E,
    id: &str,
    conversation_id: &str,
    parent_message_id: Option<&str>,
    depth: i32,
    sibling_index: i32,
    provider_id: &str,
    model_id: &str,
    request_id: &str,
    generation_params_json: &str,
    now_secs: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id,
         depth, sibling_index, content_text, content_format,
         provider_id, model_id, request_id, generation_params_json,
         created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'STREAMING', ?, ?, ?, '', 'MARKDOWN',
         ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(conversation_id)
    .bind(parent_message_id)
    .bind(depth)
    .bind(sibling_index)
    .bind(provider_id)
    .bind(model_id)
    .bind(request_id)
    .bind(generation_params_json)
    .bind(now_secs)
    .bind(now_secs)
    .execute(executor)
    .await?;

    Ok(())
}

/**
 * Complete a streaming assistant message.
 * Sets status to COMPLETED, commits final text, and records usage.
 * Callers should verify the message is currently STREAMING before calling.
 */
pub async fn complete_streaming<'e, E>(
    executor: E,
    message_id: &str,
    content_text: &str,
    content_blocks_json: &str,
    usage_json: &str,
    reasoning_content: Option<&str>,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE messages SET status = 'COMPLETED', content_text = ?, content_blocks_json = ?, usage_json = ?, reasoning_content = COALESCE(?, ''),
         updated_at = unixepoch() WHERE id = ? AND status = 'STREAMING'",
    )
    .bind(content_text)
    .bind(content_blocks_json)
    .bind(usage_json)
    .bind(reasoning_content)
    .bind(message_id)
    .execute(executor)
    .await?;

    Ok(())
}

/**
 * Fail a streaming assistant message.
 * Preserves any partial content and sets error details.
 */
pub async fn fail_streaming<'e, E>(
    executor: E,
    message_id: &str,
    partial_content_text: Option<&str>,
    partial_content_blocks_json: Option<&str>,
    error_code: &str,
    error_message: &str,
    error_retriable: bool,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE messages SET status = 'FAILED', content_text = COALESCE(?, content_text),
         content_blocks_json = COALESCE(?, content_blocks_json),
         error_code = ?, error_message = ?, error_retriable = ?,
         updated_at = unixepoch() WHERE id = ? AND status = 'STREAMING'",
    )
    .bind(partial_content_text)
    .bind(partial_content_blocks_json)
    .bind(error_code)
    .bind(error_message)
    .bind(error_retriable as i32)
    .bind(message_id)
    .execute(executor)
    .await?;

    Ok(())
}

/**
 * Destructively update a completed USER message's text.
 *
 * Domain guardrails live in snapshot_service::direct_overwrite_user_message;
 * keep this repository helper intentionally narrow and role/status scoped.
 */
pub async fn update_user_content<'e, E>(
    executor: E,
    message_id: &str,
    content_text: &str,
    now_secs: i64,
) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let result = sqlx::query(
        "UPDATE messages
         SET content_text = ?, content_blocks_json = '', updated_at = ?
         WHERE id = ? AND role = 'USER' AND status = 'COMPLETED'",
    )
    .bind(content_text)
    .bind(now_secs)
    .bind(message_id)
    .execute(executor)
    .await?;

    Ok(result.rows_affected() > 0)
}

/** Get the next sibling index for children of a given parent. */
pub async fn get_next_sibling_index<'e, E>(
    executor: E,
    parent_message_id: Option<&str>,
    conversation_id: &str,
) -> sqlx::Result<i32>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: (Option<i32>,) = match parent_message_id {
        Some(pid) => {
            sqlx::query_as(
                "SELECT MAX(sibling_index) FROM messages WHERE parent_message_id = ?",
            )
            .bind(pid)
            .fetch_one(executor)
            .await?
        }
        None => {
            sqlx::query_as(
                "SELECT MAX(sibling_index) FROM messages WHERE parent_message_id IS NULL AND conversation_id = ?",
            )
            .bind(conversation_id)
            .fetch_one(executor)
            .await?
        }
    };

    Ok(row.0.unwrap_or(-1) + 1)
}

/**
 * Repair inflight streaming messages: mark all STREAMING messages as ABORTED.
 *
 * Called during app startup to fix "zombie" streaming messages left over from
 * an unclean shutdown (kill process, crash, OS restart). After app restart,
 * the runtime registry and model connections are gone, so these messages can
 * never be completed.
 *
 * Sets:
 *   - status = 'ABORTED'
 *   - error_code = 'APP_RESTART_INTERRUPTED'
 *   - error_message = human-readable explanation
 *   - error_retriable = 1 (user can retry generation)
 *   - updated_at = current time
 *
 * Returns the number of messages repaired.
 */
pub async fn repair_inflight_streaming<'e, E>(
    executor: E,
    now_secs: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    let result = sqlx::query(
        "UPDATE messages
         SET status = 'ABORTED',
             error_code = 'APP_RESTART_INTERRUPTED',
             error_message = 'Generation interrupted by app restart',
             error_retriable = 1,
             updated_at = ?
         WHERE status = 'STREAMING'",
    )
    .bind(now_secs)
    .execute(executor)
    .await?;

    Ok(result.rows_affected())
}

/**
 * Remove a single leaf message by ID.
 * Caller must ensure the message has no children and is safe to remove.
 */
pub async fn remove_leaf_message<'e, E>(executor: E, message_id: &str) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let result = sqlx::query("DELETE FROM messages WHERE id = ?")
        .bind(message_id)
        .execute(executor)
        .await?;
    Ok(result.rows_affected() > 0)
}

/**
 * Collect all descendants of a message, deepest nodes first.
 *
 * Used by the explicit direct-overwrite exception to truncate downstream
 * messages after mutating a historical USER message.
 */
pub async fn collect_descendant_ids<'e, E>(
    executor: E,
    conversation_id: &str,
    root_message_id: &str,
) -> sqlx::Result<Vec<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    let rows = sqlx::query_as::<_, (String,)>(
        "WITH RECURSIVE descendants(id, depth) AS (
             SELECT id, depth FROM messages
             WHERE parent_message_id = ? AND conversation_id = ?
             UNION ALL
             SELECT m.id, m.depth FROM messages m
             JOIN descendants d ON m.parent_message_id = d.id
             WHERE m.conversation_id = ?
         )
         SELECT id FROM descendants ORDER BY depth DESC",
    )
    .bind(root_message_id)
    .bind(conversation_id)
    .bind(conversation_id)
    .fetch_all(executor)
    .await?;

    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/**
 * Count children of a given message.
 */
pub async fn count_children<'e, E>(executor: E, message_id: &str) -> sqlx::Result<i64>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE parent_message_id = ?",
    )
    .bind(message_id)
    .fetch_one(executor)
    .await?;
    Ok(row.0)
}

/** Count assistant children under the given user message. */
pub async fn count_assistant_children_by_parent<'e, E>(
    executor: E,
    parent_message_id: &str,
) -> sqlx::Result<i64>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE parent_message_id = ? AND role = 'ASSISTANT'",
    )
    .bind(parent_message_id)
    .fetch_one(executor)
    .await?;
    Ok(row.0)
}

// ============================================================================
// Search
// ============================================================================

/// Lightweight row returned by message search queries.
/// Only includes fields needed for search result display.
#[derive(Debug, FromRow)]
pub struct MessageSearchRow {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content_text: String,
    pub created_at: i64,
}

/**
 * Search messages by keyword across all conversations (or a specific one).
 *
 * Uses SQL LIKE for simple substring matching. Returns results ordered
 * by creation time (newest first), limited to `limit` results.
 */
pub async fn search_messages<'e, E>(
    executor: E,
    query: &str,
    conversation_id: Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<MessageSearchRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));

    if let Some(conv_id) = conversation_id {
        sqlx::query_as::<_, MessageSearchRow>(
            "SELECT id, conversation_id, role, content_text, created_at
             FROM messages
             WHERE conversation_id = ? AND content_text LIKE ? ESCAPE '\\'
             ORDER BY created_at DESC
             LIMIT ?",
        )
        .bind(conv_id)
        .bind(&pattern)
        .bind(limit)
        .fetch_all(executor)
        .await
    } else {
        sqlx::query_as::<_, MessageSearchRow>(
            "SELECT id, conversation_id, role, content_text, created_at
             FROM messages
             WHERE content_text LIKE ? ESCAPE '\\'
             ORDER BY created_at DESC
             LIMIT ?",
        )
        .bind(&pattern)
        .bind(limit)
        .fetch_all(executor)
        .await
    }
}
