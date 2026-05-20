/**
 * @file services/tool_executor.rs
 * @description Tool execution framework for the ReAct Loop.
 *
 * Provides:
 *   - `ToolExecutor` trait — async interface for executing named tools
 *   - `BuiltinToolExecutor` — registry of built-in tools with safe execution
 *   - `CalculatorTool` — safe math expression evaluator (first built-in tool)
 *
 * Dead code is allowed until the ReAct loop controller wires this module
 * into the streaming command path (Phase B).
 */

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

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
#[derive(Debug, Clone, Default)]
pub struct ToolExecutionContext {
    pub conversation_id: Option<String>,
    pub workspace_path: Option<String>,
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
        executor.register_calculator();
        executor.register_file_read();
        executor.register_file_write();
        executor.register_file_list();
        executor.register_grep();
        executor.register_todo_read();
        executor.register_todo_write();
        executor.register_mkdir();
        executor.register_rm();
        executor.register_web_search();
        let known_disabled_tools = disabled_tools
            .into_iter()
            .filter(|name| executor.tools.contains_key(name))
            .collect();
        executor.disabled_tools = Arc::new(Mutex::new(known_disabled_tools));
        executor
    }

    /** Register a built-in tool with its definition and sync handler. */
    fn register(
        &mut self,
        definition: ToolDefinitionDto,
        handler: impl Fn(Value, ToolExecutionContext) -> ToolExecutionResult + Send + Sync + 'static,
    ) {
        let name = definition.function.name.clone();
        self.tools.insert(name, BuiltinToolEntry {
            definition,
            handler: Some(Box::new(handler)),
            async_handler: None,
        });
    }

    /** Register a built-in tool with an async handler. */
    #[allow(dead_code)]
    fn register_async(
        &mut self,
        definition: ToolDefinitionDto,
        handler: impl Fn(Value, ToolExecutionContext) -> std::pin::Pin<Box<dyn std::future::Future<Output = ToolExecutionResult> + Send>> + Send + Sync + 'static,
    ) {
        let name = definition.function.name.clone();
        self.tools.insert(name, BuiltinToolEntry {
            definition,
            handler: None,
            async_handler: Some(Box::new(handler)),
        });
    }

    /** Register the calculator tool. */
    fn register_calculator(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "calculator".to_string(),
                description: "Evaluate a mathematical expression. Supports +, -, *, /, ^, parentheses, and basic functions (sin, cos, tan, sqrt, abs, log, ln, pi, e).".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "expression": {
                            "type": "string",
                            "description": "The mathematical expression to evaluate, e.g. '2 + 3 * 4' or 'sqrt(144)'"
                        }
                    },
                    "required": ["expression"]
                }),
            },
        };

        self.register(definition, |args, _context| calculator_handler(args));
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

/**
 * Safe mathematical expression evaluator.
 *
 * Security: Only allows digits, operators (+, -, *, /, ^), parentheses,
 * decimal points, and whitelisted function/constant names.
 * Rejects any expression containing non-mathematical characters.
 */
fn calculator_handler(args: Value) -> ToolExecutionResult {
    let expression = match args.get("expression").and_then(Value::as_str) {
        Some(expr) => expr.trim(),
        None => {
            return ToolExecutionResult {
                success: false,
                output: "Missing required parameter: expression".to_string(),
            };
        }
    };

    if expression.is_empty() {
        return ToolExecutionResult {
            success: false,
            output: "Expression cannot be empty".to_string(),
        };
    }

    if !is_safe_expression(expression) {
        return ToolExecutionResult {
            success: false,
            output: "Expression contains disallowed characters. Only numbers, operators (+, -, *, /, ^), parentheses, and functions (sin, cos, tan, sqrt, abs, log, ln, pi, e) are allowed.".to_string(),
        };
    }

    match evaluate_expression(expression) {
        Ok(result) => ToolExecutionResult {
            success: true,
            output: format!("{expression} = {result}"),
        },
        Err(msg) => ToolExecutionResult {
            success: false,
            output: format!("Evaluation error: {msg}"),
        },
    }
}

/** Check that expression only contains safe mathematical characters. */
fn is_safe_expression(expr: &str) -> bool {
    let allowed = |c: char| -> bool {
        c.is_ascii_digit()
            || c == '.'
            || c == '+'
            || c == '-'
            || c == '*'
            || c == '/'
            || c == '^'
            || c == '('
            || c == ')'
            || c == ' '
            || c == ','
    };

    // First pass: check all characters are from allowed set or part of known names
    let lowered = expr.to_lowercase();
    let cleaned = lowered
        .replace("sin", "")
        .replace("cos", "")
        .replace("tan", "")
        .replace("sqrt", "")
        .replace("abs", "")
        .replace("log", "")
        .replace("ln", "")
        .replace("pi", "")
        .replace("e", "");

    cleaned.chars().all(allowed)
}

