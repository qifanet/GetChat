/**
 * @file displayNames.ts
 * @description Display-only localization helpers for system-generated
 * conversation titles and branch names.
 *
 * These helpers keep persisted data stable while ensuring UI surfaces render
 * product language that matches the active locale.
 */

import type { TFunction } from "i18next";

const SYSTEM_CONVERSATION_TITLES = new Set(["New Conversation"]);
const SYSTEM_BRANCH_NAMES = new Set(["Main"]);

/**
 * Return a localized conversation title for system-generated defaults.
 */
export function getConversationDisplayTitle(
  title: string | null | undefined,
  t: TFunction
): string {
  const trimmedTitle = title?.trim() ?? "";
  if (trimmedTitle.length === 0) {
    return t("conversation.unnamedConversation");
  }

  if (SYSTEM_CONVERSATION_TITLES.has(trimmedTitle)) {
    return t("conversation.newConversation");
  }

  return trimmedTitle;
}

/**
 * Return a localized branch name for system-generated defaults.
 */
export function getBranchDisplayName(
  name: string | null | undefined,
  t: TFunction
): string {
  const trimmedName = name?.trim() ?? "";
  if (trimmedName.length === 0) {
    return t("branch.unnamedBranch");
  }

  if (SYSTEM_BRANCH_NAMES.has(trimmedName)) {
    return t("common.mainline");
  }

  return trimmedName;
}
