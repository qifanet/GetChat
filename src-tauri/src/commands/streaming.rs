/**
 * @file commands/streaming.rs
 * @description Runtime model streaming commands with ReAct Loop support.
 *
 * These commands do not mutate persisted conversation entities directly.
 * Instead, they bridge provider HTTP streams into frontend channel events while
 * the frontend continues to own placeholder creation, completion, and failure
 * persistence through the existing message commands.
 *
 * ReAct Loop (Reason + Act):
 *   When the model requests tool calls, this command automatically:
 *     1. Emits TOOL_CALL events for each requested call
 *     2. Executes each tool via the ToolExecutor registry
 *     3. Emits TOOL_RESULT events with execution results
 *     4. Appends assistant (with tool_calls) + tool results to the prompt
 *     5. Re-invokes the model with the extended prompt
 *     6. Repeats until the model responds normally or max_iterations is reached
 */

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{ipc::Channel, Manager, State};
use tokio::sync::watch;

use crate::dto::common::{ToolCallDto, ToolDefinitionDto};
use crate::dto::streaming::{ModelPromptMessageDto, ModelStreamEventDto, StartModelStreamInput};
use crate::error::AppError;
use crate::services::model_stream_service::{
    self, ModelStreamOutcome, ResolvedModelStreamRequest,
};
use crate::services::tool_executor::{ToolExecutionContext, ToolExecutionResult};
use crate::state::{AppState, BUILTIN_DISABLED_TOOLS_KV_KEY, TOOL_LIMITS_KV_KEY};

const TOOL_EXECUTION_TIMEOUT_SECONDS: u64 = 60;

// ============================================================================
// Commands
// ============================================================================

/**
 * Return all enabled tool definitions for the frontend to include in model
 * stream requests. This allows the frontend to decide whether to attach tools
 * without needing a separate round-trip per stream.
 */
#[tauri::command]
pub async fn get_enabled_tool_definitions(
    state: State<'_, AppState>,
) -> Result<Vec<crate::dto::common::ToolDefinitionDto>, AppError> {
    let defs = build_backend_enabled_tool_definitions(&state).await;
    let builtin_count = state.tool_executor.definitions().len();

    tracing::info!(
        cmd = "get_enabled_tool_definitions",
        builtin_count,
        mcp_count = defs.len().saturating_sub(builtin_count),
        total_count = defs.len(),
        "ok"
    );
    Ok(defs)
}

/** Build the backend-authoritative enabled tool list. Frontend input is only a hint. */
async fn build_backend_enabled_tool_definitions(state: &State<'_, AppState>) -> Vec<ToolDefinitionDto> {
    let mut defs = state.tool_executor.definitions();

    let app_data_dir = state.app_handle.path().app_data_dir().unwrap_or_default();
    let config_result = crate::services::mcp_config_file::load_mcp_config_file(&app_data_dir);
    let disabled_servers: HashSet<String> = config_result
        .servers
        .iter()
        .filter(|s| s.config.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false))
        .map(|s| s.name.clone())
        .collect();

    let mcp_manager = state.mcp_manager.lock().await;
    for (server_name, tool) in mcp_manager.all_tools() {
        if disabled_servers.contains(&server_name) {
            continue;
        }
        defs.push(ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: crate::dto::common::ToolFunctionDefDto {
                name: format!("mcp__{}__{}", server_name, tool.name),
                description: tool
                    .description
                    .unwrap_or_else(|| format!("MCP tool: {}", tool.name)),
                parameters: tool.input_schema.unwrap_or(serde_json::json!({
                    "type": "object",
                    "properties": {}
                })),
            },
        });
    }
    defs.sort_by(|a, b| a.function.name.cmp(&b.function.name));
    defs
}

/** Return all built-in tools with their enabled/disabled state. */
#[tauri::command]
pub async fn get_builtin_tool_states(
    state: State<'_, AppState>,
) -> Result<Vec<crate::services::tool_executor::ToolStateDto>, AppError> {
    Ok(state.tool_executor.get_tool_states())
}

/** Enable or disable a specific built-in tool. */
#[tauri::command]
pub async fn set_builtin_tool_enabled(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<bool, AppError> {
    let previous_enabled = state
        .tool_executor
        .get_tool_states()
        .into_iter()
        .find(|tool| tool.name == name)
        .map(|tool| tool.enabled)
        .ok_or_else(|| AppError::not_found(&format!("Tool not found: {name}")))?;

    let found = state.tool_executor.set_tool_enabled(&name, enabled);
    if !found {
        return Err(AppError::not_found(&format!("Tool not found: {name}")));
    }

    let disabled_tools = state.tool_executor.disabled_tool_names();
    let value_json = serde_json::to_string(&disabled_tools)
        .map_err(|error| AppError::db_error("Failed to serialize built-in tool settings").with_details(error.to_string()))?;

    if let Err(error) = crate::repositories::app_kv::set(
        &state.db,
        BUILTIN_DISABLED_TOOLS_KV_KEY,
        &value_json,
    )
    .await
    {
        let _ = state.tool_executor.set_tool_enabled(&name, previous_enabled);
        return Err(AppError::from(error));
    }

    tracing::info!(
        cmd = "set_builtin_tool_enabled",
        tool = %name,
        enabled,
        "ok"
    );
    Ok(true)
}

/**
 * Start a provider-backed model stream and forward normalized events over IPC.
 *
 * When the model requests tool calls, this command enters the ReAct Loop:
 * it executes tools, appends results to the prompt, and re-invokes the model
 * automatically until a normal completion or max iterations.
 */
#[tauri::command]
pub async fn start_model_stream(
    state: State<'_, AppState>,
    input: StartModelStreamInput,
    channel: Channel<ModelStreamEventDto>,
) -> Result<(), AppError> {
    let start = std::time::Instant::now();
    let request_id = input.request_id.clone();
    let provider_id = input.provider_id.clone();
    let model_id = input.model_id.clone();

    let mut active_streams = state.active_model_streams.lock().await;
    if let Some(active_request_id) = active_streams.keys().next().cloned() {
        let message = if active_request_id == request_id {
            "A stream with the same requestId is already active".to_string()
        } else {
            format!("Another model stream is already active: {active_request_id}")
        };
        let _ = channel.send(ModelStreamEventDto::Failed {
            request_id: request_id.clone(),
            code: "STREAM_ALREADY_ACTIVE".to_string(),
            message,
            retriable: true,
        });
        drop(active_streams);
        release_pending_model_stream_gate(&state, &request_id).await;
        return Ok(());
    }

    let (cancel_tx, cancel_rx) = watch::channel(false);
    active_streams.insert(request_id.clone(), cancel_tx);
    drop(active_streams);
    release_pending_model_stream_gate(&state, &request_id).await;

    let resolved = match model_stream_service::resolve_stream_request(
        &state.db,
        state.key_store.as_ref(),
        &input,
    )
    .await
    {
        Ok(resolved) => {
            tracing::info!(
                cmd = "start_model_stream",
                request_id = %request_id,
                provider_id = %provider_id,
                model_id = %model_id,
                tools_count = resolved.tools.len(),
                tool_choice = ?resolved.tool_choice,
                "stream_resolved"
            );
            resolved
        }
        Err(failure) => {
            state.active_model_streams.lock().await.remove(&request_id);
            let _ = channel.send(failure.to_event(&request_id));
            tracing::warn!(
                cmd = "start_model_stream",
                request_id = %request_id,
                provider_id = %provider_id,
                model_id = %model_id,
                error_code = %failure.code,
                message = %failure.message,
                duration_ms = start.elapsed().as_millis() as u64,
                "validation_failed"
            );
            return Ok(());
        }
    };

    // Run the ReAct Loop
    let tool_limits = state.tool_limits.lock().await.clone();
    let result = run_react_loop(
        &state,
        resolved,
        &channel,
        cancel_rx,
        tool_limits.max_iterations,
        tool_limits.max_consecutive_failures,
        tool_limits.approval_timeout_secs,
        tool_limits.tool_execution_timeout_secs,
    )
    .await;

    state.active_model_streams.lock().await.remove(&request_id);

    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(ReactLoopOutcome::Completed {
            usage,
            reasoning_content,
        }) => {
            let _ = channel.send(ModelStreamEventDto::Completed {
                request_id: request_id.clone(),
                usage,
                finish_reason: Some("stop".to_string()),
                tool_calls: None,
                reasoning_content,
            });
            tracing::info!(
                cmd = "start_model_stream",
                request_id = %request_id,
                duration_ms,
                "react_completed"
            );
        }
        Ok(ReactLoopOutcome::Cancelled) => {
            tracing::info!(
                cmd = "start_model_stream",
                request_id = %request_id,
                duration_ms,
                "react_cancelled"
            );
        }
        Err(failure) => {
            let _ = channel.send(failure.to_event(&request_id));
            tracing::warn!(
                cmd = "start_model_stream",
                request_id = %request_id,
                error_code = %failure.code,
                message = %failure.message,
                duration_ms,
                "react_failed"
            );
        }
    }

    Ok(())
}

/**
 * Request cancellation of an active model stream.
 *
 * Missing request IDs are treated as no-ops because the stream may have just
 * completed or failed locally before the abort request reached the backend.
 */
#[tauri::command]
pub async fn abort_model_stream(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), AppError> {
    release_pending_model_stream_gate(&state, &request_id).await;

    let sender = {
        let active_streams = state.active_model_streams.lock().await;
        active_streams.get(&request_id).cloned()
    };

    if let Some(sender) = sender {
        let _ = sender.send(true);
    }

    tracing::info!(cmd = "abort_model_stream", request_id = %request_id, "ok");
    Ok(())
}

async fn release_pending_model_stream_gate(state: &State<'_, AppState>, request_id: &str) {
    let mut pending = state.pending_model_stream.lock().await;
    if pending
        .as_ref()
        .map_or(false, |existing| existing.request_id == request_id)
    {
        *pending = None;
    }
}

// ============================================================================
// ReAct Loop
// ============================================================================

/** Terminal outcome of the ReAct Loop. */
enum ReactLoopOutcome {
    Completed {
        usage: Option<crate::dto::common::TokenUsageDto>,
        reasoning_content: Option<String>,
    },
    Cancelled,
}

use crate::services::model_stream_service::ModelStreamFailure;

/**
 * Execute the ReAct Loop: stream → tool_calls → execute → stream → ...
 *
 * The loop accumulates prompt messages as tool calls and results are added.
 * On each iteration, the full conversation history (including prior tool
 * interactions) is re-sent to the model.
 *
 * Termination conditions:
 *   - Model responds with a normal completion (finish_reason != "tool_calls")
 *   - Model responds with no tool_calls
 *   - Max iterations exceeded (forces a Completed event)
 *   - Cancellation requested via cancel_rx
 *   - Stream error from provider
 */

/** Execute a tool by name, routing to MCP if it has the `mcp__` prefix. */
async fn execute_tool_with_mcp(
    state: &State<'_, AppState>,
    tool_name: &str,
    arguments: &str,
    context: ToolExecutionContext,
) -> ToolExecutionResult {
    // Legacy tool name compatibility: route old tool names to new unified tools
    let (resolved_name, rewritten_args) = match tool_name {
        "file_read" | "file_write" | "file_list" | "grep" => {
            let action = match tool_name {
                "file_read" => "read",
                "file_write" => "write",
                "file_list" => "list",
                "grep" => "search",
                _ => unreachable!(),
            };
            let mut args: Value = serde_json::from_str(arguments).unwrap_or(json!({}));
            if let Some(obj) = args.as_object_mut() {
                obj.insert("action".to_string(), Value::String(action.to_string()));
            }
            ("file".to_string(), serde_json::to_string(&args).unwrap_or_else(|_| arguments.to_string()))
        }
        "todo_read" | "todo_write" => {
            let action = if tool_name == "todo_read" { "read" } else { "write" };
            let mut args: Value = serde_json::from_str(arguments).unwrap_or(json!({}));
            if let Some(obj) = args.as_object_mut() {
                obj.insert("action".to_string(), Value::String(action.to_string()));
            }
            ("todo".to_string(), serde_json::to_string(&args).unwrap_or_else(|_| arguments.to_string()))
        }
        _ => (tool_name.to_string(), arguments.to_string()),
    };

    // Try built-in executor first
    let result = state
        .tool_executor
        .execute_with_context(&resolved_name, &rewritten_args, context)
        .await;

    if result.success || !result.output.starts_with("Unknown tool:") {
        return result;
    }

    // Check for MCP namespace prefix: mcp__{server}__{tool}
    if let Some(rest) = tool_name.strip_prefix("mcp__") {
        let parts: Vec<&str> = rest.splitn(2, "__").collect();
        if parts.len() == 2 {
            let server_name = parts[0];
            let mcp_tool_name = parts[1];
            let enabled = crate::repositories::mcp_servers::list_all(&state.db)
                .await
                .unwrap_or_default()
                .into_iter()
                .find(|row| row.name == server_name)
                .map(|row| row.enabled)
                .unwrap_or(false);
            if !enabled {
                return ToolExecutionResult {
                    success: false,
                    output: format!("MCP server is disabled or unknown: {}", server_name),
                };
            }
            tracing::info!(
                server = server_name,
                tool = mcp_tool_name,
                "routing tool call to MCP server"
            );
            let args: serde_json::Value =
                serde_json::from_str(arguments).unwrap_or(serde_json::json!({}));
            let mut manager = state.mcp_manager.lock().await;
            match tokio::time::timeout(
                Duration::from_secs(TOOL_EXECUTION_TIMEOUT_SECONDS),
                manager.call_tool(server_name, mcp_tool_name, args),
            )
            .await
            {
                Ok(Ok(output)) => ToolExecutionResult {
                    success: true,
                    output,
                },
                Ok(Err(e)) => ToolExecutionResult {
                    success: false,
                    output: format!("MCP tool error ({}): {}", tool_name, e),
                },
                Err(_) => ToolExecutionResult {
                    success: false,
                    output: format!(
                        "MCP tool timed out after {} seconds: {}",
                        TOOL_EXECUTION_TIMEOUT_SECONDS, tool_name
                    ),
                },
            }
        } else {
            ToolExecutionResult {
                success: false,
                output: format!("Invalid MCP tool name format: {}", tool_name),
            }
        }
    } else {
        result
    }
}

