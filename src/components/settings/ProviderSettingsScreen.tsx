/**
 * @file ProviderSettingsScreen.tsx
 * @description Provider settings workspace for creating, editing, and deleting
 * model providers after onboarding.
 *
 * This screen exposes a desktop-focused management surface where users can
 * maintain providers, manage multiple model profiles under each provider, and
 * set the application-level fallback model without leaving the workspace.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LOCALES, type SupportedLocale } from "../../i18n";
import {
  createModelProfileId,
  getModelDisplayName,
  listAvailableModelOptions,
} from "../../features/models/modelUtils";
import { useAppStore } from "../../stores/useAppStoreSelector";
import * as tauriCmd from "../../services/tauriCommands";
import type { ProviderConfig, ProviderSaveInput, ProviderType } from "../../types/settings";
import { IconChevronLeft, IconSettings, IconTrash } from "../common/Icon";
import { confirmDialog } from "../common/confirmDialog";
const _sel_providers = (s: import("../../stores/appStore.types").AppStore) => s.providers;
const _sel_providerModels = (s: import("../../stores/appStore.types").AppStore) => s.providerModels;
const _sel_providerOrder = (s: import("../../stores/appStore.types").AppStore) => s.providerOrder;
const _sel_defaultModelId = (s: import("../../stores/appStore.types").AppStore) => s.defaultModelId;
const _sel_saveProvider = (s: import("../../stores/appStore.types").AppStore) => s.saveProvider;
const _sel_removeProvider = (s: import("../../stores/appStore.types").AppStore) => s.removeProvider;
const _sel_setDefaultModel = (s: import("../../stores/appStore.types").AppStore) => s.setDefaultModel;
const _sel_loadSettings = (s: import("../../stores/appStore.types").AppStore) => s.loadSettings;
type EditableProviderId = string | "new";
/** Draft state for a single provider model row inside the form. */
interface ProviderModelFormState {
  id: string;
  requestName: string;
  displayName: string;
}
/** Draft state for the provider editor form. */
interface ProviderFormState {
  id?: string;
  type: ProviderType;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModelId: string;
  enabled: boolean;
  models: ProviderModelFormState[];
}
/** Lightweight local feedback used by the settings workspace. */
interface SettingsFeedbackState {
  tone: "success" | "error" | "info";
  message: string;
}
/** Create a new model draft with a stable system-owned model profile ID. */
function createDraftModel(
  requestName = "",
  displayName = ""
): ProviderModelFormState {
  return {
    id: createModelProfileId(),
    requestName,
    displayName,
  };
}
/** Return sensible provider presets so new forms start from usable defaults. */
function getProviderPreset(type: ProviderType): Pick<
  ProviderFormState,
  "type" | "name" | "baseUrl" | "defaultModelId" | "enabled" | "models"
