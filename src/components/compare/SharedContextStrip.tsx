/**
 * @file SharedContextStrip.tsx
 * @description Collapsible strip showing shared context messages.
 *
 * Shared context is intentionally compressed to keep compare mode focused on
 * divergence, with optional expansion for quick review.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessageNode } from "../../types/conversation";
import { IconChevronDown, IconChevronUp, IconInfoCircle } from "../common/Icon";

interface SharedContextStripProps {
  /** Shared context messages from root to fork point. */
  messages: MessageNode[];
}

/** Render the shared-context strip used above the compare columns. */
export function SharedContextStrip({ messages }: SharedContextStripProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (messages.length === 0) {
    return (
      <div className="rounded-panel bg-white/82 px-4 py-3 text-center shadow-ring">
        <span className="text-sm leading-6 text-miro-text-secondary">
          {t("compare.noSharedContext")}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-panel bg-miro-teal-light/35 shadow-ring">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 rounded-panel px-4 py-3 text-left transition-colors hover:bg-white/35"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-white text-miro-teal shadow-ring">
            <IconInfoCircle size={14} />
          </span>
          <div className="min-w-0">
            <p className="app-section-label mb-1">
              {t("compare.sharedContext", { count: messages.length })}
            </p>
            <p className="text-sm leading-6 text-miro-text-secondary">
              {t("compare.sharedContextHint")}
            </p>
          </div>
        </div>
        <span className="app-status-pill border-white/80 bg-white/80 text-miro-text-secondary">
          {expanded ? t("common.collapse") : t("common.expand")}
          {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-miro-border/10 px-4 pb-4 pt-3">
          <div className="space-y-2">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`rounded-2xl px-3 py-3 text-sm shadow-ring ${
                  message.role === "USER"
                    ? "bg-white text-miro-text"
                    : "bg-white/90 text-miro-text-secondary"
                }`}
              >
                <span className="mr-2 inline-flex rounded-full bg-miro-bg px-2 py-1 text-[10px] font-display font-semibold uppercase tracking-[0.12em] text-miro-text-secondary">
                  {message.role === "USER"
                    ? `${t("common.user")}:`
                    : `${t("common.assistant")}:`}
                </span>
                <span className="line-clamp-2 leading-6">
                  {(message.content?.text ?? "").slice(0, 120)}
                  {(message.content?.text ?? "").length > 120 ? "..." : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
