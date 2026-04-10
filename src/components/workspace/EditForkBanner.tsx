/**
 * @file EditForkBanner.tsx
 * @description Banner shown when workspace enters EDIT_FORK mode.
 *
 * Purpose: Reinforce non-destructive awareness for message editing.
 * When the user edits a historical user message, this banner confirms
 * that the edit creates a new branch — the original message and its
 * downstream path remain untouched.
 *
 * Data source:
 *   - forkIntent.originalEditableMessageId — the message being edited
 *   - forkIntent.sourceType — should be HISTORY_USER_EDIT
 *
 * This component does NOT traverse the message tree.
 */

import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { IconPencilSquare } from "../common/Icon";

/**
 * Banner for EDIT_FORK workspace mode.
 * Emphasizes: a new branch will be created on save, original path unchanged.
 */
export function EditForkBanner() {
  const { t } = useTranslation();
  const forkIntent = useAppStore((s) => s.workspace.forkIntent);
  const clearForkIntent = useAppStore((s) => s.clearForkIntent);

  if (!forkIntent) return null;

  return (
    <div className="mx-4 mb-3 flex items-center justify-between rounded-[22px] border border-miro-violet/25 bg-miro-violet-light/75 px-4 py-3 shadow-ring">
      <div className="flex items-center gap-2">
        <IconPencilSquare size={14} className="shrink-0 text-miro-violet" />
        <p className="text-xs leading-6 text-miro-violet">
          {t("workspace.editForkPrefix")}
          <span className="font-medium">{t("workspace.editForkEmphasis")}</span>
        </p>
      </div>

      <button
        className="shrink-0 rounded-xl px-3 py-1 text-xs font-semibold text-miro-violet transition-colors hover:bg-white/50"
        onClick={clearForkIntent}
      >
        {t("workspace.cancelEdit")}
      </button>
    </div>
  );
}
