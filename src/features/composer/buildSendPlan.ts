/**
 * @file buildSendPlan.ts
 * @description Builds a SendPlan from the current workspace and composer state.
 *
 * This function is the decision engine for the send pipeline.
 * It examines the current workspace mode, fork intent, send mode,
 * and variant preview to determine:
 *   - Where to attach the new user message
 *   - Whether a new branch needs to be created
 *   - Whether this is an edit of an existing message
 *
 * All scenarios are unified into a single SendPlan object that
 * sendMessageAction can execute without knowing the specific context.
 *
 * Non-destructive guarantee:
 *   - Branch creation always creates a NEW branch entity
 *   - Original messages are never modified
 *   - forkPointMessageId points to the divergence point, not the deletion point
 */

import type { AppStore } from "../../stores/appStore.types";
import type { SendPlan } from "../../types/internal";

/**
 * Build a SendPlan based on current application state.
 *
 * Decision tree:
 *   1. COMPARE mode → throw (sending not allowed)
 *   2. forkIntent exists → HISTORY_FORK or EDIT_FORK
 *   3. sendMode === NEW_BRANCH → branch from current leaf
 *   4. variantPreview with downstream conflict → branch from variant
 *   5. Default → normal append to current path
 *
 * @throws Error if in COMPARE mode or required state is missing
 */
export function buildSendPlan(state: AppStore): SendPlan {
  const conversationId = state.workspace.activeConversationId;
  const sourceBranchId = state.workspace.currentBranchId;
  const snapshot = state.activeSnapshot;

  // --- Pre-conditions ---
  if (!conversationId) {
    throw new SendPlanError("NO_ACTIVE_CONVERSATION", "No active conversation");
  }
  if (!sourceBranchId) {
    throw new SendPlanError("NO_CURRENT_BRANCH", "No current branch selected");
  }
  if (!snapshot) {
    throw new SendPlanError("NO_SNAPSHOT", "Conversation snapshot not loaded");
  }

  const sourceBranch = snapshot.entities.branches[sourceBranchId];
  if (!sourceBranch) {
    throw new SendPlanError("BRANCH_NOT_FOUND", `Branch ${sourceBranchId} not found`);
  }

  // --- Rule 1: COMPARE mode → forbid ---
  if (state.workspace.workspaceMode === "COMPARE") {
    throw new SendPlanError(
      "COMPARE_MODE_FORBIDDEN",
      "Cannot send messages in compare mode"
    );
  }

  // --- Rule 2: Fork intent (HISTORY_FORK / EDIT_FORK) ---
  if (state.workspace.forkIntent) {
    const intent = state.workspace.forkIntent;
    const targetParentMessageId =
      intent.sourceType === "HISTORY_USER_EDIT"
        ? intent.sourceMessageId ?? null
        : intent.sourceMessageId;
    const forkSourceMessageId =
      intent.sourceType === "HISTORY_USER_EDIT"
        ? intent.originalEditableMessageId ?? intent.sourceMessageId
        : intent.sourceMessageId;

    return {
      conversationId,
      sourceBranchId,
      targetBranchId: sourceBranchId, // Placeholder; replaced after branch creation
      targetParentMessageId,
      createBranch: {
        sourceType: intent.sourceType,
        forkPointMessageId: targetParentMessageId,
        forkSourceMessageId: forkSourceMessageId ?? null,
      },
      editedFromMessageId: intent.originalEditableMessageId,
      continueFromVariantMessageId: intent.selectedVariantMessageId,
    };
  }

  // --- Rule 3: Explicit "send as new branch" ---
  if (state.composer.sendMode === "NEW_BRANCH") {
    return {
      conversationId,
      sourceBranchId,
      targetBranchId: sourceBranchId, // Placeholder; replaced after branch creation
      targetParentMessageId: sourceBranch.headMessageId,
      createBranch: {
        sourceType: "CURRENT_LEAF",
        forkPointMessageId: sourceBranch.headMessageId,
        forkSourceMessageId: sourceBranch.headMessageId,
      },
    };
  }

  // --- Rule 4: Variant preview with downstream conflict ---
  if (
    state.workspace.variantPreview?.hasDownstreamConflict &&
    state.workspace.variantPreview.assistantMessageId
  ) {
    const preview = state.workspace.variantPreview;

    return {
      conversationId,
      sourceBranchId,
      targetBranchId: sourceBranchId, // Placeholder; replaced after branch creation
      targetParentMessageId: preview.assistantMessageId,
      createBranch: {
        sourceType: "VARIANT",
        forkPointMessageId: preview.assistantMessageId,
        forkSourceMessageId: preview.assistantMessageId,
      },
      continueFromVariantMessageId: preview.assistantMessageId,
    };
  }

  // --- Rule 4.5: Variant preview without downstream conflict → append from preview ---
  if (state.workspace.variantPreview?.assistantMessageId) {
    return {
      conversationId,
      sourceBranchId,
      targetBranchId: sourceBranchId,
      targetParentMessageId: state.workspace.variantPreview.assistantMessageId,
      continueFromVariantMessageId: state.workspace.variantPreview.assistantMessageId,
    };
  }

  // --- Rule 5: Normal append ---
  return {
    conversationId,
    sourceBranchId,
    targetBranchId: sourceBranchId,
    targetParentMessageId: sourceBranch.headMessageId,
  };
}

// ============================================================================
// Error Type
// ============================================================================

/**
 * Typed error for send plan validation failures.
 * Each error code maps to a specific user-facing message.
 */
export class SendPlanError extends Error {
  constructor(
    public readonly code:
      | "NO_ACTIVE_CONVERSATION"
      | "NO_CURRENT_BRANCH"
      | "NO_SNAPSHOT"
      | "BRANCH_NOT_FOUND"
      | "COMPARE_MODE_FORBIDDEN",
    message: string
  ) {
    super(message);
    this.name = "SendPlanError";
  }
}
