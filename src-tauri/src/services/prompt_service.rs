/**
 * @file services/prompt_service.rs
 * @description Builds the prompt message array by walking the message tree
 *              from a leaf message back to the root.
 *
 * Key responsibilities:
 *   - Walk parent chain from leaf to root
 *   - Reverse to chronological order (root first)
 *   - Filter out messages that shouldn't enter the prompt:
 *     - STREAMING messages (incomplete)
 *     - ABORTED messages (user cancelled)
 *   - Respect max_tokens_budget (placeholder for future token counting)
 *
 * Returns a lightweight PromptMessage struct (role + text) suitable for
 * direct serialization to any model API format.
 */

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::dto::common::ToolCallDto;
use crate::error::AppError;
use crate::repositories::{compressed_contexts, messages, tool_calls};
use crate::services::skill_fs;
use crate::services::system_prompt_service;
use crate::services::token_estimator::estimate_prompt_message_tokens;

// ============================================================================
// Output Types
// ============================================================================

/**
 * A single message in the prompt array sent to the model API.
 * Extended to support tool_calls and tool results for the ReAct loop.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMessage {
    /// Source DB message id when this prompt entry comes from a persisted message.
    /// Synthetic system prefixes have no source id and must not be used as
    /// compressed-context traceability records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

fn prompt_group_tokens(group: &[PromptMessage]) -> u32 {
    group.iter().map(estimate_prompt_message_tokens).sum()
}

fn flatten_prompt(prefix_messages: Vec<PromptMessage>, message_groups: Vec<Vec<PromptMessage>>) -> Vec<PromptMessage> {
    let message_count: usize = message_groups.iter().map(Vec::len).sum();
    let mut result = Vec::with_capacity(prefix_messages.len() + message_count);
    result.extend(prefix_messages);
    for mut group in message_groups {
        result.append(&mut group);
    }
    result
}

fn apply_prompt_budget(
    prefix_messages: Vec<PromptMessage>,
    message_groups: Vec<Vec<PromptMessage>>,
    max_tokens_budget: Option<i32>,
) -> Vec<PromptMessage> {
    let Some(max_tokens_budget) = max_tokens_budget else {
        return flatten_prompt(prefix_messages, message_groups);
    };

    if max_tokens_budget <= 0 || message_groups.is_empty() {
        return flatten_prompt(prefix_messages, message_groups);
    }

    let budget = max_tokens_budget as u32;
    let prefix_tokens = prompt_group_tokens(&prefix_messages);
    let mut used_tokens = prefix_tokens;
    let mut kept_reversed: Vec<Vec<PromptMessage>> = Vec::new();
    let mut dropped_groups = 0usize;
    let mut dropped_tokens = 0u32;

    for (index, group) in message_groups.into_iter().enumerate().rev() {
        let group_tokens = prompt_group_tokens(&group);
        let is_latest_group = kept_reversed.is_empty();
        if is_latest_group || used_tokens.saturating_add(group_tokens) <= budget {
            used_tokens = used_tokens.saturating_add(group_tokens);
            kept_reversed.push(group);
        } else {
            dropped_groups += 1;
            dropped_tokens = dropped_tokens.saturating_add(group_tokens);
            tracing::debug!(
                group_index = index,
                group_tokens,
                budget,
                used_tokens,
                "build_prompt_messages: dropping older prompt group for token budget"
            );
        }
    }

    if dropped_groups > 0 {
        tracing::warn!(
            max_tokens_budget = budget,
            prefix_tokens,
            final_tokens = used_tokens,
            dropped_groups,
            dropped_tokens,
            "build_prompt_messages: prompt trimmed to fit configured token budget"
        );
    }

    kept_reversed.reverse();
    flatten_prompt(prefix_messages, kept_reversed)
}

// ============================================================================
// Prompt Building
// ============================================================================

/// Load skill metadata (Tier 1) from filesystem for system prompt injection.
/// Scans `{app_data}/skills/` for SKILL.md files and builds a compact
/// `[Available Skills]` block with name + description for model discovery.
fn load_skill_metadata_prompt(skills_dir: &std::path::Path) -> String {
    let skills = skill_fs::discover_skills(skills_dir);
    skill_fs::build_skill_metadata_prompt(&skills)
}

/**
 * Build the prompt message array by walking the tree from a leaf to root.
 *
 * Algorithm:
 *   1. Start at up_to_message_id
 *   2. Walk parent_message_id chain until root (parent = NULL)
 *   3. Reverse the collected list (root first → leaf last)
 *   4. Filter: exclude STREAMING and ABORTED messages
 *
 * Domain rules:
 *   - Only COMPLETED messages enter the prompt
 *   - FAILED messages with partial content CAN be included (they have text)
 *   - STREAMING messages are excluded (content is incomplete)
 *   - ABORTED messages are excluded (user intentionally stopped)
 *
 * max_tokens_budget is applied after compressed-context injection. Synthetic
 * prefixes are preserved, and older persisted message groups are dropped from
 * the front while keeping the latest user turn intact.
 */
