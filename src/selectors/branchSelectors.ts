/**
 * @file branchSelectors.ts
 * @description Pure function selectors for branch navigation, grouping,
 * and health monitoring.
 *
 * These selectors power the right-side branch panel and the
 * branch explosion governance system.
 */

import type { AppStore } from "../stores/appStore.types";
import type { BranchId, MessageId } from "../types/base";
import type { BranchEntity, ConversationSnapshot } from "../types/conversation";
import { stableSelector } from "./stable";

// ============================================================================
// Branch List Selectors
// ============================================================================

/**
 * Get all branches with the given status.
 */
export function selectBranchesByStatus(
  state: AppStore,
  status: "ACTIVE" | "ARCHIVED"
): BranchEntity[] {
  const snapshot = state.activeSnapshot;
  if (!snapshot) return [];

  return Object.values(snapshot.entities.branches).filter(
    (b) => b.status === status
  );
}

/**
 * Get all active branches in the current conversation.
 */
export function selectActiveBranches(state: AppStore): BranchEntity[] {
  return selectBranchesByStatus(state, "ACTIVE");
}

/**
 * Get all archived branches in the current conversation.
 */
export function selectArchivedBranches(state: AppStore): BranchEntity[] {
  return selectBranchesByStatus(state, "ARCHIVED");
}

/**
 * Get branches that share the same fork point as the current branch.
 * These are "sibling" branches in the tree.
 */
export function selectSiblingBranches(state: AppStore): BranchEntity[] {
  const snapshot = state.activeSnapshot;
  const currentBranchId = state.workspace.currentBranchId;
  if (!snapshot || !currentBranchId) return [];

  const currentBranch = snapshot.entities.branches[currentBranchId];
  if (!currentBranch?.forkPointMessageId) return [];

  const forkPointId = currentBranch.forkPointMessageId;
  const branchIdsAtFork = snapshot.indexes.branchIdsByForkPointId[forkPointId] ?? [];

  return branchIdsAtFork
    .map((id) => snapshot.entities.branches[id])
    .filter(
      (b): b is BranchEntity =>
        !!b &&
        b.id !== currentBranchId &&
        b.status === "ACTIVE"
    );
}

// ============================================================================
// Nearby Branches (for Branch Panel)
// ============================================================================

/**
 * Categorized branches for the "nearby" view in the branch panel.
 * Groups branches into:
 * - currentPath: the currently selected branch
 * - siblings: branches at the same fork point
 * - otherActive: all other active branches
 * - archived: all archived branches
 */
export interface NearbyBranchGroups {
  currentBranch: BranchEntity | null;
  siblings: BranchEntity[];
  otherActive: BranchEntity[];
  archived: BranchEntity[];
}

/** Frozen default for selectNearbyBranches when no snapshot is loaded. */
const EMPTY_NEARBY_GROUPS: NearbyBranchGroups = Object.freeze({
  currentBranch: null,
  siblings: [],
  otherActive: [],
  archived: [],
});

/**
 * Raw implementation of selectNearbyBranches.
 * Wrapped by stableSelector to guarantee reference stability.
 */
function selectNearbyBranchesImpl(state: AppStore): NearbyBranchGroups {
  const snapshot = state.activeSnapshot;
  const currentBranchId = state.workspace.currentBranchId;
  if (!snapshot) return EMPTY_NEARBY_GROUPS;

  const currentBranch = currentBranchId
    ? snapshot.entities.branches[currentBranchId] ?? null
    : null;

  const siblings = selectSiblingBranches(state);
  const siblingIds = new Set(siblings.map((b) => b.id));

  const allActive = selectActiveBranches(state);
  const otherActive = allActive.filter(
    (b) =>
      b.id !== currentBranchId &&
      !siblingIds.has(b.id)
  );

  const archived = selectArchivedBranches(state);

  return { currentBranch, siblings, otherActive, archived };
}

/**
 * Get the grouped branch list for the right panel's "nearby" view.
 * This is the primary data source for the BranchPanel component.
 *
 * Wrapped with stableSelector for React 19 useSyncExternalStore compatibility.
 */
export const selectNearbyBranches = stableSelector(
  selectNearbyBranchesImpl,
  EMPTY_NEARBY_GROUPS,
);

// ============================================================================
// Branch Children (for BranchHintBadge)
// ============================================================================

/**
 * Get the number of child branches at a given message node.
 * Used to display BranchHintBadge ("2 条后续路线").
 */
export function selectChildBranchCountAtMessage(
  state: AppStore,
  messageId: MessageId
): number {
  const snapshot = state.activeSnapshot;
  if (!snapshot) return 0;

  const branchIds = snapshot.indexes.branchIdsByForkPointId[messageId] ?? [];
  return branchIds.filter(
    (id) => snapshot.entities.branches[id]?.status === "ACTIVE"
  ).length;
}

/**
 * Get all branches that fork from a given message.
 */
