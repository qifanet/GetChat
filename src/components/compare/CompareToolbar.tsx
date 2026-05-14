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
import { MarkdownRenderer } from "../messages/MarkdownRenderer";
import type { BranchEntity } from "../../types/conversation";
const _select_openExportDialog = (s: import("../../stores/appStore.types").AppStore) => s.openExportDialog;
const _select_exitCompare = (s: import("../../stores/appStore.types").AppStore) => s.exitCompare;
const _select_setCurrentBranch = (s: import("../../stores/appStore.types").AppStore) => s.setCurrentBranch;
const _select_setMainlineBranch = (s: import("../../stores/appStore.types").AppStore) => s.setMainlineBranch;
interface CompareToolbarProps {
  /** Left branch entity. */
  leftBranch: BranchEntity;
  /** Right branch entity. */
  rightBranch: BranchEntity;
}
/** Toolbar above the compare columns. */
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
  const helperModelId = useAppStore((s) => s.helperModelId);
  const leftName = getBranchDisplayName(leftBranch.name, t);
  const rightName = getBranchDisplayName(rightBranch.name, t);
  /** Persist the mainline switch through the store-backed command. */
  async function handleSetMainline(branchId: string): Promise<void> {
    if (!activeConversationId) {
      return;
    }
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
  /** Exit compare mode and reopen the chosen branch in the main workspace. */
  function handleReturnToBranch(branchId: string): void {
    exitCompare();
    setCurrentBranch(branchId);
  }
  return (
    <div className="border-b border-miro-border/10 bg-white/92 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="app-status-pill border-miro-blue/20 bg-miro-blue-light/70 text-miro-blue">
            {t("compare.readOnly")}
          </span>
          {error ? <span className="text-xs text-red-600">{error}</span> : null}
        </div>
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] xl:items-center">
          <div className="flex flex-wrap items-center gap-2 xl:justify-start">
            <span className="text-sm font-semibold text-miro-text">{leftName}</span>
            {!leftBranch.isMainline ? (
              <button
                type="button"
                className="app-secondary-button px-3 py-2 text-xs text-miro-green"
                onClick={() => void handleSetMainline(leftBranch.id)}
              >
                {t("compare.setAsMainline", { name: leftName })}
              </button>
            ) : null}
            <button
              type="button"
              className="app-secondary-button px-3 py-2 text-xs"
              onClick={() => handleReturnToBranch(leftBranch.id)}
            >
              {t("compare.returnTo", { name: leftName })}
            </button>
          </div>
          <button
            type="button"
            className="app-primary-button px-4 py-2 text-xs"
            onClick={openExportDialog}
          >
            {t("common.export")}
          </button>
          <button
            type="button"
            disabled={!helperModelId || summaryLoading}
            onClick={async () => {
              if (!activeConversationId) return;
              setSummaryLoading(true);
              setSummaryText(null);
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
            }}
            className="app-secondary-button px-4 py-2 text-xs text-miro-blue"
            title={!helperModelId ? t("compare.helperModelRequired") : undefined}
          >
            {summaryLoading ? t("compare.summarizing") : t("compare.aiSummary")}
          </button>
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <button
              type="button"
              className="app-secondary-button px-3 py-2 text-xs"
              onClick={() => handleReturnToBranch(rightBranch.id)}
            >
              {t("compare.returnTo", { name: rightName })}
            </button>
            {!rightBranch.isMainline ? (
              <button
                type="button"
                className="app-secondary-button px-3 py-2 text-xs text-miro-green"
                onClick={() => void handleSetMainline(rightBranch.id)}
              >
                {t("compare.setAsMainline", { name: rightName })}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {summaryText ? (
        <div className="mt-4 rounded-lg border border-miro-blue/15 bg-miro-blue-light/20 p-4">
          <div className="mb-2 text-xs font-semibold text-miro-blue">
            {t("compare.aiSummary")}
          </div>
          <div className="prose prose-sm max-w-none text-sm text-miro-text">
            <MarkdownRenderer content={summaryText} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
