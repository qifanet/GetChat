/**
 * @file AgentMetricsPanel.tsx
 * @description Collapsed-by-default loop metrics panel (v1.5.0 M5.3).
 *
 * Lives at the bottom of the branch sidebar. Expanding it loads the most
 * recent agent-run audit trails for the current conversation from the
 * `agent_runs` table (backend-persisted by the RunAuditor seam) and shows
 * turns, token usage, wall time, and per-call tool timings. While the latest
 * run is still active, it polls at a low frequency until the run settles.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as tauriCmd from "../../services/tauriCommands";
import {
  asAgentRunApprovals,
  asAgentRunTurns,
  type AgentRunDto,
} from "../../types/agentRuns";
import { downloadTextFile } from "../../utils/downloadFile";
import { useAppStore } from "../../stores/useAppStoreSelector";
import {
  IconChevronDown,
  IconChevronUp,
  IconRefresh,
} from "../common/Icon";

const _sel_conversationId = (s: import("../../stores/appStore.types").AppStore) =>
  s.activeSnapshot?.summary.id ?? null;

const POLL_ACTIVE_MS = 5000;

/** Format a wall-time duration for compact display. */
function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** Total prompt + completion tokens across a run's turns (null when unknown). */
function totalTokens(run: AgentRunDto): number | null {
  let total = 0;
  let seen = false;
  for (const turn of asAgentRunTurns(run.turns)) {
    if (turn.promptTokens != null) {
      total += turn.promptTokens;
      seen = true;
    }
    if (turn.completionTokens != null) {
      total += turn.completionTokens;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Collapsed-by-default agent run metrics for the current conversation. */
export function AgentMetricsPanel() {
  const { t } = useTranslation();
  const conversationId = useAppStore(_sel_conversationId);
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<AgentRunDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!conversationId) {
      setRuns([]);
      return;
    }
    try {
      const recent = await tauriCmd.listAgentRuns(conversationId, 3);
      setRuns(recent);
    } catch (err) {
      console.error("[agentMetrics] failed to load runs:", err);
    } finally {
      setLoaded(true);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!expanded) return;
    void fetchRuns();
  }, [expanded, fetchRuns]);

  // While a run is in flight, keep the panel fresh; stop once it settles.
  const latestActive = runs.length > 0 && runs[0].outcome == null;
  useEffect(() => {
    if (!expanded || !latestActive) return;
    reloadTimer.current = setTimeout(() => void fetchRuns(), POLL_ACTIVE_MS);
    return () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, [expanded, latestActive, runs, fetchRuns]);

  if (!conversationId) return null;

  async function handleExport(run: AgentRunDto) {
    setExportingId(run.id);
    try {
      const trail = await tauriCmd.exportAgentRun(run.id);
      if (trail) {
        await downloadTextFile(
          JSON.stringify(trail, null, 2),
          `agent-run-${run.id.slice(0, 8)}.json`
        );
      }
    } catch (err) {
      console.error("[agentMetrics] export failed:", err);
    } finally {
      setExportingId(null);
    }
  }

  return (
    <div className="mt-3 border-t border-miro-border/10 pt-3">
      <div className="flex items-center justify-between px-1">
        <button
          type="button"
          className="flex flex-1 items-center gap-1 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          <span className="text-[10px] font-medium uppercase tracking-wider text-miro-text-secondary">
            {t("metrics.title")}
          </span>
        </button>
        {expanded && (
          <button
            type="button"
            className="app-icon-button h-6 w-6"
            onClick={() => void fetchRuns()}
            title={t("metrics.refresh")}
          >
            <IconRefresh size={11} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-2 space-y-2">
          {!loaded ? null : runs.length === 0 ? (
            <p className="px-1 text-xs text-miro-text-secondary/60">
              {t("metrics.empty")}
            </p>
          ) : (
            runs.map((run) => {
              const turns = asAgentRunTurns(run.turns);
              const approvals = asAgentRunApprovals(run.approvals);
              const tokens = totalTokens(run);
              return (
                <div
                  key={run.id}
                  className="rounded-lg border border-miro-border/20 bg-miro-surface-low/40 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        run.outcome === "COMPLETED"
                          ? "bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400"
                          : run.outcome === "FAILED"
                            ? "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400"
                            : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                      }`}
                    >
                      {run.outcome ?? t("metrics.running")}
                    </span>
                    <span className="text-miro-text-secondary">
                      {t("metrics.turns", { count: turns.length })}
                    </span>
                    {tokens != null && (
                      <span className="text-miro-text-secondary">
                        {t("metrics.tokens", { count: tokens })}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={exportingId === run.id}
                      onClick={() => void handleExport(run)}
                      className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] text-miro-blue hover:bg-miro-blue-light transition-colors"
                    >
                      {t("metrics.export")}
                    </button>
                  </div>

                  {turns.length > 0 && (
                    <div className="mt-1.5 space-y-1">
                      {turns.map((turn) => (
                        <div
                          key={turn.turn}
                          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-miro-text-secondary"
                        >
                          <span className="font-mono text-miro-text-secondary/80">
                            #{turn.turn}
                          </span>
                          <span>{formatDuration(turn.durationMs)}</span>
                          {turn.promptTokens != null || turn.completionTokens != null ? (
                            <span className="font-mono">
                              {turn.promptTokens ?? "?"}→{turn.completionTokens ?? "?"}
                            </span>
                          ) : null}
                          {turn.toolCalls.length > 0 ? (
                            turn.toolCalls.map((call, idx) => (
                              <span
                                key={`${turn.turn}-${idx}`}
                                className={`truncate rounded px-1 font-mono ${
                                  call.success
                                    ? "bg-miro-surface-high text-miro-text"
                                    : "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400"
                                }`}
                                title={`${call.name} · ${formatDuration(call.durationMs)}`}
                              >
                                {call.name} {formatDuration(call.durationMs)}
                              </span>
                            ))
                          ) : (
                            <span className="text-miro-text-secondary/50">
                              {t("metrics.noToolCalls")}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {approvals.length > 0 && (
                    <p className="mt-1 text-[10px] text-miro-text-secondary/70">
                      {t("metrics.approvals", { count: approvals.length })}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
