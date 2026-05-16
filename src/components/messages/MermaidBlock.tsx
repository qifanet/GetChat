/**
 * @file MermaidBlock.tsx
 * @description Renders a Mermaid diagram from source code into an SVG.
 *
 * - Dynamically imports `mermaid` only when a mermaid code block is present.
 * - Caches the rendered SVG in component state to avoid re-renders.
 * - Falls back to raw code + error message on parse failure.
 */
import { useState, useEffect, useRef, memo } from "react";
import { useTranslation } from "react-i18next";

interface MermaidBlockProps {
  code: string;
}

function cleanupMermaidErrorElements() {
  // Mermaid appends temporary div/svg to document.body when rendering.
  // IDs follow patterns: d{id}, {id} (svg), i{id} (iframe for sandbox mode)
  document.querySelectorAll("body > div[id^='dmermaid-']").forEach((el) => el.remove());
  document.querySelectorAll("body > svg[id^='mermaid-']").forEach((el) => el.remove());
  document.querySelectorAll("body > iframe[id^='imermaid-']").forEach((el) => el.remove());
  document.querySelectorAll("body > .mermaidTooltip").forEach((el) => el.remove());
}

export const MermaidBlock = memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const { t } = useTranslation();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${crypto.randomUUID()}`);
  const offscreenRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      // Create an offscreen container so Mermaid never touches document.body
      const offscreen = document.createElement("div");
      offscreen.style.position = "absolute";
      offscreen.style.left = "-9999px";
      offscreen.style.top = "-9999px";
      offscreen.style.visibility = "hidden";
      document.body.appendChild(offscreen);
      offscreenRef.current = offscreen;

      try {
        const mermaid = await import("mermaid");
        mermaid.default.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "loose",
          fontFamily: '"Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        });

        const id = idRef.current;
        const { svg: renderedSvg } = await mermaid.default.render(id, code, offscreen);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg(null);
        }
      } finally {
        offscreen.remove();
        offscreenRef.current = null;
        cleanupMermaidErrorElements();
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    renderDiagram();
    return () => {
      cancelled = true;
      offscreenRef.current?.remove();
      offscreenRef.current = null;
      cleanupMermaidErrorElements();
    };
  }, [code]);

  if (loading) {
    return (
      <div className="my-4 flex items-center gap-2 rounded-2xl border border-miro-border/20 bg-[#f6f7fb] px-4 py-6">
        <svg
          className="h-4 w-4 animate-spin text-miro-blue"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span className="text-sm text-miro-text-secondary">
          {t("markdown.renderingDiagram")}
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="my-4 overflow-hidden rounded-2xl border border-miro-red/20 bg-miro-red-light/40">
        <div className="flex items-center gap-2 border-b border-miro-red/10 px-4 py-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-miro-red"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span className="font-mono text-[11px] font-medium text-miro-red">
            {t("markdown.mermaidError")}
          </span>
        </div>
        {error && (
          <div className="border-b border-miro-red/10 px-4 py-1.5">
            <p className="break-words font-mono text-[11px] leading-relaxed text-miro-red/80">
              {error.length > 300 ? error.slice(0, 300) + "..." : error}
            </p>
          </div>
        )}
        <pre className="overflow-x-auto p-4 text-sm text-miro-text-secondary">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-4 overflow-x-auto rounded-2xl border border-miro-border/20 bg-[#f6f7fb] p-4"
    >
      <div
        className="mermaid-output [&>svg]:mx-auto [&>svg]:max-w-full [&>svg]:h-auto"
        dangerouslySetInnerHTML={{ __html: svg ?? "" }}
      />
    </div>
  );
});