/**
 * Recursive descent parser for mathematical expressions.
 *
 * Grammar:
 *   expr     → term (('+' | '-') term)*
 *   term     → power (('*' | '/') power)*
 *   power    → unary ('^' power)?
 *   unary    → ('-' unary) | call
 *   call     → NUMBER | IDENT '(' expr (',' expr)* ')' | IDENT | '(' expr ')'
 */
fn evaluate_expression(input: &str) -> Result<f64, String> {
    let tokens = tokenize(input)?;
    let mut pos = 0;
    let result = parse_expr(&tokens, &mut pos)?;
    if pos < tokens.len() {
        return Err(format!("Unexpected token: {:?}", tokens[pos]));
    }
    Ok(result)
}

#[derive(Debug, Clone)]
enum Token {
    Number(f64),
    Op(String),
    Func(String),
    Const(String),
    LParen,
    RParen,
    Comma,
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(&c) = chars.peek() {
        match c {
            ' ' | '\t' => {
                chars.next();
            }
            '+' | '-' | '*' | '/' | '^' => {
                tokens.push(Token::Op(c.to_string()));
                chars.next();
            }
            '(' => {
                tokens.push(Token::LParen);
                chars.next();
            }
            ')' => {
                tokens.push(Token::RParen);
                chars.next();
            }
            ',' => {
                tokens.push(Token::Comma);
                chars.next();
            }
            '.' | '0'..='9' => {
                let mut num_str = String::new();
                while let Some(&d) = chars.peek() {
                    if d.is_ascii_digit() || d == '.' {
                        num_str.push(d);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let n: f64 = num_str.parse().map_err(|e| format!("Invalid number '{num_str}': {e}"))?;
                tokens.push(Token::Number(n));
            }
            c if c.is_ascii_alphabetic() => {
                let mut name = String::new();
                while let Some(&d) = chars.peek() {
                    if d.is_ascii_alphabetic() {
                        name.push(d);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let lower = name.to_lowercase();
                match lower.as_str() {
                    "sin" | "cos" | "tan" | "sqrt" | "abs" | "log" | "ln" => {
                        tokens.push(Token::Func(lower));
                    }
                    "pi" => tokens.push(Token::Const("pi".to_string())),
                    "e" => tokens.push(Token::Const("e".to_string())),
                    other => return Err(format!("Unknown identifier: {other}")),
                }
            }
            other => return Err(format!("Unexpected character: {other}")),
        }
    }

    Ok(tokens)
}

fn parse_expr(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    let mut left = parse_term(tokens, pos)?;
    while *pos < tokens.len() {
        match &tokens[*pos] {
            Token::Op(op) if op == "+" || op == "-" => {
                let op = op.clone();
                *pos += 1;
                let right = parse_term(tokens, pos)?;
                left = if op == "+" { left + right } else { left - right };
            }
            _ => break,
        }
    }
    Ok(left)
}

fn parse_term(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    let mut left = parse_power(tokens, pos)?;
    while *pos < tokens.len() {
        match &tokens[*pos] {
            Token::Op(op) if op == "*" || op == "/" => {
                let op = op.clone();
                *pos += 1;
                let right = parse_power(tokens, pos)?;
                left = if op == "*" {
                    left * right
                } else {
                    if right == 0.0 {
                        return Err("Division by zero".to_string());
                    }
                    left / right
                };
            }
            _ => break,
        }
    }
    Ok(left)
}

fn parse_power(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    let base = parse_unary(tokens, pos)?;
    if *pos < tokens.len() {
        if let Token::Op(op) = &tokens[*pos] {
            if op == "^" {
                *pos += 1;
                let exp = parse_power(tokens, pos)?; // right-associative
                return Ok(base.powf(exp));
            }
        }
    }
    Ok(base)
}

fn parse_unary(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    if *pos < tokens.len() {
        if let Token::Op(op) = &tokens[*pos] {
            if op == "-" {
                *pos += 1;
                let val = parse_unary(tokens, pos)?;
                return Ok(-val);
            }
        }
    }
    parse_call(tokens, pos)
}

fn parse_call(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    if *pos >= tokens.len() {
        return Err("Unexpected end of expression".to_string());
    }

    match &tokens[*pos] {
        Token::Number(n) => {
            let val = *n;
            *pos += 1;
            Ok(val)
        }
        Token::Const(name) => {
            let val = match name.as_str() {
                "pi" => std::f64::consts::PI,
                "e" => std::f64::consts::E,
                _ => return Err(format!("Unknown constant: {name}")),
            };
            *pos += 1;
            Ok(val)
        }
        Token::Func(name) => {
            let func_name = name.clone();
            *pos += 1;
            // Expect '('
            if *pos >= tokens.len() || !matches!(&tokens[*pos], Token::LParen) {
                return Err(format!("Expected '(' after function '{func_name}'"));
            }
            *pos += 1;

            let mut args_vec = Vec::new();
            if *pos < tokens.len() && !matches!(&tokens[*pos], Token::RParen) {
                args_vec.push(parse_expr(tokens, pos)?);
                while *pos < tokens.len() && matches!(&tokens[*pos], Token::Comma) {
                    *pos += 1;
                    args_vec.push(parse_expr(tokens, pos)?);
                }
            }

            // Expect ')'
            if *pos >= tokens.len() || !matches!(&tokens[*pos], Token::RParen) {
                return Err(format!("Expected ')' after function '{func_name}' arguments"));
            }
            *pos += 1;

            apply_function(&func_name, &args_vec)
        }
        Token::LParen => {
            *pos += 1;
            let val = parse_expr(tokens, pos)?;
            if *pos >= tokens.len() || !matches!(&tokens[*pos], Token::RParen) {
                return Err("Expected ')'".to_string());
            }
            *pos += 1;
            Ok(val)
        }
        other => Err(format!("Unexpected token: {other:?}")),
    }
}

fn apply_function(name: &str, args: &[f64]) -> Result<f64, String> {
    match name {
        "sin" => {
            if args.len() != 1 { return Err("sin() requires exactly 1 argument".into()); }
            Ok(args[0].sin())
        }
        "cos" => {
            if args.len() != 1 { return Err("cos() requires exactly 1 argument".into()); }
            Ok(args[0].cos())
        }
        "tan" => {
            if args.len() != 1 { return Err("tan() requires exactly 1 argument".into()); }
            Ok(args[0].tan())
        }
        "sqrt" => {
            if args.len() != 1 { return Err("sqrt() requires exactly 1 argument".into()); }
            if args[0] < 0.0 { return Err("sqrt() argument must be non-negative".into()); }
            Ok(args[0].sqrt())
        }
        "abs" => {
            if args.len() != 1 { return Err("abs() requires exactly 1 argument".into()); }
            Ok(args[0].abs())
        }
        "log" => {
            if args.len() == 1 { return Ok(args[0].log10()); }
            if args.len() == 2 { return Ok(args[0].log(args[1])); }
            Err("log() requires 1 or 2 arguments".into())
        }
        "ln" => {
            if args.len() != 1 { return Err("ln() requires exactly 1 argument".into()); }
            Ok(args[0].ln())
        }
        _ => Err(format!("Unknown function: {name}")),
    }
}

// ============================================================================
// Workspace Path Validation
// ============================================================================

fn validate_path_in_workspace(path: &str, workspace_root: &Path) -> Result<PathBuf, String> {
    let target = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        workspace_root.join(path)
    };

    let canonical_workspace = workspace_root
        .canonicalize()
        .map_err(|e| format!("Invalid workspace root '{}': {}", workspace_root.display(), e))?;

    let canonical_target = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| format!("Invalid path: '{}'", path))?;
        if !parent.exists() {
            return Err(format!(
                "Parent directory does not exist for path: '{}'",
                path
            ));
        }
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Cannot resolve parent of '{}': {}", path, e))?;
        canonical_parent.join(
            target
                .file_name()
                .ok_or_else(|| format!("Invalid file name in path: '{}'", path))?,
        )
    };

    if !canonical_target.starts_with(&canonical_workspace) {
        return Err(format!(
            "Path '{}' is outside the workspace directory '{}'. Access denied for security.",
            path,
            workspace_root.display()
        ));
    }

    Ok(canonical_target)
}

fn get_workspace(context: &ToolExecutionContext) -> Result<PathBuf, String> {
    match context.workspace_path.as_deref() {
        Some(path) => Ok(PathBuf::from(path)),
        None => Err("No workspace directory configured. Please set a workspace path for this conversation before using file tools.".to_string()),
    }
}

// ============================================================================
// Todo Store (conversation-scoped)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    pub status: String,
}

