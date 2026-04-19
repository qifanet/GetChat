/**
 * @file appStore.types.ts
 * @description Type definitions for all slices in the main application store.
 *
 * The appStore follows a slice pattern where each slice manages a cohesive
 * domain of state. All slices are combined into a single store to avoid
 * cross-store synchronization issues.
 *
 * Store architecture:
 *   useAppStore (single store, multiple slices)
 *   ├── AppSlice        — bootstrap, initialization
 *   ├── SettingsSlice   — providers, models, defaults
 *   ├── ConversationSlice — summaries, active snapshot, conversation/branch CRUD
 *   ├── WorkspaceSlice  — mode, branch, fork intent, compare
 *   ├── ComposerSlice   — draft, model selection, send mode
 *   └── UiSlice         — sidebar, panels, dialogs
 *
 *   useStreamStore (separate store)
 *   └── Stream session metadata only
 */

import type {
  BranchId,
  ConversationId,
  MessageId,
  ModelId,
  RightPanelTab,
  SendMode,
  WorkspaceMode,
} from "../types/base";
import type {
  BranchEntity,
  ConversationSnapshot,
  ConversationSummary,
  MessageNode,
} from "../types/conversation";
import type {
  CompareState,
  ComposerState,
  ForkIntent,
  UiState,
  VariantPreviewContext,
  WorkspaceState,
} from "../types/workspace";
import type {
  GenerationParams,
  ModelProfile,
  ProviderConfig,
  ProviderSaveInput,
} from "../types/settings";

// ============================================================================
// AppSlice — Bootstrap & Initialization
// ============================================================================

export interface AppSlice {
  bootStatus: "IDLE" | "LOADING" | "READY" | "FAILED";
  bootError?: string;

  /** Initialize app: load settings, summaries, restore last workspace */
  initializeApp: () => Promise<void>;

  /** Restore the last opened conversation and branch */
  restoreLastWorkspace: () => Promise<void>;
}

// ============================================================================
// SettingsSlice — Provider & Model Configuration
// ============================================================================

export interface SettingsSlice {
  providers: Record<string, ProviderConfig>;
  providerModels: Record<ModelId, ModelProfile>;
  providerOrder: string[];
  defaultModelId: ModelId | null;

  loadSettings: () => Promise<void>;
  saveProvider: (input: ProviderSaveInput) => Promise<ProviderConfig>;
  removeProvider: (providerId: string) => Promise<void>;
  setDefaultModel: (modelId: ModelId | null) => Promise<void>;
}

// ============================================================================
// ConversationSlice — Summaries & Active Snapshot
// ============================================================================

export interface ConversationSlice {
  /** Lightweight summaries for the sidebar */
  summariesById: Record<ConversationId, ConversationSummary>;
  summaryOrder: ConversationId[];

  /**
   * Full snapshot of the currently open conversation.
   * Only ONE conversation is loaded as a full snapshot at a time.
   * Other conversations are represented by summaries only.
   */
  activeSnapshot: ConversationSnapshot | null;
  activeSnapshotStatus: "IDLE" | "LOADING" | "READY" | "FAILED";
  activeSnapshotError?: string;

  // --- Async operations (delegate to services) ---
  loadConversationSummaries: () => Promise<void>;
  createConversation: () => Promise<ConversationId>;
  openConversation: (conversationId: ConversationId) => Promise<void>;
  renameConversation: (conversationId: ConversationId, title: string) => Promise<ConversationSummary>;
  archiveConversation: (conversationId: ConversationId) => Promise<ConversationSummary>;
  deleteConversation: (conversationId: ConversationId) => Promise<void>;
  renameBranch: (branchId: BranchId, name: string) => Promise<BranchEntity>;
  setBranchPreferredModel: (
    branchId: BranchId,
    modelId: ModelId | null
  ) => Promise<BranchEntity>;
  setBranchHeadMessage: (
    branchId: BranchId,
    messageId: MessageId
  ) => Promise<BranchEntity>;
  archiveBranch: (branchId: BranchId) => Promise<BranchEntity>;
  unarchiveBranch: (branchId: BranchId) => Promise<BranchEntity>;
  setMainlineBranch: (
    conversationId: ConversationId,
    branchId: BranchId
  ) => Promise<BranchEntity>;

  // --- Local mutations (applied after service confirms) ---
  upsertMessageLocal: (message: MessageNode) => void;
  upsertBranchLocal: (branch: BranchEntity) => void;
  patchMessageLocal: (messageId: MessageId, patch: Partial<MessageNode>) => void;
  deleteMessageHard: (messageId: MessageId) => Promise<void>;
  editUserMessageInline: (messageId: MessageId, newContent: string) => Promise<void>;
  patchBranchLocal: (branchId: BranchId, patch: Partial<BranchEntity>) => void;
  replaceActiveSnapshot: (snapshot: ConversationSnapshot) => void;
}

// ============================================================================
// WorkspaceSlice — Mode, Branch, Fork, Compare
// ============================================================================

export interface WorkspaceSlice {
  workspace: WorkspaceState;

  setActiveConversation: (conversationId: ConversationId | null) => void;
  setCurrentBranch: (branchId: BranchId | null) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;

  /** Enter HISTORY_FORK mode with a fork intent */
  startHistoryFork: (intent: ForkIntent) => void;

  /** Enter EDIT_FORK mode with a fork intent */
  startEditFork: (intent: ForkIntent) => void;

  /** Enter EDIT_INLINE mode — edit a user message without creating a branch */
  startEditInline: (messageId: MessageId) => void;

  /** Clear fork intent and return to NORMAL mode */
  clearForkIntent: () => void;

  /** Enter COMPARE mode (disables composer) */
  enterCompare: (compareState: CompareState) => void;

  /** Exit COMPARE mode, return to NORMAL */
  exitCompare: () => void;

  setVariantPreview: (ctx: VariantPreviewContext | null) => void;
  setPendingConvergeCount: (count: number) => void;
}

// ============================================================================
// ComposerSlice — Draft, Model, Send Mode
// ============================================================================

export interface ComposerSlice {
  composer: ComposerState;

  setDraft: (draft: string) => void;
  clearDraft: () => void;
  setSelectedModelId: (modelId: ModelId | null) => void;
  setSendMode: (mode: SendMode) => void;
  patchParams: (patch: Partial<GenerationParams>) => void;
  setSendingState: (patch: Partial<Pick<ComposerState, "isSending" | "activeRequestId">>) => void;
  resetComposerAfterSend: () => void;
}

// ============================================================================
// UiSlice — Sidebar, Panels, Dialogs
// ============================================================================

export interface UiSlice {
  ui: UiState;

  setLeftSidebarCollapsed: (collapsed: boolean) => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  openExportDialog: () => void;
  closeExportDialog: () => void;
  openBranchRenameDialog: () => void;
  closeBranchRenameDialog: () => void;
}

// ============================================================================
// Combined Store Type
// ============================================================================

/** The complete app store type combining all slices */
export type AppStore = AppSlice &
  SettingsSlice &
  ConversationSlice &
  WorkspaceSlice &
  ComposerSlice &
  UiSlice;
