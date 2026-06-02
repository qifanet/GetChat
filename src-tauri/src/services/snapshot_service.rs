/**
 * @file services/snapshot_service.rs
 * @description Core service for conversation operations: snapshot assembly,
 *              message creation, branch management, and domain validation.
 *
 * This service orchestrates repository calls within transactions and handles:
 *   - DB row → DTO mapping (timestamp seconds → milliseconds)
 *   - Runtime index construction (childIds, branchIdsByForkPointId)
 *   - Domain rule enforcement (non-destructive edits, variant rules)
 *   - is_mainline derivation from conversations.mainline_branch_id
 *
 * Required dependencies: sqlx, uuid, serde_json, crate::dto, crate::error, crate::repositories
 */

use std::collections::{HashMap, HashSet};

use sqlx::SqlitePool;

use crate::dto::common::*;
use crate::dto::conversations::*;
use crate::dto::messages::*;
use crate::dto::branches::BranchDto;
use crate::error::AppError;
use crate::repositories::{branches, compressed_contexts, conversations, messages, tool_calls};

// ============================================================================
// Helpers
// ============================================================================

/** Current Unix timestamp in seconds. */
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System clock before UNIX epoch")
        .as_secs() as i64
}

/** Parse a string to MessageRole. Panics on invalid value — DB is the source of truth. */
fn parse_role(s: &str) -> MessageRole {
    match s {
        "USER" => MessageRole::User,
        "ASSISTANT" => MessageRole::Assistant,
        "SYSTEM" => MessageRole::System,
        _ => MessageRole::User,
    }
}

/** Parse a string to MessageStatus. */
fn parse_status(s: &str) -> MessageStatus {
    match s {
        "PENDING" => MessageStatus::Pending,
        "STREAMING" => MessageStatus::Streaming,
        "COMPLETED" => MessageStatus::Completed,
        "FAILED" => MessageStatus::Failed,
        "ABORTED" => MessageStatus::Aborted,
        _ => MessageStatus::Completed,
    }
}

/** Parse a string to ContentFormat. */
fn parse_format(s: &str) -> ContentFormat {
    match s {
        "PLAIN" => ContentFormat::Plain,
        _ => ContentFormat::Markdown,
    }
}

/** Parse a string to BranchStatus. */
fn parse_branch_status(s: &str) -> BranchStatus {
    match s {
        "ARCHIVED" => BranchStatus::Archived,
        _ => BranchStatus::Active,
    }
}

/** Parse a string to ForkSourceType. */
fn parse_fork_source_type(s: &str) -> ForkSourceType {
    match s {
        "ROOT" => ForkSourceType::Root,
        "CURRENT_LEAF" => ForkSourceType::CurrentLeaf,
        "HISTORY_ASSISTANT" => ForkSourceType::HistoryAssistant,
        "HISTORY_USER_EDIT" => ForkSourceType::HistoryUserEdit,
        "VARIANT" => ForkSourceType::Variant,
        _ => ForkSourceType::CurrentLeaf,
    }
}

/** Map a MessageRow to MessageDto with pre-computed child_ids. */
fn map_message_row(row: &messages::MessageRow, child_ids: Vec<String>) -> MessageDto {
    let generation = if row.provider_id.is_some() {
        Some(MessageGenerationDto {
            provider_id: row.provider_id.clone().unwrap(),
            model_id: row.model_id.clone().unwrap(),
            request_id: row.request_id.clone(),
            params: serde_json::from_str(&row.generation_params_json).ok(),
            usage: serde_json::from_str(&row.usage_json).ok(),
        })
    } else {
        None
    };

    let error = row.error_code.as_ref().map(|code| MessageErrorDto {
        code: code.clone(),
        message: row.error_message.clone().unwrap_or_default(),
        retriable: row.error_retriable == Some(1),
    });

    let blocks = if row.content_blocks_json.trim().is_empty() {
        None
    } else {
        serde_json::from_str::<Vec<ContentBlockDto>>(&row.content_blocks_json)
            .ok()
            .filter(|blocks| !blocks.is_empty())
    };

    MessageDto {
        id: row.id.clone(),
        conversation_id: row.conversation_id.clone(),
        role: parse_role(&row.role),
        status: parse_status(&row.status),
        parent_id: row.parent_message_id.clone(),
        child_ids,
        depth: row.depth,
        content: MessageContentDto {
            text: row.content_text.clone(),
            format: parse_format(&row.content_format),
            blocks,
        },
        created_at: row.created_at * 1000,
        updated_at: row.updated_at * 1000,
        generation,
        error,
        edited_from_message_id: row.edited_from_message_id.clone(),
        tool_calls: None,
    }
}

/** Map a MessageRow to MessageDto with optional tool calls. */
fn map_message_row_with_tool_calls(
    row: &messages::MessageRow,
    child_ids: Vec<String>,
    tool_call_dtos: Option<Vec<crate::dto::common::ToolCallResultDto>>,
) -> MessageDto {
    let mut dto = map_message_row(row, child_ids);
    dto.tool_calls = tool_call_dtos;
    dto
}

/** Map a BranchRow to BranchDto with computed is_mainline. Public for command reuse. */
pub fn map_branch_row_public(row: &branches::BranchRow, is_mainline: bool) -> BranchDto {
    BranchDto {
        id: row.id.clone(),
        conversation_id: row.conversation_id.clone(),
        name: row.name.clone(),
        status: parse_branch_status(&row.status),
        is_mainline,
        source_branch_id: row.source_branch_id.clone(),
        fork_point_message_id: row.fork_point_message_id.clone(),
        fork_source_type: parse_fork_source_type(&row.fork_source_type),
        fork_source_message_id: row.fork_source_message_id.clone(),
        head_message_id: row.head_message_id.clone(),
        preferred_model_id: if row.preferred_model_id.is_empty() {
            None
        } else {
            Some(row.preferred_model_id.clone())
        },
        color: if row.color.is_empty() {
            None
        } else {
            Some(row.color.clone())
        },
        summary: if row.summary.is_empty() {
            None
        } else {
            Some(row.summary.clone())
        },
        created_at: row.created_at * 1000,
        updated_at: row.updated_at * 1000,
        archived_at: row.archived_at.map(|t| t * 1000),
    }
}

// ============================================================================
// Public API: Read Operations
// ============================================================================

