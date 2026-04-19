/**
 * @file MainlineBadge.tsx
 * @description Badge indicating whether the current branch is the mainline.
 *
 * Displays:
 *   - "mainline" with solid indicator when current branch IS mainline
 *   - "branch" with hollow indicator when current branch is NOT mainline
 */
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { selectIsCurrentBranchMainline } from "../../selectors/branchSelectors";
import { IconStar, IconStarOutline } from "../common/Icon";
/**
 * Badge showing mainline status of the current branch.
 * Helps users distinguish the "default" path from side branches.
 */
export function MainlineBadge() {
  const { t } = useTranslation();
  const isMainline = useAppStore(selectIsCurrentBranchMainline);
  if (isMainline) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-miro-green/20 bg-miro-green-light px-3 py-1 text-[11px] font-display font-semibold uppercase tracking-[0.14em] text-miro-green">
        <IconStar size={12} />
        {t("common.mainline")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-miro-border bg-white px-3 py-1 text-[11px] font-display font-semibold uppercase tracking-[0.14em] text-miro-text-secondary">
      <IconStarOutline size={12} />
      {t("common.branch")}
    </span>
  );
}
