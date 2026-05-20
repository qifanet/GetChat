/**
 * @file vite.config.ts
 * @description Vite build configuration for GetChat.
 *
 * - React plugin for JSX/TSX transformation
 * - Path aliases for clean imports (@/ → src/)
 * - Dev server configured for Tauri integration
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import pkg from "./package.json";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  clearScreen: false,
  build: {
    // Avoid fragile manual vendor chunking: several markdown/math packages have
    // circular internal imports that produce Rollup circular-chunk warnings.
    chunkSizeWarningLimit: 2500,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