static TODO_STORE: Lazy<Mutex<HashMap<String, Vec<TodoItem>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/** Current conversation context for todo operations. Set by streaming layer. */
static TODO_CONVERSATION_ID: Lazy<Mutex<Option<String>>> =
    Lazy::new(|| Mutex::new(None));

/** Set the current conversation ID for todo tool context. */
pub fn set_todo_conversation_id(id: Option<String>) {
    let mut ctx = TODO_CONVERSATION_ID.lock().unwrap();
    *ctx = id;
}

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

pub fn read_all_todos() -> Vec<TodoItem> {
    let store = TODO_STORE.lock().unwrap();
    let key = get_legacy_todo_key();
    store.get(&key).cloned().unwrap_or_default()
}

fn get_todo_key(context: &ToolExecutionContext) -> String {
    context
        .conversation_id
        .clone()
        .unwrap_or_else(|| "default".to_string())
}

fn get_legacy_todo_key() -> String {
    let ctx = TODO_CONVERSATION_ID.lock().unwrap();
    ctx.clone().unwrap_or_else(|| "default".to_string())
}

// ============================================================================
// File Tools Registration
// ============================================================================

impl BuiltinToolExecutor {
    fn register_file_read(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "file_read".to_string(),
                description: "Read the contents of a file within the workspace. Returns file content with line numbers. Supports multiple character encodings (utf-8, gbk, gb2312, gb18030, big5, shift_jis, latin1). Default encoding is utf-8. Use offset and limit to read specific line ranges. Output is capped at 50000 characters to prevent context overflow.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path relative to workspace root, or absolute path within workspace" },
                        "offset": { "type": "integer", "description": "Starting line number (0-indexed). Default: 0" },
                        "limit": { "type": "integer", "description": "Maximum number of lines to read. Default: 2000" },
                        "encoding": { "type": "string", "description": "Character encoding. Supported: utf-8, gbk, gb2312, gb18030, big5, shift_jis, latin1. Default: utf-8" }
                    },
                    "required": ["path"]
                }),
            },
        };
        self.register(definition, |args, context| file_read_handler(args, &context));
    }

    fn register_file_write(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "file_write".to_string(),
                description: "Create or overwrite a file within the workspace. Creates parent directories if needed.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path relative to workspace root, or absolute path within workspace" },
                        "content": { "type": "string", "description": "Content to write to the file" }
                    },
                    "required": ["path", "content"]
                }),
            },
        };
        self.register(definition, |args, context| file_write_handler(args, &context));
    }

    fn register_file_list(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "file_list".to_string(),
                description: "List files and directories within the workspace. Returns names, sizes, and types.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path relative to workspace root. Default: '.' (workspace root)" },
                        "recursive": { "type": "boolean", "description": "Whether to list recursively. Default: false" }
                    },
                    "required": []
                }),
            },
        };
        self.register(definition, |args, context| file_list_handler(args, &context));
    }

    fn register_grep(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "grep".to_string(),
                description: "Search file contents using a regex pattern within the workspace. Returns matching lines with file paths and line numbers. Limited to 50 results.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Regex pattern to search for" },
                        "path": { "type": "string", "description": "Directory to search in (relative to workspace). Default: workspace root" },
                        "include": { "type": "string", "description": "File extension filter, e.g. '.rs' or '.ts'. Default: all files" }
                    },
                    "required": ["pattern"]
                }),
            },
        };
        self.register(definition, |args, context| grep_handler(args, &context));
    }

    fn register_todo_read(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "todo_read".to_string(),
                description: "Read the current todo list for this conversation. Returns all todo items with their IDs, content, and status.".to_string(),
                parameters: json!({ "type": "object", "properties": {}, "required": [] }),
            },
        };
        self.register(definition, |_args, context| {
            let store = TODO_STORE.lock().unwrap();
            let items = store.get(&get_todo_key(&context)).cloned().unwrap_or_default();
            let output = if items.is_empty() {
                "No todo items.".to_string()
            } else {
                items.iter().map(|t| format!("- [{}] {} ({})", t.status, t.content, t.id)).collect::<Vec<_>>().join("\n")
            };
            ToolExecutionResult { success: true, output }
        });
    }

    fn register_todo_write(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "todo_write".to_string(),
                description: "Manage a todo checklist for multi-step tasks. IMPORTANT: Proactively use this tool when the user's request involves multiple steps or sequential operations. Create a todo list at the start of complex tasks, update item statuses as you progress, and mark items completed when done. This helps track progress and ensures nothing is missed.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
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
                            }
                        }
                    },
                    "required": ["todos"]
                }),
            },
        };
        self.register(definition, |args, context| {
            let todos_val = match args.get("todos") {
                Some(v) => v,
                None => return ToolExecutionResult { success: false, output: "Missing required parameter: todos".to_string() },
            };
            let todos: Vec<TodoItem> = match serde_json::from_value(todos_val.clone()) {
                Ok(v) => v,
                Err(e) => return ToolExecutionResult { success: false, output: format!("Invalid todos format: {}", e) },
            };
            let key = get_todo_key(&context);
            let mut store = TODO_STORE.lock().unwrap();
            store.insert(key, todos.clone());
            let output = if todos.is_empty() {
                "Todo list cleared.".to_string()
            } else {
                let lines: Vec<String> = todos.iter().map(|t| format!("- [{}] {} ({})", t.status, t.content, t.id)).collect();
                format!("Todo list updated ({} items):\n{}", todos.len(), lines.join("\n"))
            };
            ToolExecutionResult { success: true, output }
        });
    }

    fn register_mkdir(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "mkdir".to_string(),
                description: "Create a directory within the workspace. Creates parent directories recursively if needed.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path relative to workspace root, or absolute path within workspace" }
                    },
                    "required": ["path"]
                }),
            },
        };
        self.register(definition, |args, context| mkdir_handler(args, &context));
    }

    fn register_rm(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "rm".to_string(),
                description: "Delete a file or directory within the workspace. THIS IS A DESTRUCTIVE OPERATION that requires user confirmation before execution. Use with caution — deleted files cannot be recovered.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File or directory path relative to workspace root, or absolute path within workspace" },
                        "recursive": { "type": "boolean", "description": "If true, delete directories recursively with all contents. Default: false (only removes empty directories)" }
                    },
                    "required": ["path"]
                }),
            },
        };
        self.register(definition, |args, context| rm_handler(args, &context));
    }

    fn register_web_search(&mut self) {
        let definition = ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: ToolFunctionDefDto {
                name: "web_search".to_string(),
                description: "Search the web for information. Returns a list of relevant results with titles, URLs, and snippets. Use this tool when you need to find current information, facts, or references that are not in your training data.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of results to return (1-10, default 5)"
                        }
                    },
                    "required": ["query"]
                }),
            },
        };

        self.register_async(definition, |args, _context| {
            Box::pin(web_search_handler(args))
        });
    }
}

