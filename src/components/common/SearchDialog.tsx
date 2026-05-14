/**
 * @file SearchDialog.tsx
 * @description Full-text search dialog triggered by Ctrl/Cmd + K.
 *
 * Features:
 *   - Debounced search (300ms) across all conversations
 *   - Results grouped by conversation with snippet display
 *   - Click result to navigate to the correct branch and scroll to message
 *   - Recent conversations shown when query is empty
 */

import { useTranslation } from "react-i18next";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { searchMessages, type SearchResultItem } from "../../services/tauriCommands";
import { getConversationDisplayTitle } from "../../i18n/displayNames";

interface SearchDialogProps {
  onClose: () => void;
  onNavigate: (conversationId: string, messageId?: string) => void;
}

export function SearchDialog({ onClose, onNavigate }: SearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const summariesById = useAppStore((s) => s.summariesById);
  const summaryOrder = useAppStore((s) => s.summaryOrder);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const items = await searchMessages({ query: query.trim(), limit: 30 });
        setResults(items);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  // Group results by conversation
  const groupedResults = useMemo(() => {
    const groups = new Map<string, SearchResultItem[]>();
    for (const item of results) {
      const existing = groups.get(item.conversationId) ?? [];
      existing.push(item);
      groups.set(item.conversationId, existing);
    }
    return Array.from(groups.entries());
  }, [results]);

  // Recent conversations for empty state
  const recentConversations = useMemo(() => {
    return summaryOrder
      .slice(0, 5)
      .map((id) => summariesById[id])
      .filter(Boolean);
  }, [summaryOrder, summariesById]);

  const handleSelectResult = useCallback(
    (conversationId: string, messageId: string) => {
      onNavigate(conversationId, messageId);
      onClose();
    },
    [onNavigate, onClose]
  );

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      onNavigate(conversationId);
      onClose();
    },
    [onNavigate, onClose]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      <button
        type="button"
        className="fixed inset-0 bg-slate-950/20 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-miro-border/30 bg-white shadow-2xl">
        <div className="flex items-center border-b border-miro-border/20 px-4">
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mr-3 flex-shrink-0 text-miro-text-secondary"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search.placeholder")}
            className="h-12 w-full bg-transparent text-sm text-miro-text outline-none placeholder:text-miro-text-secondary/50"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="ml-2 flex-shrink-0 rounded-md px-1.5 py-0.5 text-xs text-miro-text-secondary hover:bg-miro-surface-low"
            >
              Esc
            </button>
          ) : null}
        </div>

        <div className="max-h-[360px] overflow-y-auto p-2">
          {query.trim() ? (
            loading ? (
              <div className="px-3 py-6 text-center text-sm text-miro-text-secondary">
                {t("search.searching")}
              </div>
            ) : results.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-miro-text-secondary">
                {t("search.noResults")}
              </div>
            ) : (
              groupedResults.map(([conversationId, items]) => {
                const summary = summariesById[conversationId];
                const title = summary
                  ? getConversationDisplayTitle(summary.title, t)
                  : conversationId;
                return (
                  <div key={conversationId} className="mb-2">
                    <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-miro-text-secondary">
                      {title}
                    </div>
                    {items.map((item) => (
                      <button
                        key={item.messageId}
                        type="button"
                        onClick={() => handleSelectResult(conversationId, item.messageId)}
                        className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-miro-blue-light/40"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] font-semibold uppercase ${
                              item.role === "USER"
                                ? "text-miro-blue"
                                : "text-miro-text-secondary"
                            }`}
                          >
                            {item.role === "USER" ? t("common.user") : t("common.assistant")}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm leading-5 text-miro-text">
                          {highlightSnippet(item.snippet, query.trim())}
                        </p>
                      </button>
                    ))}
                  </div>
                );
              })
            )
          ) : (
            <>
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-miro-text-secondary">
                {t("search.recent")}
              </div>
              {recentConversations.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-miro-text-secondary">
                  {t("search.noRecent")}
                </div>
              ) : (
                recentConversations.map((summary) => (
                  <button
                    key={summary.id}
                    type="button"
                    onClick={() => handleSelectConversation(summary.id)}
                    className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-miro-blue-light/40"
                  >
                    <span className="text-sm text-miro-text">
                      {getConversationDisplayTitle(summary.title, t)}
                    </span>
                  </button>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function highlightSnippet(snippet: string, query: string): React.ReactNode {
  const lowerSnippet = snippet.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerSnippet.indexOf(lowerQuery);
  if (idx === -1) return snippet;

  const before = snippet.slice(0, idx);
  const match = snippet.slice(idx, idx + query.length);
  const after = snippet.slice(idx + query.length);

  return (
    <>
      {before}
      <mark className="rounded-sm bg-amber-200/80 px-0.5 text-miro-text">{match}</mark>
      {after}
    </>
  );
}
