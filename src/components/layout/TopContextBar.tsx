/**
 * @file TopContextBar.tsx
 * @description Responsive workspace header.
 *
 * The header keeps orientation and primary actions visible without letting
 * long titles, breadcrumbs, and sidebars crush the main reading area.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useMemo, useState, useRef, useEffect, useCallback } from "react";
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
import { ModelSelector } from "../common/ModelSelector";
import * as tauriCmd from "../../services/tauriCommands";
import {
  IconColumns,
  IconExport,
  IconImport,
  IconChevronLeft,
  IconChevronRight,
  IconFolderOpen,
  IconFolder,
  IconX,
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
const _sel_ui_fileExplorerOpen = (s: import("../../stores/appStore.types").AppStore) => s.ui.fileExplorerOpen;
const _sel_setFileExplorerOpen = (s: import("../../stores/appStore.types").AppStore) => s.setFileExplorerOpen;
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
  const fileExplorerOpen = useAppStore(_sel_ui_fileExplorerOpen);
  const setFileExplorerOpen = useAppStore(_sel_setFileExplorerOpen);
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
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelDropdownOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(event.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelDropdownOpen]);

  const handleModelSelect = useCallback(
    (modelId: string | null) => {
      if (!currentBranchId) return;
      void setBranchPreferredModel(currentBranchId, modelId);
      setModelDropdownOpen(false);
    },
    [currentBranchId, setBranchPreferredModel]
  );

  const handleSetWorkspace = useCallback(async () => {
    if (!summary?.id) return;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t("workspaceDir.dirPickerTitle"),
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected;
    await tauriCmd.setConversationWorkspace(summary.id, path);
    useAppStore.setState(
      (s) => {
        if (s.activeSnapshot) {
          s.activeSnapshot.summary.workspacePath = path;
        }
        if (s.summariesById[summary.id]) {
          s.summariesById[summary.id].workspacePath = path;
        }
      },
      undefined,
      "workspace/dirSet"
    );
  }, [summary?.id, t]);

  const handleClearWorkspace = useCallback(async () => {
    if (!summary?.id) return;
    await tauriCmd.setConversationWorkspace(summary.id, null);
    useAppStore.setState(
      (s) => {
        if (s.activeSnapshot) {
          s.activeSnapshot.summary.workspacePath = null;
        }
        if (s.summariesById[summary.id]) {
          s.summariesById[summary.id].workspacePath = null;
        }
      },
      undefined,
      "workspace/dirClear"
    );
  }, [summary?.id]);

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
    <header className="border-b border-miro-border/10 bg-miro-card/90 px-3 py-2.5 sm:px-4">
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
            <div ref={modelDropdownRef} className="relative flex min-w-0 max-w-full items-center gap-2">
              <button
                type="button"
                onClick={() => setModelDropdownOpen((prev) => !prev)}
                className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-miro-border/40 bg-miro-card/88 px-2.5 py-1.5 text-left text-sm text-miro-text shadow-ring transition-colors hover:bg-miro-card/95 focus:outline-none focus:ring-0"
                title={currentBranch?.preferredModelId ? currentModelLabel : undefined}
              >
                <span className="hidden text-[10px] font-semibold uppercase tracking-[0.14em] text-miro-text-secondary 2xl:inline">
                  {t("shell.currentModel")}
                </span>
                <span className="min-w-[132px] max-w-[220px] truncate">
                  {currentModelLabel}
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-miro-text-secondary">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {modelDropdownOpen && (
                <div
                  role="listbox"
                  className="absolute right-0 top-full mt-1.5 z-50 min-w-[240px] max-w-[420px] max-h-64 overflow-y-auto rounded-xl border border-miro-border/40 bg-miro-card/95 p-1.5 shadow-ring"
                >
                  {!selectedModelId && (
                    <button
                      role="option"
                      type="button"
                      aria-selected
                      onClick={() => handleModelSelect(null)}
                      className="flex w-full items-center gap-2 rounded-lg bg-miro-blue-light/65 px-3 py-2 text-left text-sm text-miro-blue transition-colors"
                    >
                      {t("shell.modelUnset")}
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    </button>
                  )}
                  {availableModelOptions.map((option) => (
                    <button
                      key={option.id}
                      role="option"
                      type="button"
                      aria-selected={selectedModelId === option.id}
                      onClick={() => handleModelSelect(option.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        selectedModelId === option.id
                          ? "bg-miro-blue-light/65 text-miro-blue"
                          : "text-miro-text hover:bg-miro-surface-high"
                      }`}
                    >
                      <span className="truncate">
                        {option.providerName} / {option.displayName}
                      </span>
                      {selectedModelId === option.id && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
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
                onClick={() => useAppStore.getState().openImportDialog()}
              >
                <IconImport size={12} />
                <span className="hidden sm:inline">{t("import.title")}</span>
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
          {summary?.id ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`app-secondary-button gap-1.5 px-3 py-2 text-xs ${summary.workspacePath ? "border-miro-green-light bg-miro-green-light/60 text-miro-green" : ""}`}
                onClick={() => void handleSetWorkspace()}
                title={summary.workspacePath ? t("workspaceDir.pathTooltip", { path: summary.workspacePath }) : t("workspaceDir.setWorkspace")}
              >
                {summary.workspacePath ? <IconFolderOpen size={12} /> : <IconFolder size={12} />}
                <span className="hidden max-w-[160px] truncate sm:inline">
                  {summary.workspacePath
                    ? summary.workspacePath.split(/[\\/]/).pop()
                    : t("workspaceDir.setWorkspace")}
                </span>
              </button>
              {summary.workspacePath ? (
                <button
                  type="button"
                  className="app-icon-button h-7 w-7 text-xs text-miro-text-secondary hover:text-miro-red"
                  onClick={() => void handleClearWorkspace()}
                  title={t("workspaceDir.clearWorkspace")}
                >
                  <IconX size={10} />
                </button>
              ) : null}
            </div>
          ) : null}
          {summary?.workspacePath ? (
            <button
              type="button"
              onClick={() => setFileExplorerOpen(!fileExplorerOpen)}
              className={`app-icon-button h-9 w-9 shrink-0 ${fileExplorerOpen ? "bg-miro-blue-light/60 text-miro-blue" : ""}`}
              title={t("fileExplorer.togglePanel")}
            >
              <IconFolderOpen size={14} />
            </button>
          ) : null}
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
