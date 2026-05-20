#![allow(dead_code)]
/**
 * @file repositories/tool_calls.rs
 * @description Tool call CRUD queries for the tool_calls table.
 *
 * Each tool call is associated with a message (the assistant message that
 * triggered it). Tool results are stored as separate messages with
 * role=TOOL and content_type=TOOL_RESULT.
 *
 * Dead code is allowed until the ReAct loop controller wires this module
 * into the command/service path (Phase B).
 */

use sqlx::{Executor, FromRow, Sqlite};

// ============================================================================
// Row Type
// ============================================================================

#[derive(Debug, FromRow)]
pub struct ToolCallRow {
    pub id: String,
    pub message_id: String,
    pub call_id: String,
    pub function_name: String,
    pub arguments_json: String,
    pub result_json: String,
    pub status: String,
    pub error_message: Option<String>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub created_at: i64,
}

// ============================================================================
// Queries
// ============================================================================

/** Insert a new tool call record. */
pub async fn insert<'e, E>(
    executor: E,
    id: &str,
    message_id: &str,
    call_id: &str,
    function_name: &str,
    arguments_json: &str,
    now_secs: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO tool_calls (id, message_id, call_id, function_name, arguments_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?)",
    )
    .bind(id)
    .bind(message_id)
    .bind(call_id)
    .bind(function_name)
    .bind(arguments_json)
    .bind(now_secs)
    .execute(executor)
    .await?;

    Ok(())
}

/** List all tool calls for a given message, ordered by creation time. */
pub async fn list_by_message<'e, E>(
    executor: E,
    message_id: &str,
) -> sqlx::Result<Vec<ToolCallRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ToolCallRow>(
        "SELECT * FROM tool_calls WHERE message_id = ? ORDER BY created_at",
    )
    .bind(message_id)
    .fetch_all(executor)
    .await
}

/** Update a tool call with execution result. */
pub async fn complete<'e, E>(
    executor: E,
    id: &str,
    result_json: &str,
    status: &str,
    error_message: Option<&str>,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE tool_calls SET result_json = ?, status = ?, error_message = ?,
         completed_at = unixepoch() WHERE id = ?",
    )
    .bind(result_json)
    .bind(status)
    .bind(error_message)
    .bind(id)
    .execute(executor)
    .await?;

    Ok(())
}

/** Find a tool call by its call_id (the provider-issued ID). */
pub async fn find_by_call_id<'e, E>(
    executor: E,
    call_id: &str,
) -> sqlx::Result<Option<ToolCallRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, ToolCallRow>(
        "SELECT * FROM tool_calls WHERE call_id = ?",
    )
    .bind(call_id)
    .fetch_optional(executor)
    .await
}

/** List all tool calls for a set of message IDs, ordered by creation time. */
pub async fn list_by_conversation<'e, E>(
    executor: E,
    conversation_message_ids: &[String],
) -> sqlx::Result<Vec<ToolCallRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    if conversation_message_ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders: Vec<&str> = conversation_message_ids.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT * FROM tool_calls WHERE message_id IN ({}) ORDER BY created_at",
        placeholders.join(",")
    );
    let mut query = sqlx::query_as::<_, ToolCallRow>(&sql);
    for id in conversation_message_ids {
        query = query.bind(id);
    }
    query.fetch_all(executor).await
}

/** Delete all tool calls belonging to a specific message. */
pub async fn delete_by_message<'e, E>(executor: E, message_id: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM tool_calls WHERE message_id = ?")
        .bind(message_id)
        .execute(executor)
        .await?;
    Ok(())
}
