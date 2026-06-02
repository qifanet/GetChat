/**
 * @file ModelSelector.tsx
 * @description Custom model selector dropdown replacing native <select>.
 * Groups models by provider, supports keyboard navigation, and matches the
 * application's design language.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AvailableModelOption } from "../../features/models/modelUtils";

interface ModelSelectorProps {
  options: AvailableModelOption[];
  value: string | null;
  onChange: (modelId: string | null) => void;
  placeholder: string;
  className?: string;
}

interface GroupedOptions {
  providerId: string;
  providerName: string;
  models: AvailableModelOption[];
}

export function ModelSelector({
  options,
  value,
  onChange,
  placeholder,
  className = "",
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const flatList = useMemo(() => {
    const items: Array<{ type: "option"; model: AvailableModelOption } | { type: "header"; providerName: string }> = [];
    const groups: GroupedOptions[] = [];
    for (const opt of options) {
      const existing = groups.find((g) => g.providerId === opt.providerId);
      if (existing) {
        existing.models.push(opt);
      } else {
        groups.push({
          providerId: opt.providerId,
          providerName: opt.providerName,
          models: [opt],
        });
      }
    }
    for (const group of groups) {
      items.push({ type: "header", providerName: group.providerName });
      for (const model of group.models) {
        items.push({ type: "option", model });
      }
    }
    return items;
  }, [options]);

  const selectedIndex = useMemo(
    () => flatList.findIndex((item) => item.type === "option" && item.model.id === value),
    [flatList, value]
  );

  const selectedLabel = useMemo(() => {
    if (!value) return placeholder;
    const found = options.find((o) => o.id === value);
    return found ? found.displayName : value;
  }, [options, value, placeholder]);

  const handleSelect = useCallback(
    (modelId: string | null) => {
      onChange(modelId);
      setOpen(false);
    },
    [onChange]
  );

  useEffect(() => {
    if (!open) {
      setHighlightIndex(-1);
      return;
    }
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (open && selectedIndex >= 0) {
      setHighlightIndex(selectedIndex);
    }
  }, [open, selectedIndex]);

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${highlightIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    const optionIndices = flatList
      .map((item, i) => (item.type === "option" ? i : -1))
      .filter((i) => i >= 0);

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const curPos = optionIndices.indexOf(highlightIndex);
        const nextPos = curPos < optionIndices.length - 1 ? curPos + 1 : 0;
        setHighlightIndex(optionIndices[nextPos]);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const curPos = optionIndices.indexOf(highlightIndex);
        const prevPos = curPos > 0 ? curPos - 1 : optionIndices.length - 1;
        setHighlightIndex(optionIndices[prevPos]);
        break;
      }
      case "Enter": {
        e.preventDefault();
        if (highlightIndex === -1) {
          handleSelect(null);
        } else if (highlightIndex >= 0) {
          const item = flatList[highlightIndex];
          if (item.type === "option") handleSelect(item.model.id);
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        className={`flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-sm transition-colors ${
          open
            ? "bg-miro-blue-light text-miro-blue"
            : "text-miro-text hover:bg-miro-surface-low"
        }`}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="min-w-0 truncate">{selectedLabel}</span>
        <svg
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1 max-h-64 min-w-[240px] overflow-y-auto rounded-xl border border-miro-border/20 bg-miro-card/95 py-1 shadow-lg backdrop-blur-sm"
          style={{ animation: "settings-toast-in 0.15s ease-out" }}
        >
          {/* "Use default" option */}
          <button
            type="button"
            role="option"
            aria-selected={!value}
            data-idx={-1}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
              !value
                ? "bg-miro-blue-light/60 text-miro-blue font-medium"
                : "text-miro-text-secondary hover:bg-miro-surface-low"
            }`}
            onClick={() => handleSelect(null)}
            onMouseEnter={() => setHighlightIndex(-1)}
          >
            <span className="min-w-0 truncate">{placeholder}</span>
          </button>

          {flatList.map((item, idx) => {
            if (item.type === "header") {
              return (
                <div
                  key={`hdr-${item.providerName}`}
                  className="mt-1 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-miro-text-secondary"
                >
                  {item.providerName}
                </div>
              );
            }
            const isSelected = item.model.id === value;
            const isHighlighted = idx === highlightIndex;
            return (
              <button
                type="button"
                role="option"
                key={item.model.id}
                aria-selected={isSelected}
                data-idx={idx}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                  isSelected
                    ? "bg-miro-blue-light/60 text-miro-blue font-medium"
                    : isHighlighted
                      ? "bg-miro-surface-low text-miro-text"
                      : "text-miro-text hover:bg-miro-surface-low"
                }`}
                onClick={() => handleSelect(item.model.id)}
                onMouseEnter={() => setHighlightIndex(idx)}
              >
                <span className="min-w-0 truncate">{item.model.displayName}</span>
              </button>
            );
          })}

          {options.length === 0 && (
            <div className="px-3 py-3 text-center text-xs text-miro-text-secondary">
              {t("shell.noModelsAvailable", "No models configured")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
