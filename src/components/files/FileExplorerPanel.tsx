/**
 * @file FileExplorerPanel.tsx
 * @description File explorer sidebar panel for workspace directories.
 *
 * Shows a collapsible directory tree for the active conversation's workspace.
 * Only visible when a conversation with a workspace path is active.
 * Files can be clicked to preview in the FilePreviewPanel.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import * as tauriCmd from "../../services/tauriCommands";
import type { DirectoryEntryDto } from "../../services/tauriTypes";
import {
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
} from "../common/Icon";

// ============================================================================
// Directory Tree Item
// ============================================================================

interface DirectoryTreeItemProps {
  entry: DirectoryEntryDto;
  conversationId: string;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string, isDir: boolean) => void;
}

const DirectoryTreeItem = memo(function DirectoryTreeItem({
  entry,
  conversationId,
  depth,
  selectedPath,
  onSelect,
}: DirectoryTreeItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirectoryEntryDto[]>([]);
  const [loading, setLoading] = useState(false);

  const handleToggle = useCallback(async () => {
    if (!entry.isDir) {
      onSelect(entry.path, false);
      return;
    }

    if (expanded) {
      setExpanded(false);
      return;
    }

    setLoading(true);
    try {
      const entries = await tauriCmd.listDirectoryEntries(conversationId, entry.path);
      setChildren(entries);
      setExpanded(true);
    } catch (err) {
      console.error("[fileExplorer] failed to list directory", entry.path, err);
    } finally {
      setLoading(false);
    }
  }, [entry.isDir, entry.path, conversationId, expanded, onSelect]);

  const isSelected = selectedPath === entry.path;
  const indent = depth * 16;

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1.5 rounded px-2 py-[5px] text-left text-[13px] transition-colors ${
          isSelected
            ? "bg-miro-blue-light/60 text-miro-blue"
            : "text-miro-text hover:bg-miro-surface-low"
        }`}
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={handleToggle}
      >
        {entry.isDir ? (
          <>
            <IconChevronRight
              size={12}
              className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            {expanded ? (
              <IconFolderOpen size={14} className="shrink-0 text-amber-500" />
            ) : (
              <IconFolder size={14} className="shrink-0 text-amber-500" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <IconFile size={14} className="shrink-0 text-miro-text-secondary" />
          </>
        )}
        <span className="min-w-0 truncate">{entry.name}</span>
        {loading && (
          <span className="ml-auto text-[10px] text-miro-text-secondary">...</span>
        )}
      </button>
      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <DirectoryTreeItem
              key={child.path}
              entry={child}
              conversationId={conversationId}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {expanded && children.length === 0 && !loading && (
        <div
          className="px-2 py-1 text-[11px] text-miro-text-secondary"
          style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}
        >
          {t("fileExplorer.emptyDirectory")}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// File Explorer Panel
// ============================================================================

interface FileExplorerPanelProps {
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
}

export function FileExplorerPanel({
  selectedFilePath,
  onSelectFile,
}: FileExplorerPanelProps) {
  const { t } = useTranslation();
  const activeConversationId = useAppStore(
    (s) => s.workspace.activeConversationId
  );
  const activeSnapshot = useAppStore((s) => s.activeSnapshot);
  const workspacePath = activeSnapshot?.summary.workspacePath ?? null;
  const setFileExplorerOpen = useAppStore((s) => s.setFileExplorerOpen);
  const isSending = useAppStore((s) => s.composer.isSending);

  const [entries, setEntries] = useState<DirectoryEntryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSelect = useCallback(
    (path: string, isDir: boolean) => {
      if (!isDir) {
        onSelectFile(path);
      }
    },
    [onSelectFile]
  );

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Auto-close when there's no workspace path
  useEffect(() => {
    if (!workspacePath && activeConversationId) {
      setFileExplorerOpen(false);
    }
  }, [workspacePath, activeConversationId, setFileExplorerOpen]);

  // Auto-refresh after stream completes (AI may have created/modified files)
  const prevSendingRef = useRef(isSending);
  useEffect(() => {
    if (prevSendingRef.current && !isSending && workspacePath) {
      refresh();
    }
    prevSendingRef.current = isSending;
  }, [isSending, workspacePath, refresh]);

  useEffect(() => {
    if (!activeConversationId || !workspacePath) {
      setEntries([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    tauriCmd
      .listDirectoryEntries(activeConversationId, workspacePath)
      .then((result) => {
        if (!cancelled) {
          setEntries(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId, workspacePath, refreshKey]);

  if (!workspacePath || !activeConversationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
        <IconFolder size={24} className="text-miro-border" />
        <p className="text-xs text-miro-text-secondary">
          {t("fileExplorer.noWorkspace")}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-8">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-miro-blue border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
        <p className="text-xs text-miro-red">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-miro-border/20 px-3 py-2">
        <IconFolder size={14} className="text-amber-500" />
        <span className="truncate text-[11px] font-medium text-miro-text-secondary">
          {workspacePath.split(/[\\/]/).pop()}
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded p-1 text-miro-text-secondary transition-colors hover:bg-miro-surface-low hover:text-miro-text"
          onClick={refresh}
          title={t("fileExplorer.refresh")}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 1v5h5" /><path d="M3.51 10a6 6 0 1 0 1.07-5.22L1 6" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {entries.map((entry) => (
          <DirectoryTreeItem
            key={entry.path}
            entry={entry}
            conversationId={activeConversationId}
            depth={0}
            selectedPath={selectedFilePath}
            onSelect={handleSelect}
          />
        ))}
        {entries.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-miro-text-secondary">
            {t("fileExplorer.emptyDirectory")}
          </div>
        )}
      </div>
    </div>
  );
}
