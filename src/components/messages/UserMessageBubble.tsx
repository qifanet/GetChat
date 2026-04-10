/**
 * @file UserMessageBubble.tsx
 * @description Renders a user message bubble in the chat area.
 *
 * The user message is right-aligned and treated as an authored instruction
 * block within the desktop workspace rather than a consumer chat bubble.
 */

import { useTranslation } from "react-i18next";
import { memo, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import type { MessageNode } from "../../types/conversation";
import { copyTextToClipboard } from "../../utils/clipboard";

interface UserMessageBubbleProps {
  /** The user message to render. */
  message: MessageNode;
}

/** Format a timestamp into a compact local time string. */
function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale.startsWith("zh") ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** Render a right-aligned user message surface. */
export const UserMessageBubble = memo(function UserMessageBubble({
  message,
}: UserMessageBubbleProps) {
  const { t, i18n } = useTranslation();
  const currentBranchId = useAppStore((state) => state.workspace.currentBranchId);
  const setDraft = useAppStore((state) => state.setDraft);
  const startEditFork = useAppStore((state) => state.startEditFork);
  const [copied, setCopied] = useState(false);

  /** Copy the current user message text to the clipboard. */
  async function handleCopy(): Promise<void> {
    await copyTextToClipboard(message.content.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  /** Load the message back into the composer and enter edit-fork mode. */
  function handleReEdit(): void {
    if (!currentBranchId) {
      return;
    }

    setDraft(message.content.text);
    startEditFork({
      sourceType: "HISTORY_USER_EDIT",
      sourceBranchId: currentBranchId,
      sourceMessageId: message.parentId ?? null,
      originalEditableMessageId: message.id,
    });
  }

  return (
    <div className="app-message-card flex justify-end">
      <div className="max-w-[min(760px,82%)]">
        <div className="mb-2 flex items-center justify-end gap-2">
          {message.editedFromMessageId ? (
            <span className="app-status-pill border-miro-border/20 bg-white/80 text-miro-text-secondary">
              {t("message.edited")}
            </span>
          ) : null}
          <span className="text-[11px] font-medium text-miro-text-secondary">
            {formatTime(message.createdAt, i18n.language)}
          </span>
          <span className="app-message-avatar app-message-avatar-user">
            {t("common.user").slice(0, 1)}
          </span>
        </div>

        <div className="rounded-[26px] rounded-tr-[10px] border border-miro-blue/12 bg-miro-blue-light px-5 py-4 text-[15px] leading-7 text-miro-text shadow-ring">
          <p className="whitespace-pre-wrap break-words">{message.content.text}</p>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded-full border border-miro-border/60 bg-white/88 px-3 py-1.5 text-xs font-medium text-miro-text-secondary transition-colors hover:border-miro-border hover:text-miro-text"
          >
            {copied ? t("message.copied") : t("message.copy")}
          </button>
          <button
            type="button"
            onClick={handleReEdit}
            className="rounded-full border border-miro-border/60 bg-white/88 px-3 py-1.5 text-xs font-medium text-miro-text-secondary transition-colors hover:border-miro-border hover:text-miro-text"
          >
            {t("message.reEdit")}
          </button>
        </div>
      </div>
    </div>
  );
});
