/**
 * @file useStreamStore.ts
 * @description Zustand store for stream session metadata only.
 *
 * This store is intentionally separated from useAppStore because:
 * 1. Stream updates have very different frequency characteristics
 * 2. React components subscribe to stream status independently
 * 3. It avoids bloating the main store with rapid micro-updates
 *
 * What goes HERE (serializable, low-frequency):
 *   - StreamSessionMeta (status, chunkCount, visibleVersion)
 *   - RequestId ↔ MessageId mapping
 *
 * What does NOT go here:
 *   - StreamRuntimeSession (chunks, surface, flushTimer) → streamRuntimeRegistry.ts
 *   - DOM references → React refs
 *   - Pretext instances → surface adapter layer
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

import type { MessageId, RequestId } from "../types/base";
import type { StreamError, StreamSessionMeta } from "../types/stream";

// ============================================================================
// Store Interface
// ============================================================================

interface StreamStore {
  /** Stream session metadata indexed by requestId */
  sessionsByRequestId: Record<RequestId, StreamSessionMeta>;

  /** Reverse mapping: which requestId is handling a given message */
  requestIdByMessageId: Record<MessageId, RequestId>;

  // --- Actions ---

  /** Create a new stream session */
  createSession: (meta: StreamSessionMeta) => void;

  /** Patch specific fields of an existing session */
  patchSession: (requestId: RequestId, patch: Partial<StreamSessionMeta>) => void;

  /** Mark a session as completed */
  completeSession: (requestId: RequestId) => void;

  /** Mark a session as failed with error details */
  failSession: (requestId: RequestId, error: StreamError) => void;

  /** Remove a session (typically after a delay post-completion) */
  removeSession: (requestId: RequestId) => void;
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useStreamStore = create<StreamStore>()(
  devtools(
    (set) => ({
      sessionsByRequestId: {},
      requestIdByMessageId: {},

      createSession: (meta) =>
        set(
          (state) => ({
            sessionsByRequestId: {
              ...state.sessionsByRequestId,
              [meta.requestId]: meta,
            },
            requestIdByMessageId: {
              ...state.requestIdByMessageId,
              [meta.targetMessageId]: meta.requestId,
            },
          }),
          undefined,
          "stream/sessionCreated"
        ),

      patchSession: (requestId, patch) =>
        set(
          (state) => {
            const existing = state.sessionsByRequestId[requestId];
            if (!existing) return state;

            return {
              sessionsByRequestId: {
                ...state.sessionsByRequestId,
                [requestId]: {
                  ...existing,
                  ...patch,
                },
              },
            };
          },
          undefined,
          "stream/sessionPatched"
        ),

      completeSession: (requestId) =>
        set(
          (state) => {
            const existing = state.sessionsByRequestId[requestId];
            if (!existing) return state;

            return {
              sessionsByRequestId: {
                ...state.sessionsByRequestId,
                [requestId]: {
                  ...existing,
                  status: "COMPLETED",
                },
              },
            };
          },
          undefined,
          "stream/sessionCompleted"
        ),

      failSession: (requestId, error) =>
        set(
          (state) => {
            const existing = state.sessionsByRequestId[requestId];
            if (!existing) return state;

            return {
              sessionsByRequestId: {
                ...state.sessionsByRequestId,
                [requestId]: {
                  ...existing,
                  status: "FAILED",
                  error,
                },
              },
            };
          },
          undefined,
          "stream/sessionFailed"
        ),

      removeSession: (requestId) =>
        set(
          (state) => {
            const targetMessageId =
              state.sessionsByRequestId[requestId]?.targetMessageId;

            const nextSessions = { ...state.sessionsByRequestId };
            delete nextSessions[requestId];

            const nextMap = { ...state.requestIdByMessageId };
            if (targetMessageId) delete nextMap[targetMessageId];

            return {
              sessionsByRequestId: nextSessions,
              requestIdByMessageId: nextMap,
            };
          },
          undefined,
          "stream/sessionRemoved"
        ),
    }),
    { name: "StreamStore" }
  )
);
