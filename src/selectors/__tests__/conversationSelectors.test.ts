/**
 * @file conversationSelectors.test.ts
 * @description Tests for conversation path traversal and workspace visibility selectors.
 *
 * Product rules tested:
 *   - walkPathFromHead returns root→head chronological order
 *   - NORMAL mode shows full current path
 *   - HISTORY_FORK truncates visible messages at the source message
 *   - EDIT_FORK truncates visible messages at the source message
 *   - COMPARE mode shows zero visible messages
 *   - selectHiddenDownstreamCount correctly computes hidden count
 *   - findForkPoint finds the lowest common ancestor
 *   - selectVariantGroupByUserMessageId identifies multiple assistant children
 */

import { describe, it, expect } from "vitest";
import {
  selectCurrentPathMessages,
  selectVisibleMessagesForWorkspace,
  selectHiddenDownstreamCount,
  selectVariantGroupByUserMessageId,
  walkPathFromHead,
  findForkPoint,
} from "../conversationSelectors";
import {
  createStoreState,
  createMessage,
  createMessagePath,
  createBranch,
  createSnapshot,
} from "../../test/stateFactory";

// ============================================================================
// walkPathFromHead
// ============================================================================

describe("walkPathFromHead", () => {
  it("returns messages in chronological order (root first)", () => {
    const messages = createMessagePath(["m1", "m2", "m3"]);
    const snapshot = createSnapshot(messages, []);

    const result = walkPathFromHead(snapshot, "m3");

    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("returns single message for a root node", () => {
    const messages = [createMessage({ id: "root", role: "USER" })];
    const snapshot = createSnapshot(messages, []);

    const result = walkPathFromHead(snapshot, "root");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root");
  });

  it("returns empty array if head message not found", () => {
    const snapshot = createSnapshot([], []);

    const result = walkPathFromHead(snapshot, "nonexistent");

    expect(result).toEqual([]);
  });

  it("stops walking if parent chain is broken", () => {
    // m2 points to a non-existent parent
    const messages = [
      createMessage({ id: "m1", role: "USER", parentId: null }),
      createMessage({ id: "m2", role: "ASSISTANT", parentId: "ghost" }),
    ];
    const snapshot = createSnapshot(messages, []);

    const result = walkPathFromHead(snapshot, "m2");

    // Only m2 itself (parent "ghost" doesn't exist)
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m2");
  });
});

// ============================================================================
// selectCurrentPathMessages
// ============================================================================

describe("selectCurrentPathMessages", () => {
  it("returns empty array when no snapshot loaded", () => {
    const state = createStoreState();
    expect(selectCurrentPathMessages(state)).toEqual([]);
  });

  it("returns empty array when no branch selected", () => {
    const messages = createMessagePath(["m1", "m2"]);
    const snapshot = createSnapshot(messages, []);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    expect(selectCurrentPathMessages(state)).toEqual([]);
  });

  it("returns full path for a branch with head message", () => {
    const messages = createMessagePath(["m1", "m2", "m3"]);
    const branch = createBranch({ id: "b1", headMessageId: "m3" });
    const snapshot = createSnapshot(messages, [branch]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "b1",
        workspaceMode: "NORMAL",
        forkIntent: null,
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    } as any);

    const result = selectCurrentPathMessages(state);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});

// ============================================================================
// selectVisibleMessagesForWorkspace — Non-destructive truncation
// ============================================================================

describe("selectVisibleMessagesForWorkspace", () => {
  /**
   * Helper: build a state with a 5-message path and a given workspace mode.
   */
  function buildPathState(
    mode: "NORMAL" | "HISTORY_FORK" | "EDIT_FORK" | "COMPARE",
    sourceMessageId?: string
  ) {
    const messages = createMessagePath(["m1", "m2", "m3", "m4", "m5"]);
    const branch = createBranch({ id: "b1", headMessageId: "m5" });
    const snapshot = createSnapshot(messages, [branch]);

    return createStoreState({
      activeSnapshot: snapshot,
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "b1",
        workspaceMode: mode,
        forkIntent: sourceMessageId
          ? {
              sourceType: mode === "EDIT_FORK" ? "HISTORY_USER_EDIT" : "HISTORY_ASSISTANT",
              sourceBranchId: "b1",
              sourceMessageId,
            }
          : null,
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    } as any);
  }

  it("NORMAL mode shows full path (non-destructive: no truncation)", () => {
    const state = buildPathState("NORMAL");
    const visible = selectVisibleMessagesForWorkspace(state);
    expect(visible.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("HISTORY_FORK truncates at source message (inclusive)", () => {
    const state = buildPathState("HISTORY_FORK", "m3");
    const visible = selectVisibleMessagesForWorkspace(state);
    // m3 is the source, so visible = [m1, m2, m3]
    expect(visible.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("EDIT_FORK truncates at source message (inclusive)", () => {
    const state = buildPathState("EDIT_FORK", "m2");
    const visible = selectVisibleMessagesForWorkspace(state);
    // m2 is the source, so visible = [m1, m2]
    expect(visible.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("COMPARE mode shows zero messages (read-only view has own selectors)", () => {
    const state = buildPathState("COMPARE");
    const visible = selectVisibleMessagesForWorkspace(state);
    expect(visible).toEqual([]);
  });

  it("HISTORY_FORK without sourceMessageId falls back to full path", () => {
    const state = buildPathState("HISTORY_FORK");
    const visible = selectVisibleMessagesForWorkspace(state);
    expect(visible).toHaveLength(5);
  });
});

// ============================================================================
// selectHiddenDownstreamCount
// ============================================================================

describe("selectHiddenDownstreamCount", () => {
  it("returns 0 in NORMAL mode (nothing hidden)", () => {
    const messages = createMessagePath(["m1", "m2", "m3"]);
    const branch = createBranch({ id: "b1", headMessageId: "m3" });
    const snapshot = createSnapshot(messages, [branch]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "b1",
        workspaceMode: "NORMAL",
        forkIntent: null,
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    } as any);

    expect(selectHiddenDownstreamCount(state)).toBe(0);
  });

  it("returns correct count in HISTORY_FORK mode", () => {
    const messages = createMessagePath(["m1", "m2", "m3", "m4", "m5"]);
    const branch = createBranch({ id: "b1", headMessageId: "m5" });
    const snapshot = createSnapshot(messages, [branch]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: {
        activeConversationId: "conv_1",
        currentBranchId: "b1",
        workspaceMode: "HISTORY_FORK",
        forkIntent: {
          sourceType: "HISTORY_ASSISTANT",
          sourceBranchId: "b1",
          sourceMessageId: "m2",
        },
        compareState: null,
        variantPreview: null,
        pendingConvergeCount: 0,
      },
    } as any);

    // Full path: 5 messages, visible up to m2: 2 messages → hidden: 3
    expect(selectHiddenDownstreamCount(state)).toBe(3);
  });
});

// ============================================================================
// findForkPoint
// ============================================================================

describe("findForkPoint", () => {
  it("finds fork point when paths diverge at a message", () => {
    // Tree:
    //   m1 → m2 → m3 → m4a (left)
    //                → m4b (right)
    const m1 = createMessage({ id: "m1", role: "USER" });
    const m2 = createMessage({ id: "m2", role: "ASSISTANT", parentId: "m1" });
    const m3 = createMessage({ id: "m3", role: "USER", parentId: "m2" });
    const m4a = createMessage({ id: "m4a", role: "ASSISTANT", parentId: "m3" });
    const m4b = createMessage({ id: "m4b", role: "ASSISTANT", parentId: "m3" });

    const snapshot = createSnapshot([m1, m2, m3, m4a, m4b], []);

    // Fork point should be m3 (the common parent of m4a and m4b)
    expect(findForkPoint(snapshot, "m4a", "m4b")).toBe("m3");
  });

  it("returns the shared head when paths are identical", () => {
    const messages = createMessagePath(["m1", "m2", "m3"]);
    const snapshot = createSnapshot(messages, []);

    // Both heads point to the same node — LCA is that node itself
    expect(findForkPoint(snapshot, "m3", "m3")).toBe("m3");
  });

  it("handles one path being a prefix of the other", () => {
    const m1 = createMessage({ id: "m1", role: "USER" });
    const m2 = createMessage({ id: "m2", role: "ASSISTANT", parentId: "m1" });
    const m3 = createMessage({ id: "m3", role: "USER", parentId: "m2" });

    const snapshot = createSnapshot([m1, m2, m3], []);

    // Left head = m3 (longer), Right head = m2 (shorter, prefix)
    // LCA is m2 because it is the deepest node common to both paths
    const result = findForkPoint(snapshot, "m3", "m2");
    expect(result).toBe("m2");
  });
});

// ============================================================================
// selectVariantGroupByUserMessageId
// ============================================================================

describe("selectVariantGroupByUserMessageId", () => {
  it("identifies multiple assistant variants for a user message", () => {
    const m1 = createMessage({ id: "m1", role: "USER" });
    const m2a = createMessage({ id: "m2a", role: "ASSISTANT", parentId: "m1" });
    const m2b = createMessage({ id: "m2b", role: "ASSISTANT", parentId: "m1" });
    const m2c = createMessage({ id: "m2c", role: "ASSISTANT", parentId: "m1" });

    const snapshot = createSnapshot([m1, m2a, m2b, m2c], []);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    const group = selectVariantGroupByUserMessageId(state, "m1");
    expect(group.userMessageId).toBe("m1");
    expect(group.assistantMessageIds).toEqual(["m2a", "m2b", "m2c"]);
  });

  it("returns empty array when no snapshot", () => {
    const state = createStoreState();
    const group = selectVariantGroupByUserMessageId(state, "m1");
    expect(group.assistantMessageIds).toEqual([]);
  });

  it("excludes non-assistant children", () => {
    const m1 = createMessage({ id: "m1", role: "USER" });
    const m2a = createMessage({ id: "m2a", role: "ASSISTANT", parentId: "m1" });
    const m2b = createMessage({ id: "m2b", role: "USER", parentId: "m1" });

    const snapshot = createSnapshot([m1, m2a, m2b], []);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    const group = selectVariantGroupByUserMessageId(state, "m1");
    expect(group.assistantMessageIds).toEqual(["m2a"]);
  });
});
