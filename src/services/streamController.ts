/**
 * @file streamController.ts
 * @description Core streaming controller that orchestrates the dual-layer
 * streaming architecture.
 *
 * Architecture flow:
 *   Model Stream
 *   → onStreamChunk() — accumulates chunks in runtime registry
 *   → scheduleFlush() — throttled flush to imperative surface
 *   → flushToSurface() — updates the DOM TextNode directly
 *   → onComplete() — commits final text to appStore + database
 *                     (single write, triggers MarkdownRenderer switch)
 *
 * Why runtime registry is NOT in Zustand:
 *   1. Chunks arrive every 10-50ms (model-dependent)
 *   2. Each Zustand setState triggers subscriber evaluation
 *   3. React components subscribed to any part of the store would
 *      re-evaluate their selectors on every chunk
 *   4. This would cause the entire message list to re-render on every token
 *   5. By keeping chunks in a plain Map, only the surface's DOM TextNode changes
 *   6. React only re-renders when the session STATUS changes (STARTING→STREAMING→COMPLETED)
 *
 * Why streaming phase should NOT do markdown parse:
 *   1. Incomplete markdown structures (unclosed ```, broken tables, split lists)
 *   2. Re-parsing on every flush causes visible flickering
 *   3. Syntax highlighting on incomplete code is jarring
 *   4. Correct approach: plain text during stream → MarkdownRenderer after completion
 */

import { useAppStore } from "../stores/useAppStore";
import { useStreamStore } from "../stores/useStreamStore";
import {
  getRuntimeSession,
  setRuntimeSession,
  deleteRuntimeSession,
} from "./streamRuntimeRegistry";
import { createTextSurface } from "./surfaces/surfaceFactory";
import type { RequestId, MessageId } from "../types/base";
import type { StreamRuntimeSession } from "../types/stream";
import type { ModelStreamEvent } from "./tauriTypes";
import * as tauriCmd from "./tauriCommands";

/** Default flush interval in milliseconds (~24ms ≈ 40fps) */
const FLUSH_INTERVAL_MS = 24;

/** Long text threshold for adaptive flush */
const LONG_TEXT_THRESHOLD = 50_000;

/** Slower flush interval for very long texts */
const LONG_TEXT_FLUSH_INTERVAL_MS = 48;

/**
 * Generate a request ID that remains unique across rapid consecutive sends.
 * Uses crypto.randomUUID when available and falls back to timestamp + random.
 */
