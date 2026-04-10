/**
 * @file modelUtils.ts
 * @description Shared helpers for presenting and selecting provider model
 * profiles across the desktop UI.
 */

import type { ModelProfile, ProviderConfig } from "../../types/settings";

/** Lightweight view model used by branch and composer model selectors. */
export interface AvailableModelOption {
  id: string;
  providerId: string;
  providerName: string;
  displayName: string;
  requestName: string;
}

/** Generate a stable system-owned model profile ID on the frontend. */
export function createModelProfileId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `model_${globalThis.crypto.randomUUID()}`;
  }

  return `model_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Resolve a human-readable model name from a stable model profile ID. */
export function getModelDisplayName(
  modelId: string | null | undefined,
  providerModels: Record<string, ModelProfile>,
  fallbackLabel: string
): string {
  if (!modelId) {
    return fallbackLabel;
  }

  const displayName = providerModels[modelId]?.displayName?.trim();
  return displayName && displayName.length > 0 ? displayName : fallbackLabel;
}

/** Flatten enabled provider models into selector-friendly options. */
export function listAvailableModelOptions(
  providers: Record<string, ProviderConfig>,
  providerOrder: string[],
  providerModels: Record<string, ModelProfile>
): AvailableModelOption[] {
  return providerOrder.flatMap((providerId) => {
    const provider = providers[providerId];
    if (!provider?.enabled) {
      return [];
    }

    return provider.modelIds
      .map((modelId) => providerModels[modelId])
      .filter((model): model is ModelProfile => Boolean(model))
      .map((model) => ({
        id: model.id,
        providerId,
        providerName: provider.name,
        displayName: model.displayName,
        requestName: model.requestName,
      }));
  });
}