> {
  if (type === "OLLAMA") {
    const defaultModel = createDraftModel("llama3.1", "Llama 3.1");
    return {
      type,
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModelId: defaultModel.id,
      enabled: true,
      models: [defaultModel],
    };
  }
  const defaultModel = createDraftModel("gpt-4.1-mini", "GPT-4.1 Mini");
  return {
    type,
    name: "OpenAI Compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModelId: defaultModel.id,
    enabled: true,
    models: [defaultModel],
  };
}
/** Map a persisted provider into the editable provider form shape. */
function buildFormFromProvider(
  provider: ProviderConfig,
  providerModels: ReturnType<typeof useAppStore.getState>["providerModels"]
): ProviderFormState {
  const models = provider.modelIds
    .map((modelId) => providerModels[modelId])
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .map((model) => ({
      id: model.id,
      requestName: model.requestName,
      displayName: model.displayName,
    }));
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    defaultModelId: provider.defaultModelId ?? models[0]?.id ?? "",
    enabled: provider.enabled,
    models,
  };
}
/** Build a fresh provider form using the selected preset. */
function buildEmptyProviderForm(
  type: ProviderType = "OPENAI_COMPATIBLE"
): ProviderFormState {
  return {
    ...getProviderPreset(type),
    apiKey: "",
  };
}
/** Compare the form draft with the persisted provider, including nested models. */
function isProviderDraftChanged(
  form: ProviderFormState,
  provider: ProviderConfig | null,
  providerModels: ReturnType<typeof useAppStore.getState>["providerModels"]
): boolean {
  if (!provider) {
    return true;
  }
  const savedModels = provider.modelIds
    .map((modelId) => providerModels[modelId])
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .map((model) => ({
      id: model.id,
      requestName: model.requestName,
      displayName: model.displayName,
    }));
  const currentModels = form.models.map((model) => ({
    id: model.id,
    requestName: model.requestName.trim(),
    displayName: model.displayName.trim(),
  }));
  return (
    form.type !== provider.type ||
    form.name.trim() !== provider.name ||
    form.baseUrl.trim() !== provider.baseUrl ||
    form.defaultModelId !== (provider.defaultModelId ?? "") ||
    form.enabled !== provider.enabled ||
    form.apiKey.trim().length > 0 ||
    JSON.stringify(currentModels) !== JSON.stringify(savedModels)
  );
}
/** Resolve a display label for a model ID using the form draft before store data. */
function resolveDraftModelDisplayName(
  modelId: string | null | undefined,
  models: ProviderModelFormState[],
  fallbackLabel: string
): string {
  if (!modelId) {
    return fallbackLabel;
  }
  const model = models.find((item) => item.id === modelId);
  if (!model) {
    return modelId;
  }
  return model.displayName.trim() || model.requestName.trim() || model.id;
}
interface ProviderSettingsScreenProps {
  onClose: () => void;
}
/** Render the provider settings workspace with multi-model configuration support. */
export function ProviderSettingsScreen({
  onClose,
}: ProviderSettingsScreenProps) {
  const { t, i18n } = useTranslation();
  const providersById = useAppStore(_sel_providers);
  const providerModelsById = useAppStore(_sel_providerModels);
  const providerOrder = useAppStore(_sel_providerOrder);
  const appDefaultModelId = useAppStore(_sel_defaultModelId);
  const saveProvider = useAppStore(_sel_saveProvider);
  const removeProvider = useAppStore(_sel_removeProvider);
  const setDefaultModel = useAppStore(_sel_setDefaultModel);
  const loadSettings = useAppStore(_sel_loadSettings);
  const orderedProviders = useMemo(
    () =>
      providerOrder
        .map((providerId) => providersById[providerId])
        .filter((provider): provider is ProviderConfig => Boolean(provider)),
    [providerOrder, providersById]
  );
  const availableModelOptions = useMemo(
    () =>
      listAvailableModelOptions(providersById, providerOrder, providerModelsById),
    [providerModelsById, providerOrder, providersById]
  );
  const [selectedProviderId, setSelectedProviderId] =
    useState<EditableProviderId>(providerOrder[0] ?? "new");
  const [form, setForm] = useState<ProviderFormState>(() =>
    providerOrder[0] && providersById[providerOrder[0]]
      ? buildFormFromProvider(providersById[providerOrder[0]], providerModelsById)
      : buildEmptyProviderForm()
  );
  const [defaultModelDraft, setDefaultModelDraft] = useState(
    appDefaultModelId ?? ""
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SettingsFeedbackState | null>(null);
  const selectedSavedProvider =
    selectedProviderId !== "new" ? providersById[selectedProviderId] ?? null : null;
  const isProviderDraftDirty = useMemo(
    () => isProviderDraftChanged(form, selectedSavedProvider, providerModelsById),
    [form, providerModelsById, selectedSavedProvider]
  );
  const enabledProviderCount = orderedProviders.filter((provider) => provider.enabled).length;
  const configuredModelCount = orderedProviders.reduce(
    (count, provider) => count + provider.modelIds.length,
    0
  );
  const feedbackClassName =
    feedback?.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : feedback?.tone === "error"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-miro-border bg-miro-bg text-miro-text-secondary";
  const selectedConnectionState =
    selectedProviderId === "new"
      ? t("settings.draftState")
      : form.enabled
        ? t("settings.enabled")
        : t("settings.disabled");
  const selectedProviderSummaryName =
    selectedProviderId === "new"
      ? form.name.trim() || t("settings.createProviderTitle")
      : selectedSavedProvider?.name || t("settings.editProviderTitle");
  const draftDefaultModelName = resolveDraftModelDisplayName(
    form.defaultModelId,
    form.models,
    t("shell.modelUnset")
  );
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  useEffect(() => {
    setDefaultModelDraft(appDefaultModelId ?? "");
  }, [appDefaultModelId]);
  useEffect(() => {
    if (
      selectedProviderId !== "new" &&
      !providersById[selectedProviderId] &&
      providerOrder.length > 0
    ) {
      setSelectedProviderId(providerOrder[0]);
      return;
    }
    if (selectedProviderId === "new") {
      return;
    }
    const provider = providersById[selectedProviderId];
    if (provider) {
      setForm(buildFormFromProvider(provider, providerModelsById));
    }
  }, [providerModelsById, providerOrder, providersById, selectedProviderId]);
  useEffect(() => {
    setFeedback(null);
  }, [selectedProviderId]);
  useEffect(() => {
    setForm((current) => {
      if (current.models.length === 0) {
        if (current.defaultModelId === "") {
          return current;
        }
        return {
          ...current,
          defaultModelId: "",
        };
      }
      if (current.models.some((model) => model.id === current.defaultModelId)) {
        return current;
      }
      return {
        ...current,
        defaultModelId: current.models[0].id,
      };
    });
  }, [form.models]);
  /** Patch one top-level form field while preserving the current draft. */
  function patchForm<K extends keyof ProviderFormState>(
    key: K,
    value: ProviderFormState[K]
  ): void {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }
  /** Patch one model row inside the nested provider models list. */
  function patchModel(
    modelId: string,
    patch: Partial<ProviderModelFormState>
  ): void {
    setForm((current) => ({
      ...current,
      models: current.models.map((model) =>
        model.id === modelId ? { ...model, ...patch } : model
      ),
    }));
  }
  /** Apply a provider-type preset while keeping user-entered values when possible. */
  function applyProviderType(type: ProviderType): void {
    const preset = getProviderPreset(type);
    setForm((current) => ({
      ...current,
      type,
      name:
        selectedProviderId === "new" || current.name.trim().length === 0
          ? preset.name
          : current.name,
      baseUrl:
        selectedProviderId === "new" || current.baseUrl.trim().length === 0
          ? preset.baseUrl
          : current.baseUrl,
      defaultModelId:
        selectedProviderId === "new" || current.defaultModelId.trim().length === 0
          ? preset.defaultModelId
          : current.defaultModelId,
      models:
        selectedProviderId === "new" && current.models.length <= 1
          ? preset.models
          : current.models,
    }));
  }
  /** Start a fresh provider draft using the chosen provider type preset. */
  function startCreatingProvider(type: ProviderType = "OPENAI_COMPATIBLE"): void {
    setSelectedProviderId("new");
    setForm(buildEmptyProviderForm(type));
    setError(null);
    setFeedback(null);
  }
  /** Add a new empty model row and keep the provider default model coherent. */
  function handleAddModel(): void {
    const nextModel = createDraftModel();
    setForm((current) => ({
      ...current,
      models: [...current.models, nextModel],
      defaultModelId: current.defaultModelId || nextModel.id,
    }));
  }
  /** Remove a model row while always keeping at least one model in the form. */
  function handleRemoveModel(modelId: string): void {
    setForm((current) => {
      if (current.models.length <= 1) {
        return current;
      }
      const models = current.models.filter((model) => model.id !== modelId);
      return {
        ...current,
        models,
        defaultModelId:
          current.defaultModelId === modelId
            ? models[0]?.id ?? ""
            : current.defaultModelId,
      };
    });
  }
  /** Validate and persist the provider draft through the existing settings slice. */
  async function handleSaveProvider(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const normalizedModels = form.models.map((model) => ({
        id: model.id,
        requestName: model.requestName.trim(),
        displayName: model.displayName.trim(),
      }));
      if (normalizedModels.length === 0) {
        throw new Error(t("settings.modelsRequired"));
      }
      if (
        normalizedModels.some(
          (model) => model.requestName.length === 0 || model.displayName.length === 0
        )
      ) {
        throw new Error(t("settings.modelFieldsRequired"));
      }
      const resolvedDefaultModelId =
        normalizedModels.find((model) => model.id === form.defaultModelId)?.id ??
        normalizedModels[0].id;
      const payload: ProviderSaveInput = {
        id: selectedProviderId === "new" ? undefined : selectedProviderId,
        type: form.type,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        defaultModelId: resolvedDefaultModelId,
        models: normalizedModels,
        enabled: form.enabled,
      };
      const savedProvider = await saveProvider(payload);
      setSelectedProviderId(savedProvider.id);
      setForm(buildFormFromProvider(savedProvider, useAppStore.getState().providerModels));
      setFeedback({
        tone: "success",
        message: t("settings.providerSaved"),
      });
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : t("settings.providerSaveFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  /** Delete the currently selected provider after an explicit user confirmation. */
  async function handleDeleteProvider(): Promise<void> {
    if (selectedProviderId === "new") {
      return;
    }
    const confirmed = await confirmDialog({
      message: t("settings.confirmDeleteProvider"),
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await removeProvider(selectedProviderId);
      const remainingIds = providerOrder.filter((id) => id !== selectedProviderId);
      setSelectedProviderId(remainingIds[0] ?? "new");
      if (remainingIds.length === 0) {
        setForm(buildEmptyProviderForm());
      }
      setFeedback({
        tone: "success",
        message: t("settings.providerDeleted"),
      });
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : t("settings.providerDeleteFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  /** Persist the application-wide default model choice. */
  async function handleSaveDefaultModel(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      await setDefaultModel(defaultModelDraft.trim() || null);
      setFeedback({
        tone: "success",
        message: t("settings.defaultModelSaved"),
      });
    } catch (modelError) {
      setError(
        modelError instanceof Error
          ? modelError.message
          : t("settings.defaultModelSaveFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  /** Probe the current saved provider through the backend connection test command. */
  async function handleTestConnection(): Promise<void> {
    if (selectedProviderId === "new" || isProviderDraftDirty) {
      setFeedback({
        tone: "info",
        message: t("settings.saveBeforeTesting"),
      });
      return;
    }
    setIsTestingConnection(true);
    setError(null);
    setFeedback(null);
    try {
      await tauriCmd.testProviderConnection(selectedProviderId);
      setFeedback({
        tone: "success",
        message: t("settings.connectionSuccess"),
      });
    } catch (connectionError) {
      setFeedback({
        tone: "error",
        message:
          connectionError instanceof Error
            ? t("settings.connectionFailedWithReason", {
                message: connectionError.message,
              })
            : t("settings.connectionFailed"),
      });
    } finally {
      setIsTestingConnection(false);
    }
  }
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col gap-4 bg-transparent xl:flex-row">
      <aside className="app-panel flex w-full shrink-0 flex-col rounded-shell bg-white/95 xl:w-[330px]">
        <div className="border-b border-miro-border/10 px-5 py-5">
          <button
            type="button"
            onClick={onClose}
            className="app-secondary-button mb-4 justify-start gap-2 px-3 py-2 text-sm"
          >
            <IconChevronLeft size={14} />
            {t("settings.backToWorkspace")}
          </button>
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-miro-blue-light text-miro-blue shadow-ring">
              <IconSettings size={18} />
            </span>
            <div>
              <p className="app-section-label mb-1">{t("common.settings")}</p>
              <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
                {t("settings.title")}
              </h2>
              <p className="text-xs leading-5 text-miro-text-secondary">
                {t("settings.subtitle")}
              </p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 px-5 py-4">
          <div className="rounded-panel bg-miro-surface-low px-3 py-3">
            <p className="app-section-label mb-1">{t("settings.providerCount")}</p>
            <p className="text-lg font-semibold text-miro-text">{orderedProviders.length}</p>
          </div>
          <div className="rounded-panel bg-miro-surface-low px-3 py-3">
            <p className="app-section-label mb-1">{t("settings.enabled")}</p>
            <p className="text-lg font-semibold text-miro-text">{enabledProviderCount}</p>
          </div>
          <div className="rounded-panel bg-miro-surface-low px-3 py-3">
            <p className="app-section-label mb-1">{t("settings.modelCount")}</p>
            <p className="text-lg font-semibold text-miro-text">{configuredModelCount}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <button
            type="button"
            onClick={() => startCreatingProvider()}
            className="mb-4 flex w-full items-center justify-center rounded-[20px] border border-dashed border-miro-blue/35 bg-miro-blue-light/55 px-3 py-3 font-display text-sm font-semibold text-miro-blue transition-colors hover:border-miro-blue hover:bg-miro-blue-light"
          >
            {t("settings.addProvider")}
          </button>
          <div className="space-y-2">
            {orderedProviders.map((provider) => {
              const isSelected = selectedProviderId === provider.id;
              const isAppDefault = Boolean(
                appDefaultModelId && provider.modelIds.includes(appDefaultModelId)
              );
              const providerDefaultModelName = getModelDisplayName(
                provider.defaultModelId,
                providerModelsById,
                t("shell.modelUnset")
              );
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => {
                    setSelectedProviderId(provider.id);
                    setError(null);
                  }}
                  className={`w-full rounded-[22px] px-4 py-4 text-left transition-colors ${
                    isSelected
                      ? "bg-miro-blue-light/70 shadow-ring"
                      : "bg-white/84 hover:bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-miro-text">
                        {provider.name}
                      </div>
                      <div className="mt-1 text-xs text-miro-text-secondary">
                        {provider.type}
                      </div>
                    </div>
                    <span
                      className={`app-status-pill ${
                        provider.hasApiKey
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700"
                      }`}
                    >
                      {provider.hasApiKey
                        ? t("settings.apiKeyReady")
                        : t("settings.apiKeyMissing")}
                    </span>
                  </div>
                  <div className="mt-2 line-clamp-1 text-xs text-miro-text-secondary">
                    {provider.baseUrl}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-wide text-miro-text-secondary">
                    <span>{provider.enabled ? t("settings.enabled") : t("settings.disabled")}</span>
                    <span>{t("settings.modelCountShort", { count: provider.modelIds.length })}</span>
                    <span>{providerDefaultModelName}</span>
                    {isAppDefault ? (
                      <span className="text-miro-blue">{t("settings.appDefaultBadge")}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <AboutSection />
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl gap-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <section className="app-panel rounded-shell bg-white/95 p-6">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-panel bg-miro-surface-low px-4 py-4">
                  <p className="app-section-label mb-2">{t("settings.defaultModelTitle")}</p>
                  <p className="line-clamp-2 text-sm font-semibold text-miro-text">
                    {getModelDisplayName(
                      appDefaultModelId,
                      providerModelsById,
                      t("shell.modelUnset")
                    )}
                  </p>
                </div>
                <div className="rounded-panel bg-miro-surface-low px-4 py-4">
                  <p className="app-section-label mb-2">{t("settings.currentObject")}</p>
                  <p className="line-clamp-2 text-sm font-semibold text-miro-text">
                    {selectedProviderSummaryName}
                  </p>
                </div>
                <div className="rounded-panel bg-miro-surface-low px-4 py-4">
                  <p className="app-section-label mb-2">{t("settings.connectionState")}</p>
                  <p className="line-clamp-2 text-sm font-semibold text-miro-text">
                    {selectedConnectionState}
                  </p>
                </div>
              </div>
            </section>
            <section className="app-panel rounded-shell bg-white/95 p-6">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                    {t("settings.defaultModelTitle")}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                    {t("settings.defaultModelHelp")}
                  </p>
                </div>
                <div className="flex w-full max-w-xl flex-col gap-3 sm:flex-row">
                  <select
                    value={defaultModelDraft}
                    onChange={(event) => setDefaultModelDraft(event.target.value)}
                    className="app-input flex-1"
                  >
                    <option value="">{t("shell.modelUnset")}</option>
                    {availableModelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.providerName} / {option.displayName}
                      </option>
                    ))}
                  </select>
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
            <section className="app-panel rounded-shell bg-white/95 p-6">
              <div className="mb-6 flex flex-col gap-2">
                <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                  {selectedProviderId === "new"
                    ? t("settings.createProviderTitle")
                    : t("settings.editProviderTitle")}
                </h3>
                <p className="text-sm leading-6 text-miro-text-secondary">
                  {t("settings.providerFormHelp")}
                </p>
              </div>
              <form className="space-y-5" onSubmit={(event) => void handleSaveProvider(event)}>
                <div className="grid gap-5 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-miro-text">
                      {t("settings.providerType")}
                    </span>
                    <select
                      value={form.type}
                      onChange={(event) =>
                        applyProviderType(event.target.value as ProviderType)
                      }
                      className="app-input"
                    >
                      <option value="OPENAI_COMPATIBLE">
                        {t("settings.providerTypeOpenAI")}
                      </option>
                      <option value="OLLAMA">
                        {t("settings.providerTypeOllama")}
                      </option>
                    </select>
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-miro-text">
                      {t("settings.providerName")}
                    </span>
                    <input
                      value={form.name}
                      onChange={(event) => patchForm("name", event.target.value)}
                      className="app-input"
                      required
                    />
                  </label>
                </div>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-miro-text">
                    {t("settings.baseUrl")}
                  </span>
                  <input
                    value={form.baseUrl}
                    onChange={(event) => patchForm("baseUrl", event.target.value)}
                    className="app-input"
                    required
                  />
                </label>
                <label className="inline-flex items-center gap-3 rounded-panel bg-miro-surface-low px-4 py-3 text-sm text-miro-text shadow-ring">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) => patchForm("enabled", event.target.checked)}
                    className="rounded border-miro-border text-miro-blue focus:ring-miro-blue/30"
                  />
                  <span>{t("settings.enabledProvider")}</span>
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-miro-text">
                    {t("settings.apiKey")}
                  </span>
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(event) => patchForm("apiKey", event.target.value)}
                    placeholder={t("settings.apiKeyPlaceholder")}
                    autoComplete="current-password"
                    className="app-input"
                  />
                </label>
                <section className="rounded-[28px] border border-miro-border/70 bg-miro-bg/70 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h4 className="font-display text-lg font-semibold tracking-[-0.02em] text-miro-text">
                        {t("settings.modelsTitle")}
                      </h4>
                      <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                        {t("settings.modelsHelp")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleAddModel}
                      className="app-secondary-button px-4 py-2 text-sm"
                    >
                      + {t("settings.addModel")}
                    </button>
                  </div>
                  <div className="mt-5 space-y-4">
                    {form.models.length === 0 ? (
                      <div className="rounded-panel border border-dashed border-miro-border bg-white/70 px-4 py-5 text-sm text-miro-text-secondary">
                        {t("settings.noModels")}
                      </div>
                    ) : null}
                    {form.models.map((model, index) => {
                      const isProviderDefault = form.defaultModelId === model.id;
                      return (
                        <article
                          key={model.id}
                          className="rounded-[24px] border border-miro-border/70 bg-white/90 p-4 shadow-[0_8px_24px_rgba(28,28,30,0.04)]"
                        >
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
                                  {t("settings.modelLabelWithIndex", { index: index + 1 })}
                                </p>
                                {isProviderDefault ? (
                                  <span className="app-status-pill border-miro-blue/20 bg-miro-blue-light/75 text-miro-blue">
                                    {t("settings.providerDefaultBadge")}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-xs leading-5 text-miro-text-secondary">
                                {t("settings.modelRoutingHelp")}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {!isProviderDefault ? (
                                <button
                                  type="button"
                                  onClick={() => patchForm("defaultModelId", model.id)}
                                  className="app-secondary-button px-3 py-2 text-xs"
                                >
                                  {t("settings.setAsProviderDefault")}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => handleRemoveModel(model.id)}
                                disabled={form.models.length <= 1}
                                className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-red-200 text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:border-miro-border disabled:text-miro-text-secondary"
                                title={t("settings.deleteProvider")}
                              >
                                <IconTrash size={14} />
                              </button>
                            </div>
                          </div>
                          <div className="mt-4 grid gap-4 lg:grid-cols-2">
                            <label className="space-y-2">
                              <span className="text-sm font-medium text-miro-text">
                                {t("settings.modelRequestName")}
                              </span>
                              <input
                                value={model.requestName}
                                onChange={(event) =>
                                  patchModel(model.id, { requestName: event.target.value })
                                }
                                placeholder={t("settings.modelRequestNamePlaceholder")}
                                className="app-input"
                                required
                              />
                            </label>
                            <label className="space-y-2">
                              <span className="text-sm font-medium text-miro-text">
                                {t("settings.modelDisplayName")}
                              </span>
                              <input
                                value={model.displayName}
                                onChange={(event) =>
                                  patchModel(model.id, { displayName: event.target.value })
                                }
                                placeholder={t("settings.modelDisplayNamePlaceholder")}
                                className="app-input"
                                required
                              />
                            </label>
                          </div>
                          <label className="mt-4 block space-y-2">
                            <span className="text-sm font-medium text-miro-text">
                              {t("settings.providerModelId")}
                            </span>
                            <input
                              value={model.id}
                              readOnly
                              className="app-input bg-miro-surface-low text-xs text-miro-text-secondary"
                            />
                          </label>
                        </article>
                      );
                    })}
                  </div>
                </section>
                <div className="rounded-panel border border-dashed border-miro-border bg-miro-bg px-4 py-3 text-sm leading-6 text-miro-text-secondary">
                  {selectedProviderId === "new" || isProviderDraftDirty
                    ? t("settings.saveBeforeTesting")
                    : t("settings.connectionHelp")}
                </div>
                {error ? (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                ) : null}
                {feedback ? (
                  <div className={`rounded-2xl border px-4 py-3 text-sm ${feedbackClassName}`}>
                    {feedback.message}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="submit"
                      disabled={isSubmitting || isTestingConnection}
                      className="app-primary-button"
                    >
                      {selectedProviderId === "new"
                        ? t("settings.createProvider")
                        : t("settings.saveProvider")}
                    </button>
                    <button
                      type="button"
                      disabled={
                        isSubmitting ||
                        isTestingConnection ||
                        selectedProviderId === "new" ||
                        isProviderDraftDirty
                      }
                      onClick={() => void handleTestConnection()}
                      className="app-secondary-button"
                      title={
                        selectedProviderId === "new" || isProviderDraftDirty
                          ? t("settings.saveBeforeTesting")
                          : t("settings.testConnection")
                      }
                    >
                      {isTestingConnection
                        ? t("settings.connectionTesting")
                        : t("settings.testConnection")}
                    </button>
                  </div>
                  {selectedProviderId !== "new" ? (
                    <button
                      type="button"
                      onClick={() => void handleDeleteProvider()}
                      disabled={isSubmitting || isTestingConnection}
                      className="rounded-xl border border-red-200 px-4 py-2.5 font-display text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:border-miro-border disabled:text-miro-text-secondary"
                    >
                      {t("settings.deleteProvider")}
                    </button>
                  ) : null}
                </div>
              </form>
            </section>
          </div>
          <aside className="space-y-4">
            <section className="app-panel rounded-shell bg-white/95 p-5">
              <p className="app-section-label mb-3">{t("settings.currentSummary")}</p>
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-miro-text-secondary">{t("settings.providerCount")}</span>
                  <span className="max-w-[170px] truncate font-semibold text-miro-text">
                    {selectedProviderSummaryName}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-miro-text-secondary">{t("settings.providerType")}</span>
                  <span className="font-semibold text-miro-text">{form.type}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-miro-text-secondary">{t("settings.connectionState")}</span>
                  <span className="font-semibold text-miro-text">{selectedConnectionState}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-miro-text-secondary">{t("settings.modelCount")}</span>
                  <span className="font-semibold text-miro-text">{form.models.length}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-miro-text-secondary">{t("settings.providerDefaultModel")}</span>
                  <span className="max-w-[170px] truncate font-semibold text-miro-text">
                    {draftDefaultModelName}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-miro-text-secondary">{t("settings.baseUrl")}</span>
                  <span className="max-w-[170px] truncate font-semibold text-miro-text">
                    {form.baseUrl || "--"}
                  </span>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {form.models.map((model) => (
                  <span
                    key={model.id}
                    className={`rounded-full px-3 py-1 text-xs ${
                      form.defaultModelId === model.id
                        ? "bg-miro-blue-light text-miro-blue"
                        : "bg-miro-surface-low text-miro-text-secondary"
                    }`}
                  >
                    {model.displayName.trim() || model.requestName.trim() || model.id}
                  </span>
                ))}
              </div>
            </section>
            <section className="app-panel rounded-shell bg-white/95 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
                    {t("settings.languageTitle")}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                    {t("settings.languageHelp")}
                  </p>
                </div>
                <div className="flex gap-2">
                  {(Object.entries(SUPPORTED_LOCALES) as [SupportedLocale, string][]).map(
                    ([localeKey, localeLabel]) => (
                      <button
                        key={localeKey}
                        type="button"
                        onClick={() => i18n.changeLanguage(localeKey)}
                        className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
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
            <section className="app-panel rounded-shell bg-white/95 p-5">
              <p className="app-section-label mb-3">{t("settings.configurationAdvice")}</p>
              <div className="space-y-3 text-sm leading-6 text-miro-text-secondary">
                <p>{t("settings.adviceModels")}</p>
                <p>{t("settings.adviceDefaultModel")}</p>
                <p>{t("settings.adviceConnection")}</p>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("../../services/updateChecker").then(({ checkForUpdate, isUpdaterSupported }) => {
      if (!isUpdaterSupported()) return;
      checkForUpdate().then((info) => {
        if (!cancelled && info) setUpdateInfo(info);
      }).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mx-4 mb-4 mt-auto border-t border-miro-border/10 pt-3">
      <p className="text-[11px] text-miro-text-secondary/60">
        {t("settings.version", { version: __APP_VERSION__ })}  ·  © 2026 QiFans
      </p>
      {updateInfo && (
        <a
          href="https://github.com/qifanet/GetChat/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 block rounded-md bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-100"
        >
          {t("settings.updateAvailable", { version: updateInfo.latestVersion })}
        </a>
      )}
    </div>
  );
}
