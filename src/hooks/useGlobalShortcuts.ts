/**
 * @file useGlobalShortcuts.ts
 * @description Global keyboard shortcuts for the GetChat workspace.
 *
 * Registered at App level, active only when boot is READY.
 * Ignores shortcuts when the active element is a text input / textarea /
 * contenteditable to avoid typing conflicts.
 *
 * Shortcuts:
 *   Ctrl/Cmd + N       → New conversation
 *   Ctrl/Cmd + Enter   → Send message (when composer has content)
 *   Escape             → Cancel stream / dismiss fork / exit compare
 *   Ctrl/Cmd + ,       → Open settings
 *   Ctrl/Cmd + B       → Toggle left sidebar
 *   Ctrl/Cmd + .       → Toggle right panel
 *   Ctrl/Cmd + K       → Open search (reserved for #6)
 */

import { useEffect, useCallback } from "react";
import { useAppStore } from "../stores/useAppStoreSelector";
import { cancelStream } from "../services/streamController";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

interface GlobalShortcutsOptions {
  onCreateConversation: () => void;
  onSendMessage: () => void;
  onOpenSettings: () => void;
  onOpenSearch?: () => void;
}

export function useGlobalShortcuts({
  onCreateConversation,
  onSendMessage,
  onOpenSettings,
  onOpenSearch,
}: GlobalShortcutsOptions) {
  const activeRequestId = useAppStore((s) => s.composer.activeRequestId);
  const isSending = useAppStore((s) => s.composer.isSending);
  const workspaceMode = useAppStore((s) => s.workspace.workspaceMode);
  const forkIntent = useAppStore((s) => s.workspace.forkIntent);
  const leftSidebarCollapsed = useAppStore((s) => s.ui.leftSidebarCollapsed);
  const rightPanelCollapsed = useAppStore((s) => s.ui.rightPanelCollapsed);

  const setLeftSidebarCollapsed = useAppStore((s) => s.setLeftSidebarCollapsed);
  const setRightPanelCollapsed = useAppStore((s) => s.setRightPanelCollapsed);
  const clearForkIntent = useAppStore((s) => s.clearForkIntent);
  const exitCompare = useAppStore((s) => s.exitCompare);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const isEditing = isEditableTarget(e.target);

      // ---- Escape (no modifier) ----
      if (e.key === "Escape" && !mod) {
        if (activeRequestId) {
          e.preventDefault();
          cancelStream(activeRequestId);
          return;
        }
        if (forkIntent) {
          e.preventDefault();
          clearForkIntent();
          return;
        }
        if (workspaceMode === "COMPARE") {
          e.preventDefault();
          exitCompare();
          return;
        }
        return;
      }

      // ---- Ctrl/Cmd + N — New conversation ----
      if (mod && e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        onCreateConversation();
        return;
      }

      // ---- Ctrl/Cmd + Enter — Send message ----
      if (mod && e.key === "Enter") {
        if (!isSending) {
          e.preventDefault();
          onSendMessage();
        }
        return;
      }

      // ---- Ctrl/Cmd + , — Toggle settings ----
      if (mod && e.key === ",") {
        e.preventDefault();
        onOpenSettings();
        return;
      }

      // ---- Ctrl/Cmd + B — Toggle left sidebar ----
      if (mod && e.key === "b" && !isEditing) {
        e.preventDefault();
        setLeftSidebarCollapsed(!leftSidebarCollapsed);
        return;
      }

      // ---- Ctrl/Cmd + . — Toggle right panel ----
      if (mod && e.key === "." && !isEditing) {
        e.preventDefault();
        setRightPanelCollapsed(!rightPanelCollapsed);
        return;
      }

      // ---- Ctrl/Cmd + K — Open search (reserved for #6) ----
      if (mod && e.key === "k" && !isEditing) {
        if (onOpenSearch) {
          e.preventDefault();
          onOpenSearch();
        }
        return;
      }
    },
    [
      activeRequestId,
      isSending,
      workspaceMode,
      forkIntent,
      leftSidebarCollapsed,
      rightPanelCollapsed,
      onCreateConversation,
      onSendMessage,
      onOpenSettings,
      onOpenSearch,
      clearForkIntent,
      exitCompare,
      setLeftSidebarCollapsed,
      setRightPanelCollapsed,
    ]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
