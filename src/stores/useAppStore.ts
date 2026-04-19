/**
 * @file useAppStore.ts
 * @description Main application store combining all slices.
 *
 * Architecture decisions:
 * 1. Single store with slices (not multiple stores) to avoid cross-store sync issues.
 * 2. immer middleware for ergonomic immutable updates.
 * 3. devtools middleware for debugging.
 * 4. subscribeWithSelector for fine-grained React subscriptions.
 * 5. NO persist middleware — persistence goes through SQLite/Tauri services.
 * 6. activeSnapshot only holds ONE conversation's full data at a time.
 *
 * Services are imported but only called; this store does not implement
 * any business logic directly.
 */

import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import type { AppStore } from "./appStore.types";
import type { WorkspaceState } from "../types/workspace";
import type { ComposerState } from "../types/workspace";
import type { UiState } from "../types/workspace";
import type {
  BranchEntity,
  ConversationSnapshot,
  ConversationSummary,
} from "../types/conversation";
import type {
  ModelProfile,
  ProviderConfig,
  ProviderSaveInput,
} from "../types/settings";
import * as tauriCmd from "../services/tauriCommands";
import type {
  LastWorkspaceSelection,
  ProviderDto,
} from "../services/tauriTypes";

// Service imports (to be implemented)
// import * as conversationService from "../services/conversationService";
// import * as settingsService from "../services/settingsService";
// import * as workspaceService from "../services/workspaceService";

// ============================================================================
// Initial State Constants
// ============================================================================

const initialWorkspace: WorkspaceState = {
  activeConversationId: null,
  currentBranchId: null,
  workspaceMode: "NORMAL",
  forkIntent: null,
  compareState: null,
  variantPreview: null,
  pendingConvergeCount: 0,
};

const initialComposer: ComposerState = {
  draft: "",
  selectedModelId: null,
  sendMode: "APPEND",
  params: { stream: true, temperature: 0.7 },
  isSending: false,
  activeRequestId: null,
};

const initialUi: UiState = {
  leftSidebarCollapsed: false,
  rightPanelCollapsed: false,
  rightPanelTab: "BRANCHES",
  exportDialogOpen: false,
  branchRenameDialogOpen: false,
};

// ============================================================================
// Mapping Helpers
// ============================================================================

/** Convert a backend ProviderDto into the frontend ProviderConfig shape. */
function mapProviderDtoToConfig(provider: ProviderDto): ProviderConfig {
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    baseUrl: provider.baseUrl,
    modelIds: provider.models.map((model) => model.id),
    hasApiKey: provider.hasApiKey,
    defaultModelId: provider.defaultModelId ?? undefined,
    enabled: provider.enabled,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

/** Convert nested provider model DTOs into the frontend model profile map. */
function normalizeProviderModels(providerDtos: ProviderDto[]): Record<string, ModelProfile> {
  return Object.fromEntries(
    providerDtos.flatMap((provider) =>
      provider.models.map((model) => [
        model.id,
        {
          id: model.id,
          providerId: provider.id,
          requestName: model.requestName,
          displayName: model.displayName,
          createdAt: model.createdAt,
          updatedAt: model.updatedAt,
        } satisfies ModelProfile,
      ])
    )
  );
}

/** Normalize provider arrays into store-friendly map + order structures. */
function normalizeProviders(providerDtos: ProviderDto[]): {
  providers: Record<string, ProviderConfig>;
  providerModels: Record<string, ModelProfile>;
  providerOrder: string[];
} {
  const providerModels = normalizeProviderModels(providerDtos);
  const providers = Object.fromEntries(
    providerDtos.map((provider) => {
      const config = mapProviderDtoToConfig(provider);
      return [config.id, config];
    })
  );

  return {
    providers,
    providerModels,
    providerOrder: providerDtos.map((provider) => provider.id),
  };
}

/** Normalize summary arrays into store-friendly map + order structures. */
function normalizeSummaries(summaries: ConversationSummary[]): {
  summariesById: Record<string, ConversationSummary>;
  summaryOrder: string[];
} {
  return {
    summariesById: Object.fromEntries(
      summaries.map((summary) => [summary.id, summary])
    ),
    summaryOrder: summaries.map((summary) => summary.id),
  };
}

/**
 * Parse a persisted workspace payload into the strict frontend contract.
 * Invalid payloads are treated as missing to avoid boot-time crashes.
 */
function coerceLastWorkspaceSelection(
  value: unknown
): LastWorkspaceSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const conversationId =
    typeof candidate.conversationId === "string"
      ? candidate.conversationId
      : candidate.conversationId === null
        ? null
        : null;
  const branchId =
    typeof candidate.branchId === "string"
      ? candidate.branchId
      : candidate.branchId === null
        ? null
        : null;

  return {
    conversationId,
    branchId,
  };
}

/**
 * Choose the best composer model from bootstrap/settings payloads.
 * The current selection is preserved only when it is still represented by
 * the persisted default or a provider-level default.
 */
function isModelSelectable(
  modelId: string | null | undefined,
  providers: Record<string, ProviderConfig>,
  providerModels: Record<string, ModelProfile>
): modelId is string {
  if (!modelId) {
    return false;
  }

  const model = providerModels[modelId];
  if (!model) {
    return false;
  }

  return Boolean(providers[model.providerId]?.enabled);
}

