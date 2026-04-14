/**
 * @file VariantSwitcher.tsx
 * @description Candidate answer pager for messages with multiple assistant variants.
 *
 * When a user message has multiple assistant children (from "regenerate" or
 * multi-model responses), this component renders a compact pager that lets
 * the user switch between candidate answers.
 *
 * The switcher is rendered between the user message bubble and the assistant
 * message bubble in the MessageList. It reads the variant group from the
 * snapshot indexes and updates the variantPreview on the workspace state.
 */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import {
  selectVariantGroupByUserMessageId,
  selectCurrentPathMessages,
} from "../../selectors/conversationSelectors";
import { IconChevronLeft, IconChevronRight } from "../common/Icon";
import type { MessageId } from "../../types/base";

interface VariantSwitcherProps {
  userMessageId: MessageId;
}

/** Compact candidate answer pager displayed above an assistant message with siblings. */
export function VariantSwitcher({ userMessageId }: VariantSwitcherProps) {
  const { t } = useTranslation();
  const activeSnapshot = useAppStore((state) => state.activeSnapshot);
  const variantGroup = useMemo(() => {
    const state = useAppStore.getState();
    return selectVariantGroupByUserMessageId(state, userMessageId);
  }, [activeSnapshot, userMessageId]);
  const setVariantPreview = useAppStore((state) => state.setVariantPreview);
  const currentBranchId = useAppStore((state) => state.workspace.currentBranchId);
  const variantPreview = useAppStore((state) => state.workspace.variantPreview);
  const pathMessages = useAppStore(selectCurrentPathMessages);

  const total = variantGroup.assistantMessageIds.length;

  const currentIndex = useMemo(() => {
    if (!activeSnapshot || !currentBranchId) return 0;

    if (variantPreview?.userMessageId === userMessageId) {
      const idx = variantGroup.assistantMessageIds.indexOf(
        variantPreview.assistantMessageId
      );
      if (idx >= 0) return idx;
    }

    const branch = activeSnapshot.entities.branches[currentBranchId];
    if (!branch) return 0;

    const messagesAfterUser = pathMessages.filter(
      (m) =>
        m.parentId === userMessageId &&
        m.role === "ASSISTANT" &&
        m.status !== "STREAMING"
    );
    if (messagesAfterUser.length > 0) {
      const pathAssistantId = messagesAfterUser[0].id;
      const idx = variantGroup.assistantMessageIds.indexOf(pathAssistantId);
      if (idx >= 0) return idx;
    }

    return 0;
  }, [
    activeSnapshot,
    currentBranchId,
    pathMessages,
    userMessageId,
    variantGroup.assistantMessageIds,
    variantPreview,
  ]);

  const handleSwitch = useCallback(
    (direction: 1 | -1) => {
      if (!activeSnapshot || total <= 1) return;

      const nextIndex = (currentIndex + direction + total) % total;
      const nextAssistantId = variantGroup.assistantMessageIds[nextIndex];
      const nextAssistant =
        activeSnapshot.entities.messages[nextAssistantId] ?? null;

      if (!nextAssistant) return;

      const branch = currentBranchId
        ? activeSnapshot.entities.branches[currentBranchId]
        : null;

      const isCurrentLeaf = branch?.headMessageId === nextAssistantId;
      const hasDownstream = nextAssistant.childIds.length > 0;
      const hasDownstreamConflict = !isCurrentLeaf || hasDownstream;

      setVariantPreview({
        userMessageId,
        assistantMessageId: nextAssistantId,
        hasDownstreamConflict,
      });
    },
    [
      activeSnapshot,
      currentIndex,
      currentBranchId,
      total,
      userMessageId,
      variantGroup.assistantMessageIds,
      setVariantPreview,
    ]
  );

  if (total <= 1) {
    return null;
  }

  return (
    <div className="app-message-card flex justify-start">
      <div className="flex items-center gap-2 rounded-full border border-miro-border/40 bg-white/88 px-3 py-1.5 shadow-ring">
        <button
          type="button"
          onClick={() => handleSwitch(-1)}
          className="flex h-6 w-6 items-center justify-center rounded-full text-miro-text-secondary transition-colors hover:bg-miro-surface-high hover:text-miro-text"
          title={t("common.collapse")}
          aria-label="Previous variant"
        >
          <IconChevronLeft size={12} />
        </button>

        <span className="min-w-[80px] text-center text-[11px] font-medium text-miro-text-secondary">
          {t("message.variantCount", {
            current: currentIndex + 1,
            total,
          })}
        </span>

        <button
          type="button"
          onClick={() => handleSwitch(1)}
          className="flex h-6 w-6 items-center justify-center rounded-full text-miro-text-secondary transition-colors hover:bg-miro-surface-high hover:text-miro-text"
          title={t("common.expand")}
          aria-label="Next variant"
        >
          <IconChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}
