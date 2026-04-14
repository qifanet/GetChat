/**
 * @file BranchRenameDialog.tsx
 * @description Modal dialog for renaming a branch.
 *
 * Wired to the store's branchRenameDialogOpen state and renameBranch action.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { IconX } from "../common/Icon";

/** Modal dialog for renaming the currently selected branch. */
export function BranchRenameDialog() {
  const { t } = useTranslation();
  const dialogOpen = useAppStore((state) => state.ui.branchRenameDialogOpen);
  const closeDialog = useAppStore((state) => state.closeBranchRenameDialog);
  const renameBranch = useAppStore((state) => state.renameBranch);
  const currentBranchId = useAppStore((state) => state.workspace.currentBranchId);
  const activeSnapshot = useAppStore((state) => state.activeSnapshot);

  const currentBranch = currentBranchId && activeSnapshot
    ? activeSnapshot.entities.branches[currentBranchId] ?? null
    : null;

  const [name, setName] = useState(currentBranch?.name ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialogOpen && currentBranch) {
      setName(currentBranch.name);
      setError(null);
      setSubmitting(false);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [dialogOpen, currentBranch]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) {
        setError(t("branch.renameRequired"));
        return;
      }
      if (!currentBranchId) return;

      setSubmitting(true);
      setError(null);
      try {
        await renameBranch(currentBranchId, trimmed);
        closeDialog();
      } catch (err) {
        setError(err instanceof Error ? err.message : t("branch.renameRequired"));
      } finally {
        setSubmitting(false);
      }
    },
    [closeDialog, currentBranchId, name, renameBranch, t]
  );

  if (!dialogOpen || !currentBranch) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="fixed inset-0 bg-slate-950/30 backdrop-blur-[2px]"
        onClick={closeDialog}
        aria-label={t("common.cancel")}
      />

      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="relative z-10 w-full max-w-sm rounded-shell bg-white px-7 py-7 shadow-panel"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
            {t("branch.rename")}
          </h2>
          <button
            type="button"
            onClick={closeDialog}
            className="app-icon-button h-8 w-8"
            aria-label={t("common.cancel")}
          >
            <IconX size={16} />
          </button>
        </div>

        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("branch.renamePlaceholder")}
          className="app-input mb-4 w-full"
        />

        {error ? (
          <p className="mb-3 text-xs leading-5 text-red-600">{error}</p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeDialog}
            className="app-secondary-button px-4 py-2 text-sm"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={submitting || name.trim().length === 0}
            className="app-primary-button px-4 py-2 text-sm disabled:opacity-50"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
