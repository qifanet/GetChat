/**
 * @file BranchListItem.tsx
 * @description Compact branch row used in the right-side branch manager.
 *
 * The row emphasizes branch identity first, while hover actions expose the
 * real branch commands without overwhelming the rail.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getBranchDisplayName } from "../../i18n/displayNames";
import { useAppStore } from "../../stores/useAppStore";
import type { BranchEntity } from "../../types/conversation";
import {
  IconArchive,
  IconColumns,
  IconPencilSquare,
  IconRotateCcw,
  IconStarOutline,
} from "../common/Icon";

interface BranchListItemProps {
  /** The branch to display. */
  branch: BranchEntity;

  /** Whether this is the currently viewed branch. */
  isCurrent: boolean;
}

/** Render a single branch row with inline actions. */
export function BranchListItem({ branch, isCurrent }: BranchListItemProps) {
  const { t } = useTranslation();
  const setCurrentBranch = useAppStore((state) => state.setCurrentBranch);
  const renameBranch = useAppStore((state) => state.renameBranch);
  const archiveBranch = useAppStore((state) => state.archiveBranch);
  const unarchiveBranch = useAppStore((state) => state.unarchiveBranch);
  const setMainlineBranch = useAppStore((state) => state.setMainlineBranch);
  const currentBranchId = useAppStore((state) => state.workspace.currentBranchId);
  const activeConversationId = useAppStore(
    (state) => state.workspace.activeConversationId
  );
  const enterCompare = useAppStore((state) => state.enterCompare);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(branch.name);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const displayBranchName = getBranchDisplayName(branch.name, t);
  const canCompare = Boolean(currentBranchId && currentBranchId !== branch.id);

  useEffect(() => {
    setRenameDraft(branch.name);
  }, [branch.id, branch.name]);

  /** Open the branch as the current workspace path. */
  function handleClick(): void {
    if (!isRenaming) {
      setCurrentBranch(branch.id);
    }
  }

  /** Start inline branch renaming. */
  function startRenaming(): void {
    setRenameDraft(branch.name);
    setError(null);
    setIsRenaming(true);
  }

  /** Cancel inline renaming and restore the committed name. */
  function cancelRenaming(): void {
    setRenameDraft(branch.name);
    setError(null);
    setIsRenaming(false);
  }

  /** Persist the inline rename form through the store-backed command. */
  async function handleRenameSubmit(
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault();

    const trimmedName = renameDraft.trim();
    if (trimmedName.length === 0) {
      setError(t("branch.renameRequired"));
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await renameBranch(branch.id, trimmedName);
      setIsRenaming(false);
    } catch (renameError) {
      setError(
        renameError instanceof Error
          ? renameError.message
          : t("branch.renameRequired")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Promote this branch to the conversation mainline. */
  async function handleSetMainline(): Promise<void> {
    if (!activeConversationId) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await setMainlineBranch(activeConversationId, branch.id);
    } catch (mainlineError) {
      setError(
        mainlineError instanceof Error
          ? mainlineError.message
          : t("branch.setAsMainline")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Archive or restore the branch through the real store action. */
  async function handleToggleArchive(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      if (branch.status === "ARCHIVED") {
        await unarchiveBranch(branch.id);
      } else {
        await archiveBranch(branch.id);
      }
    } catch (archiveError) {
      setError(
        archiveError instanceof Error
          ? archiveError.message
          : branch.status === "ARCHIVED"
            ? t("branch.unarchive")
            : t("branch.archive")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Compare this branch against the currently opened branch. */
  function handleCompare(): void {
    if (!currentBranchId || currentBranchId === branch.id) {
      return;
    }

    setError(null);
    enterCompare({
      leftBranchId: currentBranchId,
      rightBranchId: branch.id,
    });
  }

  return (
    <div
      className={`group rounded-[22px] px-3 py-3 transition-colors ${
        isCurrent ? "bg-white shadow-ring" : "bg-white/72 hover:bg-white"
      }`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleClick();
        }
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <form
              className="space-y-2"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => void handleRenameSubmit(event)}
            >
              <input
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                placeholder={t("branch.renamePlaceholder")}
                className="app-input px-3 py-2"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="app-primary-button px-3 py-1.5 text-[11px]"
                >
                  {t("common.save")}
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  className="app-secondary-button px-3 py-1.5 text-[11px]"
                  onClick={cancelRenaming}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-display text-sm font-semibold text-miro-text">
                  {displayBranchName}
                </span>
                {branch.isMainline ? (
                  <span className="app-status-pill border-miro-green/20 bg-miro-green-light/80 text-miro-green">
                    {t("common.mainline")}
                  </span>
                ) : null}
                {isCurrent ? (
                  <span className="app-status-pill border-miro-blue/15 bg-miro-blue-light text-miro-blue">
                    {t("common.current")}
                  </span>
                ) : null}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-miro-text-secondary">
                <span>{branch.status === "ARCHIVED" ? t("branch.archivedBranches") : t("branch.panelTitle")}</span>
                {branch.forkPointMessageId ? (
                  <>
                    <span className="h-1 w-1 rounded-full bg-miro-border" />
                    <span>{t("path.forkFromMessage")}</span>
                  </>
                ) : null}
              </div>
            </>
          )}

          {error ? <p className="mt-2 text-[11px] leading-5 text-red-600">{error}</p> : null}
        </div>

        {!isRenaming ? (
          <div
            className={`flex items-center gap-1 transition-opacity ${
              isCurrent ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            <button
              type="button"
              className="app-icon-button h-7 w-7"
              onClick={(event) => {
                event.stopPropagation();
                startRenaming();
              }}
              title={t("branch.rename")}
            >
              <IconPencilSquare size={12} />
            </button>
            {!branch.isMainline && branch.status === "ACTIVE" ? (
              <button
                type="button"
                className="app-icon-button h-7 w-7"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleSetMainline();
                }}
                title={t("branch.setAsMainline")}
              >
                <IconStarOutline size={12} />
              </button>
            ) : null}
            <button
              type="button"
              className="app-icon-button h-7 w-7 disabled:cursor-not-allowed disabled:text-miro-text-secondary/50 disabled:hover:bg-transparent"
              onClick={(event) => {
                event.stopPropagation();
                handleCompare();
              }}
              disabled={!canCompare}
              title={
                canCompare
                  ? t("branch.compareWithCurrent")
                  : t("branch.compareUnavailable")
              }
            >
              <IconColumns size={12} />
            </button>
            <button
              type="button"
              className="app-icon-button h-7 w-7"
              onClick={(event) => {
                event.stopPropagation();
                void handleToggleArchive();
              }}
              title={
                branch.status === "ARCHIVED"
                  ? t("branch.unarchive")
                  : t("branch.archive")
              }
            >
              {branch.status === "ARCHIVED" ? (
                <IconRotateCcw size={12} />
              ) : (
                <IconArchive size={12} />
              )}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
