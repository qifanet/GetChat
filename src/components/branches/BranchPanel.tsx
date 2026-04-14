/**
 * @file BranchPanel.tsx
 * @description Right-side branch manager grouped by branch proximity.
 *
 * Supports a compare selection mode: users check two branches and click
 * "Compare" to enter side-by-side comparison.
 */

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { selectNearbyBranches } from "../../selectors/branchSelectors";
import { BranchListItem } from "./BranchListItem";
import { BranchHealthCard } from "./BranchHealthCard";
import { IconChevronDown, IconChevronUp, IconColumns } from "../common/Icon";
import type { BranchId } from "../../types/base";

/** Render the grouped branch manager shown in the right rail. */
export function BranchPanel() {
  const { t } = useTranslation();
  const groups = useAppStore(selectNearbyBranches);
  const currentBranchId = useAppStore((state) => state.workspace.currentBranchId);
  const enterCompare = useAppStore((state) => state.enterCompare);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState<BranchId[]>([]);

  const handleToggleSelect = useCallback((branchId: BranchId) => {
    setSelectedForCompare((prev) => {
      if (prev.includes(branchId)) {
        return prev.filter((id) => id !== branchId);
      }
      if (prev.length >= 2) {
        return [prev[1], branchId];
      }
      return [...prev, branchId];
    });
  }, []);

  const handleEnterCompare = useCallback(() => {
    if (selectedForCompare.length === 2) {
      enterCompare({
        leftBranchId: selectedForCompare[0],
        rightBranchId: selectedForCompare[1],
      });
      setSelectedForCompare([]);
    }
  }, [enterCompare, selectedForCompare]);

  const handleClearSelection = useCallback(() => {
    setSelectedForCompare([]);
  }, []);

  const allActiveBranches = [
    groups.currentBranch,
    ...groups.siblings,
    ...groups.otherActive,
  ].filter((b): b is NonNullable<typeof b> => Boolean(b));

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
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedForCompare.includes(groups.currentBranch.id)}
                    onChange={() => handleToggleSelect(groups.currentBranch.id)}
                    className="h-3.5 w-3.5 shrink-0 rounded border-miro-border/40 accent-miro-blue"
                    aria-label={`Select ${groups.currentBranch.name} for compare`}
                  />
                  <div className="min-w-0 flex-1">
                    <BranchListItem branch={groups.currentBranch} isCurrent={true} />
                  </div>
                </div>
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
                  <div key={branch.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedForCompare.includes(branch.id)}
                      onChange={() => handleToggleSelect(branch.id)}
                      className="h-3.5 w-3.5 shrink-0 rounded border-miro-border/40 accent-miro-blue"
                      aria-label={`Select ${branch.name} for compare`}
                    />
                    <div className="min-w-0 flex-1">
                      <BranchListItem branch={branch} isCurrent={branch.id === currentBranchId} />
                    </div>
                  </div>
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
                    <div key={branch.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedForCompare.includes(branch.id)}
                        onChange={() => handleToggleSelect(branch.id)}
                        className="h-3.5 w-3.5 shrink-0 rounded border-miro-border/40 accent-miro-blue"
                        aria-label={`Select ${branch.name} for compare`}
                      />
                      <div className="min-w-0 flex-1">
                        <BranchListItem branch={branch} isCurrent={branch.id === currentBranchId} />
                      </div>
                    </div>
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

      {selectedForCompare.length > 0 ? (
        <div className="shrink-0 border-t border-miro-border/10 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-miro-text-secondary">
              {selectedForCompare.length === 2
                ? t("common.compare") + ": 2"
                : `${selectedForCompare.length}/2`}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleClearSelection}
                className="app-secondary-button px-3 py-1.5 text-xs"
              >
                {t("common.cancel")}
              </button>
              {selectedForCompare.length === 2 ? (
                <button
                  type="button"
                  onClick={handleEnterCompare}
                  className="app-primary-button gap-1.5 px-3 py-1.5 text-xs"
                >
                  <IconColumns size={12} />
                  {t("common.compare")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
