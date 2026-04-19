/**
 * @file MessageList.tsx
 * @description Scrollable message list for the active branch path.
 *
 * The list is treated as the main reading surface in the desktop workspace:
 * generous vertical rhythm, stable content width, and a subtle path signpost
 * above the thread body.
 *
 * VariantSwitcher is inserted between user and assistant messages when the
 * user message has multiple assistant children (candidate answers).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { useStreamStore } from "../../stores/useStreamStore";
import {
  selectVisibleMessagesForWorkspace,
  selectVariantGroupByUserMessageId,
} from "../../selectors/conversationSelectors";
const selectActiveSnapshot = (s: import('../../stores/appStore.types').AppStore) => s.activeSnapshot;
import { UserMessageBubble } from "../messages/UserMessageBubble";
import { AssistantMessageBubble } from "../messages/AssistantMessageBubble";
import { VariantSwitcher } from "../messages/VariantSwitcher";
/** Scrollable message list for the current branch path. */
export function MessageList() {
  const { t } = useTranslation();
  const messages = useAppStore(selectVisibleMessagesForWorkspace);
  // Subscribe to the raw data that drives the variant computation,
  // then derive the Set via useMemo to keep the reference stable.
  const activeSnapshot = useAppStore(selectActiveSnapshot);
  const userMessageIdsWithVariants = useMemo(() => {
    if (!activeSnapshot) return new Set<string>();
    const result = new Set<string>();
    const state = useAppStore.getState();
    for (const msgId of Object.keys(activeSnapshot.entities.messages)) {
      const msg = activeSnapshot.entities.messages[msgId];
      if (msg?.role === "USER") {
        const group = selectVariantGroupByUserMessageId(state, msgId);
        if (group.assistantMessageIds.length > 1) {
          result.add(msgId);
        }
      }
    }
    return result;
  }, [activeSnapshot]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const isStreaming = useStreamStore((s) => Object.values(s.sessionsByRequestId).some((ss) => ss.status === "STREAMING"));
  const [autoFollow, setAutoFollow] = useState(true);
  const userScrolledRef = useRef(false);
  const reenableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleScroll = useCallback(() => {
    const el = scrollContainer;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (!atBottom && autoFollow) {
      setAutoFollow(false);
      userScrolledRef.current = true;
      if (reenableTimerRef.current) clearTimeout(reenableTimerRef.current);
    }
  }, [autoFollow, scrollContainer]);

  useEffect(() => {
    const el = scrollContainer;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll, scrollContainer]);

  useEffect(() => {
    if (userScrolledRef.current && !autoFollow && isStreaming) {
      if (reenableTimerRef.current) clearTimeout(reenableTimerRef.current);
      reenableTimerRef.current = setTimeout(() => {
        userScrolledRef.current = false;
        setAutoFollow(true);
      }, 3000);
    }
    return () => { if (reenableTimerRef.current) clearTimeout(reenableTimerRef.current); };
  }, [autoFollow, isStreaming, messages.length]);

  useEffect(() => {
    if (autoFollow && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
    }
  }, [autoFollow, messages.length, isStreaming]);

  useEffect(() => {
    if (isStreaming) { setAutoFollow(true); userScrolledRef.current = false; }
  }, [isStreaming]);

  useEffect(() => {
    if (bottomRef.current && !scrollContainerRef.current) {
      let el: HTMLElement | null = bottomRef.current.parentElement;
      while (el) {
        const style = getComputedStyle(el);
        if (style.overflowY === "auto" || style.overflowY === "scroll") {
          const container = el as HTMLDivElement;
          scrollContainerRef.current = container;
          setScrollContainer(container);
          break;
        }
        el = el.parentElement;
      }
    }
  }, []);
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10">
        <p className="max-w-md text-center text-sm leading-6 text-miro-text-secondary">
          {t("conversation.welcomeSubtitle")}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-5xl flex-col px-5 py-6 sm:px-6">
      <div className="mb-6 flex items-center gap-3">
        <span className="app-section-label">{t("branch.currentPath")}</span>
        <span className="h-px flex-1 bg-miro-border/15" />
      </div>
      <div className="space-y-7">
        {messages.map((message, index) => {
          if (message.role === "USER") {
            const nextMessage = messages[index + 1];
            const hasVariants = userMessageIdsWithVariants.has(message.id);
            const showVariantSwitcher = nextMessage?.role === "ASSISTANT" && hasVariants;
            return (
              <div key={message.id} className="space-y-3">
                <UserMessageBubble message={message} />
                {showVariantSwitcher ? (
                  <VariantSwitcher userMessageId={message.id} />
                ) : null}
              </div>
            );
          }
          if (message.role === "ASSISTANT") {
            return <AssistantMessageBubble key={message.id} message={message} />;
          }
          return null;
        })}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
