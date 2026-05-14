/**
 * @file settings.ts
 * @description Type definitions for model provider configurations,
 * model profiles, and generation parameters.
 */

import type { ModelId, ProviderId, UnixMs } from "./base";

// ============================================================================
// Provider Configuration
// ============================================================================

/** Supported provider types */
export type ProviderType = "OPENAI_COMPATIBLE" | "OLLAMA";

/** Model provider configuration */
export interface ProviderConfig {
  id: ProviderId;
  type: ProviderType;
  name: string;
  baseUrl: string;
  modelIds: ModelId[];

  /**
   * Whether the provider has an API key stored in OS secure storage.
   * Derived from backend — the frontend NEVER receives the key or its reference.
   */
  hasApiKey: boolean;

  defaultModelId?: ModelId;
  enabled: boolean;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

/**
 * Payload used when creating or updating a provider configuration.
 * The raw API key is accepted here because the backend command layer is
 * responsible for persisting it into OS secure storage.
 */
export interface ProviderSaveInput {
  id?: ProviderId;
  type: ProviderType;
  name: string;
  baseUrl: string;
  apiKey?: string;
  defaultModelId?: ModelId;
  models: ProviderModelSaveInput[];
  enabled?: boolean;
}

// ============================================================================
// Model Profile
// ============================================================================

/** Payload used when saving one provider model profile. */
export interface ProviderModelSaveInput {
  id?: ModelId;
  requestName: string;
  displayName: string;
}

/** Model profile associated with a provider */
export interface ModelProfile {
  id: ModelId;
  providerId: ProviderId;
  requestName: string; // e.g., "gpt-4.1-mini"
  displayName: string; // e.g., "GPT-4.1 Mini"
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

// ============================================================================
// Generation Parameters
// ============================================================================

/** Parameters for model generation requests */
export interface GenerationParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream: boolean;
}

// ============================================================================
// Application Settings (Aggregated)
// ============================================================================

/** Application-level settings persisted to local storage */
export interface AppSettings {
  providers: Record<ProviderId, ProviderConfig>;
  providerModels: Record<ModelId, ModelProfile>;
  providerOrder: ProviderId[];
  defaultModelId: ModelId | null;
  helperModelId: ModelId | null;
  lastOpenedConversationId: string | null;
  lastOpenedBranchId: string | null;
}
