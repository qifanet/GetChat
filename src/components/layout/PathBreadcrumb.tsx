/**
 * @file PathBreadcrumb.tsx
 * @description Breadcrumb showing the current path context.
 *
 * Displays the current branch name and, if applicable,
 * where it forked from. This is the primary UI element
 * for solving "user doesn't know where they are" problem.
 */

import { useTranslation } from "react-i18next";
import { getBranchDisplayName } from "../../i18n/displayNames";
import { useAppStore } from "../../stores/useAppStore";
import { selectCurrentBranch } from "../../selectors/conversationSelectors";

/**
 * Breadcrumb showing current path name and fork origin.
 */
export function PathBreadcrumb() {
  const { t } = useTranslation();
  const branch = useAppStore(selectCurrentBranch);

  if (!branch) {
    return (
      <span className="text-sm text-miro-text-secondary">{t("path.noPathSelected")}</span>
    );
  }

  const branchName = getBranchDisplayName(branch.name, t);

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <span className="font-medium text-miro-text">{branchName}</span>
      {branch.forkSourceMessageId && (
        <span className="text-miro-text-secondary">
          {t("path.forkFromMessage")}
        </span>
      )}
    </div>
  );
}
