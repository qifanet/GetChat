/**
 * @file taskStreamBridge.ts
 * @description Bridges backend task-worker streams into the frontend stream
 * rendering pipeline (v1.5.0 M4.5).
 *
 * The task scheduler drives full agent streams server-side (M4.4) and emits:
 *   - `task_stream_event`   — { context: TaskStreamContext, event: ModelStreamEvent }
 *   - `task_queue_changed`  — { taskId } on task status transitions
 *
 * This module is the single subscriber. Stream events are fed into the same
 * `handleModelStreamEvent` pipeline as interactive streams after lazily
 * creating a TASK_WORKER session for the request, so AssistantMessageBubble /
 * StreamingAssistantContent render worker streams identically — including
 * tool calls, injections, and approvals. Persistence stays server-side; the
 * frontend only reflects state.
 *
 * Queue-change notifications fan out to `taskQueueListeners` (TaskQueuePanel
 * subscribes to refresh its list instead of fixed-interval polling).
 */

import type { ModelStreamEvent } from "./tauriTypes";
import { shouldUseBrowserDebugRuntime } from "./browserDebugRuntime";
import {
  ensureWorkerStreamSession,
  handleModelStreamEvent,
} from "./streamController";

/** Envelope the scheduler attaches to every forwarded stream event. */
export interface TaskStreamContext {
  taskId: string;
  conversationId: string;
  branchId: string;
  requestId: string;
  assistantMessageId: string;
}

export interface TaskStreamEventPayload {
  context: TaskStreamContext;
  event: ModelStreamEvent;
}

export type TaskQueueChangeListener = () => void;

let initialized = false;
let initPromise: Promise<void> | null = null;
const taskQueueListeners = new Set<TaskQueueChangeListener>();

/** Subscribe to task-queue change notifications (panel refresh). */
export function onTaskQueueChanged(listener: TaskQueueChangeListener): () => void {
  taskQueueListeners.add(listener);
  return () => {
    taskQueueListeners.delete(listener);
  };
}

function notifyTaskQueueListeners(): void {
  for (const listener of taskQueueListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[taskBridge] listener failed:", error);
    }
  }
}

async function handleTaskStreamEvent(payload: TaskStreamEventPayload): Promise<void> {
  const { context, event } = payload;
  if (!context?.requestId || !event) {
    console.warn("[taskBridge] malformed task stream event payload:", payload);
    return;
  }
  ensureWorkerStreamSession({
    requestId: context.requestId,
    conversationId: context.conversationId,
    branchId: context.branchId,
    targetMessageId: context.assistantMessageId,
  });
  await handleModelStreamEvent(event);
}

/**
 * Subscribe once to task scheduler emissions. Safe to call repeatedly (e.g.
 * from App and TaskQueuePanel effects) — only the first call subscribes.
 * In the browser-debug runtime there is no Tauri event API; worker streams
 * simply never fire, matching the mocked backend.
 */
export function ensureTaskStreamBridge(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (shouldUseBrowserDebugRuntime()) return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<TaskStreamEventPayload>("task_stream_event", (event) => {
        void handleTaskStreamEvent(event.payload).catch((error) => {
          console.error("[taskBridge] stream event handling failed:", error);
        });
      });
      await listen<{ taskId: string | null }>("task_queue_changed", () => {
        notifyTaskQueueListeners();
      });
      initialized = true;
      console.info("[taskBridge] subscribed to task scheduler events");
    } catch (error) {
      console.error("[taskBridge] failed to subscribe:", error);
      initPromise = null;
    }
  })();

  return initPromise;
}
