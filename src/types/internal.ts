/**
 * @file internal.ts
 * @description Internal helper types for the send action pipeline.
 *
 * The send pipeline unifies all message-sending scenarios into a single flow:
 *   buildSendPlan() → sendMessageAction() → streamController.startAssistantStream()
 *
 * SendPlan captures the "what and where" of a message send operation,
 * abstracting away whether it's a normal append, a new branch, a history
 * fork, an edited message, or a variant continuation.
 */

import type {
  BranchId,
  ConversationId,
  ForkSourceType,
  MessageId,
} from "./base";

// ============================================================================
// Send Plan
// ============================================================================

/**
 * Describes how a message should be sent and where it should land.
 * Built by `buildSendPlan()` based on current workspace state.
 *
 * This is the single source of truth for the send pipeline:
 * - append to current path: targetBranchId === sourceBranchId, no createBranch
 * - new branch from leaf:    createBranch with sourceType CURRENT_LEAF
 * - history fork:            createBranch with sourceType HISTORY_ASSISTANT
 * - edit fork:               createBranch with sourceType HISTORY_USER_EDIT
 * - variant continue:        createBranch with sourceType VARIANT
 */
export interface SendPlan {
  /** The conversation this send belongs to */
  conversationId: ConversationId;

  /** The branch the user is currently on */
  sourceBranchId: BranchId;

  /**
   * The branch where the message will actually be written.
   * For append: same as sourceBranchId.
   * For fork: initially set to sourceBranchId, replaced after branch creation.
   */
  targetBranchId: BranchId;

  /**
   * Which message node the new user message will be attached to.
   * - Normal append: current branch head
   * - History fork: the selected historical assistant message
   * - Edit fork: null (new root after the edited message)
   * - Variant: the selected variant assistant message
   */
  targetParentMessageId: MessageId | null;

  /**
   * If this send requires creating a new branch first,
   * describes the fork parameters.
   * Undefined for simple append operations.
   */
  createBranch?: {
    sourceType: ForkSourceType;
    forkPointMessageId: MessageId | null;
    forkSourceMessageId: MessageId | null;
  };

  /**
   * For HISTORY_USER_EDIT: points to the original message being edited.
   * The new message's editedFromMessageId will be set to this value.
   */
  editedFromMessageId?: MessageId;

  /**
   * For VARIANT continuation: the variant assistant message
   * the user is continuing from.
   */
  continueFromVariantMessageId?: MessageId;
}

// ============================================================================
// Send Pipeline Types
// ============================================================================

/** Parameters for the stream controller's startAssistantStream */
export interface StartStreamParams {
  conversationId: ConversationId;
  branchId: BranchId;
  parentMessageId: MessageId;
  providerId: string;
  modelId: string;
  promptMessages: Array<{ role: string; content: string }>;
  rendererMode?: "PRETEXT" | "DOM_TEXT";
}
