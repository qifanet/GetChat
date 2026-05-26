/**
 * @file ProviderSettingsScreen.tsx
 * @description Provider settings workspace for creating, editing, and deleting
 * model providers after onboarding.
 *
 * This screen exposes a desktop-focused management surface where users can
 * maintain providers, manage multiple model profiles under each provider, and
 * set the application-level fallback model without leaving the workspace.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  createModelProfileId,
  getModelDisplayName,
  listAvailableModelOptions,
} from "../../features/models/modelUtils";
import { useAppStore } from "../../stores/useAppStoreSelector";
import { checkForUpdate, isUpdaterSupported } from "../../services/updateChecker";
import * as tauriCmd from "../../services/tauriCommands";
import { fetchOllamaModels, type OllamaModelInfo } from "../../services/tauriCommands";
import type { ProviderConfig, ProviderSaveInput, ProviderType } from "../../types/settings";
import { IconChevronLeft, IconSettings, IconTrash } from "../common/Icon";
import { confirmDialog } from "../common/confirmDialog";
import { AppSettingsView, SettingsToastContext } from "./AppSettingsView";
const _sel_providers = (s: import("../../stores/appStore.types").AppStore) => s.providers;
const _sel_providerModels = (s: import("../../stores/appStore.types").AppStore) => s.providerModels;
const _sel_providerOrder = (s: import("../../stores/appStore.types").AppStore) => s.providerOrder;
const _sel_saveProvider = (s: import("../../stores/appStore.types").AppStore) => s.saveProvider;
const _sel_removeProvider = (s: import("../../stores/appStore.types").AppStore) => s.removeProvider;
const _sel_loadSettings = (s: import("../../stores/appStore.types").AppStore) => s.loadSettings;
const _sel_defaultModelId = (s: import("../../stores/appStore.types").AppStore) => s.defaultModelId;
const _sel_helperModelId = (s: import("../../stores/appStore.types").AppStore) => s.helperModelId;
const _sel_systemPrompt = (s: import("../../stores/appStore.types").AppStore) => s.systemPrompt;

type EditableProviderId = string | "new";
/** Draft state for a single provider model row inside the form. */
interface ProviderModelFormState {
  id: string;
  requestName: string;
  displayName: string;
  contextWindowKb: number;
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

/** Toast state for the settings page top-level save feedback. */
interface SettingsToastState {
  visible: boolean;
  tone: "success" | "error";
  message: string;
}

const TOAST_AUTO_DISMISS_MS = 2000;
/** Create a new model draft with a stable system-owned model profile ID. */
function createDraftModel(
  requestName = "",
  displayName = "",
  contextWindowKb = 64
): ProviderModelFormState {
  return {
    id: createModelProfileId(),
    requestName,
    displayName,
    contextWindowKb,
  };
}
const CONTEXT_WINDOW_MIN_KB = 1;
const CONTEXT_WINDOW_MAX_KB = 2048;


function getProviderTypeLabel(
  t: ReturnType<typeof useTranslation>["t"],
  type: ProviderType
): string {
  switch (type) {
    case "OPENAI_COMPATIBLE":
      return t("settings.providerTypeOpenAI");
    case "DEEPSEEK":
      return t("settings.providerTypeDeepSeek");
    case "OPENROUTER":
      return t("settings.providerTypeOpenRouter");
    case "GROQ":
      return t("settings.providerTypeGroq");
    case "OLLAMA":
      return t("settings.providerTypeOllama");
  }
}

/** Normalize the editable context-window value before comparing or saving. */
function normalizeContextWindowKb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 64;
  }
  return Math.max(
    CONTEXT_WINDOW_MIN_KB,
    Math.min(CONTEXT_WINDOW_MAX_KB, Math.round(value))
  );
}

/** Parse a text input so focused rows cannot be changed by mouse-wheel steps. */
function parseContextWindowKbInput(value: string): number | null {
  const normalized = value.trim().replace(/[kK]\b/g, "");
  if (normalized.length === 0) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return normalizeContextWindowKb(parsed);
}
/** Return sensible provider presets so new forms start from usable defaults. */
function getProviderPreset(type: ProviderType): Pick<
  ProviderFormState,
  "type" | "name" | "baseUrl" | "defaultModelId" | "enabled" | "models"
