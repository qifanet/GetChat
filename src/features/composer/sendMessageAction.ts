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
 * Non-destructive guarantee:
 *   - Original messages are NEVER modified
 *   - Branch creation always creates a NEW entity
 *   - editedFromMessageId links to the original without changing it
 */

import { useAppStore } from "../../stores/useAppStore";
import { buildSendPlan, SendPlanError } from "./buildSendPlan";
import { startAssistantStream } from "../../services/streamController";
import * as tauriCmd from "../../services/tauriCommands";
import type { AppStore } from "../../stores/appStore.types";
import type { BranchEntity, MessageNode } from "../../types/conversation";

// ============================================================================
// Helpers
// ============================================================================

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
export async function sendMessageAction(): Promise<void> {
  const state = useAppStore.getState();

  // --- Validation ---
  const draft = state.composer.draft.trim();
  if (!draft) {
    throw new Error("Cannot send empty message");
  }

  const modelId = state.composer.selectedModelId;
  if (!modelId) {
    throw new Error("No model selected");
  }

  // --- Build plan (pure computation) ---
  const plan = buildSendPlan(state);

  // --- Determine provider ---
  const providerId = resolveProviderIdForModel(state, modelId);

  // --- Persist branch/message entities via Tauri BEFORE local store sync ---
  let newBranch: BranchEntity | null = null;
  let targetBranchId = plan.targetBranchId;

  if (plan.createBranch) {
    newBranch = await tauriCmd.createBranch({
      conversationId: plan.conversationId,
      sourceBranchId: plan.sourceBranchId,
      forkPointMessageId: plan.createBranch.forkPointMessageId ?? undefined,
      forkSourceType: plan.createBranch.sourceType,
      forkSourceMessageId: plan.createBranch.forkSourceMessageId ?? undefined,
      preferredModelId: modelId,
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

  const promptMessages = await tauriCmd.buildPromptMessages({
    conversationId: plan.conversationId,
    upToMessageId: userMessage.id,
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
  });
}
