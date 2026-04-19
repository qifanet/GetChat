/**
 * @file globalViewSelectors.ts
 * @description Selectors for the conversation global mind-map view.
 *
 * Builds a tree of GlobalViewNode from the snapshot, where each node
 * represents a message and branches create fan-out children.
 */
import type { AppStore } from "../stores/appStore.types";
import type { BranchEntity, ConversationSnapshot, MessageNode } from "../types/conversation";
import { stableSelector } from "./stable";
// ============================================================================
// Data Types
// ============================================================================
export type MessageRole = "USER" | "ASSISTANT";
/** A single node in the global view tree. */
export interface GlobalViewNode {
  /** Message ID. */
  id: string;
  /** Message role. */
  role: MessageRole;
  /** First 120 chars of text for compact display. */
  label: string;
  /** First 200 chars for tooltip. */
  preview: string;
  /** Which branch this message belongs to (the branch whose path includes it). */
  branchId: string;
  /** Child message nodes. Multiple children = fork point. */
  children: GlobalViewNode[];
  /** Branch entities that fork from this message (empty if not a fork point). */
  forkBranches: BranchEntity[];
}
/** The full global view data. */
export interface GlobalViewData {
  /** Root nodes (usually one for the start of the conversation). */
  roots: GlobalViewNode[];
  /** All active branches keyed by ID for quick lookup. */
  branchesById: Record<string, BranchEntity>;
  /** Total message count. */
  messageCount: number;
  /** Total branch count (active). */
  branchCount: number;
}
const EMPTY_GLOBAL_VIEW: GlobalViewData = Object.freeze({
  roots: [],
  branchesById: {},
  messageCount: 0,
  branchCount: 0,
});
// ============================================================================
// Helpers
// ============================================================================
const MAX_GLOBAL_DEPTH = 64;
function getTextPreview(snapshot: ConversationSnapshot, msgId: string): { label: string; preview: string } {
  const msg: MessageNode | undefined = snapshot.entities.messages[msgId];
  const text = msg?.content?.text ?? "";
  return {
    label: text.slice(0, 120),
    preview: text.slice(0, 200),
  };
}
/**
 * Walk the message tree starting from a given message ID,
 * building GlobalViewNode children along the way.
 */
function buildMessageSubtree(
  snapshot: ConversationSnapshot,
  messageId: string,
  branchId: string,
  branchChildren: Map<string, string[]>,
  messageToBranches: Map<string, BranchEntity[]>,
  visited: Set<string>,
  depth: number,
): GlobalViewNode {
  const msg: MessageNode | undefined = snapshot.entities.messages[messageId];
  const { label, preview } = getTextPreview(snapshot, messageId);
  const forkBranches = messageToBranches.get(messageId) ?? [];
  const node: GlobalViewNode = {
    id: messageId,
    role: (msg?.role as MessageRole) ?? "USER",
    label,
    preview,
    branchId,
    children: [],
    forkBranches,
  };
  if (depth >= MAX_GLOBAL_DEPTH || !msg) return node;
  // Get all child message IDs from the snapshot index
  const childIds = snapshot.indexes.childMessageIdsByParentId[messageId] ?? [];
  for (const childId of childIds) {
    if (visited.has(childId)) continue;
    visited.add(childId);
    // Determine which branch this child belongs to.
    // If a branch starts from this child (fork point = this message, and child is
    // the first message of that branch), use that branch. Otherwise inherit parent.
    let childBranchId = branchId;
    const childMsg = snapshot.entities.messages[childId];
    if (childMsg) {
      // Check if this child is the head of any branch that was created from this fork
      for (const fb of forkBranches) {
        if (fb.headMessageId && isDescendantOf(snapshot, childId, fb.headMessageId)) {
          // This child is on the forked branch path
          childBranchId = fb.id;
          break;
        }
      }
    }
    node.children.push(
      buildMessageSubtree(
        snapshot,
        childId,
        childBranchId,
        branchChildren,
        messageToBranches,
        visited,
        depth + 1,
      ),
    );
  }
  return node;
}
/**
 * Check if `targetId` is a descendant of `ancestorId` (or the same).
 */
function isDescendantOf(
  snapshot: ConversationSnapshot,
  ancestorId: string,
  targetId: string,
): boolean {
  let cursor: string | null = targetId;
  while (cursor) {
    if (cursor === ancestorId) return true;
    const msg: MessageNode | undefined = snapshot.entities.messages[cursor];
    if (!msg) break;
    cursor = msg.parentId;
  }
  return false;
}
// ============================================================================
// Main Selector
// ============================================================================
function selectGlobalViewImpl(state: AppStore): GlobalViewData {
  const snapshot = state.activeSnapshot;
  if (!snapshot) return EMPTY_GLOBAL_VIEW;
  const allBranches = Object.values(snapshot.entities.branches);
  const activeBranches = allBranches.filter((b) => b.status === "ACTIVE");
  const archivedBranches = allBranches.filter((b) => b.status === "ARCHIVED");
  if (activeBranches.length === 0) return EMPTY_GLOBAL_VIEW;
  const branchesById: Record<string, BranchEntity> = {};
  for (const b of activeBranches) branchesById[b.id] = b;
  for (const b of archivedBranches) branchesById[b.id] = b;
  // Map: forkPointMessageId -> list of branches that fork from it
  const messageToBranches = new Map<string, BranchEntity[]>();
  for (const branch of activeBranches) {
    if (branch.forkPointMessageId) {
      if (!messageToBranches.has(branch.forkPointMessageId)) {
        messageToBranches.set(branch.forkPointMessageId, []);
      }
      messageToBranches.get(branch.forkPointMessageId)!.push(branch);
    }
  }
  // Find root messages (parentId = null)
  const allMessages = Object.values(snapshot.entities.messages);
  const rootMessages = allMessages.filter((m) => m.parentId === null);
  // Map: branchId -> child branch IDs
  const branchChildren = new Map<string, string[]>();
  for (const branch of activeBranches) {
    const parentId = branch.sourceBranchId;
    if (parentId) {
      if (!branchChildren.has(parentId)) branchChildren.set(parentId, []);
      branchChildren.get(parentId)!.push(branch.id);
    }
  }
  const mainline = activeBranches.find((b) => b.isMainline);
  const defaultBranchId = mainline?.id ?? activeBranches[0]?.id ?? "";
  const visited = new Set<string>();
  const roots: GlobalViewNode[] = [];
  for (const rootMsg of rootMessages) {
    if (visited.has(rootMsg.id)) continue;
    visited.add(rootMsg.id);
    roots.push(
      buildMessageSubtree(
        snapshot,
        rootMsg.id,
        defaultBranchId,
        branchChildren,
        messageToBranches,
        visited,
        0,
      ),
    );
  }
  return {
    roots,
    branchesById,
    messageCount: allMessages.length,
    branchCount: activeBranches.length,
  };
}
export const selectGlobalView = stableSelector(selectGlobalViewImpl, EMPTY_GLOBAL_VIEW);
