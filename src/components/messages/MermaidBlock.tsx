/**
 * @file MermaidBlock.tsx
 * @description Renders a Mermaid diagram with fullscreen zoom/pan viewer.
 *
 * Inline: static render with hover toolbar (fullscreen button only).
 * Fullscreen: overlay via createPortal covering the entire app window,
 * with mouse-wheel zoom, drag-to-pan, and Escape to close.
 */
import { useState, useEffect, useRef, memo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useThemeStore } from "../../stores/useThemeStore";
import { isDarkThemeMode } from "../../utils/mediaQuery";

interface MermaidBlockProps {
  code: string;
}

function cleanupMermaidErrorElements() {
  document.querySelectorAll("body > div[id^='dmermaid-']").forEach((el) => el.remove());
  document.querySelectorAll("body > svg[id^='mermaid-']").forEach((el) => el.remove());
  document.querySelectorAll("body > iframe[id^='imermaid-']").forEach((el) => el.remove());
  document.querySelectorAll("body > .mermaidTooltip").forEach((el) => el.remove());
}

export const MermaidBlock = memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const { t } = useTranslation();
  const themeMode = useThemeStore((s) => s.mode);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const idRef = useRef(`mermaid-${crypto.randomUUID()}`);
  const offscreenRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      const offscreen = document.createElement("div");
      offscreen.style.position = "absolute";
      offscreen.style.left = "-9999px";
      offscreen.style.top = "-9999px";
      offscreen.style.visibility = "hidden";
      document.body.appendChild(offscreen);
      offscreenRef.current = offscreen;

      try {
        const isDark = isDarkThemeMode(themeMode);
        const mermaid = await import("mermaid");
        mermaid.default.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "default",
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
  }, [code, themeMode]);

  const openFullscreen = useCallback(() => setFullscreen(true), []);
  const closeFullscreen = useCallback(() => setFullscreen(false), []);

  if (loading) {
    return (
      <div className="my-4 flex items-center gap-2 rounded-2xl border border-miro-border/20 bg-miro-surface-low px-4 py-6">
        <svg className="h-4 w-4 animate-spin text-miro-blue" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm text-miro-text-secondary">{t("markdown.renderingDiagram")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="my-4 overflow-hidden rounded-2xl border border-miro-red/20 bg-miro-red-light/40">
        <div className="flex items-center gap-2 border-b border-miro-red/10 px-4 py-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-miro-red">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span className="font-mono text-[11px] font-medium text-miro-red">{t("markdown.mermaidError")}</span>
        </div>
        <div className="border-b border-miro-red/10 px-4 py-1.5">
          <p className="wrap-break-word font-mono text-[11px] leading-relaxed text-miro-red/80">
            {error.length > 300 ? error.slice(0, 300) + "..." : error}
          </p>
        </div>
        <pre className="overflow-x-auto p-4 text-sm text-miro-text-secondary"><code>{code}</code></pre>
      </div>
    );
  }

  return (
    <>
      {/* Inline preview — no zoom/pan, just a fullscreen button */}
      <div className="group/diagram my-4 overflow-hidden rounded-2xl border border-miro-border/20 bg-miro-surface-low">
        <div className="flex items-center justify-end border-b border-miro-border/10 px-3 py-1.5 opacity-0 transition-opacity group-hover/diagram:opacity-100">
          <button
            onClick={openFullscreen}
            type="button"
            title={t("markdown.fullscreen")}
            className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] text-miro-text-tertiary transition-colors hover:bg-miro-border/10 hover:text-miro-text-primary"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
            {t("markdown.fullscreen")}
          </button>
        </div>
        <div className="overflow-x-auto p-4">
          <div
            className="mermaid-output [&>svg]:mx-auto [&>svg]:max-w-full [&>svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: svg ?? "" }}
          />
        </div>
      </div>

      {/* Fullscreen overlay via portal */}
      {fullscreen && createPortal(
        <FullscreenDiagram svg={svg ?? ""} onClose={closeFullscreen} />,
        document.body,
      )}
    </>
  );
});

// ============================================================================
// Fullscreen Overlay
// ============================================================================

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

function FullscreenDiagram({ svg, onClose }: { svg: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Prevent body scroll when overlay is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Mouse wheel zoom (only when cursor is inside the canvas)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((prev) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * factor)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Only start drag from the canvas area, not the header
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    translateStart.current = { ...translate };
  }, [translate]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setTranslate({
      x: translateStart.current.x + (e.clientX - dragStart.current.x),
      y: translateStart.current.y + (e.clientY - dragStart.current.y),
    });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const resetView = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col bg-miro-surface-high">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-miro-border/10 bg-miro-card px-4 py-2.5 shadow-xs">
        <span className="text-xs font-medium text-miro-text-secondary">
          {t("markdown.diagramView")}
        </span>
        <div className="flex items-center gap-1">
          <ToolBtn onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.25))}>
            <ZoomInIcon />
          </ToolBtn>
          <span className="min-w-14 text-center text-[10px] tabular-nums text-miro-text-tertiary">
            {Math.round(scale * 100)}%
          </span>
          <ToolBtn onClick={() => setScale((s) => Math.max(MIN_SCALE, s / 1.25))}>
            <ZoomOutIcon />
          </ToolBtn>
          <ToolBtn onClick={resetView}>
            <ResetIcon />
          </ToolBtn>
          <div className="mx-1.5 h-4 w-px bg-miro-border/20" />
          <ToolBtn onClick={onClose}>
            <CloseIcon />
          </ToolBtn>
        </div>
      </div>

      {/* Canvas */}
      <div
        className="flex-1 cursor-grab overflow-hidden bg-miro-surface-low active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          className="flex h-full w-full items-center justify-center"
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: isDragging ? "none" : "transform 0.15s ease",
          }}
        >
          <div
            className="mermaid-output [&>svg]:mx-auto [&>svg]:max-w-none [&>svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-miro-border/10 bg-miro-card px-4 py-1.5 text-center">
        <span className="text-[10px] text-miro-text-tertiary">{t("markdown.diagramHint")}</span>
      </div>
    </div>
  );
}

// ============================================================================
// Tiny icon buttons
// ============================================================================

function ToolBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      type="button"
      className="flex h-7 w-7 items-center justify-center rounded-md text-miro-text-tertiary transition-colors hover:bg-miro-border/10 hover:text-miro-text-primary"
    >
      {children}
    </button>
  );
}

function ZoomInIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></svg>;
}

function ZoomOutIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></svg>;
}

function ResetIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>;
}

function CloseIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
}
