/**
 * @file WorkspaceBannerRegion.tsx
 * @description Container component that renders the correct fork banner
 * based on the current workspaceMode.
 *
 * Routing logic:
 *   - NORMAL  → nothing
 *   - HISTORY_FORK → HistoryForkBanner + DownstreamHiddenCard
 *   - EDIT_FORK    → EditForkBanner + DownstreamHiddenCard
 *   - COMPARE      → nothing (compare has its own UI)
 *
 * This is the single entry point for workspace awareness banners.
 * All other components just render <WorkspaceBannerRegion />.
 */

import { useAppStore } from "../../stores/useAppStore";
import { HistoryForkBanner } from "./HistoryForkBanner";
import { EditForkBanner } from "./EditForkBanner";
import { DownstreamHiddenCard } from "./DownstreamHiddenCard";

/**
 * Region above the message list that shows workspace mode banners.
 * Only visible during fork operations (HISTORY_FORK / EDIT_FORK).
 */
export function WorkspaceBannerRegion() {
  const mode = useAppStore((s) => s.workspace.workspaceMode);

  if (mode === "NORMAL" || mode === "COMPARE") {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 pt-2">
      {mode === "HISTORY_FORK" && <HistoryForkBanner />}
      {mode === "EDIT_FORK" && <EditForkBanner />}
      <DownstreamHiddenCard />
    </div>
  );
}
