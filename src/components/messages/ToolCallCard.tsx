/**
 * @file ToolCallCard.tsx
 * @description Renders a single tool call as a collapsible card showing
 *              function name, arguments, and execution result.
 */

import { useTranslation } from "react-i18next";
import { memo, useState } from "react";
import { IconChevronDown, IconChevronRight, IconCheck, IconX } from "../common/Icon";
import type { ToolCallInfo } from "../../types/conversation";

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
}

export const ToolCallCard = memo(function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const isSuccess = toolCall.status === "COMPLETED";
  const isPending = toolCall.status === "PENDING";
  const isFailed = toolCall.status === "FAILED";

  let argsDisplay = toolCall.argumentsJson;
  try {
    argsDisplay = JSON.stringify(JSON.parse(toolCall.argumentsJson), null, 2);
  } catch {
    // keep raw string
  }

  let resultDisplay = toolCall.resultJson;
  try {
    resultDisplay = JSON.stringify(JSON.parse(toolCall.resultJson), null, 2);
  } catch {
    // keep raw string
  }

  return (
    <div className="my-1.5 rounded-lg border border-miro-border/20 bg-white/60 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/45"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <IconChevronDown size={14} className="shrink-0 text-miro-text-secondary" />
        ) : (
          <IconChevronRight size={14} className="shrink-0 text-miro-text-secondary" />
        )}

        <code className="font-mono text-xs font-semibold text-miro-blue">
          {toolCall.functionName}
        </code>

        {isPending ? (
          <span className="app-status-pill border-amber-300/40 bg-amber-50/70 text-amber-600">
            {t("toolCall.running")}
          </span>
        ) : isSuccess ? (
          <IconCheck size={14} className="shrink-0 text-emerald-500" />
        ) : (
          <IconX size={14} className="shrink-0 text-miro-red" />
        )}

        {!expanded && toolCall.resultJson && (
          <span className="truncate text-xs text-miro-text-secondary">
            {toolCall.resultJson.length > 60
              ? toolCall.resultJson.slice(0, 60) + "..."
              : toolCall.resultJson}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-miro-border/10 px-3 py-2">
          {argsDisplay && (
            <div className="mb-2">
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-miro-text-secondary">
                {t("toolCall.arguments")}
              </div>
              <pre className="max-h-32 overflow-auto rounded bg-miro-bg px-2 py-1.5 font-mono text-xs leading-relaxed text-miro-text">
                {argsDisplay}
              </pre>
            </div>
          )}
          {resultDisplay && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-miro-text-secondary">
                {t("toolCall.result")}
              </div>
              <pre
                className={`max-h-40 overflow-auto rounded px-2 py-1.5 font-mono text-xs leading-relaxed ${
                  isFailed
                    ? "bg-miro-red-light/40 text-miro-red"
                    : "bg-miro-bg text-miro-text"
                }`}
              >
                {resultDisplay}
              </pre>
            </div>
          )}
          {isFailed && toolCall.errorMessage && (
            <div className="mt-1.5 text-xs text-miro-red">{toolCall.errorMessage}</div>
          )}
        </div>
      )}
    </div>
  );
});
