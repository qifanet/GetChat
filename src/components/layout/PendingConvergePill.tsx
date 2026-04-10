/**
 * @file PendingConvergePill.tsx
 * @description Pill showing the number of active branches pending convergence.
 *
 * This component is the primary UI element for preventing
 * "only diverge, never converge" syndrome. It:
 *   - Is always visible when there are multiple active branches
 *   - Shows the count of non-mainline active branches
 *   - Provides a direct link to comparison
 *
 * The pill is non-blocking — it suggests, not demands.
 */

import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import {
  selectPendingConvergeCount,
  selectSuggestedCompareTargetBranchId,
} from "../../selectors/branchSelectors";
import { IconColumns } from "../common/Icon";

/**
 * Pill showing how many branches need to be converged.
 * Clicking it opens compare mode with the current branch and the suggested peer.
 */
export function PendingConvergePill() {
  const { t } = useTranslation();
  const count = useAppStore(selectPendingConvergeCount);
  const currentBranchId = useAppStore((s) => s.workspace.currentBranchId);
  const enterCompare = useAppStore((s) => s.enterCompare);
  const suggestedCompareTargetBranchId = useAppStore(
    selectSuggestedCompareTargetBranchId
  );

  if (count <= 0) return null;

  return (
    <button
      className="inline-flex items-center gap-2 rounded-full border border-miro-amber/20 bg-miro-amber-light px-3 py-1 text-[11px] font-display font-semibold uppercase tracking-[0.14em] text-miro-amber transition-colors hover:bg-miro-orange-light disabled:cursor-not-allowed disabled:border-miro-border disabled:bg-white disabled:text-miro-text-secondary"
      onClick={() => {
        if (!currentBranchId || !suggestedCompareTargetBranchId) {
          return;
        }

        enterCompare({
          leftBranchId: currentBranchId,
          rightBranchId: suggestedCompareTargetBranchId,
        });
      }}
      disabled={!currentBranchId || !suggestedCompareTargetBranchId}
      title={
        suggestedCompareTargetBranchId
          ? t("common.compare")
          : t("branch.compareUnavailable")
      }
    >
      <IconColumns size={12} />
      {t("workspace.pendingConverge", { count })}
    </button>
  );
}
