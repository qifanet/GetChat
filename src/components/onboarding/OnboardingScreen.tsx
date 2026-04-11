/**
 * @file OnboardingScreen.tsx
 * @description First-run onboarding for configuring the initial provider.
 *
 * This screen is rendered only when the application has no configured provider.
 * It collects the minimum required provider settings, persists them through the
 * Tauri command layer, and opens a working conversation so the user can start
 * chatting immediately after setup.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createModelProfileId } from "../../features/models/modelUtils";
import { useAppStore } from "../../stores/useAppStore";
import type { ProviderType } from "../../types/settings";

// ============================================================================
// Presets
// ============================================================================

interface ProviderPreset {
  name: string;
  baseUrl: string;
  defaultModelId: string;
}

/** Return the default form preset for the selected provider type. */
function getProviderPreset(type: ProviderType): ProviderPreset {
  if (type === "OLLAMA") {
    return {
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModelId: "llama3.1",
    };
  }

  return {
    name: "OpenAI Compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModelId: "gpt-4.1-mini",
  };
}

// ============================================================================
// Component
// ============================================================================

/** Render the first-run onboarding workflow for provider configuration. */
export function OnboardingScreen() {
  const { t } = useTranslation();
  const summaryOrder = useAppStore((s) => s.summaryOrder);
  const activeConversationId = useAppStore((s) => s.workspace.activeConversationId);
  const saveProvider = useAppStore((s) => s.saveProvider);
  const setDefaultModel = useAppStore((s) => s.setDefaultModel);
  const createConversation = useAppStore((s) => s.createConversation);
  const openConversation = useAppStore((s) => s.openConversation);

  const [providerType, setProviderType] =
    useState<ProviderType>("OPENAI_COMPATIBLE");
  const preset = useMemo(() => getProviderPreset(providerType), [providerType]);
  const [providerName, setProviderName] = useState(preset.name);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [defaultModelId, setDefaultModelId] = useState(preset.defaultModelId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Apply the provider-type preset without discarding explicit user edits elsewhere. */
  function applyPreset(type: ProviderType): void {
    const nextPreset = getProviderPreset(type);
    setProviderType(type);
    setProviderName(nextPreset.name);
    setBaseUrl(nextPreset.baseUrl);
    setDefaultModelId(nextPreset.defaultModelId);
  }

  /** Persist the provider and ensure the user lands in an open conversation. */
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const initialModelId = createModelProfileId();
      const normalizedModelName = defaultModelId.trim();
      const savedProvider = await saveProvider({
        type: providerType,
        name: providerName.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        defaultModelId: normalizedModelName ? initialModelId : undefined,
        models: normalizedModelName
          ? [
              {
                id: initialModelId,
                requestName: normalizedModelName,
                displayName: normalizedModelName,
              },
            ]
          : [],
        enabled: true,
      });

      await setDefaultModel(savedProvider.defaultModelId ?? null);

      if (activeConversationId) {
        return;
      }

      if (summaryOrder.length > 0) {
        await openConversation(summaryOrder[0]);
        return;
      }

      const conversationId = await createConversation();
      await openConversation(conversationId);
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : t("onboarding.saveFailed");
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell flex h-full gap-4 p-4">
      <section className="app-panel hidden w-[38%] min-w-[360px] flex-col justify-between rounded-shell bg-gradient-to-br from-miro-coral-light via-white to-miro-orange-light px-10 py-12 lg:flex">
        <div className="space-y-5">
          <span className="inline-flex rounded-full border border-miro-border bg-white/85 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-miro-amber shadow-ring">
            {t("onboarding.badge")}
          </span>
          <div className="space-y-3">
            <h1 className="max-w-sm font-display text-5xl font-semibold leading-tight tracking-[-0.05em] text-miro-text">
              {t("onboarding.title")}
            </h1>
            <p className="max-w-md text-base leading-8 text-miro-text-secondary">
              {t("onboarding.subtitle")}
            </p>
          </div>
        </div>

        <div className="space-y-3 rounded-panel border border-white/80 bg-white/80 p-5 shadow-ring backdrop-blur">
          <h2 className="font-display text-base font-semibold text-miro-text">
            {t("onboarding.noteTitle")}
          </h2>
          <p className="text-sm leading-6 text-miro-text-secondary">
            {t("onboarding.noteBody")}
          </p>
        </div>
      </section>

      <section className="flex flex-1 items-center justify-center px-6 py-8">
        <div className="app-panel w-full max-w-xl rounded-shell bg-white/95 p-8 sm:p-10">
          <div className="mb-8 space-y-2">
            <p className="app-section-label text-miro-amber lg:hidden">
              {t("onboarding.badge")}
            </p>
            <h2 className="font-display text-3xl font-semibold tracking-[-0.04em] text-miro-text">
              {t("onboarding.formTitle")}
            </h2>
            <p className="text-sm leading-6 text-miro-text-secondary">
              {t("onboarding.formSubtitle")}
            </p>
          </div>

          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="grid gap-5 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium text-miro-text">
                  {t("onboarding.providerType")}
                </span>
                <select
                  value={providerType}
                  onChange={(event) =>
                    applyPreset(event.target.value as ProviderType)
                  }
                  className="app-input"
                >
                  <option value="OPENAI_COMPATIBLE">
                    {t("onboarding.providerTypeOpenAI")}
                  </option>
                  <option value="OLLAMA">
                    {t("onboarding.providerTypeOllama")}
                  </option>
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-miro-text">
                  {t("onboarding.providerName")}
                </span>
                <input
                  value={providerName}
                  onChange={(event) => setProviderName(event.target.value)}
                  className="app-input"
                  placeholder={preset.name}
                  required
                />
              </label>
            </div>

            <label className="space-y-2">
              <span className="text-sm font-medium text-miro-text">
                {t("onboarding.baseUrl")}
              </span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="app-input"
                placeholder={preset.baseUrl}
                required
              />
            </label>

            <div className="grid gap-5 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium text-miro-text">
                  {t("onboarding.apiKey")}
                </span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="app-input"
                  placeholder={
                    providerType === "OLLAMA"
                      ? t("onboarding.apiKeyOptional")
                      : t("onboarding.apiKeyPlaceholder")
                  }
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-miro-text">
                  {t("onboarding.defaultModel")}
                </span>
                <input
                  value={defaultModelId}
                  onChange={(event) => setDefaultModelId(event.target.value)}
                  className="app-input"
                  placeholder={preset.defaultModelId}
                />
              </label>
            </div>

            <div className="rounded-panel border border-dashed border-miro-border bg-miro-orange-light px-4 py-3 text-sm leading-6 text-miro-amber">
              {t("onboarding.connectionNotice")}
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-miro-text-secondary">
                {t("onboarding.footerHint")}
              </p>
              <button
                type="submit"
                disabled={submitting}
                className="app-primary-button"
              >
                {submitting
                  ? t("onboarding.saving")
                  : t("onboarding.submit")}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
