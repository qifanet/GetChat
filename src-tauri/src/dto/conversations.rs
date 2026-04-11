/**
 * @file dto/conversations.rs
 * @description Conversation DTOs: summary, snapshot, entities, indexes.
 *
 * All timestamp fields are in milliseconds (matching frontend UnixMs).
 * The DB stores seconds; the repository layer handles conversion.
 *
 * Aggregate counts (activeBranchCount, archivedBranchCount, totalMessageCount)
 * are computed via SQL queries, not stored columns.
 */

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::branches::BranchDto;
use super::messages::MessageDto;

// ============================================================================
// Output DTOs
// ============================================================================

/**
 * Lightweight conversation summary for sidebar listing.
 * Matches frontend ConversationSummary interface.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummaryDto {
    pub id: String,
    pub title: String,

    pub created_at: i64,
    pub updated_at: i64,
    pub last_opened_at: Option<i64>,
    pub archived_at: Option<i64>,

    pub mainline_branch_id: Option<String>,

    /** Computed: COUNT of branches with status = 'ACTIVE' */
    pub active_branch_count: i32,

    /** Computed: COUNT of branches with status = 'ARCHIVED' */
    pub archived_branch_count: i32,

    /** Computed: COUNT of messages in this conversation */
    pub total_message_count: i32,
}

/**
 * Runtime indexes built on top of the message tree.
 * Reconstructed at snapshot load time from parentId relationships.
 * Matches frontend ConversationIndexes interface.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationIndexesDto {
    /** Root message IDs (parentId = null) */
    pub root_message_ids: Vec<String>,

    /** Map: parentId → list of child messageIds */
    pub child_message_ids_by_parent_id: HashMap<String, Vec<String>>,

    /** Map: forkPointMessageId → list of branchIds */
    pub branch_ids_by_fork_point_id: HashMap<String, Vec<String>>,
}

/**
 * All entities within a single conversation.
 * Maps use string IDs as keys, serialized as JSON objects.
 * Matches frontend ConversationEntities interface.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEntitiesDto {
    pub messages: HashMap<String, MessageDto>,
    pub branches: HashMap<String, BranchDto>,
}

/**
 * Complete snapshot of an active conversation.
 * Only the currently open conversation is loaded as a full snapshot;
 * others are represented by ConversationSummaryDto only.
 * Matches frontend ConversationSnapshot interface.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshotDto {
    pub summary: ConversationSummaryDto,
    pub entities: ConversationEntitiesDto,
    pub indexes: ConversationIndexesDto,

    /** Unix timestamp in milliseconds — when this snapshot was loaded */
    pub loaded_at: i64,
}

// ============================================================================
// Input Types
// ============================================================================

/** Input for creating a new conversation. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /**
     * If provided, creates the first user message and an initial branch.
     * This is a convenience for the common "new conversation with first message" flow.
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_user_message: Option<String>,
}

/** Input for loading a full conversation snapshot. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadConversationSnapshotInput {
    pub conversation_id: String,
}