/** List all conversation summaries for the sidebar. */
pub async fn list_conversation_summaries(
    pool: &SqlitePool,
) -> Result<Vec<ConversationSummaryDto>, AppError> {
    let rows = conversations::list_summaries(pool).await?;

    Ok(rows
        .into_iter()
        .map(|r| ConversationSummaryDto {
            id: r.id,
            title: r.title,
            title_source: r.title_source,
            created_at: r.created_at * 1000,
            updated_at: r.updated_at * 1000,
            last_opened_at: Some(r.last_opened_at * 1000),
            archived_at: r.archived_at.map(|t| t * 1000),
            mainline_branch_id: r.mainline_branch_id,
            active_branch_count: r.active_branch_count,
            archived_branch_count: r.archived_branch_count,
            total_message_count: r.total_message_count,
            workspace_path: r.workspace_path,
        })
        .collect())
}

/** Get a single conversation summary by ID. Used by mutation commands to return canonical DTOs. */
pub async fn get_conversation_summary(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<ConversationSummaryDto, AppError> {
    let row = conversations::get_summary(pool, conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Conversation {} not found", conversation_id)))?;

    Ok(ConversationSummaryDto {
        id: row.id,
        title: row.title,
        title_source: row.title_source,
        created_at: row.created_at * 1000,
        updated_at: row.updated_at * 1000,
        last_opened_at: Some(row.last_opened_at * 1000),
        archived_at: row.archived_at.map(|t| t * 1000),
        mainline_branch_id: row.mainline_branch_id,
        active_branch_count: row.active_branch_count,
        archived_branch_count: row.archived_branch_count,
        total_message_count: row.total_message_count,
        workspace_path: row.workspace_path,
    })
}

/**
 * Load a full conversation snapshot with all entities and indexes.
 *
 * This is the main data-loading operation for opening a conversation.
 * Builds runtime indexes at load time:
 *   - childIds: inverted from parentId
 *   - rootMessageIds: messages with parentId = null
 *   - branchIdsByForkPointId: branches grouped by fork point
 */
pub async fn load_snapshot(
    pool: &SqlitePool,
    input: &LoadConversationSnapshotInput,
) -> Result<ConversationSnapshotDto, AppError> {
    // 1. Load conversation
    let conv = conversations::find_by_id(pool, &input.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Conversation {} not found", input.conversation_id)))?;

    // 2. Load all messages
    let message_rows = messages::list_by_conversation(pool, &input.conversation_id).await?;

    // 3. Load all branches
    let branch_rows = branches::list_by_conversation(pool, &input.conversation_id).await?;

    // 4. Build child index (parentId → sorted children by sibling_index)
    let mut child_map: HashMap<String, Vec<(i32, String)>> = HashMap::new();
    let mut root_message_ids = Vec::new();

    for row in &message_rows {
        match &row.parent_message_id {
            None => root_message_ids.push(row.id.clone()),
            Some(pid) => {
                child_map
                    .entry(pid.clone())
                    .or_default()
                    .push((row.sibling_index, row.id.clone()));
            }
        }
    }

    let mut child_message_ids_by_parent_id: HashMap<String, Vec<String>> = HashMap::new();
    for (pid, mut children) in child_map {
        children.sort_by_key(|(idx, _)| *idx);
        child_message_ids_by_parent_id.insert(
            pid,
            children.into_iter().map(|(_, id)| id).collect(),
        );
    }

    // 5. Build branch fork-point index
    let mut branch_ids_by_fork_point_id: HashMap<String, Vec<String>> = HashMap::new();
    for row in &branch_rows {
        if let Some(fp_id) = &row.fork_point_message_id {
            branch_ids_by_fork_point_id
                .entry(fp_id.clone())
                .or_default()
                .push(row.id.clone());
        }
    }

    // 6. Map message rows → DTOs
    let message_ids: Vec<String> = message_rows.iter().map(|r| r.id.clone()).collect();
    let message_dtos: HashMap<String, MessageDto> = message_rows
        .iter()
        .map(|row| {
            let child_ids = child_message_ids_by_parent_id
                .get(&row.id)
                .cloned()
                .unwrap_or_default();
            (row.id.clone(), map_message_row(row, child_ids))
        })
        .collect();

    // 6b. Load tool calls for all messages and attach to DTOs
    let tc_rows = tool_calls::list_by_conversation(pool, &message_ids).await.unwrap_or_default();
    let mut message_dtos = message_dtos;
    if !tc_rows.is_empty() {
        let mut tc_by_message: HashMap<String, Vec<crate::dto::common::ToolCallResultDto>> = HashMap::new();
        for r in tc_rows {
            tc_by_message.entry(r.message_id.clone()).or_default().push(
                crate::dto::common::ToolCallResultDto {
                    id: r.id,
                    call_id: r.call_id,
                    function_name: r.function_name,
                    arguments_json: r.arguments_json,
                    result_json: r.result_json,
                    status: r.status,
                    error_message: r.error_message,
                }
            );
        }
        for (msg_id, tcs) in tc_by_message {
            if let Some(dto) = message_dtos.get_mut(&msg_id) {
                dto.tool_calls = Some(tcs);
            }
        }
    }

    // 7. Map branch rows → DTOs (with is_mainline derivation)
    let branch_dtos: HashMap<String, BranchDto> = branch_rows
        .iter()
        .map(|row| {
            let is_mainline = conv.mainline_branch_id.as_ref() == Some(&row.id);
            (row.id.clone(), map_branch_row_public(row, is_mainline))
        })
        .collect();

    // 8. Build summary
    let active_count = branch_dtos.values().filter(|b| b.status == BranchStatus::Active).count() as i32;
    let archived_count = branch_dtos.values().filter(|b| b.status == BranchStatus::Archived).count() as i32;

    let summary = ConversationSummaryDto {
        id: conv.id,
        title: conv.title,
        title_source: conv.title_source,
        created_at: conv.created_at * 1000,
        updated_at: conv.updated_at * 1000,
        last_opened_at: Some(conv.last_opened_at * 1000),
        archived_at: conv.archived_at.map(|t| t * 1000),
        mainline_branch_id: conv.mainline_branch_id,
        active_branch_count: active_count,
        archived_branch_count: archived_count,
        total_message_count: message_dtos.len() as i32,
        workspace_path: conv.workspace_path,
    };

    // 9. Assemble snapshot
    let loaded_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System clock error")
        .as_millis() as i64;

    // Update last_opened_at
    conversations::touch_last_opened(pool, &input.conversation_id).await?;

    Ok(ConversationSnapshotDto {
        summary,
        entities: ConversationEntitiesDto {
            messages: message_dtos,
            branches: branch_dtos,
        },
        indexes: ConversationIndexesDto {
            root_message_ids,
            child_message_ids_by_parent_id,
            branch_ids_by_fork_point_id,
        },
        loaded_at,
    })
}

// ============================================================================
// Public API: Write Operations (Transactional)
// ============================================================================

/**
 * Create a new conversation with an initial root branch.
 *
 * Transaction:
 *   1. Insert conversation (mainline_branch_id = NULL)
 *   2. Optionally insert first user message
 *   3. Insert initial ROOT branch
 *   4. Set mainline_branch_id to the new branch
 */
pub async fn create_conversation(
    pool: &SqlitePool,
    input: &CreateConversationInput,
) -> Result<ConversationSummaryDto, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::from)?;
    let now = now_secs();

    let conv_id = uuid::Uuid::new_v4().to_string();
    let branch_id = uuid::Uuid::new_v4().to_string();
    let title = input.title.as_deref().unwrap_or("New Conversation");

    // Create conversation
    conversations::insert(&mut *tx, &conv_id, title, now).await?;

    // Optionally create first user message
    let mut head_message_id: Option<String> = None;
    let mut msg_count = 0;

    if let Some(text) = &input.initial_user_message {
        if !text.is_empty() {
            let msg_id = uuid::Uuid::new_v4().to_string();
            messages::insert_user_message(
                &mut *tx,
                &msg_id,
                &conv_id,
                None, // root message
                0,    // depth
                0,    // sibling_index
                text,
                None, // no edit
                now,
            )
            .await?;
            head_message_id = Some(msg_id);
            msg_count = 1;
        }
    }

    // Create initial root branch
    branches::insert(
        &mut *tx,
        &branch_id,
        &conv_id,
        "Main",
        "ACTIVE",
        None,  // no source branch
        None,  // no fork point (initial branch)
        "ROOT",
        None,
        head_message_id.as_deref(),
        None,
        now,
    )
    .await?;

    // Set mainline
    conversations::set_mainline_branch(&mut *tx, &conv_id, &branch_id).await?;

    tx.commit().await.map_err(AppError::from)?;

    tracing::debug!(
        service = "create_conversation", conv_id = %conv_id, branch_id = %branch_id,
        has_initial_message = head_message_id.is_some(), msg_count, "transaction_committed"
    );

    Ok(ConversationSummaryDto {
        id: conv_id,
        title: title.to_string(),
        title_source: "DEFAULT".to_string(),
        created_at: now * 1000,
        updated_at: now * 1000,
        last_opened_at: Some(now * 1000),
        archived_at: None,
        mainline_branch_id: Some(branch_id),
        active_branch_count: 1,
        archived_branch_count: 0,
        total_message_count: msg_count,
        workspace_path: None,
    })
}

/**
 * Create a user message and append it to the branch.
 *
 * Domain rules enforced:
 *   - edited_from_message_id must point to a USER message
 *   - parent_message_id defaults to branch head if not specified
 *   - sibling_index is auto-computed
 *   - Branch head is updated to the new message
 */
pub async fn create_user_message(
    pool: &SqlitePool,
    input: &CreateUserMessageInput,
) -> Result<MessageDto, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::from)?;
    let now = now_secs();
    let msg_id = uuid::Uuid::new_v4().to_string();

    // Validate conversation
    let conv = conversations::find_by_id(&mut *tx, &input.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    // Validate branch
    let branch = branches::find_by_id(&mut *tx, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    if branch.conversation_id != input.conversation_id {
        return Err(AppError::invalid_argument(
            "Branch does not belong to this conversation",
        ));
    }

    // Domain rule: editedFromMessageId must point to a USER message
    if let Some(edited_from_id) = &input.edited_from_message_id {
        let source = messages::find_by_id(&mut *tx, edited_from_id)
            .await?
            .ok_or_else(|| AppError::not_found("Source message for edit not found"))?;

        if source.conversation_id != input.conversation_id {
            return Err(AppError::invalid_argument(
                "editedFromMessageId must belong to the same conversation",
            ));
        }

        if source.role != "USER" {
            return Err(AppError::invalid_argument(
                "editedFromMessageId must point to a USER message",
            ));
        }
    }

    // Determine parent: explicit input > branch head > null (root)
    let parent_id = input
        .parent_message_id
        .as_deref()
        .or(branch.head_message_id.as_deref());

    // Compute depth from parent
    let depth = match parent_id {
        Some(pid) => {
            let parent = messages::find_by_id(&mut *tx, pid)
                .await?
                .ok_or_else(|| AppError::not_found("Parent message not found"))?;

            if parent.conversation_id != input.conversation_id {
                return Err(AppError::invalid_argument(
                    "Parent message does not belong to this conversation",
                ));
            }

            parent.depth + 1
        }
        None => 0,
    };

    // Compute sibling_index
    let sibling_index = messages::get_next_sibling_index(&mut *tx, parent_id, &input.conversation_id).await?;

    // Insert message
    messages::insert_user_message(
        &mut *tx,
        &msg_id,
        &input.conversation_id,
        parent_id,
        depth,
        sibling_index,
        &input.content_text,
        input.edited_from_message_id.as_deref(),
        now,
    )
    .await?;

    // Update branch head
    branches::update_head(&mut *tx, &input.branch_id, &msg_id).await?;

    // Touch conversation
    conversations::touch(&mut *tx, &conv.id, now).await?;

    tx.commit().await.map_err(AppError::from)?;

    tracing::debug!(
        service = "create_user_message", conv_id = %input.conversation_id,
        branch_id = %input.branch_id, msg_id = %msg_id,
        depth, sibling_index, parent_id = ?parent_id,
        content_length = input.content_text.len(), "transaction_committed"
    );

    Ok(MessageDto {
        id: msg_id,
        conversation_id: input.conversation_id.clone(),
        role: MessageRole::User,
        status: MessageStatus::Completed,
        parent_id: parent_id.map(String::from),
        child_ids: vec![],
        depth,
        content: MessageContentDto {
            text: input.content_text.clone(),
            format: ContentFormat::Markdown,
            blocks: None,
        },
        created_at: now * 1000,
        updated_at: now * 1000,
        generation: None,
        error: None,
        edited_from_message_id: input.edited_from_message_id.clone(),
        tool_calls: None,
    })
}

/**
 * Destructively overwrite a historical USER message and truncate downstream data.
 *
 * This is the intentionally narrow exception requested by the user. The default
 * edit path remains non-destructive; this command is only for explicit direct
 * overwrite mode and refuses cases that would corrupt another branch.
 */
pub async fn direct_overwrite_user_message(
    pool: &SqlitePool,
    input: &DirectOverwriteUserMessageInput,
) -> Result<MessageDto, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::from)?;
    let now = now_secs();

    if input.content_text.trim().is_empty() {
        return Err(AppError::invalid_argument("Message content cannot be empty"));
    }

    conversations::find_by_id(&mut *tx, &input.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    let branch = branches::find_by_id(&mut *tx, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    if branch.conversation_id != input.conversation_id {
        return Err(AppError::invalid_argument(
            "Branch does not belong to this conversation",
        ));
    }

    let target = messages::find_by_id(&mut *tx, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Message not found"))?;

    if target.conversation_id != input.conversation_id {
        return Err(AppError::invalid_argument(
            "Message does not belong to this conversation",
        ));
    }
    if target.role != "USER" {
        return Err(AppError::invalid_argument(
            "Only USER messages can be directly overwritten",
        ));
    }
    if target.status != "COMPLETED" {
        return Err(AppError::conflict(
            "Only completed USER messages can be directly overwritten",
        ));
    }

    // Verify the target message is actually on the selected branch path.
    let mut cursor = branch.head_message_id.clone();
    let mut found_on_path = false;
    let mut guard = 0usize;
    while let Some(message_id) = cursor {
        guard += 1;
        if guard > 10_000 {
            return Err(AppError::invariant_violation(
                "Branch path traversal exceeded safety limit",
            ));
        }

        let row = messages::find_by_id(&mut *tx, &message_id)
            .await?
            .ok_or_else(|| AppError::not_found("Branch path message not found"))?;
        if row.conversation_id != input.conversation_id {
            return Err(AppError::invariant_violation(
                "Branch path contains a message from another conversation",
            ));
        }
        if row.id == input.message_id {
            found_on_path = true;
            break;
        }
        cursor = row.parent_message_id;
    }

    if !found_on_path {
        return Err(AppError::invalid_argument(
            "Message is not on the selected branch path",
        ));
    }

    let descendant_ids = messages::collect_descendant_ids(
        &mut *tx,
        &input.conversation_id,
        &input.message_id,
    )
    .await?;
    let descendant_set: HashSet<String> = descendant_ids.iter().cloned().collect();

    for descendant_id in &descendant_ids {
        let row = messages::find_by_id(&mut *tx, descendant_id)
            .await?
            .ok_or_else(|| AppError::not_found("Descendant message not found"))?;
        if row.status == "STREAMING" {
            return Err(AppError::conflict(
                "Cannot direct overwrite while a downstream generation is streaming",
            ));
        }
    }

    // Do not delete data referenced by another branch or by this branch's fork metadata.
    let branch_rows = branches::list_by_conversation(&mut *tx, &input.conversation_id).await?;
    for row in &branch_rows {
        let fork_point_refs_deleted = row
            .fork_point_message_id
            .as_ref()
            .is_some_and(|id| descendant_set.contains(id));
        let fork_source_refs_deleted = row
            .fork_source_message_id
            .as_ref()
            .is_some_and(|id| descendant_set.contains(id));

        if row.id == input.branch_id {
            if fork_point_refs_deleted || fork_source_refs_deleted {
                return Err(AppError::conflict(
                    "Cannot direct overwrite because the selected branch metadata points into downstream history",
                ));
            }
            continue;
        }

        let head_refs_deleted = row
            .head_message_id
            .as_ref()
            .is_some_and(|id| descendant_set.contains(id));
        if head_refs_deleted || fork_point_refs_deleted || fork_source_refs_deleted {
            return Err(AppError::conflict(
                "Cannot direct overwrite because downstream messages are referenced by another branch",
            ));
        }
    }

    let updated = messages::update_user_content(
        &mut *tx,
        &input.message_id,
        &input.content_text,
        now,
    )
    .await?;
    if !updated {
        return Err(AppError::conflict(
            "Message could not be directly overwritten",
        ));
    }

    branches::update_head(&mut *tx, &input.branch_id, &input.message_id).await?;
    compressed_contexts::delete_by_branch(&mut *tx, &input.conversation_id, &input.branch_id)
        .await?;

    for descendant_id in &descendant_ids {
        messages::remove_leaf_message(&mut *tx, descendant_id).await?;
    }

    conversations::touch(&mut *tx, &input.conversation_id, now).await?;

    let updated_row = messages::find_by_id(&mut *tx, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Updated message not found"))?;

    tx.commit().await.map_err(AppError::from)?;

    tracing::debug!(
        service = "direct_overwrite_user_message",
        conv_id = %input.conversation_id,
        branch_id = %input.branch_id,
        msg_id = %input.message_id,
        deleted_descendants = descendant_ids.len(),
        content_length = input.content_text.len(),
        "transaction_committed"
    );

    Ok(map_message_row(&updated_row, vec![]))
}

/**
 * Create a STREAMING assistant placeholder appended to the branch head.
 *
 * Lifecycle: placeholder → streaming → complete/fail
 * Updates branch head to the new placeholder.
 */
pub async fn create_assistant_placeholder_for_branch(
    pool: &SqlitePool,
    input: &CreateAssistantPlaceholderForBranchInput,
) -> Result<MessageDto, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::from)?;
    let now = now_secs();
    let msg_id = uuid::Uuid::new_v4().to_string();

    // Validate branch
    let branch = branches::find_by_id(&mut *tx, &input.branch_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    if branch.conversation_id != input.conversation_id {
        return Err(AppError::invalid_argument(
            "Branch does not belong to this conversation",
        ));
    }

    // Parent = branch head (must exist for non-empty conversations)
    let parent_id = branch.head_message_id.as_deref().ok_or_else(|| {
        AppError::invariant_violation("Cannot create assistant placeholder on empty branch")
    })?;

    // Compute depth and sibling_index from parent
    let parent = messages::find_by_id(&mut *tx, parent_id)
        .await?
        .ok_or_else(|| AppError::not_found("Branch head message not found"))?;
    let depth = parent.depth + 1;
    let sibling_index = messages::get_next_sibling_index(&mut *tx, Some(parent_id), &input.conversation_id).await?;

    let params_json = input
        .generation_params
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_else(|| "{}".to_string());

    // Insert STREAMING placeholder
    messages::insert_assistant_placeholder(
        &mut *tx,
        &msg_id,
        &input.conversation_id,
        Some(parent_id),
        depth,
        sibling_index,
        &input.provider_id,
        &input.model_id,
        &input.request_id,
        &params_json,
        now,
    )
    .await?;

    // Update branch head
    branches::update_head(&mut *tx, &input.branch_id, &msg_id).await?;

    // Touch conversation
    conversations::touch(&mut *tx, &input.conversation_id, now).await?;

    tx.commit().await.map_err(AppError::from)?;

    tracing::debug!(
        service = "create_assistant_placeholder_for_branch",
        conv_id = %input.conversation_id, branch_id = %input.branch_id,
        msg_id = %msg_id, request_id = %input.request_id,
        depth, sibling_index, "transaction_committed"
    );

    Ok(MessageDto {
        id: msg_id,
        conversation_id: input.conversation_id.clone(),
        role: MessageRole::Assistant,
        status: MessageStatus::Streaming,
        parent_id: Some(parent_id.to_string()),
        child_ids: vec![],
        depth,
        content: MessageContentDto {
            text: String::new(),
            format: ContentFormat::Markdown,
            blocks: None,
        },
        created_at: now * 1000,
        updated_at: now * 1000,
        generation: Some(MessageGenerationDto {
            provider_id: input.provider_id.clone(),
            model_id: input.model_id.clone(),
            request_id: Some(input.request_id.clone()),
            params: input.generation_params.clone(),
            usage: None,
        }),
        error: None,
        edited_from_message_id: None,
        tool_calls: None,
    })
}

/**
 * Create a STREAMING assistant variant placeholder (regenerate).
 *
 * Key difference from branch placeholder:
 *   - Does NOT update branch head (variant is just a sibling)
 *   - Only becomes a branch if user continues with downstream conflict
 */
pub async fn create_assistant_variant_placeholder(
    pool: &SqlitePool,
    input: &CreateAssistantVariantPlaceholderInput,
) -> Result<MessageDto, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::from)?;
    let now = now_secs();
    let msg_id = uuid::Uuid::new_v4().to_string();

    // Validate parent message exists
    let parent = messages::find_by_id(&mut *tx, &input.parent_message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Parent message not found"))?;

    if parent.conversation_id != input.conversation_id {
        return Err(AppError::invalid_argument(
            "Parent message does not belong to this conversation",
        ));
    }

    let depth = parent.depth + 1;
    let sibling_index =
        messages::get_next_sibling_index(&mut *tx, Some(&input.parent_message_id), &input.conversation_id).await?;

    let params_json = input
        .generation_params
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_else(|| "{}".to_string());

    // Insert STREAMING placeholder as sibling
    messages::insert_assistant_placeholder(
        &mut *tx,
        &msg_id,
        &input.conversation_id,
        Some(&input.parent_message_id),
        depth,
        sibling_index,
        &input.provider_id,
        &input.model_id,
        &input.request_id,
        &params_json,
        now,
    )
    .await?;

    // NOTE: Do NOT update branch head — variant is NOT the branch tip

    // Touch conversation
    conversations::touch(&mut *tx, &input.conversation_id, now).await?;

    tx.commit().await.map_err(AppError::from)?;

    tracing::debug!(
        service = "create_assistant_variant_placeholder",
        conv_id = %input.conversation_id, parent_msg_id = %input.parent_message_id,
        msg_id = %msg_id, request_id = %input.request_id,
        depth, sibling_index, "transaction_committed"
    );

    Ok(MessageDto {
        id: msg_id,
        conversation_id: input.conversation_id.clone(),
        role: MessageRole::Assistant,
        status: MessageStatus::Streaming,
        parent_id: Some(input.parent_message_id.clone()),
        child_ids: Vec::new(),
        depth,
        content: MessageContentDto {
            text: String::new(),
            format: ContentFormat::Markdown,
            blocks: None,
        },
        created_at: now * 1000,
        updated_at: now * 1000,
        generation: Some(MessageGenerationDto {
            provider_id: input.provider_id.clone(),
            model_id: input.model_id.clone(),
            request_id: Some(input.request_id.clone()),
            params: input.generation_params.clone(),
            usage: None,
        }),
        error: None,
        edited_from_message_id: None,
        tool_calls: None,
    })
}

/**
 * Complete a streaming assistant message.
 *
 * Commits the final text and token usage. Status transitions from
 * STREAMING → COMPLETED. This is the ONLY time message content is written.
 *
 * Transaction ensures read-check-update-re_fetch is atomic, preventing
 * race conditions with inflight repair or concurrent status changes.
 */
pub async fn complete_assistant_message(
    pool: &SqlitePool,
    input: &CompleteAssistantMessageInput,
) -> Result<MessageDto, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::from)?;

    // Verify message exists and is STREAMING
    let row = messages::find_by_id(&mut *tx, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Message not found"))?;

    if row.status != "STREAMING" {
        return Err(AppError::invariant_violation(format!(
            "Message {} is not STREAMING (current: {})",
            input.message_id, row.status
        )));
    }

    if row.request_id.as_deref() != Some(input.request_id.as_str()) {
        return Err(AppError::invariant_violation(format!(
            "Message {} does not belong to request {}",
            input.message_id, input.request_id
        )));
    }

    let usage_json = input
        .usage
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_else(|| "{}".to_string());

    let content_blocks_json = input
        .content_blocks
        .as_ref()
        .and_then(|blocks| serde_json::to_string(blocks).ok())
        .unwrap_or_default();

    messages::complete_streaming(
        &mut *tx,
        &input.message_id,
        &input.content_text,
        &content_blocks_json,
        &usage_json,
        input.reasoning_content.as_deref(),
    )
    .await?;

    // Persist tool calls if present
    if let Some(ref tool_calls) = input.tool_calls {
        let now_secs_val = now_secs();
        for tc in tool_calls {
            let id = uuid::Uuid::new_v4().to_string();
            tool_calls::insert(
                &mut *tx,
                &id,
                &input.message_id,
                &tc.call_id,
                &tc.function_name,
                &tc.arguments_json,
                now_secs_val,
            )
            .await
            .map_err(AppError::from)?;
            tool_calls::complete(
                &mut *tx,
                &id,
                &tc.result_json,
                &tc.status,
                tc.error_message.as_deref(),
            )
            .await
            .map_err(AppError::from)?;
        }
    }

    // Re-fetch for the complete DTO (within same transaction)
    let updated = messages::find_by_id(&mut *tx, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Message disappeared after update"))?;

    // Load tool calls for the DTO
    let tc_rows = tool_calls::list_by_message(&mut *tx, &input.message_id)
        .await
        .unwrap_or_default();
    let tool_call_dtos = if tc_rows.is_empty() {
        None
    } else {
        Some(
            tc_rows
                .into_iter()
                .map(|r| crate::dto::common::ToolCallResultDto {
                    id: r.id,
                    call_id: r.call_id,
                    function_name: r.function_name,
                    arguments_json: r.arguments_json,
                    result_json: r.result_json,
                    status: r.status,
                    error_message: r.error_message,
                })
                .collect(),
        )
    };

    tx.commit().await.map_err(AppError::from)?;

    Ok(map_message_row_with_tool_calls(&updated, vec![], tool_call_dtos))
}

/**
 * Fail a streaming assistant message.
 *
 * Preserves partial content and records error details.
 * Status transitions from STREAMING → FAILED.
 *
 * Transaction ensures read-check-update-re_fetch is atomic.
 */
pub async fn fail_assistant_message(
    pool: &SqlitePool,
    input: &FailAssistantMessageInput,
) -> Result<MessageDto, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::from)?;

    // Verify message exists and is STREAMING
    let row = messages::find_by_id(&mut *tx, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Message not found"))?;

    if row.status != "STREAMING" {
        return Err(AppError::invariant_violation(format!(
            "Message {} is not STREAMING (current: {})",
            input.message_id, row.status
        )));
    }

    if row.request_id.as_deref() != Some(input.request_id.as_str()) {
        return Err(AppError::invariant_violation(format!(
            "Message {} does not belong to request {}",
            input.message_id, input.request_id
        )));
    }

    let partial_content_blocks_json = input
        .partial_content_blocks
        .as_ref()
        .and_then(|blocks| serde_json::to_string(blocks).ok());

    messages::fail_streaming(
        &mut *tx,
        &input.message_id,
        input.partial_content_text.as_deref(),
        partial_content_blocks_json.as_deref(),
        &input.error_code,
        &input.error_message,
        input.error_retriable,
    )
    .await?;

    // Persist any tool calls that completed before the stream failed/cancelled.
    if let Some(ref completed_tool_calls) = input.tool_calls {
        let now_secs_val = now_secs();
        for tc in completed_tool_calls {
            let id = uuid::Uuid::new_v4().to_string();
            tool_calls::insert(
                &mut *tx,
                &id,
                &input.message_id,
                &tc.call_id,
                &tc.function_name,
                &tc.arguments_json,
                now_secs_val,
            )
            .await
            .map_err(AppError::from)?;
            tool_calls::complete(
                &mut *tx,
                &id,
                &tc.result_json,
                &tc.status,
                tc.error_message.as_deref(),
            )
            .await
            .map_err(AppError::from)?;
        }
    }

    // Re-fetch for the complete DTO (within same transaction)
    let updated = messages::find_by_id(&mut *tx, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Message disappeared after update"))?;

    let tc_rows = tool_calls::list_by_message(&mut *tx, &input.message_id)
        .await
        .unwrap_or_default();
    let tool_call_dtos = if tc_rows.is_empty() {
        None
    } else {
        Some(
            tc_rows
                .into_iter()
                .map(|r| crate::dto::common::ToolCallResultDto {
                    id: r.id,
                    call_id: r.call_id,
                    function_name: r.function_name,
                    arguments_json: r.arguments_json,
                    result_json: r.result_json,
                    status: r.status,
                    error_message: r.error_message,
                })
                .collect(),
        )
    };

    tx.commit().await.map_err(AppError::from)?;

    Ok(map_message_row_with_tool_calls(&updated, vec![], tool_call_dtos))
}

/**
 * Create a new branch from an existing message.
 *
 * Non-destructive: only creates a branch pointer, no messages are modified.
 *
 * Domain rules enforced:
 *   - HISTORY_USER_EDIT: fork_point = edited message's parent_message_id
 *   - source branch must belong to the conversation
 */
pub async fn create_branch(
    pool: &SqlitePool,
    input: &crate::dto::branches::CreateBranchInput,
) -> Result<BranchDto, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::from)?;
    let now = now_secs();
    let branch_id = uuid::Uuid::new_v4().to_string();
    let mut inherited_preferred_model_id: Option<String> = None;

    // Validate conversation
    let conv = conversations::find_by_id(&mut *tx, &input.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    if let Some(source_branch_id) = &input.source_branch_id {
        let source_branch = branches::find_by_id(&mut *tx, source_branch_id)
            .await?
            .ok_or_else(|| AppError::not_found("Source branch not found"))?;

        if source_branch.conversation_id != input.conversation_id {
            return Err(AppError::invalid_argument(
                "sourceBranchId must belong to the same conversation",
            ));
        }

        if !source_branch.preferred_model_id.is_empty() {
            inherited_preferred_model_id = Some(source_branch.preferred_model_id.clone());
        }
    }

    // Domain rule: HISTORY_USER_EDIT fork_point = edited message's parent
    let effective_fork_point = if input.fork_source_type == ForkSourceType::HistoryUserEdit {
        if let Some(source_msg_id) = &input.fork_source_message_id {
            let source = messages::find_by_id(&mut *tx, source_msg_id)
                .await?
                .ok_or_else(|| AppError::not_found("Fork source message not found"))?;

            if source.conversation_id != input.conversation_id {
                return Err(AppError::invalid_argument(
                    "forkSourceMessageId must belong to the same conversation",
                ));
            }

            // Use the source message's parent as the fork point
            source.parent_message_id.clone()
        } else {
            return Err(AppError::invalid_argument(
                "HISTORY_USER_EDIT requires fork_source_message_id",
            ));
        }
    } else {
        input.fork_point_message_id.clone()
    };

    if let Some(fork_point_message_id) = &effective_fork_point {
        let fork_point = messages::find_by_id(&mut *tx, fork_point_message_id)
            .await?
            .ok_or_else(|| AppError::not_found("Fork point message not found"))?;

        if fork_point.conversation_id != input.conversation_id {
            return Err(AppError::invalid_argument(
                "forkPointMessageId must belong to the same conversation",
            ));
        }
    }

    if input.fork_source_type != ForkSourceType::HistoryUserEdit {
        if let Some(fork_source_message_id) = &input.fork_source_message_id {
            let fork_source = messages::find_by_id(&mut *tx, fork_source_message_id)
                .await?
                .ok_or_else(|| AppError::not_found("Fork source message not found"))?;

            if fork_source.conversation_id != input.conversation_id {
                return Err(AppError::invalid_argument(
                    "forkSourceMessageId must belong to the same conversation",
                ));
            }
        }
    }

    // Determine head: starts at fork point (or null for initial branch)
    let head_message_id = effective_fork_point.clone();

    // Auto-generate name if not provided
    let name = input.name.as_deref().unwrap_or("New Branch");
    let preferred_model_id = input
        .preferred_model_id
        .clone()
        .or(inherited_preferred_model_id);

    // Insert branch
    branches::insert(
        &mut *tx,
        &branch_id,
        &input.conversation_id,
        name,
        "ACTIVE",
        input.source_branch_id.as_deref(),
        effective_fork_point.as_deref(),
        // Serialize ForkSourceType back to SCREAMING_SNAKE_CASE string
        &match input.fork_source_type {
            ForkSourceType::Root => "ROOT",
            ForkSourceType::CurrentLeaf => "CURRENT_LEAF",
            ForkSourceType::HistoryAssistant => "HISTORY_ASSISTANT",
            ForkSourceType::HistoryUserEdit => "HISTORY_USER_EDIT",
            ForkSourceType::Variant => "VARIANT",
        },
        input.fork_source_message_id.as_deref(),
        head_message_id.as_deref(),
        preferred_model_id.as_deref(),
        now,
    )
    .await?;

    // Touch conversation
    conversations::touch(&mut *tx, &conv.id, now).await?;

    tx.commit().await.map_err(AppError::from)?;

    tracing::debug!(
        service = "create_branch", conv_id = %input.conversation_id,
        branch_id = %branch_id, fork_source_type = ?input.fork_source_type,
        fork_point_msg_id = ?effective_fork_point, "transaction_committed"
    );

    let is_mainline = false; // New branches are never mainline by default
    Ok(BranchDto {
        id: branch_id,
        conversation_id: input.conversation_id.clone(),
        name: name.to_string(),
        status: BranchStatus::Active,
        is_mainline,
        source_branch_id: input.source_branch_id.clone(),
        fork_point_message_id: effective_fork_point,
        fork_source_type: input.fork_source_type,
        fork_source_message_id: input.fork_source_message_id.clone(),
        head_message_id,
        preferred_model_id,
        color: None,
        summary: None,
        created_at: now * 1000,
        updated_at: now * 1000,
        archived_at: None,
    })
}

