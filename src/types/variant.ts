/**
 * @file variant.ts
 * @description Derived variant group types for candidate answer management.
 *
 * Design decision: Variants are NOT first-class persistent entities.
 * They are runtime-derived structures computed from the message tree.
 *
 * A variant group is simply "multiple assistant messages that share the same
 * parent user message". This can always be derived from:
 *   conversationIndexes.childMessageIdsByParentId[userMessageId]
 *   filtered by role === "ASSISTANT"
 *
 * This avoids creating a separate persistence model for variants and
 * prevents "regenerate → tree explosion" issues.
 */

import type { MessageId } from "./base";

// ============================================================================
// Derived Variant Group
// ============================================================================

/**
 * A group of candidate assistant answers for the same user message.
 * Computed at runtime from the message tree — never persisted directly.
 *
 * Example:
 *   User asks "Write a tagline"
 *   → Assistant generates Answer A (original)
 *   → User clicks "Regenerate"
 *   → Assistant generates Answer B (variant)
 *
 *   Both A and B are in the same DerivedVariantGroup,
 *   sharing the same userMessageId as parent.
 */
export interface DerivedVariantGroup {
  /** The user message that all variants are answers to */
  userMessageId: MessageId;

  /** All assistant message IDs that are children of this user message */
  assistantMessageIds: MessageId[];
}
