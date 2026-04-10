/**
 * @file stateFactory.ts
 * @description Factory helpers for creating test state objects.
 *
 * These factories produce valid AppStore-like state objects for use in
 * selector and buildSendPlan tests. They follow the minimal-data principle:
 * only include fields that the code under test actually reads.
 *
 * Design goal: avoid large, brittle fixture files. Instead, compose
 * test state from small, focused factory functions.
 */

import type { AppStore } from "../stores/appStore.types";
import type { MessageNode, BranchEntity, ConversationSnapshot } from "../types/conversation";
import type { WorkspaceState, ComposerState, UiState } from "../types/workspace";

// ============================================================================
// Message Factory
// ============================================================================

let msgCounter = 0;

/**
 * Create a MessageNode with sensible defaults.
 * Override any field via the partial parameter.
 */
export function createMessage(
  overrides: Partial<MessageNode> & { id: string; role: MessageNode["role"] }
): MessageNode {
  msgCounter++;
  return {
    conversationId: "conv_1",
    status: "COMPLETED",
    parentId: null,
    childIds: [],
    depth: 0,
    content: { text: `Message content ${msgCounter}`, format: "MARKDOWN" },
    createdAt: 1000 + msgCounter,
    updatedAt: 1000 + msgCounter,
    ...overrides,
  };
}

/**
 * Create a chain of messages forming a linear path.
 * Returns messages in chronological order (root first).
 * Parent-child relationships are automatically wired.
 */
export function createMessagePath(
  ids: string[],
  roles: Array<"USER" | "ASSISTANT"> = []
): MessageNode[] {
  return ids.map((id, i) => {
    const role = roles[i] ?? (i % 2 === 0 ? "USER" : "ASSISTANT");
    return createMessage({
      id,
      role,
      parentId: i > 0 ? ids[i - 1] : null,
      depth: i,
    });
  });
}

// ============================================================================
// Branch Factory
// ============================================================================

let branchCounter = 0;

/**
 * Create a BranchEntity with sensible defaults.
 */
export function createBranch(
  overrides: Partial<BranchEntity> & { id: string }
): BranchEntity {
  branchCounter++;
  return {
    conversationId: "conv_1",
    name: `Branch ${branchCounter}`,
    status: "ACTIVE",
    isMainline: false,
    sourceBranchId: null,
    forkPointMessageId: null,
    forkSourceType: "ROOT",
    forkSourceMessageId: null,
    headMessageId: null,
    createdAt: 1000 + branchCounter,
    updatedAt: 1000 + branchCounter,
    ...overrides,
  };
}

// ============================================================================
// Snapshot Factory
// ============================================================================

/**
 * Create a minimal ConversationSnapshot from arrays of messages and branches.
 */
export function createSnapshot(
  messages: MessageNode[],
  branches: BranchEntity[],
  extra?: Partial<ConversationSnapshot>
): ConversationSnapshot {
  const now = Date.now();

  // Build childMessageIdsByParentId index
  const childMessageIdsByParentId: Record<string, string[]> = {};
  const rootMessageIds: string[] = [];

  for (const msg of messages) {
    if (!msg.parentId) {
      rootMessageIds.push(msg.id);
    } else {
      if (!childMessageIdsByParentId[msg.parentId]) {
        childMessageIdsByParentId[msg.parentId] = [];
      }
      childMessageIdsByParentId[msg.parentId].push(msg.id);
    }
  }

  // Build branchIdsByForkPointId index
  const branchIdsByForkPointId: Record<string, string[]> = {};
  for (const branch of branches) {
    if (branch.forkPointMessageId) {
      if (!branchIdsByForkPointId[branch.forkPointMessageId]) {
        branchIdsByForkPointId[branch.forkPointMessageId] = [];
      }
      branchIdsByForkPointId[branch.forkPointMessageId].push(branch.id);
    }
  }

  return {
    summary: {
      id: "conv_1",
      title: "Test Conversation",
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      archivedAt: null,
      mainlineBranchId: branches.find((b) => b.isMainline)?.id ?? null,
      activeBranchCount: branches.filter((b) => b.status === "ACTIVE").length,
      archivedBranchCount: branches.filter((b) => b.status === "ARCHIVED").length,
      totalMessageCount: messages.length,
    },
    entities: {
      messages: Object.fromEntries(messages.map((m) => [m.id, m])),
      branches: Object.fromEntries(branches.map((b) => [b.id, b])),
    },
    indexes: {
      rootMessageIds,
      childMessageIdsByParentId,
      branchIdsByForkPointId,
    },
    loadedAt: now,
    ...extra,
  };
}