// ============================================================================
// File Tool Handlers
// ============================================================================

fn file_read_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let path = match args.get("path").and_then(Value::as_str) {
        Some(p) => p,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: path".to_string() },
    };
    let offset = args.get("offset").and_then(Value::as_i64).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(2000) as usize;
    let encoding = args.get("encoding").and_then(Value::as_str).unwrap_or("utf-8").to_lowercase();
    let max_chars = 50000usize;

    let full_path = match validate_path_in_workspace(path, &workspace) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };

    let raw_bytes = match std::fs::read(&full_path) {
        Ok(b) => b,
        Err(e) => return ToolExecutionResult { success: false, output: format!("Failed to read file '{}': {}", path, e) },
    };

    let content: String = match encoding.as_str() {
        "utf-8" | "utf8" => match String::from_utf8(raw_bytes) {
            Ok(s) => s,
            Err(e) => {
                let _lossy = String::from_utf8_lossy(e.as_bytes()).to_string();
                return ToolExecutionResult {
                    success: false,
                    output: format!(
                        "File '{}' is not valid UTF-8. Try specifying an encoding like 'gbk', 'gb2312', or 'latin1'. Error: {}",
                        path, e
                    ),
                };
            }
        },
        enc => {
            let decoder = match enc {
                "gbk" => encoding_rs::GBK,
                "gb2312" => encoding_rs::GBK,
                "gb18030" => encoding_rs::GB18030,
                "big5" => encoding_rs::BIG5,
                "shift_jis" | "shift-jis" | "sjis" => encoding_rs::SHIFT_JIS,
                "latin1" | "iso-8859-1" | "iso_8859_1" => encoding_rs::WINDOWS_1252,
                "euc-kr" | "euc_kr" => encoding_rs::EUC_KR,
                other => {
                    return ToolExecutionResult {
                        success: false,
                        output: format!(
                            "Unsupported encoding '{}'. Supported: utf-8, gbk, gb2312, gb18030, big5, shift_jis, latin1, euc-kr",
                            other
                        ),
                    };
                }
            };
            let (cow, _encoding_used, _had_errors) = decoder.decode(&raw_bytes);
            let content: String = cow.into_owned();
            content
        }
    };

    let _file_size = content.len();
    let total_lines = content.lines().count();
    let lines: Vec<&str> = content.lines().collect();
    let selected: Vec<String> = lines
        .into_iter()
        .enumerate()
        .skip(offset)
        .take(limit)
        .map(|(i, line)| format!("{:>6} | {}", i + 1, line))
        .collect();

    if selected.is_empty() {
        return ToolExecutionResult { success: true, output: "(empty file or offset beyond end)".to_string() };
    }

    let mut output = format!(
        "File: {} | Encoding: {} | Total lines: {} | Showing lines {}-{}\n",
        path,
        encoding,
        total_lines,
        offset + 1,
        (offset + selected.len()).min(total_lines)
    );

    let mut char_count = 0usize;
    let mut truncated = false;
    for line in &selected {
        char_count += line.len() + 1;
        if char_count > max_chars {
            truncated = true;
            break;
        }
        output.push_str(line);
        output.push('\n');
    }

    if truncated {
        output.push_str(&format!(
            "\n... [truncated at {} characters, max output is {} chars. Use offset/limit to read more.]",
            max_chars, max_chars
        ));
    }

    ToolExecutionResult { success: true, output }
}

