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

/**
 * Group heavyweight third-party packages into stable chunks so the desktop
 * bundle stays under Vite's warning threshold without changing runtime logic.
 */
function resolveVendorChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) {
    return undefined;
  }

  const normalizedId = id.replace(/\\/g, "/");
  const matchesAny = (markers: string[]) =>
    markers.some((marker) => normalizedId.includes(marker));

  if (
    matchesAny([
      "/react-syntax-highlighter/",
      "/refractor/",
      "/highlight.js/",
    ])
  ) {
    return "vendor-markdown-highlight";
  }

  if (
    matchesAny([
      "/react/",
      "/react-dom/",
      "/scheduler/",
      "/zustand/",
      "/immer/",
    ])
  ) {
    return "vendor-app";
  }

  if (matchesAny(["/@tauri-apps/"])) {
    return "vendor-tauri";
  }

  if (
    matchesAny([
      "/i18next/",
      "/react-i18next/",
      "/i18next-browser-languagedetector/",
    ])
  ) {
    return "vendor-i18n";
  }

  return "vendor";
}

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
    rollupOptions: {
      output: {
        manualChunks: resolveVendorChunk,
      },
    },
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
