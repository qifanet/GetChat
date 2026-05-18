/**
 * @file AssistantMessageBubble.tsx
 * @description Renders an assistant message with hover-triggered action toolbar.
 *
 * Primary actions: Copy, Regenerate (icon buttons on hover).
 * Secondary actions: Continue from here (more menu).
 */

import { useTranslation } from "react-i18next";
import { memo, useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { useStreamStore } from "../../stores/useStreamStore";
import { getModelDisplayName } from "../../features/models/modelUtils";
import { resolveProviderIdForModel } from "../../features/composer/sendMessageAction";
import { startAssistantVariantStream } from "../../services/streamController";
import * as tauriCmd from "../../services/tauriCommands";
import { copyTextToClipboard } from "../../utils/clipboard";
import { useStreamingMessage } from "../../hooks/useStreamingMessage";
import { useStreamingToolCalls } from "../../hooks/useStreamingToolCalls";
import { StreamingAssistantContent } from "./StreamingAssistantContent";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallChain } from "./ToolCallChain";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { IconCopy, IconCheck, IconRefresh, IconBranch } from "../common/Icon";
import {
  MessageActionToolbar,
  MessageActionButton,
  MessageActionMoreMenu,
} from "./MessageActionToolbar";
import type { MessageNode } from "../../types/conversation";

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatTokenK(tokens: number): string {
  return `${(Math.max(0, tokens) / 1000).toFixed(1)}K`;
}

