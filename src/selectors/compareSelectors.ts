/**
 * @file compareSelectors.ts
 * @description Pure function selectors for the compare mode.
 *
 * These selectors derive shared context and diverged content
 * from two branch paths, powering the CompareWorkspace component.
 *
 * Design principle: Compare mode is READ-ONLY.
 * These selectors only compute data for display; they do not
 * modify any state.
 */

import type { AppStore } from "../stores/appStore.types";
import type { BranchId, MessageId } from "../types/base";
import type { MessageNode, ConversationSnapshot, BranchEntity } from "../types/conversation";
import { walkPathFromHead, findForkPoint } from "./conversationSelectors";
import { stableSelector } from "./stable";

// ============================================================================
// Compare Data Structures
// ============================================================================

/** The result of comparing two branches */
export interface CompareData {
  /** The left branch entity */
  leftBranch: BranchEntity | null;

  /** The right branch entity */
  rightBranch: BranchEntity | null;

  /** The message where the two paths diverge (null if they share the full path) */
  forkPointMessageId: MessageId | null;

  /** Shared context messages (from root to fork point, exclusive) */
  sharedContextMessages: MessageNode[];

  /** Messages unique to the left branch (after fork point) */
  leftDivergedMessages: MessageNode[];

  /** Messages unique to the right branch (after fork point) */
  rightDivergedMessages: MessageNode[];
}

// ============================================================================
// Compare Selectors
// ============================================================================

/** Frozen default for selectCompareData when no compare state is active. */
const EMPTY_COMPARE_DATA: CompareData = Object.freeze({
  leftBranch: null,
  rightBranch: null,
  forkPointMessageId: null,
  sharedContextMessages: [],
  leftDivergedMessages: [],
  rightDivergedMessages: [],
});

/**
 * Raw implementation of selectCompareData.
 * Wrapped by stableSelector to guarantee reference stability.
 */
function selectCompareDataImpl(state: AppStore): CompareData {
  const snapshot = state.activeSnapshot;
  const compareState = state.workspace.compareState;
  if (!snapshot || !compareState) return EMPTY_COMPARE_DATA;

  const { leftBranchId, rightBranchId } = compareState;

  const leftBranch = snapshot.entities.branches[leftBranchId] ?? null;
  const rightBranch = snapshot.entities.branches[rightBranchId] ?? null;

  if (!leftBranch?.headMessageId || !rightBranch?.headMessageId) {
    return {
      ...EMPTY_COMPARE_DATA,
      leftBranch,
      rightBranch,
    };
  }

  // Find the fork point
  const forkPointId = findForkPoint(
    snapshot,
    leftBranch.headMessageId,
    rightBranch.headMessageId
  );

  // Get full paths
  const leftPath = walkPathFromHead(snapshot, leftBranch.headMessageId);
  const rightPath = walkPathFromHead(snapshot, rightBranch.headMessageId);

  // Split into shared context and diverged content
  const { shared, leftDiverged, rightDiverged } = splitPathsAtForkPoint(
    leftPath,
    rightPath,
    forkPointId
  );

  return {
    leftBranch,
    rightBranch,
    forkPointMessageId: forkPointId,
    sharedContextMessages: shared,
    leftDivergedMessages: leftDiverged,
    rightDivergedMessages: rightDiverged,
  };
}

/**
 * Get the full comparison data for two branches.
 *
 * Algorithm:
 * 1. Walk both paths from head to root
 * 2. Find the fork point (lowest common ancestor)
 * 3. Split each path into shared context + diverged content
 *
 * Returns a CompareData with null branches if snapshot not loaded
 * or branches not found.
 *
 * Wrapped with stableSelector for React 19 useSyncExternalStore compatibility.
 */
export const selectCompareData = stableSelector(
  selectCompareDataImpl,
  EMPTY_COMPARE_DATA,
);

/**
 * Get only the shared context messages for the current compare state.
 * Useful for the SharedContextStrip component.
 */
export function selectSharedContextMessages(state: AppStore): MessageNode[] {
  return selectCompareData(state).sharedContextMessages;
}

/**
 * Get only the diverged messages for each side.
 * Useful for the CompareColumn components.
 */
export function selectDivergedMessages(
  state: AppStore
): { left: MessageNode[]; right: MessageNode[] } {
  const data = selectCompareData(state);
  return {
    left: data.leftDivergedMessages,
    right: data.rightDivergedMessages,
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Split two paths at the fork point into:
 * - shared: messages common to both paths (before fork point)
 * - leftDiverged: messages only in the left path (after fork point)
 * - rightDiverged: messages only in the right path (after fork point)
 *
 * If forkPointId is null (one path is a prefix of the other),
 * the shorter path is entirely shared context.
 */
function splitPathsAtForkPoint(
  leftPath: MessageNode[],
  rightPath: MessageNode[],
  forkPointId: MessageId | null
): {
  shared: MessageNode[];
  leftDiverged: MessageNode[];
  rightDiverged: MessageNode[];
} {
  if (!forkPointId) {
    // One path is a prefix of the other
    // The shorter path is entirely shared, the rest is diverged
    const minLen = Math.min(leftPath.length, rightPath.length);
    const shared = leftPath.slice(0, minLen);
    const leftDiverged = leftPath.slice(minLen);
    const rightDiverged = rightPath.slice(minLen);
    return { shared, leftDiverged, rightDiverged };
  }

  // Find where the fork point is in each path
  const leftForkIndex = leftPath.findIndex((m) => m.id === forkPointId);
  const rightForkIndex = rightPath.findIndex((m) => m.id === forkPointId);

  // Shared context is everything up to (inclusive) the fork point
  // We include the fork point in shared context because it's the same message
  const sharedEndIndex = Math.max(leftForkIndex, rightForkIndex);

  if (sharedEndIndex < 0) {
    // Fork point not found in either path (shouldn't happen)
    return {
      shared: [],
      leftDiverged: leftPath,
      rightDiverged: rightPath,
    };
  }

  const shared = leftPath.slice(0, sharedEndIndex + 1);
  const leftDiverged = leftPath.slice(sharedEndIndex + 1);
  const rightDiverged = rightPath.slice(sharedEndIndex + 1);

  return { shared, leftDiverged, rightDiverged };
}
