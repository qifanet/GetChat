/**
 * @file CompareToolbar.tsx
 * @description Toolbar for the compare view.
 *
 * The toolbar keeps the read-only state explicit while surfacing the only
 * allowed compare actions: return to one branch, export, or promote a branch
 * to mainline.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getBranchDisplayName } from "../../i18n/displayNames";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { generateBranchDiffSummary } from "../../services/tauriCommands";
import { MarkdownRenderer } from "../../../docs/private/MarkdownRenderer";
import type { BranchEntity } from "../../types/conversation";

const _select_openExportDialog = (s: import("../../stores/appStore.types").AppStore) => s.openExportDialog;
const _select_exitCompare = (s: import("../../stores/appStore.types").AppStore) => s.exitCompare;
const _select_setCurrentBranch = (s: import("../../stores/appStore.types").AppStore) => s.setCurrentBranch;
const _select_setMainlineBranch = (s: import("../../stores/appStore.types").AppStore) => s.setMainlineBranch;

interface CompareToolbarProps {
  leftBranch: BranchEntity;
  rightBranch: BranchEntity;
}

export function CompareToolbar({ leftBranch, rightBranch }: CompareToolbarProps) {
  const { t } = useTranslation();
  const openExportDialog = useAppStore(_select_openExportDialog);
  const exitCompare = useAppStore(_select_exitCompare);
  const setCurrentBranch = useAppStore(_select_setCurrentBranch);
  const activeConversationId = useAppStore(
    (state) => state.workspace.activeConversationId
  );
  const setMainlineBranch = useAppStore(_select_setMainlineBranch);
  const [error, setError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const helperModelId = useAppStore((s) => s.helperModelId);

  const leftName = getBranchDisplayName(leftBranch.name, t);
  const rightName = getBranchDisplayName(rightBranch.name, t);

  async function handleSetMainline(branchId: string): Promise<void> {
    if (!activeConversationId) return;
    setError(null);
    try {
      await setMainlineBranch(activeConversationId, branchId);
    } catch (mainlineError) {
      setError(
        mainlineError instanceof Error
          ? mainlineError.message
          : t("branch.setAsMainline")
      );
    }
  }

  function handleReturnToBranch(branchId: string): void {
    exitCompare();
    setCurrentBranch(branchId);
  }

  async function handleGenerateSummary(): Promise<void> {
    if (!activeConversationId) return;
    setSummaryLoading(true);
    setSummaryText(null);
    setSummaryCollapsed(false);
    try {
      const result = await generateBranchDiffSummary(
        activeConversationId,
        leftBranch.id,
        rightBranch.id
      );
      setSummaryText(result?.summary ?? null);
    } catch {
      setSummaryText(null);
    } finally {
      setSummaryLoading(false);
    }
  }

  const hasSummary = summaryText !== null;

  return (
    <div className="border-b border-miro-border/10 bg-white/92 px-4 py-3 sm:px-5">
      {/* Row 1: Status + Actions */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="app-status-pill shrink-0 border-miro-blue/20 bg-miro-blue-light/70 text-miro-blue">
          {t("compare.readOnly")}
        </span>

        {error ? <span className="shrink-0 text-xs text-red-600">{error}</span> : null}

        <span className="hidden sm:block h-4 w-px shrink-0 bg-miro-border/20" />

        <BranchActionGroup
          name={leftName}
          isMainline={leftBranch.isMainline}
          onReturn={() => handleReturnToBranch(leftBranch.id)}
          onSetMainline={() => void handleSetMainline(leftBranch.id)}
          setMainlineLabel={t("compare.setAsMainline", { name: leftName })}
        />

        <span className="hidden sm:block h-4 w-px shrink-0 bg-miro-border/20" />

        <button
          type="button"
          className="app-primary-button shrink-0 px-4 py-2 text-xs"
          onClick={openExportDialog}
        >
          {t("common.export")}
        </button>
        <button
          type="button"
          disabled={!helperModelId || summaryLoading}
          onClick={handleGenerateSummary}
          className="app-secondary-button shrink-0 px-4 py-2 text-xs text-miro-blue"
          title={!helperModelId ? t("compare.helperModelRequired") : undefined}
        >
          {summaryLoading ? t("compare.summarizing") : t("compare.aiSummary")}
        </button>

        <span className="hidden sm:block h-4 w-px shrink-0 bg-miro-border/20" />

        <BranchActionGroup
          name={rightName}
          isMainline={rightBranch.isMainline}
          onReturn={() => handleReturnToBranch(rightBranch.id)}
          onSetMainline={() => void handleSetMainline(rightBranch.id)}
          setMainlineLabel={t("compare.setAsMainline", { name: rightName })}
        />
      </div>

      {/* AI Summary — expandable panel */}
      {hasSummary ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-miro-blue/15 bg-miro-blue-light/20">
          <button
            type="button"
            onClick={() => setSummaryCollapsed((prev) => !prev)}
            className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors hover:bg-white/35"
          >
            <span className="flex items-center gap-2">
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`shrink-0 text-miro-blue transition-transform ${summaryCollapsed ? "" : "rotate-180"}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <span className="text-xs font-semibold text-miro-blue">
                {t("compare.aiSummary")}
              </span>
            </span>
            <span className="text-[11px] text-miro-text-secondary">
              {summaryCollapsed ? t("common.expand") : t("common.collapse")}
            </span>
          </button>
          {!summaryCollapsed ? (
            <div className="max-h-[300px] overflow-y-auto border-t border-miro-blue/10 px-4 py-3">
              <div className="prose prose-sm max-w-none text-sm text-miro-text">
                <MarkdownRenderer content={stripCodeFence(summaryText!)} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Branch Action Group
// ============================================================================

interface BranchActionGroupProps {
  name: string;
  isMainline: boolean;
  onReturn: () => void;
  onSetMainline: () => void;
  setMainlineLabel: string;
}

function BranchActionGroup({
  name,
  isMainline,
  onReturn,
  onSetMainline,
  setMainlineLabel,
}: BranchActionGroupProps) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span
        className="max-w-[120px] truncate text-sm font-semibold text-miro-text"
        title={name}
      >
        {name}
      </span>
      {isMainline ? (
        <span className="app-status-pill border-miro-blue/10 bg-miro-blue-light/50 px-2 py-0.5 text-[10px] text-miro-blue">
          {t("compare.mainlineBadge")}
        </span>
      ) : null}
      <button
        type="button"
        className="app-secondary-button h-7 px-2.5 text-[11px]"
        onClick={onReturn}
        title={t("compare.returnToBranch", { name })}
      >
        {t("compare.returnBtn")}
      </button>
      {!isMainline ? (
        <button
          type="button"
          className="app-secondary-button h-7 px-2.5 text-[11px] text-miro-green"
          onClick={onSetMainline}
          title={setMainlineLabel}
        >
          {t("compare.setMainlineBtn")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Strip surrounding markdown code fences that AI models often add.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:\w*)\n([\s\S]*?)```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}
