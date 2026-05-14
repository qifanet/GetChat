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

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::repositories::messages;

// ============================================================================
// Output Types
// ============================================================================

/**
 * A single message in the prompt array sent to the model API.
 * Lightweight: only role and text, no tree metadata.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMessage {
    pub role: String,
    pub content: String,
}

// ============================================================================
// Prompt Building
// ============================================================================

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
 * TODO: Implement max_tokens_budget trimming (needs token estimation).
 */
pub async fn build_prompt_messages(
    pool: &SqlitePool,
    input: &crate::dto::messages::BuildPromptMessagesInput,
) -> Result<Vec<PromptMessage>, AppError> {
    // Load all messages for the conversation (one query, then walk in memory)
    let all_rows = messages::list_by_conversation(pool, &input.conversation_id).await?;

    if all_rows.is_empty() {
        return Ok(vec![]);
    }

    // Build a lookup map for fast parent chain walking
    let msg_map: std::collections::HashMap<String, &messages::MessageRow> =
        all_rows.iter().map(|r| (r.id.clone(), r)).collect();

    // Walk from leaf to root
    let mut path = Vec::new();
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
                // Include only messages suitable for prompt
                let include = match row.status.as_str() {
                    "COMPLETED" => true,
                    "FAILED" => true, // Failed messages may have partial useful content
                    "STREAMING" => false,
                    "ABORTED" => false,
                    _ => false,
                };

                tracing::info!(
                    msg_id = %row.id,
                    role = %row.role,
                    status = %row.status,
                    parent_id = ?row.parent_message_id,
                    content_len = row.content_text.len(),
                    include,
                    "walk_step"
                );

                if include && !row.content_text.is_empty() {
                    path.push(PromptMessage {
                        role: row.role.clone(),
                        content: row.content_text.clone(),
                    });
                }

                current_id = row.parent_message_id.as_deref();
            }
            None => {
                tracing::warn!(
                    current_id = %id,
                    "walk_broken_chain: message not found in conversation"
                );
                break; // Broken chain — stop walking
            }
        }
    }

    // Reverse: root first → leaf last (chronological order for the API)
    path.reverse();

    Ok(path)
}
