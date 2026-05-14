/**
 * @file conversationSelectors.ts
 * @description Pure function selectors for conversation data, message paths,
 * and variant groups.
 *
 * All selectors are pure functions: (state: AppStore) => T
 * They can be used with Zustand's useAppStore(selector) pattern
 * and are independently testable.
 */
import type { AppStore } from "../stores/appStore.types";
import type { MessageId, BranchId } from "../types/base";
import type { MessageNode, ConversationSnapshot, ConversationSummary, BranchEntity } from "../types/conversation";
import type { DerivedVariantGroup } from "../types/variant";
import { stableArraySelector } from "./stable";
/** Frozen empty message list for selector stability. */
const EMPTY_MESSAGE_LIST: readonly MessageNode[] = Object.freeze([]);
// ============================================================================
// Basic Accessors
// ============================================================================
/**
 * Get the currently loaded conversation snapshot.
 * Returns null if no conversation is open.
 */
export function selectActiveSnapshot(state: AppStore): ConversationSnapshot | null {
  return state.activeSnapshot;
}
/**
 * Get the summary of the currently active conversation.
 * Returns null if no conversation is open.
 */
export function selectCurrentConversationSummary(state: AppStore): ConversationSummary | null {
  if (!state.workspace.activeConversationId) return null;
  // Prefer the summary from activeSnapshot if loaded
  if (state.activeSnapshot?.summary.id === state.workspace.activeConversationId) {
    return state.activeSnapshot.summary;
  }
  // Fall back to summaries map
  return state.summariesById[state.workspace.activeConversationId] ?? null;
}
/**
 * Get the currently selected branch entity.
 * Returns null if no branch is selected or snapshot not loaded.
 */
export function selectCurrentBranch(state: AppStore): BranchEntity | null {
  const snapshot = state.activeSnapshot;
  const branchId = state.workspace.currentBranchId;
  if (!snapshot || !branchId) return null;
  return snapshot.entities.branches[branchId] ?? null;
}
// ============================================================================
// Path Traversal (Core Tree Logic)
// ============================================================================
/**
 * Get the ordered message list for the current branch path.
 * Walks from headMessageId back to root via parentId, then reverses.
 *
 * Time complexity: O(n) where n is the path depth.
 * This is acceptable for v1; path caching can be added later.
 *
 * Returns empty array if:
 * - No snapshot loaded
 * - No branch selected
 * - Branch has no head message
 */
function selectCurrentPathMessagesImpl(state: AppStore): readonly MessageNode[] {
  const snapshot = state.activeSnapshot;
  const branchId = state.workspace.currentBranchId;
  if (!snapshot || !branchId) return EMPTY_MESSAGE_LIST;
  const branch = snapshot.entities.branches[branchId];
  if (!branch?.headMessageId) return EMPTY_MESSAGE_LIST;
  return walkPathFromHead(snapshot, branch.headMessageId);
}
/**
 * Stable selector for the ordered message list of the current branch path.
 */
export const selectCurrentPathMessages = stableArraySelector(
  selectCurrentPathMessagesImpl,
  EMPTY_MESSAGE_LIST,
);
/**
 * Get the visible messages for the current workspace mode.
 *
 * Behavior by mode:
 * - NORMAL: returns full current path
 * - HISTORY_FORK: returns messages up to (inclusive) the source message
 * - EDIT_FORK: returns messages up to (inclusive) the source message
 * - COMPARE: returns empty array (compare has its own selectors)
 */
function selectVisibleMessagesForWorkspaceImpl(
  state: AppStore
): readonly MessageNode[] {
  const fullPath = selectCurrentPathMessages(state);
  const snapshot = state.activeSnapshot;
  if (state.workspace.workspaceMode === "COMPARE") {
    return EMPTY_MESSAGE_LIST;
  }
  if (snapshot && state.workspace.variantPreview?.assistantMessageId) {
    const preview = state.workspace.variantPreview;
    const previewAssistant =
      snapshot.entities.messages[preview.assistantMessageId] ?? null;
    const sourceIndex = fullPath.findIndex((message) => message.id === preview.userMessageId);
    if (previewAssistant && sourceIndex >= 0) {
      const currentAssistantIndex = fullPath.findIndex(
        (message, index) => index > sourceIndex && message.role === "ASSISTANT"
      );
      const leadingPath = fullPath.slice(0, sourceIndex + 1);
      if (currentAssistantIndex < 0) {
        return [...leadingPath, previewAssistant];
      }
      if (fullPath[currentAssistantIndex]?.id === previewAssistant.id) {
        return preview.hasDownstreamConflict
          ? fullPath.slice(0, currentAssistantIndex + 1)
          : fullPath;
      }
      return preview.hasDownstreamConflict
        ? [...leadingPath, previewAssistant]
        : [
            ...leadingPath,
            previewAssistant,
            ...fullPath.slice(currentAssistantIndex + 1),
          ];
    }
  }
  if (state.workspace.workspaceMode === "NORMAL") {
    return fullPath;
  }
  // HISTORY_FORK or EDIT_FORK: show only up to the source message
  if (state.workspace.workspaceMode === "EDIT_INLINE") {
    const editMsgId = state.workspace.forkIntent?.originalEditableMessageId;
    if (!editMsgId) return fullPath;
    const index = fullPath.findIndex((m) => m.id === editMsgId);
    if (index < 0) return fullPath;
    return fullPath.slice(0, index + 1);
  }
  const sourceMessageId = state.workspace.forkIntent?.sourceMessageId;
  if (!sourceMessageId) return fullPath;
  const index = fullPath.findIndex((m) => m.id === sourceMessageId);
  if (index < 0) return fullPath;
  return fullPath.slice(0, index + 1);
}
/**
 * Stable selector for the message list visible in the current workspace mode.
 */