// ============================================================================
// Constrained Assistant Variant Delete
// ============================================================================

/**
 * Delete a variant/candidate assistant message.
 *
 * Rules:
 *   - Message must exist and be ASSISTANT role
 *   - Message must be a sibling candidate under a USER message
 *   - Message must not have children (must be a leaf node)
 *   - Message must not be the head of any branch
 *   - At least one other assistant candidate must remain under the same user message
 */
pub async fn delete_assistant_variant_message(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await.map_err(|e| AppError::db_error(&format!("tx begin: {e}")))?;

    let msg = messages::find_by_id(&mut *tx, message_id).await
        .map_err(|e| AppError::db_error(&format!("find message: {e}")))?
        .ok_or_else(|| AppError::not_found(format!("message {} not found", message_id)))?;

    if msg.role != "ASSISTANT" {
        return Err(AppError::invalid_argument("Only ASSISTANT messages can be deleted as variants"));
    }
    if msg.status == "STREAMING" {
        return Err(AppError::invalid_argument("Cannot delete a streaming message"));
    }

    let parent_id = msg.parent_message_id.as_deref().ok_or_else(|| {
        AppError::invalid_argument("Only assistant variants with a user parent can be deleted")
    })?;

    let parent = messages::find_by_id(&mut *tx, parent_id).await
        .map_err(|e| AppError::db_error(&format!("find parent message: {e}")))?
        .ok_or_else(|| AppError::not_found(format!("parent message {} not found", parent_id)))?;
    if parent.role != "USER" {
        return Err(AppError::invalid_argument("Only assistant variants under USER messages can be deleted"));
    }

    let child_count = messages::count_children(&mut *tx, message_id).await
        .map_err(|e| AppError::db_error(&format!("count children: {e}")))?;
    if child_count > 0 {
        return Err(AppError::invalid_argument("Cannot delete a message that has child messages"));
    }

    let branch_head_count = branches::count_heads_by_message(
        &mut *tx,
        &msg.conversation_id,
        message_id,
    )
    .await
    .map_err(|e| AppError::db_error(&format!("count branch heads: {e}")))?;
    if branch_head_count > 0 {
        return Err(AppError::conflict("Cannot delete a message that is currently a branch head"));
    }

    let assistant_sibling_count = messages::count_assistant_children_by_parent(&mut *tx, parent_id)
        .await
        .map_err(|e| AppError::db_error(&format!("count assistant siblings: {e}")))?;
    if assistant_sibling_count <= 1 {
        return Err(AppError::conflict("Cannot delete the only assistant candidate for this user message"));
    }

    messages::remove_leaf_message(&mut *tx, message_id).await
        .map_err(|e| AppError::db_error(&format!("remove leaf message: {e}")))?;

    tx.commit().await.map_err(|e| AppError::db_error(&format!("tx commit: {e}")))?;
    Ok(())
}

