/**
 * @file App.tsx
 * @description Root desktop shell for GetChat.
 *
 * This shell follows the product direction captured in `docs/stitch`:
 *   1. Desktop-first information density with a stable top chrome.
 *   2. Conversation navigation on the left, contextual tools on the right.
 *   3. Workspace-first entry even when no provider is configured.
 *   4. Compare mode and settings remain first-class surfaces in the same app.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getModelDisplayName } from "./features/models/modelUtils";
import { useAppStore } from "./stores/useAppStoreSelector";
import { useCompactAppShell } from "./hooks/useCompactAppShell";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { sendMessageAction } from "./features/composer/sendMessageAction";
import { getConversationDisplayTitle } from "./i18n/displayNames";
import { findBranchContainingMessage } from "./selectors/conversationSelectors";
import { TopContextBar } from "./components/layout/TopContextBar";
import { BranchPanel } from "./components/branches/BranchPanel";
import { WorkspaceBannerRegion } from "./components/workspace/WorkspaceBannerRegion";
import { MessageList } from "./components/chat/MessageList";
import { Composer } from "./components/composer/Composer";
import { TodoStatusBar } from "./components/todo/TodoStatusBar";
import { CompareWorkspace } from "./components/compare/CompareWorkspace";
import { ConversationListItem } from "./components/conversations/ConversationListItem";
import { BrandLogo } from "./components/brand/BrandLogo";
import { FileExplorerPanel } from "./components/files/FileExplorerPanel";
import { FilePreviewPanel } from "./components/files/FilePreviewPanel";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconSettings,
} from "./components/common/Icon";
import { ProviderSettingsScreen } from "./components/settings/ProviderSettingsScreen";
import { ExportDialog } from "./components/export/ExportDialog";
import { ImportDialog } from "./components/import/ImportDialog";
import { BranchRenameDialog } from "./components/branches/BranchRenameDialog";
import { ConfirmDialogPortal } from "./components/common/confirmDialog";
import { UpdateNotification } from "./components/common/UpdateNotification";
import { SearchDialog } from "./components/common/SearchDialog";
// ============================================================================
// Module-level selectors (stable references for React 19 useSyncExternalStore)
//
// Each arrow function is created once at module load time so Zustand 5's
// internal `useCallback(() => selector(api.getState()), [api, selector])`
// receives a stable `selector` every render.  Without this, inline closures
// like `(state) => state.summaryOrder` create a new function per render,
// which causes a new `getSnapshot` callback, which React 19's
// useSyncExternalStore must re-evaluate.
// ============================================================================
const selectBootStatus = (s: import("./stores/appStore.types").AppStore) => s.bootStatus;
const selectBootError = (s: import("./stores/appStore.types").AppStore) => s.bootError;
const selectInitializeApp = (s: import("./stores/appStore.types").AppStore) => s.initializeApp;
const selectLeftSidebarCollapsed = (s: import("./stores/appStore.types").AppStore) => s.ui.leftSidebarCollapsed;
const selectRightPanelCollapsed = (s: import("./stores/appStore.types").AppStore) => s.ui.rightPanelCollapsed;
const selectProviders = (s: import("./stores/appStore.types").AppStore) => s.providers;
const selectProviderOrder = (s: import("./stores/appStore.types").AppStore) => s.providerOrder;
const selectProviderModels = (s: import("./stores/appStore.types").AppStore) => s.providerModels;
const selectDefaultModelId = (s: import("./stores/appStore.types").AppStore) => s.defaultModelId;
const selectActiveSnapshot = (s: import("./stores/appStore.types").AppStore) => s.activeSnapshot;
const selectWorkspaceMode = (s: import("./stores/appStore.types").AppStore) => s.workspace.workspaceMode;
const selectSetLeftSidebarCollapsed = (s: import("./stores/appStore.types").AppStore) => s.setLeftSidebarCollapsed;
const selectSetRightPanelCollapsed = (s: import("./stores/appStore.types").AppStore) => s.setRightPanelCollapsed;
const selectCreateConversation = (s: import("./stores/appStore.types").AppStore) => s.createConversation;
const selectOpenConversation = (s: import("./stores/appStore.types").AppStore) => s.openConversation;
const selectSummariesById = (s: import("./stores/appStore.types").AppStore) => s.summariesById;
const selectSummaryOrder = (s: import("./stores/appStore.types").AppStore) => s.summaryOrder;
const selectActiveConversationId = (s: import("./stores/appStore.types").AppStore) => s.workspace.activeConversationId;
const selectFileExplorerOpen = (s: import("./stores/appStore.types").AppStore) => s.ui.fileExplorerOpen;
const selectPreviewFilePath = (s: import("./stores/appStore.types").AppStore) => s.ui.previewFilePath;
const selectSetFileExplorerOpen = (s: import("./stores/appStore.types").AppStore) => s.setFileExplorerOpen;
const selectSetPreviewFilePath = (s: import("./stores/appStore.types").AppStore) => s.setPreviewFilePath;
type AppPage = "WORKSPACE" | "SETTINGS";
interface ConversationSidebarProps {
  activePage: AppPage;
  onCreateConversation: () => Promise<void>;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
}
interface WorkspaceCenterProps {
  hasConfiguredProviders: boolean;
  onCreateConversation: () => Promise<void>;
  onOpenSettings: () => void;
}
interface WorkspaceEmptyStateProps {
  hasConfiguredProviders: boolean;
  onCreateConversation: () => Promise<void>;
  onOpenSettings: () => void;
}
interface ShellHeaderProps {
  activePage: AppPage;
  desktopLeftInset: number;
  hasConfiguredProviders: boolean;
  connectedProviderCount: number;
  defaultModelName: string;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
}
interface OverviewRailProps {
  hasConfiguredProviders: boolean;
  connectedProviderCount: number;
  defaultModelName: string;
}
interface SidebarBackdropProps {
  onClose: () => void;
}
const DESKTOP_LEFT_SIDEBAR_WIDTH_PX = 272;
const DESKTOP_RIGHT_RAIL_WIDTH_PX = 336;
const DESKTOP_COLLAPSED_EDGE_PX = 28;
// ============================================================================
// Boot States
// ============================================================================
/** Full-screen loading state shown during app initialization. */
function BootScreen() {
  const { t } = useTranslation();
  return (
    <div className="app-shell flex h-full items-center justify-center px-6 py-8">
      <div className="app-panel w-full max-w-xl rounded-shell bg-miro-card/96 px-10 py-12 text-center">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-5">
          <BrandLogo
            size={40}
            iconWrapperClassName="h-16 w-16 rounded-[24px] bg-miro-card shadow-panel"
          />
          <div className="space-y-3">
            <span className="app-section-label">GetChat</span>
            <h1 className="font-display text-3xl font-semibold tracking-[-0.03em] text-miro-text">
              {t("common.loading")}
            </h1>
            <p className="text-sm leading-7 text-miro-text-secondary">
              {t("boot.loadingDescription")}
            </p>
          </div>
          <div className="h-1.5 w-36 overflow-hidden rounded-full bg-miro-surface-high">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-miro-blue" />
          </div>
        </div>
      </div>
    </div>
  );
}
/** Full-screen error state shown when initialization fails. */
function BootError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="app-shell flex h-full items-center justify-center px-6 py-8">
      <div className="app-panel w-full max-w-xl rounded-shell bg-miro-card/96 px-10 py-12 text-center">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-5">
          <div className="flex h-16 w-16 items-center justify-center rounded-[24px] bg-miro-red-light text-2xl font-black text-miro-red">
            !
          </div>
          <div className="space-y-3">
            <span className="app-section-label">{t("boot.initializationFailed")}</span>
            <h2 className="font-display text-3xl font-semibold tracking-[-0.03em] text-miro-text">
              {t("boot.initializationFailed")}
            </h2>
            <p className="text-sm leading-7 text-miro-text-secondary">{error}</p>
          </div>
          <button type="button" onClick={onRetry} className="app-primary-button px-6">
            {t("common.retry")}
          </button>
        </div>
      </div>
    </div>
  );
}
// ============================================================================
// Shared Shell Components
// ============================================================================
/** Backdrop used when a sidebar becomes an overlay drawer in compact mode. */
function SidebarBackdrop({ onClose }: SidebarBackdropProps) {
  return (
    <button
      type="button"
      aria-label="Close sidebar"
      onClick={onClose}
      className="fixed inset-0 z-30 bg-miro-scrim backdrop-blur-[2px]"
    />
  );
}
/** Fixed desktop header with product status and primary navigation. */
function ShellHeader({
  activePage,
  desktopLeftInset,
  hasConfiguredProviders,
  connectedProviderCount,
  defaultModelName,
  onOpenWorkspace,
  onOpenSettings,
}: ShellHeaderProps) {
  const { t } = useTranslation();
  const workspaceMode = useAppStore(selectWorkspaceMode);
  const activeSnapshot = useAppStore(selectActiveSnapshot);
  const compareActive = activePage === "WORKSPACE" && workspaceMode === "COMPARE";
  const conversationTitle = getConversationDisplayTitle(
    activeSnapshot?.summary.title,
    t
  );
  return (
    <header
      className="app-shell-header fixed top-0 right-0 z-20 flex h-16 items-center justify-between px-4 sm:px-6"
      style={{ left: desktopLeftInset }}
    >
      <div className="flex min-w-0 items-center gap-4">
        <BrandLogo
          variant="lockup"
          size={28}
          subtitle={t("shell.productTagline")}
          className="min-w-0"
          iconWrapperClassName="h-10 w-10 rounded-2xl bg-miro-card/76 shadow-ring"
          iconClassName="h-7 w-7"
          titleClassName="text-base sm:text-lg"
          subtitleClassName="hidden lg:block"
        />
        <nav className="hidden items-center gap-2 md:flex">
          <button
            type="button"
            onClick={onOpenWorkspace}
            className={`app-nav-link ${
              activePage === "WORKSPACE" ? "app-nav-link-active" : ""
            }`}
          >
            {t("common.workspace")}
          </button>
          <span
            className={`app-nav-link cursor-default ${
              compareActive ? "app-nav-link-active" : ""
            }`}
          >
            {t("common.compare")}
          </span>
          <button
            type="button"
            onClick={onOpenSettings}
            className={`app-nav-link ${
              activePage === "SETTINGS" ? "app-nav-link-active" : ""
            }`}
          >
            {t("common.settings")}
          </button>
        </nav>
        {activePage === "WORKSPACE" && activeSnapshot ? (
          <div className="hidden min-w-0 items-center gap-3 xl:flex">
            <span className="h-1 w-1 rounded-full bg-miro-border" />
            <span className="truncate text-sm text-miro-text-secondary">
              {conversationTitle}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <span
          className={`app-status-pill hidden sm:inline-flex ${
            hasConfiguredProviders
              ? "border-miro-green/15 bg-miro-green-light/55 text-miro-green"
              : "border-miro-border/20 bg-miro-card/80 text-miro-text-secondary"
          }`}
        >
          {hasConfiguredProviders
            ? t("shell.providersReady", { count: connectedProviderCount })
            : t("shell.providersMissing")}
        </span>
        {defaultModelName !== t("shell.modelUnset") ? (
          <span className="app-status-pill inline-flex">
            {defaultModelName}
          </span>
        ) : null}
      </div>
    </header>
  );
}
/**
 * Product-style empty workspace state.
 * It keeps the app useful even before a provider is configured.
 */
function WorkspaceEmptyState({
  hasConfiguredProviders,
  onCreateConversation,
  onOpenSettings,
}: WorkspaceEmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full justify-center px-4 py-8 pt-40">
      <div className="w-full max-w-5xl">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto mb-8 flex justify-center">
            <BrandLogo
              size={56}
              iconWrapperClassName="h-24 w-24 rounded-shell bg-miro-card shadow-panel"
            />
          </div>
          <p className="app-section-label mb-4">
            {hasConfiguredProviders
              ? t("workspace.readyLabel")
              : t("workspace.noProviderLabel")}
          </p>
          <h2 className="font-display text-4xl font-semibold tracking-[-0.04em] text-miro-text sm:text-5xl">
            {hasConfiguredProviders
              ? t("workspace.readyTitle")
              : t("workspace.noProviderTitle")}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-8 text-miro-text-secondary">
            {hasConfiguredProviders
              ? t("workspace.readySubtitle")
              : t("workspace.noProviderSubtitle")}
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => void onCreateConversation()}
              className="app-primary-button min-w-[176px]"
            >
              {t("conversation.newConversation")}
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="app-secondary-button min-w-[176px]"
            >
              {t("workspace.openSettings")}
            </button>
          </div>
        </div>
        <div className="mx-auto mt-10 grid max-w-4xl gap-4 md:grid-cols-3">
          <div className="app-panel rounded-panel bg-miro-card/96 px-5 py-5">
            <div className="app-section-label mb-2">
              {t("workspace.localFirstTitle")}
            </div>
            <p className="text-sm leading-7 text-miro-text-secondary">
              {t("workspace.localFirstBody")}
            </p>
          </div>
          <div className="app-panel rounded-panel bg-miro-card/96 px-5 py-5">
            <div className="app-section-label mb-2">
              {t("workspace.providerShortcutTitle")}
            </div>
            <p className="text-sm leading-7 text-miro-text-secondary">
              {t("workspace.providerShortcutBody")}
            </p>
          </div>
          <div className="app-panel rounded-panel bg-miro-card/96 px-5 py-5">
            <div className="app-section-label mb-2">
              {t("workspace.cleanLayoutTitle")}
            </div>
            <p className="text-sm leading-7 text-miro-text-secondary">
              {t("workspace.cleanLayoutBody")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
/**
 * Conversation list sidebar.
 * In compact mode it behaves like a drawer and closes itself after navigation.
 */
function ArchivedSection() {
  const { t } = useTranslation();
  const summaryOrder = useAppStore(selectSummaryOrder);
  const summariesById = useAppStore(selectSummariesById);
  const activeConversationId = useAppStore(selectActiveConversationId);
  const openConversation = useAppStore(selectOpenConversation);
  const isCompactShell = useCompactAppShell();
  const collapseSidebar = useAppStore(selectSetLeftSidebarCollapsed);
  const archived = useMemo(
    () =>
      summaryOrder
        .map((id) => summariesById[id])
        .filter(
          (summary): summary is NonNullable<typeof summary> =>
            Boolean(summary?.archivedAt)
        ),
    [summaryOrder, summariesById]
  );
  const [expanded, setExpanded] = useState(false);
  if (archived.length === 0) {
    return null;
  }
  return (
    <div className="pt-3">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between px-2 py-1.5 text-left"
      >
        <span className="app-section-label">{t("conversation.archive")} ({archived.length})</span>
        {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
      </button>
      {expanded ? (
        <div className="mt-1 space-y-2">
          {archived.map((summary) => (
            <ConversationListItem
              key={summary.id}
              summary={summary}
              isActive={summary.id === activeConversationId}
              onOpen={() => {
                void openConversation(summary.id).finally(() => {
                  if (isCompactShell) {
                    collapseSidebar(true);
                  }
                });
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
function ConversationSidebar({
  activePage,
  onCreateConversation,
  onOpenWorkspace,
  onOpenSettings,
}: ConversationSidebarProps) {
  const { t } = useTranslation();
  const isCompactShell = useCompactAppShell();
  const summaryOrder = useAppStore(selectSummaryOrder);
  const summariesById = useAppStore(selectSummariesById);
  const activeConversationId = useAppStore(selectActiveConversationId);
  const openConversation = useAppStore(selectOpenConversation);
  const collapseSidebar = useAppStore(selectSetLeftSidebarCollapsed);
  const providers = useAppStore(selectProviders);
  const providerOrder = useAppStore(selectProviderOrder);
  const providerModels = useAppStore(selectProviderModels);
  const defaultModelId = useAppStore(selectDefaultModelId);
  const connectedProviderCount = providerOrder.filter(
    (providerId) => providers[providerId]?.enabled
  ).length;
  const defaultModelName = getModelDisplayName(
    defaultModelId,
    providerModels,
    t("shell.modelUnset")
  );
  return (
    <aside className="app-sidebar-surface flex h-full flex-col">
      <div className="px-6 pb-5 pt-6">
        <div className="mb-6 flex items-start justify-between gap-3">
          <BrandLogo
            variant="lockup"
            size={32}
            subtitle={t("shell.productTagline")}
            className="min-w-0"
            iconWrapperClassName="h-11 w-11 rounded-2xl bg-miro-card shadow-panel"
            iconClassName="h-8 w-8"
            subtitleClassName="text-[11px] tracking-[0.18em]"
          />
          {isCompactShell ? (
            <button
              type="button"
              onClick={() => collapseSidebar(true)}
              className="app-icon-button h-10 w-10 shrink-0"
              title={t("common.toggleLeftSidebar")}
            >
              <IconChevronLeft size={14} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void onCreateConversation()}
          className="app-primary-button w-full justify-center gap-2 rounded-2xl py-3"
          title={t("conversation.newConversation")}
        >
          <span>{t("conversation.newConversation")}</span>
        </button>
      </div>
      <div className="px-6 pb-2">
        <p className="app-section-label">{t("shell.recentConversations")}</p>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {summaryOrder.length === 0 ? (
          <div className="rounded-panel bg-miro-card/72 px-5 py-6 shadow-ring">
            <p className="mb-2 text-sm font-semibold text-miro-text">
              {t("conversation.noConversations")}
            </p>
            <p className="text-sm leading-6 text-miro-text-secondary">
              {t("conversation.sidebarHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {summaryOrder.map((conversationId) => {
              const summary = summariesById[conversationId];
              if (!summary) {
                return null;
              }
              return (
                <ConversationListItem
                  key={conversationId}
                  summary={summary}
                  isActive={conversationId === activeConversationId}
                  onOpen={() => {
                    onOpenWorkspace();
                    void openConversation(conversationId).finally(() => {
                      if (isCompactShell) {
                        collapseSidebar(true);
                      }
                    });
                  }}
                />
              );
            })}
          </div>
        )}
          <ArchivedSection />
      </div>
      <div className="mt-auto space-y-3 px-4 pb-5">
        <div className="rounded-panel bg-miro-card/80 px-4 py-4 shadow-ring">
          <div className="app-section-label mb-3">{t("shell.workspaceHealth")}</div>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between text-miro-text-secondary">
              <span>{t("shell.providerStatus")}</span>
              <span className={connectedProviderCount > 0 ? "text-miro-green" : "text-miro-red"}>
                {connectedProviderCount > 0
                  ? t("shell.connectedCount", { count: connectedProviderCount })
                  : t("shell.disconnected")}
              </span>
            </div>
            <div className="flex items-center justify-between text-miro-text-secondary">
              <span>{t("shell.modelStatus")}</span>
              <span className="max-w-[132px] truncate font-medium text-miro-text">
                {defaultModelName}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            if (activePage === "SETTINGS") {
              onOpenWorkspace();
            } else {
              onOpenSettings();
            }
            if (isCompactShell) {
              collapseSidebar(true);
            }
          }}
          className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm transition-colors ${
            activePage === "SETTINGS"
              ? "app-sidebar-item app-sidebar-item-active"
              : "app-sidebar-item bg-miro-card/72 shadow-ring"
          }`}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-miro-card text-miro-blue shadow-ring">
            <IconSettings size={14} />
          </span>
          <div className="min-w-0">
            <div className="font-display font-semibold text-miro-text">
              {activePage === "SETTINGS"
                ? t("shell.workspaceHome")
                : t("common.settings")}
            </div>
            <div className="text-xs text-miro-text-secondary">
              {activePage === "SETTINGS"
                ? t("shell.returnWorkspace")
                : t("shell.configureProviders")}
            </div>
          </div>
        </button>
      </div>
    </aside>
  );
}
/** Contextual right rail shown when no conversation is open. */
function WorkspaceOverviewRail({
  hasConfiguredProviders,
  connectedProviderCount,
  defaultModelName,
}: OverviewRailProps) {
  const { t } = useTranslation();
  const summaryOrder = useAppStore(selectSummaryOrder);
  return (
    <aside className="app-sidebar-surface flex h-full flex-col px-6 py-6">
      <div>
        <p className="app-section-label mb-5">{t("shell.workspaceCapabilities")}</p>
        <div className="space-y-4">
          <div className="rounded-panel bg-miro-card/88 px-4 py-4 shadow-ring">
            <div className="text-sm font-semibold text-miro-text">
              {t("workspace.providerShortcutTitle")}
            </div>
            <p className="mt-2 text-sm leading-6 text-miro-text-secondary">
              {t("workspace.providerShortcutBody")}
            </p>
          </div>
          <div className="rounded-panel bg-miro-card/88 px-4 py-4 shadow-ring">
            <div className="text-sm font-semibold text-miro-text">
              {t("branch.panelTitle")}
            </div>
            <p className="mt-2 text-sm leading-6 text-miro-text-secondary">
              {t("shell.branchOverview")}
            </p>
          </div>
          <div className="rounded-panel bg-miro-card/88 px-4 py-4 shadow-ring">
            <div className="text-sm font-semibold text-miro-text">
              {t("common.compare")}
            </div>
            <p className="mt-2 text-sm leading-6 text-miro-text-secondary">
              {t("shell.compareOverview")}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-8 rounded-panel bg-miro-card/88 px-4 py-4 shadow-ring">
        <p className="app-section-label mb-3">{t("shell.workspaceHealth")}</p>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-miro-text-secondary">{t("shell.providerStatus")}</span>
            <span className={hasConfiguredProviders ? "text-miro-green" : "text-miro-red"}>
              {hasConfiguredProviders
                ? t("shell.providersReady", { count: connectedProviderCount })
                : t("shell.providersMissing")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-miro-text-secondary">
              {t("shell.conversationCount")}
            </span>
            <span className="font-semibold text-miro-text">{summaryOrder.length}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-miro-text-secondary">{t("shell.defaultModel")}</span>
            <span className="max-w-[150px] truncate font-semibold text-miro-text">
              {defaultModelName}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
/** Center workspace surface containing the main content area. */
function WorkspaceCenter({
  hasConfiguredProviders,
  onCreateConversation,
  onOpenSettings,
}: WorkspaceCenterProps) {
  const activeSnapshot = useAppStore(selectActiveSnapshot);
  const workspaceMode = useAppStore(selectWorkspaceMode);
  const fileExplorerOpen = useAppStore(selectFileExplorerOpen);
  const previewFilePath = useAppStore(selectPreviewFilePath);
  const setPreviewFilePath = useAppStore(selectSetPreviewFilePath);

  if (workspaceMode === "COMPARE") {
    return (
      <main className="h-full min-w-0 overflow-hidden rounded-shell bg-miro-card">
        <CompareWorkspace />
      </main>
    );
  }

  return (
    <main className="app-panel flex h-full min-w-0 overflow-hidden rounded-shell bg-miro-card/92">
      <div className="flex flex-1 flex-col min-w-0">
        <TopContextBar />
        <WorkspaceBannerRegion />
        <div className="relative flex-1 overflow-y-auto">
          {previewFilePath && fileExplorerOpen ? (
            <FilePreviewPanel
              filePath={previewFilePath}
              onClose={() => setPreviewFilePath(null)}
            />
          ) : activeSnapshot ? (
            <MessageList />
          ) : (
            <WorkspaceEmptyState
              hasConfiguredProviders={hasConfiguredProviders}
              onCreateConversation={onCreateConversation}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
        <TodoStatusBar conversationId={activeSnapshot?.summary.id} />
        <Composer />
      </div>
      {fileExplorerOpen && (
        <div className="flex w-[260px] shrink-0 flex-col border-l border-miro-border/15 bg-miro-surface-low/50">
          <FileExplorerPanel
            selectedFilePath={previewFilePath}
            onSelectFile={setPreviewFilePath}
          />
        </div>
      )}
    </main>
  );
}
/** Fixed edge strip used to reopen or collapse a desktop sidebar. */
function SidebarEdgeStrip({
  side,
  onExpand,
  panelWidth,
  isCollapsed,
}: {
  side: "left" | "right";
  onExpand: () => void;
  panelWidth?: number;
  isCollapsed?: boolean;
}) {
  const { t } = useTranslation();
  const buttonOffset = panelWidth !== undefined ? panelWidth - 18 : 8;
  return (
    <button
      type="button"
      onClick={onExpand}
      title={
        side === "left"
          ? t("common.toggleLeftSidebar")
          : t("common.toggleRightSidebar")
      }
      className={`fixed top-[88px] z-20 flex h-14 w-5 items-center justify-center rounded-full bg-miro-card/88 shadow-float opacity-0 transition-all duration-200 hover:opacity-100 hover:bg-miro-card`}
      style={
        side === "left"
          ? { left: buttonOffset }
          : { right: buttonOffset }
      }
    >
      {side === "left" ? (
        isCollapsed ? (
          <IconChevronRight size={14} className="text-miro-text-secondary" />
        ) : (
          <IconChevronLeft size={14} className="text-miro-text-secondary" />
        )
      ) : (
        isCollapsed ? (
          <IconChevronLeft size={14} className="text-miro-text-secondary" />
        ) : (
          <IconChevronRight size={14} className="text-miro-text-secondary" />
        )
      )}
    </button>
  );
}
// ============================================================================
// App Component
// ============================================================================
/** Root application component coordinating the desktop shell and major pages. */
export function App() {
  const { t } = useTranslation();
  const [activePage, setActivePage] = useState<AppPage>("WORKSPACE");
  const isCompactShell = useCompactAppShell();
  const bootStatus = useAppStore(selectBootStatus);
  const bootError = useAppStore(selectBootError);
  const initializeApp = useAppStore(selectInitializeApp);
  const leftSidebarCollapsed = useAppStore(selectLeftSidebarCollapsed);
  const rightPanelCollapsed = useAppStore(selectRightPanelCollapsed);
  const providers = useAppStore(selectProviders);
  const providerOrder = useAppStore(selectProviderOrder);
  const providerModels = useAppStore(selectProviderModels);
  const defaultModelId = useAppStore(selectDefaultModelId);
  const activeSnapshot = useAppStore(selectActiveSnapshot);
  const workspaceMode = useAppStore(selectWorkspaceMode);
  const setLeftSidebarCollapsed = useAppStore(selectSetLeftSidebarCollapsed);
  const setRightPanelCollapsed = useAppStore(selectSetRightPanelCollapsed);
  const createConversation = useAppStore(selectCreateConversation);
  const openConversation = useAppStore(selectOpenConversation);
  const connectedProviderCount = useMemo(
    () =>
      providerOrder.filter((providerId) => providers[providerId]?.enabled).length,
    [providerOrder, providers]
  );
  const defaultModelName = getModelDisplayName(
    defaultModelId,
    providerModels,
    t("shell.modelUnset")
  );
  const hasConfiguredProviders = connectedProviderCount > 0;
  useEffect(() => {
    void initializeApp();
  }, [initializeApp]);
  useEffect(() => {
    if (!isCompactShell) {
      return;
    }
    setLeftSidebarCollapsed(true);
    setRightPanelCollapsed(true);
  }, [isCompactShell, setLeftSidebarCollapsed, setRightPanelCollapsed]);
  /** Open the workspace surface and close overlay drawers when needed. */
  const handleOpenWorkspace = useCallback(() => {
    setActivePage("WORKSPACE");
    if (isCompactShell) {
      setLeftSidebarCollapsed(true);
      setRightPanelCollapsed(true);
    }
  }, [isCompactShell, setLeftSidebarCollapsed, setRightPanelCollapsed]);
  /** Open settings and close overlay drawers in compact mode. */
  const handleOpenSettings = useCallback(() => {
    setActivePage("SETTINGS");
    if (isCompactShell) {
      setLeftSidebarCollapsed(true);
      setRightPanelCollapsed(true);
    }
  }, [isCompactShell, setLeftSidebarCollapsed, setRightPanelCollapsed]);
  /** Create and open a new conversation from any surface in the shell. */
  const handleCreateConversation = useCallback(async () => {
    const conversationId = await createConversation();
    setActivePage("WORKSPACE");
    await openConversation(conversationId);
    if (isCompactShell) {
      setLeftSidebarCollapsed(true);
      setRightPanelCollapsed(true);
    }
  }, [
    createConversation,
    isCompactShell,
    openConversation,
    setLeftSidebarCollapsed,
    setRightPanelCollapsed,
  ]);
  const [searchOpen, setSearchOpen] = useState(false);
  useGlobalShortcuts({
    onCreateConversation: () => void handleCreateConversation(),
    onSendMessage: () => void sendMessageAction(),
    onOpenSettings: handleOpenSettings,
    onOpenSearch: () => setSearchOpen(true),
  });
  if (bootStatus === "IDLE" || bootStatus === "LOADING") {
    return <BootScreen />;
  }
  if (bootStatus === "FAILED") {
    return <BootError error={bootError || "Unknown error"} onRetry={initializeApp} />;
  }
  const isSettingsPage = activePage === "SETTINGS";
  const showWorkspaceCompare =
    activePage === "WORKSPACE" && workspaceMode === "COMPARE";
  const showRightRail = !isSettingsPage && !showWorkspaceCompare;
  const showOverviewRail = showRightRail && !activeSnapshot;
  const showLeftDrawer = isCompactShell && !leftSidebarCollapsed;
  const showRightDrawer = isCompactShell && showRightRail && !rightPanelCollapsed;
  const desktopLeftInset = isCompactShell
    ? 0
    : leftSidebarCollapsed
      ? DESKTOP_COLLAPSED_EDGE_PX
      : DESKTOP_LEFT_SIDEBAR_WIDTH_PX;
  const desktopRightInset = isCompactShell
    ? 0
    : showRightRail
      ? rightPanelCollapsed
        ? DESKTOP_COLLAPSED_EDGE_PX
        : DESKTOP_RIGHT_RAIL_WIDTH_PX
      : 24;
  return (
    <div className="app-shell relative h-full overflow-hidden">
      {showLeftDrawer ? (
        <SidebarBackdrop onClose={() => setLeftSidebarCollapsed(true)} />
      ) : null}
      {showRightDrawer ? (
        <SidebarBackdrop onClose={() => setRightPanelCollapsed(true)} />
      ) : null}
      <ShellHeader
        activePage={activePage}
        desktopLeftInset={desktopLeftInset}
        hasConfiguredProviders={hasConfiguredProviders}
        connectedProviderCount={connectedProviderCount}
        defaultModelName={defaultModelName}
        onOpenWorkspace={handleOpenWorkspace}
        onOpenSettings={handleOpenSettings}
      />
      <div
        className={
          isCompactShell
            ? `fixed inset-y-0 left-0 z-40 w-[min(320px,calc(100vw-28px))] transition-transform duration-200 ${
                leftSidebarCollapsed ? "-translate-x-full" : "translate-x-0"
              }`
            : `fixed inset-y-0 left-0 z-10 overflow-hidden transition-transform duration-200 ${
                leftSidebarCollapsed ? "-translate-x-full" : "translate-x-0"
              }`
        }
        style={
          isCompactShell
            ? undefined
            : {
                width: DESKTOP_LEFT_SIDEBAR_WIDTH_PX,
              }
        }
      >
        <ConversationSidebar
          activePage={activePage}
          onCreateConversation={handleCreateConversation}
          onOpenWorkspace={handleOpenWorkspace}
          onOpenSettings={handleOpenSettings}
        />
      </div>
      {!isCompactShell && (
        <SidebarEdgeStrip
          side="left"
          onExpand={() => setLeftSidebarCollapsed(!leftSidebarCollapsed)}
          panelWidth={leftSidebarCollapsed ? undefined : DESKTOP_LEFT_SIDEBAR_WIDTH_PX}
          isCollapsed={leftSidebarCollapsed}
        />
      )}
      {showRightRail ? (
        <div
          className={
            isCompactShell
              ? `fixed inset-y-16 right-3 z-40 w-[min(340px,calc(100vw-24px))] transition-transform duration-200 ${
                  rightPanelCollapsed ? "translate-x-[calc(100%+20px)]" : "translate-x-0"
                }`
              : `fixed inset-y-16 right-0 z-10 overflow-hidden transition-transform duration-200 ${
                  rightPanelCollapsed ? "translate-x-full" : "translate-x-0"
                }`
          }
          style={
            isCompactShell
              ? undefined
              : {
                  width: DESKTOP_RIGHT_RAIL_WIDTH_PX,
                }
          }
        >
          <aside className="h-full border-l border-miro-border/10 bg-miro-surface-low">
            {showOverviewRail ? (
              <WorkspaceOverviewRail
                hasConfiguredProviders={hasConfiguredProviders}
                connectedProviderCount={connectedProviderCount}
                defaultModelName={defaultModelName}
              />
            ) : (
              <BranchPanel />
            )}
          </aside>
        </div>
      ) : null}
      {!isCompactShell && showRightRail && (
        <SidebarEdgeStrip
          side="right"
          onExpand={() => setRightPanelCollapsed(!rightPanelCollapsed)}
          panelWidth={rightPanelCollapsed ? undefined : DESKTOP_RIGHT_RAIL_WIDTH_PX}
          isCollapsed={rightPanelCollapsed}
        />
      )}
      <div
        className="h-full pt-16"
        style={{
          paddingLeft: isCompactShell ? 0 : (isSettingsPage ? 0 : desktopLeftInset),
          paddingRight: isCompactShell ? 0 : (isSettingsPage ? 0 : desktopRightInset),
        }}
      >
        <div className={`h-full overflow-hidden ${isSettingsPage ? "pr-1 pl-4 pb-4 pt-3" : "px-3 pb-3 pt-3 sm:px-4 sm:pb-4 sm:pt-4"}`}>
          {isSettingsPage ? (
            <ProviderSettingsScreen onClose={handleOpenWorkspace} />
          ) : (
            <WorkspaceCenter
              hasConfiguredProviders={hasConfiguredProviders}
              onCreateConversation={handleCreateConversation}
              onOpenSettings={handleOpenSettings}
            />
          )}
        </div>
      </div>
      <ExportDialog />
      <ImportDialog />
      <BranchRenameDialog />
      <ConfirmDialogPortal />
      <UpdateNotification />
      {searchOpen ? (
        <SearchDialog
          onClose={() => setSearchOpen(false)}
          onNavigate={async (conversationId, messageId) => {
            setActivePage("WORKSPACE");
            await openConversation(conversationId);
            if (messageId) {
              const snapshot = useAppStore.getState().activeSnapshot;
              if (snapshot) {
                const branchId = findBranchContainingMessage(snapshot, messageId);
                if (branchId) {
                  const setCurrentBranch = useAppStore.getState().setCurrentBranch;
                  setCurrentBranch(branchId);
                }
              }
              useAppStore.setState((s) => { s.ui.scrollToMessageId = messageId; });
            }
          }}
        />
      ) : null}
    </div>
  );
}