fn file_write_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let path = match args.get("path").and_then(Value::as_str) {
        Some(p) => p,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: path".to_string() },
    };
    let content = match args.get("content").and_then(Value::as_str) {
        Some(c) => c,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: content".to_string() },
    };

    const MAX_CONTENT_SIZE: usize = 100_000;
    if content.len() > MAX_CONTENT_SIZE {
        return ToolExecutionResult {
            success: false,
            output: format!(
                "Content too large ({} bytes). Maximum allowed is {} bytes.",
                content.len(), MAX_CONTENT_SIZE
            ),
        };
    }

    let full_path = match validate_path_in_workspace(path, &workspace) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };

    if let Some(parent) = full_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return ToolExecutionResult { success: false, output: format!("Failed to create parent directory: {}", e) };
        }
    }

    match std::fs::write(&full_path, content) {
        Ok(()) => ToolExecutionResult { success: true, output: format!("Successfully wrote to '{}'", path) },
        Err(e) => ToolExecutionResult { success: false, output: format!("Failed to write file '{}': {}", path, e) },
    }
}

fn mkdir_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let path = match args.get("path").and_then(Value::as_str) {
        Some(p) => p,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: path".to_string() },
    };
    if path.is_empty() {
        return ToolExecutionResult { success: false, output: "Path cannot be empty".to_string() };
    }

    let full_path = match validate_path_in_workspace(path, &workspace) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };

    if full_path.exists() {
        if full_path.is_dir() {
            return ToolExecutionResult { success: true, output: format!("Directory already exists: '{}'", path) };
        } else {
            return ToolExecutionResult { success: false, output: format!("A file already exists at '{}'. Cannot create directory.", path) };
        }
    }

    match std::fs::create_dir_all(&full_path) {
        Ok(()) => ToolExecutionResult { success: true, output: format!("Directory created: '{}'", path) },
        Err(e) => ToolExecutionResult { success: false, output: format!("Failed to create directory '{}': {}", path, e) },
    }
}

