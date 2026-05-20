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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { SUPPORTED_LOCALES, type SupportedLocale } from "../../i18n";
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
const _sel_providers = (s: import("../../stores/appStore.types").AppStore) => s.providers;
const _sel_providerModels = (s: import("../../stores/appStore.types").AppStore) => s.providerModels;
const _sel_providerOrder = (s: import("../../stores/appStore.types").AppStore) => s.providerOrder;
const _sel_defaultModelId = (s: import("../../stores/appStore.types").AppStore) => s.defaultModelId;
const _sel_helperModelId = (s: import("../../stores/appStore.types").AppStore) => s.helperModelId;
const _sel_systemPrompt = (s: import("../../stores/appStore.types").AppStore) => s.systemPrompt;
const _sel_saveProvider = (s: import("../../stores/appStore.types").AppStore) => s.saveProvider;
const _sel_removeProvider = (s: import("../../stores/appStore.types").AppStore) => s.removeProvider;
const _sel_setDefaultModel = (s: import("../../stores/appStore.types").AppStore) => s.setDefaultModel;
const _sel_setHelperModel = (s: import("../../stores/appStore.types").AppStore) => s.setHelperModel;
const _sel_setSystemPrompt = (s: import("../../stores/appStore.types").AppStore) => s.setSystemPrompt;
const _sel_loadSettings = (s: import("../../stores/appStore.types").AppStore) => s.loadSettings;

const SHORTCUT_ITEMS = [
  { key: "newChat", labelKey: "settings.shortcutNewChat", display: "⌘ N" },
  { key: "send", labelKey: "settings.shortcutSend", display: "⌘ Enter" },
  { key: "stop", labelKey: "settings.shortcutStop", display: "Esc" },
  { key: "settings", labelKey: "settings.shortcutSettings", display: "⌘ ," },
  { key: "sidebar", labelKey: "settings.shortcutSidebar", display: "⌘ B" },
  { key: "panel", labelKey: "settings.shortcutPanel", display: "⌘ ." },
  { key: "search", labelKey: "settings.shortcutSearch", display: "⌘ K" },
] as const;
function hasUserAgentData(
  nav: Navigator
): nav is Navigator & { userAgentData: { platform?: string } } {
  return "userAgentData" in nav;
}

function getNavigatorPlatform(): string {
  if (typeof navigator === "undefined") return "";
  if (hasUserAgentData(navigator)) {
    return navigator.userAgentData.platform ?? navigator.platform ?? "";
  }
  return navigator.platform ?? "";
}

function getShortcutModifierLabel(): string {
  const platform = getNavigatorPlatform();
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘" : "Ctrl";
}
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

