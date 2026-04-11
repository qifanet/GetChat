/**
 * @file CompareWorkspace.tsx
 * @description Main container for the compare view.
 *
 * Compare mode is strictly read-only. It exposes shared context first and then
 * two branch columns, keeping the layout aligned with the desktop-first shell.
 */

import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { selectCompareData } from "../../selectors/compareSelectors";
import { CompareToolbar } from "./CompareToolbar";
import { SharedContextStrip } from "./SharedContextStrip";
import { CompareColumn } from "./CompareColumn";

/** Render the compare workspace or a degraded empty state when data is missing. */
export function CompareWorkspace() {
  const { t } = useTranslation();
  const data = useAppStore(selectCompareData);

  if (!data.leftBranch && !data.rightBranch) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-8">
        <div className="rounded-shell bg-white px-8 py-8 text-center shadow-panel">
          <p className="mb-3 text-sm text-miro-text-secondary">
            {t("compare.noComparePath")}
          </p>
          <button
            type="button"
            className="app-secondary-button px-3 py-2 text-xs text-miro-blue"
            onClick={() => useAppStore.getState().exitCompare()}
          >
            {t("compare.returnToChat")}
          </button>
        </div>
      </div>
    );
  }

  if (!data.leftBranch || !data.rightBranch) {
    const missingSide = data.leftBranch ? t("compare.rightPath") : t("compare.leftPath");

    return (
      <div className="flex h-full items-center justify-center px-6 py-8">
        <div className="rounded-shell bg-white px-8 py-8 text-center shadow-panel">
          <p className="mb-3 text-sm text-miro-text-secondary">
            {t("compare.missingBranch", { side: missingSide })}
          </p>
          <button
            type="button"
            className="app-secondary-button px-3 py-2 text-xs text-miro-blue"
            onClick={() => useAppStore.getState().exitCompare()}
          >
            {t("compare.returnToChat")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <CompareToolbar leftBranch={data.leftBranch} rightBranch={data.rightBranch} />

      <div className="px-4 py-4 sm:px-5">
        <SharedContextStrip messages={data.sharedContextMessages} />
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-hidden px-4 pb-4 sm:px-5 sm:pb-5 xl:flex-row">
        <CompareColumn
          branchName={data.leftBranch.name ?? ""}
          isMainline={data.leftBranch.isMainline}
          messages={data.leftDivergedMessages}
        />
        <CompareColumn
          branchName={data.rightBranch.name ?? ""}
          isMainline={data.rightBranch.isMainline}
          messages={data.rightDivergedMessages}
        />
      </div>
    </div>
  );
}