function createRequestId(): RequestId {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `req_${globalThis.crypto.randomUUID()}` as RequestId;
  }

  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}` as RequestId;
}

// ============================================================================
// Start Stream
// ============================================================================

/**
 * Start a new assistant streaming session.
 *
 * 1. Persists a STREAMING assistant placeholder through Tauri
 * 2. Registers a stream session in useStreamStore
 * 3. Creates a runtime session in the registry (chunks, surface, timer)
 * 4. Returns requestId and assistantMessageId
 *
 * 7. Starts the backend provider stream over a Tauri Channel
 */
export async function startAssistantStream(params: {
  conversationId: string;
  branchId: string;
  parentMessageId: MessageId;
  providerId: string;
  modelId: string;
  promptMessages: Array<{ role: string; content: string }>;
  generationParams?: Record<string, unknown>;
  rendererMode?: "PRETEXT" | "DOM_TEXT";
}): Promise<{ requestId: RequestId; assistantMessageId: MessageId }> {
  const requestId = createRequestId();
  const now = Date.now();

  // 1) Persist the placeholder assistant message through Tauri first
  const assistantMessage = await tauriCmd.createAssistantPlaceholderForBranch({
    conversationId: params.conversationId,
    branchId: params.branchId,
    providerId: params.providerId,
    modelId: params.modelId,
    requestId,
    generationParams: params.generationParams,
  });
  const assistantMessageId = assistantMessage.id as MessageId;
  useAppStore.getState().upsertMessageLocal(assistantMessage);

  // 2) Register lightweight metadata in streamStore
  useStreamStore.getState().createSession({
    requestId,
    conversationId: params.conversationId,
    branchId: params.branchId,
    targetMessageId: assistantMessageId,
    status: "STARTING",
    rendererMode: params.rendererMode ?? "DOM_TEXT",
    completionMode: "BRANCH_HEAD",
    startedAt: now,
    lastChunkAt: null,
    lastFlushAt: null,
    chunkCount: 0,
    visibleVersion: 0,
    visibleCharCount: 0,
  });

  // 3) Create runtime session (NOT in Zustand)
  setRuntimeSession({
    requestId,
    chunks: [],
    pendingChunks: [],
    totalChars: 0,
    surface: null,
    flushTimer: null,
    lastEmitAt: null,
    shouldStickToBottom: true,
  });

  // 4) Mark composer as sending
  useAppStore.getState().setSendingState({
    isSending: true,
    activeRequestId: requestId,
  });

  // 5) Update branch head to point to the streaming placeholder
  //    This ensures walkPathFromHead can traverse to the new message
  useAppStore.getState().patchBranchLocal(params.branchId, {
    headMessageId: assistantMessageId,
    updatedAt: assistantMessage.updatedAt,
  });

  // 6) Transition to STREAMING status
  useStreamStore.getState().patchSession(requestId, {
    status: "STREAMING",
  });

  console.info(
    `[stream] start request=${requestId} conv=${params.conversationId} branch=${params.branchId}`
  );

  void tauriCmd
    .startModelStream(
      {
        requestId,
        providerId: params.providerId,
        modelId: params.modelId,
        promptMessages: params.promptMessages,
        generationParams: params.generationParams,
      },
      (event) => {
        void handleModelStreamEvent(event);
      }
    )
    .catch((error) => {
      void failStream(requestId, normalizeStreamError(error));
    });

  return { requestId, assistantMessageId };
}

/**
 * Start a non-destructive assistant variant stream for regenerate flows.
 *
 * The generated assistant message is attached to the same parent user message
 * but does not overwrite the current branch path unless promotion is
 * explicitly requested after completion.
 */
export async function startAssistantVariantStream(params: {
  conversationId: string;
  branchId: string;
  parentMessageId: MessageId;
  userMessageId: MessageId;
  providerId: string;
  modelId: string;
  promptMessages: Array<{ role: string; content: string }>;
  generationParams?: Record<string, unknown>;
  hasDownstreamConflict: boolean;
  promoteOnComplete?: boolean;
  rendererMode?: "PRETEXT" | "DOM_TEXT";
}): Promise<{ requestId: RequestId; assistantMessageId: MessageId }> {
  const requestId = createRequestId();
  const now = Date.now();
  const assistantMessage = await tauriCmd.createAssistantVariantPlaceholder({
    conversationId: params.conversationId,
    parentMessageId: params.parentMessageId,
    providerId: params.providerId,
    modelId: params.modelId,
    requestId,
    generationParams: params.generationParams,
  });
  const assistantMessageId = assistantMessage.id as MessageId;
  useAppStore.getState().upsertMessageLocal(assistantMessage);
  useAppStore.getState().setVariantPreview({
    userMessageId: params.userMessageId,
    assistantMessageId,
    hasDownstreamConflict: params.hasDownstreamConflict,
  });

  useStreamStore.getState().createSession({
    requestId,
    conversationId: params.conversationId,
    branchId: params.branchId,
    targetMessageId: assistantMessageId,
    status: "STARTING",
    rendererMode: params.rendererMode ?? "DOM_TEXT",
    completionMode: params.promoteOnComplete
      ? "PROMOTE_BRANCH_HEAD"
      : "VARIANT_PREVIEW",
    previewUserMessageId: params.userMessageId,
    previewHasDownstreamConflict: params.hasDownstreamConflict,
    startedAt: now,
    lastChunkAt: null,
    lastFlushAt: null,
    chunkCount: 0,
    visibleVersion: 0,
    visibleCharCount: 0,
  });

  setRuntimeSession({
    requestId,
    chunks: [],
    pendingChunks: [],
    totalChars: 0,
    surface: null,
    flushTimer: null,
    lastEmitAt: null,
    shouldStickToBottom: true,
  });

  useAppStore.getState().setSendingState({
    isSending: true,
    activeRequestId: requestId,
  });

  useStreamStore.getState().patchSession(requestId, {
    status: "STREAMING",
  });

  console.info(
    `[stream] start-variant request=${requestId} conv=${params.conversationId} branch=${params.branchId}`
  );

  void tauriCmd
    .startModelStream(
      {
        requestId,
        providerId: params.providerId,
        modelId: params.modelId,
        promptMessages: params.promptMessages,
        generationParams: params.generationParams,
      },
      (event) => {
        void handleModelStreamEvent(event);
      }
    )
    .catch((error) => {
      void failStream(requestId, normalizeStreamError(error));
    });

  return { requestId, assistantMessageId };
}

// ============================================================================
// Backend Stream Event Handling
// ============================================================================

/**
 * Handle a normalized backend stream event coming from the Tauri Channel.
 *
 * The backend only emits transport-level events; persistence still happens
 * through the existing complete/fail message commands in this controller.
 */
async function handleModelStreamEvent(event: ModelStreamEvent): Promise<void> {
  switch (event.kind) {
    case "CHUNK":
      onStreamChunk(event.requestId, event.chunk);
      return;
    case "COMPLETED":
      await completeStream(event.requestId, event.usage);
      return;
    case "FAILED":
      await failStream(event.requestId, {
        code: event.code,
        message: event.message,
        retriable: event.retriable,
      });
      return;
  }
}

/**
 * Normalize unexpected command-layer errors into the runtime failure shape used
 * by the existing failStream() flow.
 */
function normalizeStreamError(error: unknown): {
  code: string;
  message: string;
  retriable: boolean;
} {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    return {
      code: String((error as { code: unknown }).code),
      message: String((error as { message: unknown }).message),
      retriable: true,
    };
  }

  if (error instanceof Error) {
    return {
      code: "MODEL_STREAM_START_FAILED",
      message: error.message,
      retriable: true,
    };
  }

  return {
    code: "MODEL_STREAM_START_FAILED",
    message: "Failed to start backend model stream",
    retriable: true,
  };
}

// ============================================================================
// Chunk Handling
// ============================================================================

/**
 * Called for each streaming chunk from the model.
 *
 * Important: This function does NOT trigger any React state updates.
 * It only:
 *   1. Appends the chunk to the runtime buffer
 *   2. Queues the delta for the imperative surface
 *   3. Schedules a throttled flush to the imperative surface
 */
export function onStreamChunk(requestId: RequestId, chunk: string): void {
  const runtime = getRuntimeSession(requestId);
  if (!runtime) return;

  // Accumulate in buffer (O(1) push, avoids string concatenation cost)
  runtime.chunks.push(chunk);
  runtime.pendingChunks.push(chunk);
  runtime.totalChars += chunk.length;

  // Schedule flush to surface if mounted
  if (runtime.surface) {
    scheduleFlush(requestId);
  }
}

// ============================================================================
// Flush Management
// ============================================================================

/**
 * Schedule a throttled flush of accumulated chunks to the surface.
 * Uses adaptive interval: longer texts get slower flushes.
 */
function scheduleFlush(requestId: RequestId): void {
  const runtime = getRuntimeSession(requestId);
  if (!runtime || runtime.flushTimer !== null) return;

  // Adaptive flush interval for long texts
  const interval =
    runtime.totalChars > LONG_TEXT_THRESHOLD
      ? LONG_TEXT_FLUSH_INTERVAL_MS
      : FLUSH_INTERVAL_MS;

  runtime.flushTimer = setTimeout(() => {
    if (runtime) runtime.flushTimer = null;
    flushToSurface(requestId);
  }, interval);
}

/**
 * Flush all accumulated chunks to the imperative text surface.
 * This is the only function that actually updates the visible text.
 */
function flushToSurface(requestId: RequestId): void {
  const runtime = getRuntimeSession(requestId);
  if (!runtime || !runtime.surface || runtime.pendingChunks.length === 0) return;

  // Append only the new delta instead of replacing the entire text content.
  const deltaText = runtime.pendingChunks.join("");
  runtime.pendingChunks = [];
  runtime.surface.append(deltaText);

  runtime.lastEmitAt = Date.now();
}

// ============================================================================
// Surface Attachment
// ============================================================================

/**
 * Attach an imperative text surface to a running stream session.
 *
 * Called by the StreamingAssistantContent React component when it mounts.
 * If chunks were accumulated before the component rendered,
 * they are immediately flushed to the new surface.
 */
export function attachSurfaceToRequest(
  requestId: RequestId,
  container: HTMLElement,
  mode: "PRETEXT" | "DOM_TEXT"
): void {
  const runtime = getRuntimeSession(requestId);
  if (!runtime) return;

  // Destroy existing surface if any
  if (runtime.surface) {
    runtime.surface.destroy();
  }

  // Create and mount new surface
  const surface = createTextSurface(mode);
  surface.mount(container);
  runtime.surface = surface;

  // Immediately flush any accumulated chunks
  if (runtime.chunks.length > 0) {
    surface.replaceAll(runtime.chunks.join(""));
    runtime.pendingChunks = [];
  }
}

// ============================================================================
// Stream Completion
// ============================================================================

/**
 * Complete a streaming session.
 *
 * This is where the "one-time commit" happens:
 *   1. Join all chunks into final text
 *   2. Commit through Tauri complete_assistant_message
 *   3. Update appStore message with the confirmed DTO
 *   4. Update streamStore session
 *   5. Clean up runtime session
 *
 * After this, the MessageBubble will switch from StreamingAssistantContent
 * to MarkdownRenderer for the final formatted display.
 */
export async function completeStream(
  requestId: RequestId,
  usage?: Record<string, unknown>
): Promise<void> {
  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  const runtime = getRuntimeSession(requestId);
  if (!session || !runtime) return;

  const finalText = runtime.chunks.join("");
  const now = Date.now();

  // 1) Write to database
  const persistedMessage = await tauriCmd.completeAssistantMessage({
    messageId: session.targetMessageId,
    contentText: finalText,
    usage,
  });

  // 2) Update appStore with final text (triggers switch to MarkdownRenderer)
  useAppStore.getState().patchMessageLocal(session.targetMessageId, {
    status: persistedMessage.status,
    updatedAt: persistedMessage.updatedAt,
    content: persistedMessage.content,
    generation: persistedMessage.generation,
    error: persistedMessage.error,
  });

  // 3) Update branch/preview state depending on the session completion mode
  if (session.completionMode === "PROMOTE_BRANCH_HEAD") {
    const updatedBranch = await tauriCmd.setBranchHeadMessage({
      branchId: session.branchId,
      messageId: session.targetMessageId,
    });
    useAppStore.getState().upsertBranchLocal(updatedBranch);
    useAppStore.getState().setVariantPreview(null);
  } else if (session.completionMode === "VARIANT_PREVIEW") {
    if (session.previewUserMessageId) {
      useAppStore.getState().setVariantPreview({
        userMessageId: session.previewUserMessageId,
        assistantMessageId: session.targetMessageId,
        hasDownstreamConflict: session.previewHasDownstreamConflict ?? false,
      });
    }
  } else {
    useAppStore.getState().patchBranchLocal(session.branchId, {
      headMessageId: session.targetMessageId,
      updatedAt: persistedMessage.updatedAt,
    });
  }

  // 4) Update stream session status
  useStreamStore.getState().completeSession(requestId);

  // 4) Reset composer state
  useAppStore.getState().setSendingState({
    isSending: false,
    activeRequestId: null,
  });

  // 5) Clean up runtime session
  deleteRuntimeSession(requestId);

  console.info(
    `[stream] complete request=${requestId} chars=${finalText.length} chunks=${runtime.chunks.length} duration=${Date.now() - session.startedAt}ms`
  );

  // 6) Trigger auto title generation for new conversations
  if (session.completionMode === "BRANCH_HEAD") {
    const { workspace, summariesById } = useAppStore.getState();
    const conversationId = workspace.activeConversationId;
    if (conversationId) {
      const summary = summariesById[conversationId];
      const hasDefaultTitle =
        !summary?.title ||
        summary.title === "" ||
        summary.title.toLowerCase().startsWith("new conversation") ||
        summary.title.toLowerCase().startsWith("新建会话");
      if (hasDefaultTitle) {
        useAppStore.getState().autoGenerateTitle(conversationId).catch(() => {});
      }
    }
  }

  // 7) Delayed cleanup of stream store metadata
  setTimeout(() => {
    useStreamStore.getState().removeSession(requestId);
  }, 1500);
}

// ============================================================================
// Stream Failure
// ============================================================================

/**
 * Handle a streaming failure.
 *
 * Preserves any partial text that was received, persists FAILED status through
 * Tauri, and then cleans up runtime resources.
 */
export async function failStream(
  requestId: RequestId,
  error: { code: string; message: string; retriable?: boolean }
): Promise<void> {
  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  if (!session || session.status === "CANCELLED") return;

  const runtime = getRuntimeSession(requestId);
  const partialText = runtime?.chunks.join("") ?? "";

  // 1) Write partial result to database
  const persistedMessage = await tauriCmd.failAssistantMessage({
    messageId: session.targetMessageId,
    errorCode: error.code,
    errorMessage: error.message,
    errorRetriable: error.retriable ?? true,
    partialContentText: partialText || undefined,
  });

  // 2) Update appStore with partial text + error
  useAppStore.getState().patchMessageLocal(session.targetMessageId, {
    status: persistedMessage.status,
    updatedAt: persistedMessage.updatedAt,
    content: persistedMessage.content,
    generation: persistedMessage.generation,
    error: persistedMessage.error,
  });

  // 3) Update branch head only for direct branch streams; variant flows remain preview-only.
  if (session.completionMode === "BRANCH_HEAD" || !session.completionMode) {
    useAppStore.getState().patchBranchLocal(session.branchId, {
      headMessageId: session.targetMessageId,
      updatedAt: persistedMessage.updatedAt,
    });
  } else if (session.previewUserMessageId) {
    useAppStore.getState().setVariantPreview({
      userMessageId: session.previewUserMessageId,
      assistantMessageId: session.targetMessageId,
      hasDownstreamConflict: session.previewHasDownstreamConflict ?? false,
    });
  }

  // 4) Update stream session
  useStreamStore.getState().failSession(requestId, error);

  // 4) Reset composer
  useAppStore.getState().setSendingState({
    isSending: false,
    activeRequestId: null,
  });

  // 5) Clean up runtime
  deleteRuntimeSession(requestId);

  console.error(
    `[stream] fail request=${requestId} error=${error.code} partial_chars=${partialText.length}`
  );
}

// ============================================================================
// Stream Cancellation
// ============================================================================

/**
 * Cancel an ongoing stream (user clicks "Stop generating").
 *
 * Requests backend cancellation first, then persists the interruption as a
 * retriable FAILED message with `error.code = USER_CANCELLED`.
 */
export async function cancelStream(requestId: RequestId): Promise<void> {
  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  const runtime = getRuntimeSession(requestId);
  if (!session) return;

  const partialText = runtime?.chunks.join("") ?? "";
  useStreamStore.getState().patchSession(requestId, {
    status: "CANCELLED",
  });

  try {
    await tauriCmd.abortModelStream(requestId);
  } catch (error) {
    console.warn(`[stream] abort request failed request=${requestId}`, error);
  }

  // Clear any pending flush timer
  if (runtime?.flushTimer !== null) {
    // Timer will be cleaned up by deleteRuntimeSession
  }

  const persistedMessage = await tauriCmd.failAssistantMessage({
    messageId: session.targetMessageId,
    errorCode: "USER_CANCELLED",
    errorMessage: "Generation cancelled by user",
    errorRetriable: true,
    partialContentText: partialText || undefined,
  });

  // Update appStore
  useAppStore.getState().patchMessageLocal(session.targetMessageId, {
    status: persistedMessage.status,
    updatedAt: persistedMessage.updatedAt,
    content: persistedMessage.content,
    generation: persistedMessage.generation,
    error: persistedMessage.error,
  });

  // Update branch head only for direct branch streams; variant flows remain preview-only.
  if (session.completionMode === "BRANCH_HEAD" || !session.completionMode) {
    useAppStore.getState().patchBranchLocal(session.branchId, {
      headMessageId: session.targetMessageId,
      updatedAt: persistedMessage.updatedAt,
    });
  } else if (session.previewUserMessageId) {
    useAppStore.getState().setVariantPreview({
      userMessageId: session.previewUserMessageId,
      assistantMessageId: session.targetMessageId,
      hasDownstreamConflict: session.previewHasDownstreamConflict ?? false,
    });
  }

  // Reset composer
  useAppStore.getState().setSendingState({
    isSending: false,
    activeRequestId: null,
  });

  // Clean up
  deleteRuntimeSession(requestId);

  console.info(
    `[stream] cancel request=${requestId} partial_chars=${partialText.length}`
  );

  // Delayed cleanup
  setTimeout(() => {
    useStreamStore.getState().removeSession(requestId);
  }, 1000);
}
