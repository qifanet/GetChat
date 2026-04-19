/**
 * @file BranchHealthCard.tsx
 * @description Non-blocking branch-governance warning card.
 *
 * The card stays advisory: it exposes compare as the next best action when the
 * branch tree starts to expand too quickly, but it never blocks editing.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import {
  selectBranchHealth,
  selectSuggestedCompareTargetBranchId,
} from "../../selectors/branchSelectors";
import { IconColumns, IconX } from "../common/Icon";

const _select_currentBranchId = (s: import("../../stores/appStore.types").AppStore) => s.workspace.currentBranchId;
const _select_enterCompare = (s: import("../../stores/appStore.types").AppStore) => s.enterCompare;

/** Render a non-blocking health card when the branch graph becomes dense. */
export function BranchHealthCard() {
  const { t } = useTranslation();
  const health = useAppStore(selectBranchHealth);
  const currentBranchId = useAppStore(_select_currentBranchId);
  const enterCompare = useAppStore(_select_enterCompare);
  const suggestedCompareTargetBranchId = useAppStore(
    selectSuggestedCompareTargetBranchId
  );
  const [dismissed, setDismissed] = useState(false);
  if (!health.needsWarning || dismissed) {
    return null;
  }
  const isStrong = health.level === "STRONG";
  return (
    <div
      className={`rounded-panel px-4 py-4 shadow-ring ${
        isStrong
          ? "bg-miro-coral-light/55 text-miro-red"
          : "bg-miro-orange-light/60 text-miro-amber"
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="app-section-label">
            {isStrong ? t("branch.healthStrong") : t("branch.healthWarning")}
          </p>
          <p className="text-sm font-semibold leading-6 text-miro-text">
            {t("branch.healthDescription", {
              activeCount: health.activeCount,
              siblingCount: health.siblingCount,
            })}
          </p>
        </div>
        <button
          type="button"
          className="app-icon-button h-8 w-8 shrink-0"
          onClick={() => setDismissed(true)}
        >
          <IconX size={12} />
        </button>
      </div>
      <p className="mb-3 text-xs leading-5 text-miro-text-secondary">
        {t("branch.healthActionHint")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="app-secondary-button gap-2 px-3 py-2 text-xs"
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
              ? t("branch.goToCompare")
              : t("branch.compareUnavailable")
          }
        >
          <IconColumns size={12} />
          {t("branch.goToCompare")}
        </button>
        <span className="app-status-pill border-white/80 bg-white/80 text-miro-text-secondary">
          {t("branch.archiveLowValue")}
        </span>
      </div>
    </div>
  );
}
