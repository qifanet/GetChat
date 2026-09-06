/**
 * @file tool_result_overflow.rs
 * @description Repository for tool_result_overflow table (v1.5.0 M3.3) —
 * stores the full content of tool results that were truncated in the prompt.
 * The prompt carries an `overflow:<id>` reference; the read_tool_result tool
 * retrieves the stored content on demand (JIT retrieval).
 */

use sqlx::{Executor, Sqlite, SqlitePool};

pub async fn insert<'e, E>(
    executor: E,
    id: &str,
    tool_call_id: &str,
    content: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO tool_result_overflow (id, tool_call_id, content, created_at)
         VALUES (?, ?, ?, unixepoch())",
    )
    .bind(id)
    .bind(tool_call_id)
    .bind(content)
    .execute(executor)
    .await?;
    Ok(())
}

pub async fn find_content(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT content FROM tool_result_overflow WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(":memory:")
            .await
            .expect("in-memory pool");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS tool_result_overflow (
                id TEXT PRIMARY KEY,
                tool_call_id TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    /** 溢出落盘往返：insert 后 find_content 取回原文（验收门禁用例）。 */
    #[tokio::test]
    async fn insert_and_fetch_round_trip() {
        let pool = test_pool().await;
        let content = "x".repeat(20_000);
        insert(&pool, "ov-1", "call-1", &content)
            .await
            .expect("insert");

        let fetched = find_content(&pool, "ov-1").await.expect("fetch");
        assert_eq!(fetched.as_deref(), Some(content.as_str()));
    }

    /** 未知 id 返回 None（tool 层据时报错，不 panic）。 */
    #[tokio::test]
    async fn unknown_id_returns_none() {
        let pool = test_pool().await;
        let fetched = find_content(&pool, "missing").await.expect("fetch");
        assert!(fetched.is_none());
    }
}
