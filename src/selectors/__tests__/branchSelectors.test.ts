/**
 * @file branchSelectors.test.ts
 * @description Tests for branch grouping, health governance, and mainline selectors.
 *
 * Product rules tested:
 *   - Siblings share the same forkPointMessageId
 *   - NearbyBranchGroups correctly categorizes branches
 *   - Branch health triggers SOFT at sibling>4 or active>8
 *   - Branch health triggers STRONG at sibling>6 or active>12
 *   - Mainline detection works correctly
 *   - Pending converge count = active - 1 (if mainline exists)
 */

import { describe, it, expect } from "vitest";
import {
  selectSiblingBranches,
  selectNearbyBranches,
  selectBranchHealth,
  selectMainlineBranch,
  selectIsCurrentBranchMainline,
  selectPendingConvergeCount,
  selectSuggestedCompareTargetBranchId,
  selectActiveBranches,
  selectArchivedBranches,
} from "../branchSelectors";
import {
  createStoreState,
  createBranch,
  createSnapshot,
} from "../../test/stateFactory";

// ============================================================================
// Helpers
// ============================================================================

/** Create a basic workspace state with a current branch */
function workspaceState(
  currentBranchId: string,
  mode: "NORMAL" | "COMPARE" = "NORMAL"
) {
  return {
    activeConversationId: "conv_1",
    currentBranchId,
    workspaceMode: mode,
    forkIntent: null,
    compareState: null,
    variantPreview: null,
    pendingConvergeCount: 0,
  };
}

// ============================================================================
// selectActiveBranches / selectArchivedBranches
// ============================================================================

describe("selectActiveBranches", () => {
  it("returns only ACTIVE branches", () => {
    const b1 = createBranch({ id: "b1", status: "ACTIVE" });
    const b2 = createBranch({ id: "b2", status: "ACTIVE" });
    const b3 = createBranch({ id: "b3", status: "ARCHIVED" });
    const snapshot = createSnapshot([], [b1, b2, b3]);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    const active = selectActiveBranches(state);
    expect(active).toHaveLength(2);
    expect(active.every((b) => b.status === "ACTIVE")).toBe(true);
  });
});

describe("selectArchivedBranches", () => {
  it("returns only ARCHIVED branches", () => {
    const b1 = createBranch({ id: "b1", status: "ACTIVE" });
    const b2 = createBranch({ id: "b2", status: "ARCHIVED" });
    const snapshot = createSnapshot([], [b1, b2]);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    const archived = selectArchivedBranches(state);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe("b2");
  });
});

// ============================================================================
// selectSiblingBranches
// ============================================================================

describe("selectSiblingBranches", () => {
  it("returns branches with same forkPointMessageId excluding current", () => {
    const b1 = createBranch({ id: "b1", forkPointMessageId: "m3" });
    const b2 = createBranch({ id: "b2", forkPointMessageId: "m3" });
    const b3 = createBranch({ id: "b3", forkPointMessageId: "m3" });
    const b4 = createBranch({ id: "b4", forkPointMessageId: "m5" }); // different fork point

    const snapshot = createSnapshot([], [b1, b2, b3, b4]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("b1"),
    } as any);

    const siblings = selectSiblingBranches(state);
    expect(siblings.map((b) => b.id)).toEqual(["b2", "b3"]);
  });

  it("returns empty array if current branch has no forkPointMessageId", () => {
    const b1 = createBranch({ id: "b1", forkPointMessageId: null });
    const snapshot = createSnapshot([], [b1]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("b1"),
    } as any);

    expect(selectSiblingBranches(state)).toEqual([]);
  });

  it("excludes ARCHIVED siblings", () => {
    const b1 = createBranch({ id: "b1", forkPointMessageId: "m3" });
    const b2 = createBranch({ id: "b2", forkPointMessageId: "m3", status: "ARCHIVED" });

    const snapshot = createSnapshot([], [b1, b2]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("b1"),
    } as any);

    expect(selectSiblingBranches(state)).toEqual([]);
  });
});

// ============================================================================
// selectNearbyBranches
// ============================================================================

