/**
 * @file vitest.config.ts
 * @description Vitest configuration for BranchFlow test suite.
 *
 * Aliases:
 *   - @tauri-apps/api/core → stub module (not installed in npm; provided at
 *     runtime by Tauri. In tests we mock invoke via vi.mock()).
 */
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,test}.{ts,tsx}"],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@tauri-apps/api/core": resolve(__dirname, "src/test/stubs/tauriApiCore.ts"),
    },
  },
});
