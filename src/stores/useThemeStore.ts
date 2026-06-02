import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "system" | "light" | "dark";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
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

if (typeof window !== "undefined") {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  // Use onchange assignment (overwrites previous handler) to prevent
  // duplicate listeners during HMR or module reload.
  mql.onchange = () => {
    const { mode } = useThemeStore.getState();
    if (mode === "system") applyTheme("system");
  };
}