fn rm_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let path = match args.get("path").and_then(Value::as_str) {
        Some(p) => p,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: path".to_string() },
    };
    if path.is_empty() {
        return ToolExecutionResult { success: false, output: "Path cannot be empty".to_string() };
    }

    let full_path = match validate_path_in_workspace(path, &workspace) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };

    if !full_path.exists() {
        return ToolExecutionResult { success: false, output: format!("Path does not exist: '{}'", path) };
    }

    let recursive = args.get("recursive").and_then(Value::as_bool).unwrap_or(false);

    if full_path.is_dir() {
        if recursive {
            match std::fs::remove_dir_all(&full_path) {
                Ok(()) => ToolExecutionResult { success: true, output: format!("Directory deleted (recursive): '{}'", path) },
                Err(e) => ToolExecutionResult { success: false, output: format!("Failed to delete directory '{}': {}", path, e) },
            }
        } else {
            match std::fs::remove_dir(&full_path) {
                Ok(()) => ToolExecutionResult { success: true, output: format!("Directory deleted: '{}'", path) },
                Err(e) => ToolExecutionResult { success: false, output: format!("Failed to delete directory '{}'. It may not be empty — use recursive=true to delete non-empty directories. Error: {}", path, e) },
            }
        }
    } else {
        match std::fs::remove_file(&full_path) {
            Ok(()) => ToolExecutionResult { success: true, output: format!("File deleted: '{}'", path) },
            Err(e) => ToolExecutionResult { success: false, output: format!("Failed to delete file '{}': {}", path, e) },
        }
    }
}

