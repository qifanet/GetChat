/**
 * @file useCompactAppShell.ts
 * @description Responsive hook for switching the desktop shell between
 * inline sidebars and overlay side panels.
 */

import { useEffect, useState } from "react";

const DEFAULT_BREAKPOINT_PX = 1480;

/**
 * Return whether the app shell should use the compact layout.
 *
 * Compact layout is used for laptop-width windows where keeping both sidebars
 * inline would squeeze the center workspace too aggressively.
 */
export function useCompactAppShell(
  breakpointPx: number = DEFAULT_BREAKPOINT_PX
): boolean {
  const getMatches = (): boolean => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.innerWidth < breakpointPx;
  };

  const [isCompact, setIsCompact] = useState<boolean>(getMatches);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const syncMatches = (): void => setIsCompact(mediaQuery.matches);

    syncMatches();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncMatches);
      return () => mediaQuery.removeEventListener("change", syncMatches);
    }

    mediaQuery.addListener(syncMatches);
    return () => mediaQuery.removeListener(syncMatches);
  }, [breakpointPx]);

  return isCompact;
}