fn requires_tool_approval(
    function_name: &str,
    arguments: &str,
    policy: &crate::state::SecurityPolicy,
) -> bool {
    use crate::state::SecurityLevel;

    // MCP tools always require approval
    if function_name.starts_with("mcp__") {
        return true;
    }

    // Resolve legacy tool names so approval checks work for old names too
    let resolved_name = resolve_legacy_tool_name(function_name);

    match resolved_name.as_str() {
        "file" => {
            let args: Value = match serde_json::from_str(arguments) {
                Ok(v) => v,
                Err(_) => return true, // Fail-safe: require approval on parse failure
            };
            let action = args.get("action").and_then(|a| a.as_str()).unwrap_or("");
            if action != "write" {
                return false;
            }
            // File write — check level and blacklist
            match policy.level {
                SecurityLevel::Permissive => {
                    matches_blacklist(args.get("path").and_then(|p| p.as_str()).unwrap_or(""), &policy.file_write_blacklist)
                }
                SecurityLevel::Standard => true, // All file writes require approval in Standard
                SecurityLevel::Strict => true,
            }
        }
        "terminal" => {
            let args: Value = match serde_json::from_str(arguments) {
                Ok(v) => v,
                Err(_) => return true, // Fail-safe: require approval on parse failure
            };
            let command = args.get("command").and_then(|c| c.as_str()).unwrap_or("");
            match policy.level {
                SecurityLevel::Permissive => {
                    matches_blacklist(command, &policy.terminal_blacklist)
                }
                SecurityLevel::Standard => {
                    matches_blacklist(command, &policy.terminal_blacklist)
                }
                SecurityLevel::Strict => true,
            }
        }
        _ => false,
    }
}

fn matches_blacklist(text: &str, patterns: &[String]) -> bool {
    for pattern in patterns {
        match regex::Regex::new(pattern) {
            Ok(re) => {
                if re.is_match(text) {
                    return true;
                }
            }
            Err(err) => {
                // Fail-closed: invalid regex pattern treated as match for safety
                tracing::warn!(
                    pattern = %pattern,
                    error = %err,
                    "invalid regex in blacklist, treating as match for safety"
                );
                return true;
            }
        }
    }
    false
}

/** Resolve legacy tool names to their current unified equivalents. */
fn resolve_legacy_tool_name(tool_name: &str) -> String {
    match tool_name {
        "file_read" | "file_write" | "file_list" | "grep" => "file".to_string(),
        "todo_read" | "todo_write" => "todo".to_string(),
        _ => tool_name.to_string(),
    }
}

async fn execute_tool_checked(
    state: &State<'_, AppState>,
    allowed_tool_names: &HashSet<String>,
    tool_name: &str,
    arguments: &str,
    context: ToolExecutionContext,
    cancel_rx: &watch::Receiver<bool>,
    default_timeout_secs: u64,
) -> Result<ToolExecutionResult, ReactLoopOutcome> {
    // Resolve legacy tool names before the allowed-set check so old names like
    // file_read/file_write are accepted when the unified "file" tool is enabled.
    let resolved_name = resolve_legacy_tool_name(tool_name);
    if !allowed_tool_names.contains(&resolved_name) && !allowed_tool_names.contains(tool_name) {
        return Ok(ToolExecutionResult {
            success: false,
            output: format!("Tool is not enabled for this stream: {tool_name}"),
        });
    }

    // Extract per-call timeout from tool arguments if provided; otherwise use the
    // configured default. Models can pass {"timeout": 120} to request a longer
    // execution window for commands that are known to take time.
    let per_call_timeout: u64 = serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|v| v.get("timeout").and_then(Value::as_u64))
        .unwrap_or(default_timeout_secs)
        .max(10)           // at least 10 seconds
        .min(600);         // hard ceiling of 10 minutes

    let mut cancel_rx = cancel_rx.clone();
    tokio::select! {
        result = execute_tool_with_mcp(state, tool_name, arguments, context) => Ok(result),
        _ = tokio::time::sleep(Duration::from_secs(per_call_timeout)) => Ok(ToolExecutionResult {
            success: false,
            output: format!("Tool execution timed out after {} seconds: {}", per_call_timeout, tool_name),
        }),
        changed = cancel_rx.changed() => {
            if changed.is_ok() && *cancel_rx.borrow() {
                Err(ReactLoopOutcome::Cancelled)
            } else {
                Ok(ToolExecutionResult {
                    success: false,
                    output: "Tool execution interrupted by stream state change".to_string(),
                })
            }
        }
    }
}

// ============================================================================
// Mid-loop Context Compression
// ============================================================================

/// Result of a mid-loop context compression pass.
struct MidLoopCompressInfo {
    trimmed_groups: u32,
    tokens_saved: u32,
    new_ratio: f32,
    prompt_messages: Vec<ModelPromptMessageDto>,
}

fn is_system_role(role: &str) -> bool {
    role == "system" || role == "SYSTEM"
}

/// Prune old tool_result content in prompt messages. Inspired by opencode's
/// prune() which truncates old tool outputs beyond a token budget, keeping
/// recent tool outputs intact.
///
/// Strategy: for TOOL-role messages that are not in the last 2 turns, truncate
/// content to MAX_PRUNED_TOOL_CHARS characters. This saves thousands of tokens
/// from verbose tool outputs (e.g., file reads, shell output) without losing
/// the essential information for continuation.
const MAX_PRUNED_TOOL_CHARS: usize = 2000;
const PRUNE_PROTECT_RECENT_MESSAGES: usize = 6;

fn prune_old_tool_results(prompt_messages: &mut [ModelPromptMessageDto], iteration: u32) {
    // Only prune after the first iteration to allow initial context to be complete
    if iteration == 0 {
        return;
    }

    let total = prompt_messages.len();
    let protect_from = total.saturating_sub(PRUNE_PROTECT_RECENT_MESSAGES);
    let mut pruned_count = 0;

    for i in 0..protect_from {
        let msg = &mut prompt_messages[i];
        if msg.role != "TOOL" {
            continue;
        }
        if msg.content.len() <= MAX_PRUNED_TOOL_CHARS {
            continue;
        }
        let truncated: String = msg.content.chars().take(MAX_PRUNED_TOOL_CHARS).collect();
        msg.content = format!("{}\n\n[... output truncated ({} chars total) ...]", truncated, msg.content.len());
        pruned_count += 1;
    }

    if pruned_count > 0 {
        tracing::info!(
            iteration,
            pruned_count,
            protected_recent = total - protect_from,
            "prune_old_tool_results: truncated old tool outputs"
        );
    }
}

fn is_compressed_context_message(msg: &ModelPromptMessageDto) -> bool {
    msg.source_message_id.is_none()
        && is_system_role(&msg.role)
        && msg.content.starts_with("[Compressed Context Summary]")
}

/// Deterministic budget trimming: drop oldest non-system messages from the
/// prompt until estimated tokens fall within `budget`. System prefix messages
/// (those without source_message_id) are always preserved. The most recent
/// messages are also preserved to maintain conversation coherence.
fn apply_deterministic_budget_trim(
    prompt_messages: &[ModelPromptMessageDto],
    budget: u32,
    tools: &[ToolDefinitionDto],
) -> Vec<ModelPromptMessageDto> {
    let current_tokens = crate::services::token_estimator::estimate_model_request_tokens(
        prompt_messages,
        tools,
    );
    if current_tokens <= budget {
        return prompt_messages.to_vec();
    }

    // Find the boundary between system prefix and conversation messages
    let system_prefix_end = prompt_messages
        .iter()
        .position(|msg| msg.source_message_id.is_some())
        .unwrap_or(prompt_messages.len());

    // Identify safe cut points in the conversation portion.
    // A safe cut point is an index AFTER which we can start keeping messages
    // without breaking tool_call → tool_result sequence integrity.
    //
    // Safe cuts:
    //   1. After a `user` message
    //   2. After an `assistant` message with NO tool_calls (text-only)
    //   3. After the LAST tool result that completes an assistant's tool_calls
    //      (this is critical for multi-turn tool call conversations where
    //       almost all messages are assistant+tool pairs)
    let conversation_messages = &prompt_messages[system_prefix_end..];
    let mut safe_cut_indices: Vec<usize> = Vec::new();
    let mut pending_tool_ids: Vec<String> = Vec::new();

    for (i, msg) in conversation_messages.iter().enumerate() {
        let role = msg.role.to_lowercase();
        if role == "assistant" {
            // Before processing a new assistant message, any previously pending
            // tool_calls are fully answered — the cut before this assistant is safe.
            if !pending_tool_ids.is_empty() {
                safe_cut_indices.push(i);
                pending_tool_ids.clear();
            }
            // Track new tool_calls from this assistant
            if let Some(tcs) = msg.tool_calls.as_ref() {
                for tc in tcs {
                    let id = tc.id.trim().to_string();
                    if !id.is_empty() {
                        pending_tool_ids.push(id);
                    }
                }
            } else {
                // Text-only assistant — safe cut after it
                safe_cut_indices.push(i + 1);
            }
        } else if role == "user" {
            // Any pending tool_calls should have been answered — cut before user
            if !pending_tool_ids.is_empty() {
                safe_cut_indices.push(i);
                pending_tool_ids.clear();
            }
            safe_cut_indices.push(i + 1); // cut AFTER this user message
        } else if role == "tool" {
            // Remove the matching tool_call_id from pending
            if let Some(ref tc_id) = msg.tool_call_id {
                let id = tc_id.trim().to_string();
                pending_tool_ids.retain(|pending| pending != &id);
            }
            // If all pending tool_calls are now answered, the cut AFTER this
            // tool message is safe (complete tool sequence).
            if pending_tool_ids.is_empty() {
                safe_cut_indices.push(i + 1);
            }
        }
    }

    if safe_cut_indices.is_empty() {
        // No safe cut point found — fall back to preserving everything
        tracing::warn!(
            "apply_deterministic_budget_trim: no safe cut points found, keeping all messages"
        );
        return prompt_messages.to_vec();
    }

    // Preserve at least the last 6 messages (3 turns) for coherence
    let preserve_recent = 6;
    let min_start = conversation_messages.len().saturating_sub(preserve_recent);

    let tool_tokens = crate::services::token_estimator::estimate_tool_definitions_tokens(tools);
    let available_for_messages = budget.saturating_sub(tool_tokens);

    // Find the earliest safe cut that brings us within budget,
    // but never cut past min_start
    let mut chosen_start = 0usize;
    let mut found_valid = false;

    for &cut_idx in &safe_cut_indices {
        if cut_idx > min_start {
            break;
        }
        // Estimate tokens from cut_idx to end
        let tokens_from_here: u32 = conversation_messages[cut_idx..]
            .iter()
            .map(|m| crate::services::token_estimator::estimate_dto_message_tokens(m))
            .sum();
        if tokens_from_here <= available_for_messages {
            chosen_start = cut_idx;
            found_valid = true;
            break;
        }
        // If the largest safe cut still exceeds budget, use the latest one before min_start
        chosen_start = cut_idx;
    }

    if !found_valid && chosen_start == 0 {
        // Even the last safe cut before min_start doesn't fit — use the latest
        // safe cut that's as close to min_start as possible
        chosen_start = safe_cut_indices
            .iter()
            .copied()
            .filter(|&idx| idx <= min_start)
            .last()
            .unwrap_or(0);
    }

    let mut result: Vec<ModelPromptMessageDto> = Vec::new();
    // Always keep system prefix
    for msg in &prompt_messages[..system_prefix_end] {
        result.push(msg.clone());
    }
    // Keep conversation messages from chosen_start
    for msg in &conversation_messages[chosen_start..] {
        result.push(msg.clone());
    }

    let new_tokens = crate::services::token_estimator::estimate_model_request_tokens(&result, tools);
    tracing::info!(
        old_count = prompt_messages.len(),
        new_count = result.len(),
        old_tokens = current_tokens,
        new_tokens,
        budget,
        chosen_start,
        safe_cuts = safe_cut_indices.len(),
        "apply_deterministic_budget_trim: trimmed prompt (tool-sequence-safe)"
    );

    result
}

