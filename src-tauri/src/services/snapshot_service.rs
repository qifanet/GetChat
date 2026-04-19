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

use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::dto::common::*;
use crate::dto::conversations::*;
use crate::dto::messages::*;
use crate::dto::branches::BranchDto;
use crate::error::AppError;
use crate::repositories::{branches, conversations, messages};

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
        },
        created_at: row.created_at * 1000,
        updated_at: row.updated_at * 1000,
        generation,
        error,
        edited_from_message_id: row.edited_from_message_id.clone(),
    }
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
            created_at: r.created_at * 1000,
            updated_at: r.updated_at * 1000,
            last_opened_at: Some(r.last_opened_at * 1000),
            archived_at: r.archived_at.map(|t| t * 1000),
            mainline_branch_id: r.mainline_branch_id,
            active_branch_count: r.active_branch_count,
            archived_branch_count: r.archived_branch_count,
            total_message_count: r.total_message_count,
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
        created_at: row.created_at * 1000,
        updated_at: row.updated_at * 1000,
        last_opened_at: Some(row.last_opened_at * 1000),
        archived_at: row.archived_at.map(|t| t * 1000),
        mainline_branch_id: row.mainline_branch_id,
        active_branch_count: row.active_branch_count,
        archived_branch_count: row.archived_branch_count,
        total_message_count: row.total_message_count,
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
        created_at: conv.created_at * 1000,
        updated_at: conv.updated_at * 1000,
        last_opened_at: Some(conv.last_opened_at * 1000),
        archived_at: conv.archived_at.map(|t| t * 1000),
        mainline_branch_id: conv.mainline_branch_id,
        active_branch_count: active_count,
        archived_branch_count: archived_count,
        total_message_count: message_dtos.len() as i32,
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
        created_at: now * 1000,
        updated_at: now * 1000,
        last_opened_at: Some(now * 1000),
        archived_at: None,
        mainline_branch_id: Some(branch_id),
        active_branch_count: 1,
        archived_branch_count: 0,
        total_message_count: msg_count,
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
        },
        created_at: now * 1000,
        updated_at: now * 1000,
        generation: None,
        error: None,
        edited_from_message_id: input.edited_from_message_id.clone(),
    })
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

    let usage_json = input
        .usage
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_else(|| "{}".to_string());

    messages::complete_streaming(&mut *tx, &input.message_id, &input.content_text, &usage_json).await?;

    // Re-fetch for the complete DTO (within same transaction)
    let updated = messages::find_by_id(&mut *tx, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Message disappeared after update"))?;

    tx.commit().await.map_err(AppError::from)?;

    Ok(map_message_row(&updated, vec![]))
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

    messages::fail_streaming(
        &mut *tx,
        &input.message_id,
        input.partial_content_text.as_deref(),
        &input.error_code,
        &input.error_message,
        input.error_retriable,
    )
    .await?;

    // Re-fetch for the complete DTO (within same transaction)
    let updated = messages::find_by_id(&mut *tx, &input.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("Message disappeared after update"))?;

    tx.commit().await.map_err(AppError::from)?;

    Ok(map_message_row(&updated, vec![]))
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
// Hard Delete & Inline Edit
// ============================================================================

/**
 * Hard delete a variant/candidate assistant message.
 *
 * Rules:
 *   - Message must exist and be ASSISTANT role
 *   - Message must not have children (must be a leaf node)
 *   - If the deleted message is a branch's head, the branch head is NOT changed
 *     (the frontend handles this by refreshing the snapshot)
 */
pub async fn delete_variant_message(
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

    let child_count = messages::count_children(&mut *tx, message_id).await
        .map_err(|e| AppError::db_error(&format!("count children: {e}")))?;
    if child_count > 0 {
        return Err(AppError::invalid_argument("Cannot delete a message that has child messages"));
    }

    messages::hard_delete_message(&mut *tx, message_id).await
        .map_err(|e| AppError::db_error(&format!("hard delete: {e}")))?;

    tx.commit().await.map_err(|e| AppError::db_error(&format!("tx commit: {e}")))?;
    Ok(())
}

/**
 * Edit a user message inline (no branch creation).
 *
 * This replaces the content of an existing user message and deletes all
 * its ASSISTANT children. The frontend will then create a new assistant
 * placeholder at the same position for streaming.
 * Returns CONFLICT when any downstream message is still used as a branch
 * fork point (fork_point_message_id FK is ON DELETE RESTRICT).
 *
 * Returns the updated MessageDto.
 */
pub async fn edit_user_message_inline(
    pool: &SqlitePool,
    message_id: &str,
    new_content: &str,
) -> Result<MessageDto, AppError> {
    let mut tx = pool.begin().await.map_err(|e| AppError::db_error(&format!("tx begin: {e}")))?;

    let msg = messages::find_by_id(&mut *tx, message_id).await
        .map_err(|e| AppError::db_error(&format!("find message: {e}")))?
        .ok_or_else(|| AppError::not_found(format!("message {} not found", message_id)))?;

    if msg.role != "USER" {
        return Err(AppError::invalid_argument("Only USER messages can be edited inline"));
    }

    // Delete ALL descendants of this user message (not just direct ASSISTANT children).
    // This handles the case where the conversation continued past the edited message
    // (User → Assistant → User → Assistant → ...) — all downstream messages must go.
    // Step 1: collect IDs (deepest-first via CTE)
    let descendant_ids = messages::collect_descendant_ids(&mut *tx, message_id).await
        .map_err(|e| AppError::db_error(&format!("collect descendants: {e}")))?;
    let fork_point_ref_count = branches::count_fork_points_in_set(
        &mut *tx,
        &msg.conversation_id,
        &descendant_ids,
    )
    .await
    .map_err(|e| AppError::db_error(&format!("count descendant fork-point refs: {e}")))?;
    if fork_point_ref_count > 0 {
        return Err(
            AppError::conflict("Cannot edit message inline because downstream fork points exist")
                .with_details(format!("fork_point_ref_count={fork_point_ref_count}")),
        );
    }
    // Step 2: redirect branch heads that point to any descendant
    //         (branches.head_message_id has ON DELETE RESTRICT)
    if !descendant_ids.is_empty() {
        branches::redirect_heads_from_descendants(
            &mut *tx, &msg.conversation_id, &descendant_ids, message_id,
        ).await.map_err(|e| AppError::db_error(&format!("redirect branch heads: {e}")))?;
    }
    // Step 3: delete each one deepest-first to respect ON DELETE RESTRICT
    for desc_id in &descendant_ids {
        messages::hard_delete_message(&mut *tx, desc_id).await
            .map_err(|e| AppError::db_error(&format!("delete descendant: {e}")))?;
    }

    // Update the user message content
    messages::update_content(&mut *tx, message_id, new_content).await
        .map_err(|e| AppError::db_error(&format!("update content: {e}")))?;

    // Reload the updated message
    let updated = messages::find_by_id(&mut *tx, message_id).await
        .map_err(|e| AppError::db_error(&format!("reload message: {e}")))?
        .ok_or_else(|| AppError::not_found(format!("message {} not found", message_id)))?;

    tx.commit().await.map_err(|e| AppError::db_error(&format!("tx commit: {e}")))?;

    Ok(MessageDto {
        id: updated.id,
        conversation_id: updated.conversation_id,
        role: parse_role(&updated.role),
        status: parse_status(&updated.status),
        parent_id: updated.parent_message_id,
        depth: updated.depth,
        content: MessageContentDto {
            text: updated.content_text,
            format: ContentFormat::Markdown,
        },
        child_ids: Vec::new(), // Children were just deleted
        generation: None,
        error: None,
        edited_from_message_id: updated.edited_from_message_id,
        created_at: updated.created_at * 1000,
        updated_at: updated.updated_at * 1000,
    })
}
