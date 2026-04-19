/**
 * @file updateChecker.ts
 * @description Application update checker service.
 *
 * Uses the Tauri updater plugin to check for new versions on GitHub
 * and present the user with an update prompt. Runs automatically on
 * startup and exposes a manual check function.
 *
 * In non-Tauri (browser dev) environments, all operations are no-ops.
 */

import { check as tauriCheck, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let lastCheckTime = 0;
let cachedUpdate: Update | null = null;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  date: string | undefined;
  body: string | undefined;
}

/**
 * Check for updates via the Tauri updater plugin.
 * Returns null if no update available, or UpdateInfo if a new version exists.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;

  try {
    const update = await tauriCheck();
    if (!update) {
      cachedUpdate = null;
      return null;
    }

    cachedUpdate = update;
    lastCheckTime = Date.now();

    return {
      currentVersion: update.currentVersion,
      latestVersion: update.version,
      date: update.date,
      body: update.body,
    };
  } catch (err) {
    console.warn("[updater] Check failed:", err);
    return null;
  }
}

/**
 * Download and install the cached update, then relaunch the app.
 * Must be called after checkForUpdate() returned an available update.
 */
export async function installUpdateAndRelaunch(): Promise<void> {
  if (!cachedUpdate) {
    console.warn("[updater] No cached update to install");
    return;
  }

  try {
    let downloaded = 0;
    let contentLength: number | undefined;

    await cachedUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength;
          console.info(`[updater] Download started: ${contentLength} bytes`);
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (contentLength) {
            const pct = Math.round((downloaded / contentLength) * 100);
            console.info(`[updater] Download progress: ${pct}%`);
          }
          break;
        case "Finished":
          console.info("[updater] Download finished, installing...");
          break;
      }
    });

    console.info("[updater] Update installed, relaunching...");
    await relaunch();
  } catch (err) {
    console.error("[updater] Install failed:", err);
    throw err;
  }
}

/**
 * Auto-check for updates if enough time has elapsed since the last check.
 * Returns the update info if an update is available, or null otherwise.
 */
export async function autoCheckForUpdate(): Promise<UpdateInfo | null> {
  const now = Date.now();
  if (now - lastCheckTime < UPDATE_CHECK_INTERVAL_MS && cachedUpdate) {
    return {
      currentVersion: cachedUpdate.currentVersion,
      latestVersion: cachedUpdate.version,
      date: cachedUpdate.date,
      body: cachedUpdate.body,
    };
  }
  return checkForUpdate();
}
