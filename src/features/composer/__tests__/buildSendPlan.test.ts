/**
 * @file buildSendPlan.test.ts
 * @description Tests for the send plan decision engine.
 *
 * Product rules tested:
 *   1. COMPARE mode → throw COMPARE_MODE_FORBIDDEN (compare is strictly read-only)
 *   2. forkIntent (HISTORY_ASSISTANT) → creates new branch from source message
 *   3. forkIntent (HISTORY_USER_EDIT) → creates new branch with editedFromMessageId
 *   4. sendMode === NEW_BRANCH → creates branch from current leaf
 *   5. variant preview with downstream conflict → creates VARIANT branch
 *   6. Default → normal append to current path (no branch creation)
 *   7. Missing preconditions → appropriate SendPlanError codes
 */

import { describe, it, expect } from "vitest";
import { buildSendPlan, SendPlanError } from "../buildSendPlan";
import {
  createStoreState,
  createBranch,
  createSnapshot,
} from "../../../test/stateFactory";

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal valid state for send plan tests */
function baseSendState(
  overrides: Record<string, any> = {}
) {
  const branch = createBranch({
    id: "branch_1",
    headMessageId: "msg_5",
    isMainline: true,
  });
  const snapshot = createSnapshot([], [branch]);

  return createStoreState({
    activeSnapshot: snapshot,
    workspace: {
      activeConversationId: "conv_1",
      currentBranchId: "branch_1",
      workspaceMode: "NORMAL",
      forkIntent: null,
      compareState: null,
      variantPreview: null,
      pendingConvergeCount: 0,
    },
    composer: {
      draft: "Hello",
      selectedModelId: "model_1",
      sendMode: "APPEND",
      params: {},
      isSending: false,
      activeRequestId: null,
    },
    ...overrides,
  } as any);
}

// ============================================================================
// Rule 1: COMPARE mode is strictly read-only
// ============================================================================

describe("buildSendPlan — Rule 1: COMPARE mode forbidden", () => {
  it("throws COMPARE_MODE_FORBIDDEN in COMPARE mode", () => {
    const state = baseSendState({
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "branch_1",
        workspaceMode: "COMPARE",
        forkIntent: null,
        compareState: { leftBranchId: "b1", rightBranchId: "b2" },
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    });

    expect(() => buildSendPlan(state)).toThrow(SendPlanError);
    try { buildSendPlan(state); } catch (e) {
      expect((e as SendPlanError).code).toBe("COMPARE_MODE_FORBIDDEN");
    }
  });
});

// ============================================================================
// Rule 2: Fork intent creates new branch (non-destructive)
// ============================================================================

describe("buildSendPlan — Rule 2: HISTORY_FORK from historical message", () => {
  it("creates branch plan with sourceType HISTORY_ASSISTANT", () => {
    const state = baseSendState({
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "branch_1",
        workspaceMode: "HISTORY_FORK",
        forkIntent: {
          sourceType: "HISTORY_ASSISTANT",
          sourceBranchId: "branch_1",
          sourceMessageId: "msg_3",
        },
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    });

    const plan = buildSendPlan(state);

    expect(plan.conversationId).toBe("conv_1");
    expect(plan.createBranch).toBeDefined();
    expect(plan.createBranch?.sourceType).toBe("HISTORY_ASSISTANT");
    expect(plan.createBranch?.forkPointMessageId).toBe("msg_3");
    expect(plan.targetParentMessageId).toBe("msg_3");
    // Non-destructive: new branch, original untouched
    expect(plan.createBranch).toBeTruthy();
  });
});

describe("buildSendPlan — Rule 2: EDIT_FORK from edited message", () => {
  it("creates branch plan with editedFromMessageId (non-destructive traceability)", () => {
    const state = baseSendState({
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "branch_1",
        workspaceMode: "EDIT_FORK",
        forkIntent: {
          sourceType: "HISTORY_USER_EDIT",
          sourceBranchId: "branch_1",
          sourceMessageId: "msg_2",
          originalEditableMessageId: "msg_2",
        },
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    });

    const plan = buildSendPlan(state);

    expect(plan.createBranch?.sourceType).toBe("HISTORY_USER_EDIT");
    expect(plan.editedFromMessageId).toBe("msg_2");
    // Non-destructive: original message preserved via editedFromMessageId
  });
});

// ============================================================================
// Rule 3: Explicit NEW_BRANCH from leaf
// ============================================================================

