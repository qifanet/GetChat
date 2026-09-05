/**
 * @file ImportDialog.tsx
 * @description Modal dialog for importing conversations from external formats.
 *
 * Supports ChatGPT JSON and GetChat JSON formats.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { IconX } from "../common/Icon";
import * as tauriCmd from "../../services/tauriCommands";

const _sel_importDialogOpen = (s: import("../../stores/appStore.types").AppStore) => s.ui.importDialogOpen;
const _sel_closeImportDialog = (s: import("../../stores/appStore.types").AppStore) => s.closeImportDialog;

type ImportFormat = "chatgpt" | "getchat";

interface ImportResult {
  importedCount: number;
  skippedCount: number;
  errors: string[];
}

export function ImportDialog() {
  const { t } = useTranslation();
  const importDialogOpen = useAppStore(_sel_importDialogOpen);
  const closeImportDialog = useAppStore(_sel_closeImportDialog);

  const [format, setFormat] = useState<ImportFormat>("chatgpt");
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [previewCount, setPreviewCount] = useState<number>(0);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const resetState = useCallback(() => {
    setFileContent(null);
    setFileName("");
    setPreviewCount(0);
    setResult(null);
  }, []);

  useEffect(() => {
    if (!importDialogOpen) resetState();
  }, [importDialogOpen, resetState]);

  const handleSelectFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;

      const filePath = typeof selected === "string" ? selected : selected;
      const content = await readTextFile(filePath);
      setFileContent(content);

      const name = typeof filePath === "string"
        ? filePath.split(/[\\/]/).pop() || "unknown.json"
        : "unknown.json";
      setFileName(name);
      setResult(null);

      // Preview conversation count
      try {
        const parsed = JSON.parse(content);
        if (format === "chatgpt") {
          const count = Array.isArray(parsed) ? parsed.length : 0;
          setPreviewCount(count);
        } else {
          const count = Array.isArray(parsed) ? parsed.length : 1;
          setPreviewCount(count);
        }
      } catch {
        setPreviewCount(0);
      }
    } catch (err) {
      console.error("[import] file selection failed", err);
    }
  }, [format]);

  const handleImport = useCallback(async () => {
    if (!fileContent) return;
    setImporting(true);
    try {
      const res = await tauriCmd.importConversations({
        format,
        jsonContent: fileContent,
      });
      setResult(res);
    } catch (err) {
      console.error("[import] failed", err);
      setResult({ importedCount: 0, skippedCount: 0, errors: [String(err)] });
    } finally {
      setImporting(false);
    }
  }, [fileContent, format]);

  if (!importDialogOpen) return null;

  const formatButtons: { key: ImportFormat; label: string }[] = [
    { key: "chatgpt", label: t("import.formatChatGPT") },
    { key: "getchat", label: t("import.formatGetChat") },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="fixed inset-0 bg-miro-scrim backdrop-blur-[2px]"
        onClick={closeImportDialog}
        aria-label={t("common.cancel")}
      />
      <div className="relative z-10 w-full max-w-lg rounded-shell bg-miro-card px-7 py-7 shadow-panel">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
            {t("import.title")}
          </h2>
          <button
            type="button"
            onClick={closeImportDialog}
            className="app-icon-button h-8 w-8"
            title={t("common.cancel")}
            aria-label={t("common.cancel")}
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="space-y-5">
          {/* Format selector */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-miro-text">{t("import.format")}</p>
            <div className="flex gap-2">
              {formatButtons.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setFormat(key); resetState(); }}
                  className={
                    "rounded-md border px-4 py-2 text-sm font-medium transition-colors " +
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

          {/* File selection */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => void handleSelectFile()}
              className="app-secondary-button px-4 py-2 text-sm"
            >
              {t("import.selectFile")}
            </button>
            {fileName && (
              <p className="text-xs text-miro-text-secondary truncate">{fileName}</p>
            )}
          </div>

          {/* Preview */}
          {fileContent && previewCount > 0 && !result && (
            <div className="rounded-panel border border-miro-border/30 bg-miro-surface-high px-4 py-3 text-xs text-miro-text-secondary">
              {t("import.previewCount", { count: previewCount })}
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="space-y-2 rounded-panel border border-miro-border/30 bg-miro-surface-high px-4 py-3">
              <p className="text-sm font-medium text-miro-text">
                {t("import.resultSuccess", { count: result.importedCount })}
              </p>
              {result.skippedCount > 0 && (
                <p className="text-xs text-miro-text-secondary">
                  {t("import.resultSkipped", { count: result.skippedCount })}
                </p>
              )}
              {result.errors.length > 0 && (
                <div className="mt-2 max-h-32 overflow-y-auto">
                  {result.errors.map((err, i) => (
                    <p key={i} className="text-xs text-red-500">{err}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {result ? (
              <button
                type="button"
                onClick={closeImportDialog}
                className="app-primary-button px-4 py-2 text-sm"
              >
                {t("import.close")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleImport()}
                className="app-primary-button px-4 py-2 text-sm disabled:opacity-50"
                disabled={!fileContent || importing}
              >
                {importing ? t("import.importing") : t("import.importBtn")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
