/**
 * @file HistoryForkBanner.tsx
 * @description Banner shown when workspace enters HISTORY_FORK mode.
 *
 * Purpose: Reinforce non-destructive awareness.
 * When the user clicks "continue from history message", this banner
 * appears to confirm that the original path will NOT be overwritten.
 *
 * Data source:
 *   - forkIntent.sourceMessageId — identifies which message was forked from
 *   - forkIntent.sourceType — ROOT | CURRENT_LEAF | HISTORY_ASSISTANT | VARIANT
 *
 * This component does NOT traverse the message tree.
 * It reads forkIntent from the store and renders static copy.
 */

import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { IconInfoCircle } from "../common/Icon";

/**
 * Banner for HISTORY_FORK workspace mode.
 * Emphasizes: a new branch will be created on send, original path unchanged.
 */
export function HistoryForkBanner() {
  const { t } = useTranslation();
  const forkIntent = useAppStore((s) => s.workspace.forkIntent);
  const clearForkIntent = useAppStore((s) => s.clearForkIntent);

  if (!forkIntent) return null;

  return (
    <div className="mx-4 mb-3 flex items-center justify-between rounded-[22px] border border-miro-blue/25 bg-miro-blue-light/80 px-4 py-3 shadow-ring">
      <div className="flex items-center gap-2">
        <IconInfoCircle size={14} className="shrink-0 text-miro-blue" />
        <p className="text-xs leading-6 text-miro-blue">
          {t("workspace.historyForkPrefix")}
          <span className="font-medium">{t("workspace.historyForkEmphasis")}</span>
        </p>
      </div>

      <button
        className="shrink-0 rounded-xl px-3 py-1 text-xs font-semibold text-miro-blue transition-colors hover:bg-white/60"
        onClick={clearForkIntent}
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}
