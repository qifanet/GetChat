/**
 * @file streamRuntimeRegistry.ts
 * @description Non-serializable runtime registry for active stream sessions.
 *
 * *** THIS IS NOT A ZUSTAND STORE ***
 * *** THIS MUST NEVER BE IMPORTED INTO REACT COMPONENTS DIRECTLY ***
 *
 * This module stores:
 *   - Stream chunk buffers (string[])
 *   - ImperativeTextSurface instances (DOM/pretext)
 *   - Flush timers
 *
 * These are NOT serializable and MUST NOT enter Zustand or React state.
 * Only the streamController.ts service layer should interact with this registry.
 *
 * React components access streaming state through:
 *   - useStreamStore (for metadata)
 *   - StreamingAssistantContent (for surface mounting, via streamController)
 */

import type { RequestId } from "../types/base";
import type { StreamRuntimeSession } from "../types/stream";

/** Internal registry: Map of requestId → runtime session */
const registry = new Map<RequestId, StreamRuntimeSession>();

/**
 * Get a runtime session by requestId.
 * Returns null if not found.
 */
export function getRuntimeSession(requestId: RequestId): StreamRuntimeSession | null {
  return registry.get(requestId) ?? null;
}

/**
 * Register a new runtime session.
 * Called by streamController when a stream starts.
 */
export function setRuntimeSession(session: StreamRuntimeSession): void {
  registry.set(session.requestId, session);
}

/**
 * Remove and clean up a runtime session.
 * - Clears any pending flush timer
 * - Destroys the imperative text surface
 * - Removes from registry
 */
export function deleteRuntimeSession(requestId: RequestId): void {
  const session = registry.get(requestId);
  if (!session) return;

  if (session.flushTimer !== null) {
    clearTimeout(session.flushTimer);
  }

  session.surface?.destroy();
  registry.delete(requestId);
}

/**
 * Check if a runtime session exists for a given requestId.
 */
export function hasRuntimeSession(requestId: RequestId): boolean {
  return registry.has(requestId);
}

/**
 * Get the number of active runtime sessions.
 * Useful for diagnostics.
 */
export function getActiveStreamCount(): number {
  return registry.size;
}