pub async fn build_prompt_messages(
    pool: &SqlitePool,
    input: &crate::dto::messages::BuildPromptMessagesInput,
) -> Result<Vec<PromptMessage>, AppError> {
    let all_rows = messages::list_by_conversation(pool, &input.conversation_id).await?;

    if all_rows.is_empty() {
        return Ok(vec![]);
    }

    let msg_map: HashMap<String, &messages::MessageRow> =
        all_rows.iter().map(|r| (r.id.clone(), r)).collect();

    // Walk from leaf to root
    let mut path_ids: Vec<String> = Vec::new();
    let mut current_id = Some(input.up_to_message_id.as_str());

    tracing::info!(
        conv_id = %input.conversation_id,
        up_to_msg_id = %input.up_to_message_id,
        total_msgs_in_conversation = all_rows.len(),
        "build_prompt_messages: starting walk"
    );

    while let Some(id) = current_id {
        match msg_map.get(id) {
            Some(row) => {
                let include = match row.status.as_str() {
                    "COMPLETED" => true,
                    "FAILED" => true,
                    "STREAMING" => false,
                    "ABORTED" => false,
                    _ => false,
                };

                tracing::debug!(
                    msg_id = %row.id,
                    role = %row.role,
                    status = %row.status,
                    parent_id = ?row.parent_message_id,
                    content_len = row.content_text.len(),
                    include,
                    "walk_step"
                );

                if include {
                    // TOOL_RESULT messages may have empty content_text but are still valid
                    let is_tool_result = row.content_type == "TOOL_RESULT";
                    if !row.content_text.is_empty() || is_tool_result {
                        path_ids.push(row.id.clone());
                    }
                }

                current_id = row.parent_message_id.as_deref();
            }
            None => {
                tracing::warn!(
                    current_id = %id,
                    "walk_broken_chain: message not found in conversation"
                );
                break;
            }
        }
    }

    // Reverse: root first → leaf last
    path_ids.reverse();

    // Inject stable system-level prefixes first for provider prompt-cache friendliness.
    let mut prefix_messages: Vec<PromptMessage> = Vec::new();
    let system_prompt = system_prompt_service::get_system_prompt(pool).await?;
    if !system_prompt.is_empty() {
        prefix_messages.push(PromptMessage {
            source_message_id: None,
            role: "SYSTEM".to_string(),
            content: system_prompt,
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
        });
    }

    let skills_prompt = match &input.skills_dir {
        Some(dir) => load_skill_metadata_prompt(std::path::Path::new(dir)),
        None => String::new(),
    };
    if !skills_prompt.is_empty() {
        if let Some(last_system) = prefix_messages.last_mut() {
            last_system.content.push_str("\n\n");
            last_system.content.push_str(&skills_prompt);
        } else {
            prefix_messages.push(PromptMessage {
                source_message_id: None,
                role: "SYSTEM".to_string(),
                content: skills_prompt,
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
        }
    }

    // Tier 3: If user activated a skill via slash command, inject activation hint
    if let Some(ref skill_name) = input.activated_skill {
        let hint = skill_fs::build_skill_activation_hint(skill_name);
        if let Some(last_system) = prefix_messages.last_mut() {
            last_system.content.push_str("\n\n");
            last_system.content.push_str(&hint);
        } else {
            prefix_messages.push(PromptMessage {
                source_message_id: None,
                role: "SYSTEM".to_string(),
                content: hint,
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
        }
    }

    let mut compressed_source_ids: HashSet<String> = HashSet::new();

    if let Some(ref branch_id) = input.branch_id {
        if let Ok(Some(cc)) = compressed_contexts::find_latest_by_branch(
            pool, &input.conversation_id, branch_id,
        ).await {
            match serde_json::from_str::<Vec<String>>(&cc.compressed_message_ids) {
                Ok(ids) if !ids.is_empty() => {
                    compressed_source_ids.extend(ids);
                    if !cc.summary_text.is_empty() {
                        tracing::info!(
                            conv_id = %input.conversation_id,
                            branch_id = %branch_id,
                            compressed_id = %cc.id,
                            summary_len = cc.summary_text.len(),
                            compressed_ids = compressed_source_ids.len(),
                            "build_prompt_messages: injecting compressed context"
                        );
                        prefix_messages.push(PromptMessage {
                            source_message_id: None,
                            role: "SYSTEM".to_string(),
                            content: format!("[Compressed Context Summary]\n{}", cc.summary_text),
                            reasoning_content: None,
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                        });
                    }
                }
                Ok(_) => tracing::warn!(
                    conv_id = %input.conversation_id,
                    branch_id = %branch_id,
                    compressed_id = %cc.id,
                    "build_prompt_messages: ignored compressed context with empty message id set"
                ),
                Err(error) => tracing::warn!(
                    conv_id = %input.conversation_id,
                    branch_id = %branch_id,
                    compressed_id = %cc.id,
                    error = %error,
                    "build_prompt_messages: ignored compressed context with invalid message ids"
                ),
            }
        }
    }

    // Build prompt groups with tool_calls enrichment. A group maps to one
    // persisted message so budget trimming never splits assistant tool calls
    // from their rehydrated tool results.
    let mut message_groups: Vec<Vec<PromptMessage>> = Vec::with_capacity(path_ids.len());
    for msg_id in &path_ids {
        if compressed_source_ids.contains(msg_id) {
            tracing::debug!(
                msg_id = %msg_id,
                "build_prompt_messages: skipping raw message covered by compressed context"
            );
            continue;
        }

        let row = msg_map[msg_id].clone();

        let prompt_msg = match row.role.as_str() {
            "TOOL" => {
                // Tool result message: role=tool, with tool_call_id and name
                PromptMessage {
                    source_message_id: Some(row.id.clone()),
                    role: "TOOL".to_string(),
                    content: row.content_text.clone(),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: row.tool_call_id.clone(),
                    name: row.tool_name.clone(),
                }
            }
            "ASSISTANT" => {
                // Check for associated tool_calls
                let tc_rows = tool_calls::list_by_message(pool, &row.id).await.unwrap_or_default();
                let tool_calls_dto: Vec<ToolCallDto> = tc_rows.iter().map(|tc| {
                    ToolCallDto {
                        id: tc.call_id.clone(),
                        call_type: "function".to_string(),
                        function: crate::dto::common::ToolCallFunctionDto {
                            name: tc.function_name.clone(),
                            arguments: tc.arguments_json.clone(),
                        },
                    }
                }).collect();

                let mut group = vec![PromptMessage {
                    source_message_id: Some(row.id.clone()),
                    role: "ASSISTANT".to_string(),
                    content: row.content_text.clone(),
                    reasoning_content: if row.reasoning_content.trim().is_empty() {
                        None
                    } else {
                        Some(row.reasoning_content.clone())
                    },
                    tool_calls: if tool_calls_dto.is_empty() { None } else { Some(tool_calls_dto) },
                    tool_call_id: None,
                    name: None,
                }];

                // Persisted tool results are stored in tool_calls.result_json.
                // Rehydrate them as role=TOOL prompt entries so the next model
                // turn sees a valid tool-call transcript.
                for tc in tc_rows {
                    if tc.result_json.is_empty() && tc.status == "PENDING" {
                        continue;
                    }
                    group.push(PromptMessage {
                        source_message_id: Some(row.id.clone()),
                        role: "TOOL".to_string(),
                        content: tc.result_json,
                        reasoning_content: None,
                        tool_calls: None,
                        tool_call_id: Some(tc.call_id),
                        name: Some(tc.function_name),
                    });
                }

                message_groups.push(group);
                continue;
            }
            _ => {
                // USER or SYSTEM — standard role + content
                PromptMessage {
                    source_message_id: Some(row.id.clone()),
                    role: row.role.clone(),
                    content: row.content_text.clone(),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                }
            }
        };

        message_groups.push(vec![prompt_msg]);
    }

    Ok(apply_prompt_budget(
        prefix_messages,
        message_groups,
        input.max_tokens_budget,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_msg(id: &str, role: &str, content: &str) -> PromptMessage {
        PromptMessage {
            source_message_id: Some(id.to_string()),
            role: role.to_string(),
            content: content.to_string(),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    #[test]
    fn budget_trimming_preserves_latest_group() {
        let older = vec![test_msg("old", "USER", &"older context ".repeat(200))];
        let latest = vec![test_msg("latest", "USER", "current question")];

        let result = apply_prompt_budget(vec![], vec![older, latest], Some(20));

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source_message_id.as_deref(), Some("latest"));
    }

    #[test]
    fn budget_trimming_keeps_assistant_tool_group_together() {
        let older = vec![test_msg("old", "USER", &"older context ".repeat(200))];
        let assistant_group = vec![
            test_msg("assistant", "ASSISTANT", "I will call a tool"),
            PromptMessage {
                source_message_id: Some("assistant".to_string()),
                role: "TOOL".to_string(),
                content: "{\"ok\":true}".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: Some("call_1".to_string()),
                name: Some("demo_tool".to_string()),
            },
        ];

        let result = apply_prompt_budget(vec![], vec![older, assistant_group], Some(20));

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].role, "ASSISTANT");
        assert_eq!(result[1].role, "TOOL");
        assert_eq!(result[1].tool_call_id.as_deref(), Some("call_1"));
    }
}
