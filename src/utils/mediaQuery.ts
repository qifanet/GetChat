/**
 * Safe wrappers around browser media queries.
 *
 * jsdom and some non-browser runtimes do not provide window.matchMedia, so all
 * app code should go through these helpers instead of calling it directly.
 */

export const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export type ThemeModeLike = "system" | "light" | "dark";

export function getMediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }

  return window.matchMedia(query);
}

export function mediaQueryMatches(query: string, fallback = false): boolean {
  return getMediaQueryList(query)?.matches ?? fallback;
}

export function prefersDarkColorScheme(): boolean {
  return mediaQueryMatches(DARK_COLOR_SCHEME_QUERY);
}

export function isDarkThemeMode(mode: ThemeModeLike): boolean {
  return mode === "dark" || (mode === "system" && prefersDarkColorScheme());
}
