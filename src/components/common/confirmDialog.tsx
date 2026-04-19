/**
 * @file confirmDialog.tsx
 * @description Imperative confirm dialog replacing native window.confirm/alert.
 *
 * Usage (callers):
 *   import { confirmDialog } from "../common/confirmDialog";
 *   const ok = await confirmDialog({ message: "确定删除？" });
 *
 * Usage (mount once in App root):
 *   import { ConfirmDialogPortal } from "../common/confirmDialog";
 *   <ConfirmDialogPortal />
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconX } from "./Icon";
// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface ConfirmDialogOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}
// ---------------------------------------------------------------------------
// Module-level state (no store dependency)
// ---------------------------------------------------------------------------
interface PendingEntry {
  options: ConfirmDialogOptions;
  resolve: (value: boolean) => void;
}
let _pending: PendingEntry | null = null;
let _rerender: (() => void) | null = null;
function show(opts: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (_pending) {
      _pending.resolve(false);
    }
    _pending = { options: opts, resolve };
    _rerender?.();
  });
}
function resolveDialog(value: boolean) {
  _pending?.resolve(value);
  _pending = null;
  _rerender?.();
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return show(options);
}
// ---------------------------------------------------------------------------
// React component — mount once in App root
// ---------------------------------------------------------------------------
export function ConfirmDialogPortal() {
  const [, setTick] = useState(0);
  const { t } = useTranslation();
  useEffect(() => {
    _rerender = () => setTick((n) => n + 1);
    return () => { _rerender = null; };
  }, []);
  const open = _pending !== null;
  const handleConfirm = useCallback(() => resolveDialog(true), []);
  const handleCancel = useCallback(() => resolveDialog(false), []);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolveDialog(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);
  if (!open) return null;
  const opts = _pending!.options;
  const title = opts.title ?? t("common.confirm");
  const confirmLabel = opts.confirmLabel ?? t("common.confirm");
  const cancelLabel = opts.cancelLabel ?? t("common.cancel");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="fixed inset-0 bg-slate-950/30 backdrop-blur-[2px]"
        onClick={handleCancel}
        aria-label={cancelLabel}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-sm rounded-shell bg-white px-7 py-7 shadow-panel"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
            {title}
          </h2>
          <button
            type="button"
            onClick={handleCancel}
            className="app-icon-button h-8 w-8"
            title={cancelLabel}
            aria-label={cancelLabel}
          >
            <IconX size={16} />
          </button>
        </div>
        <p className="mb-6 text-sm leading-6 text-miro-text-secondary">
          {opts.message}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            className="app-secondary-button px-4 py-2 text-sm"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className={
              opts.destructive
                ? "inline-flex items-center justify-center gap-1.5 rounded-[12px] bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 active:bg-red-800"
                : "app-primary-button px-4 py-2 text-sm"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
