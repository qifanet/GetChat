/**
 * @file index.ts
 * @description Unified re-export entry point for all type definitions.
 * Import from "types" to access any type.
 */

// Base types & enums
export type {
  UnixMs,
  ConversationId,
  BranchId,
  MessageId,
  ProviderId,
  ModelId,
  RequestId,
  ToastId,
  MessageRole,
  MessageStatus,
  BranchStatus,
  WorkspaceMode,
  SendMode,
  ForkSourceType,
  RightPanelTab,
  StreamRendererMode,
  BranchFilterMode,
  ExportScope,
  ExportFormat,
} from "./base";

// Settings types
export type {
  ProviderType,
  ProviderConfig,
  ModelProfile,
  GenerationParams,
  AppSettings,
} from "./settings";

// Conversation types (core domain model)
export type {
  TokenUsage,
  MessageError,
  MessageContent,
  MessageGenerationMeta,
  MessageNode,
  BranchEntity,
  ConversationSummary,
  ConversationIndexes,
  ConversationEntities,
  ConversationSnapshot,
} from "./conversation";

// Variant types (runtime-derived)
export type { DerivedVariantGroup } from "./variant";

// Workspace types
export type {
  ForkIntent,
  CompareState,
  VariantPreviewContext,
  WorkspaceState,
  ComposerState,
  UiState,
} from "./workspace";

// Stream types
export type {
  StreamError,
  StreamSessionMeta,
  ImperativeTextSurface,
  StreamRuntimeSession,
} from "./stream";

// Internal types (send pipeline)
export type { SendPlan, StartStreamParams } from "./internal";