fn apply_compressed_context_to_runtime_prompt(
    prompt_messages: &[ModelPromptMessageDto],
    summary_text: &str,
    compressed_source_ids: &HashSet<String>,
) -> Vec<ModelPromptMessageDto> {
    let mut next = Vec::with_capacity(prompt_messages.len().saturating_add(1));
    let mut index = 0usize;

    // Keep leading synthetic system prompts stable for prompt-cache friendliness,
    // but replace any older compressed summary with the newly persisted one.
    while let Some(msg) = prompt_messages.get(index) {
        if !(msg.source_message_id.is_none() && is_system_role(&msg.role)) {
            break;
        }
        if !is_compressed_context_message(msg) {
            next.push(msg.clone());
        }
        index += 1;
    }

    if !summary_text.trim().is_empty() {
        next.push(ModelPromptMessageDto {
            source_message_id: None,
            role: "system".to_string(),
            content: format!("[Compressed Context Summary]\n{}", summary_text.trim()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
        });
    }

    for msg in prompt_messages.iter().skip(index) {
        if is_compressed_context_message(msg) {
            continue;
        }
        if msg
            .source_message_id
            .as_ref()
            .is_some_and(|id| compressed_source_ids.contains(id))
        {
            continue;
        }
        next.push(msg.clone());
    }

    next
}

/**
 * Lightweight mid-loop context compression.
 *
 * Unlike the full `compress_context` (which calls a helper AI model), this
 * function performs rule-based pruning: it scores prompt messages using the
 * importance scorer, identifies low-value groups, and trims them from the
 * front of the prompt to free space for the next iteration.
 *
 * This is intentionally synchronous (no AI call) to minimize latency within
 * the ReAct loop. The full AI-powered compression happens at the end of the
 * turn when `compress_context` is called from the frontend.
 *
 * The trimming only removes messages from the prompt array in-memory; the
 * actual persisted messages in the database are not affected. The next call
 * to `build_prompt_messages` will reconstruct the prompt from the database
 * with the correct compressed context summary.
 */
async fn mid_loop_compress(
    state: &State<'_, AppState>,
    conversation_id: &str,
    branch_id: &str,
    model_id: &str,
    prompt_messages: &[ModelPromptMessageDto],
    tools: &[ToolDefinitionDto],
    effective_budget: u32,
    _trigger_threshold: u32,
) -> Result<Option<MidLoopCompressInfo>, AppError> {
    // Try the full AI-powered compression via helper_ai_service. The summary is
    // persisted for the active branch and then applied to this in-flight prompt.
    let compress_result = crate::services::helper_ai_service::compress_context(
        state,
        conversation_id,
        branch_id,
        model_id,
    )
    .await;

    match compress_result {
        Ok(result) => {
            let compressed_source_ids: HashSet<String> = crate::repositories::compressed_contexts::find_latest_by_branch(
                &state.db,
                conversation_id,
                branch_id,
            )
            .await
            .map_err(AppError::from)?
            .and_then(|row| serde_json::from_str::<Vec<String>>(&row.compressed_message_ids).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();

            if compressed_source_ids.is_empty() {
                tracing::warn!(
                    conversation_id = %conversation_id,
                    branch_id = %branch_id,
                    "mid_loop_compress: persisted summary has no source ids"
                );
                return Ok(None);
            }

            let old_tokens = crate::services::token_estimator::estimate_model_request_tokens(
                prompt_messages,
                tools,
            );
            let next_prompt_messages = apply_compressed_context_to_runtime_prompt(
                prompt_messages,
                &result.summary_text,
                &compressed_source_ids,
            );
            let new_tokens = crate::services::token_estimator::estimate_model_request_tokens(
                &next_prompt_messages,
                tools,
            );
            let tokens_saved = old_tokens.saturating_sub(new_tokens);

            if tokens_saved == 0 && next_prompt_messages.len() >= prompt_messages.len() {
                tracing::warn!(
                    conversation_id = %conversation_id,
                    branch_id = %branch_id,
                    old_tokens,
                    new_tokens,
                    "mid_loop_compress: compression produced no in-flight token savings"
                );
                return Ok(None);
            }

            let new_ratio = if effective_budget > 0 {
                new_tokens as f32 / effective_budget as f32
            } else {
                0.0
            };
            Ok(Some(MidLoopCompressInfo {
                trimmed_groups: result.compressed_message_count,
                tokens_saved,
                new_ratio,
                prompt_messages: next_prompt_messages,
            }))
        }
        Err(e) => {
            if is_expected_compression_noop(&e) {
                tracing::info!(
                    reason = %e.message,
                    "mid_loop_compress: AI compression skipped"
                );
                return Ok(None);
            }
            // AI compression failed — fall back to deterministic budget trimming.
            // Unlike the budget check in `apply_deterministic_budget_trim` itself
            // (which returns early if within budget), we always run the trim here
            // because compression was already triggered at the 60% threshold.
            // Without this, the prompt can keep growing between 60%–100% with no
            // effective compression, eventually overflowing and breaking tool
            // message sequences.
            tracing::warn!(
                error = %e.message,
                "mid_loop_compress: AI compression failed, applying deterministic fallback"
            );
            let old_tokens = crate::services::token_estimator::estimate_model_request_tokens(
                prompt_messages,
                tools,
            );
            // Trim towards 70% of effective budget to create headroom for
            // upcoming tool call iterations.  Without this margin, each tool
            // result immediately pushes the prompt back over 100%.
            let target_budget = (effective_budget as f32 * 0.70) as u32;
            let trimmed = apply_deterministic_budget_trim(prompt_messages, target_budget, tools);
            let new_tokens = crate::services::token_estimator::estimate_model_request_tokens(
                &trimmed,
                tools,
            );
            let tokens_saved = old_tokens.saturating_sub(new_tokens);
            if tokens_saved == 0 {
                return Ok(None);
            }
            let new_ratio = if effective_budget > 0 {
                new_tokens as f32 / effective_budget as f32
            } else {
                0.0
            };
            Ok(Some(MidLoopCompressInfo {
                trimmed_groups: 0,
                tokens_saved,
                new_ratio,
                prompt_messages: trimmed,
            }))
        }
    }
}

async fn maybe_compress_react_prompt(
    state: &State<'_, AppState>,
    request_id: &str,
    iteration: u32,
    model_id: &str,
    conversation_id: &Option<String>,
    branch_id: &Option<String>,
    prompt_messages: &mut Vec<ModelPromptMessageDto>,
    tools: &[ToolDefinitionDto],
    context_budget_tokens: u32,
    effective_input_budget: u32,
    compression_trigger_tokens: u32,
    channel: &Channel<ModelStreamEventDto>,
) {
    // Layer 0: Prune — truncate verbose tool_result content in older messages.
    // This is a zero-cost, deterministic operation that doesn't require AI calls.
    // Inspired by opencode's prune() which truncates old tool outputs to save tokens.
    prune_old_tool_results(prompt_messages, iteration);

    let prompt_tokens = crate::services::token_estimator::estimate_model_request_tokens(
        prompt_messages,
        tools,
    );
    let msg_tokens: u32 = prompt_messages
        .iter()
        .map(crate::services::token_estimator::estimate_dto_message_tokens)
        .sum();
    let tool_def_tokens = crate::services::token_estimator::estimate_tool_definitions_tokens(tools);

    tracing::info!(
        request_id = %request_id,
        iteration,
        prompt_tokens,
        msg_tokens,
        tool_def_tokens,
        trigger_threshold = compression_trigger_tokens,
        effective_budget = effective_input_budget,
        msg_count = prompt_messages.len(),
        "react loop: context budget check"
    );

    let context_percentage = if context_budget_tokens > 0 {
        (prompt_tokens as f32 / context_budget_tokens as f32) * 100.0
    } else {
        0.0
    };
    let _ = channel.send(ModelStreamEventDto::ContextStatusUpdated {
        request_id: request_id.to_string(),
        used_tokens: prompt_tokens,
        total_tokens: context_budget_tokens,
        percentage: if context_percentage.is_finite() { context_percentage } else { 0.0 },
        message_count: prompt_messages.len() as u32,
    });

    if prompt_tokens < compression_trigger_tokens || effective_input_budget == 0 {
        return;
    }

    let usage_ratio = prompt_tokens as f32 / effective_input_budget as f32;
    let compression_level = crate::services::importance_scorer::CompressionLevel::from_usage_ratio(usage_ratio);
    if compression_level == crate::services::importance_scorer::CompressionLevel::None {
        return;
    }

    let Some(conv_id) = conversation_id.as_deref() else {
        tracing::warn!(
            request_id = %request_id,
            prompt_tokens,
            "react loop: context compression skipped because conversation_id is missing"
        );
        return;
    };
    let Some(branch_id) = branch_id.as_deref() else {
        tracing::warn!(
            request_id = %request_id,
            prompt_tokens,
            "react loop: context compression skipped because branch_id is missing"
        );
        return;
    };

    tracing::info!(
        request_id = %request_id,
        prompt_tokens,
        effective_input_budget,
        usage_ratio = format!("{:.2}", usage_ratio),
        level = ?compression_level,
        "react loop: mid-loop context compression triggered"
    );

    let _ = channel.send(ModelStreamEventDto::ContextCompressing {
        request_id: request_id.to_string(),
        level: match compression_level {
            crate::services::importance_scorer::CompressionLevel::Level1 => 1,
            crate::services::importance_scorer::CompressionLevel::Level2 => 2,
            crate::services::importance_scorer::CompressionLevel::Level3 => 3,
            _ => 0,
        },
        usage_ratio,
    });

    match mid_loop_compress(
        state,
        conv_id,
        branch_id,
        model_id,
        prompt_messages,
        tools,
        effective_input_budget,
        compression_trigger_tokens,
    )
    .await
    {
        Ok(Some(info)) => {
            let compressed_count = info.trimmed_groups;
            let tokens_saved = info.tokens_saved;
            let new_usage_ratio = info.new_ratio;
            *prompt_messages = info.prompt_messages;
            tracing::info!(
                request_id = %request_id,
                compressed_count,
                tokens_saved,
                new_usage_ratio = format!("{:.2}", new_usage_ratio),
                "react loop: mid-loop compression applied to in-flight prompt"
            );
            let _ = channel.send(ModelStreamEventDto::ContextCompressed {
                request_id: request_id.to_string(),
                compressed_count,
                tokens_saved,
                new_usage_ratio,
            });
        }
        Ok(None) => {
            tracing::info!(
                request_id = %request_id,
                "react loop: mid-loop compression skipped (no effective savings)"
            );
            let _ = channel.send(ModelStreamEventDto::ContextCompressionSkipped {
                request_id: request_id.to_string(),
                reason: "NO_EFFECTIVE_SAVINGS".to_string(),
                usage_ratio,
            });
        }
        Err(e) => {
            let reason = e.message.clone();
            tracing::warn!(
                request_id = %request_id,
                error = %reason,
                "react loop: mid-loop compression failed, continuing with full prompt"
            );
            let _ = channel.send(ModelStreamEventDto::ContextCompressionSkipped {
                request_id: request_id.to_string(),
                reason,
                usage_ratio,
            });
        }
    }
}

async fn stream_final_response_without_tools(
    initial_request: &ResolvedModelStreamRequest,
    prompt_messages: Vec<ModelPromptMessageDto>,
    channel: &Channel<ModelStreamEventDto>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<ReactLoopOutcome, ModelStreamFailure> {
    let final_request = ResolvedModelStreamRequest {
        request_id: initial_request.request_id.clone(),
        provider_type: initial_request.provider_type.clone(),
        provider_profile: initial_request.provider_profile,
        base_url: initial_request.base_url.clone(),
        api_key: initial_request.api_key.clone(),
        model_id: initial_request.model_id.clone(),
        request_model_name: initial_request.request_model_name.clone(),
        prompt_messages,
        generation_params: initial_request.generation_params.clone(),
        tools: vec![],
        tool_choice: None,
        conversation_id: initial_request.conversation_id.clone(),
        branch_id: initial_request.branch_id.clone(),
        workspace_path: initial_request.workspace_path.clone(),
        activated_skill: initial_request.activated_skill.clone(),
    };

    match model_stream_service::stream_model_response(&final_request, channel, cancel_rx).await {
        Ok(ModelStreamOutcome::Completed {
            usage,
            reasoning_content,
        }) => Ok(ReactLoopOutcome::Completed {
            usage,
            reasoning_content,
        }),
        Ok(ModelStreamOutcome::Cancelled) => Ok(ReactLoopOutcome::Cancelled),
        Ok(ModelStreamOutcome::ToolCallsRequested { .. }) => {
            // Empty tool list should force text. If a provider still reports a
            // tool-call finish, complete locally to avoid an illegal tool turn.
            Ok(ReactLoopOutcome::Completed {
                usage: None,
                reasoning_content: None,
            })
        }
        Err(error) => Err(error),
    }
}

async fn run_react_loop(
    state: &State<'_, AppState>,
    initial_request: ResolvedModelStreamRequest,
    channel: &Channel<ModelStreamEventDto>,
    mut cancel_rx: watch::Receiver<bool>,
    max_iterations: u32,
    max_consecutive_failures: u32,
    approval_timeout_secs: u32,
    tool_execution_timeout_secs: u64,
) -> Result<ReactLoopOutcome, ModelStreamFailure> {
    let request_id = initial_request.request_id.clone();
    let conversation_id = initial_request.conversation_id.clone();
    let branch_id = initial_request.branch_id.clone();
    let model_id = initial_request.model_id.clone();
    let mut prompt_messages = initial_request.prompt_messages.clone();
    let current_tools = build_backend_enabled_tool_definitions(state).await;
    let allowed_tool_names: HashSet<String> = current_tools
        .iter()
        .map(|tool| tool.function.name.clone())
        .collect();
    let current_tool_choice = initial_request.tool_choice.clone();

    // Resolve context window size for mid-loop compression checks.
    let context_window_kb: i32 = crate::repositories::provider_models::find_by_id(&state.db, &model_id)
        .await
        .ok()
        .flatten()
        .map(|m| m.context_window_kb)
        .unwrap_or(64);
    let context_budget_tokens = (context_window_kb.max(8) as u32) * 1000;
    // Reserve ~8K tokens for model output + safety margin
    let output_reservation: u32 = 8_000;
    let effective_input_budget = context_budget_tokens.saturating_sub(output_reservation);
    // Compression trigger threshold: 60% of effective budget
    let compression_trigger_tokens = (effective_input_budget as f32 * 0.60) as u32;

    let shell_path = crate::repositories::app_kv::get(&state.db, "shell_path")
        .await
        .ok()
        .flatten()
        .map(|raw| serde_json::from_str::<String>(&raw).unwrap_or_else(|_| raw.trim_matches('"').to_string()))
        .filter(|s| !s.is_empty());
    let tool_context = ToolExecutionContext {
        conversation_id: conversation_id.clone(),
        workspace_path: initial_request.workspace_path.clone(),
        shell_path,
        skills_dir: state.app_handle.path().app_data_dir().ok().map(|p| {
            crate::services::skill_fs::skills_root_from_app_data(&p).to_string_lossy().to_string()
        }),
    };
    let mut consecutive_tool_failures = 0u32;

    // Set todo conversation context for scoped storage
    crate::services::tool_executor::set_todo_conversation_id(conversation_id.clone());

    // Ensure todo context is cleared when the loop exits
    let _todo_guard = scopeguard::guard((), |_| {
        crate::services::tool_executor::set_todo_conversation_id(None);
    });

    // Inject tool usage guidance when tools are available
    if !current_tools.is_empty() {
        let tool_names: Vec<&str> = current_tools.iter().map(|t| t.function.name.as_str()).collect();
        let mut guidance_parts: Vec<String> = Vec::new();

        guidance_parts.push("You have access to tools. Use them proactively when they can help answer the user's request more accurately or efficiently.".to_string());

        if tool_names.iter().any(|n| *n == "todo") {
            guidance_parts.push("When the user's request involves multiple steps or a complex task, proactively use the todo tool (action=write) to create a todo list first, then work through each item and update statuses as you progress. This helps track progress and ensures nothing is missed.".to_string());
        }

        if tool_names.iter().any(|n| *n == "file") {
            guidance_parts.push("When asked about files or code, use file tools to read actual file contents rather than guessing. Always verify information by reading the files first.".to_string());
        }

        if tool_names.iter().any(|n| *n == "terminal") {
            let mut terminal_guidance = String::from(
                "IMPORTANT: This is a local desktop environment, NOT a container or sandbox. ",
            );
            if let Some(ref ws) = initial_request.workspace_path {
                terminal_guidance.push_str(&format!(
                    "The current working directory is '{}'. ",
                    ws.replace('\\', "/"),
                ));
            }
            terminal_guidance.push_str(
                "Do NOT use /workspace as a path — that is a container convention and does not exist here. \
                 Always verify a directory exists before cd-ing into it (e.g., use 'ls DIR && cd DIR' or check with 'if exist DIR' on Windows). \
                 If a cd command fails, list available directories first before trying another path.",
            );
            guidance_parts.push(terminal_guidance);
        }

        if !guidance_parts.is_empty() {
            let guidance = guidance_parts.join(" ");
            // Prepend as system message or append to existing system message
            if let Some(first) = prompt_messages.first_mut() {
                if first.role == "system" || first.role == "SYSTEM" {
                    first.content.push_str("\n\n");
                    first.content.push_str(&guidance);
                } else {
                    prompt_messages.insert(0, ModelPromptMessageDto {
                        source_message_id: None,
                        role: "system".to_string(),
                        content: guidance,
                        reasoning_content: None,
                        tool_calls: None,
                        tool_call_id: None,
                        name: None,
                    });
                }
            } else {
                prompt_messages.insert(0, ModelPromptMessageDto {
                    source_message_id: None,
                    role: "system".to_string(),
                    content: guidance,
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                });
            }
        }

        // Inject skill metadata (Tier 1) and activation hint (Tier 3)
        if let Some(app_data) = state.app_handle.path().app_data_dir().ok() {
            let skills_dir = crate::services::skill_fs::skills_root_from_app_data(&app_data);
            let skills = crate::services::skill_fs::discover_skills(&skills_dir);

            if !skills.is_empty() {
                let skill_metadata = crate::services::skill_fs::build_skill_metadata_prompt(&skills);
                if let Some(first) = prompt_messages.first_mut() {
                    if first.role == "system" || first.role == "SYSTEM" {
                        first.content.push_str("\n\n");
                        first.content.push_str(&skill_metadata);
                    } else {
                        prompt_messages.insert(0, ModelPromptMessageDto {
                            source_message_id: None,
                            role: "system".to_string(),
                            content: skill_metadata,
                            reasoning_content: None,
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                        });
                    }
                }
            }

            // Tier 3: activation hint for slash command
            if let Some(ref skill_name) = initial_request.activated_skill {
                let hint = crate::services::skill_fs::build_skill_activation_hint(skill_name);
                if let Some(first) = prompt_messages.first_mut() {
                    if first.role == "system" || first.role == "SYSTEM" {
                        first.content.push_str("\n\n");
                        first.content.push_str(&hint);
                    }
                }
            }
        }
    }

    for iteration in 0..max_iterations {
        // Check cancellation
        if *cancel_rx.borrow() {
            return Ok(ReactLoopOutcome::Cancelled);
        }

        maybe_compress_react_prompt(
            state,
            &request_id,
            iteration,
            &model_id,
            &conversation_id,
            &branch_id,
            &mut prompt_messages,
            &current_tools,
            context_budget_tokens,
            effective_input_budget,
            compression_trigger_tokens,
            channel,
        )
        .await;

        // Build request for this iteration
        let request = ResolvedModelStreamRequest {
            request_id: request_id.clone(),
            provider_type: initial_request.provider_type.clone(),
            provider_profile: initial_request.provider_profile,
            base_url: initial_request.base_url.clone(),
            api_key: initial_request.api_key.clone(),
            model_id: initial_request.model_id.clone(),
            request_model_name: initial_request.request_model_name.clone(),
            prompt_messages: prompt_messages.clone(),
            generation_params: initial_request.generation_params.clone(),
            tools: current_tools.clone(),
            tool_choice: current_tool_choice.clone(),
            conversation_id: conversation_id.clone(),
            branch_id: branch_id.clone(),
            workspace_path: initial_request.workspace_path.clone(),
            activated_skill: initial_request.activated_skill.clone(),
        };
        // may choose not to call them. We keep tools in the request so
        // the model can chain multiple tool calls across iterations.

        // Stream the model response with automatic retry for retriable errors
        const MAX_RETRY_ATTEMPTS: u32 = 5;
        let mut last_failure: Option<ModelStreamFailure> = None;
        let mut outcome: Option<ModelStreamOutcome> = None;

        for retry_attempt in 0..=MAX_RETRY_ATTEMPTS {
            if retry_attempt > 0 {
                // Exponential backoff with jitter: ~2s, ~5s, ~10s, ~20s, ~30s
                let base_delay = 2u64.pow(retry_attempt.min(4));
                let jitter = (retry_attempt as u64) * 3;
                let delay_secs = (base_delay + jitter).min(30) as u32;
                let delay = Duration::from_secs(delay_secs as u64);

                let failure = last_failure.as_ref().unwrap();
                let _ = channel.send(ModelStreamEventDto::Retrying {
                    request_id: request_id.clone(),
                    attempt: retry_attempt,
                    max_attempts: MAX_RETRY_ATTEMPTS,
                    next_retry_in_secs: delay_secs,
                    error_summary: failure.message.chars().take(200).collect(),
                });

                tokio::select! {
                    _ = tokio::time::sleep(delay) => {},
                    _ = cancel_rx.changed() => {
                        if *cancel_rx.borrow() {
                            return Ok(ReactLoopOutcome::Cancelled);
                        }
                    }
                }
            }

            match model_stream_service::stream_model_response(
                &request,
                channel,
                cancel_rx.clone(),
            )
            .await
            {
                Ok(result) => {
                    outcome = Some(result);
                    break;
                }
                Err(failure) => {
                    if !failure.retriable {
                        // Terminal error — propagate immediately
                        return Err(failure);
                    }
                    // Retriable — store and loop again if attempts remain
                    last_failure = Some(failure);
                    if retry_attempt >= MAX_RETRY_ATTEMPTS {
                        // All retries exhausted — propagate the last failure
                        return Err(last_failure.unwrap());
                    }
                    // Otherwise, backoff and retry
                }
            }
        }

        let outcome = outcome.expect("outcome must be set after retry loop");

        match outcome {
            ModelStreamOutcome::Completed {
                usage,
                reasoning_content,
            } => {
                return Ok(ReactLoopOutcome::Completed {
                    usage,
                    reasoning_content,
                });
            }
            ModelStreamOutcome::Cancelled => {
                return Ok(ReactLoopOutcome::Cancelled);
            }
            ModelStreamOutcome::ToolCallsRequested {
                tool_calls,
                usage: _,
                reasoning_content,
            } => {
                if tool_calls.is_empty() {
                    tracing::warn!(
                        request_id = %request_id,
                        iteration,
                        "tool_calls requested but list is empty, completing"
                    );
                    return Ok(ReactLoopOutcome::Completed {
                        usage: None,
                        reasoning_content,
                    });
                }

                tracing::info!(
                    request_id = %request_id,
                    iteration,
                    tool_count = tool_calls.len(),
                    "react loop: executing tool calls"
                );

                // 1. Emit TOOL_CALL events and execute each tool
                let _tool_results: Vec<ToolCallDto> = Vec::new();

                // Add the assistant message with tool_calls to the prompt
                let assistant_tool_call_message = ModelPromptMessageDto {
                    source_message_id: None,
                    role: "assistant".to_string(),
                    content: String::new(),
                    reasoning_content,
                    tool_calls: Some(tool_calls.clone()),
                    tool_call_id: None,
                    name: None,
                };
                prompt_messages.push(assistant_tool_call_message);

                for (tool_index, tc) in tool_calls.iter().enumerate() {
                    // Emit TOOL_CALL event to frontend
                    let _ = channel.send(ModelStreamEventDto::ToolCall {
                        request_id: request_id.clone(),
                        call_id: tc.id.clone(),
                        function_name: tc.function.name.clone(),
                        arguments: tc.function.arguments.clone(),
                    });

                    let security_policy = state.security_policy.lock().await.clone();
                    let requires_approval = requires_tool_approval(&tc.function.name, &tc.function.arguments, &security_policy);
                    drop(security_policy);

                    let result = if requires_approval {
                        // Request user approval via oneshot channel
                        let approval_id = format!("{}_{}", request_id, tc.id);
                        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

                        // Register the pending approval
                        {
                            let mut pending = state.pending_approvals.lock().await;
                            pending.insert(approval_id.clone(), tx);
                        }

                        // Build description from arguments
                        let description = build_approval_description(
                            &tc.function.name,
                            &tc.function.arguments,
                        );

                        // Emit APPROVAL_REQUIRED event to frontend
                        let _ = channel.send(ModelStreamEventDto::ApprovalRequired {
                            request_id: request_id.clone(),
                            approval_id: approval_id.clone(),
                            function_name: tc.function.name.clone(),
                            description,
                            timeout_secs: approval_timeout_secs,
                        });

                        tracing::info!(
                            request_id = %request_id,
                            approval_id = %approval_id,
                            tool = %tc.function.name,
                            "react loop: waiting for user approval"
                        );

                        // Wait for user response with backend-side timeout
                        let (approved, was_timeout) = match tokio::time::timeout(
                            std::time::Duration::from_secs(approval_timeout_secs as u64),
                            rx,
                        ).await {
                            Ok(Ok(approved)) => {
                                tracing::info!(
                                    approval_id = %approval_id,
                                    approved,
                                    "react loop: approval received, resuming"
                                );
                                (approved, false)
                            }
                            Ok(Err(_)) => {
                                tracing::warn!(
                                    approval_id = %approval_id,
                                    "approval channel closed, treating as rejected"
                                );
                                (false, false)
                            }
                            Err(_) => {
                                tracing::warn!(
                                    approval_id = %approval_id,
                                    timeout_secs = approval_timeout_secs,
                                    "approval timed out (backend)"
                                );
                                (false, true)
                            }
                        };

                        // Clean up the pending approval entry
                        {
                            let mut pending = state.pending_approvals.lock().await;
                            pending.remove(&approval_id);
                        }

                        if approved {
                            match execute_tool_checked(
                                state,
                                &allowed_tool_names,
                                &tc.function.name,
                                &tc.function.arguments,
                                tool_context.clone(),
                                &cancel_rx,
                                tool_execution_timeout_secs,
                            )
                            .await {
                                Ok(result) => result,
                                Err(outcome) => return Ok(outcome),
                            }
                        } else if was_timeout {
                            tracing::info!(
                                approval_id = %approval_id,
                                timeout_secs = approval_timeout_secs,
                                "tool approval timed out"
                            );
                            crate::services::tool_executor::ToolExecutionResult {
                                success: false,
                                output: format!(
                                    "Approval timed out after {} seconds — user did not respond in time. \
                                     This is NOT a user rejection. The user may have stepped away or is busy. \
                                     You may retry this tool call if appropriate.",
                                    approval_timeout_secs
                                ),
                            }
                        } else {
                            tracing::info!(
                                approval_id = %approval_id,
                                "user rejected tool execution"
                            );
                            crate::services::tool_executor::ToolExecutionResult {
                                success: false,
                                output: "User explicitly rejected this operation.".to_string(),
                            }
                        }
                    } else {
                        // Normal tool — execute directly (with MCP routing)
                        match execute_tool_checked(
                            state,
                            &allowed_tool_names,
                            &tc.function.name,
                            &tc.function.arguments,
                            tool_context.clone(),
                            &cancel_rx,
                            tool_execution_timeout_secs,
                        )
                        .await {
                            Ok(result) => result,
                            Err(outcome) => return Ok(outcome),
                        }
                    };

                    tracing::info!(
                        request_id = %request_id,
                        tool = %tc.function.name,
                        success = result.success,
                        output_len = result.output.len(),
                        "react loop: tool executed"
                    );

                    // Emit TOOL_RESULT event to frontend
                    let _ = channel.send(ModelStreamEventDto::ToolResult {
                        request_id: request_id.clone(),
                        call_id: tc.id.clone(),
                        result: result.output.clone(),
                        success: result.success,
                    });

                    // Add tool result to prompt messages — immediately truncate
                    // if the output is excessively large to prevent prompt overflow.
                    const MAX_INLINE_TOOL_CHARS: usize = 8_000;
                    let tool_content = if result.output.len() > MAX_INLINE_TOOL_CHARS {
                        let truncated: String = result.output.chars().take(MAX_INLINE_TOOL_CHARS).collect();
                        format!(
                            "{}\n\n[... output truncated ({} chars total) ...]",
                            truncated,
                            result.output.len()
                        )
                    } else {
                        result.output.clone()
                    };

                    let tool_result_message = ModelPromptMessageDto {
                        source_message_id: None,
                        role: "tool".to_string(),
                        content: tool_content.clone(),
                        reasoning_content: None,
                        tool_calls: None,
                        tool_call_id: Some(tc.id.clone()),
                        name: Some(tc.function.name.clone()),
                    };

                    // Pre-append compression: predict whether adding this result
                    // would push the prompt over the danger threshold.  If so,
                    // compress the CURRENT prompt (without the new result) first
                    // to create room.  This prevents overflow before it happens.
                    let result_tokens = crate::services::token_estimator::estimate_dto_message_tokens(
                        &tool_result_message,
                    );
                    let pre_append_tokens = crate::services::token_estimator::estimate_model_request_tokens(
                        &prompt_messages,
                        &current_tools,
                    );
                    let projected_tokens = pre_append_tokens.saturating_add(result_tokens);
                    let danger_threshold = (effective_input_budget as f32 * 0.96) as u32;

                    if projected_tokens > danger_threshold && effective_input_budget > 0 {
                        tracing::info!(
                            request_id = %request_id,
                            iteration,
                            pre_append_tokens,
                            result_tokens,
                            projected_tokens,
                            danger_threshold,
                            "react loop: pre-append compression triggered (tool result would exceed 96%)"
                        );
                        maybe_compress_react_prompt(
                            state,
                            &request_id,
                            iteration,
                            &model_id,
                            &conversation_id,
                            &branch_id,
                            &mut prompt_messages,
                            &current_tools,
                            context_budget_tokens,
                            effective_input_budget,
                            compression_trigger_tokens,
                            channel,
                        )
                        .await;
                    }

                    prompt_messages.push(tool_result_message);

                    if result.success {
                        consecutive_tool_failures = 0;
                    } else {
                        consecutive_tool_failures = consecutive_tool_failures.saturating_add(1);
                        if consecutive_tool_failures >= max_consecutive_failures {
                            tracing::warn!(
                                request_id = %request_id,
                                max_consecutive_failures,
                                last_tool = %tc.function.name,
                                "react loop: consecutive tool failure limit reached, forcing final text response"
                            );

                            // The preceding assistant message may contain multiple tool calls.
                            // Strict providers require every call id to receive a matching
                            // role=tool result before any final no-tools request.
                            for skipped_tc in tool_calls.iter().skip(tool_index + 1) {
                                let skipped_output = format!(
                                    "Skipped {} because the consecutive tool failure limit ({}) was reached before this tool could run.",
                                    skipped_tc.function.name, max_consecutive_failures
                                );
                                let _ = channel.send(ModelStreamEventDto::ToolCall {
                                    request_id: request_id.clone(),
                                    call_id: skipped_tc.id.clone(),
                                    function_name: skipped_tc.function.name.clone(),
                                    arguments: skipped_tc.function.arguments.clone(),
                                });
                                let _ = channel.send(ModelStreamEventDto::ToolResult {
                                    request_id: request_id.clone(),
                                    call_id: skipped_tc.id.clone(),
                                    result: skipped_output.clone(),
                                    success: false,
                                });
                                prompt_messages.push(ModelPromptMessageDto {
                                    source_message_id: None,
                                    role: "tool".to_string(),
                                    content: skipped_output,
                                    reasoning_content: None,
                                    tool_calls: None,
                                    tool_call_id: Some(skipped_tc.id.clone()),
                                    name: Some(skipped_tc.function.name.clone()),
                                });
                            }

                            prompt_messages.push(ModelPromptMessageDto {
                                source_message_id: None,
                                role: "system".to_string(),
                                content: format!(
                                    "Tool execution has failed {} consecutive times. You cannot call any more tools in this response. \
                                    Explain the limitation clearly, summarize what is already known, and provide the best direct answer or next steps without using tools.",
                                    max_consecutive_failures
                                ),
                                reasoning_content: None,
                                tool_calls: None,
                                tool_call_id: None,
                                name: None,
                            });
                            return stream_final_response_without_tools(
                                &initial_request,
                                prompt_messages,
                                channel,
                                cancel_rx,
                            )
                            .await;
                        }
                    }
                }

                // Continue the loop — the model will receive the updated prompt
                // with tool results and respond again.
            }
        }
    }

    // Max iterations reached — inject a soft-stop system message and let model respond naturally
    tracing::warn!(
        request_id = %request_id,
        max_iterations,
        "react loop: max iterations reached, injecting soft-stop hint"
    );

    // Add a legal system hint telling the model it has hit the limit. Do not
    // synthesize a `tool` message here: strict providers such as DeepSeek only
    // accept tool messages that directly answer a preceding assistant tool call.
    let limit_message = ModelPromptMessageDto {
        source_message_id: None,
        role: "system".to_string(),
        content: format!(
            "Maximum tool call rounds reached ({}). You cannot call any more tools in this response. \
            Please provide your final answer to the user based on the information you have gathered so far. \
            Do not attempt to call any more tools - summarize what you know and respond directly.",
            max_iterations
        ),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
        name: None,
    };
    prompt_messages.push(limit_message);

    // One final iteration without tools so the model gives a natural response
    let final_request = ResolvedModelStreamRequest {
        request_id: request_id.clone(),
        provider_type: initial_request.provider_type.clone(),
        provider_profile: initial_request.provider_profile,
        base_url: initial_request.base_url.clone(),
        api_key: initial_request.api_key.clone(),
        model_id: initial_request.model_id.clone(),
        request_model_name: initial_request.request_model_name.clone(),
        prompt_messages: prompt_messages.clone(),
        generation_params: initial_request.generation_params.clone(),
        tools: vec![], // No tools — force text response
        tool_choice: None,
        conversation_id: conversation_id.clone(),
        branch_id: branch_id.clone(),
        workspace_path: initial_request.workspace_path.clone(),
        activated_skill: initial_request.activated_skill.clone(),
    };

    match model_stream_service::stream_model_response(
        &final_request,
        channel,
        cancel_rx,
    )
    .await
    {
        Ok(ModelStreamOutcome::Completed {
            usage,
            reasoning_content,
        }) => {
            Ok(ReactLoopOutcome::Completed {
                usage,
                reasoning_content,
            })
        }
        Ok(ModelStreamOutcome::Cancelled) => Ok(ReactLoopOutcome::Cancelled),
        Ok(ModelStreamOutcome::ToolCallsRequested { .. }) => {
            // Model still tried to call tools despite empty tools list — force complete
            Ok(ReactLoopOutcome::Completed {
                usage: None,
                reasoning_content: None,
            })
        }
        Err(e) => Err(e),
    }
}

/**
 * Build a human-readable description of a tool action for the approval dialog.
 */
fn build_approval_description(function_name: &str, arguments: &str) -> String {
    let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
    match function_name {
        "rm" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("unknown");
            let recursive = args.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
            if recursive {
                format!("Delete directory '{}' and all its contents recursively", path)
            } else {
                format!("Delete file '{}'", path)
            }
        }
        "file_write" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("unknown");
            format!("Write/overwrite file '{}'", path)
        }
        _ => format!("Execute destructive tool: {}", function_name),
    }
}

/**
 * Approve or reject a pending tool action that requires user confirmation.
 *
 * Called by the frontend after the user responds to the approval dialog.
 * Returns true if the approval was found and resolved, false if it expired.
 */
#[tauri::command]
pub async fn approve_tool_action(
    state: State<'_, AppState>,
    approval_id: String,
    approved: bool,
) -> Result<bool, AppError> {
    let sender = {
        let mut pending = state.pending_approvals.lock().await;
        pending.remove(&approval_id)
    };

    match sender {
        Some(tx) => {
            let _ = tx.send(approved);
            tracing::info!(
                cmd = "approve_tool_action",
                approval_id = %approval_id,
                approved,
                "resolved"
            );
            Ok(true)
        }
        None => {
            tracing::warn!(
                cmd = "approve_tool_action",
                approval_id = %approval_id,
                "not found (expired or already resolved)"
            );
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn get_tool_settings(
    state: State<'_, AppState>,
) -> Result<crate::state::ToolLimits, AppError> {
    let limits = state.tool_limits.lock().await.clone();
    Ok(limits)
}

#[tauri::command]
pub async fn update_tool_settings(
    state: State<'_, AppState>,
    max_iterations: Option<u32>,
    max_consecutive_failures: Option<u32>,
    approval_timeout_secs: Option<u32>,
    tool_execution_timeout_secs: Option<u64>,
) -> Result<crate::state::ToolLimits, AppError> {
    let (previous_limits, next_limits) = {
        let mut limits = state.tool_limits.lock().await;
        let previous_limits = limits.clone();
        if let Some(v) = max_iterations {
            limits.max_iterations = v;
        }
        if let Some(v) = max_consecutive_failures {
            limits.max_consecutive_failures = v;
        }
        if let Some(v) = approval_timeout_secs {
            limits.approval_timeout_secs = v;
        }
        if let Some(v) = tool_execution_timeout_secs {
            limits.tool_execution_timeout_secs = v;
        }
        *limits = limits.clone().normalized();
        (previous_limits, limits.clone())
    };

    let value_json = serde_json::to_string(&next_limits)
        .map_err(|error| AppError::db_error("Failed to serialize tool settings").with_details(error.to_string()))?;

    if let Err(error) = crate::repositories::app_kv::set(&state.db, TOOL_LIMITS_KV_KEY, &value_json).await {
        let mut limits = state.tool_limits.lock().await;
        *limits = previous_limits;
        return Err(AppError::from(error));
    }

    tracing::info!(
        cmd = "update_tool_settings",
        max_iterations = next_limits.max_iterations,
        max_consecutive_failures = next_limits.max_consecutive_failures,
        approval_timeout_secs = next_limits.approval_timeout_secs,
        tool_execution_timeout_secs = next_limits.tool_execution_timeout_secs,
        "updated"
    );
    Ok(next_limits)
}

#[tauri::command]
pub async fn get_security_policy(
    state: State<'_, AppState>,
) -> Result<crate::state::SecurityPolicy, AppError> {
    Ok(state.security_policy.lock().await.clone())
}

#[tauri::command]
pub async fn update_security_policy(
    state: State<'_, AppState>,
    level: Option<String>,
    terminal_blacklist: Option<Vec<String>>,
    file_write_blacklist: Option<Vec<String>>,
) -> Result<crate::state::SecurityPolicy, AppError> {
    use crate::state::SECURITY_POLICY_KV_KEY;

    let previous = {
        let mut policy = state.security_policy.lock().await;
        let previous = policy.clone();
        if let Some(ref l) = level {
            policy.level = match l.as_str() {
                "permissive" => crate::state::SecurityLevel::Permissive,
                "strict" => crate::state::SecurityLevel::Strict,
                _ => crate::state::SecurityLevel::Standard,
            };
        }
        if let Some(ref bl) = terminal_blacklist {
            policy.terminal_blacklist = bl.clone();
        }
        if let Some(ref bl) = file_write_blacklist {
            policy.file_write_blacklist = bl.clone();
        }
        let updated = policy.clone();
        drop(policy);
        (previous, updated)
    };

    let updated = previous.1;
    let previous = previous.0;
    let value_json = serde_json::to_string(&updated)
        .map_err(|error| AppError::db_error("Failed to serialize security policy").with_details(error.to_string()))?;

    if let Err(error) = crate::repositories::app_kv::set(&state.db, SECURITY_POLICY_KV_KEY, &value_json).await {
        let mut policy = state.security_policy.lock().await;
        *policy = previous;
        return Err(AppError::from(error));
    }

    tracing::info!(
        cmd = "update_security_policy",
        level = ?updated.level,
        terminal_blacklist_count = updated.terminal_blacklist.len(),
        file_write_blacklist_count = updated.file_write_blacklist.len(),
        "updated"
    );
    Ok(updated)
}

// ============================================================================
// MCP Server Management Commands
// ============================================================================

use crate::services::mcp_client::McpServerConfig;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStateDto {
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub status: String,
    pub enabled: bool,
    pub tools: Vec<McpToolDto>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDto {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<serde_json::Value>,
}

/** Input format matching Claude Desktop: `{ "name": { "command": ..., "args": ..., "env": ... } }`. */
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AddMcpServerInput {
    /// Server name (key in mcpServers map).
    pub name: String,
    /// Per-server config (command, args, env).
    pub config: McpServerConfig,
}

fn is_valid_mcp_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && !name.contains("__")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    // Match token-like *segments* instead of arbitrary substrings so ordinary
    // numeric settings such as MAX_TOKENS are not treated as secrets.
    let segments: Vec<&str> = upper
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect();

    segments.iter().enumerate().any(|(index, segment)| {
        matches!(
            *segment,
            "KEY"
                | "SECRET"
                | "PASSWORD"
                | "AUTH"
                | "AUTHORIZATION"
                | "CREDENTIAL"
                | "CREDENTIALS"
                | "BEARER"
                | "PAT"
        ) || (*segment == "TOKEN" && index + 1 == segments.len())
    })
}

fn normalize_mcp_transport_for_storage(transport: &str) -> String {
    match transport.trim().to_ascii_lowercase().as_str() {
        "" | "stdio" => "stdio".to_string(),
        "http" | "streamable_http" | "streamable-http" | "streamablehttp" => {
            "streamable_http".to_string()
        }
        "sse" | "legacy_sse" | "legacy-sse" => "sse".to_string(),
        other => other.to_string(),
    }
}

fn is_sensitive_header_key(key: &str) -> bool {
    is_sensitive_env_key(key)
}

#[cfg(test)]
mod mcp_env_tests {
    use super::is_sensitive_env_key;

    #[test]
    fn sensitive_env_key_detection_uses_segments() {
        assert!(is_sensitive_env_key("OPENAI_API_KEY"));
        assert!(is_sensitive_env_key("github-token"));
        assert!(is_sensitive_env_key("CLIENT_SECRET"));
        assert!(is_sensitive_env_key("PASSWORD"));

        assert!(!is_sensitive_env_key("FEEDBACK_MAX_TOKENS"));
        assert!(!is_sensitive_env_key("TOKEN_LIMIT"));
        assert!(!is_sensitive_env_key("TOKENIZER_MODEL"));
        assert!(!is_sensitive_env_key("PORT"));
    }
}

fn mcp_secret_store_key(server_name: &str, env_key: &str) -> String {
    format!("mcp:{server_name}:env:{env_key}")
}

fn mcp_header_secret_store_key(server_name: &str, header_key: &str) -> String {
    format!("mcp:{server_name}:header:{header_key}")
}

fn encode_mcp_env_for_storage(
    server_name: &str,
    env: &HashMap<String, String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<String, AppError> {
    let mut stored = serde_json::Map::new();
    for (key, value) in env {
        if is_sensitive_env_key(key) {
            let secret_key = mcp_secret_store_key(server_name, key);
            key_store
                .save(&secret_key, value)
                .map_err(AppError::secure_storage_error)?;
            stored.insert(key.clone(), serde_json::json!({ "kind": "secure" }));
        } else {
            stored.insert(
                key.clone(),
                serde_json::json!({ "kind": "plain", "value": value }),
            );
        }
    }
    Ok(serde_json::Value::Object(stored).to_string())
}

fn encode_mcp_headers_for_storage(
    server_name: &str,
    headers: &HashMap<String, String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<String, AppError> {
    let mut stored = serde_json::Map::new();
    for (key, value) in headers {
        if is_sensitive_header_key(key) {
            let secret_key = mcp_header_secret_store_key(server_name, key);
            key_store
                .save(&secret_key, value)
                .map_err(AppError::secure_storage_error)?;
            stored.insert(key.clone(), serde_json::json!({ "kind": "secure" }));
        } else {
            stored.insert(
                key.clone(),
                serde_json::json!({ "kind": "plain", "value": value }),
            );
        }
    }
    Ok(serde_json::Value::Object(stored).to_string())
}

fn decode_mcp_env_from_storage(
    server_name: &str,
    env_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<HashMap<String, String>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(env_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid MCP env metadata: {e}")))?;
    let Some(object) = parsed.as_object() else {
        return Ok(HashMap::new());
    };

    let mut env = HashMap::new();
    for (key, value) in object {
        if let Some(raw) = value.as_str() {
            if is_sensitive_env_key(key) {
                tracing::warn!(
                    server = %server_name,
                    env_key = %key,
                    "Skipping legacy plaintext sensitive MCP env value"
                );
            } else {
                env.insert(key.clone(), raw.to_string());
            }
            continue;
        }

        match value.get("kind").and_then(|v| v.as_str()) {
            Some("secure") => {
                let secret_key = mcp_secret_store_key(server_name, key);
                if let Some(secret) = key_store
                    .load(&secret_key)
                    .map_err(AppError::secure_storage_error)?
                {
                    env.insert(key.clone(), secret);
                } else {
                    tracing::warn!(
                        server = %server_name,
                        env_key = %key,
                        "Missing secure MCP env value"
                    );
                }
            }
            Some("plain") => {
                if let Some(raw) = value.get("value").and_then(|v| v.as_str()) {
                    env.insert(key.clone(), raw.to_string());
                }
            }
            _ => {}
        }
    }
    Ok(env)
}

fn decode_mcp_headers_from_storage(
    server_name: &str,
    headers_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<HashMap<String, String>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(headers_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid MCP header metadata: {e}")))?;
    let Some(object) = parsed.as_object() else {
        return Ok(HashMap::new());
    };

    let mut headers = HashMap::new();
    for (key, value) in object {
        if let Some(raw) = value.as_str() {
            if is_sensitive_header_key(key) {
                tracing::warn!(
                    server = %server_name,
                    header = %key,
                    "Skipping legacy plaintext sensitive MCP HTTP header value"
                );
            } else {
                headers.insert(key.clone(), raw.to_string());
            }
            continue;
        }

        match value.get("kind").and_then(|v| v.as_str()) {
            Some("secure") => {
                let secret_key = mcp_header_secret_store_key(server_name, key);
                if let Some(secret) = key_store
                    .load(&secret_key)
                    .map_err(AppError::secure_storage_error)?
                {
                    headers.insert(key.clone(), secret);
                } else {
                    tracing::warn!(
                        server = %server_name,
                        header = %key,
                        "Missing secure MCP HTTP header value"
                    );
                }
            }
            Some("plain") => {
                if let Some(raw) = value.get("value").and_then(|v| v.as_str()) {
                    headers.insert(key.clone(), raw.to_string());
                }
            }
            _ => {}
        }
    }
    Ok(headers)
}

fn cleanup_mcp_env_secrets(
    server_name: &str,
    env_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
    retain_sensitive_keys: &HashSet<String>,
) -> Result<(), AppError> {
    let parsed: serde_json::Value = serde_json::from_str(env_json).unwrap_or_default();
    let Some(object) = parsed.as_object() else {
        return Ok(());
    };

    for (key, value) in object {
        if retain_sensitive_keys.contains(key) {
            continue;
        }
        let stored_secure = value.get("kind").and_then(|v| v.as_str()) == Some("secure");
        if stored_secure || is_sensitive_env_key(key) {
            key_store
                .delete(&mcp_secret_store_key(server_name, key))
                .map_err(AppError::secure_storage_error)?;
        }
    }
    Ok(())
}

fn cleanup_mcp_header_secrets(
    server_name: &str,
    headers_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
    retain_sensitive_keys: &HashSet<String>,
) -> Result<(), AppError> {
    let parsed: serde_json::Value = serde_json::from_str(headers_json).unwrap_or_default();
    let Some(object) = parsed.as_object() else {
        return Ok(());
    };

    for (key, value) in object {
        if retain_sensitive_keys.contains(key) {
            continue;
        }
        let stored_secure = value.get("kind").and_then(|v| v.as_str()) == Some("secure");
        if stored_secure || is_sensitive_header_key(key) {
            key_store
                .delete(&mcp_header_secret_store_key(server_name, key))
                .map_err(AppError::secure_storage_error)?;
        }
    }
    Ok(())
}

fn snapshot_mcp_env_secrets(
    server_name: &str,
    env_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<HashMap<String, String>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(env_json).unwrap_or_default();
    let Some(object) = parsed.as_object() else {
        return Ok(HashMap::new());
    };

    let mut secrets = HashMap::new();
    for (key, value) in object {
        let stored_secure = value.get("kind").and_then(|v| v.as_str()) == Some("secure");
        if stored_secure || is_sensitive_env_key(key) {
            if let Some(secret) = key_store
                .load(&mcp_secret_store_key(server_name, key))
                .map_err(AppError::secure_storage_error)?
            {
                secrets.insert(key.clone(), secret);
            }
        }
    }
    Ok(secrets)
}

fn snapshot_mcp_header_secrets(
    server_name: &str,
    headers_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<HashMap<String, String>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(headers_json).unwrap_or_default();
    let Some(object) = parsed.as_object() else {
        return Ok(HashMap::new());
    };

    let mut secrets = HashMap::new();
    for (key, value) in object {
        let stored_secure = value.get("kind").and_then(|v| v.as_str()) == Some("secure");
        if stored_secure || is_sensitive_header_key(key) {
            if let Some(secret) = key_store
                .load(&mcp_header_secret_store_key(server_name, key))
                .map_err(AppError::secure_storage_error)?
            {
                secrets.insert(key.clone(), secret);
            }
        }
    }
    Ok(secrets)
}

fn restore_mcp_env_secrets(
    server_name: &str,
    secrets: &HashMap<String, String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<(), AppError> {
    for (key, value) in secrets {
        key_store
            .save(&mcp_secret_store_key(server_name, key), value)
            .map_err(AppError::secure_storage_error)?;
    }
    Ok(())
}

fn restore_mcp_header_secrets(
    server_name: &str,
    secrets: &HashMap<String, String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<(), AppError> {
    for (key, value) in secrets {
        key_store
            .save(&mcp_header_secret_store_key(server_name, key), value)
            .map_err(AppError::secure_storage_error)?;
    }
    Ok(())
}

fn delete_mcp_env_secret_keys(
    server_name: &str,
    keys: &HashSet<String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<(), AppError> {
    for key in keys {
        key_store
            .delete(&mcp_secret_store_key(server_name, key))
            .map_err(AppError::secure_storage_error)?;
    }
    Ok(())
}

fn delete_mcp_header_secret_keys(
    server_name: &str,
    keys: &HashSet<String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<(), AppError> {
    for key in keys {
        key_store
            .delete(&mcp_header_secret_store_key(server_name, key))
            .map_err(AppError::secure_storage_error)?;
    }
    Ok(())
}

async fn restore_mcp_runtime_from_row(
    state: &State<'_, AppState>,
    row: &crate::repositories::mcp_servers::McpServerRow,
) {
    if !row.enabled {
        return;
    }

    let args: Vec<String> = match serde_json::from_str(&row.args_json) {
        Ok(args) => args,
        Err(error) => {
            tracing::warn!(server = %row.name, error = %error, "Failed to restore previous MCP args");
            return;
        }
    };
    let env = match decode_mcp_env_from_storage(&row.name, &row.env_json, state.key_store.as_ref()) {
        Ok(env) => env,
        Err(error) => {
            tracing::warn!(server = %row.name, error = %error, "Failed to restore previous MCP env");
            return;
        }
    };
    let headers = match decode_mcp_headers_from_storage(&row.name, &row.headers_json, state.key_store.as_ref()) {
        Ok(headers) => headers,
        Err(error) => {
            tracing::warn!(server = %row.name, error = %error, "Failed to restore previous MCP HTTP headers");
            return;
        }
    };

    let mut manager = state.mcp_manager.lock().await;
    if let Err(error) = manager
        .add_server(
            row.name.clone(),
            McpServerConfig {
                transport: row.transport.clone(),
                command: row.command.clone(),
                args,
                env,
                url: row.url.clone(),
                headers,
            },
        )
        .await
    {
        tracing::warn!(server = %row.name, error = %error, "Failed to restore previous MCP runtime");
    }
}

#[tauri::command]
pub async fn list_mcp_servers(
    state: State<'_, AppState>,
) -> Result<Vec<McpServerStateDto>, AppError> {
    let app_data_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::db_error(&format!("Failed to resolve app data dir: {e}")))?;

    let config_result = crate::services::mcp_config_file::load_mcp_config_file(&app_data_dir);

    let runtime_states: HashMap<String, crate::services::mcp_client::McpServerState> = {
        let manager = state.mcp_manager.lock().await;
        manager
            .server_states()
            .into_iter()
            .map(|state| (state.name.clone(), state))
            .collect()
    };

    let mut result = Vec::with_capacity(config_result.servers.len());
    for parsed in &config_result.servers {
        let config = &parsed.config;
        let disabled = config
            .get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let transport_raw = config
            .get("transport")
            .or_else(|| config.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("stdio");
        let transport = normalize_mcp_transport_for_storage(transport_raw).to_string();

        let command = config
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let args: Vec<String> = config
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let url = config
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let env: HashMap<String, String> = config
            .get("env")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        let headers: HashMap<String, String> = config
            .get("headers")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        let runtime_state = runtime_states.get(&parsed.name);
        let status = if disabled {
            "disabled".to_string()
        } else if let Some(state) = runtime_state {
            match &state.status {
                crate::services::mcp_client::McpServerStatus::Running => "running".to_string(),
                crate::services::mcp_client::McpServerStatus::Starting => "starting".to_string(),
                crate::services::mcp_client::McpServerStatus::Error(e) => format!("error: {e}"),
                _ => "stopped".to_string(),
            }
        } else {
            "stopped".to_string()
        };

        let mut tools: Vec<McpToolDto> = runtime_state
            .map(|state| {
                state
                    .tools
                    .iter()
                    .cloned()
                    .map(|t| McpToolDto {
                        name: t.name,
                        description: t.description,
                        input_schema: t.input_schema,
                    })
                    .collect()
            })
            .unwrap_or_default();
        tools.sort_by(|a, b| a.name.cmp(&b.name));

        result.push(McpServerStateDto {
            enabled: !disabled,
            name: parsed.name.clone(),
            transport,
            command,
            args,
            env,
            url,
            headers,
            status,
            tools,
        });
    }

    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

#[tauri::command]
pub async fn add_mcp_server(
    state: State<'_, AppState>,
    input: AddMcpServerInput,
) -> Result<(), AppError> {
    let name = input.name.trim().to_string();
    if !is_valid_mcp_server_name(&name) {
        return Err(AppError::invalid_argument(
            "Server name must be 1-40 chars and contain only letters, numbers, '_' or '-'",
        ));
    }

    let previous_row = crate::repositories::mcp_servers::find_by_name(&state.db, &name)
        .await
        .map_err(|e| AppError::db_error(&format!("Failed to load existing MCP config: {e}")))?;

    // Validate metadata before touching runtime state or secure storage.
    let transport = normalize_mcp_transport_for_storage(&input.config.transport);
    let command = input.config.command.clone();
    let args_json = serde_json::to_string(&input.config.args)
        .map_err(|e| AppError::invalid_argument(&format!("Invalid args: {e}")))?;
    let url = input.config.url.trim().to_string();
    let current_secret_keys: HashSet<String> = input
        .config
        .env
        .keys()
        .filter(|key| is_sensitive_env_key(key))
        .cloned()
        .collect();
    let current_header_secret_keys: HashSet<String> = input
        .config
        .headers
        .keys()
        .filter(|key| is_sensitive_header_key(key))
        .cloned()
        .collect();
    let previous_secret_values = if let Some(previous_row) = &previous_row {
        snapshot_mcp_env_secrets(&name, &previous_row.env_json, state.key_store.as_ref())?
    } else {
        HashMap::new()
    };
    let previous_header_secret_values = if let Some(previous_row) = &previous_row {
        snapshot_mcp_header_secrets(&name, &previous_row.headers_json, state.key_store.as_ref())?
    } else {
        HashMap::new()
    };

    let mut effective_env = input.config.env.clone();
    for key in &current_secret_keys {
        if effective_env.get(key).is_some_and(|value| value.is_empty()) {
            if let Some(previous_value) = previous_secret_values.get(key) {
                effective_env.insert(key.clone(), previous_value.clone());
            }
        }
    }
    let mut effective_headers = input.config.headers.clone();
    for key in &current_header_secret_keys {
        if effective_headers.get(key).is_some_and(|value| value.is_empty()) {
            if let Some(previous_value) = previous_header_secret_values.get(key) {
                effective_headers.insert(key.clone(), previous_value.clone());
            }
        }
    }

    let runtime_config = McpServerConfig {
        transport: transport.clone(),
        command: input.config.command.clone(),
        args: input.config.args.clone(),
        env: effective_env.clone(),
        url: input.config.url.clone(),
        headers: effective_headers.clone(),
    };

    // Validate/start the server process before mutating DB/secure-storage state.
    // This prevents a failed add from leaving a saved config that the UI reports as enabled/running.
    let mut manager = state.mcp_manager.lock().await;
    if let Err(error) = manager.add_server(name.clone(), runtime_config).await {
        return Err(AppError::invalid_argument(&error));
    }
    drop(manager);

    let env_json = match encode_mcp_env_for_storage(&name, &effective_env, state.key_store.as_ref()) {
        Ok(value) => value,
        Err(error) => {
            let mut manager = state.mcp_manager.lock().await;
            manager.remove_server(&name).await;
            delete_mcp_env_secret_keys(&name, &current_secret_keys, state.key_store.as_ref())?;
            delete_mcp_header_secret_keys(&name, &current_header_secret_keys, state.key_store.as_ref())?;
            restore_mcp_env_secrets(&name, &previous_secret_values, state.key_store.as_ref())?;
            restore_mcp_header_secrets(&name, &previous_header_secret_values, state.key_store.as_ref())?;
            if let Some(previous_row) = &previous_row {
                restore_mcp_runtime_from_row(&state, previous_row).await;
            }
            return Err(error);
        }
    };

    let headers_json = match encode_mcp_headers_for_storage(&name, &effective_headers, state.key_store.as_ref()) {
        Ok(value) => value,
        Err(error) => {
            let mut manager = state.mcp_manager.lock().await;
            manager.remove_server(&name).await;
            cleanup_mcp_env_secrets(&name, &env_json, state.key_store.as_ref(), &HashSet::new())?;
            delete_mcp_header_secret_keys(&name, &current_header_secret_keys, state.key_store.as_ref())?;
            restore_mcp_env_secrets(&name, &previous_secret_values, state.key_store.as_ref())?;
            restore_mcp_header_secrets(&name, &previous_header_secret_values, state.key_store.as_ref())?;
            if let Some(previous_row) = &previous_row {
                restore_mcp_runtime_from_row(&state, previous_row).await;
            }
            return Err(error);
        }
    };

    let upsert_result = crate::repositories::mcp_servers::upsert(
        &state.db,
        &name,
        &transport,
        &command,
        &args_json,
        &env_json,
        &url,
        &headers_json,
        true,
    )
    .await;
    if let Err(error) = upsert_result {
        let mut manager = state.mcp_manager.lock().await;
        manager.remove_server(&name).await;
        cleanup_mcp_env_secrets(&name, &env_json, state.key_store.as_ref(), &HashSet::new())?;
        cleanup_mcp_header_secrets(&name, &headers_json, state.key_store.as_ref(), &HashSet::new())?;
        restore_mcp_env_secrets(&name, &previous_secret_values, state.key_store.as_ref())?;
        restore_mcp_header_secrets(&name, &previous_header_secret_values, state.key_store.as_ref())?;
        if let Some(previous_row) = &previous_row {
            restore_mcp_runtime_from_row(&state, previous_row).await;
        }
        return Err(AppError::db_error(&format!(
            "Failed to save MCP config: {error}"
        )));
    }

    if let Some(previous_row) = previous_row {
        cleanup_mcp_env_secrets(
            &name,
            &previous_row.env_json,
            state.key_store.as_ref(),
            &current_secret_keys,
        )?;
        cleanup_mcp_header_secrets(
            &name,
            &previous_row.headers_json,
            state.key_store.as_ref(),
            &current_header_secret_keys,
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_mcp_server(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), AppError> {
    let app_data_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::db_error(&format!("Failed to resolve app data dir: {e}")))?;

    let raw_json = std::fs::read_to_string(
        crate::services::mcp_config_file::mcps_json_path(&app_data_dir),
    )
    .map_err(|e| AppError::db_error(&format!("Failed to read mcps.json: {e}")))?;

    let mut parsed: serde_json::Value = serde_json::from_str(&raw_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid mcps.json: {e}")))?;

    let server_map = crate::services::mcp_config_file::extract_server_map_mut(&mut parsed)
        .ok_or_else(|| AppError::not_found("No server map found in mcps.json"))?;

    if server_map.remove(&name).is_none() {
        return Err(AppError::not_found(&format!("MCP server not found: {name}")));
    }

    let new_json = serde_json::to_string_pretty(&parsed)
        .map_err(|e| AppError::db_error(&format!("Failed to serialize mcps.json: {e}")))?;
    crate::services::mcp_config_file::save_mcp_config_file(&app_data_dir, &new_json)
        .map_err(|e| AppError::db_error(&format!("Failed to save mcps.json: {e}")))?;

    // Stop and remove from runtime
    let mut manager = state.mcp_manager.lock().await;
    manager.remove_server(&name).await;

    tracing::info!(cmd = "remove_mcp_server", server = %name, "ok");
    Ok(())
}

#[tauri::command]
pub async fn get_mcp_tool_definitions(
    state: State<'_, AppState>,
) -> Result<Vec<crate::dto::common::ToolDefinitionDto>, AppError> {
    Ok(build_backend_enabled_tool_definitions(&state)
        .await
        .into_iter()
        .filter(|definition| definition.function.name.starts_with("mcp__"))
        .collect())
}

#[tauri::command]
pub async fn set_mcp_server_enabled(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<bool, AppError> {
    let app_data_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::db_error(&format!("Failed to resolve app data dir: {e}")))?;

    // Read current mcps.json
    let raw_json = std::fs::read_to_string(
        crate::services::mcp_config_file::mcps_json_path(&app_data_dir),
    )
    .map_err(|e| AppError::db_error(&format!("Failed to read mcps.json: {e}")))?;

    let mut parsed: serde_json::Value = serde_json::from_str(&raw_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid mcps.json: {e}")))?;

    // Find the server entry
    let server_obj = crate::services::mcp_config_file::extract_server_map_mut(&mut parsed)
        .and_then(|map| map.get_mut(&name))
        .ok_or_else(|| AppError::not_found(&format!("MCP server not found: {name}")))?;

    if enabled {
        server_obj.as_object_mut().map(|o| o.remove("disabled"));
    } else {
        server_obj.as_object_mut().map(|o| o.insert("disabled".to_string(), serde_json::Value::Bool(true)));
    }

    // Save updated file
    let new_json = serde_json::to_string_pretty(&parsed)
        .map_err(|e| AppError::db_error(&format!("Failed to serialize mcps.json: {e}")))?;
    crate::services::mcp_config_file::save_mcp_config_file(&app_data_dir, &new_json)
        .map_err(|e| AppError::db_error(&format!("Failed to save mcps.json: {e}")))?;

    // Reload only the affected server
    let mut manager = state.mcp_manager.lock().await;
    if enabled {
        // Parse the server config from the saved JSON and start it
        let smap = parsed.get("mcpServers")
            .or_else(|| parsed.get("servers"))
            .and_then(|v| v.as_object())
            .or_else(|| parsed.as_object());
        if let Some(smap) = smap {
            if let Some(config_value) = smap.get(&name) {
                let transport_raw = config_value.get("transport")
                    .or_else(|| config_value.get("type"))
                    .and_then(|v| v.as_str()).unwrap_or("stdio");
                let transport = crate::services::mcp_client::normalize_mcp_transport(transport_raw);
                let command = config_value.get("command")
                    .and_then(|v| v.as_str()).unwrap_or("").to_string();
                let args: Vec<String> = config_value.get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let url = config_value.get("url")
                    .and_then(|v| v.as_str()).unwrap_or("").to_string();
                let env = config_value.get("env")
                    .and_then(|v| v.as_object())
                    .map(|obj| obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect())
                    .unwrap_or_default();
                let headers = config_value.get("headers")
                    .and_then(|v| v.as_object())
                    .map(|obj| obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect())
                    .unwrap_or_default();

                let config = crate::services::mcp_client::McpServerConfig {
                    transport, command, args, env, url, headers,
                };

                match manager.add_server(name.clone(), config).await {
                    Ok(()) => tracing::info!(server = %name, "MCP server re-enabled"),
                    Err(e) => tracing::warn!(server = %name, error = %e, "Failed to start re-enabled MCP server"),
                }
            }
        }
    } else {
        // Just stop the single server
        manager.remove_server(&name).await;
        tracing::info!(server = %name, "MCP server disabled and stopped");
    }

    tracing::info!(cmd = "set_mcp_server_enabled", server = %name, enabled, "ok");
    Ok(true)
}

#[tauri::command]
pub async fn get_context_status(
    state: State<'_, AppState>,
    conversation_id: String,
    branch_id: String,
    model_id: String,
) -> Result<crate::dto::streaming::ContextStatusDto, AppError> {
    // Resolve the branch head message ID
    let branch = crate::repositories::branches::find_by_id(&state.db, &branch_id)
        .await
        .map_err(|e| AppError::db_error(&format!("Failed to find branch: {e}")))?;

    let up_to_message_id = match branch {
        Some(b) => b.head_message_id.unwrap_or_default(),
        None => String::new(),
    };

    let raw_input = crate::dto::messages::BuildPromptMessagesInput {
        conversation_id: conversation_id.clone(),
        up_to_message_id: up_to_message_id.clone(),
        max_tokens_budget: None,
        branch_id: Some(branch_id.clone()),
        skills_dir: state.app_handle.path().app_data_dir().ok().map(|p| {
            crate::services::skill_fs::skills_root_from_app_data(&p).to_string_lossy().to_string()
        }),
        activated_skill: None,
    };

    let raw_messages = crate::services::prompt_service::build_prompt_messages(&state.db, &raw_input)
        .await
        .map_err(|e| AppError::db_error(&format!("Failed to build prompt: {e}")))?;

    let tool_definitions = build_backend_enabled_tool_definitions(&state).await;
    let context_window_kb = crate::repositories::provider_models::get_context_window_kb(
        &state.db,
        &model_id,
    )
    .await
    .unwrap_or(64);
    let total_tokens = (context_window_kb as u32) * 1000;

    let mut raw_breakdown = crate::services::token_estimator::estimate_messages_token_breakdown(&raw_messages);
    let raw_message_breakdown_tokens = crate::services::token_estimator::sum_context_token_breakdown(&raw_breakdown);
    let raw_used_tokens = crate::services::token_estimator::estimate_prompt_model_request_tokens(
        &raw_messages,
        &tool_definitions,
    );
    // Attribute tool schemas plus request-level overhead to tool_prompt_tokens
    // so the UI total matches the same request-level estimate used by streaming.
    raw_breakdown.tool_prompt_tokens = raw_used_tokens.saturating_sub(raw_message_breakdown_tokens);

    // The send path applies deterministic prompt trimming before streaming.
    // Report `used_tokens` on the same basis, while keeping `raw_used_tokens`
    // available for diagnostics and deciding whether compression is worthwhile.
    let total_for_budget = total_tokens.max(1000);
    let default_output_reserve = 512u32.max((total_for_budget as f32 * 0.10).floor() as u32);
    let output_reserve = default_output_reserve.min((total_for_budget as f32 * 0.40).floor() as u32);
    let send_budget = (total_for_budget as f32 * 0.90).floor() as u32;
    let prompt_budget_tokens = 1000u32.max(
        send_budget
            .saturating_sub(raw_breakdown.tool_prompt_tokens)
            .saturating_sub(output_reserve),
    );

    let budgeted_input = crate::dto::messages::BuildPromptMessagesInput {
        conversation_id: conversation_id.clone(),
        up_to_message_id,
        max_tokens_budget: Some(prompt_budget_tokens.min(i32::MAX as u32) as i32),
        branch_id: Some(branch_id.clone()),
        skills_dir: state.app_handle.path().app_data_dir().ok().map(|p| {
            crate::services::skill_fs::skills_root_from_app_data(&p).to_string_lossy().to_string()
        }),
        activated_skill: None,
    };
    let messages = crate::services::prompt_service::build_prompt_messages(&state.db, &budgeted_input)
        .await
        .map_err(|e| AppError::db_error(&format!("Failed to build budgeted prompt: {e}")))?;

    let mut breakdown = crate::services::token_estimator::estimate_messages_token_breakdown(&messages);
    let message_breakdown_tokens = crate::services::token_estimator::sum_context_token_breakdown(&breakdown);
    let used_tokens = crate::services::token_estimator::estimate_prompt_model_request_tokens(
        &messages,
        &tool_definitions,
    );
    breakdown.tool_prompt_tokens = used_tokens.saturating_sub(message_breakdown_tokens);

    let percentage = if total_tokens > 0 {
        (used_tokens as f32 / total_tokens as f32) * 100.0
    } else {
        0.0
    };
    let raw_percentage = if total_tokens > 0 {
        (raw_used_tokens as f32 / total_tokens as f32) * 100.0
    } else {
        0.0
    };

    Ok(crate::dto::streaming::ContextStatusDto {
        used_tokens,
        raw_used_tokens,
        total_tokens,
        percentage,
        raw_percentage,
        message_count: messages.len() as u32,
        raw_message_count: raw_messages.len() as u32,
        prompt_budget_tokens,
        breakdown,
    })
}

/**
 * Reload all persisted MCP servers from database on startup.
 * Silently skips servers that fail to connect.
 */
/**
 * Reload MCP servers from mcps.json file (or migrate from SQLite on first run).
 */
pub async fn reload_mcp_servers_from_file(
    app_handle: &tauri::AppHandle,
    db: &sqlx::SqlitePool,
    _key_store: &dyn crate::state::SecureKeyStore,
    mcp_manager: &std::sync::Arc<tokio::sync::Mutex<crate::services::mcp_client::McpManager>>,
) {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to resolve app data directory");

    use crate::services::mcp_config_file;

    // Migration: if mcps.json doesn't exist but SQLite has servers, export first
    let mcps_path = mcp_config_file::mcps_json_path(&app_dir);
    if !mcps_path.exists() {
        if let Ok(rows) = crate::repositories::mcp_servers::list_all(db).await {
            if !rows.is_empty() {
                let json = mcp_config_file::export_sqlite_to_mcps_json(&rows);
                if let Err(e) = mcp_config_file::save_mcp_config_file(&app_dir, &json) {
                    tracing::warn!("Failed to export MCP servers to mcps.json: {e}");
                } else {
                    tracing::info!(count = rows.len(), "Migrated MCP servers from SQLite to mcps.json");
                }
            }
        }
    }

    let result = mcp_config_file::load_mcp_config_file(&app_dir);

    for err in &result.parse_errors {
        tracing::warn!("MCP config: {err}");
    }

    if result.servers.is_empty() {
        return;
    }

    tracing::info!(count = result.servers.len(), "Loading MCP servers from mcps.json...");

    let mut manager = mcp_manager.lock().await;
    for server in &result.servers {
        let config_value = &server.config;

        // Extract fields from JSON value, tolerating missing/wrong types
        let transport_raw = config_value.get("transport")
            .or_else(|| config_value.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("stdio");
        let transport = crate::services::mcp_client::normalize_mcp_transport(transport_raw);
        let command = config_value.get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args: Vec<String> = config_value.get("args")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let url = config_value.get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let disabled = config_value.get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if disabled {
            tracing::info!(server = %server.name, "MCP server is disabled; skipping");
            continue;
        }

        // For env and headers, extract as plain string maps
        // Sensitive values stored in keyring are NOT used in file mode
        // Users should put real values directly in the JSON (or use env var references)
        let env = config_value.get("env")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<String, String>>()
            )
            .unwrap_or_default();
        let headers = config_value.get("headers")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<String, String>>()
            )
            .unwrap_or_default();

        let config = crate::services::mcp_client::McpServerConfig {
            transport,
            command,
            args,
            env,
            url,
            headers,
        };

        match manager.add_server(server.name.clone(), config.clone()).await {
            Ok(()) => {
                tracing::info!(server = %server.name, "MCP server loaded from file");
            }
            Err(e) => {
                tracing::warn!(server = %server.name, error = %e, "Failed to start MCP server");
            }
        }
    }
}

#[tauri::command]
pub async fn get_mcp_config_json(
    app_handle: tauri::AppHandle,
) -> Result<String, AppError> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_argument(format!("Failed to resolve app data dir: {e}")))?;

    use crate::services::mcp_config_file;
    let path = mcp_config_file::mcps_json_path(&app_dir);

    if !path.exists() {
        // Return empty template
        return Ok("{\n  \"mcpServers\": {}\n}".to_string());
    }

    std::fs::read_to_string(&path)
        .map_err(|e| AppError::invalid_argument(format!("Failed to read mcps.json: {e}")))
}

#[tauri::command]
pub async fn save_mcp_config_json(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    json_content: String,
) -> Result<String, AppError> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_argument(format!("Failed to resolve app data dir: {e}")))?;

    use crate::services::mcp_config_file;

    mcp_config_file::save_mcp_config_file(&app_dir, &json_content)
        .map_err(|e| AppError::invalid_argument(e))?;

    // Reload all servers from the updated file
    reload_mcp_servers_from_file(&app_handle, &state.db, state.key_store.as_ref(), &state.mcp_manager).await;

    // Return validation info
    let result = mcp_config_file::load_mcp_config_file(&app_dir);
    let mut info = Vec::new();
    for server in &result.servers {
        info.push(format!("✓ {}", server.name));
    }
    for err in &result.parse_errors {
        info.push(format!("⚠ {err}"));
    }
    Ok(info.join("\n"))
}

// ============================================================================
// Skills & Slash Commands
// ============================================================================

/// Return all skills and MCP prompts available for slash commands.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashItemDto {
    pub item_type: String, // "skill" | "mcp_prompt"
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub arguments_json: String,
    pub server_name: Option<String>,
}

/// List slash items from filesystem skills + MCP prompts.
#[tauri::command]
pub async fn list_slash_items(
    state: State<'_, AppState>,
) -> Result<Vec<SlashItemDto>, AppError> {
    let mut items = Vec::new();

    // Skills from filesystem
    if let Ok(app_data) = state.app_handle.path().app_data_dir() {
        let skills_dir = crate::services::skill_fs::skills_root_from_app_data(&app_data);
        let skills = crate::services::skill_fs::discover_skills(&skills_dir);
        for skill in skills {
            items.push(SlashItemDto {
                item_type: "skill".to_string(),
                name: skill.name,
                display_name: skill.display_name,
                description: skill.description,
                arguments_json: "[]".to_string(),
                server_name: None,
            });
        }
    }

    // MCP prompts from connected servers
    let manager = state.mcp_manager.lock().await;
    let mcp_prompts = manager.all_prompts();
    for (server_name, prompt) in mcp_prompts {
        let args_json = serde_json::to_string(&prompt.arguments)
            .unwrap_or_else(|_| "[]".to_string());
        items.push(SlashItemDto {
            item_type: "mcp_prompt".to_string(),
            name: prompt.name.clone(),
            display_name: prompt.name,
            description: prompt.description.unwrap_or_default(),
            arguments_json: args_json,
            server_name: Some(server_name),
        });
    }

    Ok(items)
}

/// Execute an MCP prompt by server name + prompt name.
#[tauri::command]
pub async fn execute_mcp_prompt(
    state: State<'_, AppState>,
    server_name: String,
    prompt_name: String,
    arguments_json: String,
) -> Result<String, AppError> {
    let args: std::collections::HashMap<String, String> =
        serde_json::from_str(&arguments_json).unwrap_or_default();

    let mut manager = state.mcp_manager.lock().await;
    let messages = manager
        .get_prompt(&server_name, &prompt_name, args)
        .await
        .map_err(|e| AppError::invalid_argument(&e))?;

    let texts: Vec<String> = messages
        .iter()
        .filter_map(|m| match &m.content {
            crate::services::mcp_client::McpPromptContent::Text { text } => Some(text.clone()),
        })
        .collect();

    Ok(texts.join("\n\n"))
}

/// Return (and create if needed) the skills directory path under app data.
#[tauri::command]
pub async fn get_skills_directory(state: State<'_, AppState>) -> Result<String, AppError> {
    let app_data = state.app_handle.path().app_data_dir()
        .map_err(|e| AppError::invalid_argument(&format!("Failed to resolve app data dir: {e}")))?;
    let dir = crate::services::skill_fs::skills_root_from_app_data(&app_data);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::db_error(&format!("Failed to create skills dir: {e}")))?;
    Ok(dir.to_string_lossy().to_string())
}

// ============================================================================
// Context Compression
// ============================================================================

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressContextDto {
    pub compressed_id: String,
    pub summary_text: String,
    pub compressed_message_count: u32,
    pub estimated_tokens: u32,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
}

#[tauri::command]
pub async fn compress_context(
    state: State<'_, AppState>,
    conversation_id: String,
    branch_id: String,
    model_id: String,
) -> Result<CompressContextDto, AppError> {
    let result = match crate::services::helper_ai_service::compress_context(
        &state, &conversation_id, &branch_id, &model_id,
    )
    .await
    {
        Ok(result) => result,
        Err(error) if is_expected_compression_noop(&error) => {
            let skip_reason = error.message.clone();
            tracing::info!(
                conversation_id = %conversation_id,
                branch_id = %branch_id,
                reason = %skip_reason,
                "compress_context: no-op"
            );
            return Ok(CompressContextDto {
                compressed_id: String::new(),
                summary_text: String::new(),
                compressed_message_count: 0,
                estimated_tokens: 0,
                skipped: true,
                skip_reason: Some(skip_reason),
            });
        }
        Err(error) => return Err(error),
    };

    Ok(CompressContextDto {
        compressed_id: result.compressed_id,
        summary_text: result.summary_text,
        compressed_message_count: result.compressed_message_count,
        estimated_tokens: result.estimated_tokens,
        skipped: false,
        skip_reason: None,
    })
}

fn is_expected_compression_noop(error: &AppError) -> bool {
    matches!(&error.code, crate::error::AppErrorCode::InvalidArgument)
        && matches!(
            error.message.as_str(),
            "No compressible content"
                | "Context usage is below compression threshold"
                | "Not enough messages to compress"
                | "Branch has no messages"
        )
}