// ============================================================================
// Store State Factory
// ============================================================================

/**
 * Create a complete AppStore-like state object for selector tests.
 * Selectors only read the fields they need, so we provide a minimal shape.
 */
export function createStoreState(
  overrides: Partial<AppStore> = {}
): AppStore {
  return {
    bootStatus: "READY",
    initializeApp: async () => {},
    restoreLastWorkspace: async () => {},

    providers: {},
    providerOrder: [],
    defaultModelId: null,
    loadSettings: async () => {},
    saveProvider: async () => ({
      id: "provider_1",
      type: "OPENAI_COMPATIBLE",
      name: "Provider 1",
      baseUrl: "https://api.openai.com/v1",
      hasApiKey: true,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    removeProvider: async () => {},
    setDefaultModel: async () => {},

    summariesById: {},
    summaryOrder: [],
    activeSnapshot: null,
    activeSnapshotStatus: "READY",
    loadConversationSummaries: async () => {},
    createConversation: async () => "conv_1",
    openConversation: async () => {},
    renameConversation: async () => ({
      id: "conv_1",
      title: "Renamed Conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
      archivedAt: null,
      mainlineBranchId: null,
      activeBranchCount: 1,
      archivedBranchCount: 0,
      totalMessageCount: 0,
    }),
    archiveConversation: async () => ({
      id: "conv_1",
      title: "Archived Conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
      archivedAt: Date.now(),
      mainlineBranchId: null,
      activeBranchCount: 0,
      archivedBranchCount: 0,
      totalMessageCount: 0,
    }),
    deleteConversation: async () => {},
    renameBranch: async () =>
      createBranch({
        id: "branch_1",
        name: "Renamed Branch",
      }),
    archiveBranch: async () =>
      createBranch({
        id: "branch_1",
        status: "ARCHIVED",
        archivedAt: Date.now(),
      }),
    unarchiveBranch: async () =>
      createBranch({
        id: "branch_1",
        status: "ACTIVE",
      }),
    setMainlineBranch: async () =>
      createBranch({
        id: "branch_1",
        isMainline: true,
      }),
    upsertMessageLocal: () => {},
    upsertBranchLocal: () => {},
    patchMessageLocal: () => {},
    patchBranchLocal: () => {},
    replaceActiveSnapshot: () => {},

    workspace: {
      activeConversationId: null,
      currentBranchId: null,
      workspaceMode: "NORMAL",
      forkIntent: null,
      compareState: null,
      variantPreview: null,
      pendingConvergeCount: 0,
    },
    setActiveConversation: () => {},
    setCurrentBranch: () => {},
    setWorkspaceMode: () => {},
    startHistoryFork: () => {},
    startEditFork: () => {},
    clearForkIntent: () => {},
    enterCompare: () => {},
    exitCompare: () => {},
    setVariantPreview: () => {},
    setPendingConvergeCount: () => {},

    composer: {
      draft: "",
      selectedModelId: null,
      sendMode: "APPEND",
      params: {},
      isSending: false,
      activeRequestId: null,
    },
    setDraft: () => {},
    clearDraft: () => {},
    setSelectedModelId: () => {},
    setSendMode: () => {},
    patchParams: () => {},
    setSendingState: () => {},
    resetComposerAfterSend: () => {},

    ui: {
      leftSidebarCollapsed: false,
      rightPanelCollapsed: false,
      rightPanelTab: "BRANCHES",
      exportDialogOpen: false,
      branchRenameDialogOpen: false,
    },
    setLeftSidebarCollapsed: () => {},
    setRightPanelCollapsed: () => {},
    setRightPanelTab: () => {},
    openExportDialog: () => {},
    closeExportDialog: () => {},
    openBranchRenameDialog: () => {},
    closeBranchRenameDialog: () => {},

    ...overrides,
  } as AppStore;
}
