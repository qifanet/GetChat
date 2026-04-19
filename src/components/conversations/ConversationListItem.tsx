/**
 * @file ConversationListItem.tsx
 * @description Sidebar item for a single conversation summary.
 *
 * The item is designed as a compact desktop list row: one primary title line,
 * one metadata line, and hover-revealed management actions.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getConversationDisplayTitle } from "../../i18n/displayNames";
import { useAppStore } from "../../stores/useAppStoreSelector";
import type { ConversationSummary } from "../../types/conversation";
import { IconArchive, IconPencilSquare, IconTrash } from "../common/Icon";
import { confirmDialog } from "../common/confirmDialog";
const _sel_renameConversation = (s: import("../../stores/appStore.types").AppStore) => s.renameConversation;
const _sel_archiveConversation = (s: import("../../stores/appStore.types").AppStore) => s.archiveConversation;
const _sel_deleteConversation = (s: import("../../stores/appStore.types").AppStore) => s.deleteConversation;
interface ConversationListItemProps {
  summary: ConversationSummary;
  isActive: boolean;
  onOpen: () => void;
}
function formatUpdatedAt(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale.startsWith("zh") ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
export function ConversationListItem({
  summary,
  isActive,
  onOpen,
}: ConversationListItemProps) {
  const { t, i18n } = useTranslation();
  const renameConversation = useAppStore(_sel_renameConversation);
  const archiveConversation = useAppStore(_sel_archiveConversation);
  const deleteConversation = useAppStore(_sel_deleteConversation);
  const [isRenaming, setIsRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(summary.title);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const displayTitle = getConversationDisplayTitle(summary.title, t);
  useEffect(() => {
    setTitleDraft(summary.title);
  }, [summary.id, summary.title]);
  function startRenaming(): void {
    setTitleDraft(summary.title);
    setError(null);
    setIsRenaming(true);
  }
  function cancelRenaming(): void {
    setTitleDraft(summary.title);
    setError(null);
    setIsRenaming(false);
  }
  async function handleRenameSubmit(
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault();
    const trimmedTitle = titleDraft.trim();
    if (trimmedTitle.length === 0) {
      setError(t("conversation.renameRequired"));
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await renameConversation(summary.id, trimmedTitle);
      setIsRenaming(false);
    } catch (renameError) {
      setError(
        renameError instanceof Error
          ? renameError.message
          : t("conversation.renameRequired")
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  async function handleArchive(): Promise<void> {
    if (!(await confirmDialog({
      message: t("conversation.confirmArchive"),
    }))) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await archiveConversation(summary.id);
    } catch (archiveError) {
      setError(
        archiveError instanceof Error
          ? archiveError.message
          : t("conversation.archive")
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  async function handleDelete(): Promise<void> {
    if (!(await confirmDialog({
      message: t("conversation.confirmDelete"),
      destructive: true,
    }))) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await deleteConversation(summary.id);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : t("conversation.delete")
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  return (
    <div
      className={`group rounded-[18px] px-3 py-2.5 text-sm transition-colors ${
        isActive
          ? "bg-miro-blue-light/85 text-miro-blue shadow-ring"
          : "bg-white/82 text-miro-text hover:bg-white"
      }`}
    >
      {isRenaming ? (
        <form className="space-y-2" onSubmit={(event) => void handleRenameSubmit(event)}>
          <input
            autoFocus
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            placeholder={t("conversation.renamePlaceholder")}
            className="app-input px-3 py-2 text-sm"
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
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onOpen}
            onDoubleClick={startRenaming}
            title={t("conversation.rename")}
            className="min-w-0 flex-1 cursor-text text-left"
          >
            <span className="line-clamp-1 font-display text-[14px] font-semibold leading-6 tracking-[-0.015em] text-miro-text">
              {displayTitle}
            </span>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] leading-5 text-miro-text-secondary">
              <span>{t("shell.messageCount", { count: summary.totalMessageCount })}</span>
              <span className="h-1 w-1 rounded-full bg-miro-border" />
              <span>{formatUpdatedAt(summary.updatedAt, i18n.language)}</span>
            </div>
          </button>
          <div
            className={`flex shrink-0 items-center gap-1 pt-0.5 transition-opacity ${
              isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            <button
              type="button"
              className="app-icon-button h-6 w-6 rounded-lg"
              onClick={startRenaming}
              title={t("conversation.rename")}
            >
              <IconPencilSquare size={12} />
            </button>
            <button
              type="button"
              className="app-icon-button h-6 w-6 rounded-lg"
              onClick={() => void handleArchive()}
              title={t("conversation.archive")}
            >
              <IconArchive size={12} />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-red-600 transition-colors hover:bg-red-50 hover:text-red-700"
              onClick={() => void handleDelete()}
              title={t("conversation.delete")}
            >
              <IconTrash size={12} />
            </button>
          </div>
        </div>
      )}
      {error ? <p className="mt-2 text-[11px] leading-5 text-red-600">{error}</p> : null}
    </div>
  );
}
