/**
 * @file useStreamingMessage.ts
 * @description Hook that provides lightweight streaming state for a message.
 *
 * This hook subscribes to useStreamStore but ONLY reads the session metadata,
 * NOT the actual chunk content. This is critical for performance:
 *
 *   ❌ Bad:  subscribing to every chunk → re-render per token
 *   ✅ Good: subscribing to status/requestId → re-render only on state changes
 *
 * React components using this hook will only re-render when:
 *   - Stream starts (status changes to STREAMING)
 *   - Stream completes (status changes to COMPLETED)
 *   - Stream fails (status changes to FAILED)
 *
 * They will NOT re-render on every chunk, because chunk data lives
 * in the runtime registry (plain Map), not in Zustand.
 */

import { useMemo } from "react";
import { useStreamStore } from "../stores/useStreamStore";
import type { MessageNode } from "../types/conversation";

export interface StreamingMessageState {
  /** Whether this message is currently being streamed */
  isStreaming: boolean;

  /** The request ID associated with this stream (null if not streaming) */
  requestId: string | null;

  /** Which renderer mode to use for the streaming surface */
  rendererMode: "PRETEXT" | "DOM_TEXT";

  /** Current stream status (null if not streaming) */
  streamStatus: "STARTING" | "STREAMING" | "COMPLETED" | "FAILED" | "CANCELLED" | null;

  /** Approximate character count visible on screen */
  visibleCharCount: number;
}

/**
 * Get lightweight streaming state for a given message.
 *
 * Usage:
 *   const { isStreaming, requestId, rendererMode } = useStreamingMessage(message);
 *
 *   if (isStreaming) {
 *     return <StreamingAssistantContent requestId={requestId!} rendererMode={rendererMode} />;
 *   }
 *   return <MarkdownRenderer content={message.content.text} />;
 */
export function useStreamingMessage(message: MessageNode): StreamingMessageState {
  const requestId = message.generation?.requestId ?? null;
  const streamStatus = useStreamStore((state) =>
    requestId ? state.sessionsByRequestId[requestId]?.status ?? null : null
  );
  const rendererMode = useStreamStore((state) =>
    requestId ? state.sessionsByRequestId[requestId]?.rendererMode ?? "DOM_TEXT" : "DOM_TEXT"
  );

  return useMemo<StreamingMessageState>(() => {
    const isStreaming =
      !!requestId &&
      message.status === "STREAMING" &&
      (streamStatus === "STARTING" || streamStatus === "STREAMING");

    return {
      isStreaming,
      requestId: requestId ?? null,
      rendererMode,
      streamStatus,
      // Streaming text is rendered imperatively; React does not need a
      // high-frequency visible-char subscription anymore.
      visibleCharCount: 0,
    };
  }, [message.status, rendererMode, requestId, streamStatus]);
}
