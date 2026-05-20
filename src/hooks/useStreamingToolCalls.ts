/**
 * @file useStreamingToolCalls.ts
 * @description Hook that provides tool call info during ReAct Loop streaming.
 *
 * Reads tool call data from the runtime registry (non-React) and subscribes
 * to visibleVersion changes in useStreamStore for re-render triggers.
 */

import { useMemo } from "react";
import { useStreamStore } from "../stores/useStreamStore";
import { getRuntimeSession } from "../services/streamRuntimeRegistry";
import type { ToolCallInfo } from "../types/conversation";

/**
 * Get the current tool calls for a streaming request.
 *
 * Re-renders when visibleVersion changes (bumped by streamController
 * on each TOOL_CALL / TOOL_RESULT event).
 */
export function useStreamingToolCalls(requestId: string | null): ToolCallInfo[] {
  // Subscribe to visibleVersion so React re-renders when it changes
  const visibleVersion = useStreamStore((state) =>
    requestId ? state.sessionsByRequestId[requestId]?.visibleVersion ?? 0 : 0
  );

  return useMemo(() => {
    if (!requestId) return [];
    const runtime = getRuntimeSession(requestId);
    // visibleVersion is used as a dep to invalidate the memo
    void visibleVersion;
    return runtime?.toolCalls ?? [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, visibleVersion]);
}
