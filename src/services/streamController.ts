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
import type { ModelStreamEvent } from "./tauriTypes";
import type { ToolCallInfo } from "../types/conversation";
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
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  toolChoice?: string;
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
    toolCalls: [],
    contentBlocks: [],
    currentTextChunks: [],
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
        tools: params.tools,
        toolChoice: params.toolChoice,
        conversationId: params.conversationId,
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
  rendererMode?: "PRETEXT" | "DOM_TEXT";
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  toolChoice?: string;
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
    completionMode: "VARIANT_PREVIEW",
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
    toolCalls: [],
    contentBlocks: [],
    currentTextChunks: [],
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
        tools: params.tools,
        toolChoice: params.toolChoice,
        conversationId: params.conversationId,
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
      if (event.finishReason === "tool_calls" && event.toolCalls) {
        // Backend reports tool calls requested — log for now, full ReAct loop in later phase
        console.info(
          `[stream] tool_calls requested request=${event.requestId} calls=${event.toolCalls.length}`,
          event.toolCalls.map((tc) => tc.function.name)
        );
      }
      await completeStream(event.requestId, event.usage, event.reasoningContent);
      return;
    case "FAILED":
      await failStream(event.requestId, {
        code: event.code,
        message: event.message,
        retriable: event.retriable,
      });
      return;
    case "RETRYING": {
      const session = useStreamStore.getState().sessionsByRequestId[event.requestId];
      if (session) {
        useStreamStore.getState().patchSession(event.requestId, {
          retrying: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            nextRetryInSecs: event.nextRetryInSecs,
            errorSummary: event.errorSummary,
            receivedAt: Date.now(),
          },
          visibleVersion: session.visibleVersion + 1,
        });
      }
      console.info(
        `[stream] retrying request=${event.requestId} attempt=${event.attempt}/${event.maxAttempts} wait=${event.nextRetryInSecs}s`
      );
      return;
    }
    case "TOOL_CALL": {
      const runtime = getRuntimeSession(event.requestId);
      if (runtime) {
        // Flush accumulated text chunks into a text block before the tool call
        if (runtime.currentTextChunks.length > 0) {
          runtime.contentBlocks.push({
            type: "text",
            content: runtime.currentTextChunks.join(""),
          });
          runtime.currentTextChunks = [];
        }
        // Append tool_call block
        runtime.contentBlocks.push({
          type: "tool_call",
          callId: event.callId,
          functionName: event.functionName,
          args: event.arguments,
        });

        // Legacy toolCalls array (backward compat)
        const tc: ToolCallInfo = {
          id: `tc_${event.callId}`,
          callId: event.callId,
          functionName: event.functionName,
          argumentsJson: event.arguments,
          resultJson: "",
          status: "PENDING",
        };
        runtime.toolCalls = [...runtime.toolCalls, tc];
        // Force a React re-render by bumping visibleVersion
        const session = useStreamStore.getState().sessionsByRequestId[event.requestId];
        if (session) {
          useStreamStore.getState().patchSession(event.requestId, {
            visibleVersion: session.visibleVersion + 1,
          });
        }
      }
      console.info(
        `[stream] tool_call request=${event.requestId} callId=${event.callId} fn=${event.functionName}`
      );
      return;
    }
    case "TOOL_RESULT": {
      const runtime = getRuntimeSession(event.requestId);
      if (runtime) {
        // Append tool_result block
        runtime.contentBlocks.push({
          type: "tool_result",
          callId: event.callId,
          result: event.result,
          success: event.success,
        });

        // Legacy toolCalls array update (backward compat)
        const idx = runtime.toolCalls.findIndex(
          (tc) => tc.callId === event.callId
        );
        if (idx !== -1) {
          const updated = { ...runtime.toolCalls[idx] };
          updated.resultJson = event.result;
          updated.status = event.success ? "COMPLETED" : "FAILED";
          if (!event.success) {
            updated.errorMessage = event.result;
          }
          runtime.toolCalls = [
            ...runtime.toolCalls.slice(0, idx),
            updated,
            ...runtime.toolCalls.slice(idx + 1),
          ];
          const session = useStreamStore.getState().sessionsByRequestId[event.requestId];
          if (session) {
            useStreamStore.getState().patchSession(event.requestId, {
              visibleVersion: session.visibleVersion + 1,
              pendingApproval: undefined,
            });
          }
        }
      }
      console.info(
        `[stream] tool_result request=${event.requestId} callId=${event.callId} success=${event.success}`
      );
      return;
    }
    case "APPROVAL_REQUIRED": {
      console.info(
        `[stream] approval_required request=${event.requestId} approvalId=${event.approvalId} fn=${event.functionName}`
      );
      // Store pending approval in streamStore (drives React approval UI)
      // Do NOT use window.confirm — Tauri blocks it in webview
      useStreamStore.getState().patchSession(event.requestId, {
        pendingApproval: {
          approvalId: event.approvalId,
          functionName: event.functionName,
          description: event.description,
          timeoutSecs: event.timeoutSecs,
          receivedAt: Date.now(),
        },
      });
      return;
    }
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

  // Clear retry state on first chunk after a retry
  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  if (session?.retrying) {
    useStreamStore.getState().patchSession(requestId, {
      retrying: undefined,
      visibleVersion: session.visibleVersion + 1,
    });
  }

  // Accumulate in buffer (O(1) push, avoids string concatenation cost)
  runtime.chunks.push(chunk);
  runtime.pendingChunks.push(chunk);
  runtime.totalChars += chunk.length;

  // Also accumulate in currentTextChunks for contentBlocks (B-2 inline display)
  runtime.currentTextChunks.push(chunk);

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
  usage?: Record<string, unknown>,
  reasoningContent?: string
): Promise<void> {
  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  const runtime = getRuntimeSession(requestId);
  if (!session || !runtime) return;

  // Flush any remaining currentTextChunks into the final text block
  if (runtime.currentTextChunks.length > 0) {
    runtime.contentBlocks.push({
      type: "text",
      content: runtime.currentTextChunks.join(""),
    });
    runtime.currentTextChunks = [];
  }

  const finalText = runtime.chunks.join("");

  // Extract tool calls from runtime session for persistence
  const runtimeToolCalls = runtime.toolCalls.length > 0
    ? runtime.toolCalls.map(tc => ({
        callId: tc.callId,
        functionName: tc.functionName,
        argumentsJson: tc.argumentsJson,
        resultJson: tc.resultJson,
        status: tc.status,
        errorMessage: tc.errorMessage,
      }))
    : undefined;

  // 1) Write to database
  const hasContentBlocks = runtime.contentBlocks.some((block) => block.type !== "text");
  const persistedMessage = await tauriCmd.completeAssistantMessage({
    messageId: session.targetMessageId,
    requestId,
    contentText: finalText,
    contentBlocks: hasContentBlocks ? runtime.contentBlocks : undefined,
    usage,
    reasoningContent,
    toolCalls: runtimeToolCalls,
  });

  // 2) Update appStore with final text (triggers switch to MarkdownRenderer)
  //    Use the canonical DTO returned by Tauri to avoid frontend/DB drift.
  useAppStore.getState().patchMessageLocal(session.targetMessageId, {
    status: persistedMessage.status,
    updatedAt: persistedMessage.updatedAt,
    content: persistedMessage.content,
    generation: persistedMessage.generation,
    error: persistedMessage.error,
    toolCalls: persistedMessage.toolCalls,
  });

  // 3) Update branch/preview state depending on the session completion mode.
  // Regenerate always stays a candidate variant; it never patches branch head.
  if (session.completionMode === "VARIANT_PREVIEW") {
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

  // 6) Trigger auto title generation for conversations without a user-set title
  if (session.completionMode === "BRANCH_HEAD") {
    const { workspace, summariesById } = useAppStore.getState();
    const conversationId = workspace?.activeConversationId;
    if (conversationId) {
      const summary = summariesById[conversationId];
      const title = summary?.title ?? "";
      const hasDefaultTitle =
        !title.trim() ||
        title === "New Conversation" ||
        title.toLowerCase().startsWith("new conversation") ||
        title.toLowerCase().startsWith("新建会话") ||
        title.toLowerCase().startsWith("未命名会话");
      if (hasDefaultTitle) {
        console.info(
          `[stream] triggering auto title generation for conv=${conversationId} title="${title}"`
        );
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

  if (runtime?.currentTextChunks.length) {
    runtime.contentBlocks.push({
      type: "text",
      content: runtime.currentTextChunks.join(""),
    });
    runtime.currentTextChunks = [];
  }

  const partialText = runtime?.chunks.join("") ?? "";
  const partialContentBlocks = runtime?.contentBlocks.some(
    (block) => block.type !== "text"
  )
    ? runtime.contentBlocks
    : undefined;
  const runtimeToolCalls = runtime?.toolCalls.length
    ? runtime.toolCalls.map((tc) => ({
        callId: tc.callId,
        functionName: tc.functionName,
        argumentsJson: tc.argumentsJson,
        resultJson: tc.resultJson,
        status: tc.status,
        errorMessage: tc.errorMessage,
      }))
    : undefined;

  // 1) Write partial result to database
  const persistedMessage = await tauriCmd.failAssistantMessage({
    messageId: session.targetMessageId,
    requestId,
    errorCode: error.code,
    errorMessage: error.message,
    errorRetriable: error.retriable ?? true,
    partialContentText: partialText || undefined,
    partialContentBlocks,
    toolCalls: runtimeToolCalls,
  });

  // 2) Update appStore with partial text + error
  useAppStore.getState().patchMessageLocal(session.targetMessageId, {
    status: persistedMessage.status,
    updatedAt: persistedMessage.updatedAt,
    content: persistedMessage.content,
    generation: persistedMessage.generation,
    error: persistedMessage.error,
    toolCalls: persistedMessage.toolCalls,
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

  if (runtime?.currentTextChunks.length) {
    runtime.contentBlocks.push({
      type: "text",
      content: runtime.currentTextChunks.join(""),
    });
    runtime.currentTextChunks = [];
  }

  const partialText = runtime?.chunks.join("") ?? "";
  const partialContentBlocks = runtime?.contentBlocks.some(
    (block) => block.type !== "text"
  )
    ? runtime.contentBlocks
    : undefined;
  const runtimeToolCalls = runtime?.toolCalls.length
    ? runtime.toolCalls.map((tc) => ({
        callId: tc.callId,
        functionName: tc.functionName,
        argumentsJson: tc.argumentsJson,
        resultJson: tc.resultJson,
        status: tc.status,
        errorMessage: tc.errorMessage,
      }))
    : undefined;
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
    requestId,
    errorCode: "USER_CANCELLED",
    errorMessage: "Generation cancelled by user",
    errorRetriable: true,
    partialContentText: partialText || undefined,
    partialContentBlocks,
    toolCalls: runtimeToolCalls,
  });

  // Update appStore
  useAppStore.getState().patchMessageLocal(session.targetMessageId, {
    status: persistedMessage.status,
    updatedAt: persistedMessage.updatedAt,
    content: persistedMessage.content,
    generation: persistedMessage.generation,
    error: persistedMessage.error,
    toolCalls: persistedMessage.toolCalls,
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
