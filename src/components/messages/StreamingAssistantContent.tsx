/**
 * @file StreamingAssistantContent.tsx
 * @description Component that renders streaming text using an imperative surface.
 *
 * THIS COMPONENT DOES NOT RE-RENDER ON EVERY TOKEN.
 *
 * How it works:
 *   1. Creates a div ref (container)
 *   2. On mount, passes the container to attachSurfaceToRequest()
 *   3. streamController attaches an ImperativeTextSurface to the container
 *   4. Subsequent chunks are written directly to the DOM TextNode
 *      via surface.append() / surface.replaceAll()
 *   5. React is COMPLETELY BYPASSED during token streaming
 *   6. When stream completes, this component unmounts and
 *      AssistantMessageBubble switches to MarkdownRenderer
 *
 * Re-render triggers (intentionally minimal):
 *   - requestId changes (new stream)
 *   - rendererMode changes (unlikely mid-stream)
 *   - Component mount/unmount
 *
 * NOT triggered by:
 *   - Individual tokens
 *   - Imperative surface flushes
 *   - Chunk counters or other runtime-only diagnostics
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { attachSurfaceToRequest } from "../../services/streamController";

interface StreamingAssistantContentProps {
  /** The request ID of the active stream */
  requestId: string;

  /** Which rendering mode to use */
  rendererMode: "PRETEXT" | "DOM_TEXT";
}

/**
 * Renders a container for the imperative text surface.
 * Text content is managed entirely outside of React.
 */
export function StreamingAssistantContent({
  requestId,
  rendererMode,
}: StreamingAssistantContentProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Attach the imperative surface to this container.
    // This is the ONLY interaction point between React and the streaming surface.
    // After this call, all text updates happen via surface.append()/replaceAll(),
    // which directly modify the DOM TextNode — React reconciliation is bypassed.
    attachSurfaceToRequest(requestId, container, rendererMode);

    // Cleanup: surface is destroyed by streamController when stream completes.
    // No explicit cleanup needed here because:
    //   - completeStream() calls deleteRuntimeSession() which destroys the surface
    //   - When this component unmounts, the container div is removed from DOM
    //   - The surface's destroy() is idempotent
  }, [requestId, rendererMode]);

  return (
    <div
      ref={containerRef}
      className="streaming-surface whitespace-pre-wrap break-words font-mono text-sm"
      data-request-id={requestId}
      aria-live="polite"
      aria-label={t("message.generating")}
    />
  );
}
