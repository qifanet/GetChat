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
async function saveFile(content: string, filename: string): Promise<boolean> {
  try {
    const filePath = await save({
      defaultPath: filename,
      filters: [{ name: "Documents", extensions: [filename.endsWith(".json") ? "json" : "md"] }],
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
/** Modal dialog for exporting conversation content as Markdown or JSON. */
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
    if (scope === "WHOLE_TREE") {
      const allMessages = Object.values(activeSnapshot.entities.messages)
        .filter((m) => m.status !== "STREAMING")
        .sort((a, b) => a.createdAt - b.createdAt);
      return buildMarkdownFromMessages(allMessages, title);
    }
    return buildMarkdownFromMessages(currentPathMessages, title);
  }, [activeSnapshot, currentPathMessages, format, scope, summary, t]);
  const filename = useMemo(() => {
    const base = (summary?.title || "conversation").replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_");
    const ext = format === "JSON" ? "json" : "md";
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

