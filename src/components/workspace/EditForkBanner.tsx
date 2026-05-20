/**
 * @file EditForkBanner.tsx
 * @description Banner shown when workspace enters EDIT_FORK mode.
 *
 * Purpose: make the historical edit mode explicit. The default mode remains
 * non-destructive branch creation; direct overwrite is a user-selected
 * destructive exception.
 *
 * Data source:
 *   - forkIntent.originalEditableMessageId — the message being edited
 *   - forkIntent.sourceType — should be HISTORY_USER_EDIT
 *
 * This component does NOT traverse the message tree.
 */
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { IconPencilSquare } from "../common/Icon";
const _sel_workspace_forkIntent = (s: import("../../stores/appStore.types").AppStore) => s.workspace.forkIntent;
const _sel_clearForkIntent = (s: import("../../stores/appStore.types").AppStore) => s.clearForkIntent;
const _sel_setHistoryEditMode = (s: import("../../stores/appStore.types").AppStore) => s.setHistoryEditMode;
/**
 * Banner for EDIT_FORK workspace mode.
 * Lets the user choose between safe branch creation and destructive overwrite.
 */
export function EditForkBanner() {
  const { t } = useTranslation();
  const forkIntent = useAppStore(_sel_workspace_forkIntent);
  const clearForkIntent = useAppStore(_sel_clearForkIntent);
  const setHistoryEditMode = useAppStore(_sel_setHistoryEditMode);
  if (!forkIntent) return null;
  const editMode = forkIntent.editMode ?? "NEW_BRANCH";
  const isDirectOverwrite = editMode === "DIRECT_OVERWRITE";

  const buttonClass = (active: boolean) =>
    [
      "rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors",
      active
        ? "bg-white text-miro-violet shadow-ring"
        : "text-miro-text-secondary hover:bg-white/50",
    ].join(" ");

  return (
    <div className="mx-4 mb-3 flex flex-col gap-3 rounded-[22px] border border-miro-violet/25 bg-miro-violet-light/75 px-4 py-3 shadow-ring lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-start gap-2">
        <IconPencilSquare size={14} className="mt-1 shrink-0 text-miro-violet" />
        <div className="min-w-0 text-xs leading-6 text-miro-violet">
          <p>
            {t("workspace.editForkPrefix")}
            <span className="font-medium">
              {isDirectOverwrite
                ? t("workspace.editForkDirectEmphasis")
                : t("workspace.editForkEmphasis")}
            </span>
          </p>
          {isDirectOverwrite ? (
            <p className="mt-1 max-w-3xl text-[11px] leading-5 text-red-700">
              {t("workspace.editForkDirectWarning")}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex rounded-2xl border border-miro-violet/20 bg-white/35 p-1">
          <button
            type="button"
            className={buttonClass(!isDirectOverwrite)}
            aria-pressed={!isDirectOverwrite}
            onClick={() => setHistoryEditMode("NEW_BRANCH")}
          >
            {t("workspace.editModeNewBranch")}
          </button>
          <button
            type="button"
            className={buttonClass(isDirectOverwrite)}
            aria-pressed={isDirectOverwrite}
            onClick={() => setHistoryEditMode("DIRECT_OVERWRITE")}
          >
            {t("workspace.editModeDirectOverwrite")}
          </button>
        </div>
        <button
          className="rounded-xl px-3 py-1 text-xs font-semibold text-miro-violet transition-colors hover:bg-white/50"
          onClick={clearForkIntent}
        >
          {t("workspace.cancelEdit")}
        </button>
      </div>
    </div>
  );
}
