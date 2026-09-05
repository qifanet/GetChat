/**
 * @file agent/tools/builtin/todo.rs
 * @description Unified `todo` tool with a conversation-scoped in-memory store.
 * Verbatim relocation from services/tool_executor.rs (M2.1). The store is
 * conversation_id-keyed; nothing global remains.
 */

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::tools::executor::{BuiltinToolExecutor, ToolExecutionContext, ToolExecutionResult};
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta, ToolRisk};
use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    pub status: String,
}

static TODO_STORE: Lazy<Mutex<HashMap<String, Vec<TodoItem>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/** Read todos for a specific conversation (used by frontend polling). */
pub fn read_todos_for_conversation(conversation_id: &str) -> Vec<TodoItem> {
    let store = TODO_STORE.lock().unwrap();
    store.get(conversation_id).cloned().unwrap_or_default()
}

/** Clear todos for a specific conversation. */
#[allow(dead_code)]
pub fn clear_todos_for_conversation(conversation_id: &str) {
    let mut store = TODO_STORE.lock().unwrap();
    store.remove(conversation_id);
}

fn get_todo_key(context: &ToolExecutionContext) -> String {
    context
        .conversation_id
        .clone()
        .unwrap_or_else(|| "default".to_string())
}

/** Register the unified todo tool — merges todo_read and todo_write. */
pub(crate) fn register(executor: &mut BuiltinToolExecutor) {
    let definition = ToolDefinitionDto {
        tool_type: "function".to_string(),
        function: ToolFunctionDefDto {
            name: "todo".to_string(),
            description: "Manage a todo checklist for multi-step tasks. Use 'read' to list current items, 'write' to update the full list. Proactively create a todo list when the user's request involves multiple steps.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["read", "write"],
                        "description": "read = list current items, write = replace the full list"
                    },
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "content": { "type": "string" },
                                "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                            },
                            "required": ["id", "content", "status"]
                        },
                        "description": "Full todo list (required for write action). Replaces all existing items."
                    }
                },
                "required": ["action"]
            }),
        },
    };

    const META: ToolMeta = ToolMeta {
        risk: ToolRisk::Low,
        concurrency: ToolConcurrency::Safe,
        max_output_chars: 20_000,
        timeout_secs: 5,
    };

    executor.register(definition, META, |args, context| todo_tool_handler(args, &context));
}

fn todo_tool_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let action = match args.get("action").and_then(Value::as_str) {
        Some(a) => a.to_lowercase(),
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: action (read|write)".to_string() },
    };

    match action.as_str() {
        "read" => {
            let store = TODO_STORE.lock().unwrap();
            let items = store.get(&get_todo_key(context)).cloned().unwrap_or_default();
            let output = if items.is_empty() {
                "No todo items.".to_string()
            } else {
                items.iter().map(|t| format!("- [{}] {} ({})", t.status, t.content, t.id)).collect::<Vec<_>>().join("\n")
            };
            ToolExecutionResult { success: true, output }
        }
        "write" => {
            let todos_val = match args.get("todos") {
                Some(v) => v,
                None => return ToolExecutionResult { success: false, output: "Missing required parameter: todos".to_string() },
            };
            let todos: Vec<TodoItem> = match serde_json::from_value(todos_val.clone()) {
                Ok(v) => v,
                Err(e) => return ToolExecutionResult { success: false, output: format!("Invalid todos format: {}", e) },
            };
            let key = get_todo_key(context);
            let mut store = TODO_STORE.lock().unwrap();
            store.insert(key, todos.clone());
            let output = if todos.is_empty() {
                "Todo list cleared.".to_string()
            } else {
                let lines: Vec<String> = todos.iter().map(|t| format!("- [{}] {} ({})", t.status, t.content, t.id)).collect();
                format!("Todo list updated ({} items):\n{}", todos.len(), lines.join("\n"))
            };
            ToolExecutionResult { success: true, output }
        }
        _ => ToolExecutionResult { success: false, output: format!("Unknown todo action: '{}'. Use read or write.", action) },
    }
}
