/**
 * @file ExportDialog.tsx
 * @description Modal dialog for exporting conversation content.
 *
 * Supports two export scopes:
 *   - Current path: exports the visible branch messages
 *   - Whole conversation: exports the entire snapshot as JSON
 *
 * And three formats:
 *   - Markdown: human-readable text with message roles
 *   - JSON: structured data including full snapshot metadata
 *   - HTML: standalone styled page for sharing and printing
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import {
  selectCurrentPathMessages,
  selectCurrentConversationSummary,
} from "../../selectors/conversationSelectors";
import { copyTextToClipboard } from "../../utils/clipboard";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { IconX } from "../common/Icon";
import type { ExportFormat, ExportScope } from "../../types/base";
import type { MessageNode, ConversationSnapshot } from "../../types/conversation";
const _sel_ui_exportDialogOpen = (s: import("../../stores/appStore.types").AppStore) => s.ui.exportDialogOpen;
const _sel_closeExportDialog = (s: import("../../stores/appStore.types").AppStore) => s.closeExportDialog;
const _sel_activeSnapshot = (s: import("../../stores/appStore.types").AppStore) => s.activeSnapshot;

/** Build a Markdown string from an ordered list of messages. */
function buildMarkdownFromMessages(
  messages: readonly MessageNode[],
  title: string,
  _snapshot?: ConversationSnapshot | null,
  _scope?: ExportScope
): string {
  const lines: string[] = [`# ${title}`, ""];

  // When exporting whole tree with a snapshot, annotate branches
  if (_scope === "WHOLE_TREE" && _snapshot) {
    const messagesById = new Map<string, MessageNode>();
    for (const msg of messages) {
      messagesById.set(msg.id, msg);
    }

    // Build parent → children mapping to detect branch points
    const childrenByParent = new Map<string, MessageNode[]>();
    for (const msg of messages) {
      const pid = msg.parentId;
      if (!pid) continue;
      const list = childrenByParent.get(pid) ?? [];
      list.push(msg);
      childrenByParent.set(pid, list);
    }

    // Identify mainline path for branch marking
    const mainlineBranch = Object.values(_snapshot.entities.branches).find(
      (b) => b.isMainline
    );
    const mainlineIds = new Set<string>();
    if (mainlineBranch) {
      const headId = mainlineBranch.headMessageId;
      let cur: string | null | undefined = headId;
      while (cur) {
        mainlineIds.add(cur);
        cur = messagesById.get(cur)?.parentId;
      }
    }

    // Assign branch labels to non-mainline messages
    const branchLabels = new Map<string, string>();
    // Track which parent IDs have branch points, but don't write annotations yet
    const branchPointParents = new Map<string, number>(); // parentId → child count
    let branchIdx = 1;
    for (const [parentId, children] of childrenByParent) {
      if (children.length <= 1) continue;
      branchPointParents.set(parentId, children.length);
      for (const child of children) {
        if (mainlineIds.has(child.id)) continue;
        if (!branchLabels.has(child.id)) {
          branchLabels.set(child.id, `Branch ${branchIdx}`);
          branchIdx++;
        }
      }
    }

    // Walk messages in order and annotate at the correct location
    let currentBranch = "Mainline";
    for (const msg of messages) {
      // Emit branch point annotation right after the parent message that forks
      if (branchPointParents.has(msg.id)) {
        lines.push(`<!-- Branch point: ${branchPointParents.get(msg.id)} variants -->`);
      }
      if (branchLabels.has(msg.id)) {
        currentBranch = branchLabels.get(msg.id)!;
        lines.push("", `---`, "", `> [${currentBranch}]`, "");
      } else if (mainlineIds.has(msg.id) && currentBranch !== "Mainline") {
        currentBranch = "Mainline";
        lines.push("", `---`, "", `> [Mainline]`, "");
      }
      const role = msg.role === "USER" ? "## User" : "## Assistant";
      lines.push(role, "", msg.content.text, "");
    }
  } else {
    for (const msg of messages) {
      const role = msg.role === "USER" ? "## User" : "## Assistant";
      lines.push(role);
      lines.push("");
      lines.push(msg.content.text);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Build a JSON string from the full conversation snapshot. */
function buildJsonFromSnapshot(snapshot: ConversationSnapshot): string {
  return JSON.stringify(
    {
      conversation: {
        id: snapshot.summary.id,
        title: snapshot.summary.title,
        exportedAt: new Date().toISOString(),
      },
      summary: snapshot.summary,
      messages: Object.values(snapshot.entities.messages).map((msg) => ({
        id: msg.id,
        role: msg.role,
        status: msg.status,
        parentId: msg.parentId,
        content: msg.content.text,
        createdAt: new Date(msg.createdAt).toISOString(),
        generation: msg.generation
          ? {
              providerId: msg.generation.providerId,
              modelId: msg.generation.modelId,
              usage: msg.generation.usage,
            }
          : undefined,
      })),
      branches: Object.values(snapshot.entities.branches).map((branch) => ({
        id: branch.id,
        name: branch.name,
        status: branch.status,
        isMainline: branch.isMainline,
        forkPointMessageId: branch.forkPointMessageId,
        headMessageId: branch.headMessageId,
        createdAt: new Date(branch.createdAt).toISOString(),
      })),
    },
    null,
    2
  );
}

/** Build a standalone HTML page from messages. */
function buildHtmlFromMessages(
  messages: readonly MessageNode[],
  title: string
): string {
  const bodyParts: string[] = [];
  for (const msg of messages) {
    const isUser = msg.role === "USER";
    const roleLabel = isUser ? "User" : "Assistant";
    const escaped = escapeHtml(msg.content.text);
    bodyParts.push(`
    <div class="msg ${isUser ? "user" : "assistant"}">
      <div class="role">${roleLabel}</div>
      <div class="bubble">${escaped}</div>
    </div>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    line-height: 1.6; padding: 24px; max-width: 800px; margin: 0 auto;
    background: #fff; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a2e; color: #e0e0e0; }
    .msg.user .bubble { background: #2d2d5e; }
    .msg.assistant .bubble { background: #2a2a3a; }
    h1 { color: #e0e0e0; }
    .meta { color: #888; }
  }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .meta { font-size: 0.8rem; margin-bottom: 24px; }
  .msg { margin-bottom: 16px; }
  .msg.user { display: flex; flex-direction: column; align-items: flex-end; }
  .msg.assistant { display: flex; flex-direction: column; align-items: flex-start; }
  .role { font-size: 0.75rem; font-weight: 600; margin-bottom: 4px; opacity: 0.7; }
  .bubble {
    max-width: 85%; padding: 12px 16px; border-radius: 12px;
    white-space: pre-wrap; word-break: break-word; font-size: 0.9rem;
  }
  .msg.user .bubble { background: #e3f2fd; color: #1a1a1a; border-bottom-right-radius: 4px; }
  .msg.assistant .bubble { background: #f0f0f0; color: #1a1a1a; border-bottom-left-radius: 4px; }
  pre { margin: 8px 0; padding: 12px; background: #f5f5f5; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; }
  code { font-family: "SF Mono", "Fira Code", "Consolas", monospace; font-size: 0.85em; }
  @media print { body { padding: 0; } .msg { break-inside: avoid; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">Exported from GetChat &middot; ${new Date().toLocaleString()}</div>
${bodyParts.join("")}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trigger a file download with the given content. */
async function saveFile(content: string, filename: string): Promise<boolean> {
  const ext = filename.endsWith(".json") ? "json" : filename.endsWith(".html") ? "html" : "md";
  try {
    const filePath = await save({
      defaultPath: filename,
      filters: [{ name: "Documents", extensions: [ext] }],
    });
    if (!filePath) return false;
    const encoder = new TextEncoder();
    await writeFile(filePath, encoder.encode(content));
    return true;
  } catch (err) {
    console.warn("[export] Tauri save failed, falling back to browser download", err);
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
  }
}

/** Modal dialog for exporting conversation content as Markdown, JSON, or HTML. */
export function ExportDialog() {
  const { t } = useTranslation();
  const exportDialogOpen = useAppStore(_sel_ui_exportDialogOpen);
  const closeExportDialog = useAppStore(_sel_closeExportDialog);
  const activeSnapshot = useAppStore(_sel_activeSnapshot);
  const summary = useAppStore(selectCurrentConversationSummary);
  const currentPathMessages = useAppStore(selectCurrentPathMessages);
  const [scope, setScope] = useState<ExportScope>("CURRENT_PATH");
  const [format, setFormat] = useState<ExportFormat>("MARKDOWN");
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);
  const exportContent = useMemo(() => {
    if (!activeSnapshot) return null;
    if (format === "JSON") {
      return buildJsonFromSnapshot(activeSnapshot);
    }
    const title = summary?.title || t("conversation.unnamedConversation");
    const messages = scope === "WHOLE_TREE"
      ? Object.values(activeSnapshot.entities.messages)
          .filter((m) => m.status !== "STREAMING")
          .sort((a, b) => a.createdAt - b.createdAt)
      : currentPathMessages;

    if (format === "HTML") {
      return buildHtmlFromMessages(messages, title);
    }
    return buildMarkdownFromMessages(messages, title, activeSnapshot, scope);
  }, [activeSnapshot, currentPathMessages, format, scope, summary, t]);
  const filename = useMemo(() => {
    const base = (summary?.title || "conversation").replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_");
    const ext = format === "JSON" ? "json" : format === "HTML" ? "html" : "md";
    return `${base}.${ext}`;
  }, [summary, format]);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const handleDownload = useCallback(async () => {
    if (!exportContent) return;
    setSaving(true);
    try {
      const ok = await saveFile(exportContent, filename);
      if (ok) {
        setSaveSuccess(true);
        setTimeout(() => { closeExportDialog(); }, 800);
      }
    } finally {
      setSaving(false);
    }
  }, [exportContent, filename, closeExportDialog]);
  const handleCopy = useCallback(async () => {
    if (!exportContent) return;
    await copyTextToClipboard(exportContent);
    setCopied(true);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 1500);
  }, [exportContent]);
  if (!exportDialogOpen || !activeSnapshot) {
    return null;
  }

  const formatButtons: { key: ExportFormat; label: string }[] = [
    { key: "MARKDOWN", label: t("export.markdown") },
    { key: "JSON", label: t("export.json") },
    { key: "HTML", label: t("export.html") },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="fixed inset-0 bg-miro-scrim backdrop-blur-[2px]"
        onClick={closeExportDialog}
        aria-label={t("common.cancel")}
      />
      <div className="relative z-10 w-full max-w-lg rounded-shell bg-miro-card px-7 py-7 shadow-panel">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
            {t("export.title")}
          </h2>
          <button
            type="button"
            onClick={closeExportDialog}
            className="app-icon-button h-8 w-8"
            title={t("common.cancel")}
            aria-label={t("common.cancel")}
          >
            <IconX size={16} />
          </button>
        </div>
        <div className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium text-miro-text">{t("export.currentPath")}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setScope("CURRENT_PATH")}
                className={
                  "rounded-[12px] border px-4 py-2 text-sm font-medium transition-colors " +
                  (scope === "CURRENT_PATH"
                    ? "border-miro-blue/30 bg-miro-blue-light/65 text-miro-blue"
                    : "border-miro-border/30 bg-miro-card text-miro-text-secondary hover:border-miro-border")
                }
              >
                {t("export.currentPath")}
              </button>
              <button
                type="button"
                onClick={() => setScope("WHOLE_TREE")}
                className={
                  "rounded-[12px] border px-4 py-2 text-sm font-medium transition-colors " +
                  (scope === "WHOLE_TREE"
                    ? "border-miro-blue/30 bg-miro-blue-light/65 text-miro-blue"
                    : "border-miro-border/30 bg-miro-card text-miro-text-secondary hover:border-miro-border")
                }
              >
                {t("export.wholeTree")}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-miro-text">{t("export.markdown")}</p>
            <div className="flex gap-2">
              {formatButtons.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFormat(key)}
                  className={
                    "rounded-[12px] border px-4 py-2 text-sm font-medium transition-colors " +
                    (format === key
                      ? "border-miro-blue/30 bg-miro-blue-light/65 text-miro-blue"
                      : "border-miro-border/30 bg-miro-card text-miro-text-secondary hover:border-miro-border")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="app-secondary-button px-4 py-2 text-sm"
            >
              {copied ? t("export.copiedToClipboard") : t("export.copyContent")}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="app-primary-button px-4 py-2 text-sm disabled:opacity-50"
              disabled={saving || saveSuccess}
            >
              {saveSuccess ? t("common.saved") : saving ? t("common.saving") : t("export.download")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
