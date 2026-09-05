/**
 * @file agent/runner.rs
 * @description The ReAct agent run loop (v1.5.0 M1.3).
 *
 * Verbatim relocation of the loop, tool execution, and approval policy that
 * used to live in `commands/streaming.rs`. The runner is a pure function of
 * `(deps, request, channel, cancel_rx)`:
 *
 *   - `deps: ReactLoopDeps` carries every external dependency (DB, executor,
 *     policy, sessions, model backend, compression backend)
 *   - events flow out through the Tauri channel exactly as before
 *   - the golden replay cases in `agent/eval/cases.rs` lock the behavior
 *
 * Termination conditions (unchanged):
 *   - Model responds with a normal completion (finish_reason != "tool_calls")
 *   - Model responds with no tool_calls
 *   - Max iterations exceeded (soft stop, no-tools final response)
 *   - Max consecutive tool failures (soft stop)
 *   - Cancellation requested via cancel_rx
 *   - Stream error from provider
 */

use std::collections::HashSet;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::agent::context::maybe_compress_react_prompt;
use crate::agent::deps::{McpBackend, ReactLoopDeps, StreamBackend};
use crate::agent::session;
use crate::dto::common::ToolCallDto;
use crate::dto::streaming::{ModelPromptMessageDto, ModelStreamEventDto};
use crate::services::model_stream_service::{
    self, ModelStreamFailure, ModelStreamOutcome, ResolvedModelStreamRequest,
};
use crate::agent::tools::{ToolExecutionContext, ToolExecutionResult};

pub(crate) const TOOL_EXECUTION_TIMEOUT_SECONDS: u64 = 60;

/** Terminal outcome of the ReAct Loop. */
#[derive(Debug)]
pub(crate) enum ReactLoopOutcome {
    Completed {
        usage: Option<crate::dto::common::TokenUsageDto>,
        reasoning_content: Option<String>,
    },
    Cancelled,
}

/**
 * Route one model request to the configured backend: the real provider HTTP
 * stack in production, or the scripted golden-harness model in tests.
 * Introduced in M0 so the loop body has a single seam for all model calls.
 */
async fn dispatch_stream(
    deps: &ReactLoopDeps<'_>,
    request: &ResolvedModelStreamRequest,
    channel: &Channel<ModelStreamEventDto>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<ModelStreamOutcome, ModelStreamFailure> {
    match &deps.stream {
        StreamBackend::Real => {
            model_stream_service::stream_model_response(request, channel, cancel_rx).await
        }
        StreamBackend::Scripted(model) => model.respond(request, channel, cancel_rx).await,
    }
}

async fn stream_final_response_without_tools(
    deps: &ReactLoopDeps<'_>,
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

    match dispatch_stream(deps, &final_request, channel, cancel_rx).await {
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

pub(crate) async fn run_react_loop(
    deps: &ReactLoopDeps<'_>,
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
    let current_tools = deps.tool_definitions.clone();
    let allowed_tool_names: HashSet<String> = current_tools
        .iter()
        .map(|tool| tool.function.name.clone())
        .collect();
    let current_tool_choice = initial_request.tool_choice.clone();

    // Resolve context window size for mid-loop compression checks.
    let context_window_kb: i32 = crate::repositories::provider_models::find_by_id(&deps.db, &model_id)
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

    let shell_path = crate::repositories::app_kv::get(&deps.db, "shell_path")
        .await
        .ok()
        .flatten()
        .map(|raw| serde_json::from_str::<String>(&raw).unwrap_or_else(|_| raw.trim_matches('"').to_string()))
        .filter(|s| !s.is_empty());
    let tool_context = ToolExecutionContext {
        conversation_id: conversation_id.clone(),
        workspace_path: initial_request.workspace_path.clone(),
        shell_path,
        skills_dir: deps.app_data_dir.as_ref().map(|p| {
            crate::services::skill_fs::skills_root_from_app_data(p).to_string_lossy().to_string()
        }),
        db_pool: Some(deps.db.clone()),
    };
    let mut consecutive_tool_failures = 0u32;

    // Compose tool guidance, skill metadata, and the activation hint into the
    // prompt (M1.4: relocated verbatim to agent/prompt.rs).
    crate::agent::prompt::inject_prompt_context(
        &mut prompt_messages,
        &current_tools,
        initial_request.workspace_path.as_deref(),
        deps.app_data_dir.as_deref(),
        initial_request.activated_skill.as_deref(),
    );

    for iteration in 0..max_iterations {
        // Check cancellation
        if *cancel_rx.borrow() {
            return Ok(ReactLoopOutcome::Cancelled);
        }

        maybe_compress_react_prompt(
            deps,
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

            match dispatch_stream(deps, &request, channel, cancel_rx.clone()).await {
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

                    let security_policy = deps.security_policy.lock().await.clone();
                    let requires_approval = requires_tool_approval(&tc.function.name, &tc.function.arguments, &security_policy);
                    drop(security_policy);

                    let result = if requires_approval {
                        // Request user approval via oneshot channel
                        let approval_id = format!("{}_{}", request_id, tc.id);
                        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

                        // Register the pending approval
                        {
                            let mut pending = deps.pending_approvals.lock().await;
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
                            let mut pending = deps.pending_approvals.lock().await;
                            pending.remove(&approval_id);
                        }

                        if approved {
                            match execute_tool_checked(
                                deps,
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
                            crate::agent::tools::ToolExecutionResult {
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
                            crate::agent::tools::ToolExecutionResult {
                                success: false,
                                output: "User explicitly rejected this operation.".to_string(),
                            }
                        }
                    } else {
                        // Normal tool — execute directly (with MCP routing)
                        match execute_tool_checked(
                            deps,
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
                            deps,
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
                                deps,
                                &initial_request,
                                prompt_messages,
                                channel,
                                cancel_rx,
                            )
                            .await;
                        }
                    }
                }

                // Drain this run's inject queue and append as user messages
                // (Dual-Queue injection) — scoped to this session (M1).
                let injected = session::drain_injections(&deps.session).await;
                if !injected.is_empty() {
                    for msg in &injected {
                        let _ = channel.send(ModelStreamEventDto::UserInjected {
                            request_id: request_id.clone(),
                            content: msg.clone(),
                        });
                        prompt_messages.push(ModelPromptMessageDto {
                            source_message_id: None,
                            role: "user".to_string(),
                            content: format!("[User supplement] {}", msg),
                            reasoning_content: None,
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                        });
                        tracing::info!(
                            request_id = %request_id,
                            content = %msg,
                            "injected user message at tool boundary"
                        );
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

    match dispatch_stream(deps, &final_request, channel, cancel_rx).await
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

/** Execute a tool by name, routing to MCP if it has the `mcp__` prefix. */
async fn execute_tool_with_mcp(
    deps: &ReactLoopDeps<'_>,
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
    let result = deps
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
            let enabled = crate::repositories::mcp_servers::list_all(&deps.db)
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
            let McpBackend::Real(manager) = &deps.mcp else {
                return ToolExecutionResult {
                    success: false,
                    output: format!(
                        "MCP routing is unavailable in this context: {}",
                        tool_name
                    ),
                };
            };
            tracing::info!(
                server = server_name,
                tool = mcp_tool_name,
                "routing tool call to MCP server"
            );
            let args: serde_json::Value =
                serde_json::from_str(arguments).unwrap_or(serde_json::json!({}));
            let mut manager = manager.lock().await;
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
    deps: &ReactLoopDeps<'_>,
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
        result = execute_tool_with_mcp(deps, tool_name, arguments, context) => Ok(result),
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
