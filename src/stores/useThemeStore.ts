import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DARK_COLOR_SCHEME_QUERY,
  getMediaQueryList,
  prefersDarkColorScheme,
} from "../utils/mediaQuery";

export type ThemeMode = "system" | "light" | "dark";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  if (mode === "system") {
    root.classList.toggle("dark", prefersDarkColorScheme());
  } else {
    root.classList.toggle("dark", mode === "dark");
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: "system" as ThemeMode,
      setMode: (mode: ThemeMode) => {
        applyTheme(mode);
        set({ mode });
      },
    }),
    {
      name: "getchat-theme",
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.mode);
      },
    },
  ),
);

const mql = getMediaQueryList(DARK_COLOR_SCHEME_QUERY);

if (mql) {
  // Use onchange assignment (overwrites previous handler) to prevent
  // duplicate listeners during HMR or module reload.
  mql.onchange = () => {
    const { mode } = useThemeStore.getState();
    if (mode === "system") {
      applyTheme("system");
      // Notify theme consumers that derive dark state from system preferences.
      useThemeStore.setState({ mode: "system" });
    }
  };
}
