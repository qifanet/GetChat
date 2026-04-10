/**
 * @file stream.ts
 * @description Type definitions for the dual-layer streaming architecture.
 *
 * Architecture overview:
 *   Model Stream
 *   → StreamController
 *   → StreamRuntimeRegistry (chunks, timers, imperative surface) ← NOT in Zustand
 *   → useStreamStore (meta only, low frequency updates)           ← In Zustand
 *   → onCompleted → commit final text to appStore.activeSnapshot
 *
 * Critical design rules:
 * 1. StreamRuntimeSession must NEVER be stored in Zustand or React state.
 *    It lives in a plain Map (streamRuntimeRegistry.ts).
 * 2. ImperativeTextSurface is an adapter interface for streaming text display.
 *    Do NOT fabricate any specific implementation's API — use the adapter pattern.
 * 3. StreamSessionMeta only stores serializable metadata for React consumption.
 */

import type {
  BranchId,
  ConversationId,
  MessageId,
  RequestId,
  StreamRendererMode,
  UnixMs,
} from "./base";

// ============================================================================
// Stream Error
// ============================================================================

/** Error information for a failed stream */
export interface StreamError {
  code: string;
  message: string;
}

// ============================================================================
// Stream Session Meta (Serializable — stored in Zustand)
// ============================================================================

/**
 * Serializable metadata for an active stream session.
 * This is the ONLY streaming-related data that goes into Zustand.
 * Updated at low frequency (not per-token).
 */
export interface StreamSessionMeta {
  requestId: RequestId;
  conversationId: ConversationId;
  branchId: BranchId;
  targetMessageId: MessageId;

  status: "STARTING" | "STREAMING" | "COMPLETED" | "FAILED" | "CANCELLED";

  rendererMode: StreamRendererMode;

  startedAt: UnixMs;
  lastChunkAt: UnixMs | null;
  lastFlushAt: UnixMs | null;

  /** Number of chunks received (low-frequency counter) */
  chunkCount: number;

  /** Incremented on each surface flush (for React key optimization) */
  visibleVersion: number;

  /** Total visible character count (approximate) */
  visibleCharCount: number;

  /** How completion should update workspace state after persistence succeeds. */
  completionMode?: "BRANCH_HEAD" | "PROMOTE_BRANCH_HEAD" | "VARIANT_PREVIEW";

  /** Parent user message for variant preview flows. */
  previewUserMessageId?: MessageId;

  /** Whether previewed downstream content should stay hidden. */
  previewHasDownstreamConflict?: boolean;

  error?: StreamError;
}

// ============================================================================
// Imperative Text Surface (Adapter Interface)
// ============================================================================

/**
 * Adapter interface for imperative text surface rendering.
 *
 * This is the key abstraction that prevents per-token React re-renders.
 * During streaming, text is appended imperatively to a DOM element,
 * bypassing React's reconciliation entirely.
 *
 * Implementation options:
 * 1. DomTextSurface — plain DOM TextNode, always works as fallback
 * 2. PretextSurfaceAdapter — wraps Pretext library if available
 *
 * IMPORTANT: Do NOT fabricate any specific implementation's API.
 * Fill in the real implementation details in the adapter layer.
 */
export interface ImperativeTextSurface {
  /** Mount the surface into a container DOM element */
  mount(container: HTMLElement): void;

  /** Append a chunk of text to the current content */
  append(chunk: string): void;

  /** Replace all content with the given text */
  replaceAll(text: string): void;

  /** Clean up resources and detach from the DOM */
  destroy(): void;
}

// ============================================================================
// Stream Runtime Session (Non-Serializable — NOT in Zustand)
// ============================================================================

/**
 * Non-serializable runtime state for an active stream.
 * Stored in a plain Map in streamRuntimeRegistry.ts.
 * NEVER put this into Zustand or React state.
 *
 * Uses string[] for chunks instead of string concatenation
 * to avoid O(n²) cost on long texts.
 */
export interface StreamRuntimeSession {
  requestId: RequestId;

  /**
   * Accumulated chunks. Using array instead of string concatenation
   * avoids O(n²) copying cost for long streaming responses.
   * Final text: chunks.join("")
   */
  chunks: string[];

  /**
   * Chunks that have not yet been flushed to the imperative surface.
   * This lets the renderer append only the delta instead of rebuilding the
   * full text on every flush.
   */
  pendingChunks: string[];

  /** Running total of characters (for flush scheduling) */
  totalChars: number;

  /** The imperative text surface for this stream */
  surface: ImperativeTextSurface | null;

  /** Timer handle for throttled flush (NOT in Zustand) */
  flushTimer: ReturnType<typeof setTimeout> | null;

  /** Timestamp of last surface emit */
  lastEmitAt: UnixMs | null;

  /** Whether to auto-scroll as new content arrives */
  shouldStickToBottom: boolean;
}
