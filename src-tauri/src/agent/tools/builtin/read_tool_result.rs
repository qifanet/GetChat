/**
 * @file agent/tools/builtin/read_tool_result.rs
 * @description `read_tool_result` internal tool (v1.5.0 M3.3) — JIT retrieval
 * of tool outputs that were truncated in the prompt and persisted to the
 * `tool_result_overflow` table (referenced as `overflow:<id>`).
 *
 * Output is served in fixed chunks smaller than the runner's inline truncation
 * cap (8K), so a read result never overflows again; the model pages through
 * long content with the `offset` parameter.
 */

use serde_json::{json, Value};

use crate::agent::tools::executor::{BuiltinToolExecutor, ToolExecutionContext, ToolExecutionResult};
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta, ToolRisk};
use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

/** Chars served per read — must stay below the runner's MAX_INLINE_TOOL_CHARS. */
const READ_CHUNK_CHARS: usize = 7_000;

/** Register the read_tool_result internal tool (JIT overflow retrieval). */
pub(crate) fn register(executor: &mut BuiltinToolExecutor) {
    let definition = ToolDefinitionDto {
        tool_type: "function".to_string(),
        function: ToolFunctionDefDto {
            name: "read_tool_result".to_string(),
            description: "Read the full content of a tool output that was truncated earlier in this conversation. When a tool result contains a reference like 'full output available via read_tool_result with id: overflow:<id>', call this tool with that id. Long content is served in chunks — pass the offset from the continuation hint to read further.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The overflow id from the truncated tool result (e.g. 'overflow:<id>' or just the id part)"
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Character offset to start reading from (for paging through long content; default 0)"
                    }
                },
                "required": ["id"]
            }),
        },
    };

    const META: ToolMeta = ToolMeta {
        risk: ToolRisk::Low,
        concurrency: ToolConcurrency::Safe,
        max_output_chars: 50_000,
        timeout_secs: 5,
    };

    executor.register_async(definition, META, |args, context| {
        Box::pin(async move { read_tool_result_handler(args, context).await })
    });
}

async fn read_tool_result_handler(
    args: Value,
    context: ToolExecutionContext,
) -> ToolExecutionResult {
    let raw_id = match args.get("id").and_then(Value::as_str) {
        Some(id) => id.trim(),
        None => {
            return ToolExecutionResult {
                success: false,
                output: "Missing required parameter: id".to_string(),
            };
        }
    };

    // Accept both the `overflow:<id>` reference form and the bare id.
    let id = raw_id.strip_prefix("overflow:").unwrap_or(raw_id);
    if id.is_empty() {
        return ToolExecutionResult {
            success: false,
            output: "Overflow id cannot be empty".to_string(),
        };
    }

    let offset = args
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;

    let Some(pool) = context.db_pool.as_ref() else {
        return ToolExecutionResult {
            success: false,
            output: "Database is not available in this execution context".to_string(),
        };
    };

    let content = match crate::repositories::tool_result_overflow::find_content(pool, id).await {
        Ok(Some(content)) => content,
        Ok(None) => {
            return ToolExecutionResult {
                success: false,
                output: format!(
                    "No stored tool result found for id '{raw_id}'. The reference may be stale or mistyped."
                ),
            };
        }
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Failed to read stored tool result: {e}"),
            };
        }
    };

    let total_chars = content.chars().count();
    let chunk: String = content.chars().skip(offset).take(READ_CHUNK_CHARS).collect();
    let next_offset = offset + chunk.chars().count();

    let mut output = format!(
        "[stored tool result id={} total_chars={}]\n{}",
        id, total_chars, chunk
    );
    if next_offset < total_chars {
        output.push_str(&format!(
            "\n\n[... content continues — call read_tool_result again with offset={} ...]",
            next_offset
        ));
    }

    ToolExecutionResult {
        success: true,
        output,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn handler_context_with_content(content: &str) -> ToolExecutionContext {
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
        crate::repositories::tool_result_overflow::insert(&pool, "ov-1", "call-1", content)
            .await
            .expect("insert");
        ToolExecutionContext {
            conversation_id: None,
            workspace_path: None,
            shell_path: None,
            skills_dir: None,
            db_pool: Some(pool),
        }
    }

    fn args(id: &str, offset: Option<u64>) -> Value {
        let mut obj = json!({ "id": id });
        if let Some(offset) = offset {
            obj["offset"] = json!(offset);
        }
        obj
    }

    /** 溢出往返：handler 取回落盘内容（验收门禁用例）。 */
    #[tokio::test]
    async fn round_trip_returns_stored_content() {
        let context = handler_context_with_content("hello overflow").await;
        let result = read_tool_result_handler(args("overflow:ov-1", None), context).await;
        assert!(result.success, "{}", result.output);
        assert!(result.output.contains("hello overflow"), "{}", result.output);
    }

    /** 超过 7K 的内容分页，续读提示携带下一 offset。 */
    #[tokio::test]
    async fn long_content_pages_with_offset_hint() {
        let context = handler_context_with_content(&"x".repeat(20_000)).await;
        let first = read_tool_result_handler(args("ov-1", None), context).await;
        assert!(first.success);
        assert!(first.output.contains("offset=7000"), "{}", first.output);

        let context = handler_context_with_content(&"x".repeat(20_000)).await;
        let second = read_tool_result_handler(args("ov-1", Some(7_000)), context).await;
        assert!(second.success);
        // 7000..14000 served; 6000 chars remain, so a further hint is expected.
        assert!(
            second.output.contains("offset=14000"),
            "continuation hint must point at the next page: {}",
            second.output
        );

        // Final page: offset 14000 serves the remaining 6000 chars, no hint.
        let context = handler_context_with_content(&"x".repeat(20_000)).await;
        let last = read_tool_result_handler(args("ov-1", Some(14_000)), context).await;
        assert!(last.success);
        assert!(
            !last.output.contains("offset="),
            "final page must not carry a continuation hint: {}",
            last.output
        );
    }

    /** 未知 id 报错而非 panic。 */
    #[tokio::test]
    async fn unknown_id_reports_error() {
        let context = handler_context_with_content("present").await;
        let result = read_tool_result_handler(args("missing", None), context).await;
        assert!(!result.success);
        assert!(result.output.contains("No stored tool result"), "{}", result.output);
    }
}