/** Retry status card — shows countdown during automatic retry attempts. */
function RetryStatusCard({
  attempt,
  maxAttempts,
  nextRetryInSecs,
  errorSummary,
}: {
  attempt: number;
  maxAttempts: number;
  nextRetryInSecs: number;
  errorSummary: string;
}) {
  const { t } = useTranslation();
  const [countdown, setCountdown] = useState(nextRetryInSecs);

  useEffect(() => {
    setCountdown(nextRetryInSecs);
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [nextRetryInSecs]);

  return (
    <div className="mt-3 rounded-lg border border-amber-300/40 bg-amber-50/80 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {t("message.retrying", { attempt, maxAttempts })}
      </div>
      <div className="mt-1 text-xs text-amber-600">
        {countdown > 0
          ? t("message.retryCountdown", { seconds: countdown })
          : t("message.retryConnecting")}
      </div>
      {errorSummary && (
        <div className="mt-1 truncate text-[11px] text-amber-500/80" title={errorSummary}>
          {errorSummary}
        </div>
      )}
    </div>
  );
}

/** Context compressing card — shown during mid-loop context optimization. */
function ContextCompressingCard({
  level,
  usageRatio,
}: {
  level: number;
  usageRatio: number;
}) {
  const { t } = useTranslation();
  const percent = Math.round(finiteNumber(usageRatio) * 100);
  return (
    <div className="mt-3 rounded-lg border border-blue-300/40 bg-blue-50/80 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-blue-700">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {t("message.contextCompressing", { level })}
      </div>
      <div className="mt-1 text-xs text-blue-600">
        {t("message.contextUsageHint", { percent })}
      </div>
    </div>
  );
}

/** In-flight ReAct loop context status pushed by the backend. */
function ContextWindowStatusCard({
  usedTokens,
  totalTokens,
  percentage,
  messageCount,
}: {
  usedTokens: number;
  totalTokens: number;
  percentage: number;
  messageCount: number;
}) {
  const { t } = useTranslation();
  const safePercentage = finiteNumber(percentage);
  const percent = Math.round(safePercentage);
  const width = Math.min(Math.max(safePercentage, 0), 100);
  return (
    <div className="mt-3 rounded-lg border border-miro-border/30 bg-white/80 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3 text-xs text-miro-text-secondary">
        <span>
          {t("message.contextWindowStatus", {
            percent,
            used: formatTokenK(finiteNumber(usedTokens)),
            total: formatTokenK(finiteNumber(totalTokens)),
            count: messageCount,
          })}
        </span>
        <span className="shrink-0 font-medium text-miro-text">{percent}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-miro-border/40">
        <div
          className="h-full rounded-full bg-miro-blue transition-all duration-300"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

/** Context compressed card — shown briefly after compression completes. */
function ContextCompressedCard({
  compressedCount,
  tokensSaved,
  newUsageRatio,
}: {
  compressedCount: number;
  tokensSaved: number;
  newUsageRatio: number;
}) {
  const { t } = useTranslation();
  const percent = Math.round(finiteNumber(newUsageRatio) * 100);
  return (
    <div className="mt-3 rounded-lg border border-green-300/40 bg-green-50/80 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-green-700">
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
        </svg>
        {t("message.contextCompressed", { count: compressedCount })}
      </div>
      <div className="mt-1 text-xs text-green-600">
        {t("message.contextCompressedDetail", {
          percent,
          saved: tokensSaved > 0 ? `~${tokensSaved}` : "",
        })}
      </div>
    </div>
  );
}

const _sel_providerModels = (s: import("../../stores/appStore.types").AppStore) => s.providerModels;
const _sel_workspace_activeConversationId = (s: import("../../stores/appStore.types").AppStore) => s.workspace.activeConversationId;
const _sel_workspace_currentBranchId = (s: import("../../stores/appStore.types").AppStore) => s.workspace.currentBranchId;
const _sel_composer_isSending = (s: import("../../stores/appStore.types").AppStore) => s.composer.isSending;
const _sel_startHistoryFork = (s: import("../../stores/appStore.types").AppStore) => s.startHistoryFork;

interface AssistantMessageBubbleProps {
  message: MessageNode;
}

function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale.startsWith("zh") ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

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
    <div className="app-message-card group/message flex flex-col items-start" data-message-id={message.id}>
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
      </div>
      {footer ? (
        <div className="mt-1.5 max-w-[min(860px,100%)]">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

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
  const startHistoryFork = useAppStore(_sel_startHistoryFork);

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
  async function handleCopy(): Promise<void> {
    await copyTextToClipboard(message.content.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function handleContinueFromHere(): void {
    if (!currentBranchId) return;
    startHistoryFork({
      sourceType: "HISTORY_ASSISTANT",
      sourceBranchId: currentBranchId,
      sourceMessageId: message.id,
    });
  }

  async function handleRegenerate(): Promise<void> {
    if (!activeConversationId || !currentBranchId || parentMessage?.role !== "USER") return;
    const state = useAppStore.getState();
    const modelId = state.composer.selectedModelId ?? message.generation?.modelId;
    if (!modelId) return;
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
      generationParams: { ...state.composer.params },
      hasDownstreamConflict,
      rendererMode: "DOM_TEXT",
    });
  }

  const moreMenuItems = currentBranchId
    ? [
        {
          label: t("message.continueFromHere"),
          onClick: handleContinueFromHere,
          icon: <IconBranch size={14} />,
        },
      ]
    : [];

  const footerActions = !isStreaming ? (
    <MessageActionToolbar align="left">
      <MessageActionButton
        icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        label={copied ? t("message.copied") : t("message.copy")}
        onClick={() => void handleCopy()}
      />
      {canRegenerate ? (
        <MessageActionButton
          icon={<IconRefresh size={14} />}
          label={t("message.regenerate")}
          onClick={() => void handleRegenerate()}
        />
      ) : null}
      <MessageActionMoreMenu items={moreMenuItems} />
    </MessageActionToolbar>
  ) : null;

  // Tool calls section rendered after markdown content
  const persistedToolCallSection =
    message.toolCalls && message.toolCalls.length > 0 ? (
      <ToolCallChain toolCalls={message.toolCalls} />
    ) : null;

  // During streaming, get tool calls from runtime registry
  const streamingToolCalls = useStreamingToolCalls(isStreaming ? requestId : null);
  const streamingToolCallSection = streamingToolCalls.length > 0 ? (
    <ToolCallChain toolCalls={streamingToolCalls} />
  ) : null;

  // Pending tool approval — read at top level (hooks can't be conditional)
  const pendingApproval = useStreamStore(
    (s) => (isStreaming && requestId ? s.sessionsByRequestId[requestId]?.pendingApproval : undefined)
  );

  // Retry state — show countdown when backend is retrying
  const retryState = useStreamStore(
    (s) => (isStreaming && requestId ? s.sessionsByRequestId[requestId]?.retrying : undefined)
  );

  if (isStreaming && requestId) {
    return (
      <AssistantMessageFrame
        message={message}
        statusText={t("message.generating")}
        footer={footerActions}
      >
        <StreamingAssistantContent
          requestId={requestId}
          rendererMode={rendererMode}
        />
        {streamingToolCallSection}
        {retryState ? (
          <RetryStatusCard
            attempt={retryState.attempt}
            maxAttempts={retryState.maxAttempts}
            nextRetryInSecs={retryState.nextRetryInSecs}
            errorSummary={retryState.errorSummary}
          />
        ) : null}
        {pendingApproval ? (
          <ToolApprovalCard
            requestId={requestId}
            approvalId={pendingApproval.approvalId}
            functionName={pendingApproval.functionName}
            description={pendingApproval.description}
            timeoutSecs={pendingApproval.timeoutSecs}
            receivedAt={pendingApproval.receivedAt}
          />
        ) : null}
      </AssistantMessageFrame>
    );
  }

  // Determine if we should use block-level rendering (inline tool display)
  const hasContentBlocks = message.content.blocks && message.content.blocks.length > 0 &&
    message.content.blocks.some(b => b.type !== "text");
  const blockContent = hasContentBlocks && message.content.blocks ? (
    <ContentBlockRenderer blocks={message.content.blocks} />
  ) : null;

  if (isUserCancelled) {
    return (
      <AssistantMessageFrame
        message={message}
        statusText={t("message.generationStopped")}
        footer={footerActions}
        toneClassName="assistant-message-bubble aborted"
      >
        {blockContent ?? <MarkdownRenderer content={message.content.text} />}
        {blockContent ? null : persistedToolCallSection}
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
        {blockContent ?? <MarkdownRenderer content={message.content.text} />}
        {blockContent ? null : persistedToolCallSection}
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
        {blockContent ?? <MarkdownRenderer content={message.content.text} />}
        {blockContent ? null : persistedToolCallSection}
      </AssistantMessageFrame>
    );
  }

  return (
    <AssistantMessageFrame message={message} footer={footerActions}>
      {blockContent ?? <MarkdownRenderer content={message.content.text} />}
      {blockContent ? null : persistedToolCallSection}
    </AssistantMessageFrame>
  );
});
