/**
 * @file ExportDialog.tsx
 * @description Modal dialog for exporting conversation content.
 *
 * Supports two export scopes:
 *   - Current path: exports the visible branch messages
 *   - Whole conversation: exports the entire snapshot as JSON
 *
 * And two formats:
 *   - Markdown: human-readable text with message roles
 *   - JSON: structured data including full snapshot metadata
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import {
  selectCurrentPathMessages,
  selectCurrentConversationSummary,
} from "../../selectors/conversationSelectors";
import { copyTextToClipboard } from "../../utils/clipboard";
import { IconX } from "../common/Icon";
import type { ExportFormat, ExportScope } from "../../types/base";
import type { MessageNode, ConversationSnapshot } from "../../types/conversation";

/** Build a Markdown string from an ordered list of messages. */
function buildMarkdownFromMessages(
  messages: readonly MessageNode[],
  title: string
): string {
  const lines: string[] = [`# ${title}`, ""];

  for (const msg of messages) {
    const role = msg.role === "USER" ? "## User" : "## Assistant";
    lines.push(role);
    lines.push("");
    lines.push(msg.content.text);
    lines.push("");
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

/** Trigger a file download with the given content. */
function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Modal dialog for exporting conversation content as Markdown or JSON. */
export function ExportDialog() {
  const { t } = useTranslation();
  const exportDialogOpen = useAppStore((state) => state.ui.exportDialogOpen);
  const closeExportDialog = useAppStore((state) => state.closeExportDialog);
  const activeSnapshot = useAppStore((state) => state.activeSnapshot);
  const summary = useAppStore(selectCurrentConversationSummary);
  const currentPathMessages = useAppStore(selectCurrentPathMessages);

  const [scope, setScope] = useState<ExportScope>("CURRENT_PATH");
  const [format, setFormat] = useState<ExportFormat>("MARKDOWN");
  const [copied, setCopied] = useState(false);

  const exportContent = useMemo(() => {
    if (!activeSnapshot) return null;

    if (format === "JSON") {
      return buildJsonFromSnapshot(activeSnapshot);
    }

    const title = summary?.title || t("conversation.unnamedConversation");
    return buildMarkdownFromMessages(currentPathMessages, title);
  }, [activeSnapshot, currentPathMessages, format, summary, t]);

  const filename = useMemo(() => {
    const base = (summary?.title || "conversation").replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_");
    const ext = format === "JSON" ? "json" : "md";
    return `${base}.${ext}`;
  }, [summary, format]);

  const handleDownload = useCallback(() => {
    if (!exportContent) return;

    const mimeType = format === "JSON" ? "application/json" : "text/markdown";
    downloadFile(exportContent, filename, mimeType);
  }, [exportContent, filename, format]);

  const handleCopy = useCallback(async () => {
    if (!exportContent) return;

    await copyTextToClipboard(exportContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [exportContent]);

  if (!exportDialogOpen || !activeSnapshot) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="fixed inset-0 bg-slate-950/30 backdrop-blur-[2px]"
        onClick={closeExportDialog}
        aria-label={t("common.cancel")}
      />

      <div className="relative z-10 w-full max-w-lg rounded-shell bg-white px-7 py-7 shadow-panel">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
            {t("export.title")}
          </h2>
          <button
            type="button"
            onClick={closeExportDialog}
            className="app-icon-button h-8 w-8"
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
                    : "border-miro-border/30 bg-white text-miro-text-secondary hover:border-miro-border")
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
                    : "border-miro-border/30 bg-white text-miro-text-secondary hover:border-miro-border")
                }
              >
                {t("export.wholeTree")}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-miro-text">{t("export.markdown")}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFormat("MARKDOWN")}
                className={
                  "rounded-[12px] border px-4 py-2 text-sm font-medium transition-colors " +
                  (format === "MARKDOWN"
                    ? "border-miro-blue/30 bg-miro-blue-light/65 text-miro-blue"
                    : "border-miro-border/30 bg-white text-miro-text-secondary hover:border-miro-border")
                }
              >
                {t("export.markdown")}
              </button>
              <button
                type="button"
                onClick={() => setFormat("JSON")}
                className={
                  "rounded-[12px] border px-4 py-2 text-sm font-medium transition-colors " +
                  (format === "JSON"
                    ? "border-miro-blue/30 bg-miro-blue-light/65 text-miro-blue"
                    : "border-miro-border/30 bg-white text-miro-text-secondary hover:border-miro-border")
                }
              >
                {t("export.json")}
              </button>
            </div>
          </div>

          {scope === "WHOLE_TREE" && format === "MARKDOWN" ? (
            <div className="rounded-panel border border-miro-border/30 bg-miro-surface-high px-4 py-3 text-xs leading-5 text-miro-text-secondary">
              {t("export.markdown")} — {t("export.currentPath")}
            </div>
          ) : null}

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
              className="app-primary-button px-4 py-2 text-sm"
            >
              {t("export.download")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