/** Find the best fallback model from enabled providers. */
function findFallbackModelId(
  providers: Record<string, ProviderConfig>,
  providerOrder: string[],
  providerModels: Record<string, ModelProfile>
): string | null {
  for (const providerId of providerOrder) {
    const provider = providers[providerId];
    if (!provider?.enabled) {
      continue;
    }

    if (isModelSelectable(provider.defaultModelId, providers, providerModels)) {
      return provider.defaultModelId;
    }

    const firstAvailableModelId = provider.modelIds.find((modelId) =>
      isModelSelectable(modelId, providers, providerModels)
    );
    if (firstAvailableModelId) {
      return firstAvailableModelId;
    }
  }

  return null;
}

/** Choose the best composer model from defaults, branch preference, and availability. */
function selectInitialModelId(params: {
  defaultModelId: string | null;
  preferredBranchModelId?: string | null;
  currentSelectedModelId?: string | null;
  providers: Record<string, ProviderConfig>;
  providerOrder: string[];
  providerModels: Record<string, ModelProfile>;
}): string | null {
  const {
    defaultModelId,
    preferredBranchModelId,
    currentSelectedModelId,
    providers,
    providerOrder,
    providerModels,
  } = params;

  if (isModelSelectable(preferredBranchModelId, providers, providerModels)) {
    return preferredBranchModelId;
  }

  if (isModelSelectable(currentSelectedModelId, providers, providerModels)) {
    return currentSelectedModelId;
  }

  if (isModelSelectable(defaultModelId, providers, providerModels)) {
    return defaultModelId;
  }

  return findFallbackModelId(providers, providerOrder, providerModels);
}

/** Pick the branch that should become active when a snapshot is opened. */
function resolveCurrentBranchId(
  snapshot: ConversationSnapshot,
  preferredBranchId?: string | null
): string | null {
  if (
    preferredBranchId &&
    snapshot.entities.branches[preferredBranchId]
  ) {
    return preferredBranchId;
  }

  const mainlineBranchId = snapshot.summary.mainlineBranchId;
  if (mainlineBranchId && snapshot.entities.branches[mainlineBranchId]) {
    return mainlineBranchId;
  }

  return Object.keys(snapshot.entities.branches)[0] ?? null;
}

/** Upsert a branch DTO into the loaded snapshot and keep fork-point indexes consistent. */
function upsertBranchIntoSnapshot(
  snapshot: ConversationSnapshot,
  branch: BranchEntity
): void {
  snapshot.entities.branches[branch.id] = branch;

  if (!branch.forkPointMessageId) {
    return;
  }

  const branchIds =
    snapshot.indexes.branchIdsByForkPointId[branch.forkPointMessageId] ?? [];
  if (!branchIds.includes(branch.id)) {
    branchIds.push(branch.id);
    snapshot.indexes.branchIdsByForkPointId[branch.forkPointMessageId] =
      branchIds;
  }
}

/** Recompute branch counters on both the active snapshot summary and sidebar summary. */
function syncBranchCounts(
  snapshot: ConversationSnapshot,
  summary?: ConversationSummary
): void {
  const activeBranchCount = Object.values(snapshot.entities.branches).filter(
    (branch) => branch.status === "ACTIVE"
  ).length;
  const archivedBranchCount = Object.values(snapshot.entities.branches).filter(
    (branch) => branch.status === "ARCHIVED"
  ).length;

  snapshot.summary.activeBranchCount = activeBranchCount;
  snapshot.summary.archivedBranchCount = archivedBranchCount;

  if (summary) {
    summary.activeBranchCount = activeBranchCount;
    summary.archivedBranchCount = archivedBranchCount;
  }
}

/** Pick the next active branch after the current one becomes unavailable. */
function resolveNextActiveBranchId(
  snapshot: ConversationSnapshot,
  excludedBranchId: string
): string | null {
  const activeBranches = Object.values(snapshot.entities.branches).filter(
    (branch) =>
      branch.id !== excludedBranchId && branch.status === "ACTIVE"
  );
  const mainlineBranch = activeBranches.find((branch) => branch.isMainline);

  return mainlineBranch?.id ?? activeBranches[0]?.id ?? null;
}

