/**
 * @file BranchTreeItem.tsx
 * @description Compact single-row branch item for the tree-view panel.
 *
 * Shows branch name, status pills, and hover-revealed action buttons.
 * Used inside the tree layout with optional checkbox for compare.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getBranchDisplayName } from "../../i18n/displayNames";
import { useAppStore } from "../../stores/useAppStoreSelector";
import type { BranchEntity } from "../../types/conversation";
import type { BranchId } from "../../types/base";
import {
  IconArchive,
  IconPencilSquare,
  IconRotateCcw,
  IconStarOutline,
} from "../common/Icon";

const _sel_setCurrentBranch = (s: import("../../stores/appStore.types").AppStore) => s.setCurrentBranch;
const _sel_renameBranch = (s: import("../../stores/appStore.types").AppStore) => s.renameBranch;
const _sel_archiveBranch = (s: import("../../stores/appStore.types").AppStore) => s.archiveBranch;
const _sel_unarchiveBranch = (s: import("../../stores/appStore.types").AppStore) => s.unarchiveBranch;
const _sel_setMainlineBranch = (s: import("../../stores/appStore.types").AppStore) => s.setMainlineBranch;
const _sel_activeConversationId = (s: import("../../stores/appStore.types").AppStore) => s.workspace.activeConversationId;

interface BranchTreeItemProps {
  branch: BranchEntity;
  isCurrent: boolean;
  isMainline: boolean;
  isOnMainline: boolean;
  selectedForCompare: BranchId[];
  onToggleSelect: (id: BranchId) => void;
  messageCount?: number;
  connector?: "middle" | "last";
}

export function BranchTreeItem({
  branch,
  isCurrent,
  isMainline,
  isOnMainline,
  selectedForCompare,
  onToggleSelect,
  messageCount,
  connector,
}: BranchTreeItemProps) {
  const { t } = useTranslation();
  const setCurrentBranch = useAppStore(_sel_setCurrentBranch);
  const renameBranch = useAppStore(_sel_renameBranch);
  const archiveBranch = useAppStore(_sel_archiveBranch);
  const unarchiveBranch = useAppStore(_sel_unarchiveBranch);
  const setMainlineBranch = useAppStore(_sel_setMainlineBranch);
  const activeConversationId = useAppStore(_sel_activeConversationId);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(branch.name);
  const displayName = getBranchDisplayName(branch.name, t);
  const showCheckbox = branch.status === "ACTIVE";
  function handleClick() {
    if (!isRenaming) setCurrentBranch(branch.id);
  }
  const renameCommitRef = useRef(false);
  async function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = renameDraft.trim();
    if (trimmed) {
      renameCommitRef.current = true;
      try { await renameBranch(branch.id, trimmed); setIsRenaming(false); } catch (e) { console.error("[branch] rename failed:", e); renameCommitRef.current = false; }
    }
  }
  async function handleSetMainline() {
    if (!activeConversationId) return;
    try { await setMainlineBranch(activeConversationId, branch.id); } catch {}
  }
  async function handleToggleArchive() {
    try {
      if (branch.status === "ARCHIVED") await unarchiveBranch(branch.id);
      else await archiveBranch(branch.id);
    } catch {}
  }
  const bgClass = isCurrent
    ? "bg-miro-blue-light/45"
    : isOnMainline
      ? "bg-white/60"
      : "bg-white/40 hover:bg-white/70";
  return (
    <div
      className={`group flex items-center gap-1.5 rounded-xl px-2 py-1.5 transition-colors cursor-pointer ${bgClass}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); } }}
    >
      {/* Compare checkbox */}
      {showCheckbox ? (
        <input
          type="checkbox"
          checked={selectedForCompare.includes(branch.id)}
          onChange={(e) => { e.stopPropagation(); onToggleSelect(branch.id); }}
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
          <form onSubmit={(e) => void handleRenameSubmit(e)} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => { if (!renameCommitRef.current) setIsRenaming(false); }}
              className="app-input px-2 py-0.5 text-xs"
              style={{ width: 120 }}
            />
            <button type="submit" className="text-[10px] font-medium text-miro-blue" onMouseDown={() => { renameCommitRef.current = true; }}>{t("common.save")}</button>
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate text-xs font-medium text-miro-text" title={branch.name}>{displayName}</span>
            {isMainline ? (
              <span className="shrink-0 whitespace-nowrap app-status-pill border-miro-green/20 bg-miro-green-light/80 text-miro-green text-[9px]">{t("common.mainline")}</span>
            ) : null}
            {isCurrent ? (
              <span className="shrink-0 whitespace-nowrap app-status-pill border-miro-blue/15 bg-miro-blue-light text-miro-blue text-[9px]">{t("common.current")}</span>
            ) : null}
            {messageCount != null ? (
              <span className="shrink-0 whitespace-nowrap text-[10px] text-miro-text-secondary">{messageCount} msg</span>
            ) : null}
          </div>
        )}
      </div>
      {/* Hover actions */}
      {!isRenaming && branch.status === "ACTIVE" ? (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="app-icon-button h-5 w-5"
            title={t("branch.rename")}
            onClick={() => { setRenameDraft(branch.name); setIsRenaming(true); }}
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
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
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
