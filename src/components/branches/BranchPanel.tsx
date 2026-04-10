/**
 * @file BranchPanel.tsx
 * @description Right-side branch manager grouped by branch proximity.
 *
 * The panel mirrors the stitch reference as a dense contextual rail: current
 * path first, nearby branches second, long-tail routes collapsed by default.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { selectNearbyBranches } from "../../selectors/branchSelectors";
import { BranchListItem } from "./BranchListItem";
import { BranchHealthCard } from "./BranchHealthCard";
import { IconChevronUp, IconChevronDown } from "../common/Icon";

/** Render the grouped branch manager shown in the right rail. */
export function BranchPanel() {
  const { t } = useTranslation();
  const groups = useAppStore(selectNearbyBranches);
  const currentBranchId = useAppStore((state) => state.workspace.currentBranchId);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-miro-border/10 px-5 py-5">
        <p className="app-section-label mb-1">{t("common.workspace")}</p>
        <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
          {t("branch.panelTitle")}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          {groups.currentBranch ? (
            <section className="space-y-2">
              <div className="app-section-label px-1">{t("branch.currentPath")}</div>
              <div className="rounded-panel bg-miro-blue-light/45 p-2">
                <BranchListItem branch={groups.currentBranch} isCurrent={true} />
              </div>
            </section>
          ) : null}

          {groups.siblings.length > 0 ? (
            <section className="space-y-2">
              <div className="app-section-label px-1">
                {t("branch.siblingBranches")} ({groups.siblings.length})
              </div>
              <div className="space-y-2 rounded-panel bg-white/70 p-2 shadow-ring">
                {groups.siblings.map((branch) => (
                  <BranchListItem
                    key={branch.id}
                    branch={branch}
                    isCurrent={branch.id === currentBranchId}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {groups.otherActive.length > 0 ? (
            <section className="space-y-2">
              <button
                type="button"
                className="flex w-full items-center justify-between px-1 text-left"
                onClick={() => setOtherExpanded((expanded) => !expanded)}
              >
                <span className="app-section-label">
                  {t("branch.otherActiveBranches")} ({groups.otherActive.length})
                </span>
                {otherExpanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
              </button>
              {otherExpanded ? (
                <div className="space-y-2 rounded-panel bg-white/70 p-2 shadow-ring">
                  {groups.otherActive.map((branch) => (
                    <BranchListItem
                      key={branch.id}
                      branch={branch}
                      isCurrent={branch.id === currentBranchId}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {groups.archived.length > 0 ? (
            <section className="space-y-2">
              <button
                type="button"
                className="flex w-full items-center justify-between px-1 text-left"
                onClick={() => setArchivedExpanded((expanded) => !expanded)}
              >
                <span className="app-section-label">
                  {t("branch.archivedBranches")} ({groups.archived.length})
                </span>
                {archivedExpanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
              </button>
              {archivedExpanded ? (
                <div className="space-y-2 rounded-panel bg-white/70 p-2 shadow-ring">
                  {groups.archived.map((branch) => (
                    <BranchListItem
                      key={branch.id}
                      branch={branch}
                      isCurrent={branch.id === currentBranchId}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <BranchHealthCard />
        </div>
      </div>
    </div>
  );
}
