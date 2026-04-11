/**
 * @file tauriTypes.ts
 * @description Type definitions for the Tauri invoke layer.
 *
 * These types align the Rust DTO definitions with the frontend TypeScript
 * domain types. They serve as the contract between frontend and backend.
 *
 * Design decisions:
 *   - Input types use camelCase (matching serde rename_all = "camelCase")
 *   - Output types reuse existing domain types where possible
 *   - ProviderDto uses hasApiKey instead of apiKeyRef (security)
 *   - Error type wraps the serialized Rust AppError
 */

import type {
  BranchId,
  ConversationId,
  MessageId,
  ModelId,
  ProviderId,
  RequestId,
} from "../types/base";
import type { ModelProfile, ProviderModelSaveInput, ProviderType } from "../types/settings";
import type {
  BranchEntity,
  ConversationSummary,
  ConversationSnapshot,
  MessageNode,
} from "../types/conversation";

// ============================================================================
// Error Types
// ============================================================================

/** Error codes matching Rust AppErrorCode (SCREAMING_SNAKE_CASE) */
export type TauriErrorCode =
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "INVARIANT_VIOLATION"
  | "DB_ERROR"
  | "SECURE_STORAGE_ERROR";

/**
 * Typed error from Tauri backend.
 * Constructed by the invoke wrapper when a command fails.
 */
export class TauriAppError extends Error {
  readonly code: TauriErrorCode;
  readonly details?: string;

