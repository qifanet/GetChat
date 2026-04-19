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
import { useAppStore } from "../../stores/useAppStoreSelector";
import { useTranslation } from "react-i18next";
import { HistoryForkBanner } from "./HistoryForkBanner";
import { EditForkBanner } from "./EditForkBanner";
import { DownstreamHiddenCard } from "./DownstreamHiddenCard";

function EditInlineBanner() {
  const { t } = useTranslation();
  const clearFork = useAppStore((s: import("../../stores/appStore.types").AppStore) => s.clearForkIntent);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
      <span className="font-medium">{t("workspace.editInlineTitle")}</span>
      <span className="text-blue-400">—</span>
      <span>{t("workspace.editInlineDesc")}</span>
      <button type="button" onClick={clearFork} className="ml-auto text-blue-500 hover:text-blue-700">{t("common.cancel")}</button>
    </div>
  );
}
const _sel_workspace_workspaceMode = (s: import("../../stores/appStore.types").AppStore) => s.workspace.workspaceMode;
/**
 * Region above the message list that shows workspace mode banners.
 * Only visible during fork operations (HISTORY_FORK / EDIT_FORK).
 */
export function WorkspaceBannerRegion() {
  const mode = useAppStore(_sel_workspace_workspaceMode);
  if (mode === "NORMAL" || mode === "COMPARE") {
    return null;
  }
  return (
    <div className="flex flex-col gap-1 pt-2">
      {mode === "HISTORY_FORK" && <HistoryForkBanner />}
      {mode === "EDIT_FORK" && <EditForkBanner />}
      {mode === "EDIT_INLINE" && <EditInlineBanner />}
      {(mode === "HISTORY_FORK" || mode === "EDIT_FORK") && <DownstreamHiddenCard />}
    </div>
  );
}
