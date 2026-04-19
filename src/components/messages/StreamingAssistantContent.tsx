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
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { attachSurfaceToRequest } from "../../services/streamController";
interface StreamingAssistantContentProps {
  requestId: string;
  rendererMode: "PRETEXT" | "DOM_TEXT";
}
export function StreamingAssistantContent({
  requestId,
  rendererMode,
}: StreamingAssistantContentProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    attachSurfaceToRequest(requestId, container, rendererMode);
  }, [requestId, rendererMode]);
  return (
    <div
      ref={containerRef}
      className="streaming-surface streaming-caret whitespace-pre-wrap break-words font-mono text-sm"
      data-request-id={requestId}
      aria-live="polite"
      aria-label={t("message.generating")}
    />
  );
}
