/**
 * @file CompareColumn.tsx
 * @description Read-only branch column used in compare mode.
 *
 * Each column behaves like a focused review surface: branch identity at the
 * top, then a scrollable stack of diverged messages underneath.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getBranchDisplayName } from "../../i18n/displayNames";
import type { MessageNode } from "../../types/conversation";
import { MarkdownRenderer } from "../messages/MarkdownRenderer";

interface CompareColumnProps {
  /** Branch name displayed as column header. */
  branchName: string;

  /** Whether this branch is the mainline. */
  isMainline: boolean;

  /** Diverged messages for this column. */
  messages: MessageNode[];
}

/** Render one side of the compare workspace. */
export function CompareColumn({
  branchName,
  isMainline,
  messages,
}: CompareColumnProps) {
  const { t } = useTranslation();
  const displayBranchName = getBranchDisplayName(branchName, t);

  return (
    <div className="app-soft-panel flex min-h-0 min-w-0 flex-1 flex-col rounded-shell bg-white/96">
      <div className="flex items-center gap-2 border-b border-miro-border/10 px-4 py-4">
        <span className="truncate font-display text-base font-semibold tracking-[-0.03em] text-miro-text">
          {displayBranchName}
        </span>
        {isMainline ? (
          <span className="app-status-pill border-miro-green/20 bg-miro-green-light/80 text-miro-green">
            {t("common.mainline")}
          </span>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-miro-text-secondary">
            {t("compare.noDivergedMessages")}
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <CompareMessageItem key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Render a single read-only message inside a compare column. */
function CompareMessageItem({ message }: { message: MessageNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isUser = message.role === "USER";
  const fullText = message.content?.text ?? "";
  const collapseThreshold = 300;
  const shouldTruncate = fullText.length > collapseThreshold && !expanded;
  const displayText = shouldTruncate
    ? `${fullText.slice(0, collapseThreshold)}...`
    : fullText;

  return (
    <div
      className={`rounded-[24px] px-4 py-4 shadow-ring ${
        isUser
          ? "bg-miro-blue-light text-miro-text"
          : "bg-white text-miro-text"
      }`}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wide ${
            isUser ? "text-miro-text-secondary" : "text-miro-blue"
          }`}
        >
          {isUser ? t("common.user") : t("common.assistant")}
        </span>
      </div>

      <div className="text-sm leading-relaxed">
        {isUser ? (
          <p className="whitespace-pre-wrap">{displayText}</p>
        ) : (
          <MarkdownRenderer content={displayText} />
        )}
      </div>

      {fullText.length > collapseThreshold ? (
        <button
          type="button"
          className="mt-2 text-[10px] font-semibold text-miro-text-secondary hover:text-miro-text"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("common.collapse") : t("common.expandAll")}
        </button>
      ) : null}
    </div>
  );
}