describe("selectNearbyBranches", () => {
  it("categorizes branches into current, siblings, otherActive, archived", () => {
    const mainBranch = createBranch({
      id: "main",
      forkPointMessageId: "m3",
      isMainline: true,
    });
    const sibling1 = createBranch({ id: "sib1", forkPointMessageId: "m3" });
    const sibling2 = createBranch({ id: "sib2", forkPointMessageId: "m3" });
    const otherActive = createBranch({ id: "other1", forkPointMessageId: "m5" });
    const archived = createBranch({ id: "arch1", status: "ARCHIVED" });

    const snapshot = createSnapshot(
      [],
      [mainBranch, sibling1, sibling2, otherActive, archived]
    );
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("main"),
    } as any);

    const groups = selectNearbyBranches(state);

    expect(groups.currentBranch?.id).toBe("main");
    expect(groups.siblings.map((b) => b.id)).toEqual(["sib1", "sib2"]);
    expect(groups.otherActive.map((b) => b.id)).toEqual(["other1"]);
    expect(groups.archived.map((b) => b.id)).toEqual(["arch1"]);
  });

  it("returns all-empty when no snapshot", () => {
    const state = createStoreState();
    const groups = selectNearbyBranches(state);
    expect(groups.currentBranch).toBeNull();
    expect(groups.siblings).toEqual([]);
    expect(groups.otherActive).toEqual([]);
    expect(groups.archived).toEqual([]);
  });
});

// ============================================================================
// selectBranchHealth — Branch Explosion Governance
// ============================================================================

describe("selectBranchHealth", () => {
  /**
   * Build a state with N sibling branches and M total active branches.
   */
  function healthState(siblingCount: number, totalActive: number) {
    const branches: ReturnType<typeof createBranch>[] = [];

    // Current branch (forkPoint = "fork1")
    branches.push(createBranch({ id: "current", forkPointMessageId: "fork1" }));

    // Sibling branches (same forkPoint)
    for (let i = 0; i < siblingCount; i++) {
      branches.push(
        createBranch({ id: `sib_${i}`, forkPointMessageId: "fork1" })
      );
    }

    // Other active branches (different forkPoint)
    const otherCount = totalActive - 1 - siblingCount;
    for (let i = 0; i < otherCount; i++) {
      branches.push(
        createBranch({ id: `other_${i}`, forkPointMessageId: `fork_${i + 2}` })
      );
    }

    const snapshot = createSnapshot([], branches);
    return createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("current"),
    } as any);
  }

  it("returns NONE when counts are below thresholds", () => {
    const state = healthState(2, 4);
    const health = selectBranchHealth(state);
    expect(health.level).toBe("NONE");
    expect(health.needsWarning).toBe(false);
  });

  it("returns SOFT when sibling count > 4 (governance threshold)", () => {
    const state = healthState(5, 6);
    const health = selectBranchHealth(state);
    expect(health.level).toBe("SOFT");
    expect(health.needsWarning).toBe(true);
  });

  it("returns SOFT when active count > 8 (governance threshold)", () => {
    const state = healthState(2, 9);
    const health = selectBranchHealth(state);
    expect(health.level).toBe("SOFT");
    expect(health.needsWarning).toBe(true);
  });

  it("returns STRONG when sibling count > 6", () => {
    const state = healthState(7, 8);
    const health = selectBranchHealth(state);
    expect(health.level).toBe("STRONG");
    expect(health.needsWarning).toBe(true);
  });

  it("returns STRONG when active count > 12", () => {
    const state = healthState(3, 13);
    const health = selectBranchHealth(state);
    expect(health.level).toBe("STRONG");
    expect(health.needsWarning).toBe(true);
  });

  it("returns NONE when no snapshot or branch", () => {
    const state = createStoreState();
    const health = selectBranchHealth(state);
    expect(health.level).toBe("NONE");
    expect(health.needsWarning).toBe(false);
  });
});

// ============================================================================
// selectSuggestedCompareTargetBranchId
// ============================================================================