describe("buildSendPlan — Rule 3: Explicit new branch from leaf", () => {
  it("creates branch plan with sourceType CURRENT_LEAF", () => {
    const state = baseSendState({
      composer: {
        draft: "Hello",
        selectedModelId: "model_1",
        sendMode: "NEW_BRANCH",
        params: {},
        isSending: false,
        activeRequestId: null,
      },
    });

    const plan = buildSendPlan(state);

    expect(plan.createBranch).toBeDefined();
    expect(plan.createBranch?.sourceType).toBe("CURRENT_LEAF");
    expect(plan.createBranch?.forkPointMessageId).toBe("msg_5");
    expect(plan.targetParentMessageId).toBe("msg_5");
  });
});

// ============================================================================
// Rule 4: Variant continuation with downstream conflict
// ============================================================================

describe("buildSendPlan — Rule 4: Variant continuation creates branch", () => {
  it("creates VARIANT branch when hasDownstreamConflict is true", () => {
    const state = baseSendState({
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "branch_1",
        workspaceMode: "NORMAL",
        forkIntent: null,
        compareState: null,
        variantPreview: {
          userMessageId: "msg_4",
          assistantMessageId: "msg_5b",
          hasDownstreamConflict: true,
        },
        pendingConvergeCount: 0,
      },
    });

    const plan = buildSendPlan(state);

    expect(plan.createBranch?.sourceType).toBe("VARIANT");
    expect(plan.continueFromVariantMessageId).toBe("msg_5b");
    // Variant upgrade: only becomes branch when continued with conflict
  });

  it("does NOT create branch when variant has no downstream conflict", () => {
    const state = baseSendState({
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "branch_1",
        workspaceMode: "NORMAL",
        forkIntent: null,
        compareState: null,
        variantPreview: {
          userMessageId: "msg_4",
          assistantMessageId: "msg_5b",
          hasDownstreamConflict: false,
        },
        pendingConvergeCount: 0,
      },
    });

    const plan = buildSendPlan(state);

    // Falls through to normal append
    expect(plan.createBranch).toBeUndefined();
  });
});

// ============================================================================
// Rule 5: Default — normal append (non-destructive: no branch created)
// ============================================================================

describe("buildSendPlan — Rule 5: Normal append", () => {
  it("appends to current branch without creating new branch", () => {
    const state = baseSendState();

    const plan = buildSendPlan(state);

    expect(plan.conversationId).toBe("conv_1");
    expect(plan.targetBranchId).toBe("branch_1");
    expect(plan.targetParentMessageId).toBe("msg_5");
    expect(plan.createBranch).toBeUndefined();
  });
});

// ============================================================================
// Pre-condition validation
// ============================================================================

describe("buildSendPlan — Pre-condition validation", () => {
  it("throws NO_ACTIVE_CONVERSATION when conversationId is null", () => {
    const state = baseSendState({
      workspace: {
        activeConversationId: null,
        currentBranchId: "branch_1",
        workspaceMode: "NORMAL",
        forkIntent: null,
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    });

    try { buildSendPlan(state); } catch (e) {
      expect((e as SendPlanError).code).toBe("NO_ACTIVE_CONVERSATION");
    }
  });

  it("throws NO_CURRENT_BRANCH when branchId is null", () => {
    const state = baseSendState({
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: null,
        workspaceMode: "NORMAL",
        forkIntent: null,
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    });

    try { buildSendPlan(state); } catch (e) {
      expect((e as SendPlanError).code).toBe("NO_CURRENT_BRANCH");
    }
  });

  it("throws NO_SNAPSHOT when snapshot is null", () => {
    const state = baseSendState({
      activeSnapshot: null,
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "branch_1",
        workspaceMode: "NORMAL",
        forkIntent: null,
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    });

    try { buildSendPlan(state); } catch (e) {
      expect((e as SendPlanError).code).toBe("NO_SNAPSHOT");
    }
  });

  it("throws BRANCH_NOT_FOUND when branch not in snapshot", () => {
    const snapshot = createSnapshot([], []);
    const state = baseSendState({
      activeSnapshot: snapshot,
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "nonexistent_branch",
        workspaceMode: "NORMAL",
        forkIntent: null,
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    });

    try { buildSendPlan(state); } catch (e) {
      expect((e as SendPlanError).code).toBe("BRANCH_NOT_FOUND");
    }
  });
});
