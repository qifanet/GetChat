/**
 * @file FilePreviewPanel.tsx
 * @description Read-only file preview panel shown when a file is selected
 * in the FileExplorerPanel.
 *
 * Displays file content with line numbers, truncation notice,
 * and language detection based on file extension.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import * as tauriCmd from "../../services/tauriCommands";
import type { FilePreviewDto } from "../../services/tauriTypes";
import { IconFile, IconX } from "../common/Icon";

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  rs: "Rust",
  py: "Python",
  json: "JSON",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  md: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sql: "SQL",
  sh: "Shell",
  bash: "Bash",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
  h: "C Header",
  svg: "SVG",
  xml: "XML",
  txt: "Plain Text",
};

function detectLanguage(filePath: string): string | null {
  const fileName = filePath.split(/[\\/]/).pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? null;
}

interface FilePreviewPanelProps {
  filePath: string;
  onClose: () => void;
}

export function FilePreviewPanel({ filePath, onClose }: FilePreviewPanelProps) {
  const { t } = useTranslation();
  const activeConversationId = useAppStore(
    (s) => s.workspace.activeConversationId
  );

  const [preview, setPreview] = useState<FilePreviewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeConversationId || !filePath) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    tauriCmd
      .readFilePreview(activeConversationId, filePath, 500)
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
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
  }, [activeConversationId, filePath]);

  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const detectedLang = preview?.language ?? detectLanguage(filePath);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-white"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-miro-border/20 px-3 py-2">
        <IconFile size={14} className="shrink-0 text-miro-blue" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-miro-text">
          {fileName}
        </span>
        {detectedLang && (
          <span className="shrink-0 rounded bg-miro-surface-low px-1.5 py-0.5 text-[10px] text-miro-text-secondary">
            {detectedLang}
          </span>
        )}
        <button
          type="button"
          className="app-icon-button ml-1 h-6 w-6 shrink-0"
          onClick={onClose}
          title={t("common.collapse")}
        >
          <IconX size={10} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center px-4 py-8">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-miro-blue border-t-transparent" />
          </div>
        )}

        {error && (
          <div className="px-4 py-4 text-center text-xs text-miro-red">
            {error}
          </div>
        )}

        {preview && !loading && !error && (
          <>
            {preview.truncated && (
              <div className="border-b border-amber-200 bg-amber-50/60 px-3 py-1.5 text-[11px] text-amber-700">
                {t("fileExplorer.truncated", {
                  lines: preview.totalLines,
                  maxLines: 500,
                })}
              </div>
            )}
            <pre className="overflow-x-auto p-0 text-[12px] leading-5">
              <code className="block">
                {preview.content.split("\n").map((line, index) => (
                  <div key={index} className="flex">
                    <span className="inline-block w-10 shrink-0 select-none text-right text-[10px] leading-5 text-miro-border">
                      {index + 1}
                    </span>
                    <span className="flex-1 whitespace-pre-wrap break-all pl-3 text-miro-text">
                      {line}
                    </span>
                  </div>
                ))}
              </code>
            </pre>
          </>
        )}

        {!preview && !loading && !error && (
          <div className="px-4 py-4 text-center text-xs text-miro-text-secondary">
            {t("fileExplorer.noPreview")}
          </div>
        )}
      </div>
    </div>
  );
}
