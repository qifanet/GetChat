/**
 * @file BranchPanel.tsx
 * @description Recursive branch tree panel for the right rail.
 *
 * Displays the full branch hierarchy as a flat indented tree.
 * Mainline at root, child branches indented below their source.
 * Double-click a branch node to navigate to it.
 * Hover shows a tooltip with the branch's head message preview.
 */
import { useState, useCallback, useRef, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import {
  selectBranchTree,
  type BranchTreeNode,
} from "../../selectors/branchSelectors";
import { BranchHealthCard } from "./BranchHealthCard";
import { ConversationGlobalView } from "./ConversationGlobalView";
import {
  IconChevronDown,
  IconChevronUp,
  IconColumns,
  IconPencilSquare,
  IconArchive,
  IconStarOutline,
  IconRotateCcw,
} from "../common/Icon";
import { getBranchDisplayName } from "../../i18n/displayNames";
import type { BranchId } from "../../types/base";
import type { BranchEntity } from "../../types/conversation";

const _sel_currentBranchId =
  (s: import("../../stores/appStore.types").AppStore) =>
    s.workspace.currentBranchId;
const _sel_enterCompare =
  (s: import("../../stores/appStore.types").AppStore) => s.enterCompare;
const _sel_setCurrentBranch =
  (s: import("../../stores/appStore.types").AppStore) => s.setCurrentBranch;
const _sel_renameBranch =
  (s: import("../../stores/appStore.types").AppStore) => s.renameBranch;
const _sel_archiveBranch =
  (s: import("../../stores/appStore.types").AppStore) => s.archiveBranch;
const _sel_unarchiveBranch =
  (s: import("../../stores/appStore.types").AppStore) => s.unarchiveBranch;
const _sel_setMainlineBranch =
  (s: import("../../stores/appStore.types").AppStore) => s.setMainlineBranch;
const _sel_activeConversationId =
  (s: import("../../stores/appStore.types").AppStore) =>
    s.workspace.activeConversationId;

interface TooltipState {
  visible: boolean;
  text: string;
  x: number;
  y: number;
}

export function BranchPanel() {
  const { t } = useTranslation();
  const tree = useAppStore(selectBranchTree);
  const currentBranchId = useAppStore(_sel_currentBranchId);
  const enterCompare = useAppStore(_sel_enterCompare);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [showGlobalView, setShowGlobalView] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState<BranchId[]>([]);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    text: "",
    x: 0,
    y: 0,
  });
  const tooltipTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleToggleSelect = useCallback((branchId: BranchId) => {
    setSelectedForCompare((prev) => {
      if (prev.includes(branchId))
        return prev.filter((id) => id !== branchId);
      if (prev.length >= 2) return [prev[1], branchId];
      return [...prev, branchId];
    });
  }, []);

  const handleEnterCompare = useCallback(() => {
    if (selectedForCompare.length === 2) {
      enterCompare({
        leftBranchId: selectedForCompare[0],
        rightBranchId: selectedForCompare[1],
      });
      setSelectedForCompare([]);
    }
  }, [enterCompare, selectedForCompare]);

  const handleClearSelection = useCallback(
    () => setSelectedForCompare([]),
    [],
  );

  const showTooltip = useCallback(
    (text: string, e: React.MouseEvent) => {
      if (tooltipTimeout.current) clearTimeout(tooltipTimeout.current);
      const rect = panelRef.current?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left + 12 : e.clientX;
      const y = rect ? e.clientY - rect.top - 8 : e.clientY;
      setTooltip({ visible: true, text, x, y });
    },
    [],
  );

  const hideTooltip = useCallback(() => {
    tooltipTimeout.current = setTimeout(() => {
      setTooltip((s) => ({ ...s, visible: false }));
    }, 120);
  }, []);

  // Flatten the tree into rows for rendering
  const rows = tree.root ? flattenTree(tree.root) : [];

  return (
    <div className="flex h-full flex-col" ref={panelRef}>
      {/* Tooltip */}
      {tooltip.visible && (
        <div
          className="pointer-events-none absolute z-50 max-w-[260px] rounded-lg bg-miro-text px-3 py-2 text-[11px] leading-relaxed text-white shadow-lg"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Header */}
      <div className="border-b border-miro-border/10 px-5 py-5">
        <p className="app-section-label mb-1">{t("common.workspace")}</p>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
            {t("branch.panelTitle")}
          </h2>
          <button
            type="button"
            onClick={() => setShowGlobalView(true)}
            className="app-secondary-button gap-1.5 px-2.5 py-1 text-[10px]"
          >
            {t("globalView.openGlobalView")}
          </button>
        </div>
      </div>

      {/* Global view overlay */}
      {showGlobalView && (
        <ConversationGlobalView onClose={() => setShowGlobalView(false)} />
      )}

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {!tree.root ? (
          <p className="py-8 text-center text-sm text-miro-text-secondary">
            {t("branch.noBranches")}
          </p>
        ) : (
          <div className="space-y-0">
            {rows.map((row) => (
              <BranchRow
                key={row.node.branch.id}
                node={row.node}
                depth={row.depth}
                isLast={row.isLast}
                ancestorLines={row.ancestorLines}
                currentBranchId={currentBranchId}
                selectedForCompare={selectedForCompare}
                onToggleSelect={handleToggleSelect}
                onShowTooltip={showTooltip}
                onHideTooltip={hideTooltip}
              />
            ))}

            {/* Archived section */}
            {tree.archived.length > 0 ? (
              <div className="mt-3 border-t border-miro-border/10 pt-3">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-1 text-left"
                  onClick={() => setArchivedExpanded((v) => !v)}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wider text-miro-text-secondary">
                    {t("branch.archivedBranches")} ({tree.archived.length})
                  </span>
                  {archivedExpanded ? (
                    <IconChevronUp size={12} />
                  ) : (
                    <IconChevronDown size={12} />
                  )}
                </button>
                {archivedExpanded ? (
                  <div className="mt-1.5 space-y-0.5">
                    {tree.archived.map((branch) => (
                      <BranchRow
                        key={branch.id}
                        node={{
                          branch,
                          depth: 0,
                          headPreview: "",
                          children: [],
                        }}
                        depth={0}
                        isLast={true}
                        ancestorLines={[]}
                        currentBranchId={currentBranchId}
                        selectedForCompare={[]}
                        onToggleSelect={() => {}}
                        onShowTooltip={showTooltip}
                        onHideTooltip={hideTooltip}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <BranchHealthCard />
          </div>
        )}
      </div>

      {/* Compare selection bar */}
      {selectedForCompare.length > 0 ? (
        <div className="shrink-0 border-t border-miro-border/10 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-miro-text-secondary">
              {selectedForCompare.length === 2
                ? `${t("common.compare")}: 2`
                : `${selectedForCompare.length}/2`}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleClearSelection}
                className="app-secondary-button px-3 py-1.5 text-xs"
              >
                {t("common.cancel")}
              </button>
              {selectedForCompare.length === 2 ? (
                <button
                  type="button"
                  onClick={handleEnterCompare}
                  className="app-primary-button gap-1.5 px-3 py-1.5 text-xs"
                >
                  <IconColumns size={12} />
                  {t("common.compare")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Flatten tree to rows
// ============================================================================

interface FlatRow {
  node: BranchTreeNode;
  depth: number;
  isLast: boolean;
  /** Which ancestor levels need a vertical line (true = draw line). */
  ancestorLines: boolean[];
}

const MAX_RENDER_DEPTH = 8;

function flattenTree(root: BranchTreeNode): FlatRow[] {
  const result: FlatRow[] = [];
  // Root node (mainline) is always first
  result.push({
    node: root,
    depth: 0,
    isLast: true,
    ancestorLines: [],
  });

  // Iterative walk using a stack to avoid deep recursion
  const stack: Array<{
    node: BranchTreeNode;
    depth: number;
    ancestorLines: boolean[];
  }> = [{ node: root, depth: 0, ancestorLines: [] }];

  while (stack.length > 0) {
    const item = stack.pop()!;
    const { node, depth, ancestorLines } = item;
    const children = node.children;

    // Push children in reverse so left-most is processed first
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const childAncestorLines = [...ancestorLines, !isLast];
      const childDepth = depth + 1;

      result.push({
        node: child,
        depth: childDepth,
        isLast,
        ancestorLines,
      });

      if (childDepth < MAX_RENDER_DEPTH) {
        stack.push({ node: child, depth: childDepth, ancestorLines: childAncestorLines });
      }
    }
  }

  return result;
}

// ============================================================================
// Branch Row Component
// ============================================================================

function BranchRow({
  node,
  depth,
  isLast,
  ancestorLines,
  currentBranchId,
  selectedForCompare,
  onToggleSelect,
  onShowTooltip,
  onHideTooltip,
}: {
  node: BranchTreeNode;
  depth: number;
  isLast: boolean;
  ancestorLines: boolean[];
  currentBranchId: string | null;
  selectedForCompare: BranchId[];
  onToggleSelect: (id: BranchId) => void;
  onShowTooltip: (text: string, e: React.MouseEvent) => void;
  onHideTooltip: () => void;
}) {
  const { t } = useTranslation();
  const setCurrentBranch = useAppStore(_sel_setCurrentBranch);
  const renameBranch = useAppStore(_sel_renameBranch);
  const archiveBranch = useAppStore(_sel_archiveBranch);
  const unarchiveBranch = useAppStore(_sel_unarchiveBranch);
  const setMainlineBranch = useAppStore(_sel_setMainlineBranch);
  const activeConversationId = useAppStore(_sel_activeConversationId);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(node.branch.name);
  const renameCommitRef = useRef(false);

  const branch = node.branch;
  const isCurrent = branch.id === currentBranchId;
  const isMainline = branch.isMainline;
  const displayName = getBranchDisplayName(branch.name, t);
  const showCheckbox = branch.status === "ACTIVE";
  const childCount = node.children.length;

  function handleClick() {
    if (!isRenaming) setCurrentBranch(branch.id);
  }

  function handleDoubleClick() {
    if (!isRenaming) setCurrentBranch(branch.id);
  }

  async function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = renameDraft.trim();
    if (trimmed) {
      renameCommitRef.current = true;
      try {
        await renameBranch(branch.id, trimmed);
        setIsRenaming(false);
      } catch (err) {
        console.error("[branch] rename failed:", err);
        renameCommitRef.current = false;
      }
    }
  }

  async function handleSetMainline() {
    if (!activeConversationId) return;
    try {
      await setMainlineBranch(activeConversationId, branch.id);
    } catch {}
  }

  async function handleToggleArchive() {
    try {
      if (branch.status === "ARCHIVED") await unarchiveBranch(branch.id);
      else await archiveBranch(branch.id);
    } catch {}
  }

  const bgClass = isCurrent
    ? "bg-miro-blue-light/45"
    : depth === 0
      ? "bg-white/60"
      : "bg-white/40 hover:bg-white/70";

  // Build tree connector indentation (cap visual depth)
  const INDENT_PX = 16;
  const VISUAL_DEPTH = Math.min(depth, MAX_RENDER_DEPTH);

  return (
    <div
      className={`group flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors cursor-pointer ${bgClass}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      onMouseEnter={
        node.headPreview
          ? (e) => onShowTooltip(node.headPreview, e)
          : undefined
      }
      onMouseLeave={node.headPreview ? onHideTooltip : undefined}
    >
      {/* Tree indentation with connector lines */}
      <div
        className="relative shrink-0"
        style={{ width: VISUAL_DEPTH * INDENT_PX + 4, height: 16 }}
      >
        {depth > 0 &&
          ancestorLines.map((hasLine, i) => {
            if (!hasLine) return null;
            return (
              <div
                key={i}
                className="absolute top-0 h-full w-px bg-miro-border/25"
                style={{ left: i * INDENT_PX + 7 }}
              />
            );
          })}
        {depth > 0 && (
          <Fragment>
            {/* Horizontal connector */}
            <div
              className="absolute top-1/2 h-px bg-miro-border/25"
              style={{
                left: (depth - 1) * INDENT_PX + 7,
                width: INDENT_PX - 4,
              }}
            />
            {/* Corner or T-junction dot */}
            <div
              className={`absolute top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full border-[1.5px] ${
                isMainline
                  ? "border-miro-green bg-miro-green-light"
                  : "border-miro-border/40 bg-white"
              }`}
              style={{ left: depth * INDENT_PX - 2 }}
            />
          </Fragment>
        )}
      </div>

      {/* Mainline dot for root */}
      {VISUAL_DEPTH === 0 && (
        <div className="h-[11px] w-[11px] shrink-0 rounded-full border-[1.5px] border-miro-green bg-miro-green-light" />
      )}

      {/* Compare checkbox */}
      {showCheckbox ? (
        <input
          type="checkbox"
          checked={selectedForCompare.includes(branch.id)}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect(branch.id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-3 w-3 shrink-0 rounded border-miro-border/40 accent-miro-blue"
          aria-label={`Select ${branch.name} for compare`}
        />
      ) : (
        <span className="h-3 w-3 shrink-0" />
      )}

      {/* Branch info */}
      <div className="min-w-0 flex-1">
        {isRenaming ? (
          <form
            onSubmit={(e) => void handleRenameSubmit(e)}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1"
          >
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => {
                if (!renameCommitRef.current) setIsRenaming(false);
              }}
              className="app-input px-2 py-0.5 text-xs"
              style={{ width: 120 }}
            />
            <button
              type="submit"
              className="text-[10px] font-medium text-miro-blue"
              onMouseDown={() => {
                renameCommitRef.current = true;
              }}
            >
              {t("common.save")}
            </button>
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <span
              className="truncate text-xs font-medium text-miro-text"
              title={branch.name}
            >
              {displayName}
            </span>
            {isMainline ? (
              <span className="shrink-0 whitespace-nowrap app-status-pill border-miro-green/20 bg-miro-green-light/80 text-miro-green text-[9px]">
                {t("common.mainline")}
              </span>
            ) : null}
            {isCurrent ? (
              <span className="shrink-0 whitespace-nowrap app-status-pill border-miro-blue/15 bg-miro-blue-light text-miro-blue text-[9px]">
                {t("common.current")}
              </span>
            ) : null}
            {childCount > 0 ? (
              <span className="shrink-0 whitespace-nowrap text-[10px] text-miro-text-secondary/60">
                {childCount}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {/* Hover actions */}
      {!isRenaming && branch.status === "ACTIVE" ? (
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="app-icon-button h-5 w-5"
            title={t("branch.rename")}
            onClick={() => {
              setRenameDraft(branch.name);
              setIsRenaming(true);
            }}
          >
            <IconPencilSquare size={10} />
          </button>
          {!isMainline ? (
            <button
              type="button"
              className="app-icon-button h-5 w-5"
              title={t("branch.setAsMainline")}
              onClick={() => void handleSetMainline()}
            >
              <IconStarOutline size={10} />
            </button>
          ) : null}
          <button
            type="button"
            className="app-icon-button h-5 w-5"
            title={t("branch.archive")}
            onClick={() => void handleToggleArchive()}
          >
            <IconArchive size={10} />
          </button>
        </div>
      ) : null}
      {!isRenaming && branch.status === "ARCHIVED" ? (
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="app-icon-button h-5 w-5"
            title={t("branch.unarchive")}
            onClick={() => void handleToggleArchive()}
          >
            <IconRotateCcw size={10} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
