/**
 * @file AppSettingsView.tsx
 * @description Application-level settings view.
 *
 * Contains default model, helper model, system prompt, language,
 * close behavior, shell path, and keyboard shortcuts.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { useThemeStore, type ThemeMode } from "../../stores/useThemeStore";
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

/** Toast context for settings feedback. */
export const SettingsToastContext = createContext<(message: string, tone?: "success" | "error") => void>(() => {});

/** Hook to access the settings toast. */
export function useSettingsToast() {
  return useContext(SettingsToastContext);
}

const THEME_OPTIONS: { mode: ThemeMode; icon: React.ReactNode }[] = [
  {
    mode: "system",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    mode: "light",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ),
  },
  {
    mode: "dark",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    ),
  },
];

function ThemeToggle() {
  const { t } = useTranslation();
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  return (
    <div className="flex shrink-0 gap-1.5">
      {THEME_OPTIONS.map(({ mode, icon }) => (
        <button
          key={mode}
          type="button"
          onClick={() => setThemeMode(mode)}
          className={`inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors ${
            themeMode === mode
              ? "bg-miro-blue-light text-miro-blue shadow-ring"
              : "bg-miro-surface-low text-miro-text-secondary hover:bg-miro-surface"
          }`}
          title={t(`settings.theme${mode.charAt(0).toUpperCase() + mode.slice(1)}`)}
        >
          <span className="mr-1.5">{icon}</span>
          {t(`settings.theme${mode.charAt(0).toUpperCase() + mode.slice(1)}`)}
        </button>
      ))}
    </div>
  );
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

  const availableModelOptions = useMemo(
    () => listAvailableModelOptions(providersById, providerOrder, providerModelsById),
    [providersById, providerOrder, providerModelsById]
  );

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
  const showToast = useSettingsToast();

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
    try {
      await setDefaultModel(defaultModelDraft.trim() || null);
      showToast(t("common.saved"));
    } catch (modelError) {
      showToast(
        modelError instanceof Error ? modelError.message : t("settings.defaultModelSaveFailed"),
        "error"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Persist the helper model used for background AI tasks. */
  async function handleSaveHelperModel(): Promise<void> {
    setIsSubmitting(true);
    try {
      await setHelperModel(helperModelDraft.trim() || null);
      showToast(t("common.saved"));
    } catch (modelError) {
      showToast(
        modelError instanceof Error ? modelError.message : t("settings.helperModelSaveFailed"),
        "error"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Persist the application-level prompt prefix used for future model requests. */
  async function handleSaveSystemPrompt(): Promise<void> {
    setIsSubmitting(true);
    try {
      const savedPrompt = await setSystemPrompt(systemPromptDraft);
      setSystemPromptDraft(savedPrompt);
      showToast(t("common.saved"));
    } catch (promptError) {
      showToast(
        promptError instanceof Error ? promptError.message : t("settings.systemPromptSaveFailed"),
        "error"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Reset the system prompt by saving an empty value. */
  async function handleResetSystemPrompt(): Promise<void> {
    setIsSubmitting(true);
    try {
      const savedPrompt = await setSystemPrompt("");
      setSystemPromptDraft(savedPrompt);
      showToast(t("common.saved"));
    } catch (promptError) {
      showToast(
        promptError instanceof Error ? promptError.message : t("settings.systemPromptSaveFailed"),
        "error"
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
          <section id="section-default-model" className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-6">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                  {t("settings.defaultModelTitle")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                  {t("settings.defaultModelHelp")}
                </p>
              </div>
              <div className="flex min-w-0 items-end gap-3">
                <div ref={defaultModelDropdownRef} className="relative min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setDefaultModelDropdownOpen((prev) => !prev)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-miro-border/15 bg-miro-card/88 px-3 py-2 text-left text-sm text-miro-text shadow-ring transition-colors hover:bg-miro-card/95 focus:outline-hidden focus:ring-0"
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
                      className="absolute left-0 top-full mt-1.5 z-50 max-h-64 w-full overflow-y-auto rounded-xl border border-miro-border/15 bg-miro-card/95 p-1.5 shadow-ring"
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
                  className="app-primary-button shrink-0 whitespace-nowrap"
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
          </section>

          {/* Helper Model */}
          <section id="section-helper-model" className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-6">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                  {t("settings.helperModelTitle")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                  {t("settings.helperModelHelp")}
                </p>
              </div>
              <div className="flex min-w-0 items-end gap-3">
                <div ref={helperModelDropdownRef} className="relative min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setHelperModelDropdownOpen((prev) => !prev)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-miro-border/15 bg-miro-card/88 px-3 py-2 text-left text-sm text-miro-text shadow-ring transition-colors hover:bg-miro-card/95 focus:outline-hidden focus:ring-0"
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
                      className="absolute left-0 top-full mt-1.5 z-50 max-h-64 w-full overflow-y-auto rounded-xl border border-miro-border/15 bg-miro-card/95 p-1.5 shadow-ring"
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
                  className="app-primary-button shrink-0 whitespace-nowrap"
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
            {!appHelperModelId && (
              <p className="mt-3 text-xs text-miro-amber">
                {t("settings.helperModelNotConfigured")}
              </p>
            )}
          </section>

          {/* System Prompt */}
          <section id="section-system-prompt" className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-6">
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
        </div>

        <aside className="space-y-4">
          {/* Theme */}
          <section id="section-theme" className="app-panel rounded-shell bg-miro-card/95 px-5 py-4">
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-4">
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
                  {t("settings.themeTitle")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                  {t("settings.themeHelp")}
                </p>
              </div>
              <ThemeToggle />
            </div>
          </section>

          {/* Language */}
          <section id="section-language" className="app-panel rounded-shell bg-miro-card/95 px-5 py-4">
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
          <section id="section-shortcuts" className="app-panel rounded-shell bg-miro-card/95 p-5">
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

  /** Auto-detect shell path on the system. */
  const handleAutoDetect = async () => {
    try {
      const detected = await tauriCmd.detectShellPath();
      if (detected) {
        shellPathDirtyRef.current = true;
        setShellPathLocal(detected);
        showToast(t("settings.shellPathDetected", { path: detected }));
      } else {
        showToast(t("settings.shellPathNotDetected"), "error");
      }
    } catch {
      showToast(t("settings.shellPathNotDetected"), "error");
    }
  };

  if (!loaded) return null;

  return (
    <section className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-5">
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
              ? "border-miro-green-light bg-miro-green-light"
              : "border-miro-border/30 bg-miro-card hover:border-miro-border/50"
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
              ? "border-miro-green-light bg-miro-green-light"
              : "border-miro-border/30 bg-miro-card hover:border-miro-border/50"
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
          onClick={() => void handleAutoDetect()}
          className="app-secondary-button rounded-lg px-3 py-2 text-xs whitespace-nowrap"
        >
          {t("settings.shellPathAutoDetect")}
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
