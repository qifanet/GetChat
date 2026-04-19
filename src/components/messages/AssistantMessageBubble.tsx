/**
 * @file AssistantMessageBubble.tsx
 * @description Renders an assistant message with automatic switching between
 * streaming mode and completed mode.
 *
 * Streaming and markdown surfaces must never render at the same time. This is
 * a hard constraint of the message rendering model.
 */
import { useTranslation } from "react-i18next";
import { memo, useState, type ReactNode } from "react";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { getModelDisplayName } from "../../features/models/modelUtils";
import { resolveProviderIdForModel } from "../../features/composer/sendMessageAction";
import { startAssistantVariantStream } from "../../services/streamController";
import * as tauriCmd from "../../services/tauriCommands";
import { copyTextToClipboard } from "../../utils/clipboard";
import { useStreamingMessage } from "../../hooks/useStreamingMessage";
import { StreamingAssistantContent } from "./StreamingAssistantContent";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { MessageNode } from "../../types/conversation";
const _sel_providerModels = (s: import("../../stores/appStore.types").AppStore) => s.providerModels;
const _sel_workspace_activeConversationId = (s: import("../../stores/appStore.types").AppStore) => s.workspace.activeConversationId;
const _sel_workspace_currentBranchId = (s: import("../../stores/appStore.types").AppStore) => s.workspace.currentBranchId;
const _sel_composer_isSending = (s: import("../../stores/appStore.types").AppStore) => s.composer.isSending;
const _sel_setVariantPreview = (s: import("../../stores/appStore.types").AppStore) => s.setVariantPreview;
const _sel_startHistoryFork = (s: import("../../stores/appStore.types").AppStore) => s.startHistoryFork;
const _sel_setBranchHeadMessage = (s: import("../../stores/appStore.types").AppStore) => s.setBranchHeadMessage;
interface AssistantMessageBubbleProps {
  /** The assistant message to render. */
  message: MessageNode;
}
/** Format a timestamp into a compact local time string. */
function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale.startsWith("zh") ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
/** Shared shell around the assistant content surface. */
function AssistantMessageFrame({
  message,
  children,
  statusText,
  callout,
  footer,
  toneClassName,
}: {
  message: MessageNode;
  children: ReactNode;
  statusText?: string;
  callout?: ReactNode;
  footer?: ReactNode;
  toneClassName?: string;
}) {
  const { t, i18n } = useTranslation();
  const providerModels = useAppStore(_sel_providerModels);
  const modelDisplayName = getModelDisplayName(
    message.generation?.modelId,
    providerModels,
    ""
  );
  return (
    <div className="app-message-card flex justify-start">
      <div className="max-w-[min(860px,100%)]">
        <div className="mb-2 flex items-center gap-2">
          <span className="app-message-avatar app-message-avatar-assistant">AI</span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-miro-blue">
            {t("common.assistant")}
          </span>
          <span className="text-[11px] font-medium text-miro-text-secondary">
            {formatTime(message.createdAt, i18n.language)}
          </span>
          {modelDisplayName ? (
            <span className="app-status-pill border-miro-blue/15 bg-miro-blue-light/65 text-miro-blue">
              {t("message.modelUsed", { name: modelDisplayName })}
            </span>
          ) : null}
          {statusText ? (
            <span className="app-status-pill border-miro-border/20 bg-white/80 text-miro-text-secondary">
              {statusText}
            </span>
          ) : null}
        </div>
        <div className={toneClassName ?? "assistant-message-bubble completed"}>{children}</div>
        {callout ? <div className="mt-3">{callout}</div> : null}
        {footer ? <div className="mt-3">{footer}</div> : null}
      </div>
    </div>
  );
}
/** Assistant message bubble with automatic streaming and completed switching. */
export const AssistantMessageBubble = memo(function AssistantMessageBubble({
  message,
}: AssistantMessageBubbleProps) {
  const { t } = useTranslation();
  const { isStreaming, requestId, rendererMode } = useStreamingMessage(message);
  const activeConversationId = useAppStore(_sel_workspace_activeConversationId);
  const currentBranchId = useAppStore(_sel_workspace_currentBranchId);
  const parentMessage = useAppStore((state) =>
    message.parentId ? state.activeSnapshot?.entities.messages[message.parentId] ?? null : null
  );
  const isSending = useAppStore(_sel_composer_isSending);
  const setVariantPreview = useAppStore(_sel_setVariantPreview);
  const startHistoryFork = useAppStore(_sel_startHistoryFork);
  const setBranchHeadMessage = useAppStore(_sel_setBranchHeadMessage);
  const currentBranchHeadMessageId = useAppStore((state) => {
    const branchId = state.workspace.currentBranchId;
    return branchId ? state.activeSnapshot?.entities.branches[branchId]?.headMessageId ?? null : null;
  });
  const [copied, setCopied] = useState(false);
  const isUserCancelled =
    message.status === "FAILED" && message.error?.code === "USER_CANCELLED";
  const showRetryGuidance =
    message.status === "FAILED" && Boolean(message.error?.retriable);
  const canRegenerate = Boolean(
    activeConversationId &&
      currentBranchId &&
      parentMessage?.role === "USER" &&
      !isStreaming &&
      !isSending
  );
  const canPromoteToCurrentPath =
    Boolean(currentBranchId) && currentBranchHeadMessageId !== message.id;
  /** Copy the assistant response to the clipboard. */
  async function handleCopy(): Promise<void> {
    await copyTextToClipboard(message.content.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  /** Start a non-destructive continuation flow from this assistant message. */
  function handleContinueFromHere(): void {
    if (!currentBranchId) {
      return;
    }
    startHistoryFork({
      sourceType: "HISTORY_ASSISTANT",
      sourceBranchId: currentBranchId,
      sourceMessageId: message.id,
    });
  }
  /** Promote a preview or historical assistant message to the current branch head. */
  async function handleApplyToCurrentPath(): Promise<void> {
    if (!currentBranchId) {
      return;
    }
    await setBranchHeadMessage(currentBranchId, message.id);
    setVariantPreview(null);
  }
  /** Regenerate this assistant reply as a variant, preserving history by default. */
  async function handleRegenerate(): Promise<void> {
    if (!activeConversationId || !currentBranchId || parentMessage?.role !== "USER") {
      return;
    }
    const state = useAppStore.getState();
    const modelId = state.composer.selectedModelId ?? message.generation?.modelId;
    if (!modelId) {
      return;
    }
    const providerId = resolveProviderIdForModel(state, modelId);
    const isCurrentLeaf =
      (state.activeSnapshot?.entities.branches[currentBranchId]?.headMessageId ?? null) ===
      message.id;
    const hasDownstreamConflict = !isCurrentLeaf || message.childIds.length > 0;
    const promptMessages = await tauriCmd.buildPromptMessages({
      conversationId: activeConversationId,
      upToMessageId: parentMessage.id,
    });
    await startAssistantVariantStream({
      conversationId: activeConversationId,
      branchId: currentBranchId,
      parentMessageId: parentMessage.id,
      userMessageId: parentMessage.id,
      providerId,
      modelId,
      promptMessages,
      generationParams: {
        ...state.composer.params,
      },
      hasDownstreamConflict,
      promoteOnComplete: !hasDownstreamConflict,
      rendererMode: "DOM_TEXT",
    });
  }
  const footerActions = !isStreaming ? (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="rounded-full border border-miro-border/60 bg-white/88 px-3 py-1.5 text-xs font-medium text-miro-text-secondary transition-colors hover:border-miro-border hover:text-miro-text"
      >
        {copied ? t("message.copied") : t("message.copy")}
      </button>
      {canRegenerate ? (
        <button
          type="button"
          onClick={() => void handleRegenerate()}
          className="rounded-full border border-miro-border/60 bg-white/88 px-3 py-1.5 text-xs font-medium text-miro-text-secondary transition-colors hover:border-miro-border hover:text-miro-text"
        >
          {t("message.regenerate")}
        </button>
      ) : null}
      {currentBranchId ? (
        <button
          type="button"
          onClick={handleContinueFromHere}
          className="rounded-full border border-miro-border/60 bg-white/88 px-3 py-1.5 text-xs font-medium text-miro-text-secondary transition-colors hover:border-miro-border hover:text-miro-text"
        >
          {t("message.continueFromHere")}
        </button>
      ) : null}
      {canPromoteToCurrentPath ? (
        <button
          type="button"
          onClick={() => void handleApplyToCurrentPath()}
          className="rounded-full border border-miro-blue/20 bg-miro-blue-light/70 px-3 py-1.5 text-xs font-medium text-miro-blue transition-colors hover:border-miro-blue/30"
        >
          {t("message.applyToCurrentBranch")}
        </button>
      ) : null}
    </div>
  ) : null;
  if (isStreaming && requestId) {
    return (
      <AssistantMessageFrame
        message={message}
        statusText={t("message.generating")}
        footer={footerActions}
        toneClassName="assistant-message-bubble streaming"
      >
        <StreamingAssistantContent
          requestId={requestId}
          rendererMode={rendererMode}
        />
      </AssistantMessageFrame>
    );
  }
  if (isUserCancelled) {
    return (
      <AssistantMessageFrame
        message={message}
        statusText={t("message.generationStopped")}
        footer={footerActions}
        toneClassName="assistant-message-bubble aborted"
      >
        <MarkdownRenderer content={message.content.text} />
      </AssistantMessageFrame>
    );
  }
  if (message.status === "FAILED") {
    return (
      <AssistantMessageFrame
        message={message}
        statusText={t("message.generationStopped")}
        toneClassName="assistant-message-bubble failed"
        footer={footerActions}
        callout={
          message.error ? (
            <div className="assistant-message-callout border-miro-red/35 bg-miro-red-light/70 text-miro-red">
              <p>{t("message.generationFailed", { message: message.error.message })}</p>
              {showRetryGuidance ? (
                <p className="mt-2 text-xs leading-5 text-miro-red/85">
                  {t("message.generationRetryHint")}
                </p>
              ) : null}
            </div>
          ) : null
        }
      >
        <MarkdownRenderer content={message.content.text} />
      </AssistantMessageFrame>
    );
  }
  if (message.status === "ABORTED") {
    return (
      <AssistantMessageFrame
        message={message}
        statusText={t("message.generationStopped")}
        footer={footerActions}
        toneClassName="assistant-message-bubble aborted"
      >
        <MarkdownRenderer content={message.content.text} />
      </AssistantMessageFrame>
    );
  }
  return (
    <AssistantMessageFrame message={message} footer={footerActions}>
      <MarkdownRenderer content={message.content.text} />
    </AssistantMessageFrame>
  );
});