const BUILTIN_TOOL_I18N_KEYS: Record<string, { nameKey: string; descriptionKey: string }> = {
  calculator: {
    nameKey: "settings.builtinToolCalculatorName",
    descriptionKey: "settings.builtinToolCalculatorDescription",
  },
  file_read: {
    nameKey: "settings.builtinToolFileReadName",
    descriptionKey: "settings.builtinToolFileReadDescription",
  },
  file_write: {
    nameKey: "settings.builtinToolFileWriteName",
    descriptionKey: "settings.builtinToolFileWriteDescription",
  },
  file_list: {
    nameKey: "settings.builtinToolFileListName",
    descriptionKey: "settings.builtinToolFileListDescription",
  },
  grep: {
    nameKey: "settings.builtinToolGrepName",
    descriptionKey: "settings.builtinToolGrepDescription",
  },
  todo_read: {
    nameKey: "settings.builtinToolTodoReadName",
    descriptionKey: "settings.builtinToolTodoReadDescription",
  },
  todo_write: {
    nameKey: "settings.builtinToolTodoWriteName",
    descriptionKey: "settings.builtinToolTodoWriteDescription",
  },
  mkdir: {
    nameKey: "settings.builtinToolMkdirName",
    descriptionKey: "settings.builtinToolMkdirDescription",
  },
  rm: {
    nameKey: "settings.builtinToolRmName",
    descriptionKey: "settings.builtinToolRmDescription",
  },
  web_search: {
    nameKey: "settings.builtinToolWebSearchName",
    descriptionKey: "settings.builtinToolWebSearchDescription",
  },
};

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
/** Render the provider settings workspace with multi-model configuration support. */
export function ProviderSettingsScreen({
  onClose,
}: ProviderSettingsScreenProps) {
  const { t, i18n } = useTranslation();
  const shortcutModifierLabel = useMemo(() => getShortcutModifierLabel(), []);
  const shortcutItems = useMemo(
    () =>
      SHORTCUT_ITEMS.map((item) => ({
        ...item,
        display: item.display.replace("⌘", shortcutModifierLabel),
      })),
    [shortcutModifierLabel]
  );
  const providersById = useAppStore(_sel_providers);
  const providerModelsById = useAppStore(_sel_providerModels);
  const providerOrder = useAppStore(_sel_providerOrder);
  const appDefaultModelId = useAppStore(_sel_defaultModelId);
  const appHelperModelId = useAppStore(_sel_helperModelId);
  const appSystemPrompt = useAppStore(_sel_systemPrompt);
  const saveProvider = useAppStore(_sel_saveProvider);
  const removeProvider = useAppStore(_sel_removeProvider);
  const setDefaultModel = useAppStore(_sel_setDefaultModel);
  const setHelperModel = useAppStore(_sel_setHelperModel);
  const setSystemPrompt = useAppStore(_sel_setSystemPrompt);
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
  const [isFetchingModels, setIsFetchingModels] = useState(false);
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

  const [helperModelDraft, setHelperModelDraft] = useState(
    appHelperModelId ?? ""
  );
  const [systemPromptDraft, setSystemPromptDraft] = useState(appSystemPrompt);
  const systemPromptCharCount = Array.from(systemPromptDraft).length;

  useEffect(() => {
    setHelperModelDraft(appHelperModelId ?? "");
  }, [appHelperModelId]);
  useEffect(() => {
    setSystemPromptDraft(appSystemPrompt);
  }, [appSystemPrompt]);

  async function handleSaveHelperModel(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      await setHelperModel(helperModelDraft.trim() || null);
      setFeedback({
        tone: "success",
        message: t("settings.helperModelSaved"),
      });
    } catch (modelError) {
      setError(
        modelError instanceof Error
          ? modelError.message
          : t("settings.helperModelSaveFailed")
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
      setFeedback({
        tone: "success",
        message: t("settings.systemPromptSaved"),
      });
    } catch (promptError) {
      setError(
        promptError instanceof Error
          ? promptError.message
          : t("settings.systemPromptSaveFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Reset by saving an empty prompt; backend normalizes it to the release default. */
  async function handleResetSystemPrompt(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      const savedPrompt = await setSystemPrompt("");
      setSystemPromptDraft(savedPrompt);
      setFeedback({
        tone: "success",
        message: t("settings.systemPromptResetDone"),
      });
    } catch (promptError) {
      setError(
        promptError instanceof Error
          ? promptError.message
          : t("settings.systemPromptSaveFailed")
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
    <section className="flex h-full min-w-0 flex-1 flex-col gap-4 overflow-hidden bg-transparent xl:flex-row">
      <aside className="app-panel flex min-w-0 w-full shrink-0 flex-col rounded-shell bg-white/95 xl:w-[330px]">
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
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-miro-blue-light text-miro-blue shadow-ring">
              <IconSettings size={18} />
            </span>
            <div className="min-w-0">
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
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto grid min-w-0 w-full max-w-6xl gap-4 min-[1800px]:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            <section className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="min-w-0 rounded-panel bg-miro-surface-low px-4 py-4">
                  <p className="app-section-label mb-2">{t("settings.defaultModelTitle")}</p>
                  <p className="line-clamp-2 text-sm font-semibold text-miro-text">
                    {getModelDisplayName(
                      appDefaultModelId,
                      providerModelsById,
                      t("shell.modelUnset")
                    )}
                  </p>
                </div>
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
                  <select
                    value={defaultModelDraft}
                    onChange={(event) => setDefaultModelDraft(event.target.value)}
                    className="app-input min-w-0 flex-1"
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
            <section className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
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
                  <select
                    value={helperModelDraft}
                    onChange={(event) => setHelperModelDraft(event.target.value)}
                    className="app-input min-w-0 flex-1"
                  >
                    <option value="">{t("settings.helperModelPlaceholder")}</option>
                    {availableModelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.providerName} / {option.displayName}
                      </option>
                    ))}
                  </select>
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
            <section className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
              <div className="mb-4 flex min-w-0 flex-col gap-3 min-[1800px]:flex-row min-[1800px]:items-start min-[1800px]:justify-between">
                <div className="min-w-0">
                  <h3 className="font-display text-xl font-semibold tracking-[-0.03em] text-miro-text">
                    {t("settings.systemPromptTitle")}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-miro-text-secondary">
                    {t("settings.systemPromptHelp")}
                  </p>
                </div>
                <p className="shrink-0 rounded-full bg-miro-surface-low px-3 py-1 text-xs font-medium text-miro-text-secondary">
                  {t("settings.systemPromptCharCount", {
                    count: systemPromptCharCount,
                  })}
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
            <section className="app-panel min-w-0 rounded-shell bg-white/95 p-6">
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
                      <option value="DEEPSEEK">
                        {t("settings.providerTypeDeepSeek")}
                      </option>
                      <option value="OPENROUTER">
                        {t("settings.providerTypeOpenRouter")}
                      </option>
                      <option value="GROQ">
                        {t("settings.providerTypeGroq")}
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
          <aside className="min-w-0 space-y-4">
            <section className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
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
                  <span className="font-semibold text-miro-text">
                    {getProviderTypeLabel(t, form.type)}
                  </span>
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
            <section className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
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
            <section className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
              <p className="app-section-label mb-3">{t("settings.configurationAdvice")}</p>
              <div className="space-y-3 text-sm leading-6 text-miro-text-secondary">
                <p>{t("settings.adviceModels")}</p>
                <p>{t("settings.adviceDefaultModel")}</p>
                <p>{t("settings.adviceConnection")}</p>
              </div>
            </section>
            <section className="app-panel rounded-shell bg-white/95 p-5">
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
            <ToolSettingsSection />
            <BuiltinToolsSection />
            <McpServersSection />
            <SkillsSection />
          </aside>
        </div>
      </div>
    </section>
  );
}

/** Tool calling settings section: max iterations, consecutive failures, approval timeout. */
function ToolSettingsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<tauriCmd.ToolSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    tauriCmd.getToolSettings().then(setSettings).catch(() => {});
  }, []);

  if (!settings) return null;

  async function handleSave(patch: Partial<tauriCmd.ToolSettingsDto>) {
    setSaving(true);
    try {
      const updated = await tauriCmd.updateToolSettings(patch);
      setSettings(updated);
    } catch (err) {
      console.error("[tool-settings] failed to save", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
      <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
        {t("settings.toolSettingsTitle")}
      </h3>
      <p className="mt-1 text-xs text-miro-text-secondary">
        {t("settings.toolSettingsHelp")}
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-miro-text">
            {t("settings.maxIterations")}
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <input
              type="number"
              min={1}
              max={50}
              value={settings.max_iterations}
              className="w-24 rounded-md border border-miro-border/30 bg-white px-3 py-1.5 text-sm text-miro-text focus:border-miro-blue focus:outline-none"
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 50) {
                  setSettings({ ...settings, max_iterations: v });
                }
              }}
              onBlur={() => void handleSave({ max_iterations: settings.max_iterations })}
            />
            <span className="min-w-0 flex-1 text-xs text-miro-text-secondary">
              {t("settings.maxIterationsHelp")}
            </span>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-miro-text">
            {t("settings.maxConsecutiveFailures")}
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <input
              type="number"
              min={1}
              max={20}
              value={settings.max_consecutive_failures}
              className="w-24 rounded-md border border-miro-border/30 bg-white px-3 py-1.5 text-sm text-miro-text focus:border-miro-blue focus:outline-none"
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 20) {
                  setSettings({ ...settings, max_consecutive_failures: v });
                }
              }}
              onBlur={() => void handleSave({ max_consecutive_failures: settings.max_consecutive_failures })}
            />
            <span className="min-w-0 flex-1 text-xs text-miro-text-secondary">
              {t("settings.maxConsecutiveFailuresHelp")}
            </span>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-miro-text">
            {t("settings.approvalTimeout")}
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <input
              type="number"
              min={10}
              max={300}
              value={settings.approval_timeout_secs}
              className="w-24 rounded-md border border-miro-border/30 bg-white px-3 py-1.5 text-sm text-miro-text focus:border-miro-blue focus:outline-none"
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 10 && v <= 300) {
                  setSettings({ ...settings, approval_timeout_secs: v });
                }
              }}
              onBlur={() => void handleSave({ approval_timeout_secs: settings.approval_timeout_secs })}
            />
            <span className="min-w-0 flex-1 text-xs text-miro-text-secondary">
              {t("settings.approvalTimeoutHelp")}
            </span>
          </div>
        </div>
        {saving && (
          <p className="text-xs text-miro-text-secondary">{t("common.saving")}</p>
        )}
      </div>
    </section>
  );
}

