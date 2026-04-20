/**
 * @file UpdateNotification.tsx
 * @description Update notification banner and progress overlay.
 *
 * Checks for updates on mount and displays a non-intrusive banner
 * when a new version is available. During download, a modal overlay
 * shows progress.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  autoCheckForUpdate,
  installUpdateAndRelaunch,
  type UpdateInfo,
} from "../../services/updateChecker";

export function UpdateNotification() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    autoCheckForUpdate().then((info) => {
      if (info) setUpdate(info);
    });
  }, []);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setError(null);
    try {
      await installUpdateAndRelaunch();
    } catch {
      setError(t("updater.installFailed"));
      setInstalling(false);
    }
  }, [t]);

  // Don't render anything when no update, dismissed, or in browser dev mode
  if (!update || dismissed) {
    return null;
  }

  // Full-screen overlay during install
  if (installing) {
    return (
      <div role="dialog" aria-modal="true" aria-label={t("updater.installing")} className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="mx-4 max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-miro-border border-t-miro-blue" />
          <p className="text-sm font-medium text-miro-text">
            {t("updater.installing")}
          </p>
          <p className="mt-1 text-xs text-miro-text-secondary">
            {t("updater.installingHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-xl border border-miro-blue/20 bg-miro-blue/5 px-3 py-2">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-miro-blue"
      >
        <path d="M21 12a9 9 0 11-6.219-8.56" />
        <path d="M21 3v6h-6" />
      </svg>
      <span className="text-xs text-miro-text">
        {t("updater.available", {
          version: update.latestVersion,
          current: update.currentVersion,
        })}
      </span>
      <button
        type="button"
        onClick={handleInstall}
        className="rounded-lg bg-miro-blue px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-miro-blue/90"
      >
        {t("updater.updateNow")}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rounded-lg px-2 py-1 text-[11px] text-miro-text-secondary transition-colors hover:bg-miro-surface-high"
      >
        {t("updater.later")}
      </button>
      {error && (
        <span className="ml-1 text-[11px] text-miro-red">{error}</span>
      )}
    </div>
  );
}