describe("selectSuggestedCompareTargetBranchId", () => {
  it("prefers the mainline branch when current branch is not mainline", () => {
    const current = createBranch({ id: "current", forkPointMessageId: "m1" });
    const mainline = createBranch({
      id: "mainline",
      forkPointMessageId: "m1",
      isMainline: true,
    });
    const sibling = createBranch({ id: "sibling", forkPointMessageId: "m1" });
    const snapshot = createSnapshot([], [current, mainline, sibling]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("current"),
    } as any);

    expect(selectSuggestedCompareTargetBranchId(state)).toBe("mainline");
  });

  it("falls back to a sibling when current branch is already mainline", () => {
    const current = createBranch({
      id: "current",
      forkPointMessageId: "m1",
      isMainline: true,
    });
    const sibling = createBranch({ id: "sibling", forkPointMessageId: "m1" });
    const other = createBranch({ id: "other", forkPointMessageId: "m2" });
    const snapshot = createSnapshot([], [current, sibling, other]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("current"),
    } as any);

    expect(selectSuggestedCompareTargetBranchId(state)).toBe("sibling");
  });

  it("returns null when there is no other active branch", () => {
    const current = createBranch({ id: "current", isMainline: true });
    const archived = createBranch({ id: "archived", status: "ARCHIVED" });
    const snapshot = createSnapshot([], [current, archived]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("current"),
    } as any);

    expect(selectSuggestedCompareTargetBranchId(state)).toBeNull();
  });
});

// ============================================================================
// selectMainlineBranch / selectIsCurrentBranchMainline
// ============================================================================

describe("selectMainlineBranch", () => {
  it("returns the branch marked as mainline", () => {
    const b1 = createBranch({ id: "b1", isMainline: true });
    const b2 = createBranch({ id: "b2", isMainline: false });
    const snapshot = createSnapshot([], [b1, b2]);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    expect(selectMainlineBranch(state)?.id).toBe("b1");
  });

  it("returns null when no mainline is set", () => {
    const b1 = createBranch({ id: "b1", isMainline: false });
    const snapshot = createSnapshot([], [b1]);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    expect(selectMainlineBranch(state)).toBeNull();
  });
});

describe("selectIsCurrentBranchMainline", () => {
  it("returns true when current branch is mainline", () => {
    const b1 = createBranch({ id: "b1", isMainline: true });
    const snapshot = createSnapshot([], [b1]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("b1"),
    } as any);

    expect(selectIsCurrentBranchMainline(state)).toBe(true);
  });

  it("returns false when current branch is not mainline", () => {
    const b1 = createBranch({ id: "b1", isMainline: false });
    const snapshot = createSnapshot([], [b1]);
    const state = createStoreState({
      activeSnapshot: snapshot,
      workspace: workspaceState("b1"),
    } as any);

    expect(selectIsCurrentBranchMainline(state)).toBe(false);
  });
});

// ============================================================================
// selectPendingConvergeCount
// ============================================================================

describe("selectPendingConvergeCount", () => {
  it("returns 0 when only 1 active branch (nothing to converge)", () => {
    const b1 = createBranch({ id: "b1", isMainline: true });
    const snapshot = createSnapshot([], [b1]);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    expect(selectPendingConvergeCount(state)).toBe(0);
  });

  it("returns activeCount - 1 when mainline exists", () => {
    const branches = [
      createBranch({ id: "b1", isMainline: true }),
      createBranch({ id: "b2" }),
      createBranch({ id: "b3" }),
      createBranch({ id: "b4" }),
    ];
    const snapshot = createSnapshot([], branches);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    // 4 active, 1 mainline → 3 pending
    expect(selectPendingConvergeCount(state)).toBe(3);
  });

  it("returns activeCount when no mainline (all count)", () => {
    const branches = [
      createBranch({ id: "b1", isMainline: false }),
      createBranch({ id: "b2", isMainline: false }),
    ];
    const snapshot = createSnapshot([], branches);
    const state = createStoreState({ activeSnapshot: snapshot } as any);

    // 2 active, no mainline → 2 pending
    expect(selectPendingConvergeCount(state)).toBe(2);
  });
});