function BuiltinToolsSection() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<tauriCmd.ToolStateDto[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    tauriCmd.getBuiltinToolStates()
      .then(setTools)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  async function handleToggle(name: string, enabled: boolean) {
    try {
      await tauriCmd.setBuiltinToolEnabled(name, enabled);
      setTools((prev) =>
        prev.map((t) => (t.name === name ? { ...t, enabled } : t))
      );
    } catch (err) {
      console.error("[builtin-tools] failed to toggle", err);
    }
  }

  if (!loaded) return null;
  if (tools.length === 0) return null;

  return (
    <section className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
      <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
        {t("settings.builtinToolsTitle")}
      </h3>
      <p className="mt-1 text-xs text-miro-text-secondary">
        {t("settings.builtinToolsHelp")}
      </p>
      <div className="mt-4 space-y-2">
        {tools.map((tool) => {
          const label = BUILTIN_TOOL_I18N_KEYS[tool.name];
          const displayName = label
            ? t(label.nameKey, { defaultValue: tool.name })
            : tool.name;
          const displayDescription = label
            ? t(label.descriptionKey, { defaultValue: tool.description })
            : tool.description;
          return (
            <div
              key={tool.name}
              className="flex min-w-0 items-center justify-between rounded-lg border border-miro-border/20 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-miro-text">{displayName}</p>
                <p className="truncate text-xs text-miro-text-secondary">
                  {displayDescription}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={tool.enabled}
                onClick={() => void handleToggle(tool.name, !tool.enabled)}
                className={`relative ml-3 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                  tool.enabled ? "bg-miro-blue" : "bg-miro-border/40"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${
                    tool.enabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function McpServersSection() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<tauriCmd.McpServerStateDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingMcpServerName, setEditingMcpServerName] = useState<string | null>(null);
  const [jsonInput, setJsonInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [pendingServerNames, setPendingServerNames] = useState<Set<string>>(
    () => new Set()
  );

  function setServerPending(name: string, pending: boolean) {
    setPendingServerNames((prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  }

  async function loadServers() {
    try {
      const nextServers = await tauriCmd.listMcpServers();
      setServers(nextServers);
      setLoadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
      console.error("[mcp] failed to load servers", err);
    } finally {
      setLoaded(true);
    }
  }

  async function handleToggleEnabled(name: string, enabled: boolean) {
    setServerPending(name, true);
    setServerErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      await tauriCmd.setMcpServerEnabled(name, enabled);
      await loadServers();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setServerErrors((prev) => ({ ...prev, [name]: message }));
      await loadServers();
    } finally {
      setServerPending(name, false);
    }
  }

  useEffect(() => {
    void loadServers();
  }, []);

  function normalizeMcpTransport(value: unknown): "stdio" | "streamable_http" | "sse" {
    const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!raw || raw === "stdio") return "stdio";
    if (raw === "http" || raw === "streamable-http" || raw === "streamable_http") {
      return "streamable_http";
    }
    if (raw === "sse" || raw === "legacy-sse" || raw === "legacy_sse") {
      return "sse";
    }
    return "stdio";
  }

  function readStringMap(value: unknown): Record<string, string> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        String(item),
      ])
    );
  }

  function readMcpServerConfig(
    name: string,
    value: unknown
  ): { ok: true; config: tauriCmd.McpServerConfig } | { ok: false; error: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: t("settings.mcpErrorServerMustBeObject", { name }) };
    }

    const serverObj = value as Record<string, unknown>;
    const hasCommand = typeof serverObj.command === "string" && serverObj.command.trim().length > 0;
    const hasUrl = typeof serverObj.url === "string" && serverObj.url.trim().length > 0;
    const transport = normalizeMcpTransport(
      serverObj.transport ?? (hasUrl && !hasCommand ? "streamable_http" : "stdio")
    );

    if (transport === "stdio" && !hasCommand) {
      return { ok: false, error: t("settings.mcpErrorCommandRequired", { name }) };
    }
    if ((transport === "streamable_http" || transport === "sse") && !hasUrl) {
      return { ok: false, error: t("settings.mcpErrorUrlRequired", { name }) };
    }

    return {
      ok: true,
      config: {
        transport,
        command: hasCommand ? String(serverObj.command).trim() : "",
        args: Array.isArray(serverObj.args) ? serverObj.args.map(String) : [],
        env: readStringMap(serverObj.env),
        url: hasUrl ? String(serverObj.url).trim() : "",
        headers: readStringMap(serverObj.headers),
      },
    };
  }

  /** Parse MCP JSON from common client shapes and transport-aware HTTP configs. */
  function parseAndValidate(json: string):
    | { ok: true; servers: Array<{ name: string; config: tauriCmd.McpServerConfig }> }
    | { ok: false; error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: t("settings.mcpErrorJsonParse", { message: (e as SyntaxError).message }) };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: t("settings.mcpErrorJsonMustBeObject") };
    }
    const obj = parsed as Record<string, unknown>;

    const wrappedServers = obj.mcpServers ?? obj.servers;
    if (typeof wrappedServers === "object" && wrappedServers !== null && !Array.isArray(wrappedServers)) {
      const serversMap = wrappedServers as Record<string, unknown>;
      const results: Array<{ name: string; config: tauriCmd.McpServerConfig }> = [];
      for (const [name, value] of Object.entries(serversMap)) {
        const configResult = readMcpServerConfig(name, value);
        if (!configResult.ok) return configResult;
        results.push({
          name: name.trim(),
          config: configResult.config,
        });
      }
      if (results.length === 0) {
        return { ok: false, error: t("settings.mcpErrorServerMapEmpty") };
      }
      return { ok: true, servers: results };
    }

    if (typeof obj.name === "string" && obj.name.trim()) {
      const configResult = readMcpServerConfig(obj.name.trim(), obj);
      if (!configResult.ok) return configResult;
      return { ok: true, servers: [{ name: obj.name.trim(), config: configResult.config }] };
    }

    const entries = Object.entries(obj);
    const hasServerLikeEntries = entries.some(
      ([, v]) =>
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        ("command" in (v as Record<string, unknown>) || "url" in (v as Record<string, unknown>))
    );
    if (hasServerLikeEntries) {
      const results: Array<{ name: string; config: tauriCmd.McpServerConfig }> = [];
      for (const [name, value] of entries) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const configResult = readMcpServerConfig(name, value);
        if (!configResult.ok) return configResult;
        results.push({
          name: name.trim(),
          config: configResult.config,
        });
      }
      if (results.length === 0) {
        return { ok: false, error: t("settings.mcpErrorNoValidServers") };
      }
      return { ok: true, servers: results };
    }

    return { ok: false, error: t("settings.mcpErrorExpectedShape") };
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);

    const result = parseAndValidate(jsonInput.trim());
    if (!result.ok) {
      setAddError(result.error);
      return;
    }
    if (editingMcpServerName) {
      const [target] = result.servers;
      if (result.servers.length !== 1 || target?.name !== editingMcpServerName) {
        setAddError(t("settings.mcpEditNameLocked"));
        return;
      }
    }

    setAdding(true);
    try {
      // Add servers one by one; stop on first failure
      for (const { name, config } of result.servers) {
        await tauriCmd.addMcpServer({ name, config });
      }
      setJsonInput("");
      setEditingMcpServerName(null);
      setShowForm(false);
      await loadServers();
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  function handleEditMcpServer(server: tauriCmd.McpServerStateDto) {
    setEditingMcpServerName(server.name);
    setAddError(null);
    setJsonInput(
      JSON.stringify(
        {
          name: server.name,
          transport: server.transport,
          command: server.command || undefined,
          args: server.args,
          env: server.env,
          url: server.url || undefined,
          headers: server.headers,
        },
        null,
        2
      )
    );
    setShowForm(true);
  }

  async function handleRemove(name: string) {
    setServerPending(name, true);
    setServerErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      await tauriCmd.removeMcpServer(name);
      await loadServers();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setServerErrors((prev) => ({ ...prev, [name]: message }));
      console.error("[mcp] failed to remove server", err);
    } finally {
      setServerPending(name, false);
    }
  }

  if (!loaded) return null;

  const exampleJson = JSON.stringify(
    {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
        },
        exa: {
          url: "https://mcp.exa.ai/mcp",
          headers: {
            "x-api-key": "YOUR_KEY",
          },
        },
      },
    },
    null,
    2
  );

  function getStatusPillClassName(status: string): string {
    if (status === "running") {
      return "bg-emerald-50 text-emerald-700";
    }
    if (status === "disabled") {
      return "bg-miro-bg text-miro-text-secondary";
    }
    if (status === "starting") {
      return "bg-amber-50 text-amber-700";
    }
    return "bg-red-50 text-red-600";
  }

  function getMcpStatusLabel(status: string): string {
    if (status === "running") return t("settings.mcpStatusRunning");
    if (status === "disabled") return t("settings.mcpStatusDisabled");
    if (status === "starting") return t("settings.mcpStatusStarting");
    if (status === "stopped") return t("settings.mcpStatusStopped");
    if (status.startsWith("error:")) {
      return t("settings.mcpStatusError", {
        message: status.replace(/^error:\s*/, ""),
      });
    }
    return status;
  }

  return (
    <section className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
            {t("settings.mcpServersTitle")}
          </h3>
          <p className="mt-1 text-xs text-miro-text-secondary">
            {t("settings.mcpServersHelp")}
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => {
              setEditingMcpServerName(null);
              setJsonInput("");
              setAddError(null);
              setShowForm(true);
            }}
            className="app-secondary-button rounded-lg px-3 py-1.5 text-xs"
          >
            + {t("settings.mcpAddServer")}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={(e) => void handleAdd(e)} className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-miro-text">
              {t("settings.mcpJsonConfig")} *
            </label>
            <textarea
              className="app-input mt-1 w-full font-mono text-xs"
              rows={8}
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              placeholder={exampleJson}
              spellCheck={false}
            />
          </div>
          {addError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
              {addError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={adding}
              className="app-primary-button rounded-lg px-4 py-1.5 text-xs"
            >
              {adding
                ? t("settings.mcpValidating")
                : editingMcpServerName
                  ? t("settings.mcpSaveServer")
                  : t("settings.mcpAddConfirm")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setAddError(null);
                setEditingMcpServerName(null);
              }}
              className="app-secondary-button rounded-lg px-4 py-1.5 text-xs"
            >
              {t("settings.mcpCancel")}
            </button>
          </div>
        </form>
      )}

      {loadError && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {loadError}
        </p>
      )}

      {servers.length > 0 && (
        <div className="mt-4 space-y-2">
          {servers.map((server) => {
            const isPending = pendingServerNames.has(server.name);
            const serverError = serverErrors[server.name];
            const pendingLabel = server.enabled
              ? t("settings.mcpDisabling")
              : t("settings.mcpValidating");
            const transportLabel = server.transport === "streamable_http" ? "HTTP" : server.transport.toUpperCase();
            const connectionLabel = server.transport === "streamable_http" || server.transport === "sse"
              ? server.url
              : `${server.command} ${server.args.join(" ")}`.trim();
            return (
            <div
              key={server.name}
              className="min-w-0 rounded-lg border border-miro-border/20 px-3 py-2"
            >
              <div className="flex min-w-0 items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 max-w-full truncate text-sm font-medium text-miro-text">
                      {server.name}
                    </p>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        getStatusPillClassName(server.status)
                      }`}
                    >
                      {isPending ? pendingLabel : getMcpStatusLabel(server.status)}
                    </span>
                    <span className="rounded-full bg-miro-bg px-2 py-0.5 text-[10px] font-medium text-miro-text-secondary">
                      {transportLabel}
                    </span>
                    {server.tools.length > 0 && (
                      <span className="text-[10px] text-miro-text-secondary">
                        {t("settings.mcpToolsCount", { count: server.tools.length })}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-miro-text-secondary">
                    {connectionLabel}
                  </p>
                  {server.tools.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {server.tools.map((tool) => (
                        <span
                          key={tool.name}
                          className="rounded bg-miro-bg px-1.5 py-0.5 text-[10px] text-miro-text-secondary"
                          title={tool.description}
                        >
                          {tool.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="ml-2 flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => handleEditMcpServer(server)}
                    className={`rounded-md px-2 py-1 text-xs font-medium text-miro-text-secondary transition-colors hover:bg-miro-bg hover:text-miro-text ${
                      isPending ? "cursor-wait opacity-50" : ""
                    }`}
                  >
                    {t("settings.mcpEditServer")}
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={server.enabled}
                    aria-busy={isPending || undefined}
                    disabled={isPending}
                    onClick={() => void handleToggleEnabled(server.name, !server.enabled)}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      server.enabled ? "bg-miro-blue" : "bg-miro-border/40"
                    } ${
                      isPending ? "cursor-wait opacity-60" : "cursor-pointer"
                    }`}
                    title={server.enabled ? t("settings.mcpDisableServer") : t("settings.mcpEnableServer")}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                        server.enabled ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void handleRemove(server.name)}
                    className={`rounded-md p-1.5 text-miro-text-secondary/50 transition-colors hover:bg-red-50 hover:text-red-600 ${
                      isPending ? "cursor-wait opacity-50" : ""
                    }`}
                    title={t("settings.mcpRemoveServer")}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
              {serverError && (
                <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                  {serverError}
                </p>
              )}
            </div>
            );
          })}
        </div>
      )}

      {servers.length === 0 && !showForm && (
        <p className="mt-3 text-xs text-miro-text-secondary/60">
          {t("settings.mcpNoServers")}
        </p>
      )}
    </section>
  );
}

function SkillsSection() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<tauriCmd.SkillDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingSkill, setEditingSkill] = useState<tauriCmd.SkillDto | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formTriggerType, setFormTriggerType] = useState("SLASH");
  const [formTemplate, setFormTemplate] = useState("");
  const [formVariables, setFormVariables] = useState("");
  const [formBoundTools, setFormBoundTools] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [skillsDir, setSkillsDir] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  function loadSkills() {
    tauriCmd
      .listSkills()
      .then(setSkills)
      .catch(() => {})
      .finally(() => setLoaded(true));
    tauriCmd.getSkillsDirectory().then(setSkillsDir).catch(() => {});
  }

  useEffect(() => {
    loadSkills();
  }, []);

  function resetForm() {
    setFormName("");
    setFormDisplayName("");
    setFormDescription("");
    setFormTriggerType("SLASH");
    setFormTemplate("");
    setFormVariables("");
    setFormBoundTools("");
    setFormError(null);
    setImportError(null);
    setEditingSkill(null);
    setShowForm(false);
  }

  function startEdit(skill: tauriCmd.SkillDto) {
    setEditingSkill(skill);
    setFormName(skill.name);
    setFormDisplayName(skill.displayName);
    setFormDescription(skill.description);
    setFormTriggerType(skill.triggerType);
    setFormTemplate(skill.promptTemplate);
    setFormVariables(skill.variablesJson || "[]");
    setFormBoundTools(skill.boundToolsJson || "[]");
    setFormError(null);
    setShowForm(true);
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
  }

  async function handleImportSkill() {
    setImporting(true);
    setImportError(null);
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) {
        await tauriCmd.importSkill(selected);
        setImportError(null);
        loadSkills();
      }
    } catch (err) {
      console.warn("Import skill failed:", err);
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const trimmedName = formName.trim();
    if (!trimmedName) {
      setFormError(t("settings.skillNameRequired"));
      return;
    }
    if (!formTemplate.trim()) {
      setFormError(t("settings.skillTemplateRequired"));
      return;
    }

    // Validate JSON fields
    if (formVariables.trim()) {
      try {
        JSON.parse(formVariables);
      } catch {
        setFormError(t("settings.skillVariablesJsonParseError"));
        return;
      }
    }
    if (formBoundTools.trim()) {
      try {
        JSON.parse(formBoundTools);
      } catch {
        setFormError(t("settings.skillBoundToolsJsonParseError"));
        return;
      }
    }

    setSaving(true);
    try {
      const input: tauriCmd.CreateSkillInput = {
        name: trimmedName,
        displayName: formDisplayName.trim(),
        description: formDescription.trim(),
        triggerType: formTriggerType,
        promptTemplate: formTemplate,
        variablesJson: formVariables.trim() || "[]",
        boundToolsJson: formBoundTools.trim() || "[]",
      };
      if (editingSkill) {
        await tauriCmd.updateSkill(input);
      } else {
        await tauriCmd.createSkill(input);
      }
      resetForm();
      loadSkills();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!(await confirmDialog({ message: t("settings.skillConfirmDelete") }))) return;
    try {
      await tauriCmd.deleteSkill(id);
      loadSkills();
    } catch (err) {
      console.error("[skills] failed to delete", err);
    }
  }

  async function handleToggle(skill: tauriCmd.SkillDto) {
    try {
      await tauriCmd.setSkillEnabled(skill.id, !skill.enabled);
      loadSkills();
    } catch (err) {
      console.error("[skills] failed to toggle", err);
    }
  }

  if (!loaded) return null;

  const triggerBadge = (type: string) => {
    switch (type) {
      case "ALWAYS":
        return (
          <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
            {t("settings.skillTriggerAlwaysDesc")}
          </span>
        );
      case "SLASH":
        return (
          <span className="inline-flex items-center rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-700">
            {t("settings.skillTriggerSlashDesc")}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center rounded-full bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600">
            {t("settings.skillTriggerManualDesc")}
          </span>
        );
    }
  };

  return (
    <section className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
            {t("settings.skillsTitle")}
          </h3>
          <p className="mt-1 text-xs text-miro-text-secondary">
            {t("settings.skillsHelp")}
          </p>
          {skillsDir && (
            <p className="mt-1 text-[10px] text-miro-text-secondary/60 font-mono truncate">
              {skillsDir}
            </p>
          )}
          <p className="mt-1 text-[10px] text-miro-text-secondary/70">
            {t("settings.skillImportHelp")}
          </p>
        </div>
        {!showForm && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleImportSkill()}
              disabled={importing}
              className="app-secondary-button rounded-lg px-3 py-1.5 text-xs"
            >
              {importing ? t("settings.skillImporting") : t("settings.skillImport")}
            </button>
            <button
              type="button"
              onClick={startCreate}
              className="app-secondary-button rounded-lg px-3 py-1.5 text-xs"
            >
              + {t("settings.skillAdd")}
            </button>
          </div>
        )}
      </div>

      {importError && !showForm && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {importError}
        </p>
      )}

      {showForm && (
        <form onSubmit={(e) => void handleSave(e)} className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-miro-text">
                {t("settings.skillName")} *
              </label>
              <input
                type="text"
                className="app-input mt-1 w-full text-xs"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t("settings.skillNamePlaceholder")}
                disabled={!!editingSkill}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-miro-text">
                {t("settings.skillDisplayName")}
              </label>
              <input
                type="text"
                className="app-input mt-1 w-full text-xs"
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
                placeholder={t("settings.skillDisplayNamePlaceholder")}
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-miro-text">
              {t("settings.skillDescription")}
            </label>
            <input
              type="text"
              className="app-input mt-1 w-full text-xs"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder={t("settings.skillDescriptionPlaceholder")}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-miro-text">
              {t("settings.skillTriggerType")}
            </label>
            <div className="mt-1 flex flex-wrap gap-3">
              {(["ALWAYS", "SLASH", "MANUAL"] as const).map((type) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center gap-1.5 text-xs"
                >
                  <input
                    type="radio"
                    name="triggerType"
                    value={type}
                    checked={formTriggerType === type}
                    onChange={() => setFormTriggerType(type)}
                    className="accent-miro-blue"
                  />
                  {t(`settings.skillTrigger${type.charAt(0) + type.slice(1).toLowerCase()}`)}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-miro-text">
              {t("settings.skillPromptTemplate")} *
            </label>
            <p className="mb-1 text-[10px] text-miro-text-secondary">
              {t("settings.skillPromptTemplateHelp")}
            </p>
            <textarea
              className="app-input w-full font-mono text-xs"
              rows={6}
              value={formTemplate}
              onChange={(e) => setFormTemplate(e.target.value)}
              placeholder="You are a {{role}} expert. Help me with {{topic}}."
              spellCheck={false}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-miro-text">
                {t("settings.skillVariables")}
              </label>
              <input
                type="text"
                className="app-input mt-1 w-full font-mono text-xs"
                value={formVariables}
                onChange={(e) => setFormVariables(e.target.value)}
                placeholder={t("settings.skillVariablesPlaceholder")}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-miro-text">
                {t("settings.skillBoundTools")}
              </label>
              <input
                type="text"
                className="app-input mt-1 w-full font-mono text-xs"
                value={formBoundTools}
                onChange={(e) => setFormBoundTools(e.target.value)}
                placeholder={t("settings.skillBoundToolsPlaceholder")}
              />
            </div>
          </div>

          {formError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saving}
              className="app-primary-button rounded-lg px-4 py-1.5 text-xs"
            >
              {saving
                ? t("common.saving")
                : editingSkill
                  ? t("settings.skillSave")
                  : t("settings.skillAdd")}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="app-secondary-button rounded-lg px-4 py-1.5 text-xs"
            >
              {t("settings.skillCancel")}
            </button>
          </div>
        </form>
      )}

      {skills.length > 0 && (
        <div className="mt-4 space-y-2">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className={`min-w-0 rounded-lg border px-3 py-2 ${
                skill.enabled
                  ? "border-miro-border/20"
                  : "border-miro-border/10 bg-gray-50/50 opacity-60"
              }`}
            >
              <div className="flex min-w-0 items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 max-w-full truncate text-sm font-medium text-miro-text">
                      {skill.displayName || skill.name}
                    </p>
                    {triggerBadge(skill.triggerType)}
                    {skill.description && (
                      <span className="max-w-[200px] truncate text-[10px] text-miro-text-secondary">
                        {skill.description}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-miro-text-secondary/70">
                    /{skill.name}
                  </p>
                </div>
                <div className="ml-2 flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleToggle(skill)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                      skill.enabled
                        ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                    }`}
                  >
                    {skill.enabled ? t("settings.skillDisable") : t("settings.skillEnable")}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(skill)}
                    className="rounded-md p-1.5 text-miro-text-secondary/50 transition-colors hover:bg-blue-50 hover:text-blue-600"
                    title={t("settings.skillEdit")}
                  >
                    <IconSettings size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(skill.id)}
                    className="rounded-md p-1.5 text-miro-text-secondary/50 transition-colors hover:bg-red-50 hover:text-red-600"
                    title={t("settings.skillDelete")}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {skills.length === 0 && !showForm && (
        <p className="mt-3 text-xs text-miro-text-secondary/60">
          {t("settings.skillsEmpty")}
        </p>
      )}
    </section>
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
