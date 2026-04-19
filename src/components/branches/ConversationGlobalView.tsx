/**
 * @file ConversationGlobalView.tsx
 * @description Full-screen mind-map view of the entire conversation tree.
 *
 * Shows every message as a node with branch-aware layout.
 * Supports pan (drag), zoom (scroll), hover previews, and
 * double-click to navigate into a branch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import {
  selectGlobalView,
  type GlobalViewNode,
  type GlobalViewData,
} from "../../selectors/globalViewSelectors";
import { IconX } from "../common/Icon";
import { getBranchDisplayName } from "../../i18n/displayNames";

const _sel_currentBranchId =
  (s: import("../../stores/appStore.types").AppStore) =>
    s.workspace.currentBranchId;
const _sel_setCurrentBranch =
  (s: import("../../stores/appStore.types").AppStore) => s.setCurrentBranch;

// ============================================================================
// Layout Constants
// ============================================================================

const NODE_W = 160;
const NODE_H = 36;
const H_GAP = 48;
const V_GAP = 16;
const BORDER_RADIUS = 8;

// ============================================================================
// Layout Algorithm (Tidy Tree)
// ============================================================================

interface LayoutNode {
  node: GlobalViewNode;
  x: number;
  y: number;
  width: number; // subtree width
}

function layoutTree(roots: GlobalViewNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];

  function measureSubtreeWidth(node: GlobalViewNode): number {
    if (node.children.length === 0) return NODE_W;
    const childWidths = node.children.map(measureSubtreeWidth);
    return childWidths.reduce((a, b) => a + b, 0) + H_GAP * (node.children.length - 1);
  }

  function layoutNode(node: GlobalViewNode, x: number, y: number): LayoutNode {
    const subtreeWidth = measureSubtreeWidth(node);
    const layout: LayoutNode = {
      node,
      x: x + subtreeWidth / 2 - NODE_W / 2,
      y,
      width: subtreeWidth,
    };
    result.push(layout);

    if (node.children.length > 0) {
      const childWidths = node.children.map((c) => measureSubtreeWidth(c));
      const totalW = childWidths.reduce((a, b) => a + b, 0) + H_GAP * (node.children.length - 1);
      let cx = x + (subtreeWidth - totalW) / 2;
      for (let i = 0; i < node.children.length; i++) {
        layoutNode(node.children[i], cx, y + NODE_H + V_GAP);
        cx += childWidths[i] + H_GAP;
      }
    }

    return layout;
  }

  // Layout all roots stacked vertically
  let yOff = 0;
  for (const root of roots) {
    const rootWidth = measureSubtreeWidth(root);
    layoutNode(root, 0, yOff);
    yOff += NODE_H + V_GAP * 4; // Extra gap between root trees
  }

  return result;
}

// ============================================================================
// Component
// ============================================================================

interface Props {
  onClose: () => void;
}

export function ConversationGlobalView({ onClose }: Props) {
  const { t } = useTranslation();
  const data = useAppStore(selectGlobalView);
  const currentBranchId = useAppStore(_sel_currentBranchId);
  const setCurrentBranch = useAppStore(_sel_setCurrentBranch);

  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    text: string;
    branchName: string;
    x: number;
    y: number;
  }>({ visible: false, text: "", branchName: "", x: 0, y: 0 });

  // Layout
  const layouts = useMemo(() => layoutTree(data.roots), [data.roots]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (layouts.length === 0) return { w: 800, h: 600 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of layouts) {
      minX = Math.min(minX, l.x);
      minY = Math.min(minY, l.y);
      maxX = Math.max(maxX, l.x + NODE_W);
      maxY = Math.max(maxY, l.y + NODE_H);
    }
    return {
      w: maxX - minX + 200,
      h: maxY - minY + 200,
      offX: -minX + 100,
      offY: -minY + 100,
    };
  }, [layouts]);

  // Non-passive wheel listener (React onWheel is passive, can't preventDefault)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom((z) => Math.max(0.15, Math.min(3, z * delta)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Center on first load
  useEffect(() => {
    if (containerRef.current) {
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      setPan({
        x: cw / 2 - bounds.w / 2,
        y: 40,
      });
      setZoom(Math.min(1, (cw - 40) / bounds.w));
    }
  }, [bounds]);

  // Pan handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  }, [dragging]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  // Double-click navigation
  const handleNodeDoubleClick = useCallback(
    (node: GlobalViewNode) => {
      setCurrentBranch(node.branchId);
      onClose();
    },
    [setCurrentBranch, onClose],
  );

  // Build edges
  const edges = useMemo(() => {
    const result: Array<{ x1: number; y1: number; x2: number; y2: number; isFork: boolean }> = [];
    const nodeMap = new Map<string, LayoutNode>();
    for (const l of layouts) nodeMap.set(l.node.id, l);

    for (const l of layouts) {
      for (const child of l.node.children) {
        const childLayout = nodeMap.get(child.id);
        if (!childLayout) continue;
        result.push({
          x1: l.x + NODE_W / 2,
          y1: l.y + NODE_H,
          x2: childLayout.x + NODE_W / 2,
          y2: childLayout.y,
          isFork: l.node.children.length > 1,
        });
      }
    }
    return result;
  }, [layouts]);

  // Node lookup for tooltip
  const nodeById = useMemo(() => {
    const m = new Map<string, GlobalViewNode>();
    function walk(n: GlobalViewNode) {
      m.set(n.id, n);
      n.children.forEach(walk);
    }
    data.roots.forEach(walk);
    return m;
  }, [data]);

  const handleNodeMouseEnter = useCallback(
    (nodeId: string, e: React.MouseEvent) => {
      const n = nodeById.get(nodeId);
      if (!n) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltip({
        visible: true,
        text: n.preview,
        branchName: data.branchesById[n.branchId]?.name ?? "",
        x: e.clientX - rect.left + 16,
        y: e.clientY - rect.top - 12,
      });
    },
    [nodeById, data.branchesById],
  );

  const handleNodeMouseLeave = useCallback(() => {
    setTooltip((t) => ({ ...t, visible: false }));
  }, []);

  // Reset zoom
  const handleFitView = useCallback(() => {
    if (!containerRef.current) return;
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    const scaleX = (cw - 40) / bounds.w;
    const scaleY = (ch - 120) / bounds.h;
    const z = Math.min(scaleX, scaleY, 1);
    setZoom(z);
    setPan({
      x: (cw - bounds.w * z) / 2,
      y: (ch - 80 - bounds.h * z) / 2 + 40,
    });
  }, [bounds]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex flex-col bg-miro-surface-high backdrop-blur-xl">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-miro-border/10 px-6 py-4">
        <div className="flex items-center gap-4">
          <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
            {t("globalView.title")}
          </h2>
          <span className="text-[11px] text-miro-text-secondary">
            {t("globalView.stats", {
              messages: data.messageCount,
              branches: data.branchCount,
            })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleFitView}
            className="app-secondary-button px-3 py-1.5 text-xs"
          >
            {t("globalView.fitView")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="app-icon-button h-8 w-8"
          >
            <IconX size={14} />
          </button>
        </div>
      </div>

      {/* Hint */}
      <div className="px-6 py-2">
        <p className="text-[10px] text-miro-text-secondary">
          {t("globalView.hint")}
        </p>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Tooltip */}
        {tooltip.visible && (
          <div
            className="pointer-events-none absolute z-50 max-w-[300px] rounded-lg bg-miro-text px-3 py-2 text-[11px] leading-relaxed text-white shadow-lg"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            {tooltip.branchName && (
              <p className="mb-1 text-[10px] font-medium text-miro-blue-light">
                {tooltip.branchName}
              </p>
            )}
            <p className="line-clamp-4">{tooltip.text || t("globalView.emptyMessage")}</p>
          </div>
        )}

        <svg
          width={bounds.w}
          height={bounds.h}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          <defs>
            <clipPath id="nodeClip">
              <rect x={0} y={0} width={NODE_W - 4} height={NODE_H} rx={2} />
            </clipPath>
          </defs>
          {/* Edges */}
          {edges.map((edge, i) => (
            <path
              key={i}
              d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.y1 + V_GAP * 1.5}, ${edge.x2} ${edge.y2 - V_GAP * 1.5}, ${edge.x2} ${edge.y2}`}
              fill="none"
              stroke={edge.isFork ? "#5b76fe" : "#d1d5db"}
              strokeWidth={edge.isFork ? 1.5 : 1}
              strokeOpacity={edge.isFork ? 0.6 : 0.4}
            />
          ))}

          {/* Nodes */}
          {layouts.map((l) => {
            const n = l.node;
            const isUser = n.role === "USER";
            const isSystem = n.role === "SYSTEM";
            const isCurrentBranch = n.branchId === currentBranchId;
            const hasForks = n.forkBranches.length > 0;
            const nodeFill = isUser ? "#eef1ff" : isSystem ? "#fff4e5" : "#edfcf2";
            const nodeStroke = isUser ? "#c7d2fe" : isSystem ? "#fbcf8b" : "#bbf7d0";
            const roleColor = isUser ? "#5b76fe" : isSystem ? "#d97706" : "#16a34a";
            const roleLabel = isUser ? "U" : isSystem ? "S" : "A";

            return (
              <g
                key={n.id}
                transform={`translate(${l.x}, ${l.y})`}
                onMouseEnter={(e) => handleNodeMouseEnter(n.id, e)}
                onMouseLeave={handleNodeMouseLeave}
                onDoubleClick={() => handleNodeDoubleClick(n)}
                style={{ cursor: "pointer" }}
              >
                {/* Node background */}
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={BORDER_RADIUS}
                  fill={nodeFill}
                  stroke={
                    isCurrentBranch
                      ? "#5b76fe"
                      : hasForks
                        ? "#5b76fe"
                        : nodeStroke
                  }
                  strokeWidth={isCurrentBranch ? 1.5 : 1}
                />

                {/* Role badge */}
                <text
                  x={8}
                  y={NODE_H / 2}
                  dominantBaseline="central"
                  fontSize={10}
                  fontWeight={600}
                  fill={roleColor}
                >
                  {roleLabel}
                </text>

                {/* Label text with clip to prevent overflow */}
                <g clipPath="url(#nodeClip)">
                <text
                  x={24}
                  y={NODE_H / 2}
                  dominantBaseline="central"
                  fontSize={10}
                  fill="#1c1c1e"
                >
                  {n.label.length > 14 ? n.label.slice(0, 14) + "…" : n.label || t("globalView.emptyMessage")}
                </text>

                </g>
                {/* Fork indicator */}
                {hasForks && (
                  <circle
                    cx={NODE_W - 8}
                    cy={NODE_H / 2}
                    r={4}
                    fill="#5b76fe"
                    opacity={0.6}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>,
    document.body,
  );
}