export const selectVisibleMessagesForWorkspace = stableArraySelector(
  selectVisibleMessagesForWorkspaceImpl,
  EMPTY_MESSAGE_LIST,
);
/**
 * Get the number of messages hidden by the current workspace mode.
 * Used to display the DownstreamHiddenCard ("原路径后续 N 条消息已隐藏").
 */
export function selectHiddenDownstreamCount(state: AppStore): number {
  const fullPath = selectCurrentPathMessages(state);
  const visiblePath = selectVisibleMessagesForWorkspace(state);
  return fullPath.length - visiblePath.length;
}
// ============================================================================
// Variant Groups
// ============================================================================
/**
 * Derive a variant group for a given user message.
 * Returns all assistant messages that are children of the specified user message.
 *
 * This is computed purely from the message tree — no persistence needed.
 * A variant group exists whenever a user message has multiple assistant children
 * (e.g., from "regenerate" or multi-model responses).
 */
export function selectVariantGroupByUserMessageId(
  state: AppStore,
  userMessageId: MessageId
): DerivedVariantGroup {
  const snapshot = state.activeSnapshot;
  if (!snapshot) {
    return { userMessageId, assistantMessageIds: [] };
  }
  const childIds = snapshot.indexes.childMessageIdsByParentId[userMessageId] ?? [];
  const assistantIds = childIds.filter(
    (id) => snapshot.entities.messages[id]?.role === "ASSISTANT"
  );
  return {
    userMessageId,
    assistantMessageIds: assistantIds,
  };
}
/**
 * Check if a message has multiple variants (candidate answers).
 * Useful for showing the VariantHintBadge ("3 个候选").
 */
export function selectHasVariants(state: AppStore, userMessageId: MessageId): boolean {
  const group = selectVariantGroupByUserMessageId(state, userMessageId);
  return group.assistantMessageIds.length > 1;
}
/**
 * Get the number of variants for a message.
 */
export function selectVariantCount(state: AppStore, userMessageId: MessageId): number {
  return selectVariantGroupByUserMessageId(state, userMessageId).assistantMessageIds.length;
}
// ============================================================================
// Internal Helpers (Pure Functions)
// ============================================================================
/**
 * Walk from a head message back to root via parentId.
 * Returns messages in chronological order (root first).
 *
 * This is the fundamental tree traversal function that all path-based
 * selectors build upon.
 */
export function walkPathFromHead(
  snapshot: ConversationSnapshot,
  headMessageId: MessageId
): MessageNode[] {
  const result: MessageNode[] = [];
  let cursor: MessageId | null = headMessageId;
  while (cursor) {
    const msg: MessageNode | undefined = snapshot.entities.messages[cursor];
    if (!msg) break;
    result.push(msg);
    cursor = msg.parentId;
  }
  return result.reverse();
}
/**
 * Find the fork point (lowest common ancestor) between two message paths.
 * Returns the message ID where the two paths diverge, or null if they
 * share the same entire path.
 *
 * Used by compare mode to determine shared context vs diverged content.
 */
export function findForkPoint(
  snapshot: ConversationSnapshot,
  leftHeadId: MessageId,
  rightHeadId: MessageId
): MessageId | null {
  const leftAncestors = new Set<MessageId>();
  let cursor: MessageId | null = leftHeadId;
  while (cursor) {
    leftAncestors.add(cursor);
    cursor = snapshot.entities.messages[cursor]?.parentId ?? null;
  }
  // Walk the right path upward until we find a node that IS in the left path.
  // That node is the true LCA (fork point).
  cursor = rightHeadId;
  while (cursor) {
    if (leftAncestors.has(cursor)) {
      // This is the lowest common ancestor — the fork point
      return cursor;
    }
    cursor = snapshot.entities.messages[cursor]?.parentId ?? null;
  }
  // No common ancestor found
  return null;
}

/**
 * Find the best branch to display a specific message.
 *
 * Strategy:
 *   1. If any branch has headMessageId === targetMessageId, use it (exact match).
 *   2. Otherwise, walk from each branch head back to root; pick the first branch
 *      whose path includes the target message.
 *   3. Prefer non-archived branches.
 *   4. Falls back to null if no branch contains the message.
 */
export function findBranchContainingMessage(
  snapshot: ConversationSnapshot,
  targetMessageId: MessageId
): BranchId | null {
  const branches = Object.values(snapshot.entities.branches);

  // 1. Exact head match (fast path)
  const exactMatch = branches.find((b) => b.headMessageId === targetMessageId && !b.archivedAt);
  if (exactMatch) return exactMatch.id;

  // Also check archived
  const exactMatchAny = branches.find((b) => b.headMessageId === targetMessageId);
  if (exactMatchAny) return exactMatchAny.id;

  // 2. Walk each branch path and check for containment
  const messages = snapshot.entities.messages;
  let bestBranchId: BranchId | null = null;
  let bestIsArchived = true;

  for (const branch of branches) {
    if (!branch.headMessageId) continue;
    let cursor: MessageId | null = branch.headMessageId;
    while (cursor) {
      if (cursor === targetMessageId) {
        // Prefer non-archived
        if (!branch.archivedAt) return branch.id;
        if (bestBranchId === null) {
          bestBranchId = branch.id;
          bestIsArchived = true;
        }
        break;
      }
      cursor = messages[cursor]?.parentId ?? null;
    }
  }

  return bestBranchId;
}
