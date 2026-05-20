import { memo, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as tauriCmd from "../../services/tauriCommands";

interface TodoItem {
  id: string;
  content: string;
  status: string;
}

const POLL_INTERVAL = 3000;

function getStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "\u2705";
    case "in_progress":
      return "\uD83D\uDD34";
    case "pending":
      return "\u26AA";
    default:
      return "\u26AA";
  }
}

interface TodoStatusBarProps {
  conversationId?: string;
}

export const TodoStatusBar = memo(function TodoStatusBar({ conversationId }: TodoStatusBarProps) {
  const { t } = useTranslation();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [visible, setVisible] = useState(false);

  const fetchTodos = useCallback(async () => {
    try {
      const items = await tauriCmd.readTodoItems(conversationId);
      setTodos(items);
      const hasActive = items.some(
        (item) => item.status !== "completed"
      );
      setVisible(items.length > 0 && hasActive);
    } catch {
      // Non-critical
    }
  }, [conversationId]);

  useEffect(() => {
    fetchTodos();
    const interval = setInterval(fetchTodos, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchTodos]);

  if (!visible || todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const totalCount = todos.length;

  return (
    <div className="border-t border-miro-border/30 bg-miro-blue-light/30">
      <button
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs font-medium text-miro-blue/80 hover:bg-miro-blue-light/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={`transform transition-transform text-[10px] ${
            expanded ? "rotate-90" : ""
          }`}
        >
          {"\u25B6"}
        </span>
        <span>
          {t("todo.statusBar", {
            completed: completedCount,
            total: totalCount,
          })}
        </span>
        <div className="ml-auto flex gap-0.5">
          {todos.map((item) => (
            <span
              key={item.id}
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                item.status === "completed"
                  ? "bg-green-500"
                  : item.status === "in_progress"
                  ? "bg-blue-500 animate-pulse"
                  : "bg-gray-300"
              }`}
            />
          ))}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-miro-border/20 px-4 pb-2 pt-1">
          {todos.map((item) => (
            <div
              key={item.id}
              className={`flex items-start gap-2 py-0.5 text-xs ${
                item.status === "completed"
                  ? "text-miro-text-secondary line-through opacity-60"
                  : "text-miro-text-primary"
              }`}
            >
              <span className="mt-px shrink-0 text-[10px]">
                {getStatusIcon(item.status)}
              </span>
              <span className="min-w-0 truncate">{item.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
