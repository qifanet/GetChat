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
import { useThemeStore } from "../../stores/useThemeStore";
import { isDarkThemeMode } from "../../utils/mediaQuery";
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
  const transformRef = useRef({ x: 0, y: 0, zoom: 1 });
  transformRef.current = { x: pan.x, y: pan.y, zoom };
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Management mode state
  const [managementMode, setManagementMode] = useState(false);
  const [selectedBranchIds, setSelectedBranchIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    text: string;
    branchName: string;
    x: number;
    y: number;
  }>({ visible: false, text: "", branchName: "", x: 0, y: 0 });

  const themeMode = useThemeStore((s) => s.mode);
  const isDark = isDarkThemeMode(themeMode);

  // Theme-aware SVG palette
  const svgPalette = useMemo(() => isDark ? {
    edgeNormal: "#3d444d",
    edgeFork: "#818cf8",
    nodeFillUser: "rgba(99, 102, 241, 0.12)",
    nodeFillSystem: "rgba(210, 153, 34, 0.12)",
    nodeFillAssistant: "rgba(63, 185, 80, 0.12)",
    nodeStrokeUser: "rgba(129, 140, 248, 0.35)",
    nodeStrokeSystem: "rgba(210, 153, 34, 0.35)",
    nodeStrokeAssistant: "rgba(63, 185, 80, 0.35)",
    roleUser: "#818cf8",
    roleSystem: "#d29922",
    roleAssistant: "#3fb950",
    labelText: "#e6edf3",
    selectStroke: "#f85149",
    selectFill: "rgba(248, 81, 73, 0.12)",
    branchBadge: "#818cf8",
  } : {
    edgeNormal: "#d1d5db",
    edgeFork: "#5b76fe",
    nodeFillUser: "#eef1ff",
    nodeFillSystem: "#fff4e5",
    nodeFillAssistant: "#edfcf2",
    nodeStrokeUser: "#c7d2fe",
    nodeStrokeSystem: "#fbcf8b",
    nodeStrokeAssistant: "#bbf7d0",
    roleUser: "#5b76fe",
    roleSystem: "#d97706",
    roleAssistant: "#16a34a",
    labelText: "#1c1c1e",
    selectStroke: "#ef4444",
    selectFill: "#fee2e2",
    branchBadge: "#5b76fe",
  }, [isDark]);

  // Layout
  const layouts = useMemo(() => layoutTree(data.roots), [data.roots]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (layouts.length === 0) return { w: 800, h: 600, contentW: 800, contentH: 600, cx: 400, cy: 300 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of layouts) {
      minX = Math.min(minX, l.x);
      minY = Math.min(minY, l.y);
      maxX = Math.max(maxX, l.x + NODE_W);
      maxY = Math.max(maxY, l.y + NODE_H);
    }
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    return {
      w: contentW + 200,
      h: contentH + 200,
      contentW,
      contentH,
      // Tree center in raw layout coords (SVG doesn't shift nodes, just adds empty padding)
      cx: minX + contentW / 2,
      cy: minY + contentH / 2,
    };
  }, [layouts]);

  // Non-passive wheel listener (React onWheel is passive, can't preventDefault)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const t = transformRef.current;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.15, Math.min(3, t.zoom * delta));
      const ratio = newZoom / t.zoom;

      const newTransform = {
        x: mouseX - (mouseX - t.x) * ratio,
        y: mouseY - (mouseY - t.y) * ratio,
        zoom: newZoom,
      };
      transformRef.current = newTransform;
      setPan({ x: newTransform.x, y: newTransform.y });
      setZoom(newZoom);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Center on first load
  useEffect(() => {
    if (containerRef.current) {
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      const z = Math.min(1, (cw - 40) / bounds.contentW);
      const newPan = {
        x: cw / 2 - bounds.cx * z,
        y: ch / 2 - bounds.cy * z,
      };
      transformRef.current = { x: newPan.x, y: newPan.y, zoom: z };
      setPan(newPan);
      setZoom(z);
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
    const scaleX = (cw - 40) / bounds.contentW;
    const scaleY = (ch - 120) / bounds.contentH;
    const z = Math.min(scaleX, scaleY, 1);
    const newPan = {
      x: cw / 2 - bounds.cx * z,
      y: ch / 2 - bounds.cy * z,
    };
    transformRef.current = { x: newPan.x, y: newPan.y, zoom: z };
    setPan(newPan);
    setZoom(z);
  }, [bounds]);

  // Management mode: click node to toggle branch selection
  const handleNodeClickManage = useCallback(
    (node: GlobalViewNode) => {
      if (!managementMode) return;
      const branchId = node.branchId;
      const branch = data.branchesById[branchId];
      if (!branch || branch.isMainline) return; // Cannot select mainline

      setSelectedBranchIds((prev) => {
        const next = new Set(prev);
        if (next.has(branchId)) {
          next.delete(branchId);
        } else {
          next.add(branchId);
        }
        return next;
      });
    },
    [managementMode, data.branchesById],
  );

  // Delete selected branches
  const handleDeleteSelected = useCallback(async () => {
    if (selectedBranchIds.size === 0) return;
    const branchNames = [...selectedBranchIds]
      .map((id) => data.branchesById[id]?.name ?? id)
      .join(", ");

    const { confirmDialog } = await import("../common/confirmDialog");
    const confirmed = await confirmDialog({
      message: t("globalView.confirmDelete", { branches: branchNames }),
      destructive: true,
    });
    if (!confirmed) return;

    setDeleting(true);
    try {
      const tauriCmd = await import("../../services/tauriCommands");
      for (const branchId of selectedBranchIds) {
        // Backend cascade-deletes child branches, so some may already be gone
        try {
          await tauriCmd.deleteBranch(branchId);
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("NOT_FOUND"))) {
            throw e;
          }
        }
      }
      setSelectedBranchIds(new Set());
      const { useAppStore: getStore } = await import("../../stores/useAppStoreSelector");
      const store = getStore.getState();
      if (store.workspace.activeConversationId) {
        await store.openConversation(store.workspace.activeConversationId);
      }
    } catch (err) {
      console.error("[globalView] delete failed:", err);
    } finally {
      setDeleting(false);
    }
  }, [selectedBranchIds, data.branchesById, t]);

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
            onClick={() => {
              setManagementMode((m) => !m);
              setSelectedBranchIds(new Set());
            }}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              managementMode
                ? "bg-miro-red text-white hover:bg-miro-red"
                : "app-secondary-button"
            }`}
          >
            {managementMode ? t("globalView.exitManage") : t("globalView.manageMode")}
          </button>
          {managementMode && selectedBranchIds.size > 0 && (
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleDeleteSelected()}
              className="rounded-md bg-miro-red px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-miro-red disabled:opacity-50"
            >
              {deleting
                ? t("globalView.deleting")
                : t("globalView.deleteSelected", { count: selectedBranchIds.size })}
            </button>
          )}
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
              stroke={edge.isFork ? svgPalette.edgeFork : svgPalette.edgeNormal}
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
            const isSelected = managementMode && selectedBranchIds.has(n.branchId);
            const nodeFill = isUser ? svgPalette.nodeFillUser : isSystem ? svgPalette.nodeFillSystem : svgPalette.nodeFillAssistant;
            const nodeStroke = isUser ? svgPalette.nodeStrokeUser : isSystem ? svgPalette.nodeStrokeSystem : svgPalette.nodeStrokeAssistant;
            const roleColor = isUser ? svgPalette.roleUser : isSystem ? svgPalette.roleSystem : svgPalette.roleAssistant;
            const roleLabel = isUser ? "U" : isSystem ? "S" : "A";

            return (
              <g
                key={n.id}
                transform={`translate(${l.x}, ${l.y})`}
                onMouseEnter={(e) => handleNodeMouseEnter(n.id, e)}
                onMouseLeave={handleNodeMouseLeave}
                onDoubleClick={managementMode ? undefined : () => handleNodeDoubleClick(n)}
                onClick={managementMode ? () => handleNodeClickManage(n) : undefined}
                style={{ cursor: managementMode ? "pointer" : "pointer" }}
              >
                {/* Selection highlight in management mode */}
                {managementMode && isSelected && (
                  <rect
                    x={-3}
                    y={-3}
                    width={NODE_W + 6}
                    height={NODE_H + 6}
                    rx={BORDER_RADIUS + 2}
                    fill="none"
                    stroke={svgPalette.selectStroke}
                    strokeWidth={2}
                    strokeDasharray="4 2"
                    opacity={0.8}
                  />
                )}
                {/* Node background */}
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={BORDER_RADIUS}
                  fill={managementMode && isSelected ? svgPalette.selectFill : nodeFill}
                  stroke={
                    managementMode && isSelected
                      ? svgPalette.selectStroke
                      : isCurrentBranch
                        ? svgPalette.edgeFork
                        : hasForks
                          ? svgPalette.edgeFork
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
                  fill={svgPalette.labelText}
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
                    fill={svgPalette.branchBadge}
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