> {
  const presetByType: Record<ProviderType, { name: string; baseUrl: string; models: ProviderModelFormState[] }> = {
    OPENAI_COMPATIBLE: {
      name: "OpenAI Compatible",
      baseUrl: "https://api.openai.com/v1",
      models: [createDraftModel("gpt-4.1-mini", "GPT-4.1 Mini", 128)],
    },
    DEEPSEEK: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      models: [
        createDraftModel("deepseek-chat", "DeepSeek Chat", 64),
        createDraftModel("deepseek-reasoner", "DeepSeek Reasoner", 64),
      ],
    },
    OPENROUTER: {
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      models: [createDraftModel("openai/gpt-4.1-mini", "GPT-4.1 Mini", 128)],
    },
    GROQ: {
      name: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      models: [createDraftModel("llama-3.3-70b-versatile", "Llama 3.3 70B Versatile", 128)],
    },
    OLLAMA: {
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [createDraftModel("llama3.1", "Llama 3.1", 32)],
    },
  };
  const preset = presetByType[type];
  const defaultModel = preset.models[0];
  return {
    type,
    name: preset.name,
    baseUrl: preset.baseUrl,
    defaultModelId: defaultModel?.id ?? "",
    enabled: true,
    models: preset.models,
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
      contextWindowKb: model.contextWindowKb,
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
      contextWindowKb: model.contextWindowKb,
    }));
  const currentModels = form.models.map((model) => ({
    id: model.id,
    requestName: model.requestName.trim(),
    displayName: model.displayName.trim(),
    contextWindowKb: normalizeContextWindowKb(model.contextWindowKb),
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

/** Available tabs within the settings page. */
type SettingsTab = "providers" | "app";

/** Render the provider settings workspace with multi-model configuration support. */
export function ProviderSettingsScreen({
  onClose,
}: ProviderSettingsScreenProps) {
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>("providers");
  const providersById = useAppStore(_sel_providers);
  const providerModelsById = useAppStore(_sel_providerModels);
  const providerOrder = useAppStore(_sel_providerOrder);
  const saveProvider = useAppStore(_sel_saveProvider);
  const removeProvider = useAppStore(_sel_removeProvider);
  const loadSettings = useAppStore(_sel_loadSettings);
  const appDefaultModelId = useAppStore(_sel_defaultModelId);
  const appHelperModelId = useAppStore(_sel_helperModelId);
  const appSystemPrompt = useAppStore(_sel_systemPrompt);
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SettingsFeedbackState | null>(null);

  // Dropdown state for provider type
  const [providerTypeDropdownOpen, setProviderTypeDropdownOpen] = useState(false);
  const providerTypeDropdownRef = useRef<HTMLDivElement>(null);

  const providerTypeOptions: { value: ProviderType; label: string }[] = [
    { value: "OPENAI_COMPATIBLE", label: t("settings.providerTypeOpenAI") },
    { value: "DEEPSEEK", label: t("settings.providerTypeDeepSeek") },
    { value: "OPENROUTER", label: t("settings.providerTypeOpenRouter") },
    { value: "GROQ", label: t("settings.providerTypeGroq") },
    { value: "OLLAMA", label: t("settings.providerTypeOllama") },
  ];

  // External click handler to close provider type dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (providerTypeDropdownOpen && providerTypeDropdownRef.current && !providerTypeDropdownRef.current.contains(event.target as Node)) {
        setProviderTypeDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [providerTypeDropdownOpen]);
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
  /** Fetch available models from a running Ollama instance and add them to the form. */
  async function handleFetchOllamaModels(): Promise<void> {
    setIsFetchingModels(true);
    try {
      const models = await fetchOllamaModels(form.baseUrl);
      if (models.length === 0) {
        setFeedback({ tone: "info", message: t("settings.noModelsFound") });
        return;
      }
      // Preserve stable row IDs when refreshing models for an existing provider.
      // Otherwise saving a fetched list with the same request names can hit DB
      // unique constraints because the backend treats unknown IDs as inserts.
      const existingByRequestName = new Map<string, ProviderModelFormState>();
      for (const existingModel of form.models) {
        const requestName = existingModel.requestName.trim();
        if (requestName.length > 0) {
          existingByRequestName.set(requestName, existingModel);
        }
      }
      const newModels = models.map((m: OllamaModelInfo) => {
        const existing = existingByRequestName.get(m.name);
        if (existing) {
          return {
            ...existing,
            requestName: m.name,
            displayName: existing.displayName.trim() || m.name.split(":")[0],
            contextWindowKb: normalizeContextWindowKb(existing.contextWindowKb),
          };
        }
        return {
          id: createModelProfileId(),
          requestName: m.name,
          displayName: m.name.split(":")[0],
          contextWindowKb: 64,
        };
      });
      setForm((current) => ({
        ...current,
        models: newModels,
        defaultModelId: newModels[0]?.id ?? "",
      }));
      setFeedback({ tone: "success", message: t("settings.modelsFetched", { count: newModels.length }) });
    } catch (err) {
      setFeedback({ tone: "error", message: String(err instanceof Error ? err.message : err) });
    } finally {
      setIsFetchingModels(false);
    }
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
        contextWindowKb: normalizeContextWindowKb(model.contextWindowKb),
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

  // --- Settings page toast ---
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toast, setToast] = useState<SettingsToastState>({
    visible: false,
    tone: "success",
    message: "",
  });

  const showToast = useCallback((message: string, tone: "success" | "error" = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ visible: true, tone, message });
    toastTimerRef.current = setTimeout(() => {
      setToast((prev) => ({ ...prev, visible: false }));
    }, TOAST_AUTO_DISMISS_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  return (
    <SettingsToastContext.Provider value={showToast}>
      <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden pb-4">
        {toast.visible && (
          <div
            className={`absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-xl px-5 py-2.5 text-sm font-medium shadow-lg ${
              toast.tone === "success"
                ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border border-red-200 bg-red-50 text-red-700"
            }`}
            style={{ animation: "settings-toast-in 0.25s ease-out" }}
          >
            <span className="mr-2">{toast.tone === "success" ? "\u2713" : "\u2717"}</span>
            {toast.message}
          </div>
        )}
        <section className="flex h-full min-w-0 flex-1 gap-4 overflow-auto bg-transparent">
          <aside className="app-panel flex min-w-0 shrink-0 flex-col rounded-shell bg-white/95 w-[330px]">
            <div className="border-b border-miro-border/10 px-5 py-5">
              <button
                type="button"
                onClick={onClose}
                className="app-secondary-button mb-4 justify-start gap-2 px-3 py-2 text-sm"
              >
                <IconChevronLeft size={14} />
                {t("settings.backToWorkspace")}
              </button>
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-miro-blue-light text-miro-blue shadow-ring mt-1">
                  {activeTab === "providers" ? <IconSettings size={18} /> : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                      <line x1="8" y1="21" x2="16" y2="21"></line>
                      <line x1="12" y1="17" x2="12" y2="21"></line>
                    </svg>
                  )}
                </span>
                <div className="min-w-0">
                  <h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-miro-text">
                    {activeTab === "providers" ? t("settings.title") : t("settings.appSettingsTitle")}
                  </h2>
                  <p className="text-xs text-miro-text-secondary" style={{ height: '40px', lineHeight: '20px' }}>
                    {activeTab === "providers" ? t("settings.subtitle") : t("settings.appSettingsSubtitle")}
                  </p>
                </div>
              </div>
            </div>

            {/* Tab navigation */}
            <div className="flex gap-1.5 px-5 py-3">
              <button
                type="button"
                onClick={() => setActiveTab("providers")}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  activeTab === "providers"
                    ? "bg-miro-blue-light text-miro-blue shadow-ring"
                    : "bg-miro-surface-low text-miro-text-secondary hover:bg-miro-surface"
                }`}
              >
                {t("settings.providerTab")}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("app")}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  activeTab === "app"
                    ? "bg-miro-blue-light text-miro-blue shadow-ring"
                    : "bg-miro-surface-low text-miro-text-secondary hover:bg-miro-surface"
                }`}
              >
                {t("settings.appTab")}
              </button>
            </div>

            {/* Category-specific list */}
            {activeTab === "providers" ? (
              <>
                <div className="grid grid-cols-3 gap-2 px-5 py-4">
                  <div className="min-w-0 rounded-panel bg-miro-surface-low px-3 py-3">
                    <p className="app-section-label mb-1">{t("settings.providerCount")}</p>
                    <p className="text-lg font-semibold text-miro-text">{orderedProviders.length}</p>
                  </div>
                  <div className="min-w-0 rounded-panel bg-miro-surface-low px-3 py-3">
                    <p className="app-section-label mb-1">{t("settings.enabled")}</p>
                    <p className="text-lg font-semibold text-miro-text">{enabledProviderCount}</p>
                  </div>
                  <div className="min-w-0 rounded-panel bg-miro-surface-low px-3 py-3">
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
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-miro-text">
                                {provider.name}
                              </div>
                              <div className="mt-1 text-xs text-miro-text-secondary">
                                {getProviderTypeLabel(t, provider.type)}
                              </div>
                            </div>
                            <span
                              className={`app-status-pill shrink-0 ${
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
                            <span className="inline-block max-w-full truncate align-bottom">
                              {providerDefaultModelName}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 overflow-y-auto px-4 pb-4">
                <div className="space-y-1.5 pt-2">
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-default-model")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.defaultModelTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">
                      {getModelDisplayName(appDefaultModelId, providerModelsById, t("shell.modelUnset"))}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-helper-model")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.helperModelTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">
                      {appHelperModelId
                        ? getModelDisplayName(appHelperModelId, providerModelsById, t("shell.modelUnset"))
                        : t("settings.helperModelNotConfigured")}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-system-prompt")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.systemPromptTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary line-clamp-2">
                      {appSystemPrompt || t("settings.systemPromptPlaceholder")}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-tool-settings")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.toolSettingsTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{t("settings.toolSettingsHelp")}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-security-policy")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.securityPolicyTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{t("settings.securityPolicyHelp")}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-builtin-tools")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.builtinToolsTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{t("settings.builtinToolsHelp")}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-mcp-servers")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.mcpServersTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{t("settings.mcpServersHelp")}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-skills")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.skillsTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{t("settings.skillsHelp")}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-language")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.languageTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{i18n.language}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-close-behavior")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.closeBehaviorTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{t("settings.closeBehaviorHelp")}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-shell-path")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.shellPathTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{t("settings.shellPathHelp")}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("app"); setTimeout(() => document.getElementById("section-shortcuts")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="w-full rounded-[16px] bg-white/84 px-3 py-3 text-left hover:bg-white"
                  >
                    <div className="text-xs font-semibold text-miro-text">{t("settings.shortcutsTitle")}</div>
                    <div className="mt-0.5 text-[11px] text-miro-text-secondary">{t("settings.shortcutsHelp", "查看和管理所有快捷键")}</div>
                  </button>
                </div>
              </div>
            )}
            <AboutSection />
      </aside>
      <div className="min-w-0 flex-1 overflow-auto">
        {activeTab === "app" ? (
          <AppSettingsView />
        ) : (
        <div className="w-full space-y-4 pt-2 pr-4">
          <section className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="min-w-0 rounded-panel bg-miro-surface-low px-4 py-4">
                  <p className="app-section-label mb-2">{t("settings.currentObject")}</p>
                  <p className="line-clamp-2 text-sm font-semibold text-miro-text">
                    {selectedProviderSummaryName}
                  </p>
                </div>
                <div className="min-w-0 rounded-panel bg-miro-surface-low px-4 py-4">
                  <p className="app-section-label mb-2">{t("settings.connectionState")}</p>
                  <p className="line-clamp-2 text-sm font-semibold text-miro-text">
                    {selectedConnectionState}
                  </p>
                </div>
              </div>
            </section>
            <section className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
              <div className="mb-6 flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                    {selectedProviderId === "new"
                      ? t("settings.createProviderTitle")
                      : t("settings.editProviderTitle")}
                  </h3>
                  <p className="text-sm leading-6 text-miro-text-secondary">
                    {t("settings.providerFormHelp")}
                  </p>
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-2 rounded-panel bg-miro-surface-low px-4 py-3 text-sm text-miro-text shadow-ring">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) => patchForm("enabled", event.target.checked)}
                    className="rounded border-miro-border text-miro-blue focus:ring-miro-blue/30"
                  />
                  <span>{t("settings.enabledProvider")}</span>
                </label>
              </div>
              <form className="space-y-5" onSubmit={(event) => void handleSaveProvider(event)}>
                <div className="grid gap-5 md:grid-cols-2">
                  <div className="space-y-2">
                    <span className="text-sm font-medium text-miro-text">
                      {t("settings.providerType")}
                    </span>
                    <div ref={providerTypeDropdownRef} className="relative">
                      <button
                        type="button"
                        onClick={() => setProviderTypeDropdownOpen((prev) => !prev)}
                        className="flex w-full items-center gap-2 rounded-xl border border-miro-border/40 bg-white/88 px-3 py-2 text-left text-sm text-miro-text shadow-ring transition-colors hover:bg-white/95 focus:outline-none focus:ring-0"
                      >
                        <span className="flex-1">
                          {getProviderTypeLabel(t, form.type as ProviderType)}
                        </span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-miro-text-secondary">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      {providerTypeDropdownOpen && (
                        <div
                          role="listbox"
                          className="absolute left-0 top-full mt-1.5 z-50 w-full rounded-xl border border-miro-border/40 bg-white/95 p-1.5 shadow-ring"
                        >
                          {providerTypeOptions.map((option) => (
                            <button
                              key={option.value}
                              role="option"
                              type="button"
                              aria-selected={form.type === option.value}
                              onClick={() => {
                                applyProviderType(option.value);
                                setProviderTypeDropdownOpen(false);
                              }}
                              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                                form.type === option.value
                                  ? "bg-miro-blue-light/65 text-miro-blue"
                                  : "text-miro-text hover:bg-miro-surface-high"
                              }`}
                            >
                              <span className="flex-1">{option.label}</span>
                              {form.type === option.value && (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto">
                                  <path d="M20 6L9 17l-5-5" />
                                </svg>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
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
                {form.type !== "OLLAMA" && (
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
                )}
                {form.type === "OLLAMA" && (
                <button
                  type="button"
                  onClick={handleFetchOllamaModels}
                  disabled={isFetchingModels}
                  className="app-secondary-button px-4 py-2 text-sm"
                >
                  {isFetchingModels ? t("settings.fetchingModels") : t("settings.fetchModels")}
                </button>
                )}
                <section className="min-w-0 rounded-[28px] border border-miro-border/70 bg-miro-bg/70 p-5">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
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
                      className="app-secondary-button shrink-0 whitespace-nowrap px-4 py-2 text-sm"
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
                          className="min-w-0 rounded-[24px] border border-miro-border/70 bg-white/90 p-4 shadow-[0_8px_24px_rgba(28,28,30,0.04)]"
                        >
                          <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                            <label className="space-y-2">
                              <span className="text-sm font-medium text-miro-text">
                                {t("settings.modelContextWindow")}
                              </span>
                              <input
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={String(model.contextWindowKb)}
                                onChange={(event) => {
                                  const nextValue = parseContextWindowKbInput(event.target.value);
                                  if (nextValue !== null) {
                                    patchModel(model.id, { contextWindowKb: nextValue });
                                  }
                                }}
                                placeholder={t("settings.modelContextWindowPlaceholder")}
                                className="app-input"
                                required
                              />
                              <span className="block text-xs leading-5 text-miro-text-secondary">
                                {t("settings.modelContextWindowHelp")}
                              </span>
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
        )}
      </div>
    </section>
      </div>
    </SettingsToastContext.Provider>
  );
}


function AboutSection() {
  const { t } = useTranslation();
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isUpdaterSupported()) return;
    checkForUpdate()
      .then((info) => {
        if (!cancelled && info) setUpdateInfo(info);
      })
      .catch(() => {});
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
