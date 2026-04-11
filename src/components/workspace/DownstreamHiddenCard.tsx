/**
 * @file DownstreamHiddenCard.tsx
 * @description Shows how many downstream messages are hidden during fork mode.
 *
 * Purpose: Make the "hidden messages" consequence visible.
 * When the user enters HISTORY_FORK or EDIT_FORK, downstream messages
 * beyond the fork point are visually hidden. This card tells the user
 * exactly how many, reinforcing that they are NOT deleted.
 *
 * Data source:
 *   - selectHiddenDownstreamCount selector — pure function, no tree traversal here.
 *
 * This component only appears when hiddenCount > 0.
 */

import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { selectHiddenDownstreamCount } from "../../selectors/conversationSelectors";

/**
 * Card showing count of hidden downstream messages during fork.
 * Reinforces: messages are hidden, not deleted.
 */
export function DownstreamHiddenCard() {
  const { t } = useTranslation();
  const hiddenCount = useAppStore(selectHiddenDownstreamCount);

  if (hiddenCount <= 0) return null;

  return (
    <div className="mx-3 mb-3 rounded-panel border border-miro-coral-light bg-miro-coral-light/35 px-4 py-3 shadow-ring">
      <p className="app-section-label mb-1">{t("workspace.downstreamLabel")}</p>
      <p className="text-sm leading-6 text-miro-text-secondary">
        {t("workspace.downstreamHidden", { count: hiddenCount })}
        <span className="font-semibold text-miro-text">{t("workspace.downstreamSafe")}</span>
      </p>
    </div>
  );
}
