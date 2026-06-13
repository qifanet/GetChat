/**
 * @file TaskQueuePanel.tsx
 * @description Task queue panel for v1.5.0 — displays background task status
 * with message content preview, cancel, and inline editing support.
 */

import { useEffect, useState, useCallback } from "react";
import * as tauriCmd from "../../services/tauriCommands";
import type { TaskQueueItemDto, TaskStatus } from "../../types/taskQueue";
import { useAppStore } from "../../stores/useAppStore";
import {
  IconClock,
  IconPlay,
  IconCheck,
  IconAlertCircle,
  IconXCircle,
  IconChevronDown,
  IconChevronRight,
  IconX,
  IconPencilSquare,
} from "../common/Icon";

const STATUS_ICON: Record<TaskStatus, React.FC<{ className?: string; size?: number }>> = {
  QUEUED: IconClock,
  RUNNING: IconPlay,
  PAUSED: IconClock,
  COMPLETED: IconCheck,
  FAILED: IconAlertCircle,
  CANCELLED: IconXCircle,
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  QUEUED: "Waiting",
  RUNNING: "Running",
  PAUSED: "Paused",
  COMPLETED: "Done",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const STATUS_BADGE: Record<TaskStatus, string> = {
  QUEUED: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  RUNNING: "bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400",
  PAUSED: "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/40 dark:text-yellow-400",
  COMPLETED: "bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400",
  FAILED: "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400",
  CANCELLED: "bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500",
};

export function TaskQueuePanel() {
  const [tasks, setTasks] = useState<TaskQueueItemDto[]>([]);
  const [visible, setVisible] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  useEffect(() => {
    let prevHadRunning = false;

    const fetchTasks = async () => {
      try {
        const items = await tauriCmd.listTaskQueue();
        const nowSecs = Math.floor(Date.now() / 1000);
        const filtered = items.filter((task) => {
          if (task.status === "QUEUED" || task.status === "RUNNING" || task.status === "PAUSED") {
            return true;
          }
          const endTime = task.completedAt || task.startedAt || task.createdAt;
          return endTime != null && (nowSecs - endTime) < 30;
        });

        const hasRunning = filtered.some(t => t.status === "RUNNING" || t.status === "QUEUED");
        const justCompleted = prevHadRunning && !hasRunning && filtered.some(t => t.status === "COMPLETED");

        setTasks(filtered);
        setVisible(filtered.length > 0);
        prevHadRunning = hasRunning;

        if (justCompleted) {
          const convId = useAppStore.getState().activeSnapshot?.summary.id;
          if (convId) {
            console.log("[TaskQueuePanel] Tasks completed, reloading snapshot for", convId);
            useAppStore.getState().openConversation(convId);
          }
        }
      } catch (error) {
        console.error("[TaskQueuePanel] Failed to fetch tasks:", error);
      }
    };

    fetchTasks();
    const interval = setInterval(fetchTasks, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleCancel = useCallback(async (taskId: string) => {
    try {
      await tauriCmd.cancelTask(taskId);
      setTasks((prev) => prev.map((t) =>
        t.id === taskId ? { ...t, status: "CANCELLED" as TaskStatus } : t
      ));
    } catch (error) {
      console.error("[TaskQueuePanel] Cancel failed:", error);
    }
  }, []);

  const handleStartEdit = useCallback((task: TaskQueueItemDto) => {
    const initialMsg = task.config?.initial_message ?? "";
    setEditDraft(initialMsg);
    setEditingTaskId(task.id);
  }, []);

  if (!visible || tasks.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-miro-border/20 bg-miro-card/96 px-3 py-2 sm:px-4">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <IconClock size={14} className="text-miro-text-secondary" />
            <span className="text-xs font-medium text-miro-text-secondary">
              Task Queue ({tasks.length})
            </span>
          </div>
          <button
            onClick={() => setVisible(false)}
            className="flex items-center gap-1 text-[10px] text-miro-text-secondary hover:text-miro-text transition-colors"
          >
            Hide
          </button>
        </div>

        {/* Task list */}
        <div className="space-y-1">
          {tasks.map((task) => {
            const StatusIcon = STATUS_ICON[task.status];
            const isExpanded = expandedTaskId === task.id;
            const isEditing = editingTaskId === task.id;
            const branchName = task.config?.branch_name ?? "";
            const initialMessage = task.config?.initial_message ?? "";
            const canAct = task.status === "QUEUED";

            return (
              <div
                key={task.id}
                className="rounded-lg border border-miro-border/20 bg-miro-surface-high/50"
              >
                {/* Row header */}
                <div
                  onClick={() => {
                    if (!isEditing) setExpandedTaskId(isExpanded ? null : task.id);
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-miro-surface-high/60 transition-colors"
                >
                  {isExpanded ? (
                    <IconChevronDown size={12} className="text-miro-text-secondary shrink-0" />
                  ) : (
                    <IconChevronRight size={12} className="text-miro-text-secondary shrink-0" />
                  )}

                  <StatusIcon size={14} className="shrink-0" />

                  <span
                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[task.status]}`}
                  >
                    {STATUS_LABEL[task.status]}
                  </span>

                  {/* Branch name — always visible */}
                  {branchName && (
                    <span className="text-xs text-miro-text font-medium truncate">
                      {branchName}
                    </span>
                  )}

                  {/* Message preview when collapsed */}
                  {!isExpanded && initialMessage && (
                    <span className="text-[11px] text-miro-text-secondary truncate max-w-[200px]">
                      — {initialMessage.slice(0, 50)}{initialMessage.length > 50 ? "..." : ""}
                    </span>
                  )}

                  {/* Action buttons */}
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    {canAct && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartEdit(task);
                        }}
                        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-miro-blue hover:bg-miro-blue-light transition-colors"
                        title="Edit message"
                      >
                        <IconPencilSquare size={10} />
                        Edit
                      </button>
                    )}
                    {canAct && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancel(task.id);
                        }}
                        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-miro-red hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        title="Cancel task"
                      >
                        <IconX size={10} />
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && !isEditing && (
                  <div className="border-t border-miro-border/15 px-3 py-2 space-y-1.5 text-xs bg-miro-card/50">
                    <div className="flex items-center gap-3 text-miro-text-secondary">
                      <span>Task: <span className="font-mono text-miro-text">{task.id.slice(0, 12)}…</span></span>
                      <span>Type: <span className="text-miro-text">{task.taskType}</span></span>
                    </div>
                    {initialMessage && (
                      <div>
                        <span className="text-miro-text-secondary">Message:</span>
                        <p className="mt-0.5 text-miro-text whitespace-pre-wrap">{initialMessage}</p>
                      </div>
                    )}
                    {task.errorMessage && (
                      <div className="text-red-500">
                        Error: {task.errorMessage}
                      </div>
                    )}
                  </div>
                )}

                {/* Edit mode */}
                {isEditing && (
                  <div className="border-t border-miro-border/15 px-3 py-2 bg-miro-card/50 space-y-2">
                    <div className="text-xs text-miro-text-secondary">
                      Editing message for <span className="font-medium text-miro-text">{branchName || task.id.slice(0, 12)}</span>
                    </div>
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      className="w-full resize-none rounded-md border border-miro-border/30 bg-miro-surface-high px-2.5 py-1.5 text-xs text-miro-text focus:outline-none focus:ring-1 focus:ring-miro-blue/40"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          // Update the config in local state (backend doesn't support editing yet)
                          setTasks(prev => prev.map(t =>
                            t.id === task.id
                              ? { ...t, config: { ...t.config, initial_message: editDraft } }
                              : t
                          ));
                          setEditingTaskId(null);
                        }}
                        className="rounded-md bg-miro-blue px-2.5 py-1 text-[11px] font-medium text-white hover:bg-miro-blue-pressed transition-colors"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingTaskId(null)}
                        className="rounded-md px-2.5 py-1 text-[11px] text-miro-text-secondary hover:bg-miro-surface-high transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
