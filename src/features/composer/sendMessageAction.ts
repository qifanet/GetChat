/**
 * @file sendMessageAction.ts
 * @description Unified send action that executes a SendPlan.
 *
 * This is the single entry point for ALL message sending:
 *   - Normal append
 *   - New branch from leaf
 *   - History fork (continue from historical assistant message)
 *   - Edit fork (edit historical user message and branch)
 *   - Variant continue (continue from a candidate answer)
 *
 * CRITICAL: Persistent entities are created via Tauri commands first, then the
 * confirmed branch/message DTOs are applied to Zustand in a SINGLE immer set()
 * call. This prevents intermediate inconsistent renders where the workspace
 * moves to a branch or message that the backend has not actually accepted.
 *
 * Default behavior is non-destructive: edits create a new branch and preserve
 * original messages. DIRECT_OVERWRITE is the explicit exception and is handled
 * before the normal SendPlan path.
 */
import { useAppStore, sortSummaryOrder } from "../../stores/useAppStore";
import { buildSendPlan } from "./buildSendPlan";
import {
  findActiveAssistantStream,
  startAssistantStream,
} from "../../services/streamController";
import * as tauriCmd from "../../services/tauriCommands";
import type { AppStore } from "../../stores/appStore.types";
import type { BranchEntity, MessageNode } from "../../types/conversation";
import type { PromptMessage } from "../../services/tauriTypes";
// ============================================================================
// Helpers
// ============================================================================
const PASSIVE_COMPRESSION_THRESHOLD_PERCENT = 75;
const SEND_CONTEXT_BUDGET_RATIO = 0.9;
const MIN_PROMPT_BUDGET_TOKENS = 1000;

type EnabledTools = Awaited<ReturnType<typeof tauriCmd.getEnabledToolDefinitions>>;

interface PreparedPromptForSend {
  promptMessages: PromptMessage[];
  tools: EnabledTools;
}

interface SendSubmitLock {
  startedAt: number;
}

const SEND_SUBMIT_LOCK_STALE_MS = 120_000;
let activeSendSubmitLock: SendSubmitLock | null = null;

function isSendSubmitLocked(): boolean {
  if (!activeSendSubmitLock) {
    return false;
  }
  if (Date.now() - activeSendSubmitLock.startedAt > SEND_SUBMIT_LOCK_STALE_MS) {
    activeSendSubmitLock = null;
    return false;
  }
  return true;
}

function tryAcquireSendSubmitLock(): boolean {
  if (isSendSubmitLocked()) {
    return false;
  }
  activeSendSubmitLock = { startedAt: Date.now() };
  return true;
}

function releaseSendSubmitLock(): void {
  activeSendSubmitLock = null;
}

function syncComposerToActiveStream(): boolean {
  const activeStream = findActiveAssistantStream();
  if (!activeStream) {
    return false;
  }

  useAppStore.getState().setSendingState({
    isSending: true,
    activeRequestId: activeStream.requestId,
  });
  return true;
}

/** Resolve the provider that should serve the currently selected model. */
export function resolveProviderIdForModel(state: AppStore, modelId: string): string {
  const selectedModel = state.providerModels[modelId];
  if (
    selectedModel &&
    state.providers[selectedModel.providerId]?.enabled
  ) {
    return selectedModel.providerId;
  }
  const fallbackProviderId = state.providerOrder.find((providerId) => {
    const provider = state.providers[providerId];
    if (!provider?.enabled) {
      return false;
    }
    return provider.modelIds.some(
      (providerModelId) => state.providerModels[providerModelId]
    );
  });
  if (!fallbackProviderId) {
    throw new Error("No enabled provider available for the selected model");
  }
  return fallbackProviderId;
}

function getModelContextTokens(state: AppStore, modelId: string): number {
  const configuredKb = state.providerModels[modelId]?.contextWindowKb;
  if (typeof configuredKb === "number" && Number.isFinite(configuredKb) && configuredKb > 0) {
    return Math.round(configuredKb * 1000);
  }
  return 64_000;
}

