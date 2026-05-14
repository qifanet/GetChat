/**
 * @file MessageActionToolbar.tsx
 * @description Hover-triggered action toolbar for message bubbles.
 *
 * Shows icon buttons with tooltips on hover. Supports an overflow "more"
 * dropdown for secondary actions.
 *
 * Usage:
 *   <MessageActionToolbar align="right">
 *     <MessageActionTooltipButton icon={<IconCopy />} label="Copy" onClick={handleCopy} />
 *     <MessageActionMoreMenu items={[{ label: "Delete", onClick: handleDelete }]} />
 *   </MessageActionToolbar>
 */

import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";

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
 * Closes on outside click or Escape.
 */
export function MessageActionMoreMenu({ items }: MessageActionMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);
  const handleClose = useCallback(() => setOpen(false), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;

    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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
    <div ref={containerRef} className="relative">
      <MessageActionButton
        icon={
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="12" r="1" fill="currentColor" />
            <circle cx="12" cy="12" r="1" fill="currentColor" />
            <circle cx="19" cy="12" r="1" fill="currentColor" />
          </svg>
        }
        label="More"
        onClick={handleToggle}
      />
      {open ? (
        <div
          className="absolute bottom-full left-0 z-50 mb-1 min-w-[140px] rounded-lg border border-miro-border/40 bg-white py-1 shadow-lg"
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
                handleClose();
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
      ) : null}
    </div>
  );
}
