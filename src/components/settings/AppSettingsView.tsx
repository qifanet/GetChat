/**
 * @file AppSettingsView.tsx
 * @description Application-level settings view.
 *
 * Contains default model, helper model, system prompt, language,
 * close behavior, shell path, and keyboard shortcuts.
 */
import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ToolSettingsSection,
  SecurityPolicySection,
  BuiltinToolsSection,
  McpServersSection,
  SkillsSection,
} from "./GlobalSettingsSections";
import { SUPPORTED_LOCALES, type SupportedLocale } from "../../i18n";
import {
  getModelDisplayName,
  listAvailableModelOptions,
} from "../../features/models/modelUtils";
import { useAppStore } from "../../stores/useAppStoreSelector";
import * as tauriCmd from "../../services/tauriCommands";
const _sel_providers = (s: import("../../stores/appStore.types").AppStore) => s.providers;
const _sel_providerModels = (s: import("../../stores/appStore.types").AppStore) => s.providerModels;
const _sel_providerOrder = (s: import("../../stores/appStore.types").AppStore) => s.providerOrder;
const _sel_defaultModelId = (s: import("../../stores/appStore.types").AppStore) => s.defaultModelId;
const _sel_helperModelId = (s: import("../../stores/appStore.types").AppStore) => s.helperModelId;
const _sel_systemPrompt = (s: import("../../stores/appStore.types").AppStore) => s.systemPrompt;
const _sel_setDefaultModel = (s: import("../../stores/appStore.types").AppStore) => s.setDefaultModel;
const _sel_setHelperModel = (s: import("../../stores/appStore.types").AppStore) => s.setHelperModel;
const _sel_setSystemPrompt = (s: import("../../stores/appStore.types").AppStore) => s.setSystemPrompt;

const SHORTCUT_ITEMS = [
  { key: "newChat", labelKey: "settings.shortcutNewChat", display: "⌘ N" },
  { key: "send", labelKey: "settings.shortcutSend", display: "⌘ Enter" },
  { key: "stop", labelKey: "settings.shortcutStop", display: "Esc" },
  { key: "settings", labelKey: "settings.shortcutSettings", display: "⌘ ," },
  { key: "sidebar", labelKey: "settings.shortcutSidebar", display: "⌘ B" },
  { key: "panel", labelKey: "settings.shortcutPanel", display: "⌘ ." },
  { key: "search", labelKey: "settings.shortcutSearch", display: "⌘ K" },
] as const;

/** Detect the platform to choose the shortcut modifier display. */
function getNavigatorPlatform(): string {
  if (typeof navigator === "undefined") return "";
  if ("userAgentData" in navigator) {
    return (navigator as any).userAgentData?.platform ?? navigator.platform ?? "";
  }
  return navigator.platform ?? "";
}

/** Return the platform's shortcut modifier label (⌘ on Mac, Ctrl elsewhere). */
function getShortcutModifierLabel(): string {
  const platform = getNavigatorPlatform();
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘" : "Ctrl";
}

const TOAST_AUTO_DISMISS_MS = 2000;

/** Toast context for settings feedback. */
export const SettingsToastContext = createContext<(message: string, tone?: "success" | "error") => void>(() => {});

/** Hook to access the settings toast. */
export function useSettingsToast() {
  return useContext(SettingsToastContext);
}

