/**
 * @file agent/tools/executor.rs
 * @description Tool execution framework for the ReAct Loop.
 *
 * Verbatim relocation of the framework half of services/tool_executor.rs
 * (M2.1): the `ToolExecutor` trait, `BuiltinToolExecutor` registry, shared
 * result/context types, and the executor unit tests. Individual tools live in
 * the `builtin` modules; each registration now also carries a `ToolMeta` from
 * `registry.rs`.
 */

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::tools::builtin;
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta};
use crate::dto::common::ToolDefinitionDto;

// ============================================================================
// Trait
// ============================================================================

/** Result of a single tool execution. */
#[derive(Debug, Clone)]
pub struct ToolExecutionResult {
    pub success: bool,
    pub output: String,
}

/** Per-stream execution context for built-in tools. */
#[derive(Debug, Clone)]
pub struct ToolExecutionContext {
    pub conversation_id: Option<String>,
    pub workspace_path: Option<String>,
    pub shell_path: Option<String>,
    pub skills_dir: Option<String>,
    pub db_pool: Option<sqlx::SqlitePool>,
}

impl Default for ToolExecutionContext {
    fn default() -> Self {
        Self {
            conversation_id: None,
            workspace_path: None,
            shell_path: None,
            skills_dir: None,
            db_pool: None,
        }
    }
}

/** Async trait for executing a named tool with JSON arguments. */
#[async_trait::async_trait]
pub trait ToolExecutor: Send + Sync {
    /** Execute a tool with per-stream context. */
    async fn execute_with_context(
        &self,
        name: &str,
        arguments: &str,
        context: ToolExecutionContext,
    ) -> ToolExecutionResult;

    /** List all enabled tool definitions this executor can handle. */
    fn definitions(&self) -> Vec<ToolDefinitionDto>;

    /** Get all tool states (name, description, enabled). Default empty. */
    fn get_tool_states(&self) -> Vec<ToolStateDto> {
        Vec::new()
    }

    /** Enable or disable a tool. Default no-op returning false. */
    fn set_tool_enabled(&self, _name: &str, _enabled: bool) -> bool {
        false
    }

    /** Return disabled tool names for persistence. Default empty. */
    fn disabled_tool_names(&self) -> Vec<String> {
        Vec::new()
    }
}

// ============================================================================
// Builtin Tool Executor
// ============================================================================

/**
 * Registry-based executor for built-in tools.
 *
 * Each tool is a closure `async |args: Value| -> ToolExecutionResult`.
 * New tools are registered with `register()` during app startup.
 */
pub struct BuiltinToolExecutor {
    tools: HashMap<String, BuiltinToolEntry>,
    disabled_tools: Arc<Mutex<HashSet<String>>>,
}

struct BuiltinToolEntry {
    #[allow(dead_code)]
    definition: ToolDefinitionDto,
    handler: Option<Box<dyn Fn(Value, ToolExecutionContext) -> ToolExecutionResult + Send + Sync>>,
    async_handler: Option<Box<dyn Fn(Value, ToolExecutionContext) -> std::pin::Pin<Box<dyn std::future::Future<Output = ToolExecutionResult> + Send>> + Send + Sync>>,
    /** Static scheduling/policy metadata (consumed by policy + parallel executor). */
    meta: ToolMeta,
}

