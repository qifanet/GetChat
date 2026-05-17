/**
 * @file Composer.tsx
 * @description Message input area with send mode dropdown and stop controls.
 *
 * The composer is a lightweight input bar at the bottom of the workspace.
 * Status indicators (provider/model) live in the global header to avoid
 * redundant visual noise. Branch mode is shown as a subtle inline dot.
 *
 * Send modes:
 *   APPEND      — normal send, appends to current path
 *   NEW_BRANCH  — creates a new branch from current leaf, original path unchanged
 */
import { useRef, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { useStreamStore } from "../../stores/useStreamStore";
import { sendMessageAction } from "../../features/composer/sendMessageAction";
import { cancelActiveStreams, cancelStream } from "../../services/streamController";
import * as tauriCmd from "../../services/tauriCommands";
import type { SendMode } from "../../types/base";

const _sel_workspace_workspaceMode = (s: import("../../stores/appStore.types").AppStore) => s.workspace.workspaceMode;

const _select_draft = (s: import("../../stores/appStore.types").AppStore) => s.composer.draft;
const _select_isSending = (s: import("../../stores/appStore.types").AppStore) => s.composer.isSending;
const _select_activeRequestId = (s: import("../../stores/appStore.types").AppStore) => s.composer.activeRequestId;
const _select_selectedModelId = (s: import("../../stores/appStore.types").AppStore) => s.composer.selectedModelId;
const _select_sendMode = (s: import("../../stores/appStore.types").AppStore) => s.composer.sendMode;
const _select_providerOrder = (s: import("../../stores/appStore.types").AppStore) => s.providerOrder;
const _select_providers = (s: import("../../stores/appStore.types").AppStore) => s.providers;
const _select_setDraft = (s: import("../../stores/appStore.types").AppStore) => s.setDraft;
const _select_setSendMode = (s: import("../../stores/appStore.types").AppStore) => s.setSendMode;

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Message composer with textarea, send mode dropdown, and stop controls. */
export function Composer() {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submitInFlightRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Slash command state
  const [slashItems, setSlashItems] = useState<tauriCmd.SlashItemDto[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [paramDialog, setParamDialog] = useState<{
    item: tauriCmd.SlashItemDto;
    variables: string[];
    values: Record<string, string>;
  } | null>(null);
  const [activeSlashItem, setActiveSlashItem] = useState<{
    item: tauriCmd.SlashItemDto;
    argsJson: string;
  } | null>(null);
  const draft = useAppStore(_select_draft);
  const isSending = useAppStore(_select_isSending);
  const activeRequestId = useAppStore(_select_activeRequestId);
  const selectedModelId = useAppStore(_select_selectedModelId);
  const sendMode = useAppStore(_select_sendMode);
  const providerOrder = useAppStore(_select_providerOrder);
  const providers = useAppStore(_select_providers);
  const setDraft = useAppStore(_select_setDraft);
  const setSendMode = useAppStore(_select_setSendMode);
  const workspaceMode = useAppStore(_sel_workspace_workspaceMode);
  const activeConversationId = useAppStore(
    (state) => state.workspace.activeConversationId
  );
  const activeBranchId = useAppStore(
    (state) => state.workspace.currentBranchId
  );
  const [contextStatus, setContextStatus] = useState<tauriCmd.ContextStatusDto | null>(null);
  const [compressing, setCompressing] = useState(false);
  const enabledProviderCount = useMemo(
    () => providerOrder.filter((providerId) => providers[providerId]?.enabled).length,
    [providerOrder, providers]
  );
  );
  const hasEnabledProvider = enabledProviderCount > 0;
  const disabledReason = !hasEnabledProvider
    ? t("composer.providerRequiredHint")
    : !selectedModelId
      ? t("composer.modelRequiredHint")
      : null;
  const canSend =
    (draft.trim().length > 0 || activeSlashItem !== null) &&
    !isSending &&
    hasEnabledProvider &&
    Boolean(selectedModelId);
  const isBranchMode = sendMode === "NEW_BRANCH";
  useEffect(() => {
    if (draft !== "" || !textareaRef.current) {
      return;
    }
    textareaRef.current.style.height = "34px";
  }, [draft]);
  /** Close dropdown on outside clicks. */
  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);
  /** Dispatch the real send action while keeping runtime failures visible in the console. */
  const handleSend = useCallback(async () => {
    if (submitInFlightRef.current || !canSend) {
      return;
    }

    submitInFlightRef.current = true;

    try {
      // If an active slash item is pending, render its template and prepend to draft.
      if (activeSlashItem) {
        try {
          const { item, argsJson } = activeSlashItem;
          let rendered: string;
          if (item.itemType === "mcp_prompt" && item.serverName) {
            rendered = await tauriCmd.executeMcpPrompt(item.serverName, item.name, argsJson);
          } else {
            rendered = await tauriCmd.executeSkill(item.name, argsJson);
          }
          const userText = draft.trim();
          const fullText = userText ? `${rendered}\n\n${userText}` : rendered;
          setDraft(fullText);
          setActiveSlashItem(null);
        } catch (err) {
          console.error("[composer] slash render failed:", err);
          return;
        }
        // Yield so the draft state update propagates before sendMessageAction reads it.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      try {
        await sendMessageAction();
      } catch (error) {
        console.error("[composer] send failed:", error);
      }
    } finally {
      submitInFlightRef.current = false;
    }
  }, [canSend, activeSlashItem, draft, setDraft]);
  /** Cancel the active streaming request when the user presses the stop control. */
  const handleStop = useCallback(() => {
    const cancelled = cancelActiveStreams({ conversationId: activeConversationId });
    if (cancelled === 0 && activeRequestId) {
      void cancelStream(activeRequestId);
    }
  }, [activeConversationId, activeRequestId]);
  /** Select a send mode from the dropdown and close it. */
  const handleSelectMode = useCallback(
    (mode: SendMode) => {
      setSendMode(mode);
      setMenuOpen(false);
    },
    [setSendMode]
  );
  /** Toggle the dropdown. */
  const handleToggleMenu = useCallback(() => {
    setMenuOpen((prev) => !prev);
  }, []);
  /** Support Enter to send and Shift+Enter for a newline. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );
  /** Auto-resize the textarea while keeping the composer height under control.
   *  Also detect `/` at start for slash command menu. */
  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      setDraft(value);
      const element = event.target;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 180)}px`;

      // Slash command detection: starts with "/" and no newline before the slash
      if (value.startsWith("/")) {
        const query = value.slice(1).split(/\s/)[0] ?? "";
        if (!showSlashMenu) {
          tauriCmd.listSlashItems().then(setSlashItems).catch(() => {});
        }
        setShowSlashMenu(true);
        setSlashFilter(query.toLowerCase());
      } else {
        setShowSlashMenu(false);
      }
    },
    [setDraft, showSlashMenu]
  );

  /** Select a slash item — defer rendering to send time. */
  const handleSelectSlashItem = useCallback(
    async (item: tauriCmd.SlashItemDto) => {
      setShowSlashMenu(false);
      setDraft("");

      let variables: string[] = [];
      try {
        const parsed = JSON.parse(item.argumentsJson);
        if (Array.isArray(parsed)) {
          variables = parsed.map((v: unknown) =>
            typeof v === "string" ? v : String(v)
          );
        } else if (typeof parsed === "object" && parsed !== null) {
          variables = (parsed as Array<{ name: string }>).map((a) => a.name);
        }
      } catch {
        // ignore
      }

      if (variables.length > 0) {
        const initialValues: Record<string, string> = {};
        variables.forEach((v) => {
          initialValues[v] = "";
        });
        setParamDialog({ item, variables, values: initialValues });
      } else {
        setActiveSlashItem({ item, argsJson: "{}" });
      }
    },
    [setDraft]
  );

  /** Submit the parameter dialog and activate deferred slash rendering. */
  const handleParamSubmit = useCallback(async () => {
    if (!paramDialog) return;
    const { item, values } = paramDialog;
    setActiveSlashItem({ item, argsJson: JSON.stringify(values) });
    setParamDialog(null);
  }, [paramDialog]);
  /** Refetch context status from backend immediately. */
  const refreshContextStatus = useCallback(() => {
    if (!activeConversationId || !activeBranchId || !selectedModelId) return;
    tauriCmd
      .getContextStatus(activeConversationId, activeBranchId, selectedModelId)
      .then(setContextStatus)
      .catch(() => {});
  }, [activeConversationId, activeBranchId, selectedModelId]);

  /** Poll context status periodically. Uses 5s interval during active streaming, 30s when idle. */
  useEffect(() => {
    if (!activeConversationId || !activeBranchId || !selectedModelId) return;
    let cancelled = false;
    const interval = isSending ? 5_000 : 30_000;
    const poll = () => {
      if (cancelled) return;
      tauriCmd
        .getContextStatus(activeConversationId, activeBranchId, selectedModelId)
        .then(setContextStatus)
        .catch(() => {});
      timer = window.setTimeout(poll, interval);
    };
    let timer: ReturnType<typeof setTimeout>;
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeConversationId, activeBranchId, selectedModelId, isSending]);

  /** Re-fetch context status immediately when a stream completes. */
  const prevSendingRef = useRef(isSending);
  useEffect(() => {
    if (prevSendingRef.current && !isSending) {
      refreshContextStatus();
    }
    prevSendingRef.current = isSending;
  }, [isSending, refreshContextStatus]);

  /** Re-fetch context status when mid-loop compression completes (CONTEXT_COMPRESSED SSE event). */
  const streamSession = useStreamStore((s) =>
    activeRequestId ? s.sessionsByRequestId[activeRequestId] : undefined
  );
  useEffect(() => {
    if (streamSession?.contextCompressed) {
      refreshContextStatus();
    }
  }, [streamSession?.contextCompressed, refreshContextStatus]);

  /** Post-stream async compaction (opencode-style): trigger background compression
   *  after a stream completes if context usage is high. The result takes effect on
   *  the NEXT conversation turn, not the current one. */
  const POST_STREAM_COMPRESSION_THRESHOLD = 75;
  useEffect(() => {
    if (prevSendingRef.current && !isSending) {
      if (activeConversationId && activeBranchId && selectedModelId) {
        tauriCmd.getContextStatus(activeConversationId, activeBranchId, selectedModelId)
          .then((status) => {
            const pct = status.rawPercentage ?? status.percentage;
            if (pct >= POST_STREAM_COMPRESSION_THRESHOLD) {
              console.info(
                `[context] post-stream async compression: usage=${pct}% >= ${POST_STREAM_COMPRESSION_THRESHOLD}%`
              );
              tauriCmd.compressContext(activeConversationId, activeBranchId, selectedModelId)
                .then((result) => {
                  if (result.skipped) {
                    console.info("[context] post-stream compression skipped", result.skipReason);
                  } else {
                    console.info(
                      `[context] post-stream compression done: ${result.compressedMessageCount} messages, ~${result.estimatedTokens} tokens`
                    );
                  }
                  refreshContextStatus();
                })
                .catch((err) => {
                  console.warn("[context] post-stream compression failed (non-critical)", err);
                });
            }
          })
          .catch(() => { /* status fetch failed, ignore */ });
      }
    }
  }, [isSending, activeConversationId, activeBranchId, selectedModelId, refreshContextStatus]);

  async function handleCompress() {
    if (!activeConversationId || !activeBranchId || !selectedModelId) return;
    setCompressing(true);
    try {
      const result = await tauriCmd.compressContext(activeConversationId, activeBranchId, selectedModelId);
      if (result.skipped) {
        console.info("[composer] context compression skipped", result.skipReason ?? "NO_COMPRESSIBLE_CONTENT");
      }
      refreshContextStatus();
    } catch (err) {
      console.error("[composer] compress failed:", err);
    } finally {
      setCompressing(false);
    }
  }

  if (!activeConversationId || workspaceMode === "COMPARE") {
    return null;
  }
  return (
    <div className="shrink-0 border-t border-miro-border/10 bg-white/60 px-3 py-2.5 sm:px-4">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2">
          {/* Branch mode indicator */}
          {isBranchMode && (
            <div
              className="flex h-11 w-7 shrink-0 items-center justify-center"
              title={t("composer.branchModeHint")}
            >
              <span className="h-2 w-2 rounded-full bg-miro-blue" />
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={disabledReason ?? t("composer.placeholder")}
            rows={1}
            className="min-h-[44px] max-h-[180px] flex-1 resize-none rounded-[20px] border border-miro-border/15 bg-white px-4 py-2.5 font-body text-[15px] leading-6 text-miro-text placeholder:text-miro-placeholder shadow-ring focus:outline-none focus:ring-4 focus:ring-miro-blue/10"
          />
          {isSending ? (
            <button
              type="button"
              onClick={handleStop}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] bg-miro-red text-white transition-colors hover:bg-miro-red/90"
              title={t("composer.stop")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <div ref={menuRef} className="relative flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!canSend}
                className={
                  "flex h-11 items-center justify-center rounded-l-[16px] pl-3.5 pr-2 transition-colors " +
                  (canSend
                    ? "bg-miro-blue text-white hover:bg-miro-blue-pressed"
                    : "bg-miro-border/80 text-miro-text-secondary/40")
                }
                title={isBranchMode ? t("composer.sendAsNewBranch") : t("composer.send")}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
              <button
                type="button"
                onClick={handleToggleMenu}
                disabled={!canSend}
                className={
                  "flex h-11 items-center justify-center rounded-r-[16px] border-l pl-1 pr-2 transition-colors " +
                  (canSend
                    ? "border-white/20 bg-miro-blue text-white hover:bg-miro-blue-pressed"
                    : "border-transparent bg-miro-border/80 text-miro-text-secondary/40")
                }
                title={t("composer.send")}
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {menuOpen && canSend ? (
                <div
                  role="listbox"
                  className="absolute bottom-full right-0 mb-2 w-52 rounded-[16px] border border-miro-border/30 bg-white p-1.5 shadow-panel"
                >
                  <button
                    role="option"
                    type="button"
                    aria-selected={sendMode === "APPEND"}
                    onClick={() => handleSelectMode("APPEND")}
                    className={
                      "flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left text-sm transition-colors " +
                      (sendMode === "APPEND"
                        ? "bg-miro-blue-light/65 text-miro-blue"
                        : "text-miro-text hover:bg-miro-surface-high")
                    }
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                    <span className="font-medium">{t("composer.send")}</span>
                    {sendMode === "APPEND" ? (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        className="ml-auto"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    ) : null}
                  </button>
                  <button
                    role="option"
                    type="button"
                    aria-selected={sendMode === "NEW_BRANCH"}
                    onClick={() => handleSelectMode("NEW_BRANCH")}
                    className={
                      "flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left text-sm transition-colors " +
                      (sendMode === "NEW_BRANCH"
                        ? "bg-miro-blue-light/65 text-miro-blue"
                        : "text-miro-text hover:bg-miro-surface-high")
                    }
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M6 3v12" />
                      <path d="M18 9a3 3 0 100 6h4" />
                      <path d="M18 15H6" />
                    </svg>
                    <span className="font-medium">{t("composer.sendAsNewBranch")}</span>
                    {sendMode === "NEW_BRANCH" ? (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        className="ml-auto"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    ) : null}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Parameter fill dialog */}
      {paramDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="fixed inset-0 bg-slate-950/30 backdrop-blur-[2px]"
            onClick={() => setParamDialog(null)}
          />
          <div className="relative z-10 w-full max-w-md rounded-shell bg-white px-7 py-7 shadow-panel">
            <h2 className="mb-4 font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
              /{paramDialog.item.name}
            </h2>
            <p className="mb-4 text-sm text-miro-text-secondary">
              {paramDialog.item.description || "Fill in the parameters:"}
            </p>
            <div className="space-y-3">
              {paramDialog.variables.map((variable) => (
                <div key={variable}>
                  <label className="text-xs font-medium text-miro-text">
                    {variable}
                  </label>
                  <input
                    type="text"
                    className="app-input mt-1 w-full text-sm"
                    value={paramDialog.values[variable] ?? ""}
                    onChange={(e) =>
                      setParamDialog((prev) =>
                        prev
                          ? {
                              ...prev,
                              values: { ...prev.values, [variable]: e.target.value },
                            }
                          : null
                      )
                    }
                    placeholder={variable}
                    autoFocus={paramDialog.variables[0] === variable}
                  />
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setParamDialog(null)}
                className="app-secondary-button px-4 py-2 text-sm"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleParamSubmit()}
                className="app-primary-button px-4 py-2 text-sm"
              >
                {t("settings.skillSave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
