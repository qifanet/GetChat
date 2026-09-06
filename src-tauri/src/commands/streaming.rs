/**
 * @file commands/streaming.rs
 * @description Runtime model streaming command shells (v1.5.0 M1.3).
 *
 * These commands do not mutate persisted conversation entities directly.
 * Instead, they bridge provider HTTP streams into frontend channel events while
 * the frontend continues to own placeholder creation, completion, and failure
 * persistence through the existing message commands.
 *
 * The ReAct loop itself (Reason + Act: stream → tool_calls → execute →
 * re-stream) lives in `agent/runner.rs`; mid-loop context compression lives in
 * `agent/context.rs`; prompt composition lives in `agent/prompt.rs`. This
 * module keeps only the Tauri command boundary: stream start/abort, tool
 * definitions/settings, approval resolution, security policy, context status,
 * explicit compression, and mid-stream user-message injection.
 */

use std::collections::HashSet;

use tauri::{ipc::Channel, Manager, State};
use tokio::sync::watch;

use crate::agent::deps::{CompressionBackend, McpBackend, ReactLoopDeps, StreamBackend};
use crate::agent::runner::{run_react_loop, ReactLoopOutcome};
use crate::dto::common::ToolDefinitionDto;
use crate::dto::streaming::{ModelStreamEventDto, StartModelStreamInput};
use crate::error::AppError;
use crate::services::model_stream_service;
use crate::state::{AppState, BUILTIN_DISABLED_TOOLS_KV_KEY, TOOL_LIMITS_KV_KEY};

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
    let defs = build_backend_enabled_tool_definitions(state.inner()).await;
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
pub(crate) async fn build_backend_enabled_tool_definitions(state: &AppState) -> Vec<ToolDefinitionDto> {
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
) -> Result<Vec<crate::agent::tools::ToolStateDto>, AppError> {
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

    // M4 per-conversation stream lock (A1): one stream per conversation keeps
    // message-tree write ordering; different conversations stream in parallel.
    let mut active_streams = state.active_model_streams.lock().await;
    let conflict = active_streams
        .iter()
        .find(|(_, active)| active.conversation_id == input.conversation_id)
        .map(|(active_request_id, _)| active_request_id.clone());
    if let Some(active_request_id) = conflict {
        let message = if active_request_id == request_id {
            "A stream with the same requestId is already active".to_string()
        } else {
            format!("Another model stream is already active in this conversation: {active_request_id}")
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
    active_streams.insert(
        request_id.clone(),
        crate::state::ActiveModelStream {
            conversation_id: input.conversation_id.clone(),
            cancel: cancel_tx,
        },
    );
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
    let session = crate::agent::session::new_shared_session();
    state
        .agent_sessions
        .lock()
        .await
        .insert(request_id.clone(), session.clone());
    let deps = build_react_loop_deps(state.inner(), session).await;
    let tool_limits = state.tool_limits.lock().await.clone();
    let result = run_react_loop(
        &deps,
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
    state.agent_sessions.lock().await.remove(&request_id);

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
        active_streams.get(&request_id).map(|active| active.cancel.clone())
    };

    if let Some(sender) = sender {
        let _ = sender.send(true);
    }

    tracing::info!(cmd = "abort_model_stream", request_id = %request_id, "ok");
    Ok(())
}

async fn release_pending_model_stream_gate(state: &State<'_, AppState>, request_id: &str) {
    // Gates are keyed by conversation; drop whichever entry this request owns.
    let mut pending = state.pending_model_stream.lock().await;
    pending.retain(|_, existing| existing.request_id != request_id);
}

/**
 * Resolve the ReAct loop's dependencies from Tauri-managed application state.
 * Tests build an equivalent `ReactLoopDeps` fixture instead of calling this.
 */
pub(crate) async fn build_react_loop_deps<'a>(
    state: &'a AppState,
    session: crate::agent::session::SharedAgentSession,
) -> ReactLoopDeps<'a> {
    ReactLoopDeps {
        db: state.db.clone(),
        tool_executor: state.tool_executor.clone(),
        tool_definitions: build_backend_enabled_tool_definitions(state).await,
        security_policy: state.security_policy.clone(),
        pending_approvals: state.pending_approvals.clone(),
        app_data_dir: state.app_handle.path().app_data_dir().ok(),
        mcp: McpBackend::Real(state.mcp_manager.clone()),
        stream: StreamBackend::Real,
        compression: CompressionBackend::Real(state),
        session,
        auditor: Some(std::sync::Arc::new(
            crate::agent::audit::SqliteRunAuditor::new(state.db.clone()),
        )),
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

    let tool_definitions = build_backend_enabled_tool_definitions(state.inner()).await;
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

// ============================================================================
// Explicit Context Compression
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
        Err(error) if crate::agent::context::is_expected_compression_noop(&error) => {
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

#[tauri::command]
pub async fn inject_user_message_to_stream(
    state: State<'_, AppState>,
    request_id: String,
    message: String,
) -> Result<(), AppError> {
    {
        let active_streams = state.active_model_streams.lock().await;
        if !active_streams.contains_key(&request_id) {
            return Err(AppError::invalid_argument(&format!(
                "No active stream found for request_id: {request_id}"
            )));
        }
    }
    // Push into this run's AgentSession — scoped by request_id, never shared
    // with other concurrent streams (M1 session-scoping).
    match state.agent_sessions.lock().await.get(&request_id).cloned() {
        Some(session) => {
            session.lock().await.injections.push(message);
            Ok(())
        }
        None => Err(AppError::invalid_argument(&format!(
            "No agent session found for request_id: {request_id}"
        ))),
    }
}

/**
 * Withdraw a not-yet-consumed Dual-Queue injection (C13 cancel).
 *
 * Returns false when the session already drained the entry (the model is
 * already processing it) or no session exists — the frontend surfaces this as
 * "too late to cancel" and leaves the recorded supplement in place.
 */
#[tauri::command]
pub async fn cancel_injected_message(
    state: State<'_, AppState>,
    request_id: String,
    message: String,
) -> Result<bool, AppError> {
    let session = state
        .agent_sessions
        .lock()
        .await
        .get(&request_id)
        .cloned();
    match session {
        Some(session) => {
            let cancelled =
                crate::agent::session::cancel_injection(&session, &message).await;
            if cancelled {
                tracing::info!(
                    cmd = "cancel_injected_message",
                    request_id = %request_id,
                    "injection withdrawn"
                );
            }
            Ok(cancelled)
        }
        None => Ok(false),
    }
}
