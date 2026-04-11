/**
 * @file dto/branches.rs
 * @description Branch DTOs and input types.
 *
 * Key design:
 *   - is_mainline is DERIVED from conversation.mainline_branch_id, not a DB column.
 *     The repository layer computes this when building the DTO.
 *   - A branch is a named path pointer (fork_point + head), NOT a message mapping.
 */

use serde::{Deserialize, Serialize};

use super::common::{BranchStatus, ForkSourceType};

// ============================================================================
// Output DTO
// ============================================================================

/**
 * Branch entity returned to the frontend.
 * Matches frontend BranchEntity interface exactly.
 *
 * Derived fields:
 *   - is_mainline: conversation.mainline_branch_id == this branch's id
 *     Computed by the repository layer, never stored in DB.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDto {
    pub id: String,
    pub conversation_id: String,

    pub name: String,
    pub status: BranchStatus,

    /**
     * Whether this is the default branch for the conversation.
     * Derived: conversation.mainline_branch_id == branch.id.
     * Setting mainline only updates conversations.mainline_branch_id.
     */
    pub is_mainline: bool,

    /** Which branch this one forked from (null for the original branch) */
    pub source_branch_id: Option<String>,

    /** The message where this branch diverged from the source */
    pub fork_point_message_id: Option<String>,

    /** What kind of action created this fork */
    pub fork_source_type: ForkSourceType,

    /**
     * The specific message that triggered the fork:
     * - HISTORY_ASSISTANT: the assistant message user clicked "continue from here"
     * - HISTORY_USER_EDIT: the user message being edited
     * - VARIANT: the assistant variant being continued from
     */
    pub fork_source_message_id: Option<String>,

    /** The latest (leaf) message in this branch's path */
    pub head_message_id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_model_id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    pub created_at: i64,
    pub updated_at: i64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
}

// ============================================================================
// Input Types
// ============================================================================

/**
 * Input for creating a new branch.
 *
 * The command creates a branch record pointing into the existing message tree.
 * No messages are copied or modified (non-destructive).
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchInput {
    pub conversation_id: String,

    /** Which branch this forks from. None for the initial branch of a conversation. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_branch_id: Option<String>,

    /** The shared ancestor message where paths diverge. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_point_message_id: Option<String>,

    /** What kind of action triggered this fork */
    pub fork_source_type: ForkSourceType,

    /** The specific message that triggered the fork */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_source_message_id: Option<String>,

    /** Branch display name. Auto-generated if not provided. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /** Optional branch-level preferred model profile. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_model_id: Option<String>,
}

/** Input for renaming a branch. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBranchInput {
    pub branch_id: String,
    pub name: String,
}

/** Input for updating the preferred model profile of a branch. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBranchPreferredModelInput {
    pub branch_id: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

/** Input for promoting an existing message to the current branch head. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBranchHeadMessageInput {
    pub branch_id: String,
    pub message_id: String,
}

/**
 * Input for setting the mainline branch.
 *
 * Non-destructive: only updates conversations.mainline_branch_id.
 * No message tree or branch data is modified.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMainlineBranchInput {
    pub conversation_id: String,
    pub branch_id: String,
}

/**
 * Result of set_mainline_branch command.
 *
 * Returns the IDs needed by the frontend to update isMainline on all branches
 * without re-fetching the entire snapshot:
 *   - oldMainlineBranchId: the branch that WAS mainline (set isMainline=false)
 *   - newMainlineBranchDto: the branch that IS NOW mainline (set isMainline=true)
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMainlineResult {
    /** The branch that was previously mainline (null if none existed) */
    pub old_mainline_branch_id: Option<String>,

    /** The newly set mainline branch with all current data */
    pub new_mainline_branch: BranchDto,
}
