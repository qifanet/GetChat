/**
 * @file base.ts
 * @description Base type aliases and enumerations for the BranchFlow project.
 * These types serve as the foundational building blocks for all domain models.
 */

// ============================================================================
// ID Type Aliases
// ============================================================================

/** Unix timestamp in milliseconds */
export type UnixMs = number;

/** Unique identifier for a conversation */
export type ConversationId = string;

/** Unique identifier for a branch within a conversation */
export type BranchId = string;

/** Unique identifier for a message node in the message tree */
export type MessageId = string;

/** Unique identifier for a model provider configuration */
export type ProviderId = string;

/** Unique identifier for a model profile */
export type ModelId = string;

/** Unique identifier for a streaming request */
export type RequestId = string;

/** Unique identifier for a toast notification */
export type ToastId = string;

// ============================================================================
// Role & Status Enums
// ============================================================================

/** Message role in the conversation tree */
export type MessageRole = "SYSTEM" | "USER" | "ASSISTANT";

/** Lifecycle status of a message node */
export type MessageStatus =
  | "PENDING"
  | "STREAMING"
  | "COMPLETED"
  | "FAILED"
  | "ABORTED";

/** Status of a branch (active or archived) */
export type BranchStatus = "ACTIVE" | "ARCHIVED";

// ============================================================================
// Workspace & Interaction Modes
// ============================================================================

/**
 * Workspace mode determines the current interaction context.
 * - NORMAL: Standard chat mode
 * - HISTORY_FORK: Continuing from a historical assistant message
 * - EDIT_FORK: Editing a historical user message to create a new branch
 * - COMPARE: Read-only side-by-side comparison of two branches
 */
export type WorkspaceMode =
  | "NORMAL"
  | "HISTORY_FORK"
  | "EDIT_FORK"
  | "COMPARE";

/** How the composer sends the message */
export type SendMode = "APPEND" | "NEW_BRANCH";

/** What triggered a fork operation */
export type ForkSourceType =
  | "ROOT"
  | "CURRENT_LEAF"
  | "HISTORY_ASSISTANT"
  | "HISTORY_USER_EDIT"
  | "VARIANT";

/** Active tab in the right panel */
export type RightPanelTab = "BRANCHES" | "DETAILS";

/** Renderer mode for streaming text */
export type StreamRendererMode = "PRETEXT" | "DOM_TEXT";

/** Filter mode for the branch panel */
export type BranchFilterMode = "NEARBY" | "ACTIVE" | "ARCHIVED";

/** Export scope for the export dialog */
export type ExportScope = "CURRENT_PATH" | "WHOLE_TREE";

/** Export format */
export type ExportFormat = "MARKDOWN" | "JSON";
