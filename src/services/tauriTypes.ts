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
import type { ContentBlock } from "../types/stream";

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
  helperModelId: string | null;
  systemPrompt: string;
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

export interface DirectOverwriteUserMessageInput {
  conversationId: ConversationId;
  branchId: BranchId;
  messageId: MessageId;
  contentText: string;
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
  requestId: RequestId;
  contentText: string;
  contentBlocks?: ContentBlock[];
  usage?: Record<string, unknown>;
  reasoningContent?: string;
  toolCalls?: ToolCallResultInput[];
}

/** A single tool call result to persist alongside an assistant message. */
export interface ToolCallResultInput {
  callId: string;
  functionName: string;
  argumentsJson: string;
  resultJson: string;
  status: string;
  errorMessage?: string;
}

export interface FailAssistantMessageInput {
  messageId: MessageId;
  requestId: RequestId;
  errorCode: string;
  errorMessage: string;
  errorRetriable: boolean;
  partialContentText?: string;
  partialContentBlocks?: ContentBlock[];
  toolCalls?: ToolCallResultInput[];
}

export interface BuildPromptMessagesInput {
  conversationId: ConversationId;
  upToMessageId: MessageId;
  maxTokensBudget?: number;
  branchId?: BranchId;
}

// ============================================================================
// Prompt Output Type
// ============================================================================

/** A single message in the prompt array sent to the model API */
export interface PromptMessage {
  sourceMessageId?: MessageId;
  role: string;
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCallDto[];
  toolCallId?: string;
  name?: string;
}

/** Tool call returned by the model (function name + arguments). */
export interface ToolCallDto {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/** Tool definition sent to the model API. */
export interface ToolDefinitionDto {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
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
  tools?: ToolDefinitionDto[];
  toolChoice?: string;
  conversationId?: string;
  branchId?: BranchId;
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
  finishReason?: string;
  toolCalls?: ToolCallDto[];
  reasoningContent?: string;
}

/** Runtime stream failure event sent from the Tauri backend over Channel IPC. */
export interface ModelStreamFailedEvent {
  kind: "FAILED";
  requestId: RequestId;
  code: string;
  message: string;
  retriable: boolean;
}

/** Tool call started event — emitted when the backend begins executing a tool. */
export interface ModelStreamToolCallEvent {
  kind: "TOOL_CALL";
  requestId: RequestId;
  callId: string;
  functionName: string;
  arguments: string;
}

/** Tool execution result event — emitted after a tool finishes executing. */
export interface ModelStreamToolResultEvent {
  kind: "TOOL_RESULT";
  requestId: RequestId;
  callId: string;
  result: string;
  success: boolean;
}

/** Approval required event — emitted when a destructive tool needs user confirmation. */
export interface ModelStreamApprovalRequiredEvent {
  kind: "APPROVAL_REQUIRED";
  requestId: RequestId;
  approvalId: string;
  functionName: string;
  description: string;
  timeoutSecs: number;
}

/** Retry in progress event — emitted before an automatic retry after a retriable error. */
export interface ModelStreamRetryingEvent {
  kind: "RETRYING";
  requestId: RequestId;
  attempt: number;
  maxAttempts: number;
  nextRetryInSecs: number;
  errorSummary: string;
}

/** Union of all runtime model stream events delivered through the channel. */
export type ModelStreamEvent =
  | ModelStreamChunkEvent
  | ModelStreamCompletedEvent
  | ModelStreamFailedEvent
  | ModelStreamToolCallEvent
  | ModelStreamToolResultEvent
  | ModelStreamApprovalRequiredEvent
  | ModelStreamRetryingEvent
  | ModelStreamContextCompressingEvent
  | ModelStreamContextCompressionSkippedEvent
  | ModelStreamContextStatusUpdatedEvent
  | ModelStreamContextCompressedEvent;

/** Mid-loop context compression started. */
export interface ModelStreamContextCompressingEvent {
  kind: "CONTEXT_COMPRESSING";
  requestId: RequestId;
  level: number;
  usageRatio: number;
}

/** Mid-loop context compression was intentionally skipped. */
export interface ModelStreamContextCompressionSkippedEvent {
  kind: "CONTEXT_COMPRESSION_SKIPPED";
  requestId: RequestId;
  reason: string;
  usageRatio: number;
}

/** ReAct-loop in-flight context status update. */
export interface ModelStreamContextStatusUpdatedEvent {
  kind: "CONTEXT_STATUS_UPDATED";
  requestId: RequestId;
  usedTokens: number;
  totalTokens: number;
  percentage: number;
  messageCount: number;
}

/** Mid-loop context compression completed. */
export interface ModelStreamContextCompressedEvent {
  kind: "CONTEXT_COMPRESSED";
  requestId: RequestId;
  compressedCount: number;
  tokensSaved: number;
  newUsageRatio: number;
}

// ============================================================================
// Context Management Types
// ============================================================================

/** Context window usage status for a conversation branch. */
export interface ContextTokenBreakdownDto {
  systemTokens: number;
  toolPromptTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  compressedContextTokens: number;
  skillPromptTokens: number;
}

export interface ContextStatusDto {
  /** Estimate of the actual next model request after prompt-budget trimming. */
  usedTokens: number;
  /** Untrimmed full-path estimate for diagnostics/compression decisions. */
  rawUsedTokens: number;
  totalTokens: number;
  percentage: number;
  rawPercentage: number;
  messageCount: number;
  rawMessageCount: number;
  promptBudgetTokens: number;
  breakdown: ContextTokenBreakdownDto;
}

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

// ============================================================================
// Filesystem Commands (v1.3.0)
// ============================================================================

export interface DirectoryEntryDto {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface FilePreviewDto {
  path: string;
  content: string;
  totalLines: number;
  truncated: boolean;
  language: string | null;
  isBinary: boolean;
  fileSize: number;
}
