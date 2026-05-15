/**
 * @file UserMessageBubble.tsx
 * @description Renders a user message bubble with hover-triggered action toolbar.
 *
 * Actions: Copy (primary), Edit (primary), Continue from here (more menu).
 * Toolbar appears on hover via Tailwind group/group-hover/message.
 */

import { useTranslation } from "react-i18next";
import { memo, useState } from "react";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { IconCopy, IconCheck, IconPencilSquare, IconBranch } from "../common/Icon";
import {
  MessageActionButton,
  MessageActionMoreMenu,
} from "./MessageActionToolbar";
import type { MessageNode } from "../../types/conversation";
import { copyTextToClipboard } from "../../utils/clipboard";

const _sel_workspace_currentBranchId = (s: import("../../stores/appStore.types").AppStore) => s.workspace.currentBranchId;
const _sel_setDraft = (s: import("../../stores/appStore.types").AppStore) => s.setDraft;
const _sel_startEditInline = (s: import("../../stores/appStore.types").AppStore) => s.startEditInline;
const _sel_startHistoryFork = (s: import("../../stores/appStore.types").AppStore) => s.startHistoryFork;

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

/** Render a right-aligned user message surface with hover action toolbar. */
export const UserMessageBubble = memo(function UserMessageBubble({
  message,
}: UserMessageBubbleProps) {
  const { t, i18n } = useTranslation();
  const currentBranchId = useAppStore(_sel_workspace_currentBranchId);
  const setDraft = useAppStore(_sel_setDraft);
  const startEditInline = useAppStore(_sel_startEditInline);
  const startHistoryFork = useAppStore(_sel_startHistoryFork);

  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    await copyTextToClipboard(message.content.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function handleReEdit(): void {
    if (!currentBranchId) return;
    setDraft(message.content.text);
    startEditInline(message.id);
  }

  function handleContinueFromHere(): void {
    if (!currentBranchId) return;
    startHistoryFork({
      sourceType: "HISTORY_USER_EDIT",
      sourceBranchId: currentBranchId,
      sourceMessageId: message.id,
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

  return (
    <div className="app-message-card group/message flex flex-col items-end" data-message-id={message.id}>
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
      </div>
      <div className="mt-1.5 flex max-w-[min(760px,82%)] items-center gap-0.5 justify-end opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
        <MessageActionButton
          icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          label={copied ? t("message.copied") : t("message.copy")}
          onClick={() => void handleCopy()}
        />
        <MessageActionButton
          icon={<IconPencilSquare size={14} />}
          label={t("message.reEdit")}
          onClick={handleReEdit}
        />
        <MessageActionMoreMenu items={moreMenuItems} />
      </div>
    </div>
  );
});