export function selectBranchesAtForkPoint(
  state: AppStore,
  messageId: MessageId
): BranchEntity[] {
  const snapshot = state.activeSnapshot;
  if (!snapshot) return [];

  const branchIds = snapshot.indexes.branchIdsByForkPointId[messageId] ?? [];
  return branchIds
    .map((id) => snapshot.entities.branches[id])
    .filter((b): b is BranchEntity => !!b);
}

// ============================================================================
// Converge Count
// ============================================================================

/**
 * Get the number of active branches pending convergence.
 * This is defined as: (total active branches) - 1 (the mainline).
 * If no mainline is set, all active branches count.
 */
export function selectPendingConvergeCount(state: AppStore): number {
  const snapshot = state.activeSnapshot;
  if (!snapshot) return 0;

  const activeBranches = Object.values(snapshot.entities.branches).filter(
    (b) => b.status === "ACTIVE"
  );

  if (activeBranches.length <= 1) return 0;

  // Subtract the mainline branch
  const hasMainline = activeBranches.some((b) => b.isMainline);
  return hasMainline ? activeBranches.length - 1 : activeBranches.length;
}

// ============================================================================
// Branch Health (Explosion Governance)
// ============================================================================

/** Branch health assessment for governance warnings */
export interface BranchHealth {
  /** Number of active sibling branches at the current fork point */
  siblingCount: number;

  /** Total number of active branches in the conversation */
  activeCount: number;

  /** Whether a warning should be shown */
  needsWarning: boolean;

  /** Warning severity level */
  level: "NONE" | "SOFT" | "STRONG";
}

/** Frozen default for selectBranchHealth when no snapshot is loaded. */
const EMPTY_BRANCH_HEALTH: BranchHealth = Object.freeze({
  siblingCount: 0,
  activeCount: 0,
  needsWarning: false,
  level: "NONE",
});

/**
 * Raw implementation of selectBranchHealth.
 * Wrapped by stableSelector to guarantee reference stability.
 */
function selectBranchHealthImpl(state: AppStore): BranchHealth {
  const snapshot = state.activeSnapshot;
  const currentBranchId = state.workspace.currentBranchId;

  if (!snapshot || !currentBranchId) {
    return EMPTY_BRANCH_HEALTH;
  }

  const siblings = selectSiblingBranches(state);
  const activeBranches = selectActiveBranches(state);

  const siblingCount = siblings.length;
  const activeCount = activeBranches.length;

  let level: BranchHealth["level"] = "NONE";
  if (siblingCount > 4 || activeCount > 8) level = "SOFT";
  if (siblingCount > 6 || activeCount > 12) level = "STRONG";

  return {
    siblingCount,
    activeCount,
    needsWarning: level !== "NONE",
    level,
  };
}

/**
 * Assess the health of the current branch situation.
 *
 * Governance thresholds:
 * - SOFT warning: siblingCount > 4 OR activeCount > 8
 * - STRONG warning: siblingCount > 6 OR activeCount > 12
 *
 * These are non-blocking: the UI shows a suggestion, not a blocker.
 *
 * Wrapped with stableSelector for React 19 useSyncExternalStore compatibility.
 */
export const selectBranchHealth = stableSelector(
  selectBranchHealthImpl,
  EMPTY_BRANCH_HEALTH,
);

// ============================================================================
// Compare Suggestions
// ============================================================================

/**
 * Pick the most useful active branch to compare with the current branch.
 * Priority:
 *   1. The mainline branch (when current is not mainline)
 *   2. A sibling branch at the same fork point
 *   3. Any other active branch
 */
export function selectSuggestedCompareTargetBranchId(
  state: AppStore
): BranchId | null {
  const snapshot = state.activeSnapshot;
  const currentBranchId = state.workspace.currentBranchId;
  if (!snapshot || !currentBranchId) return null;

  const activeBranches = Object.values(snapshot.entities.branches).filter(
    (branch) => branch.status === "ACTIVE" && branch.id !== currentBranchId
  );
  if (activeBranches.length === 0) return null;

  const mainlineBranch = activeBranches.find((branch) => branch.isMainline);
  if (mainlineBranch) {
    return mainlineBranch.id;
  }

  const siblingBranch = selectSiblingBranches(state)[0];
  if (siblingBranch) {
    return siblingBranch.id;
  }

  return activeBranches[0]?.id ?? null;
}

// ============================================================================
// Mainline
// ============================================================================

/**
 * Get the mainline branch for the current conversation.
 */
export function selectMainlineBranch(state: AppStore): BranchEntity | null {
  const snapshot = state.activeSnapshot;
  if (!snapshot) return null;

  return (
    Object.values(snapshot.entities.branches).find(
      (b) => b.isMainline && b.status === "ACTIVE"
    ) ?? null
  );
}

/**
 * Check if the current branch is the mainline.
 */
export function selectIsCurrentBranchMainline(state: AppStore): boolean {
  const branchId = state.workspace.currentBranchId;
  if (!branchId || !state.activeSnapshot) return false;
  return state.activeSnapshot.entities.branches[branchId]?.isMainline ?? false;
}
