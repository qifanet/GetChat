/**
 * @file TopContextBar.tsx
 * @description Responsive workspace header.
 *
 * The header keeps orientation and primary actions visible without letting
 * long titles, breadcrumbs, and sidebars crush the main reading area.
 */
import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import {
  getModelDisplayName,
  listAvailableModelOptions,
} from "../../features/models/modelUtils";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { useCompactAppShell } from "../../hooks/useCompactAppShell";
import { getConversationDisplayTitle } from "../../i18n/displayNames";
import {
  selectCurrentBranch,
  selectCurrentConversationSummary,
} from "../../selectors/conversationSelectors";
import { selectSuggestedCompareTargetBranchId } from "../../selectors/branchSelectors";
import { PathBreadcrumb } from "./PathBreadcrumb";
import { MainlineBadge } from "./MainlineBadge";
import { PendingConvergePill } from "./PendingConvergePill";
import {
  IconColumns,
  IconExport,
  IconChevronLeft,
  IconChevronRight,
} from "../common/Icon";
const _sel_workspace_workspaceMode = (s: import("../../stores/appStore.types").AppStore) => s.workspace.workspaceMode;
const _sel_workspace_currentBranchId = (s: import("../../stores/appStore.types").AppStore) => s.workspace.currentBranchId;
const _sel_composer_selectedModelId = (s: import("../../stores/appStore.types").AppStore) => s.composer.selectedModelId;
const _sel_providers = (s: import("../../stores/appStore.types").AppStore) => s.providers;
const _sel_providerOrder = (s: import("../../stores/appStore.types").AppStore) => s.providerOrder;
const _sel_providerModels = (s: import("../../stores/appStore.types").AppStore) => s.providerModels;
const _sel_ui_leftSidebarCollapsed = (s: import("../../stores/appStore.types").AppStore) => s.ui.leftSidebarCollapsed;
const _sel_ui_rightPanelCollapsed = (s: import("../../stores/appStore.types").AppStore) => s.ui.rightPanelCollapsed;
const _sel_setLeftSidebarCollapsed = (s: import("../../stores/appStore.types").AppStore) => s.setLeftSidebarCollapsed;
const _sel_setRightPanelCollapsed = (s: import("../../stores/appStore.types").AppStore) => s.setRightPanelCollapsed;
const _sel_setBranchPreferredModel = (s: import("../../stores/appStore.types").AppStore) => s.setBranchPreferredModel;
const _sel_enterCompare = (s: import("../../stores/appStore.types").AppStore) => s.enterCompare;
/** Responsive top bar for conversation context and primary workspace actions. */
export function TopContextBar() {
  const { t } = useTranslation();
  const isCompactShell = useCompactAppShell();
  const summary = useAppStore(selectCurrentConversationSummary);
  const currentBranch = useAppStore(selectCurrentBranch);
  const workspaceMode = useAppStore(_sel_workspace_workspaceMode);
  const currentBranchId = useAppStore(_sel_workspace_currentBranchId);
  const selectedModelId = useAppStore(_sel_composer_selectedModelId);
  const providers = useAppStore(_sel_providers);
  const providerOrder = useAppStore(_sel_providerOrder);
  const providerModels = useAppStore(_sel_providerModels);
  const leftCollapsed = useAppStore(_sel_ui_leftSidebarCollapsed);
  const rightCollapsed = useAppStore(_sel_ui_rightPanelCollapsed);
  const setLeftCollapsed = useAppStore(_sel_setLeftSidebarCollapsed);
  const setRightCollapsed = useAppStore(_sel_setRightPanelCollapsed);
  const setBranchPreferredModel = useAppStore(_sel_setBranchPreferredModel);
  const enterCompare = useAppStore(_sel_enterCompare);
  const suggestedCompareTargetBranchId = useAppStore(
    selectSuggestedCompareTargetBranchId
  );
  const displayConversationTitle = getConversationDisplayTitle(summary?.title, t);
  const availableModelOptions = useMemo(
    () => listAvailableModelOptions(providers, providerOrder, providerModels),
    [providerModels, providerOrder, providers]
  );
  const currentModelLabel = getModelDisplayName(
    selectedModelId,
    providerModels,
    t("shell.modelUnset")
  );
  /** Toggle the conversation sidebar while preventing two overlay drawers from overlapping. */
  function handleToggleLeftSidebar(): void {
    const nextCollapsed = !leftCollapsed;
    setLeftCollapsed(nextCollapsed);
    if (isCompactShell && !nextCollapsed) {
      setRightCollapsed(true);
    }
  }
  /** Toggle the branch sidebar while preventing two overlay drawers from overlapping. */
  function handleToggleRightSidebar(): void {
    const nextCollapsed = !rightCollapsed;
    setRightCollapsed(nextCollapsed);
    if (isCompactShell && !nextCollapsed) {
      setLeftCollapsed(true);
    }
  }
  return (
    <header className="border-b border-miro-border/10 bg-white/90 px-3 py-2.5 sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <button
            type="button"
            onClick={handleToggleLeftSidebar}
            className="app-icon-button h-9 w-9 shrink-0"
            title={t("common.toggleLeftSidebar")}
          >
            {leftCollapsed ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
          </button>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate font-display text-base font-semibold tracking-[-0.03em] text-miro-text sm:text-lg">
                {displayConversationTitle}
              </h1>
              <MainlineBadge />
              <PendingConvergePill />
            </div>
            <div className="mt-1 min-w-0 overflow-hidden text-xs leading-5 text-miro-text-secondary sm:text-sm">
              <PathBreadcrumb />
            </div>
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          {currentBranchId ? (
            <div className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-miro-border/40 bg-white/88 px-2.5 py-1.5 shadow-ring">
              <span className="hidden text-[10px] font-semibold uppercase tracking-[0.14em] text-miro-text-secondary 2xl:inline">
                {t("shell.currentModel")}
              </span>
              <select
                value={selectedModelId ?? ""}
                onChange={(event) =>
                  void setBranchPreferredModel(
                    currentBranchId,
                    event.target.value || null
                  )
                }
                className="min-w-[132px] max-w-[220px] bg-transparent text-sm text-miro-text focus:outline-none"
                title={currentBranch?.preferredModelId ? currentModelLabel : undefined}
              >
                <option value="">{t("shell.modelUnset")}</option>
                {availableModelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.providerName} / {option.displayName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {workspaceMode === "COMPARE" ? (
            <span className="app-status-pill border-miro-blue/20 bg-miro-blue-light/70 text-miro-blue">
              {t("compare.readOnly")}
            </span>
          ) : (
            <>
              <button
                type="button"
                className="app-secondary-button gap-1.5 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent"
                onClick={() => {
                  if (!currentBranchId || !suggestedCompareTargetBranchId) {
                    return;
                  }
                  enterCompare({
                    leftBranchId: currentBranchId,
                    rightBranchId: suggestedCompareTargetBranchId,
                  });
                }}
                disabled={!currentBranchId || !suggestedCompareTargetBranchId}
                title={
                  suggestedCompareTargetBranchId
                    ? t("common.compare")
                    : t("branch.compareUnavailable")
                }
              >
                <IconColumns size={12} />
                <span className="hidden sm:inline">{t("common.compare")}</span>
              </button>
              <button
                type="button"
                className="app-secondary-button gap-1.5 px-3 py-2 text-xs"
                onClick={() => useAppStore.getState().openExportDialog()}
              >
                <IconExport size={12} />
                <span className="hidden sm:inline">{t("common.export")}</span>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleToggleRightSidebar}
            className="app-icon-button h-9 w-9 shrink-0"
            title={t("common.toggleRightSidebar")}
          >
            {rightCollapsed ? <IconChevronLeft size={14} /> : <IconChevronRight size={14} />}
          </button>
        </div>
      </div>
    </header>
  );
}