// ============================================================================
// Delete Branch (hard delete with cascade)
// ============================================================================

/** Result of a branch deletion, listing what was removed. */
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchResult {
    pub deleted_branch_ids: Vec<String>,
    pub deleted_message_ids: Vec<String>,
    pub conversation_id: String,
}

/**
 * Hard-delete a branch and its exclusive messages.
 *
 * Safety guards:
 *   1. Cannot delete the mainline branch
 *   2. Cannot delete a branch with status STREAMING messages
 *   3. Child branches that have this branch as source_branch_id are also deleted (cascade)
 *   4. Only messages exclusive to the deleted branch path are removed
 *      (shared messages at the fork point and before are preserved)
 *   5. Compressed contexts for deleted branches are cleaned up
 *
 * Algorithm:
 *   a. Collect all branch IDs to delete (target + descendants)
 *   b. For each branch, collect its exclusive message path (head → fork_point, exclusive)
 *   c. Filter out messages referenced by surviving branches
 *   d. Delete tool_calls, messages, compressed_contexts, branch rows
 *   e. Use PRAGMA defer_foreign_keys for safe ordering
 */
pub async fn delete_branch(
    pool: &SqlitePool,
    branch_id: &str,
) -> Result<DeleteBranchResult, AppError> {
    let mut tx = pool.begin().await
        .map_err(|e| AppError::db_error(&format!("tx begin: {e}")))?;

    // Enable deferred FK checking so constraint checks are deferred to commit
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::db_error(&format!("pragma defer: {e}")))?;

    // 1. Load target branch
    let target = branches::find_by_id(&mut *tx, branch_id).await
        .map_err(|e| AppError::db_error(&format!("find branch: {e}")))?
        .ok_or_else(|| AppError::not_found(format!("Branch {} not found", branch_id)))?;

    let conversation_id = target.conversation_id.clone();

    // 2. Guard: cannot delete mainline
    let conv = conversations::find_by_id(&mut *tx, &conversation_id).await
        .map_err(|e| AppError::db_error(&format!("find conversation: {e}")))?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    if conv.mainline_branch_id.as_deref() == Some(branch_id) {
        return Err(AppError::conflict(
            "Cannot delete the mainline branch. Set a different mainline first.",
        ));
    }

    // 3. Collect all branch IDs to delete: target + recursive descendants
    let mut branch_ids_to_delete = vec![branch_id.to_string()];
    let mut queue = vec![branch_id.to_string()];
    while let Some(bid) = queue.pop() {
        let children = branches::list_child_branches(&mut *tx, &bid).await
            .map_err(|e| AppError::db_error(&format!("list child branches: {e}")))?;
        for child in children {
            branch_ids_to_delete.push(child.id.clone());
            queue.push(child.id.clone());
        }
    }

    // 4. Collect all message IDs that surviving branches touch.
    //    Walk each surviving branch from head → fork_point (inclusive).
    let surviving_branches: Vec<branches::BranchRow> = {
        let all_branches = branches::list_by_conversation(&mut *tx, &conversation_id).await
            .map_err(|e| AppError::db_error(&format!("list branches: {e}")))?;
        all_branches.into_iter()
            .filter(|b| !branch_ids_to_delete.contains(&b.id))
            .collect()
    };

    let mut protected_msg_ids: HashSet<String> = HashSet::new();
    for b in &surviving_branches {
        // Insert fork_point (shared ancestor — never delete)
        if let Some(ref fid) = b.fork_point_message_id {
            protected_msg_ids.insert(fid.clone());
        }
        // Walk head → fork_point
        if let Some(ref hid) = b.head_message_id {
            let mut cursor: Option<String> = Some(hid.clone());
            while let Some(cid) = cursor {
                if protected_msg_ids.contains(&cid) { break; }
                protected_msg_ids.insert(cid.clone());
                let parent = sqlx::query_as::<_, (Option<String>,)>(
                    "SELECT parent_message_id FROM messages WHERE id = ?",
                )
                .bind(&cid)
                .fetch_optional(&mut *tx)
                .await;
                match parent {
                    Ok(Some((Some(pid),))) => {
                        if b.fork_point_message_id.as_ref() == Some(&pid) {
                            break;
                        }
                        cursor = Some(pid);
                    }
                    _ => break,
                }
            }
        }
    }

    // 5. Collect the direct path (head → fork) for each branch to delete,
    //    using tx (not pool) for consistency.
    //    Then expand to include all descendant messages that are not protected.
    let mut messages_to_delete: HashSet<String> = HashSet::new();

    for bid in &branch_ids_to_delete {
        // Load branch head and fork_point via tx
        let br = sqlx::query_as::<_, branches::BranchRow>(
            "SELECT * FROM branches WHERE id = ?",
        )
        .bind(bid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| AppError::db_error(&format!("load branch {bid}: {e}")))?;

        let Some(br) = br else { continue };

        let Some(head_id) = br.head_message_id.as_deref() else { continue };
        let fork_id = br.fork_point_message_id.as_deref();

        // Walk head → fork, collecting messages
        let mut path_ids: Vec<String> = Vec::new();
        let mut cursor: Option<String> = Some(head_id.to_string());
        while let Some(cid) = cursor {
            if let Some(fid) = fork_id {
                if cid == fid { break; }
            }
            path_ids.push(cid.clone());
            let parent = sqlx::query_as::<_, (Option<String>,)>(
                "SELECT parent_message_id FROM messages WHERE id = ?",
            )
            .bind(&cid)
            .fetch_optional(&mut *tx)
            .await;
            match parent {
                Ok(Some((Some(pid),))) => cursor = Some(pid),
                _ => break,
            }
        }

        // For each message on the path, collect its full descendant subtree
        // that is NOT protected by surviving branches.
        for path_id in &path_ids {
            let mut sub_queue = vec![path_id.clone()];
            while let Some(mid) = sub_queue.pop() {
                if messages_to_delete.contains(&mid) { continue; }
                if protected_msg_ids.contains(&mid) { continue; }

                messages_to_delete.insert(mid.clone());

                // Find children of this message
                let children = sqlx::query_as::<_, (String,)>(
                    "SELECT id FROM messages WHERE parent_message_id = ?",
                )
                .bind(&mid)
                .fetch_all(&mut *tx)
                .await
                .unwrap_or_default();
                for (child_id,) in children {
                    if !protected_msg_ids.contains(&child_id) {
                        sub_queue.push(child_id);
                    }
                }
            }
        }
    }

    // Remove protected messages (safety net — should already be excluded)
    messages_to_delete.retain(|id| !protected_msg_ids.contains(id));

    // 6. Before deleting messages, NULL out any parent_message_id references
    //    from messages that are NOT being deleted, pointing to messages that ARE.
    //    This satisfies the ON DELETE RESTRICT FK constraint.
    let ids_list = messages_to_delete.iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(",");
    if !ids_list.is_empty() {
        sqlx::query(&format!(
            "UPDATE messages SET parent_message_id = NULL \
             WHERE parent_message_id IN ({ids_list}) \
             AND id NOT IN ({ids_list})"
        ))
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::db_error(&format!("nullify parent refs: {e}")))?;
    }

    // 7. Delete tool_calls for messages being deleted
    for mid in &messages_to_delete {
        let _ = tool_calls::delete_by_message(&mut *tx, mid).await;
    }

    // 8. Delete messages
    for mid in &messages_to_delete {
        sqlx::query("DELETE FROM messages WHERE id = ?")
            .bind(mid)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::db_error(&format!("delete message {}: {e}", mid)))?;
    }

    // 9. Delete compressed contexts for deleted branches
    for bid in &branch_ids_to_delete {
        let _ = compressed_contexts::delete_by_branch(&mut *tx, &conversation_id, bid).await;
    }

    // 10. Delete branch rows
    for bid in &branch_ids_to_delete {
        branches::delete_by_id(&mut *tx, bid).await
            .map_err(|e| AppError::db_error(&format!("delete branch {}: {e}", bid)))?;
    }

    tx.commit().await
        .map_err(|e| AppError::db_error(&format!("tx commit: {e}")))?;

    tracing::info!(
        cmd = "delete_branch",
        branch_id = %branch_id,
        conversation_id = %conversation_id,
        branches_deleted = branch_ids_to_delete.len(),
        messages_deleted = messages_to_delete.len(),
        "ok"
    );

    Ok(DeleteBranchResult {
        deleted_branch_ids: branch_ids_to_delete,
        deleted_message_ids: messages_to_delete.into_iter().collect(),
        conversation_id,
    })
}
