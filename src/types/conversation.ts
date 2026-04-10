/**
 * @file conversation.ts
 * @description Core domain models for conversations, message nodes, and branches.
 *
 * Key design decisions:
 * - MessageNode uses parentId to form a tree structure (no parent reference loops)
 * - childIds is a runtime index that can be reconstructed from parentId
 * - Messages are treated as immutable — edits create new nodes, never modify existing ones
 * - A "branch" is a named reference to a path in the tree, not a copy of messages
 */

import type {
  BranchId,
  BranchStatus,
  ConversationId,
  ForkSourceType,
  MessageId,
  MessageRole,
  MessageStatus,
  ModelId,
  ProviderId,
  RequestId,
  UnixMs,
} from "./base";

// ============================================================================
// Token Usage
// ============================================================================

/** Token usage statistics for a model generation request */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// ============================================================================
// Message Error
// ============================================================================

/** Error information attached to a failed message */
export interface MessageError {
  code: string;
  message: string;
  retriable: boolean;
}

// ============================================================================
// Message Content
// ============================================================================

/**
 * Message content container.
 * Only stores the final committed text.
 * During streaming, incremental text must NOT be written here.
 */
export interface MessageContent {
  text: string;
  format: "MARKDOWN";
}

// ============================================================================
// Message Generation Metadata
// ============================================================================

/** Metadata about how a message was generated */
export interface MessageGenerationMeta {
  providerId: ProviderId;
  modelId: ModelId;
  requestId?: RequestId;
  params?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
  usage?: TokenUsage;
}

// ============================================================================
// MessageNode
// ============================================================================

/**
 * A single node in the conversation message tree.
 *
 * Tree structure is expressed solely through `parentId`:
 * - Root messages have parentId = null
 * - All other messages point to their parent
 * - Multiple children of the same parent form "siblings" (variants/branches)
 *
 * Immutability rule: Once created, a MessageNode's content and parentId
 * should never be modified. To "edit" a message, create a new MessageNode
 * with editedFromMessageId pointing to the original.
 */
export interface MessageNode {
  id: MessageId;
  conversationId: ConversationId;

  role: MessageRole;
  status: MessageStatus;

  /**
   * Tree structure core: parentId alone is sufficient to reconstruct all paths.
   * Root messages have parentId = null.
   */
  parentId: MessageId | null;

  /**
   * Runtime index: list of child message IDs.
   * Can be reconstructed from parentId relationships.
   * Recommended: build at snapshot load time, do not persist.
   */
  childIds: MessageId[];

  /**
   * Depth from root (0 for root messages).
   * Recommended: compute at snapshot load time.
   */
  depth: number;

  content: MessageContent;

  createdAt: UnixMs;
  updatedAt: UnixMs;

  generation?: MessageGenerationMeta;
  error?: MessageError;

  /**
   * Only used when a historical user message is "edited and branched".
   * Points to the original message this was derived from.
   * Enforces non-destructive branching.
   */
  editedFromMessageId?: MessageId;
}

// ============================================================================
// Branch Entity
// ============================================================================

/**
 * A named reference to a path in the message tree.
 *
 * A branch is NOT a copy of messages — it's a pointer to a fork point
 * and a head node. All branches in the same conversation share the
 * same underlying message tree.
 *
 * Design principles:
 * - isMainline only affects which branch opens by default
 * - Setting a branch as mainline NEVER modifies the message tree
 * - forkPointMessageId identifies where this branch diverged
 */
export interface BranchEntity {
  id: BranchId;
  conversationId: ConversationId;

  name: string;
  status: BranchStatus;

  /** Whether this is the default branch opened when entering a conversation */
  isMainline: boolean;

  /** Which branch this one forked from (null for the original branch) */
  sourceBranchId: BranchId | null;

  /**
   * The message node where this branch diverged.
   * Null for the initial/mainline branch of a new conversation.
   */
  forkPointMessageId: MessageId | null;

  /** What kind of action created this fork */
  forkSourceType: ForkSourceType;

  /**
   * The specific message that triggered the fork:
   * - HISTORY_ASSISTANT: the assistant message user clicked "continue from here"
   * - HISTORY_USER_EDIT: the user message being edited
   * - VARIANT: the assistant variant being continued from
   */
  forkSourceMessageId: MessageId | null;

  /**
   * The latest (leaf) message node in this branch's path.
   * Null for empty conversations.
   */
  headMessageId: MessageId | null;

  /** Optional branch-level preferred model profile. */
  preferredModelId?: ModelId;

  /** Display metadata */
  color?: string;
  summary?: string;

  createdAt: UnixMs;
  updatedAt: UnixMs;
  archivedAt?: UnixMs;
}

// ============================================================================
// Conversation Summary
// ============================================================================

/** Lightweight summary of a conversation for sidebar display */
export interface ConversationSummary {
  id: ConversationId;
  title: string;

  createdAt: UnixMs;
  updatedAt: UnixMs;
  lastOpenedAt: UnixMs | null;
  archivedAt: UnixMs | null;

  mainlineBranchId: BranchId | null;
  activeBranchCount: number;
  archivedBranchCount: number;
  totalMessageCount: number;
}

// ============================================================================
// Conversation Indexes
// ============================================================================

/**
 * Runtime indexes built on top of the message tree.
 * Recommended: reconstruct at snapshot load time, do not persist.
 */
export interface ConversationIndexes {
  /** Root message IDs (parentId = null) */
  rootMessageIds: MessageId[];

  /** Map from parentId to list of child messageIds */
  childMessageIdsByParentId: Record<MessageId, MessageId[]>;

  /** Map from forkPointMessageId to list of branchIds */
  branchIdsByForkPointId: Record<MessageId, BranchId[]>;
}

// ============================================================================
// Conversation Entities
// ============================================================================

/** All entities within a single conversation */
export interface ConversationEntities {
  messages: Record<MessageId, MessageNode>;
  branches: Record<BranchId, BranchEntity>;
}

// ============================================================================
// Conversation Snapshot
// ============================================================================

/**
 * Complete snapshot of an active conversation.
 * Only the currently open conversation should be loaded as a full snapshot.
 * Other conversations are represented by ConversationSummary only.
 */
export interface ConversationSnapshot {
  summary: ConversationSummary;
  entities: ConversationEntities;
  indexes: ConversationIndexes;
  loadedAt: UnixMs;
}