impl BuiltinToolExecutor {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::new_with_disabled(HashSet::new())
    }

    pub fn new_with_disabled(disabled_tools: HashSet<String>) -> Self {
        let mut executor = Self {
            tools: HashMap::new(),
            disabled_tools: Arc::new(Mutex::new(HashSet::new())),
        };
        builtin::calculator::register(&mut executor);
        builtin::file::register(&mut executor);
        builtin::todo::register(&mut executor);
        builtin::terminal::register(&mut executor);
        builtin::web_search::register(&mut executor);
        builtin::load_skill::register(&mut executor);
        builtin::parallel_branch_fork::register(&mut executor);
        let known_disabled_tools = disabled_tools
            .into_iter()
            .filter(|name| executor.tools.contains_key(name))
            .collect();
        executor.disabled_tools = Arc::new(Mutex::new(known_disabled_tools));
        executor
    }

    /** Register a built-in tool with its definition, metadata, and sync handler. */
    pub(crate) fn register(
        &mut self,
        definition: ToolDefinitionDto,
        meta: ToolMeta,
        handler: impl Fn(Value, ToolExecutionContext) -> ToolExecutionResult + Send + Sync + 'static,
    ) {
        let name = definition.function.name.clone();
        self.tools.insert(name, BuiltinToolEntry {
            definition,
            handler: Some(Box::new(handler)),
            async_handler: None,
            meta,
        });
    }

    /** Register a built-in tool with an async handler. */
    pub(crate) fn register_async(
        &mut self,
        definition: ToolDefinitionDto,
        meta: ToolMeta,
        handler: impl Fn(Value, ToolExecutionContext) -> std::pin::Pin<Box<dyn std::future::Future<Output = ToolExecutionResult> + Send>> + Send + Sync + 'static,
    ) {
        let name = definition.function.name.clone();
        self.tools.insert(name, BuiltinToolEntry {
            definition,
            handler: None,
            async_handler: Some(Box::new(handler)),
            meta,
        });
    }

    /** Metadata for a registered tool, or `None` if unknown. */
    #[allow(dead_code)] // consumed by the M2.4 parallel executor
    pub(crate) fn tool_meta(&self, name: &str) -> Option<ToolMeta> {
        self.tools.get(name).map(|e| e.meta)
    }

    /** Concurrency class of a registered tool (defaults to Safe). */
    #[allow(dead_code)] // consumed by the M2.4 parallel executor
    pub(crate) fn tool_concurrency(&self, name: &str) -> ToolConcurrency {
        self.tools
            .get(name)
            .map(|e| e.meta.concurrency)
            .unwrap_or(ToolConcurrency::Safe)
    }

    /** Get all registered tool names with their enabled/disabled state. */
    pub fn get_tool_states(&self) -> Vec<ToolStateDto> {
        let disabled = self.disabled_tools.lock().unwrap();
        self.tools
            .values()
            .map(|e| ToolStateDto {
                name: e.definition.function.name.clone(),
                description: e.definition.function.description.clone(),
                enabled: !disabled.contains(&e.definition.function.name),
            })
            .collect()
    }

    /** Enable or disable a specific tool by name. Returns false if tool not found. */
    pub fn set_tool_enabled(&self, name: &str, enabled: bool) -> bool {
        if !self.tools.contains_key(name) {
            return false;
        }
        let mut disabled = self.disabled_tools.lock().unwrap();
        if enabled {
            disabled.remove(name);
        } else {
            disabled.insert(name.to_string());
        }
        true
    }

    /** Return disabled built-in tool names in stable order for app_kv persistence. */
    pub fn disabled_tool_names(&self) -> Vec<String> {
        let disabled = self.disabled_tools.lock().unwrap();
        let mut names: Vec<String> = disabled.iter().cloned().collect();
        names.sort();
        names
    }
}

/** Tool state returned to the frontend for the settings page. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStateDto {
    pub name: String,
    pub description: String,
    pub enabled: bool,
}

#[async_trait::async_trait]
impl ToolExecutor for BuiltinToolExecutor {
    async fn execute_with_context(
        &self,
        name: &str,
        arguments: &str,
        context: ToolExecutionContext,
    ) -> ToolExecutionResult {
        let Some(entry) = self.tools.get(name) else {
            return ToolExecutionResult {
                success: false,
                output: format!("Unknown tool: {name}"),
            };
        };

        {
            let disabled = self.disabled_tools.lock().unwrap();
            if disabled.contains(name) {
                return ToolExecutionResult {
                    success: false,
                    output: format!("Tool is disabled: {name}"),
                };
            }
        }

        let args: Value = match serde_json::from_str(arguments) {
            Ok(v) => v,
            Err(e) => {
                return ToolExecutionResult {
                    success: false,
                    output: format!("Invalid JSON arguments: {e}"),
                };
            }
        };

        if let Some(ref async_h) = entry.async_handler {
            async_h(args, context).await
        } else if let Some(ref sync_h) = entry.handler {
            sync_h(args, context)
        } else {
            ToolExecutionResult {
                success: false,
                output: format!("Tool {name} has no handler registered"),
            }
        }
    }

    #[allow(dead_code)]
    fn definitions(&self) -> Vec<ToolDefinitionDto> {
        let disabled = self.disabled_tools.lock().unwrap();
        self.tools
            .values()
            .filter(|e| !disabled.contains(&e.definition.function.name))
            .map(|e| e.definition.clone())
            .collect()
    }

    fn get_tool_states(&self) -> Vec<ToolStateDto> {
        BuiltinToolExecutor::get_tool_states(self)
    }

    fn set_tool_enabled(&self, name: &str, enabled: bool) -> bool {
        BuiltinToolExecutor::set_tool_enabled(self, name, enabled)
    }

    fn disabled_tool_names(&self) -> Vec<String> {
        BuiltinToolExecutor::disabled_tool_names(self)
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_builtin_executor_calculator() {
        let executor = BuiltinToolExecutor::new();
        let defs = executor.definitions();
        assert!(defs.iter().any(|d| d.function.name == "calculator"));

        let result = executor
            .execute_with_context(
                "calculator",
                r#"{"expression": "2 + 3 * 4"}"#,
                ToolExecutionContext::default(),
            )
            .await;
        assert!(result.success);
        assert!(result.output.contains("14"));
    }

    #[tokio::test]
    async fn test_builtin_executor_unknown_tool() {
        let executor = BuiltinToolExecutor::new();
        let result = executor
            .execute_with_context("nonexistent", "{}", ToolExecutionContext::default())
            .await;
        assert!(!result.success);
        assert!(result.output.contains("Unknown tool"));
    }
}
