/**
 * @file AssistantMessageBubble.tsx
 * @description Renders an assistant message with hover-triggered action toolbar.
 *
 * Primary actions: Copy, Regenerate (icon buttons on hover).
 * Secondary actions: Continue from here (more menu).
 */

import { ParallelForkReviewPanel } from "../parallelFork";
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
    <div className="mt-3 rounded-lg border border-miro-amber-light/40 bg-miro-amber-light/80 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-miro-amber">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {t("message.retrying", { attempt, maxAttempts })}
      </div>
      <div className="mt-1 text-xs text-miro-amber">
        {countdown > 0
          ? t("message.retryCountdown", { seconds: countdown })
          : t("message.retryConnecting")}
      </div>
      {errorSummary && (
        <div className="mt-1 truncate text-[11px] text-miro-amber/80" title={errorSummary}>
          {errorSummary}
        </div>
      )}
    </div>
  );
}

/** Store selectors for assistant message rendering. */

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
            <span className="app-status-pill border-miro-border/20 bg-miro-card/80 text-miro-text-secondary">
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

  // Check for pending parallel fork proposals
  const parallelForkProposal = message.toolCalls?.find((tc) => {
    if (tc.functionName !== 'parallel_branch_fork') return false;
    if (!tc.resultJson) return false;
    try {
      const result = JSON.parse(tc.resultJson);
      return result.status === 'PENDING_USER_REVIEW' && result.fork_proposal_id;
    } catch {
      return false;
    }
  });

  const proposalPanel = parallelForkProposal ? (() => {
    try {
      const result = JSON.parse(parallelForkProposal.resultJson);
      return (
        <ParallelForkReviewPanel
          proposalId={result.fork_proposal_id}
          branches={result.branches || []}
          onExecute={async (taskIds: string[]) => {
            console.log('[ParallelFork] Tasks created:', taskIds);
            // Wait for tasks to complete (they usually finish in ~2 seconds)
            const maxAttempts = 20;
            for (let i = 0; i < maxAttempts; i++) {
              await new Promise(r => setTimeout(r, 500));
              try {
                const tasks = await import('../../services/tauriCommands').then(m => m.listTaskQueue());
                const relevant = tasks.filter(t => taskIds.includes(t.id));
                const allDone = relevant.every(t => t.status === 'COMPLETED' || t.status === 'FAILED');
                if (allDone) {
                  console.log('[ParallelFork] All tasks completed, reloading snapshot');
                  const convId = useAppStore.getState().activeSnapshot?.summary.id;
                  if (convId) {
                    await useAppStore.getState().openConversation(convId);
                  }

                  // Auto-trigger AI response for each completed branch (sequentially for RPM)
                  const snapshot = useAppStore.getState().activeSnapshot;
                  if (snapshot) {
                    const completedTaskConfigs = relevant
                      .filter(t => t.status === 'COMPLETED')
                      .map(t => t.config);
                    
                    for (const cfg of completedTaskConfigs) {
                      const branchName = cfg.branch_name;
                      const branchIdFromConfig = cfg.branch_id;
                      const modelId = cfg.model_id || useAppStore.getState().composer.selectedModelId || useAppStore.getState().defaultModelId;
                      if (!modelId || !branchName) continue;

                      // Find the branch by name or ID in the updated snapshot
                      const branchEntry = Object.entries(snapshot.entities.branches)
                        .find(([id, b]) => id === branchIdFromConfig || b.name === branchName);
                      if (!branchEntry) continue;
                      
                      const [branchId, branch] = branchEntry;
                      const headMsgId = branch.headMessageId;
                      if (!headMsgId) continue;

                      const providerId = resolveProviderIdForModel(useAppStore.getState(), modelId);
                      if (!providerId) continue;

                      try {
                        const promptMessages = await tauriCmd.buildPromptMessages({
                          conversationId: convId!,
                          upToMessageId: headMsgId,
                        });

                        const { startAssistantStream } = await import('../../services/streamController');
                        await startAssistantStream({
                          conversationId: convId!,
                          branchId,
                          parentMessageId: headMsgId,
                          providerId,
                          modelId,
                          promptMessages,
                        });
                        console.log('[ParallelFork] AI stream started for branch:', branchName);
                      } catch (streamErr) {
                        console.error('[ParallelFork] Failed to start stream for branch:', branchName, streamErr);
                      }
                    }
                  }
                  break;
                }
              } catch (pollErr) {
                console.error('[ParallelFork] Poll error:', pollErr);
              }
            }
          }}
          onError={(error: Error) => {
            console.error('[ParallelFork] Execution failed:', error);
            // TODO: Show error toast
          }}
        />
      );
    } catch (e) {
      console.error('[ParallelFork] Failed to render panel:', e);
      return null;
    }
  })() : null;

  return (
    <AssistantMessageFrame message={message} footer={footerActions}>
      {blockContent ?? <MarkdownRenderer content={message.content.text} />}
      {blockContent ? null : persistedToolCallSection}
      {proposalPanel}
    </AssistantMessageFrame>
  );
});
