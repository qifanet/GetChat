/**
 * @file ToolApprovalCard.tsx
 * @description Inline approval card shown during streaming when a destructive
 *              tool requires user consent.
 *
 * Shows tool name, description, and Approve/Reject buttons.
 * Auto-rejects according to the backend-provided timeout.
 */

import { memo, useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as tauriCmd from "../../services/tauriCommands";

interface ToolApprovalCardProps {
  requestId: string;
  approvalId: string;
  functionName: string;
  description: string;
  timeoutSecs: number;
  receivedAt: number;
}

export const ToolApprovalCard = memo(function ToolApprovalCard({
  requestId,
  approvalId,
  functionName,
  description,
  timeoutSecs,
  receivedAt,
}: ToolApprovalCardProps) {
  const { t } = useTranslation();
  const timeoutMs = Math.max(1, timeoutSecs) * 1000;
  const [resolved, setResolved] = useState<"approved" | "rejected" | null>(null);
  const [remaining, setRemaining] = useState(
    Math.max(0, timeoutMs - (Date.now() - receivedAt))
  );
  const resolvedRef = useRef<"approved" | "rejected" | null>(null);

  const resolve = useCallback(
    async (action: "approved" | "rejected", approved: boolean) => {
      if (resolvedRef.current) return;
      resolvedRef.current = action;
      setResolved(action);
      try {
        await tauriCmd.approveToolAction(approvalId, approved);
      } catch (err) {
        console.error("[approval] failed to send", action, err);
      }
    },
    [approvalId]
  );

  const handleApprove = useCallback(() => resolve("approved", true), [resolve]);
  const handleReject = useCallback(() => resolve("rejected", false), [resolve]);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - receivedAt;
      const left = timeoutMs - elapsed;
      if (left <= 0) {
        clearInterval(interval);
        resolve("rejected", false);
      } else {
        setRemaining(left);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [receivedAt, resolve, timeoutMs]);

  const secondsLeft = Math.ceil(remaining / 1000);
  const isExpired = remaining <= 0;

  if (resolved === "approved") {
    return (
      <div className="my-1.5 rounded-lg border border-emerald-200/60 bg-emerald-50/50 px-3 py-2 text-xs text-emerald-700">
        {t("toolCall.approvalApproved", { fn: functionName })}
      </div>
    );
  }

  if (resolved === "rejected" || isExpired) {
    return (
      <div className="my-1.5 rounded-lg border border-miro-red/20 bg-miro-red-light/30 px-3 py-2 text-xs text-miro-red">
        {isExpired && !resolved
          ? t("toolCall.approvalTimeout", { fn: functionName })
          : t("toolCall.approvalRejected", { fn: functionName })}
      </div>
    );
  }

  return (
    <div className="my-1.5 rounded-lg border border-amber-300/50 bg-amber-50/60 text-sm">
      <div className="px-3 py-2">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          <code className="font-mono text-xs font-semibold text-amber-800">
            {functionName}
          </code>
          <span className="app-status-pill border-amber-300/40 bg-amber-100/70 text-amber-600">
            {t("toolCall.approvalRequired")}
          </span>
        </div>
        <p className="mb-2 text-xs text-amber-900/80">{description}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
            onClick={() => void handleApprove()}
          >
            {t("toolCall.approve")}
          </button>
          <button
            type="button"
            className="rounded-md bg-miro-red/80 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-miro-red"
            onClick={() => void handleReject()}
          >
            {t("toolCall.reject")}
          </button>
          <span className="ml-auto text-[10px] text-amber-600/70">
            {t("toolCall.approvalCountdown", { seconds: secondsLeft })}
          </span>
        </div>
      </div>
    </div>
  );
});