  constructor(code: TauriErrorCode, message: string, details?: string) {
    super(`[${code}] ${message}`);
    this.name = "TauriAppError";
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Bootstrap Types
// ============================================================================

/** Result of bootstrap_app command — all data needed on app launch */
export interface LastWorkspaceSelection {
  conversationId: ConversationId | null;
  branchId: BranchId | null;
}

/** Result of bootstrap_app command — all data needed on app launch */
export interface BootstrapResult {
  lastWorkspace: LastWorkspaceSelection | null;
  providers: ProviderDto[];
  defaultModelId: string | null;
}

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Provider DTO returned from the backend.
 * Differs from frontend ProviderConfig: hasApiKey replaces apiKeyRef.
 * The frontend NEVER receives apiKeyRef or plaintext keys.
 */
export interface ProviderDto {
  id: ProviderId;
  type: ProviderType;
  name: string;
  baseUrl: string;
  defaultModelId: string | null;
  models: ProviderModelDto[];
  hasApiKey: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Provider model DTO returned from the backend. */
export interface ProviderModelDto extends ModelProfile {}

/** Input for save_provider command */
export interface SaveProviderInput {
  id?: string;
  type: ProviderType;
  name: string;
  baseUrl: string;
  /** Raw API key — stored in OS secure storage, never in DB */
  apiKey?: string;
  defaultModelId?: string | null;
  models: ProviderModelSaveInput[];
  enabled?: boolean;
}

// ============================================================================
// Conversation Input Types
// ============================================================================

export interface CreateConversationInput {
  title?: string;
  initialUserMessage?: string;
}

export interface LoadConversationSnapshotInput {
  conversationId: ConversationId;
}

// ============================================================================
// Branch Input Types
// ============================================================================

export interface CreateBranchInput {
  conversationId: ConversationId;
  sourceBranchId?: BranchId;
  forkPointMessageId?: MessageId;
  forkSourceType:
    | "ROOT"
    | "CURRENT_LEAF"
    | "HISTORY_ASSISTANT"
    | "HISTORY_USER_EDIT"
    | "VARIANT";
  forkSourceMessageId?: MessageId;
  name?: string;
  preferredModelId?: ModelId | null;
}

export interface RenameBranchInput {
  branchId: BranchId;
  name: string;
}

export interface SetMainlineBranchInput {
  conversationId: ConversationId;
  branchId: BranchId;
}

/**
 * Result of set_mainline_branch command.
 * Contains IDs needed to update isMainline across all branches
 * without re-fetching the entire snapshot.
 */
export interface SetMainlineResult {
  /** The branch that was previously mainline (null if none existed) */
  oldMainlineBranchId: BranchId | null;
  /** The newly set mainline branch with all current data */
  newMainlineBranch: BranchEntity;
}

export interface SetBranchPreferredModelInput {
  branchId: BranchId;
  modelId: ModelId | null;
}

export interface SetBranchHeadMessageInput {
  branchId: BranchId;
  messageId: MessageId;
}

// ============================================================================
// Message Input Types
// ============================================================================

export interface CreateUserMessageInput {
  conversationId: ConversationId;
  branchId: BranchId;
  contentText: string;
  parentMessageId?: MessageId;
  editedFromMessageId?: MessageId;
}

export interface CreateAssistantPlaceholderForBranchInput {
  conversationId: ConversationId;
  branchId: BranchId;
  providerId: ProviderId;
  modelId: string;
  requestId: string;
  generationParams?: Record<string, unknown>;
}

export interface CreateAssistantVariantPlaceholderInput {
  conversationId: ConversationId;
  parentMessageId: MessageId;
  providerId: ProviderId;
  modelId: string;
  requestId: string;
  generationParams?: Record<string, unknown>;
}

export interface CompleteAssistantMessageInput {
  messageId: MessageId;
  contentText: string;
  usage?: Record<string, unknown>;
}

export interface FailAssistantMessageInput {
  messageId: MessageId;
  errorCode: string;
  errorMessage: string;
  errorRetriable: boolean;
  partialContentText?: string;
}

export interface BuildPromptMessagesInput {
  conversationId: ConversationId;
  upToMessageId: MessageId;
  maxTokensBudget?: number;
}

// ============================================================================
// Prompt Output Type
// ============================================================================

/** A single message in the prompt array sent to the model API */
export interface PromptMessage {
  role: string;
  content: string;
}

// ============================================================================
// Runtime Streaming Types
// ============================================================================

/** Input for starting a provider-backed runtime model stream. */
export interface StartModelStreamInput {
  requestId: RequestId;
  providerId: ProviderId;
  modelId: string;
  promptMessages: PromptMessage[];
  generationParams?: Record<string, unknown>;
}

/** Runtime stream chunk event sent from the Tauri backend over Channel IPC. */
export interface ModelStreamChunkEvent {
  kind: "CHUNK";
  requestId: RequestId;
  chunk: string;
}

/** Runtime stream completion event sent from the Tauri backend over Channel IPC. */
export interface ModelStreamCompletedEvent {
  kind: "COMPLETED";
  requestId: RequestId;
  usage?: Record<string, unknown>;
}

/** Runtime stream failure event sent from the Tauri backend over Channel IPC. */
export interface ModelStreamFailedEvent {
  kind: "FAILED";
  requestId: RequestId;
  code: string;
  message: string;
  retriable: boolean;
}

/** Union of all runtime model stream events delivered through the channel. */
export type ModelStreamEvent =
  | ModelStreamChunkEvent
  | ModelStreamCompletedEvent
  | ModelStreamFailedEvent;

// ============================================================================
// Type Aliases — Reuse existing domain types for outputs
// ============================================================================

/**
 * Output type alignment:
 *
 * Rust DTO                → TypeScript Type
 * ─────────────────────────────────────────
 * ConversationSummaryDto  → ConversationSummary (from types/conversation)
 * ConversationSnapshotDto → ConversationSnapshot (from types/conversation)
 * BranchDto               → BranchEntity (from types/conversation)
 * MessageDto              → MessageNode (from types/conversation)
 * ProviderDto             → ProviderDto (defined above — differs from ProviderConfig)
 */
export type {
  ConversationSummary,
  ConversationSnapshot,
  BranchEntity,
  MessageNode,
};

// ============================================================================
// Debug Types — Dev-only, not for production UI
// ============================================================================

/** Result of a single invariant check */
export interface InvariantCheck {
  /** Machine-readable check identifier */
  code: string;
  /** Human-readable description */
  label: string;
  /** true iff rowCount === 0 (no violations) */
  passed: boolean;
  /** Number of violating rows */
  rowCount: number;
  /** Up to 10 sample violating rows */
  sampleRows: Record<string, unknown>[];
}

/** Result of running all database invariant checks */
export interface InvariantCheckResult {
  /** true iff all checks passed */
  ok: boolean;
  /** Ordered list of all check results */
  checks: InvariantCheck[];
  /** Unix timestamp (ms) when checks were run */
  checkedAt: number;
}
