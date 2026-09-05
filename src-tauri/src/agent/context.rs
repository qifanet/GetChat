/**
 * @file agent/context.rs
 * @description Mid-loop context management for the agent run (v1.5.0 M1.3).
 *
 * Verbatim relocation of the compression stack that used to live in
 * `commands/streaming.rs`: budget checks, old-tool-result pruning, the
 * AI-powered mid-loop compression (via `helper_ai_service`), and the
 * deterministic fallback trim. M3 unifies these strategies behind a single
 * budget ledger (`agent/context/ContextManager`, ARCHITECTURE.md §4.2).
 *
 * All functions here are behavior-preserving relocations; the golden replay
 * cases in `agent/eval/cases.rs` guard the observable behavior.
 */

use std::collections::HashSet;

use tauri::ipc::Channel;

use crate::agent::deps::{CompressionBackend, ReactLoopDeps};
use crate::dto::common::ToolDefinitionDto;
use crate::dto::streaming::{ModelPromptMessageDto, ModelStreamEventDto};
use crate::error::AppError;

/** True when the error is an expected "nothing to compress" condition. */
pub(crate) fn is_expected_compression_noop(error: &AppError) -> bool {
    matches!(&error.code, crate::error::AppErrorCode::InvalidArgument)
        && matches!(
            error.message.as_str(),
            "No compressible content"
                | "Context usage is below compression threshold"
                | "Not enough messages to compress"
                | "Branch has no messages"
        )
}

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

async fn mid_loop_compress(
    deps: &ReactLoopDeps<'_>,
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
    // Golden-test backends carry no compression hook and skip this pass.
    let compress_result = match &deps.compression {
        CompressionBackend::Real(state) => {
            crate::services::helper_ai_service::compress_context(
                state,
                conversation_id,
                branch_id,
                model_id,
            )
            .await
        }
        CompressionBackend::Disabled => {
            tracing::debug!("mid_loop_compress: compression disabled, skipping AI pass");
            return Ok(None);
        }
    };

    match compress_result {
        Ok(result) => {
            let compressed_source_ids: HashSet<String> = crate::repositories::compressed_contexts::find_latest_by_branch(
                &deps.db,
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

/** Layer-0 prune + budget check + (when over threshold) AI compression pass. */
pub(crate) async fn maybe_compress_react_prompt(
    deps: &ReactLoopDeps<'_>,
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
        deps,
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
