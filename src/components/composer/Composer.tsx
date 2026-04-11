/**
 * @file Composer.tsx
 * @description Message input area with send and stop controls.
 *
 * The composer is presented as a focused desktop work surface instead of a
 * chat-app footer. It stays compact, surfaces provider/model readiness, and
 * keeps the main typing area visually stable across viewports.
 */

import { useRef, useCallback, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getModelDisplayName } from "../../features/models/modelUtils";
import { useAppStore } from "../../stores/useAppStore";
import { sendMessageAction } from "../../features/composer/sendMessageAction";
import { cancelStream } from "../../services/streamController";

/** Message composer with textarea plus provider and send status controls. */
export function Composer() {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draft = useAppStore((state) => state.composer.draft);
  const isSending = useAppStore((state) => state.composer.isSending);
  const activeRequestId = useAppStore((state) => state.composer.activeRequestId);
  const selectedModelId = useAppStore((state) => state.composer.selectedModelId);
  const providerOrder = useAppStore((state) => state.providerOrder);
  const providers = useAppStore((state) => state.providers);
  const providerModels = useAppStore((state) => state.providerModels);
  const setDraft = useAppStore((state) => state.setDraft);
  const workspaceMode = useAppStore((state) => state.workspace.workspaceMode);
  const activeConversationId = useAppStore(
    (state) => state.workspace.activeConversationId
  );

  const enabledProviderCount = useMemo(
    () => providerOrder.filter((providerId) => providers[providerId]?.enabled).length,
    [providerOrder, providers]
  );
  const hasEnabledProvider = enabledProviderCount > 0;
  const disabledReason = !hasEnabledProvider
    ? t("composer.providerRequiredHint")
    : !selectedModelId
      ? t("composer.modelRequiredHint")
      : null;
  const canSend =
    draft.trim().length > 0 &&
    !isSending &&
    hasEnabledProvider &&
    Boolean(selectedModelId);
  const selectedModelLabel = getModelDisplayName(
    selectedModelId,
    providerModels,
    t("shell.modelUnset")
  );

  useEffect(() => {
    if (draft !== "" || !textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = "34px";
  }, [draft]);

  /** Dispatch the real send action while keeping runtime failures visible in the console. */
  const handleSend = useCallback(async () => {
    if (!canSend) {
      return;
    }

    try {
      await sendMessageAction();
    } catch (error) {
      console.error("[composer] send failed:", error);
    }
  }, [canSend]);

  /** Cancel the active streaming request when the user presses the stop control. */
  const handleStop = useCallback(() => {
    if (activeRequestId) {
      cancelStream(activeRequestId);
    }
  }, [activeRequestId]);

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

  /** Auto-resize the textarea while keeping the composer height under control. */
  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      const element = event.target;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    },
    [setDraft]
  );

  if (!activeConversationId || workspaceMode === "COMPARE") {
    return null;
  }

  return (
    <div className="shrink-0 border-t border-miro-border/10 bg-white/88 px-3 py-3 sm:px-4">
      <div className="mx-auto max-w-5xl">
        <div className="app-panel rounded-[24px] bg-white/96 px-3 py-3 sm:px-4 sm:py-3.5">
          <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-miro-border/10 pb-2">
            <span className="app-status-pill px-2.5 py-1 text-[10px]">
              {hasEnabledProvider
                ? t("shell.connectedCount", { count: enabledProviderCount })
                : t("shell.providersMissing")}
            </span>
            <span className="app-status-pill px-2.5 py-1 text-[10px]">
              {selectedModelLabel}
            </span>
            {!disabledReason ? (
              <p className="text-xs leading-5 text-miro-text-secondary sm:ml-auto">
                {t("composer.shortcutHint")}
              </p>
            ) : null}
          </div>

          <div className="flex items-end gap-2.5">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={disabledReason ?? t("composer.placeholder")}
              rows={1}
              className="min-h-[34px] max-h-[180px] flex-1 resize-none bg-transparent px-1 py-1 font-body text-[15px] leading-6 text-miro-text placeholder:text-miro-placeholder focus:outline-none"
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
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!canSend}
                className={
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] transition-colors " +
                  (canSend
                    ? "bg-miro-blue text-white hover:bg-miro-blue-pressed"
                    : "bg-miro-border/80 text-miro-text-secondary/40")
                }
                title={t("composer.send")}
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