/** Render the application-level settings content. */
export function AppSettingsView() {
  const { t, i18n } = useTranslation();
  const shortcutModifierLabel = useState(() => getShortcutModifierLabel())[0];
  const shortcutItems = useState(
    () =>
      SHORTCUT_ITEMS.map((item) => ({
        ...item,
        display: item.display.replace("⌘", shortcutModifierLabel),
      }))
  )[0];

  const providersById = useAppStore(_sel_providers);
  const providerModelsById = useAppStore(_sel_providerModels);
  const providerOrder = useAppStore(_sel_providerOrder);
  const appDefaultModelId = useAppStore(_sel_defaultModelId);
  const appHelperModelId = useAppStore(_sel_helperModelId);
  const appSystemPrompt = useAppStore(_sel_systemPrompt);
  const setDefaultModel = useAppStore(_sel_setDefaultModel);
  const setHelperModel = useAppStore(_sel_setHelperModel);
  const setSystemPrompt = useAppStore(_sel_setSystemPrompt);

  const availableModelOptions = useState(
    () => listAvailableModelOptions(providersById, providerOrder, providerModelsById)
  )[0];

  const [defaultModelDraft, setDefaultModelDraft] = useState(appDefaultModelId ?? "");
  const [helperModelDraft, setHelperModelDraft] = useState(appHelperModelId ?? "");
  const [systemPromptDraft, setSystemPromptDraft] = useState(appSystemPrompt);
  const systemPromptCharCount = Array.from(systemPromptDraft).length;

  // Dropdown state
  const [defaultModelDropdownOpen, setDefaultModelDropdownOpen] = useState(false);
  const [helperModelDropdownOpen, setHelperModelDropdownOpen] = useState(false);
  const defaultModelDropdownRef = useRef<HTMLDivElement>(null);
  const helperModelDropdownRef = useRef<HTMLDivElement>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "info"; message: string } | null>(null);
  const showToast = useSettingsToast();

  const feedbackClassName =
    feedback?.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : feedback?.tone === "error"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-miro-border bg-miro-bg text-miro-text-secondary";

  useEffect(() => {
    setDefaultModelDraft(appDefaultModelId ?? "");
  }, [appDefaultModelId]);

  useEffect(() => {
    setHelperModelDraft(appHelperModelId ?? "");
  }, [appHelperModelId]);

  useEffect(() => {
    setSystemPromptDraft(appSystemPrompt);
  }, [appSystemPrompt]);

  // External click handler to close dropdowns
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (defaultModelDropdownOpen && defaultModelDropdownRef.current && !defaultModelDropdownRef.current.contains(event.target as Node)) {
        setDefaultModelDropdownOpen(false);
      }
      if (helperModelDropdownOpen && helperModelDropdownRef.current && !helperModelDropdownRef.current.contains(event.target as Node)) {
        setHelperModelDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [defaultModelDropdownOpen, helperModelDropdownOpen]);

  /** Persist the application-wide default model choice. */
  async function handleSaveDefaultModel(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      await setDefaultModel(defaultModelDraft.trim() || null);
      setFeedback({ tone: "success", message: t("settings.defaultModelSaved") });
    } catch (modelError) {
      setError(
        modelError instanceof Error ? modelError.message : t("settings.defaultModelSaveFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Persist the helper model used for background AI tasks. */
  async function handleSaveHelperModel(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      await setHelperModel(helperModelDraft.trim() || null);
      setFeedback({ tone: "success", message: t("settings.helperModelSaved") });
    } catch (modelError) {
      setError(
        modelError instanceof Error ? modelError.message : t("settings.helperModelSaveFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Persist the application-level prompt prefix used for future model requests. */
  async function handleSaveSystemPrompt(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      const savedPrompt = await setSystemPrompt(systemPromptDraft);
      setSystemPromptDraft(savedPrompt);
      setFeedback({ tone: "success", message: t("settings.systemPromptSaved") });
    } catch (promptError) {
      setError(
        promptError instanceof Error ? promptError.message : t("settings.systemPromptSaveFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Reset the system prompt by saving an empty value. */
  async function handleResetSystemPrompt(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      const savedPrompt = await setSystemPrompt("");
      setSystemPromptDraft(savedPrompt);
      setFeedback({ tone: "success", message: t("settings.systemPromptResetDone") });
    } catch (promptError) {
      setError(
        promptError instanceof Error ? promptError.message : t("settings.systemPromptSaveFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-w-0 flex-1 overflow-auto">
      <div className="grid min-w-0 w-full gap-4 min-[1800px]:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
        <div className="min-w-0 space-y-4">
          {/* Default Model */}
          <section id="section-default-model" className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
            <div className="flex min-w-0 flex-col gap-4 min-[1800px]:flex-row min-[1800px]:items-end min-[1800px]:justify-between">
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                  {t("settings.defaultModelTitle")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                  {t("settings.defaultModelHelp")}
                </p>
              </div>
              <div className="flex min-w-0 w-full max-w-xl flex-col gap-3 sm:flex-row">
                <div ref={defaultModelDropdownRef} className="relative min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setDefaultModelDropdownOpen((prev) => !prev)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-miro-border/40 bg-white/88 px-3 py-2 text-left text-sm text-miro-text shadow-ring transition-colors hover:bg-white/95 focus:outline-none focus:ring-0"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {defaultModelDraft
                        ? getModelDisplayName(defaultModelDraft, providerModelsById, t("shell.modelUnset"))
                        : t("shell.modelUnset")}
                    </span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-miro-text-secondary">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {defaultModelDropdownOpen && (
                    <div
                      role="listbox"
                      className="absolute left-0 top-full mt-1.5 z-50 max-h-64 w-full overflow-y-auto rounded-xl border border-miro-border/40 bg-white/95 p-1.5 shadow-ring"
                    >
                      <button
                        role="option"
                        type="button"
                        aria-selected={!defaultModelDraft}
                        onClick={() => { setDefaultModelDraft(""); setDefaultModelDropdownOpen(false); }}
                        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          !defaultModelDraft
                            ? "bg-miro-blue-light/65 text-miro-blue"
                            : "text-miro-text hover:bg-miro-surface-high"
                        }`}
                      >
                        <span className="truncate">{t("shell.modelUnset")}</span>
                        {!defaultModelDraft && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                      </button>
                      {availableModelOptions.map((option) => (
                        <button
                          key={option.id}
                          role="option"
                          type="button"
                          aria-selected={defaultModelDraft === option.id}
                          onClick={() => { setDefaultModelDraft(option.id); setDefaultModelDropdownOpen(false); }}
                          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                            defaultModelDraft === option.id
                              ? "bg-miro-blue-light/65 text-miro-blue"
                              : "text-miro-text hover:bg-miro-surface-high"
                          }`}
                        >
                          <span className="truncate">
                            {option.providerName} / {option.displayName}
                          </span>
                          {defaultModelDraft === option.id && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleSaveDefaultModel()}
                  disabled={isSubmitting}
                  className="app-primary-button"
                >
                  {t("settings.saveDefaultModel")}
                </button>
              </div>
            </div>
          </section>

          {/* Helper Model */}
          <section id="section-helper-model" className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
            <div className="flex min-w-0 flex-col gap-4 min-[1800px]:flex-row min-[1800px]:items-end min-[1800px]:justify-between">
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                  {t("settings.helperModelTitle")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                  {t("settings.helperModelHelp")}
                </p>
              </div>
              <div className="flex min-w-0 w-full max-w-xl flex-col gap-3 sm:flex-row">
                <div ref={helperModelDropdownRef} className="relative min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setHelperModelDropdownOpen((prev) => !prev)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-miro-border/40 bg-white/88 px-3 py-2 text-left text-sm text-miro-text shadow-ring transition-colors hover:bg-white/95 focus:outline-none focus:ring-0"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {helperModelDraft
                        ? getModelDisplayName(helperModelDraft, providerModelsById, t("shell.modelUnset"))
                        : t("settings.helperModelPlaceholder")}
                    </span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-miro-text-secondary">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {helperModelDropdownOpen && (
                    <div
                      role="listbox"
                      className="absolute left-0 top-full mt-1.5 z-50 max-h-64 w-full overflow-y-auto rounded-xl border border-miro-border/40 bg-white/95 p-1.5 shadow-ring"
                    >
                      <button
                        role="option"
                        type="button"
                        aria-selected={!helperModelDraft}
                        onClick={() => { setHelperModelDraft(""); setHelperModelDropdownOpen(false); }}
                        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          !helperModelDraft
                            ? "bg-miro-blue-light/65 text-miro-blue"
                            : "text-miro-text hover:bg-miro-surface-high"
                        }`}
                      >
                        <span className="truncate">{t("settings.helperModelPlaceholder")}</span>
                        {!helperModelDraft && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                      </button>
                      {availableModelOptions.map((option) => (
                        <button
                          key={option.id}
                          role="option"
                          type="button"
                          aria-selected={helperModelDraft === option.id}
                          onClick={() => { setHelperModelDraft(option.id); setHelperModelDropdownOpen(false); }}
                          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                            helperModelDraft === option.id
                              ? "bg-miro-blue-light/65 text-miro-blue"
                              : "text-miro-text hover:bg-miro-surface-high"
                          }`}
                        >
                          <span className="truncate">
                            {option.providerName} / {option.displayName}
                          </span>
                          {helperModelDraft === option.id && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleSaveHelperModel()}
                  disabled={isSubmitting}
                  className="app-primary-button"
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
            {!appHelperModelId && (
              <p className="mt-3 text-xs text-amber-600">
                {t("settings.helperModelNotConfigured")}
              </p>
            )}
          </section>

          {/* System Prompt */}
          <section id="section-system-prompt" className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
            <div className="mb-4 flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                  {t("settings.systemPromptTitle")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                  {t("settings.systemPromptHelp")}
                </p>
              </div>
              <p className="shrink-0 rounded-full bg-miro-surface-low px-3 py-1 text-xs font-medium text-miro-text-secondary">
                {t("settings.systemPromptCharCount", { count: systemPromptCharCount })}
              </p>
            </div>
            <textarea
              value={systemPromptDraft}
              onChange={(event) => setSystemPromptDraft(event.target.value)}
              placeholder={t("settings.systemPromptPlaceholder")}
              rows={12}
              className="app-input min-h-[220px] w-full min-w-0 resize-y font-mono text-xs leading-5"
            />
            <div className="mt-3 rounded-panel bg-miro-surface-low px-4 py-3 text-xs leading-5 text-miro-text-secondary">
              <p className="font-semibold text-miro-text">
                {t("settings.systemPromptPreviewTitle")}
              </p>
              <p className="mt-1">{t("settings.systemPromptPreview")}</p>
            </div>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => void handleResetSystemPrompt()}
                disabled={isSubmitting}
                className="app-secondary-button"
              >
                {t("settings.systemPromptReset")}
              </button>
              <button
                type="button"
                onClick={() => void handleSaveSystemPrompt()}
                disabled={isSubmitting}
                className="app-primary-button"
              >
                {t("common.save")}
              </button>
            </div>
          </section>

          {/* Tool Settings */}
          <ToolSettingsSection />

          {/* Security Policy */}
          <SecurityPolicySection />

          {/* Builtin Tools */}
          <BuiltinToolsSection />

          {/* MCP Servers */}
          <McpServersSection />

          {/* Skills */}
          <SkillsSection />

          {/* Error / Feedback */}
          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {feedback && (
            <div className={`rounded-2xl border px-4 py-3 text-sm ${feedbackClassName}`}>
              {feedback.message}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          {/* Language */}
          <section id="section-language" className="app-panel rounded-shell bg-white/95 px-5 py-4">
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-4">
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
                  {t("settings.languageTitle")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                  {t("settings.languageHelp")}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {(Object.entries(SUPPORTED_LOCALES) as [SupportedLocale, string][]).map(
                  ([localeKey, localeLabel]) => (
                    <button
                      key={localeKey}
                      type="button"
                      onClick={() => i18n.changeLanguage(localeKey)}
                      className={`rounded-lg px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors ${
                        i18n.language === localeKey
                          ? "bg-miro-blue-light text-miro-blue shadow-ring"
                          : "bg-miro-surface-low text-miro-text-secondary hover:bg-miro-surface"
                      }`}
                    >
                      {localeLabel}
                    </button>
                  )
                )}
              </div>
            </div>
          </section>

          {/* Close Behavior & Shell Path */}
          <div id="section-close-behavior">
          <CloseBehaviorSection />
          </div>

          {/* Shortcuts */}
          <section id="section-shortcuts" className="app-panel rounded-shell bg-white/95 p-5">
            <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
              {t("settings.shortcutsTitle")}
            </h3>
            <div className="mt-3 space-y-2">
              {shortcutItems.map((item) => (
                <div key={item.key} className="flex min-w-0 items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-miro-text-secondary">
                    {t(item.labelKey)}
                  </span>
                  <kbd className="shrink-0 rounded-md border border-miro-border/30 bg-miro-surface-low px-2 py-0.5 font-mono text-xs text-miro-text">
                    {item.display}
                  </kbd>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** Close behavior and shell path settings loaded from Tauri backend. */
function CloseBehaviorSection() {
  const { t } = useTranslation();
  const showToast = useSettingsToast();
  const [closeBehavior, setCloseBehaviorLocal] = useState<"exit" | "tray">("exit");
  const [shellPath, setShellPathLocal] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const closeBehaviorDirtyRef = useRef(false);
  const shellPathDirtyRef = useRef(false);

  useEffect(() => {
    let active = true;
    const loadInitialSettings = async () => {
      const [closeResult, shellResult] = await Promise.allSettled([
        tauriCmd.getCloseBehavior(),
        tauriCmd.getShellPath(),
      ]);
      if (!active) return;
      if (closeResult.status === "fulfilled" && !closeBehaviorDirtyRef.current) {
        setCloseBehaviorLocal(closeResult.value);
      }
      if (shellResult.status === "fulfilled" && !shellPathDirtyRef.current) {
        setShellPathLocal(shellResult.value);
      }
      setLoaded(true);
    };
    void loadInitialSettings();
    return () => { active = false; };
  }, []);

  /** Handle close behavior change with auto-save. */
  const handleCloseBehaviorChange = async (behavior: "exit" | "tray") => {
    closeBehaviorDirtyRef.current = true;
    setCloseBehaviorLocal(behavior);
    try {
      await tauriCmd.setCloseBehavior(behavior);
      showToast(t("common.saved"));
    } catch { /* ignore */ }
  };

  /** Handle shell path save. */
  const handleShellPathSave = async () => {
    setSaving(true);
    try {
      await tauriCmd.setShellPath(shellPath.trim());
      showToast(t("common.saved"));
    } catch {
      showToast(t("settings.providerSaveFailed"), "error");
    }
    setSaving(false);
  };

  /** Browse for a shell executable path. */
  const handleBrowseShell = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: t("settings.shellPathTitle"),
      });
      if (selected && typeof selected === "string") {
        shellPathDirtyRef.current = true;
        setShellPathLocal(selected);
      }
    } catch { /* cancelled */ }
  };

  if (!loaded) return null;

  return (
    <section className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
      <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
        {t("settings.closeBehaviorTitle")}
      </h3>
      <p className="mt-1 text-xs text-miro-text-secondary">
        {t("settings.closeBehaviorHelp")}
      </p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => handleCloseBehaviorChange("exit")}
          className={`flex-1 rounded-lg border-2 p-3 text-left transition-all ${
            closeBehavior === "exit"
              ? "border-emerald-400 bg-emerald-50"
              : "border-gray-200 bg-white hover:border-gray-300"
          }`}
        >
          <div className="text-sm font-medium text-miro-text">
            {t("settings.closeBehaviorExit")}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-miro-text-secondary">
            {t("settings.closeBehaviorExitDesc")}
          </div>
        </button>
        <button
          type="button"
          onClick={() => handleCloseBehaviorChange("tray")}
          className={`flex-1 rounded-lg border-2 p-3 text-left transition-all ${
            closeBehavior === "tray"
              ? "border-emerald-400 bg-emerald-50"
              : "border-gray-200 bg-white hover:border-gray-300"
          }`}
        >
          <div className="text-sm font-medium text-miro-text">
            {t("settings.closeBehaviorTray")}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-miro-text-secondary">
            {t("settings.closeBehaviorTrayDesc")}
          </div>
        </button>
      </div>

      <div id="section-shell-path">
      <h3 className="mt-6 font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
        {t("settings.shellPathTitle")}
      </h3>
      <p className="mt-1 text-xs text-miro-text-secondary">
        {t("settings.shellPathHelp")}
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={shellPath}
          onChange={(e) => {
            shellPathDirtyRef.current = true;
            setShellPathLocal(e.target.value);
          }}
          placeholder={t("settings.shellPathPlaceholder")}
          className="app-input flex-1 rounded-lg px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={handleBrowseShell}
          className="app-secondary-button rounded-lg px-3 py-2 text-xs whitespace-nowrap"
        >
          {t("common.browse", "Browse")}
        </button>
        <button
          type="button"
          onClick={handleShellPathSave}
          disabled={saving}
          className="app-primary-button rounded-lg px-3 py-2 text-xs whitespace-nowrap"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
      </div>
    </section>
  );
}
