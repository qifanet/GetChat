/**
 * @file MessageActionToolbar.tsx
 * @description Hover-triggered action toolbar for message bubbles.
 *
 * Shows icon buttons with tooltips on hover. Supports an overflow "more"
 * dropdown for secondary actions.
 *
 * Usage:
 *   <MessageActionToolbar align="right">
 *     <MessageActionButton icon={<IconCopy />} label="Copy" onClick={handleCopy} />
 *     <MessageActionMoreMenu items={[{ label: "Delete", onClick: handleDelete }]} />
 *   </MessageActionToolbar>
 */

import { useState, useRef, useEffect, useCallback, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

// ============================================================================
// Toolbar Container
// ============================================================================

interface MessageActionToolbarProps {
  /** Toolbar content (buttons + more menu) */
  children: ReactNode;
  /** Alignment: "right" for user messages, "left" for assistant messages */
  align?: "left" | "right";
}

/**
 * Container for message action buttons. Renders as a flex row with
 * gap-0.5, appearing on parent group-hover. Alignment controlled via prop.
 */
export function MessageActionToolbar({ children, align = "left" }: MessageActionToolbarProps) {
  return (
    <div
      className={`mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 ${
        align === "right" ? "justify-end" : "justify-start"
      }`}
    >
      {children}
    </div>
  );
}

// ============================================================================
// Tooltip Button
// ============================================================================

interface MessageActionButtonProps {
  /** Icon element to render */
  icon: ReactNode;
  /** Tooltip text shown on hover */
  label: string;
  /** Click handler */
  onClick: () => void;
  /** Whether to show a blue highlight style */
  highlight?: boolean;
  /** Disabled state */
  disabled?: boolean;
}

/**
 * Small icon button with a CSS tooltip. Used as primary actions on the toolbar.
 */
export function MessageActionButton({
  icon,
  label,
  onClick,
  highlight = false,
  disabled = false,
}: MessageActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`relative flex h-7 w-7 items-center justify-center rounded-md text-miro-text-secondary transition-colors
        ${disabled ? "cursor-not-allowed opacity-40" : "hover:bg-miro-border/15 hover:text-miro-text"}
        ${highlight ? "text-miro-blue hover:bg-miro-blue-light/50" : ""}`}
    >
      {icon}
    </button>
  );
}

// ============================================================================
// More Menu (Dropdown)
// ============================================================================

export interface MoreMenuItem {
  /** Display label */
  label: string;
  /** Click handler */
  onClick: () => void;
  /** Destructive style (red text) */
  danger?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Optional icon */
  icon?: ReactNode;
}

interface MessageActionMoreMenuProps {
  /** Menu items to show in the dropdown */
  items: MoreMenuItem[];
}

/**
 * "More" overflow button that opens a floating dropdown menu.
 * Uses a portal to document.body with fixed positioning to guarantee
 * the menu is never clipped by any ancestor's overflow/contain.
 * The menu appears directly above the trigger button.
 * Closes on outside click or Escape.
 */
export function MessageActionMoreMenu({ items }: MessageActionMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const handleClose = useCallback(() => setOpen(false), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;

    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className="relative flex h-7 w-7 items-center justify-center rounded-md text-miro-text-secondary transition-colors hover:bg-miro-border/15 hover:text-miro-text"
        title="More"
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="5" cy="12" r="1" fill="currentColor" />
          <circle cx="12" cy="12" r="1" fill="currentColor" />
          <circle cx="19" cy="12" r="1" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <MoreMenuPortal
          triggerRef={triggerRef}
          menuRef={menuRef}
          items={items}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}

// ============================================================================
// Portal Dropdown
// ============================================================================

interface MoreMenuPortalProps {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  items: MoreMenuItem[];
  onClose: () => void;
}

/**
 * Renders the dropdown menu via a React portal to document.body.
 * Positions itself above the trigger button using fixed coordinates,
 * keeping in sync with scroll and resize changes while open.
 */
function MoreMenuPortal({ triggerRef, menuRef, items, onClose }: MoreMenuPortalProps) {
  const [coords, setCoords] = useState<{ left: number; bottom: number }>({
    left: 0,
    bottom: 0,
  });

  useLayoutEffect(() => {
    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setCoords({
        left: rect.left,
        bottom: window.innerHeight - rect.top + 4,
      });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [triggerRef]);

  const menu = (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[140px] rounded-lg border border-miro-border/40 bg-white py-1 shadow-lg"
      style={{ left: coords.left, bottom: coords.bottom }}
      role="menu"
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors
            ${item.disabled ? "cursor-not-allowed opacity-40" : ""}
            ${item.danger ? "text-miro-red hover:bg-miro-red-light/40" : "text-miro-text hover:bg-miro-border/10"}`}
        >
          {item.icon ? <span className="flex-shrink-0">{item.icon}</span> : null}
          {item.label}
        </button>
      ))}
    </div>
  );

  return createPortal(menu, document.body);
}