function readNumberParam(params: unknown, keys: string[]): number | null {
  if (!params || typeof params !== "object") return null;
  const source = params as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function getOutputTokenReserve(state: AppStore, totalTokens: number): number {
  const configuredMax = readNumberParam(state.composer.params, ["maxTokens", "max_tokens"]);
  const defaultReserve = Math.max(512, Math.floor(totalTokens * 0.1));
  const reserve = Math.max(configuredMax ?? defaultReserve, defaultReserve);
  return Math.min(reserve, Math.floor(totalTokens * 0.4));
}

function getPromptTokenBudget(
  state: AppStore,
  modelId: string,
  status: tauriCmd.ContextStatusDto | null
): number {
  const totalTokens = Math.max(status?.totalTokens ?? getModelContextTokens(state, modelId), 1000);
  const toolPromptTokens = Math.max(status?.breakdown?.toolPromptTokens ?? 0, 0);
  const outputReserve = getOutputTokenReserve(state, totalTokens);
  const sendBudget = Math.floor(totalTokens * SEND_CONTEXT_BUDGET_RATIO);
  return Math.max(MIN_PROMPT_BUDGET_TOKENS, sendBudget - toolPromptTokens - outputReserve);
}

function shouldAttemptPassiveCompression(
  status: tauriCmd.ContextStatusDto | null,
  promptTokenBudget: number
): boolean {
  if (!status) {
    return false;
  }
  const rawMessageCount = status.rawMessageCount ?? status.messageCount;
  if (rawMessageCount < 6) {
    return false;
  }
  const rawUsedTokens = status.rawUsedTokens ?? status.usedTokens;
  const rawPercentage = status.rawPercentage ?? status.percentage;
  return (
    rawPercentage >= PASSIVE_COMPRESSION_THRESHOLD_PERCENT ||
    rawUsedTokens > promptTokenBudget
  );
}

async function preparePromptForSend(params: {
  state: AppStore;
  conversationId: string;
  branchId: string;
  upToMessageId: string;
  modelId: string;
}): Promise<PreparedPromptForSend> {
  const { state, conversationId, branchId, upToMessageId, modelId } = params;
  const [tools, initialStatus] = await Promise.all([
    tauriCmd.getEnabledToolDefinitions(),
    tauriCmd.getContextStatus(conversationId, branchId, modelId).catch((error) => {
      console.warn("[context] failed to read context status before send", error);
      return null;
    }),
  ]);

  // Compression is now triggered asynchronously AFTER stream completion
  // (opencode-style: model-response-then-compact). The deterministic budget
  // trimming in buildPromptMessages is the safety net for the current turn.
  const status = initialStatus;
  const promptTokenBudget = getPromptTokenBudget(state, modelId, status);

  const promptMessages = await tauriCmd.buildPromptMessages({
    conversationId,
    upToMessageId,
    branchId,
    maxTokensBudget: promptTokenBudget,
  });

  return { promptMessages, tools };
}

/**
 * Execute the unified send action.
 *
 * All mutations are applied in a single immer set() to guarantee atomicity.
 * The state transition is:
 *
 *   1. Build SendPlan (pure computation, no state change)
 *   2. Persist branch/message entities via Tauri commands
 *   3. Single set() that atomically syncs the confirmed DTOs into Zustand
 *   4. Start assistant streaming (async, separate from state mutation)
 *
 * @throws SendPlanError if state is invalid or in compare mode
 * @throws Error if required fields (draft, model) are missing
 */
export async function sendMessageAction(options?: {
  activatedSkill?: string;
}): Promise<void> {
  const state = useAppStore.getState();
  if (state.composer.isSending || isSendSubmitLocked()) {
    console.warn("[composer] duplicate send ignored: a send is already in progress");
    return;
  }
  if (syncComposerToActiveStream()) {
    console.warn("[composer] duplicate send ignored: a stream is already active");
    return;
  }

  // --- Validation ---
  const draft = state.composer.draft.trim();
  if (!draft) {
    throw new Error("Cannot send empty message");
  }
  const modelId = state.composer.selectedModelId;
  if (!modelId) {
    throw new Error("No model selected");
  }

  if (!tryAcquireSendSubmitLock()) {
    console.warn("[composer] duplicate send ignored: submit lock is active");
    return;
  }

  let assistantStreamStarted = false;
  useAppStore.getState().setSendingState({
    isSending: true,
    activeRequestId: null,
  });

  try {

  const directOverwriteIntent =
    state.workspace.forkIntent?.sourceType === "HISTORY_USER_EDIT" &&
    state.workspace.forkIntent.editMode === "DIRECT_OVERWRITE"
      ? state.workspace.forkIntent
      : null;

  if (directOverwriteIntent) {
    const conversationId = state.workspace.activeConversationId;
    const targetBranchId = directOverwriteIntent.sourceBranchId;
    const messageId = directOverwriteIntent.originalEditableMessageId;

    if (!conversationId) {
      throw new Error("No active conversation");
    }
    if (!targetBranchId) {
      throw new Error("No current branch selected");
    }
    if (!messageId) {
      throw new Error("No editable message selected");
    }

    const providerId = resolveProviderIdForModel(state, modelId);
    const userMessage = await tauriCmd.directOverwriteUserMessage({
      conversationId,
      branchId: targetBranchId,
      messageId,
      contentText: draft,
    });
    const [{ promptMessages, tools }, snapshot] = await Promise.all([
      preparePromptForSend({
        state,
        conversationId,
        branchId: targetBranchId,
        upToMessageId: userMessage.id,
        modelId,
      }),
      tauriCmd.loadConversationSnapshot(conversationId),
    ]);

    useAppStore.setState(
      (s) => {
        s.activeSnapshot = snapshot;
        s.activeSnapshotStatus = "READY";
        s.activeSnapshotError = undefined;
        s.summariesById[conversationId] = {
          ...(s.summariesById[conversationId] ?? snapshot.summary),
          ...snapshot.summary,
        };
        sortSummaryOrder(s);
        s.workspace.activeConversationId = conversationId;
        s.workspace.currentBranchId = targetBranchId;
        s.composer.draft = "";
        s.workspace.workspaceMode = "NORMAL";
        s.workspace.forkIntent = null;
        s.workspace.variantPreview = null;
      },
      undefined,
      "conversation/directOverwriteMessageSent"
    );

    await startAssistantStream({
      conversationId,
      branchId: targetBranchId,
      parentMessageId: userMessage.id,
      providerId,
      modelId,
      promptMessages,
      generationParams: {
        ...state.composer.params,
      },
      rendererMode: "DOM_TEXT",
      tools: tools.length > 0 ? tools : undefined,
      toolChoice: tools.length > 0 ? "auto" : undefined,
      activatedSkill: options?.activatedSkill,
    });
    assistantStreamStarted = true;
    return;
  }

  // --- Build plan (pure computation) ---
  const plan = buildSendPlan(state);
  // --- Determine provider ---
  const providerId = resolveProviderIdForModel(state, modelId);
  // --- Persist branch/message entities via Tauri BEFORE local store sync ---
  let newBranch: BranchEntity | null = null;
  let targetBranchId = plan.targetBranchId;
  if (plan.createBranch) {
    const autoName = draft.length > 10 ? draft.slice(0, 10) + '...' : draft;
    newBranch = await tauriCmd.createBranch({
      conversationId: plan.conversationId,
      sourceBranchId: plan.sourceBranchId,
      forkPointMessageId: plan.createBranch.forkPointMessageId ?? undefined,
      forkSourceType: plan.createBranch.sourceType,
      forkSourceMessageId: plan.createBranch.forkSourceMessageId ?? undefined,
      preferredModelId: modelId,
      name: autoName,
    });
    targetBranchId = newBranch.id;
  }
  const userMessage: MessageNode = await tauriCmd.createUserMessage({
    conversationId: plan.conversationId,
    branchId: targetBranchId,
    contentText: draft,
    parentMessageId: plan.targetParentMessageId ?? undefined,
    editedFromMessageId: plan.editedFromMessageId ?? undefined,
  });
  const { promptMessages, tools } = await preparePromptForSend({
    state,
    conversationId: plan.conversationId,
    branchId: targetBranchId,
    upToMessageId: userMessage.id,
    modelId,
  });
  // --- SINGLE ATOMIC SET: all mutations in one immer transaction ---
  useAppStore.setState(
    (s) => {
      if (!s.activeSnapshot) return;
      // 1. Upsert new branch + update indexes + update currentBranchId
      if (newBranch) {
        s.activeSnapshot.entities.branches[newBranch.id] = newBranch;
        // Update branch index by fork point
        if (newBranch.forkPointMessageId) {
          const ids =
            s.activeSnapshot.indexes.branchIdsByForkPointId[
              newBranch.forkPointMessageId
            ] ?? [];
          if (!ids.includes(newBranch.id)) {
            ids.push(newBranch.id);
            s.activeSnapshot.indexes.branchIdsByForkPointId[
              newBranch.forkPointMessageId
            ] = ids;
          }
        }
      }
      // 2. Upsert user message + update indexes
      s.activeSnapshot.entities.messages[userMessage.id] = userMessage;
      if (userMessage.parentId) {
        const children =
          s.activeSnapshot.indexes.childMessageIdsByParentId[
            userMessage.parentId
          ] ?? [];
        if (!children.includes(userMessage.id)) {
          children.push(userMessage.id);
          s.activeSnapshot.indexes.childMessageIdsByParentId[
            userMessage.parentId
          ] = children;
        }
      } else {
        if (!s.activeSnapshot.indexes.rootMessageIds.includes(userMessage.id)) {
          s.activeSnapshot.indexes.rootMessageIds.push(userMessage.id);
        }
      }
      // 3. Update branch headMessageId (for existing branches too, not just new ones)
      const targetBranch = s.activeSnapshot.entities.branches[targetBranchId];
      if (targetBranch) {
        targetBranch.headMessageId = userMessage.id;
        targetBranch.updatedAt = userMessage.updatedAt;
      }
      if (newBranch) {
        s.activeSnapshot.summary.activeBranchCount += 1;
      }
      s.activeSnapshot.summary.totalMessageCount += 1;
      s.activeSnapshot.summary.updatedAt = userMessage.updatedAt;
      s.summariesById[plan.conversationId] = {
        ...(s.summariesById[plan.conversationId] ?? s.activeSnapshot.summary),
        ...s.activeSnapshot.summary,
      };
      sortSummaryOrder(s);
      s.workspace.currentBranchId = targetBranchId;
      // 4. Clear all transient state after confirmed persistence
      s.composer.draft = "";
      s.workspace.workspaceMode = "NORMAL";
      s.workspace.forkIntent = null;
      s.workspace.variantPreview = null;
    },
    undefined,
    "conversation/messageSent"
  );
  // --- Step 5: Start assistant streaming (async, outside the atomic set) ---
  await startAssistantStream({
    conversationId: plan.conversationId,
    branchId: targetBranchId,
    parentMessageId: userMessage.id,
    providerId,
    modelId,
    promptMessages,
    generationParams: {
      ...state.composer.params,
    },
    rendererMode: "DOM_TEXT",
    tools: tools.length > 0 ? tools : undefined,
    toolChoice: tools.length > 0 ? "auto" : undefined,
    activatedSkill: options?.activatedSkill,
  });
  assistantStreamStarted = true;
  } catch (error) {
    if (!assistantStreamStarted) {
      useAppStore.getState().setSendingState({
        isSending: false,
        activeRequestId: null,
      });
    }
    throw error;
  } finally {
    releaseSendSubmitLock();
  }
}
