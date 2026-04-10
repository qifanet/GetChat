/**
 * @file Icon.tsx
 * @description Lightweight SVG icon components following the Miro design system.
 *
 * All icons are inline SVGs to avoid external dependencies.
 * Consistent sizing: 16px default (sm), stroke-based, 1.5px width.
 *
 * Design reference: docs/UIUX-miro/DESIGN.md
 *   - Primary interactive: #5b76fe (Blue 450)
 *   - Neutral text: #1c1c1e (Near Black)
 *   - Muted: #555a6a (Slate)
 *
 * Usage:
 *   import { IconStar, IconX } from "../common/Icon";
 *   <IconStar className="text-emerald-500" />
 */

import type { SVGProps } from "react";

/** Base props shared by all icons */
type IconBaseProps = SVGProps<SVGSVGElement> & {
  /** Size in pixels. Defaults to 16. */
  size?: number;
};

/** Common viewBox and default attributes for stroke-based icons */
const iconDefaults = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/**
 * Star icon — used for "set as mainline" action.
 * Filled variant for mainline indicator.
 */
export function IconStar({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={0.5}
      />
    </svg>
  );
}

/**
 * Outline star icon — used for "set as mainline" button (not yet mainline).
 */
export function IconStarOutline({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
        stroke="currentColor"
      />
    </svg>
  );
}

/**
 * Archive box icon — used for archive branch action.
 */
export function IconArchive({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

/**
 * Counter-clockwise restore icon — used for unarchive / restore actions.
 */
export function IconRotateCcw({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M3 2v6h6" />
      <path d="M3 8a9 9 0 101.9-2.7" />
    </svg>
  );
}

/**
 * Trash icon — used for destructive delete actions.
 */
export function IconTrash({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/**
 * Close / dismiss icon (X).
 */
export function IconX({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

/**
 * Edit / pencil square icon — used for edit fork banner.
 */
export function IconPencilSquare({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M16.474 5.408l2.118 2.118-9.474 9.474H7v-2.118l9.474-9.474z" />
      <path d="M16.474 5.408l2.118 2.118" />
      <path d="M3 21h18" />
    </svg>
  );
}

/**
 * Info circle icon — used for history fork banner.
 */
export function IconInfoCircle({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

/**
 * Chevron up icon — used for collapsible sections.
 */
export function IconChevronUp({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M18 15l-6-6-6 6" />
    </svg>
  );
}

/**
 * Chevron down icon — used for collapsible sections.
 */
export function IconChevronDown({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * Chevron left icon — used for sidebar collapse and navigation.
 */
export function IconChevronLeft({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/**
 * Chevron right icon — used for sidebar expand and navigation.
 */
export function IconChevronRight({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

/**
 * Compare / columns icon — used for compare action button.
 */
export function IconColumns({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="18" rx="1" />
    </svg>
  );
}

/**
 * Export / download icon — used for export action button.
 */
export function IconExport({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

/**
 * Settings / gear icon — used for provider settings entry points.
 */
export function IconSettings({ size = 16, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} {...iconDefaults} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1 1 0 00.2 1.1l.1.1a2 2 0 010 2.8 2 2 0 01-2.8 0l-.1-.1a1 1 0 00-1.1-.2 1 1 0 00-.6.9V20a2 2 0 01-4 0v-.2a1 1 0 00-.7-.9 1 1 0 00-1 .2l-.2.1a2 2 0 01-2.8 0 2 2 0 010-2.8l.1-.1a1 1 0 00.2-1.1 1 1 0 00-.9-.6H4a2 2 0 010-4h.2a1 1 0 00.9-.7 1 1 0 00-.2-1l-.1-.2a2 2 0 010-2.8 2 2 0 012.8 0l.1.1a1 1 0 001.1.2H9a1 1 0 00.6-.9V4a2 2 0 014 0v.2a1 1 0 00.7.9 1 1 0 001-.2l.2-.1a2 2 0 012.8 0 2 2 0 010 2.8l-.1.1a1 1 0 00-.2 1.1V9c0 .4.2.7.6.8h.2a2 2 0 010 4h-.2a1 1 0 00-.8.6z" />
    </svg>
  );
}