fn file_list_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let rel_path = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let recursive = args.get("recursive").and_then(Value::as_bool).unwrap_or(false);

    let full_path = match validate_path_in_workspace(rel_path, &workspace) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };

    if !full_path.is_dir() {
        return ToolExecutionResult { success: false, output: format!("'{}' is not a directory", rel_path) };
    }

    let mut entries = Vec::new();
    let max_entries = 500usize;
    collect_dir_entries(&full_path, recursive, &mut entries, 0, max_entries);

    if entries.is_empty() {
        return ToolExecutionResult { success: true, output: "(empty directory)".to_string() };
    }

    let display_entries: Vec<String> = entries
        .iter()
        .map(|(depth, name, size, is_dir)| {
            let indent = "  ".repeat(*depth);
            let type_icon = if *is_dir { "DIR " } else { "FILE" };
            let size_str = if *is_dir { String::new() } else { format!(" ({} bytes)", size) };
            format!("{}{} {}{}", indent, type_icon, name, size_str)
        })
        .collect();

    let mut output = format!("Directory listing of '{}':\n{}", rel_path, display_entries.join("\n"));
    if entries.len() >= max_entries {
        output.push_str(&format!("\n... (showing first {} entries)", max_entries));
    }
    ToolExecutionResult { success: true, output }
}

fn collect_dir_entries(
    dir: &Path,
    recursive: bool,
    entries: &mut Vec<(usize, String, u64, bool)>,
    depth: usize,
    max_entries: usize,
) {
    if entries.len() >= max_entries { return; }
    if let Ok(read_dir) = std::fs::read_dir(dir) {
        let mut dir_entries: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
        dir_entries.sort_by_key(|e| e.file_name());
        for entry in dir_entries {
            if entries.len() >= max_entries { return; }
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = entry.metadata().ok();
            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            entries.push((depth, name.clone(), size, is_dir));
            if recursive && is_dir {
                collect_dir_entries(&entry.path(), true, entries, depth + 1, max_entries);
            }
        }
    }
}

fn grep_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let pattern = match args.get("pattern").and_then(Value::as_str) {
        Some(p) => p,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: pattern".to_string() },
    };
    let include_ext = args.get("include").and_then(Value::as_str).map(|s| s.to_string());

    let search_root = match args.get("path").and_then(Value::as_str) {
        Some(p) if !p.is_empty() && p != "." => {
            match validate_path_in_workspace(p, &workspace) {
                Ok(path) => path,
                Err(e) => return ToolExecutionResult { success: false, output: e },
            }
        }
        _ => workspace.clone(),
    };

    if !search_root.exists() {
        return ToolExecutionResult { success: false, output: format!("Search path does not exist: {}", search_root.display()) };
    }
    if !search_root.is_dir() {
        return ToolExecutionResult { success: false, output: format!("Search path is not a directory: {}", search_root.display()) };
    }

    let re = match Regex::new(pattern) {
        Ok(r) => r,
        Err(e) => return ToolExecutionResult { success: false, output: format!("Invalid regex pattern: {}", e) },
    };

    let mut results = Vec::new();
    let max_results = 50;
    grep_dir(&search_root, &re, &include_ext, &mut results, max_results, &workspace);

    if results.is_empty() {
        return ToolExecutionResult { success: true, output: "No matches found.".to_string() };
    }

    let truncated = if results.len() >= max_results {
        format!("{}\n... (showing first {} results)", results.join("\n"), max_results)
    } else {
        format!("Found {} matches:\n{}", results.len(), results.join("\n"))
    };
    ToolExecutionResult { success: true, output: truncated }
}