/** Persist the latest workspace selection for next-launch restoration. */
async function persistWorkspaceSelection(
  workspace: LastWorkspaceSelection
): Promise<void> {
  try {
    await tauriCmd.saveLastWorkspace(workspace);
  } catch (error) {
    console.warn("[workspace] failed to persist last workspace", error);
  }
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useAppStore = create<AppStore>()(
  devtools(
    subscribeWithSelector(
      immer((set, get) => ({
        // ==================================================================
        // AppSlice — Bootstrap
        // ==================================================================
        bootStatus: "IDLE" as const,
        bootError: undefined,

        initializeApp: async () => {
          set(
            (s) => {
              s.bootStatus = "LOADING";
              s.bootError = undefined;
              s.activeSnapshot = null;
              s.activeSnapshotStatus = "IDLE";
              s.activeSnapshotError = undefined;
              s.workspace = { ...initialWorkspace };
            },
            undefined,
            "app/initializeStart"
          );

          try {
            const [bootstrapResult, summaries] = await Promise.all([
              tauriCmd.bootstrapApp(),
              tauriCmd.listConversationSummaries(),
            ]);
            const { providers, providerModels, providerOrder } = normalizeProviders(
              bootstrapResult.providers
            );
            const { summariesById, summaryOrder } = normalizeSummaries(summaries);
            const selectedModelId = selectInitialModelId({
              defaultModelId: bootstrapResult.defaultModelId,
              currentSelectedModelId: get().composer.selectedModelId,
              providers,
              providerOrder,
              providerModels,
            });

            set(
              (s) => {
                s.providers = providers;
                s.providerModels = providerModels;
                s.providerOrder = providerOrder;
                s.defaultModelId = bootstrapResult.defaultModelId;
                s.composer.selectedModelId = selectedModelId;
                s.summariesById = summariesById;
                s.summaryOrder = summaryOrder;
              },
              undefined,
              "app/bootstrapLoaded"
            );

            const lastWorkspace = coerceLastWorkspaceSelection(
              bootstrapResult.lastWorkspace
            );
            if (lastWorkspace?.conversationId) {
              if (summariesById[lastWorkspace.conversationId]) {
                try {
                  await get().openConversation(lastWorkspace.conversationId);
                  if (lastWorkspace.branchId) {
                    get().setCurrentBranch(lastWorkspace.branchId);
                  }
                } catch (error) {
                  console.warn(
                    "[workspace] failed to restore last workspace",
                    error
                  );
                }
              } else {
                await persistWorkspaceSelection({
                  conversationId: null,
                  branchId: null,
                });
              }
            }

            set(
              (s) => {
                s.bootStatus = "READY";
              },
              undefined,
              "app/initializeReady"
            );
          } catch (err: unknown) {
            const message =
              err instanceof Error ? err.message : "Failed to initialize app";
            set(
              (s) => {
                s.bootStatus = "FAILED";
                s.bootError = message;
              },
              undefined,
              "app/initializeFailed"
            );
          }
        },

        restoreLastWorkspace: async () => {
          const bootstrapResult = await tauriCmd.bootstrapApp();
          const lastWorkspace = coerceLastWorkspaceSelection(
            bootstrapResult.lastWorkspace
          );

          if (!lastWorkspace?.conversationId) {
            return;
          }

          if (!get().summariesById[lastWorkspace.conversationId]) {
            await get().loadConversationSummaries();
          }

          if (!get().summariesById[lastWorkspace.conversationId]) {
            await persistWorkspaceSelection({
              conversationId: null,
              branchId: null,
            });
            return;
          }

          await get().openConversation(lastWorkspace.conversationId);
          if (lastWorkspace.branchId) {
            get().setCurrentBranch(lastWorkspace.branchId);
          }
        },

        // ==================================================================
        // SettingsSlice
        // ==================================================================
        providers: {},
        providerModels: {},
        providerOrder: [],
        defaultModelId: null,

        loadSettings: async () => {
          const [providerDtos, defaultModelId] = await Promise.all([
            tauriCmd.listProviders(),
            tauriCmd.getDefaultModel(),
          ]);
          const { providers, providerModels, providerOrder } = normalizeProviders(
            providerDtos
          );
          const currentBranchId = get().workspace.currentBranchId;
          const activeSnapshot = get().activeSnapshot;
          const preferredBranchModelId =
            currentBranchId && activeSnapshot
              ? activeSnapshot.entities.branches[currentBranchId]?.preferredModelId ?? null
              : null;
          const selectedModelId = selectInitialModelId({
            defaultModelId,
            preferredBranchModelId,
            currentSelectedModelId: get().composer.selectedModelId,
            providers,
            providerOrder,
            providerModels,
          });

          set(
            (s) => {
              s.providers = providers;
              s.providerModels = providerModels;
              s.providerOrder = providerOrder;
              s.defaultModelId = defaultModelId;
              s.composer.selectedModelId = selectedModelId;
            },
            undefined,
            "settings/loaded"
          );
        },

        saveProvider: async (provider) => {
          const savedProvider = await tauriCmd.saveProvider(provider);
          await get().loadSettings();
          return mapProviderDtoToConfig(savedProvider);
        },

        removeProvider: async (providerId) => {
          const providerToRemove = get().providers[providerId];
          const removedModelIds = new Set(providerToRemove?.modelIds ?? []);
          const remainingProviders = Object.fromEntries(
            Object.entries(get().providers).filter(([id]) => id !== providerId)
          );
          const remainingProviderOrder = get().providerOrder.filter((id) => id !== providerId);
          const remainingProviderModels = Object.fromEntries(
            Object.entries(get().providerModels).filter(
              ([modelId]) => !removedModelIds.has(modelId)
            )
          );
          const nextDefaultModelId = removedModelIds.has(get().defaultModelId ?? "")
            ? findFallbackModelId(
                remainingProviders,
                remainingProviderOrder,
                remainingProviderModels
              )
            : get().defaultModelId;

          await tauriCmd.deleteProvider(providerId);

          if (nextDefaultModelId !== get().defaultModelId) {
            await tauriCmd.setDefaultModel(nextDefaultModelId);
          }

          await get().loadSettings();
        },

        setDefaultModel: async (modelId) => {
          await tauriCmd.setDefaultModel(modelId);
          const state = get();
          const preferredBranchModelId =
            state.workspace.currentBranchId && state.activeSnapshot
              ? state.activeSnapshot.entities.branches[state.workspace.currentBranchId]
                  ?.preferredModelId ?? null
              : null;
          set(
            (s) => {
              s.defaultModelId = modelId;
              s.composer.selectedModelId = selectInitialModelId({
                defaultModelId: modelId,
                preferredBranchModelId,
                currentSelectedModelId: s.composer.selectedModelId,
                providers: state.providers,
                providerOrder: state.providerOrder,
                providerModels: state.providerModels,
              });
            },
            undefined,
            "settings/defaultModelChanged"
          );
        },

        // ==================================================================
        // ConversationSlice
        // ==================================================================
        summariesById: {},
        summaryOrder: [],
        activeSnapshot: null,
        activeSnapshotStatus: "IDLE" as const,
        activeSnapshotError: undefined,

        loadConversationSummaries: async () => {
          const summaries = await tauriCmd.listConversationSummaries();
          const { summariesById, summaryOrder } = normalizeSummaries(summaries);
          set(
            (s) => {
              s.summariesById = summariesById;
              s.summaryOrder = summaryOrder;
              if (
                s.workspace.activeConversationId &&
                !summariesById[s.workspace.activeConversationId]
              ) {
                s.workspace = { ...initialWorkspace };
                s.activeSnapshot = null;
                s.activeSnapshotStatus = "IDLE";
                s.activeSnapshotError = undefined;
              }
            },
            undefined,
            "conversation/summariesLoaded"
          );
        },

        createConversation: async () => {
          const summary = await tauriCmd.createConversation({});
          set(
            (s) => {
              s.summariesById[summary.id] = summary;
              s.summaryOrder.unshift(summary.id);
            },
            undefined,
            "conversation/created"
          );
          return summary.id;
        },

        openConversation: async (conversationId) => {
          set(
            (s) => {
              s.activeSnapshotStatus = "LOADING";
              s.activeSnapshotError = undefined;
            },
            undefined,
            "conversation/openStart"
          );

          try {
            const snapshot = await tauriCmd.loadConversationSnapshot(conversationId);
            const openedAt = Date.now();
            const resolvedBranchId = resolveCurrentBranchId(snapshot);
            const preferredBranchModelId =
              resolvedBranchId
                ? snapshot.entities.branches[resolvedBranchId]?.preferredModelId ?? null
                : null;
            const selectedModelId = selectInitialModelId({
              defaultModelId: get().defaultModelId,
              preferredBranchModelId,
              currentSelectedModelId: get().composer.selectedModelId,
              providers: get().providers,
              providerOrder: get().providerOrder,
              providerModels: get().providerModels,
            });
            set(
              (s) => {
                const summary: ConversationSummary = {
                  ...(s.summariesById[conversationId] ?? snapshot.summary),
                  ...snapshot.summary,
                  updatedAt: openedAt,
                  lastOpenedAt: openedAt,
                };

                s.activeSnapshot = {
                  ...snapshot,
                  summary,
                };
                s.activeSnapshotStatus = "READY";
                s.activeSnapshotError = undefined;
                s.summariesById[conversationId] = summary;
                s.summaryOrder = [
                  conversationId,
                  ...s.summaryOrder.filter((id) => id !== conversationId),
                ];
                s.workspace.activeConversationId = conversationId;
                s.workspace.currentBranchId = resolvedBranchId;
                s.workspace.workspaceMode = "NORMAL";
                s.workspace.forkIntent = null;
                s.workspace.compareState = null;
                s.workspace.variantPreview = null;
                s.workspace.pendingConvergeCount = 0;
                s.composer.selectedModelId = selectedModelId;
              },
              undefined,
              "conversation/openReady"
            );
            await persistWorkspaceSelection({
              conversationId,
              branchId: resolvedBranchId,
            });
          } catch (err: unknown) {
            const message =
              err instanceof Error ? err.message : "Failed to load conversation";
            set(
              (s) => {
                s.activeSnapshotStatus = "FAILED";
                s.activeSnapshotError = message;
              },
              undefined,
              "conversation/openFailed"
            );
          }
        },

        renameConversation: async (conversationId, title) => {
          const summary = await tauriCmd.renameConversation(conversationId, title);
          set(
            (s) => {
              s.summariesById[conversationId] = summary;
              if (s.activeSnapshot?.summary.id === conversationId) {
                s.activeSnapshot.summary = summary;
              }
            },
            undefined,
            "conversation/renamed"
          );
          return summary;
        },

        archiveConversation: async (conversationId) => {
          const summary = await tauriCmd.archiveConversation(conversationId);
          const wasActive = get().workspace.activeConversationId === conversationId;

          set(
            (s) => {
              delete s.summariesById[conversationId];
              s.summaryOrder = s.summaryOrder.filter((id) => id !== conversationId);

              if (wasActive) {
                s.workspace = { ...initialWorkspace };
                s.activeSnapshot = null;
                s.activeSnapshotStatus = "IDLE";
                s.activeSnapshotError = undefined;
              }
            },
            undefined,
            "conversation/archived"
          );

          if (wasActive) {
            await persistWorkspaceSelection({
              conversationId: null,
              branchId: null,
            });
          }

          return summary;
        },

        deleteConversation: async (conversationId) => {
          const wasActive = get().workspace.activeConversationId === conversationId;
          await tauriCmd.deleteConversation(conversationId);
          set(
            (s) => {
              delete s.summariesById[conversationId];
              s.summaryOrder = s.summaryOrder.filter((id) => id !== conversationId);
              if (wasActive) {
                s.workspace = { ...initialWorkspace };
                s.activeSnapshot = null;
                s.activeSnapshotStatus = "IDLE";
                s.activeSnapshotError = undefined;
              }
            },
            undefined,
            "conversation/deleted"
          );

          if (wasActive) {
            await persistWorkspaceSelection({
              conversationId: null,
              branchId: null,
            });
          }
        },

        renameBranch: async (branchId, name) => {
          const trimmedName = name.trim();
          if (trimmedName.length === 0) {
            throw new Error("Branch name is required");
          }

          const updatedBranch = await tauriCmd.renameBranch({
            branchId,
            name: trimmedName,
          });

          set(
            (s) => {
              if (
                s.activeSnapshot &&
                s.activeSnapshot.summary.id === updatedBranch.conversationId
              ) {
                upsertBranchIntoSnapshot(s.activeSnapshot, updatedBranch);
                s.activeSnapshot.summary.updatedAt = updatedBranch.updatedAt;
              }

              const summary = s.summariesById[updatedBranch.conversationId];
              if (summary) {
                summary.updatedAt = updatedBranch.updatedAt;
              }
            },
            undefined,
            "branch/renamed"
          );

          return updatedBranch;
        },

        setBranchPreferredModel: async (branchId, modelId) => {
          const updatedBranch = await tauriCmd.setBranchPreferredModel({
            branchId,
            modelId,
          });

          set(
            (s) => {
              if (
                s.activeSnapshot &&
                s.activeSnapshot.summary.id === updatedBranch.conversationId
              ) {
                upsertBranchIntoSnapshot(s.activeSnapshot, updatedBranch);
                s.activeSnapshot.summary.updatedAt = updatedBranch.updatedAt;
              }

              const summary = s.summariesById[updatedBranch.conversationId];
              if (summary) {
                summary.updatedAt = updatedBranch.updatedAt;
              }

              if (s.workspace.currentBranchId === updatedBranch.id) {
                s.composer.selectedModelId = selectInitialModelId({
                  defaultModelId: s.defaultModelId,
                  preferredBranchModelId: updatedBranch.preferredModelId ?? null,
                  currentSelectedModelId: modelId,
                  providers: s.providers,
                  providerOrder: s.providerOrder,
                  providerModels: s.providerModels,
                });
              }
            },
            undefined,
            "branch/preferredModelChanged"
          );

          return updatedBranch;
        },

        setBranchHeadMessage: async (branchId, messageId) => {
          const updatedBranch = await tauriCmd.setBranchHeadMessage({
            branchId,
            messageId,
          });

          set(
            (s) => {
              if (
                s.activeSnapshot &&
                s.activeSnapshot.summary.id === updatedBranch.conversationId
              ) {
                upsertBranchIntoSnapshot(s.activeSnapshot, updatedBranch);
                s.activeSnapshot.summary.updatedAt = updatedBranch.updatedAt;
              }

              const summary = s.summariesById[updatedBranch.conversationId];
              if (summary) {
                summary.updatedAt = updatedBranch.updatedAt;
              }
            },
            undefined,
            "branch/headChanged"
          );

          return updatedBranch;
        },

        archiveBranch: async (branchId) => {
          const updatedBranch = await tauriCmd.archiveBranch(branchId);
          let nextBranchId: string | null = null;
          let shouldPersistWorkspace = false;

          set(
            (s) => {
              if (
                !s.activeSnapshot ||
                s.activeSnapshot.summary.id !== updatedBranch.conversationId
              ) {
                return;
              }

              upsertBranchIntoSnapshot(s.activeSnapshot, updatedBranch);
              s.activeSnapshot.summary.updatedAt = updatedBranch.updatedAt;

              const summary = s.summariesById[updatedBranch.conversationId];
              if (summary) {
                summary.updatedAt = updatedBranch.updatedAt;
              }

              syncBranchCounts(s.activeSnapshot, summary);

              if (s.workspace.currentBranchId === branchId) {
                nextBranchId = resolveNextActiveBranchId(
                  s.activeSnapshot,
                  branchId
                );
                s.workspace.currentBranchId = nextBranchId;
                shouldPersistWorkspace =
                  s.workspace.activeConversationId ===
                  updatedBranch.conversationId;
              }
            },
            undefined,
            "branch/archived"
          );

          if (shouldPersistWorkspace) {
            await persistWorkspaceSelection({
              conversationId: updatedBranch.conversationId,
              branchId: nextBranchId,
            });
          }

          return updatedBranch;
        },

        unarchiveBranch: async (branchId) => {
          const updatedBranch = await tauriCmd.unarchiveBranch(branchId);

          set(
            (s) => {
              if (
                !s.activeSnapshot ||
                s.activeSnapshot.summary.id !== updatedBranch.conversationId
              ) {
                return;
              }

              upsertBranchIntoSnapshot(s.activeSnapshot, updatedBranch);
              s.activeSnapshot.summary.updatedAt = updatedBranch.updatedAt;

              const summary = s.summariesById[updatedBranch.conversationId];
              if (summary) {
                summary.updatedAt = updatedBranch.updatedAt;
              }

              syncBranchCounts(s.activeSnapshot, summary);
            },
            undefined,
            "branch/unarchived"
          );

          return updatedBranch;
        },

        setMainlineBranch: async (conversationId, branchId) => {
          const result = await tauriCmd.setMainlineBranch({
            conversationId,
            branchId,
          });

          set(
            (s) => {
              if (
                s.activeSnapshot &&
                s.activeSnapshot.summary.id === conversationId
              ) {
                if (
                  result.oldMainlineBranchId &&
                  s.activeSnapshot.entities.branches[result.oldMainlineBranchId]
                ) {
                  s.activeSnapshot.entities.branches[
                    result.oldMainlineBranchId
                  ].isMainline = false;
                }

                upsertBranchIntoSnapshot(
                  s.activeSnapshot,
                  result.newMainlineBranch
                );
                s.activeSnapshot.summary.mainlineBranchId =
                  result.newMainlineBranch.id;
                s.activeSnapshot.summary.updatedAt =
                  result.newMainlineBranch.updatedAt;
              }

              const summary = s.summariesById[conversationId];
              if (summary) {
                summary.mainlineBranchId = result.newMainlineBranch.id;
                summary.updatedAt = result.newMainlineBranch.updatedAt;
              }
            },
            undefined,
            "branch/mainlineChanged"
          );

          return result.newMainlineBranch;
        },

        // --- Local mutations ---

        upsertMessageLocal: (message) => {
          set(
            (s) => {
              if (!s.activeSnapshot) return;
              s.activeSnapshot.entities.messages[message.id] = message;

              // Update child index
              if (message.parentId) {
                const children =
                  s.activeSnapshot.indexes.childMessageIdsByParentId[
                    message.parentId
                  ] ?? [];
                if (!children.includes(message.id)) {
                  children.push(message.id);
                  s.activeSnapshot.indexes.childMessageIdsByParentId[
                    message.parentId
                  ] = children;
                }
              } else {
                if (
                  !s.activeSnapshot.indexes.rootMessageIds.includes(message.id)
                ) {
                  s.activeSnapshot.indexes.rootMessageIds.push(message.id);
                }
              }
            },
            undefined,
            "conversation/messageUpserted"
          );
        },

        upsertBranchLocal: (branch) => {
          set(
            (s) => {
              if (!s.activeSnapshot) return;
              s.activeSnapshot.entities.branches[branch.id] = branch;

              // Update branch index by fork point
              if (branch.forkPointMessageId) {
                const ids =
                  s.activeSnapshot.indexes.branchIdsByForkPointId[
                    branch.forkPointMessageId
                  ] ?? [];
                if (!ids.includes(branch.id)) {
                  ids.push(branch.id);
                  s.activeSnapshot.indexes.branchIdsByForkPointId[
                    branch.forkPointMessageId
                  ] = ids;
                }
              }
            },
            undefined,
            "conversation/branchUpserted"
          );
        },

        patchMessageLocal: (messageId, patch) => {
          set(
            (s) => {
              if (!s.activeSnapshot?.entities.messages[messageId]) return;
              Object.assign(s.activeSnapshot.entities.messages[messageId], patch);
            },
            undefined,
            "conversation/messagePatched"
          );
        },

        deleteMessageHard: async (messageId) => {
          await tauriCmd.deleteMessage(messageId);
          set(
            (s) => {
              if (!s.activeSnapshot) return;
              const msg = s.activeSnapshot.entities.messages[messageId];
              if (!msg) return;
              const now = Date.now();
              // Remove from parent childIds
              if (msg.parentId) {
                const parent = s.activeSnapshot.entities.messages[msg.parentId];
                if (parent) {
                  parent.childIds = parent.childIds.filter((id) => id !== messageId);
                }
              }
              // Remove from childMessageIdsByParentId index
              if (msg.parentId) {
                const siblings = s.activeSnapshot.indexes.childMessageIdsByParentId[msg.parentId];
                if (siblings) {
                  const idx = siblings.indexOf(messageId);
                  if (idx >= 0) siblings.splice(idx, 1);
                }
              }
              // Remove from rootMessageIds if root
              if (!msg.parentId) {
                s.activeSnapshot.indexes.rootMessageIds = s.activeSnapshot.indexes.rootMessageIds.filter((id) => id !== messageId);
              }
              // Delete the message entity
              delete s.activeSnapshot.entities.messages[messageId];
              // Clear variant preview if it referenced the deleted message
              if (s.workspace.variantPreview?.assistantMessageId === messageId) {
                s.workspace.variantPreview = null;
              }
              s.activeSnapshot.summary.totalMessageCount = Math.max(
                0,
                s.activeSnapshot.summary.totalMessageCount - 1
              );
              s.activeSnapshot.summary.updatedAt = now;
              s.summariesById[msg.conversationId] = {
                ...(s.summariesById[msg.conversationId] ?? s.activeSnapshot.summary),
                ...s.activeSnapshot.summary,
              };
            },
            undefined,
            "conversation/messageHardDeleted"
          );
        },

        editUserMessageInline: async (messageId, newContent) => {
          const updatedMsg = await tauriCmd.editUserMessageInline(messageId, newContent);
          set(
            (s) => {
              if (!s.activeSnapshot) return;
              const snap = s.activeSnapshot;
              const collectDescendantIds = (parentId: string, acc: Set<string>) => {
                const childIds = snap.indexes.childMessageIdsByParentId[parentId] ?? [];
                for (const childId of childIds) {
                  if (acc.has(childId)) continue;
                  acc.add(childId);
                  collectDescendantIds(childId, acc);
                }
              };
              const descendantIds = new Set<string>();
              collectDescendantIds(messageId, descendantIds);
              const removedCount = descendantIds.size;
              snap.entities.messages[messageId] = updatedMsg;
              for (const descendantId of descendantIds) {
                const descendant = snap.entities.messages[descendantId];
                if (descendant?.parentId) {
                  const siblings = snap.indexes.childMessageIdsByParentId[descendant.parentId];
                  if (siblings) {
                    snap.indexes.childMessageIdsByParentId[descendant.parentId] = siblings.filter(
                      (id) => id !== descendantId
                    );
                  }
                }
                snap.indexes.rootMessageIds = snap.indexes.rootMessageIds.filter(
                  (id) => id !== descendantId
                );
                delete snap.indexes.childMessageIdsByParentId[descendantId];
                delete snap.indexes.branchIdsByForkPointId[descendantId];
                delete snap.entities.messages[descendantId];
              }
              snap.indexes.childMessageIdsByParentId[messageId] = [];
              updatedMsg.childIds = [];
              snap.summary.totalMessageCount = Math.max(
                0,
                snap.summary.totalMessageCount - removedCount
              );
              snap.summary.updatedAt = updatedMsg.updatedAt;
              s.summariesById[updatedMsg.conversationId] = {
                ...(s.summariesById[updatedMsg.conversationId] ?? snap.summary),
                ...snap.summary,
              };
              s.workspace.variantPreview = null;
            },
            undefined,
            "conversation/userMessageEditedInline"
          );
        },
        patchBranchLocal: (branchId, patch) => {
          set(
            (s) => {
              if (!s.activeSnapshot?.entities.branches[branchId]) return;
              Object.assign(s.activeSnapshot.entities.branches[branchId], patch);
            },
            undefined,
            "conversation/branchPatched"
          );
        },

        replaceActiveSnapshot: (snapshot) => {
          set(
            (s) => {
              s.activeSnapshot = snapshot;
              s.activeSnapshotStatus = "READY";
              s.activeSnapshotError = undefined;
            },
            undefined,
            "conversation/snapshotReplaced"
          );
        },

        // ==================================================================
        // WorkspaceSlice
        // ==================================================================
        workspace: initialWorkspace,

        setActiveConversation: (conversationId) => {
          set(
            (s) => {
              s.workspace.activeConversationId = conversationId;
              if (conversationId === null) {
                s.workspace.currentBranchId = null;
              }
            },
            undefined,
            "workspace/activeConversationChanged"
          );

          if (conversationId === null) {
            void persistWorkspaceSelection({
              conversationId: null,
              branchId: null,
            });
          }
        },

        setCurrentBranch: (branchId) => {
          set(
            (s) => {
              if (
                branchId !== null &&
                !s.activeSnapshot?.entities.branches[branchId]
              ) {
                return;
              }
              s.workspace.currentBranchId = branchId;
              const preferredBranchModelId =
                branchId && s.activeSnapshot
                  ? s.activeSnapshot.entities.branches[branchId]?.preferredModelId ?? null
                  : null;
              s.composer.selectedModelId = selectInitialModelId({
                defaultModelId: s.defaultModelId,
                preferredBranchModelId,
                currentSelectedModelId: s.composer.selectedModelId,
                providers: s.providers,
                providerOrder: s.providerOrder,
                providerModels: s.providerModels,
              });
            },
            undefined,
            "workspace/currentBranchChanged"
          );

          const { activeConversationId, currentBranchId } = get().workspace;
          if (activeConversationId) {
            void persistWorkspaceSelection({
              conversationId: activeConversationId,
              branchId: currentBranchId,
            });
          }
        },

        setWorkspaceMode: (mode) => {
          set(
            (s) => {
              s.workspace.workspaceMode = mode;
            },
            undefined,
            "workspace/modeChanged"
          );
        },

        startHistoryFork: (intent) => {
          set(
            (s) => {
              s.workspace.forkIntent = intent;
              s.workspace.workspaceMode = "HISTORY_FORK";
            },
            undefined,
            "workspace/historyForkStarted"
          );
        },

        startEditFork: (intent) => {
          set(
            (s) => {
              s.workspace.forkIntent = intent;
              s.workspace.workspaceMode = "EDIT_FORK";
            },
            undefined,
            "workspace/editForkStarted"
          );

        },
        startEditInline: (messageId) => {
          set(
            (s) => {
              s.workspace.forkIntent = {
                sourceType: "HISTORY_USER_EDIT",
                sourceBranchId: s.workspace.currentBranchId!,
                sourceMessageId: null,
                originalEditableMessageId: messageId,
              };
              s.workspace.workspaceMode = "EDIT_INLINE";
            },
            undefined,
            "workspace/editInlineStarted"
          );
        },

        clearForkIntent: () => {
          set(
            (s) => {
              s.workspace.forkIntent = null;
              s.workspace.workspaceMode = "NORMAL";
            },
            undefined,
            "workspace/forkIntentCleared"
          );
        },

        /**
         * Enter COMPARE mode.
         * IMPORTANT: Composer MUST be disabled when in COMPARE mode.
         * This is enforced at the UI layer by checking workspaceMode.
         */
        enterCompare: (compareState) => {
          set(
            (s) => {
              s.workspace.compareState = compareState;
              s.workspace.workspaceMode = "COMPARE";
            },
            undefined,
            "workspace/compareEntered"
          );
        },

        exitCompare: () => {
          set(
            (s) => {
              s.workspace.compareState = null;
              s.workspace.workspaceMode = "NORMAL";
            },
            undefined,
            "workspace/compareExited"
          );
        },

        setVariantPreview: (ctx) => {
          set(
            (s) => {
              s.workspace.variantPreview = ctx;
            },
            undefined,
            "workspace/variantPreviewChanged"
          );
        },

        setPendingConvergeCount: (count) => {
          set(
            (s) => {
              s.workspace.pendingConvergeCount = count;
            },
            undefined,
            "workspace/pendingConvergeUpdated"
          );
        },

        // ==================================================================
        // ComposerSlice
        // ==================================================================
        composer: initialComposer,

        setDraft: (draft) => {
          set(
            (s) => {
              s.composer.draft = draft;
            },
            undefined,
            "composer/draftChanged"
          );
        },

        clearDraft: () => {
          set(
            (s) => {
              s.composer.draft = "";
            },
            undefined,
            "composer/draftCleared"
          );
        },

        setSelectedModelId: (modelId) => {
          set(
            (s) => {
              s.composer.selectedModelId = modelId;
            },
            undefined,
            "composer/modelChanged"
          );
        },

        setSendMode: (mode) => {
          set(
            (s) => {
              s.composer.sendMode = mode;
            },
            undefined,
            "composer/sendModeChanged"
          );
        },

        patchParams: (patch) => {
          set(
            (s) => {
              Object.assign(s.composer.params, patch);
            },
            undefined,
            "composer/paramsPatched"
          );
        },

        setSendingState: (patch) => {
          set(
            (s) => {
              if (patch.isSending !== undefined) s.composer.isSending = patch.isSending;
              if (patch.activeRequestId !== undefined)
                s.composer.activeRequestId = patch.activeRequestId;
            },
            undefined,
            "composer/sendingStateChanged"
          );
        },

        resetComposerAfterSend: () => {
          set(
            (s) => {
              s.composer.draft = "";
              s.composer.sendMode = "APPEND";
              s.composer.isSending = false;
              s.composer.activeRequestId = null;
            },
            undefined,
            "composer/resetAfterSend"
          );
        },

        // ==================================================================
        // UiSlice
        // ==================================================================
        ui: initialUi,

        setLeftSidebarCollapsed: (collapsed) => {
          set(
            (s) => {
              s.ui.leftSidebarCollapsed = collapsed;
            },
            undefined,
            "ui/leftSidebarCollapsed"
          );
        },

        setRightPanelCollapsed: (collapsed) => {
          set(
            (s) => {
              s.ui.rightPanelCollapsed = collapsed;
            },
            undefined,
            "ui/rightPanelCollapsed"
          );
        },

        setRightPanelTab: (tab) => {
          set(
            (s) => {
              s.ui.rightPanelTab = tab;
            },
            undefined,
            "ui/rightPanelTabChanged"
          );
        },

        openExportDialog: () => {
          set(
            (s) => {
              s.ui.exportDialogOpen = true;
            },
            undefined,
            "ui/exportDialogOpened"
          );
        },

        closeExportDialog: () => {
          set(
            (s) => {
              s.ui.exportDialogOpen = false;
            },
            undefined,
            "ui/exportDialogClosed"
          );
        },

        openBranchRenameDialog: () => {
          set(
            (s) => {
              s.ui.branchRenameDialogOpen = true;
            },
            undefined,
            "ui/branchRenameDialogOpened"
          );
        },

        closeBranchRenameDialog: () => {
          set(
            (s) => {
              s.ui.branchRenameDialogOpen = false;
            },
            undefined,
            "ui/branchRenameDialogClosed"
          );
        },
      }))
    )
  )
);
