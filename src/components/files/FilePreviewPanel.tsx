/**
 * @file FilePreviewPanel.tsx
 * @description Full-area file preview overlay for the workspace center.
 *
 * Replaces the chat area when a file is selected for preview.
 * Shows file content with line numbers, text search, truncation notice,
 * language detection, and graceful handling of binary/unsupported files.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import * as tauriCmd from "../../services/tauriCommands";
import type { FilePreviewDto } from "../../services/tauriTypes";
import { IconChevronDown, IconChevronUp, IconFile, IconX } from "../common/Icon";

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript JSX",
  js: "JavaScript", jsx: "JavaScript JSX",
  rs: "Rust", py: "Python", json: "JSON",
  css: "CSS", scss: "SCSS", html: "HTML",
  md: "Markdown", yaml: "YAML", yml: "YAML",
  toml: "TOML", sql: "SQL", sh: "Shell",
  bash: "Bash", go: "Go", java: "Java",
  c: "C", cpp: "C++", h: "C Header",
  svg: "SVG", xml: "XML", txt: "Plain Text",
};

const BINARY_TYPE_HINTS: Record<string, { reason: string; suggestion: string }> = {
  docx: { reason: "Microsoft Word document (compressed XML)", suggestion: "Open in Word or LibreOffice" },
  doc: { reason: "Legacy Word binary format", suggestion: "Open in Word or LibreOffice" },
  xlsx: { reason: "Microsoft Excel spreadsheet (compressed XML)", suggestion: "Open in Excel or LibreOffice" },
  xls: { reason: "Legacy Excel binary format", suggestion: "Open in Excel or LibreOffice" },
  pptx: { reason: "Microsoft PowerPoint (compressed XML)", suggestion: "Open in PowerPoint" },
  pdf: { reason: "PDF document", suggestion: "Open in a PDF viewer" },
  zip: { reason: "ZIP archive", suggestion: "Extract with your archive manager" },
  "7z": { reason: "7-Zip archive", suggestion: "Extract with 7-Zip or your archive manager" },
  rar: { reason: "RAR archive", suggestion: "Extract with your archive manager" },
  tar: { reason: "Tar archive", suggestion: "Extract with your archive manager" },
  gz: { reason: "Gzip compressed file", suggestion: "Extract with your archive manager" },
  png: { reason: "PNG image", suggestion: "Open in an image viewer" },
  jpg: { reason: "JPEG image", suggestion: "Open in an image viewer" },
  jpeg: { reason: "JPEG image", suggestion: "Open in an image viewer" },
  exe: { reason: "Windows executable", suggestion: "Run or inspect as needed" },
  dll: { reason: "Windows dynamic library", suggestion: "Binary library file" },
  mp3: { reason: "MP3 audio file", suggestion: "Open in a media player" },
  mp4: { reason: "MP4 video file", suggestion: "Open in a media player" },
};

function detectLanguage(filePath: string): string | null {
  const fileName = filePath.split(/[\\/]/).pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? null;
}

function getExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

interface SearchResult {
  lineIndex: number;
  matchStart: number;
  matchEnd: number;
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
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matchRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!activeConversationId || !filePath) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    tauriCmd
      .readFilePreview(activeConversationId, filePath, 2000)
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
  const ext = getExtension(filePath);
  const detectedLang = preview?.language ?? detectLanguage(filePath);
  const binaryHint = BINARY_TYPE_HINTS[ext];

  // Search logic
  const searchResults = useMemo<SearchResult[]>(() => {
    if (!searchQuery.trim() || !preview?.content || preview.isBinary) return [];
    const query = searchQuery.toLowerCase();
    const results: SearchResult[] = [];
    const lines = preview.content.split("\n");

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx].toLowerCase();
      let pos = 0;
      while (true) {
        const idx = line.indexOf(query, pos);
        if (idx === -1) break;
        results.push({ lineIndex: lineIdx, matchStart: idx, matchEnd: idx + query.length });
        pos = idx + 1;
      }
    }

    return results;
  }, [searchQuery, preview?.content, preview?.isBinary]);

  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  // Scroll to current match
  useEffect(() => {
    if (searchResults.length === 0) return;
    const match = searchResults[currentMatchIndex];
    if (!match) return;
    const el = matchRefs.current.get(match.lineIndex);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [currentMatchIndex, searchResults]);

  const handleOpenInFileManager = useCallback(async () => {
    if (!activeConversationId) return;
    try {
      await tauriCmd.revealInFileManager(activeConversationId, filePath);
    } catch (err) {
      console.error("[filePreview] failed to reveal in file manager", err);
    }
  }, [activeConversationId, filePath]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (searchQuery) {
          setSearchQuery("");
        } else {
          onClose();
        }
      }
      if (e.key === "Enter" && searchResults.length > 0) {
        if (e.shiftKey) {
          setCurrentMatchIndex((prev) =>
            prev > 0 ? prev - 1 : searchResults.length - 1
          );
        } else {
          setCurrentMatchIndex((prev) =>
            prev < searchResults.length - 1 ? prev + 1 : 0
          );
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    },
    [onClose, searchQuery, searchResults.length]
  );

  const lines = preview?.content ? preview.content.split("\n") : [];
  const matchedLineIndices = new Set(searchResults.map((r) => r.lineIndex));

  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-miro-card"
      onKeyDown={handleKeyDown}
      ref={(el) => {
        if (el) el.focus();
      }}
      tabIndex={0}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-miro-border/20 px-4 py-2.5">
        <IconFile size={16} className="shrink-0 text-miro-blue" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-miro-text">
          {fileName}
        </span>
        {detectedLang && (
          <span className="shrink-0 rounded bg-miro-surface-low px-1.5 py-0.5 text-[10px] text-miro-text-secondary">
            {detectedLang}
          </span>
        )}
        {preview && !preview.isBinary && (
          <span className="shrink-0 text-[10px] text-miro-text-secondary">
            {t("fileExplorer.lineCount", { count: preview.totalLines })} · {formatFileSize(preview.fileSize)}
          </span>
        )}
        {preview?.isBinary && (
          <span className="shrink-0 text-[10px] text-miro-text-secondary">
            {formatFileSize(preview.fileSize)}
          </span>
        )}

        {/* Search bar (text files only) */}
        {preview && !preview.isBinary && !loading && (
          <div className="flex items-center gap-1">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`${t("fileExplorer.searchPlaceholder")} (Ctrl+F)`}
              className="h-7 w-[180px] rounded-md border border-miro-border/30 bg-miro-surface-low px-2 text-[12px] text-miro-text placeholder:text-miro-text-secondary/60 focus:border-miro-blue focus:outline-none"
            />
            {searchResults.length > 0 && (
              <span className="shrink-0 text-[10px] tabular-nums text-miro-text-secondary">
                {currentMatchIndex + 1}/{searchResults.length}
              </span>
            )}
            {searchResults.length > 1 && (
              <div className="flex flex-col">
                <button
                  type="button"
                  className="leading-none text-miro-text-secondary hover:text-miro-text"
                  onClick={() =>
                    setCurrentMatchIndex((prev) =>
                      prev > 0 ? prev - 1 : searchResults.length - 1
                    )
                  }
                >
                  <IconChevronUp size={10} />
                </button>
                <button
                  type="button"
                  className="-mt-0.5 leading-none text-miro-text-secondary hover:text-miro-text"
                  onClick={() =>
                    setCurrentMatchIndex((prev) =>
                      prev < searchResults.length - 1 ? prev + 1 : 0
                    )
                  }
                >
                  <IconChevronDown size={10} />
                </button>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className="app-icon-button ml-1 h-7 w-7 shrink-0"
          onClick={onClose}
          title={t("fileExplorer.closePreview")}
        >
          <IconX size={12} />
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center px-4 py-16">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-miro-blue border-t-transparent" />
            <span className="ml-3 text-sm text-miro-text-secondary">{t("common.loading")}</span>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-miro-red-light text-miro-red">
              <IconFile size={20} />
            </div>
            <p className="text-sm text-miro-red">{error}</p>
            <button
              type="button"
              className="app-secondary-button px-4 py-2 text-xs"
              onClick={handleOpenInFileManager}
            >
              {t("fileExplorer.openInFileManager")}
            </button>
          </div>
        )}

        {preview?.isBinary && !loading && !error && (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-miro-surface-low">
              <IconFile size={28} className="text-miro-text-secondary" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-miro-text">
                {t("fileExplorer.binaryFileTitle")}
              </p>
              <p className="text-xs text-miro-text-secondary">
                {binaryHint?.reason ?? t("fileExplorer.binaryFileReason")}
              </p>
            </div>
            <div className="rounded-lg border border-miro-border/20 bg-miro-surface-low/50 px-4 py-3 text-left">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-miro-text-secondary">
                {t("fileExplorer.recommendedAction")}
              </p>
              <p className="text-xs text-miro-text">
                {binaryHint?.suggestion ?? t("fileExplorer.openExternally")}
              </p>
            </div>
            <button
              type="button"
              className="app-primary-button px-5 py-2 text-xs"
              onClick={handleOpenInFileManager}
            >
              {t("fileExplorer.openInFileManager")}
            </button>
          </div>
        )}

        {preview && !preview.isBinary && !loading && !error && (
          <>
            {preview.truncated && (
              <div className="border-b border-miro-amber-light bg-miro-amber-light/60 px-4 py-1.5 text-[11px] text-miro-amber">
                {t("fileExplorer.truncated", {
                  lines: preview.totalLines,
                  maxLines: 2000,
                })}
              </div>
            )}
            <div className="px-2 py-1">
              {lines.map((line, index) => {
                const isMatch = matchedLineIndices.has(index);
                const currentMatchLine = searchResults[currentMatchIndex]?.lineIndex;
                const isCurrentMatch = isMatch && index === currentMatchLine;

                return (
                  <div
                    key={index}
                    ref={isMatch ? (el) => {
                      if (el) matchRefs.current.set(index, el);
                    } : undefined}
                    className={`flex rounded-sm ${
                      isCurrentMatch
                        ? "bg-miro-blue-light/80"
                        : isMatch
                          ? "bg-yellow-100/60"
                          : "hover:bg-miro-surface-low/50"
                    }`}
                  >
                    <span className="inline-block w-12 shrink-0 select-none text-right text-[10px] leading-[22px] text-miro-border">
                      {index + 1}
                    </span>
                    <span className="whitespace-pre pl-4 text-[13px] leading-[22px] text-miro-text">
                      {line}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {!preview && !loading && !error && (
          <div className="flex items-center justify-center px-4 py-16 text-xs text-miro-text-secondary">
            {t("fileExplorer.noPreview")}
          </div>
        )}
      </div>
    </div>
  );
}
