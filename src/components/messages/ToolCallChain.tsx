/**
 * @file ToolCallChain.tsx
 * @description Renders a chain of tool calls associated with an assistant message.
 *              Shows a collapsible list of ToolCallCard components.
 */

import { useTranslation } from "react-i18next";
import { memo, useState } from "react";
import { IconChevronDown, IconChevronRight } from "../common/Icon";
import { ToolCallCard } from "./ToolCallCard";
import type { ToolCallInfo } from "../../types/conversation";

interface ToolCallChainProps {
  toolCalls: ToolCallInfo[];
}

export const ToolCallChain = memo(function ToolCallChain({ toolCalls }: ToolCallChainProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  if (toolCalls.length === 0) return null;

  const completedCount = toolCalls.filter((tc) => tc.status === "COMPLETED").length;
  const failedCount = toolCalls.filter((tc) => tc.status === "FAILED").length;
  const hasPending = toolCalls.some((tc) => tc.status === "PENDING");

  return (
    <div className="my-2">
      <button
        type="button"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium text-miro-text-secondary transition-colors hover:text-miro-text"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? (
          <IconChevronRight size={12} className="shrink-0" />
        ) : (
          <IconChevronDown size={12} className="shrink-0" />
        )}
        <span>
          {t("toolCall.toolCallsCount", {
            total: toolCalls.length,
            completed: completedCount,
            failed: failedCount,
          })}
        </span>
        {hasPending && (
          <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        )}
      </button>

      {!collapsed && (
        <div className="space-y-1">
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.callId} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
});
