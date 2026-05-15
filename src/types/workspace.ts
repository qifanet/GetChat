/**
 * @file workspace.ts
 * @description Type definitions for workspace state, composer state, and UI state.
 *
 * Workspace state follows a strict state machine:
 *   NORMAL → HISTORY_FORK → NORMAL (after branch creation or cancel)
 *   NORMAL → EDIT_FORK    → NORMAL (after branch creation or cancel)
 *   NORMAL → COMPARE      → NORMAL (after returning from comparison)
 *
 * Key constraints:
 * - COMPARE mode disables the composer
 * - HISTORY_FORK and EDIT_FORK show explicit banners
 * - forkIntent is non-null only in HISTORY_FORK and EDIT_FORK modes
 * - variantPreview is a message-level sub-state, not a page-level mode
 */

import type {
  BranchId,
  ConversationId,
  ForkSourceType,
  MessageId,
  ModelId,
  RequestId,
  RightPanelTab,
  SendMode,
  WorkspaceMode,
} from "./base";
import type { GenerationParams } from "./settings";

// ============================================================================
// Fork Intent
// ============================================================================

/**
 * Describes a pending fork operation.
 * Only non-null when workspaceMode is HISTORY_FORK or EDIT_FORK.
 */
export interface ForkIntent {
  sourceType: ForkSourceType;
  sourceBranchId: BranchId;
  sourceMessageId: MessageId | null;

  /** Used in HISTORY_USER_EDIT mode: the original message being edited */
  originalEditableMessageId?: MessageId;

  /** Used when continuing from a variant assistant message */
  selectedVariantMessageId?: MessageId;
}

// ============================================================================
// Compare State
// ============================================================================

/** State for the side-by-side comparison mode */
export interface CompareState {
  leftBranchId: BranchId;
  rightBranchId: BranchId;
}

// ============================================================================
// Variant Preview Context
// ============================================================================

/**
 * Message-level sub-state for variant preview.
 * This is NOT a page-level mode — it coexists with NORMAL mode.
 *
 * When a user is viewing a non-default variant:
 * - The displayed message content changes
 * - If the user continues chatting, a new branch may be needed
 * - hasDownstreamConflict indicates if the current variant differs
 *   from the one the existing downstream path was built on
 */
export interface VariantPreviewContext {
  /** The user message whose assistant variant is being previewed */
  userMessageId: MessageId;

  /** The specific assistant variant currently displayed */
  assistantMessageId: MessageId;

  /**
   * If true, continuing from this variant will create a new branch
   * because the downstream path was built on a different variant.
   */
  hasDownstreamConflict: boolean;
}

// ============================================================================
// Workspace State
// ============================================================================

/**
 * Core workspace state machine.
 * Controls what the user sees and can interact with.
 */
export interface WorkspaceState {
  /** Currently active conversation, null if no conversation is open */
  activeConversationId: ConversationId | null;

  /** Currently viewed branch, null if no branch is selected */
  currentBranchId: BranchId | null;

  /** Current workspace mode (see state machine above) */
  workspaceMode: WorkspaceMode;

  /** Pending fork intent, non-null only in HISTORY_FORK/EDIT_FORK modes */
  forkIntent: ForkIntent | null;

  /** Compare state, non-null only in COMPARE mode */
  compareState: CompareState | null;

  /** Active variant preview, coexists with NORMAL mode */
  variantPreview: VariantPreviewContext | null;

  /** Number of active branches that haven't been converged yet */
  pendingConvergeCount: number;
}

// ============================================================================
// Composer State
// ============================================================================

/** State for the message input area at the bottom of the workspace */
export interface ComposerState {
  /** Current draft text */
  draft: string;

  /** Selected model for the next message */
  selectedModelId: ModelId | null;

  /** How the message will be sent (append to current path or as new branch) */
  sendMode: SendMode;

  /** Generation parameters for the next request */
  params: GenerationParams;

  /** Whether a message is currently being sent/streamed */
  isSending: boolean;

  /** The active streaming request ID, null if not streaming */
  activeRequestId: RequestId | null;
}

// ============================================================================
// UI State
// ============================================================================

/** Pure UI interaction state, no business logic */
export interface UiState {
  leftSidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  rightPanelTab: RightPanelTab;

  exportDialogOpen: boolean;
  branchRenameDialogOpen: boolean;

  /** Set by search navigation; MessageList scrolls to this message then clears it. */
  scrollToMessageId: string | null;
}