fn grep_dir(
    dir: &Path,
    re: &Regex,
    include_ext: &Option<String>,
    results: &mut Vec<String>,
    max_results: usize,
    workspace: &Path,
) {
    if results.len() >= max_results { return; }
    if let Ok(read_dir) = std::fs::read_dir(dir) {
        let mut entries: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if results.len() >= max_results { return; }
            let path = entry.path();
            if path.is_dir() {
                if let Ok(canonical) = path.canonicalize() {
                    if canonical.starts_with(workspace) {
                        grep_dir(&path, re, include_ext, results, max_results, workspace);
                    }
                }
            } else {
                let ext_match = match include_ext {
                    Some(ext) => {
                        let filter = ext.trim_start_matches('.').to_lowercase();
                        path.extension()
                            .map(|e| e.to_string_lossy().to_lowercase() == filter)
                            .unwrap_or(false)
                    },
                    None => true,
                };
                if !ext_match { continue; }
                // Read raw bytes and try UTF-8 first, fallback to lossy decode
                if let Ok(raw) = std::fs::read(&path) {
                    let content = String::from_utf8_lossy(&raw);
                    let rel = path.strip_prefix(workspace).unwrap_or(&path).display().to_string();
                    for (i, line) in content.lines().enumerate() {
                        if results.len() >= max_results { return; }
                        if re.is_match(line) {
                            results.push(format!("{}:{}: {}", rel, i + 1, line));
                        }
                    }
                }
            }
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

// ============================================================================
// Web Search Handler
// ============================================================================

async fn web_search_handler(args: Value) -> ToolExecutionResult {
    let query = match args.get("query").and_then(Value::as_str) {
        Some(q) => q.trim().to_string(),
        None => {
            return ToolExecutionResult {
                success: false,
                output: "Missing required parameter: query".to_string(),
            };
        }
    };

    if query.is_empty() {
        return ToolExecutionResult {
            success: false,
            output: "Search query cannot be empty".to_string(),
        };
    }

    let max_results = args
        .get("max_results")
        .and_then(Value::as_i64)
        .unwrap_or(5)
        .clamp(1, 10) as usize;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Failed to create HTTP client: {e}"),
            };
        }
    };

    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(&query)
    );

    let response = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Search request failed: {e}"),
            };
        }
    };

    let html = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Failed to read response: {e}"),
            };
        }
    };

    let document = match scraper::Html::parse_document(&html) {
        doc => doc,
    };

    let result_selector = match scraper::Selector::parse(".result") {
        Ok(s) => s,
        Err(_) => {
            return ToolExecutionResult {
                success: false,
                output: "Failed to parse search results page structure".to_string(),
            };
        }
    };

    let title_selector = match scraper::Selector::parse(".result__title a") {
        Ok(s) => s,
        Err(_) => {
            return ToolExecutionResult {
                success: false,
                output: "Failed to parse result title elements".to_string(),
            };
        }
    };

    let snippet_selector = match scraper::Selector::parse(".result__snippet") {
        Ok(s) => s,
        Err(_) => {
            return ToolExecutionResult {
                success: false,
                output: "Failed to parse result snippet elements".to_string(),
            };
        }
    };

    let mut results = Vec::new();

    for result_node in document.select(&result_selector).take(max_results) {
        let title = result_node
            .select(&title_selector)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let href = result_node
            .select(&title_selector)
            .next()
            .and_then(|el| el.value().attr("href"))
            .unwrap_or("");

        let snippet = result_node
            .select(&snippet_selector)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        if !title.is_empty() {
            results.push(json!({
                "title": title,
                "url": href,
                "snippet": snippet,
            }));
        }
    }

    if results.is_empty() {
        return ToolExecutionResult {
            success: true,
            output: format!("No results found for: {query}"),
        };
    }

    let output = serde_json::to_string_pretty(&json!({
        "query": query,
        "results": results,
    }))
    .unwrap_or_else(|_| "Error formatting results".to_string());

    ToolExecutionResult {
        success: true,
        output,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_arithmetic() {
        assert_eq!(evaluate_expression("2 + 3").unwrap(), 5.0);
        assert_eq!(evaluate_expression("10 - 4").unwrap(), 6.0);
        assert_eq!(evaluate_expression("3 * 4").unwrap(), 12.0);
        assert_eq!(evaluate_expression("10 / 2").unwrap(), 5.0);
    }

    #[test]
    fn test_operator_precedence() {
        assert_eq!(evaluate_expression("2 + 3 * 4").unwrap(), 14.0);
        assert_eq!(evaluate_expression("(2 + 3) * 4").unwrap(), 20.0);
    }

    #[test]
    fn test_power() {
        assert_eq!(evaluate_expression("2 ^ 3").unwrap(), 8.0);
        assert_eq!(evaluate_expression("2 ^ 3 ^ 2").unwrap(), 512.0); // right-associative
    }

    #[test]
    fn test_unary_minus() {
        assert_eq!(evaluate_expression("-5 + 3").unwrap(), -2.0);
        assert_eq!(evaluate_expression("-(-3)").unwrap(), 3.0);
    }

    #[test]
    fn test_functions() {
        let result = evaluate_expression("sqrt(144)").unwrap();
        assert!((result - 12.0).abs() < 1e-10);

        let result = evaluate_expression("abs(-7)").unwrap();
        assert!((result - 7.0).abs() < 1e-10);
    }

    #[test]
    fn test_constants() {
        let result = evaluate_expression("pi").unwrap();
        assert!((result - std::f64::consts::PI).abs() < 1e-10);

        let result = evaluate_expression("2 * pi").unwrap();
        assert!((result - 2.0 * std::f64::consts::PI).abs() < 1e-10);
    }

    #[test]
    fn test_division_by_zero() {
        assert!(evaluate_expression("1 / 0").is_err());
    }

    #[test]
    fn test_unsafe_expression_rejected() {
        assert!(!is_safe_expression("system('rm -rf /')"));
        assert!(!is_safe_expression("eval('code')"));
        assert!(is_safe_expression("2 + 3 * sqrt(16)"));
    }

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
