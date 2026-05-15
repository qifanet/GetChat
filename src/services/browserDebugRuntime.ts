/**
 * @file browserDebugRuntime.ts
 * @description In-browser fallback runtime for front-end debugging without Tauri.
 *
 * This module simulates the subset of backend commands that the desktop UI
 * needs during browser-based development. It keeps a small localStorage-backed
 * dataset so the shell, settings screen, workspace, branch rail, compare mode,
 * and streaming pipeline can run without manual mock injection.
 */

import type { RequestId } from "../types/base";
import type {
  BranchEntity,
  ConversationIndexes,
  ConversationSummary,
  MessageNode,
} from "../types/conversation";
import {
  TauriAppError,
  type BootstrapResult,
  type BuildPromptMessagesInput,
  type CompleteAssistantMessageInput,
  type ConversationSnapshot,
  type CreateAssistantPlaceholderForBranchInput,
  type CreateAssistantVariantPlaceholderInput,
  type CreateBranchInput,
  type CreateConversationInput,
  type CreateUserMessageInput,
  type FailAssistantMessageInput,
  type InvariantCheckResult,
  type LastWorkspaceSelection,
  type ModelStreamEvent,
  type PromptMessage,
  type ProviderDto,
  type RenameBranchInput,
  type SaveProviderInput,
  type SetBranchHeadMessageInput,
  type SetBranchPreferredModelInput,
  type SetMainlineBranchInput,
  type SetMainlineResult,
  type StartModelStreamInput,
} from "./tauriTypes";

/** Supported command names mirrored from the Tauri command layer. */
export type BrowserDebugCommandName =
  | "bootstrap_app"
  | "save_last_workspace"
  | "get_default_model"
  | "set_default_model"
  | "get_helper_model"
  | "set_helper_model"
  | "list_providers"
  | "save_provider"
  | "delete_provider"
  | "test_provider_connection"
  | "fetch_ollama_models"
  | "list_conversation_summaries"
  | "create_conversation"
  | "load_conversation_snapshot"
  | "rename_conversation"
  | "archive_conversation"
  | "unarchive_conversation"
  | "delete_conversation"
  | "generate_conversation_title"
  | "create_branch"
  | "rename_branch"
  | "set_branch_preferred_model"
  | "set_branch_head_message"
  | "archive_branch"
  | "unarchive_branch"
  | "set_mainline_branch"
  | "create_user_message"
  | "create_assistant_placeholder_for_branch"
  | "create_assistant_variant_placeholder"
  | "complete_assistant_message"
  | "fail_assistant_message"
  | "build_prompt_messages"
  | "check_db_invariants"
  | "delete_message"
  | "edit_user_message_inline"
  | "search_messages"
  | "generate_branch_diff_summary";

/** Window shape extension used only for Tauri runtime detection. */
interface BrowserWindowWithTauri extends Window {
  __TAURI_INTERNALS__?: {
    invoke?: unknown;
  };
}

/** Persistent storage record for a single conversation. */
interface BrowserDebugConversationRecord {
  summary: ConversationSummary;
  messages: Record<string, MessageNode>;
  branches: Record<string, BranchEntity>;
  indexes: ConversationIndexes;
}

/** Persistent storage record for the full browser debug database. */
interface BrowserDebugState {
  version: 1;
  lastWorkspace: LastWorkspaceSelection | null;
  defaultModelId: string | null;
  helperModelId: string | null;
  providersById: Record<string, ProviderDto>;
  providerOrder: string[];
  conversationsById: Record<string, BrowserDebugConversationRecord>;
  conversationOrder: string[];
}

/** Runtime controller for a simulated model stream. */
class BrowserDebugStreamController {
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  aborted = false;
}

const BROWSER_DEBUG_STORAGE_KEY = "getchat.browser-debug-runtime.v1";
const BROWSER_DEBUG_LOCALE_KEY = "getchat-locale";
const BROWSER_DEBUG_DIFF_SUMMARY_ZH =
  "## 分支差异分析\n\n两条分支在重构方向上有明显差异。\n\n### 左分支\n- 聚合边界拆分优先\n- 渐进式推进\n\n### 右分支\n- 事件总线优先\n- 解耦与异步化\n\n### 建议\n根据团队规模和交付节奏选择合适方案。";
const BROWSER_DEBUG_DIFF_SUMMARY_EN =
  "## Branch Diff Summary\n\nThe two branches diverge in refactoring strategy.\n\n### Left branch\n- Boundary decomposition first\n- Incremental rollout\n\n### Right branch\n- Event bus first\n- Decoupling and async focus\n\n### Recommendation\nPick the approach that fits team size and delivery pace.";
const browserDebugStreams = new Map<RequestId, BrowserDebugStreamController>();
let browserDebugMemoryState: BrowserDebugState | null = null;

function getBrowserDebugLocale(): string {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(BROWSER_DEBUG_LOCALE_KEY);
  if (stored) return stored;
  return window.navigator.language;
}

function buildBrowserDebugDiffSummary(): string {
  const locale = getBrowserDebugLocale().toLowerCase();
  if (locale.startsWith("zh")) {
    return BROWSER_DEBUG_DIFF_SUMMARY_ZH;
  }
  return BROWSER_DEBUG_DIFF_SUMMARY_EN;
}

/**
 * Return true when the app runs inside a normal browser dev session rather
 * than the real Tauri shell.
 */
export function shouldUseBrowserDebugRuntime(): boolean {
  if (import.meta.env.MODE === "test") {
    return false;
  }

  if (typeof window === "undefined") {
    return false;
  }

  const tauriWindow = window as BrowserWindowWithTauri;
  return typeof tauriWindow.__TAURI_INTERNALS__?.invoke !== "function";
}

/** Deep-clone browser debug data before handing it back to the app. */
function cloneBrowserDebugValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

/** Generate a stable entity identifier for browser-only data. */
function createBrowserDebugId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize generation params from loose command input into message metadata. */
function mapGenerationParams(
  params?: Record<string, unknown>
): MessageNode["generation"] extends { params?: infer T } ? T : never {
  if (!params) {
    return undefined as MessageNode["generation"] extends { params?: infer T }
      ? T
      : never;
  }

  return {
    temperature:
      typeof params.temperature === "number" ? params.temperature : undefined,
    topP: typeof params.topP === "number" ? params.topP : undefined,
    maxTokens:
      typeof params.maxTokens === "number" ? params.maxTokens : undefined,
  } as MessageNode["generation"] extends { params?: infer T } ? T : never;
}

/** Build the initial demo conversation shown in browser debug mode. */
function createSeedConversation(now: number): BrowserDebugConversationRecord {
  const conversationId = "conv_seed_architecture_review";
  const mainBranchId = "branch_seed_mainline";
  const altBranchId = "branch_seed_event";
  const rootUserMessageId = "msg_seed_user_request";
  const mainAssistantMessageId = "msg_seed_assistant_main";
  const altAssistantMessageId = "msg_seed_assistant_alt";

  return {
    summary: {
      id: conversationId,
      title: "架构方案评审",
      createdAt: now - 32_000,
      updatedAt: now - 20_000,
      lastOpenedAt: now - 20_000,
      archivedAt: null,
      mainlineBranchId: mainBranchId,
      activeBranchCount: 2,
      archivedBranchCount: 0,
      totalMessageCount: 3,
    },
    messages: {
      [rootUserMessageId]: {
        id: rootUserMessageId,
        conversationId,
        role: "USER",
        status: "COMPLETED",
        parentId: null,
        childIds: [mainAssistantMessageId, altAssistantMessageId],
        depth: 0,
        content: {
          text: "请给出两套后端重构路径，并说明差异。",
          format: "MARKDOWN",
        },
        createdAt: now - 30_000,
        updatedAt: now - 30_000,
      },
      [mainAssistantMessageId]: {
        id: mainAssistantMessageId,
        conversationId,
        role: "ASSISTANT",
        status: "COMPLETED",
        parentId: rootUserMessageId,
        childIds: [],
        depth: 1,
        content: {
          text: "方案 A：优先拆分聚合边界，先处理权限与资料域。",
          format: "MARKDOWN",
        },
        createdAt: now - 24_000,
        updatedAt: now - 24_000,
        generation: {
          providerId: "provider_browser_debug",
          modelId: "browser-debug-model",
        },
      },
      [altAssistantMessageId]: {
        id: altAssistantMessageId,
        conversationId,
        role: "ASSISTANT",
        status: "COMPLETED",
        parentId: rootUserMessageId,
        childIds: [],
        depth: 1,
        content: {
          text: "方案 B：先做事件总线和读写隔离，再逐步抽离服务。",
          format: "MARKDOWN",
        },
        createdAt: now - 20_000,
        updatedAt: now - 20_000,
        generation: {
          providerId: "provider_browser_debug",
          modelId: "browser-debug-model",
        },
      },
    },
    branches: {
      [mainBranchId]: {
        id: mainBranchId,
        conversationId,
        name: "主线方案",
        status: "ACTIVE",
        isMainline: true,
        sourceBranchId: null,
        forkPointMessageId: null,
        forkSourceType: "ROOT",
        forkSourceMessageId: null,
        headMessageId: mainAssistantMessageId,
        summary: "默认评审路线",
        createdAt: now - 32_000,
        updatedAt: now - 24_000,
      },
      [altBranchId]: {
        id: altBranchId,
        conversationId,
        name: "事件方案",
        status: "ACTIVE",
        isMainline: false,
        sourceBranchId: mainBranchId,
        forkPointMessageId: rootUserMessageId,
        forkSourceType: "VARIANT",
        forkSourceMessageId: altAssistantMessageId,
        headMessageId: altAssistantMessageId,
        summary: "强调解耦与异步化",
        createdAt: now - 21_000,
        updatedAt: now - 20_000,
      },
    },
    indexes: {
      rootMessageIds: [rootUserMessageId],
      childMessageIdsByParentId: {
        [rootUserMessageId]: [mainAssistantMessageId, altAssistantMessageId],
      },
      branchIdsByForkPointId: {
        [rootUserMessageId]: [altBranchId],
      },
    },
  };
}

/** Create the initial persisted browser debug dataset. */
function createInitialBrowserDebugState(): BrowserDebugState {
  const now = Date.now();
  const seedConversation = createSeedConversation(now);

  return {
    version: 1,
    lastWorkspace: {
      conversationId: seedConversation.summary.id,
      branchId: seedConversation.summary.mainlineBranchId,
    },
    defaultModelId: null,
    helperModelId: null,
    providersById: {},
    providerOrder: [],
    conversationsById: {
      [seedConversation.summary.id]: seedConversation,
    },
    conversationOrder: [seedConversation.summary.id],
  };
}

/** Read the serialized debug state from localStorage or memory fallback. */
function readBrowserDebugState(): BrowserDebugState {
  if (typeof window === "undefined") {
    if (!browserDebugMemoryState) {
      browserDebugMemoryState = createInitialBrowserDebugState();
    }

    return cloneBrowserDebugValue(browserDebugMemoryState);
  }

  const raw = window.localStorage.getItem(BROWSER_DEBUG_STORAGE_KEY);
  if (!raw) {
    const initialState = createInitialBrowserDebugState();
    writeBrowserDebugState(initialState);
    return cloneBrowserDebugValue(initialState);
  }

  try {
    const parsed = JSON.parse(raw) as BrowserDebugState;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.providersById === "object" &&
      typeof parsed.conversationsById === "object"
    ) {
      browserDebugMemoryState = cloneBrowserDebugValue(parsed);
      return cloneBrowserDebugValue(parsed);
    }
  } catch (error) {
    console.warn("[browser-debug] failed to parse persisted state, resetting", error);
  }

  const resetState = createInitialBrowserDebugState();
  writeBrowserDebugState(resetState);
  return cloneBrowserDebugValue(resetState);
}

/** Persist the serialized debug state to localStorage or memory fallback. */
function writeBrowserDebugState(state: BrowserDebugState): void {
  browserDebugMemoryState = cloneBrowserDebugValue(state);

  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    BROWSER_DEBUG_STORAGE_KEY,
    JSON.stringify(browserDebugMemoryState)
  );
}

/** Execute a read-only command against the current browser debug state. */
function readBrowserDebugCommand<T>(
  reader: (state: BrowserDebugState) => T
): T {
  const state = readBrowserDebugState();
  return cloneBrowserDebugValue(reader(state));
}

/** Execute a mutating command and persist the updated browser debug state. */
function mutateBrowserDebugState<T>(
  mutator: (state: BrowserDebugState) => T
): T {
  const state = readBrowserDebugState();
  const result = mutator(state);
  writeBrowserDebugState(state);
  return cloneBrowserDebugValue(result);
}

/** Throw a typed application error matching the real Tauri command layer. */
function throwBrowserDebugError(
  code: ConstructorParameters<typeof TauriAppError>[0],
  message: string,
  details?: string
): never {
  throw new TauriAppError(code, message, details);
}

/** Return ordered providers using the persisted provider order. */
function listOrderedProviders(state: BrowserDebugState): ProviderDto[] {
  return state.providerOrder
    .map((providerId) => state.providersById[providerId])
    .filter((provider): provider is ProviderDto => Boolean(provider));
}

/** Return ordered active conversation summaries. */
function listOrderedConversationSummaries(
  state: BrowserDebugState
): ConversationSummary[] {
  return state.conversationOrder
    .map((conversationId) => state.conversationsById[conversationId]?.summary)
    .filter(
      (summary): summary is ConversationSummary =>
        Boolean(summary) && summary.archivedAt === null
    );
}

/** Find a conversation record or raise a typed not-found error. */
function requireConversationRecord(
  state: BrowserDebugState,
  conversationId: string
): BrowserDebugConversationRecord {
  const conversation = state.conversationsById[conversationId];
  if (!conversation) {
    throwBrowserDebugError(
      "NOT_FOUND",
      `Conversation ${conversationId} was not found`
    );
  }

  return conversation;
}

/** Find a branch and its parent conversation or raise a typed not-found error. */
function requireBranchRecord(
  state: BrowserDebugState,
  branchId: string
): { conversation: BrowserDebugConversationRecord; branch: BranchEntity } {
  for (const conversation of Object.values(state.conversationsById)) {
    const branch = conversation.branches[branchId];
    if (branch) {
      return { conversation, branch };
    }
  }

  throwBrowserDebugError("NOT_FOUND", `Branch ${branchId} was not found`);
}

/** Find a message and its parent conversation or raise a typed not-found error. */
function requireMessageRecord(
  state: BrowserDebugState,
  messageId: string
): { conversation: BrowserDebugConversationRecord; message: MessageNode } {
  for (const conversation of Object.values(state.conversationsById)) {
    const message = conversation.messages[messageId];
    if (message) {
      return { conversation, message };
    }
  }

  throwBrowserDebugError("NOT_FOUND", `Message ${messageId} was not found`);
}

/** Recompute summary counters after any conversation mutation. */
function syncConversationSummary(
  conversation: BrowserDebugConversationRecord,
  updatedAt: number
): void {
  const branchList = Object.values(conversation.branches);
  conversation.summary.mainlineBranchId =
    branchList.find((branch) => branch.isMainline)?.id ?? null;
  conversation.summary.activeBranchCount = branchList.filter(
    (branch) => branch.status === "ACTIVE"
  ).length;
  conversation.summary.archivedBranchCount = branchList.filter(
    (branch) => branch.status === "ARCHIVED"
  ).length;
  conversation.summary.totalMessageCount = Object.keys(conversation.messages).length;
  conversation.summary.updatedAt = updatedAt;
}

/** Append a child message ID to parent and index structures exactly once. */
function registerChildRelationship(
  conversation: BrowserDebugConversationRecord,
  parentId: string,
  childId: string
): void {
  const parent = conversation.messages[parentId];
  if (parent && !parent.childIds.includes(childId)) {
    parent.childIds.push(childId);
  }

  const childIds =
    conversation.indexes.childMessageIdsByParentId[parentId] ?? [];
  if (!childIds.includes(childId)) {
    childIds.push(childId);
    conversation.indexes.childMessageIdsByParentId[parentId] = childIds;
  }
}

/** Append a root message ID exactly once. */
function registerRootMessage(
  conversation: BrowserDebugConversationRecord,
  messageId: string
): void {
  if (!conversation.indexes.rootMessageIds.includes(messageId)) {
    conversation.indexes.rootMessageIds.push(messageId);
  }
}

/** Append a branch ID under its fork point exactly once. */
function registerForkPointBranch(
  conversation: BrowserDebugConversationRecord,
  forkPointMessageId: string,
  branchId: string
): void {
  const branchIds =
    conversation.indexes.branchIdsByForkPointId[forkPointMessageId] ?? [];
  if (!branchIds.includes(branchId)) {
    branchIds.push(branchId);
    conversation.indexes.branchIdsByForkPointId[forkPointMessageId] = branchIds;
  }
}

/** Collect all descendant IDs under a message. */
function collectDescendantMessageIds(
  conversation: BrowserDebugConversationRecord,
  ancestorId: string
): Set<string> {
  const descendants = new Set<string>();
  const stack = [...(conversation.indexes.childMessageIdsByParentId[ancestorId] ?? [])];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (descendants.has(currentId)) {
      continue;
    }
    descendants.add(currentId);
    const children = conversation.indexes.childMessageIdsByParentId[currentId] ?? [];
    for (const childId of children) {
      stack.push(childId);
    }
  }
  return descendants;
}

/** Create a browser debug provider DTO from a save payload. */
function buildProviderDto(
  input: SaveProviderInput,
  existingProvider?: ProviderDto
): ProviderDto {
  const now = Date.now();
  const providerId =
    input.id ?? existingProvider?.id ?? createBrowserDebugId("provider");
  const existingModelsById = Object.fromEntries(
    (existingProvider?.models ?? []).map((model) => [model.id, model])
  );
  const models = input.models.map((model) => {
    const resolvedId = model.id ?? createBrowserDebugId("model");
    const existingModel = existingModelsById[resolvedId];
    return {
      id: resolvedId,
      providerId,
      requestName: model.requestName.trim(),
      displayName: model.displayName.trim(),
      createdAt: existingModel?.createdAt ?? now,
      updatedAt: now,
    };
  });
  const resolvedDefaultModelId =
    input.defaultModelId === undefined
      ? existingProvider?.defaultModelId ?? models[0]?.id ?? null
      : input.defaultModelId ?? models[0]?.id ?? null;

  return {
    id: providerId,
    type: input.type,
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim(),
    defaultModelId: resolvedDefaultModelId,
    models,
    hasApiKey:
      input.apiKey !== undefined
        ? input.apiKey.trim().length > 0
        : existingProvider?.hasApiKey ?? false,
    enabled: input.enabled ?? existingProvider?.enabled ?? true,
    createdAt: existingProvider?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Create a summary title that stays product-like even in debug mode. */
function buildConversationTitle(
  input: CreateConversationInput,
  existingCount: number
): string {
  const trimmedTitle = input.title?.trim();
  if (trimmedTitle) {
    return trimmedTitle;
  }

  return existingCount === 0 ? "新建会话" : `新建会话 ${existingCount + 1}`;
}

/** Create a user message entity for either explicit send or seeded conversation creation. */
function buildUserMessageEntity(
  input: CreateUserMessageInput,
  parentMessage: MessageNode | null
): MessageNode {
  const now = Date.now();

  return {
    id: createBrowserDebugId("msg"),
    conversationId: input.conversationId,
    role: "USER",
    status: "COMPLETED",
    parentId: parentMessage?.id ?? input.parentMessageId ?? null,
    childIds: [],
    depth: parentMessage ? parentMessage.depth + 1 : 0,
    content: {
      text: input.contentText,
      format: "MARKDOWN",
    },
    createdAt: now,
    updatedAt: now,
    editedFromMessageId: input.editedFromMessageId,
  };
}

/** Create a streaming assistant placeholder entity for a branch. */
function buildAssistantPlaceholderEntity(params: {
  conversationId: string;
  parentMessage: MessageNode | null;
  providerId: string;
  modelId: string;
  requestId: string;
  generationParams?: Record<string, unknown>;
}): MessageNode {
  const now = Date.now();

  return {
    id: createBrowserDebugId("msg"),
    conversationId: params.conversationId,
    role: "ASSISTANT",
    status: "STREAMING",
    parentId: params.parentMessage?.id ?? null,
    childIds: [],
    depth: params.parentMessage ? params.parentMessage.depth + 1 : 0,
    content: {
      text: "",
      format: "MARKDOWN",
    },
    createdAt: now,
    updatedAt: now,
    generation: {
      providerId: params.providerId,
      modelId: params.modelId,
      requestId: params.requestId,
      params: mapGenerationParams(params.generationParams),
    },
  };
}

/** Create a default mainline branch for a brand-new conversation. */
function buildMainlineBranch(
  conversationId: string,
  headMessageId: string | null,
  preferredModelId: string | null = null
): BranchEntity {
  const now = Date.now();

  return {
    id: createBrowserDebugId("branch"),
    conversationId,
    name: "主线",
    status: "ACTIVE",
    isMainline: true,
    sourceBranchId: null,
    forkPointMessageId: null,
    forkSourceType: "ROOT",
    forkSourceMessageId: null,
    headMessageId,
    preferredModelId: preferredModelId ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/** Create the placeholder stream response content used in browser debug mode. */
function buildBrowserDebugAssistantReply(input: StartModelStreamInput): string {
  const state = readBrowserDebugState();
  const lastUserMessage = [...input.promptMessages]
    .reverse()
    .find((message) => message.role.toLowerCase() === "user");
  const displayModelName =
    listOrderedProviders(state)
      .flatMap((provider) => provider.models)
      .find((model) => model.id === input.modelId)
      ?.displayName?.trim() || "未命名模型";

  const requestSummary = lastUserMessage?.content.trim();
  const normalizedPrompt = requestSummary
    ? requestSummary.replace(/\s+/g, " ").slice(0, 160)
    : null;

  return [
    "当前处于浏览器调试模式，回复内容由本地模拟运行时生成，用于验证前端流程与流式渲染。",
    `当前演示模型：${displayModelName}。`,
    normalizedPrompt
      ? `已识别到最后一条用户诉求：${normalizedPrompt}`
      : "当前上下文中没有可用于演示的用户输入。",
    "切回桌面 Tauri 壳层后，这条链路会自动恢复为真实后端命令调用。",
  ].join("\n\n");
}

/** Split a long assistant reply into small stream chunks. */
function chunkBrowserDebugReply(reply: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < reply.length) {
    chunks.push(reply.slice(cursor, cursor + 24));
    cursor += 24;
  }

  return chunks;
}

/** Schedule a simulated stream lifecycle for browser debug mode. */
function startBrowserDebugStream(
  input: StartModelStreamInput,
  onEvent: (event: ModelStreamEvent) => void
): void {
  const controller = new BrowserDebugStreamController();
  browserDebugStreams.set(input.requestId, controller);

  const provider = readBrowserDebugCommand((state) => state.providersById[input.providerId]);
  if (!provider) {
    const timer = setTimeout(() => {
      if (controller.aborted) {
        return;
      }

      onEvent({
        kind: "FAILED",
        requestId: input.requestId,
        code: "NOT_FOUND",
        message: `Provider ${input.providerId} was not found`,
        retriable: true,
      });
      browserDebugStreams.delete(input.requestId);
    }, 40);
    controller.timers.add(timer);
    return;
  }

  const reply = buildBrowserDebugAssistantReply(input);
  const chunks = chunkBrowserDebugReply(reply);
  let nextDelayMs = 45;

  chunks.forEach((chunk) => {
    const timer = setTimeout(() => {
      if (controller.aborted) {
        return;
      }

      onEvent({
        kind: "CHUNK",
        requestId: input.requestId,
        chunk,
      });
    }, nextDelayMs);

    controller.timers.add(timer);
    nextDelayMs += 36;
  });

  const completionTimer = setTimeout(() => {
    if (controller.aborted) {
      return;
    }

    const promptTokens = Math.max(24, input.promptMessages.length * 14);
    const completionTokens = Math.max(30, Math.ceil(reply.length / 5));
    onEvent({
      kind: "COMPLETED",
      requestId: input.requestId,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    });
    browserDebugStreams.delete(input.requestId);
  }, nextDelayMs + 24);

  controller.timers.add(completionTimer);
}

/** Stop a simulated stream and clear all pending timers. */
function abortBrowserDebugStream(requestId: string): void {
  const controller = browserDebugStreams.get(requestId as RequestId);
  if (!controller) {
    return;
  }

  controller.aborted = true;
  controller.timers.forEach((timer) => clearTimeout(timer));
  controller.timers.clear();
  browserDebugStreams.delete(requestId as RequestId);
}

/** Run a browser-debug implementation for a non-streaming command. */
export async function invokeBrowserDebugCommand<T>(
  commandName: BrowserDebugCommandName,
  args?: Record<string, unknown>
): Promise<T> {
  switch (commandName) {
    case "bootstrap_app":
      return readBrowserDebugCommand(
        (state): BootstrapResult => ({
          lastWorkspace: state.lastWorkspace,
          providers: listOrderedProviders(state),
          defaultModelId: state.defaultModelId,
          helperModelId: state.helperModelId,
        })
      ) as T;

    case "save_last_workspace":
      return mutateBrowserDebugState((state) => {
        state.lastWorkspace = (args?.workspaceJson as LastWorkspaceSelection) ?? null;
        return undefined;
      }) as T;

    case "get_default_model":
      return readBrowserDebugCommand((state) => state.defaultModelId) as T;

    case "set_default_model":
      return mutateBrowserDebugState((state) => {
        state.defaultModelId = (args?.modelId as string | null) ?? null;
        return undefined;
      }) as T;

    case "get_helper_model":
      return readBrowserDebugCommand((state) => state.helperModelId) as T;

    case "set_helper_model":
      return mutateBrowserDebugState((state) => {
        state.helperModelId = (args?.modelId as string | null) ?? null;
        return undefined;
      }) as T;

    case "list_providers":
      return readBrowserDebugCommand((state) => listOrderedProviders(state)) as T;

    case "save_provider":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as SaveProviderInput | undefined;
        if (!input) {
          throwBrowserDebugError("INVALID_ARGUMENT", "Provider input is required");
        }

        if (!input.name?.trim() || !input.baseUrl?.trim()) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "Provider name and baseUrl are required"
          );
        }

        if (
          !Array.isArray(input.models) ||
          input.models.length === 0 ||
          input.models.some(
            (model) =>
              !model.requestName?.trim() || !model.displayName?.trim()
          )
        ) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "At least one valid model profile is required"
          );
        }

        const existingProvider = input.id ? state.providersById[input.id] : undefined;
        const provider = buildProviderDto(input, existingProvider);
        state.providersById[provider.id] = provider;
        if (!state.providerOrder.includes(provider.id)) {
          state.providerOrder.unshift(provider.id);
        }

        const allModelIds = Object.values(state.providersById).flatMap((item) =>
          item.models.map((model) => model.id)
        );
        if (state.defaultModelId && !allModelIds.includes(state.defaultModelId)) {
          state.defaultModelId = provider.defaultModelId;
        }

        return provider;
      }) as T;

    case "delete_provider":
      return mutateBrowserDebugState((state) => {
        const providerId = args?.providerId as string | undefined;
        const provider = providerId ? state.providersById[providerId] : undefined;
        if (!providerId || !provider) {
          throwBrowserDebugError("NOT_FOUND", `Provider ${providerId} was not found`);
        }

        delete state.providersById[providerId];
        state.providerOrder = state.providerOrder.filter((id) => id !== providerId);
        if (
          state.defaultModelId &&
          provider.models.some((model) => model.id === state.defaultModelId)
        ) {
          state.defaultModelId = null;
        }
        return undefined;
      }) as T;

    case "test_provider_connection":
      return mutateBrowserDebugState((state) => {
        const providerId = args?.providerId as string | undefined;
        const provider = providerId ? state.providersById[providerId] : undefined;
        if (!provider) {
          throwBrowserDebugError("NOT_FOUND", `Provider ${providerId} was not found`);
        }

        if (!provider.enabled) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "The selected provider is disabled"
          );
        }

        return undefined;
      }) as T;

    case "fetch_ollama_models":
      return [] as T;

    case "list_conversation_summaries":
      return readBrowserDebugCommand((state) =>
        listOrderedConversationSummaries(state)
      ) as T;

    case "create_conversation":
      return mutateBrowserDebugState((state) => {
        const input = (args?.input as CreateConversationInput | undefined) ?? {};
        const conversationId = createBrowserDebugId("conv");
        const title = buildConversationTitle(
          input,
          Object.keys(state.conversationsById).length
        );
        const now = Date.now();

        let rootMessage: MessageNode | null = null;
        const messages: Record<string, MessageNode> = {};
        const indexes: ConversationIndexes = {
          rootMessageIds: [],
          childMessageIdsByParentId: {},
          branchIdsByForkPointId: {},
        };

        if (input.initialUserMessage?.trim()) {
          rootMessage = {
            id: createBrowserDebugId("msg"),
            conversationId,
            role: "USER",
            status: "COMPLETED",
            parentId: null,
            childIds: [],
            depth: 0,
            content: {
              text: input.initialUserMessage.trim(),
              format: "MARKDOWN",
            },
            createdAt: now,
            updatedAt: now,
          };
          messages[rootMessage.id] = rootMessage;
          indexes.rootMessageIds.push(rootMessage.id);
        }

        const mainlineBranch = buildMainlineBranch(
          conversationId,
          rootMessage?.id ?? null,
          state.defaultModelId
        );
        const conversation: BrowserDebugConversationRecord = {
          summary: {
            id: conversationId,
            title,
            createdAt: now,
            updatedAt: now,
            lastOpenedAt: now,
            archivedAt: null,
            mainlineBranchId: mainlineBranch.id,
            activeBranchCount: 1,
            archivedBranchCount: 0,
            totalMessageCount: rootMessage ? 1 : 0,
          },
          messages,
          branches: {
            [mainlineBranch.id]: mainlineBranch,
          },
          indexes,
        };

        state.conversationsById[conversationId] = conversation;
        state.conversationOrder = [
          conversationId,
          ...state.conversationOrder.filter((id) => id !== conversationId),
        ];
        state.lastWorkspace = {
          conversationId,
          branchId: mainlineBranch.id,
        };

        return conversation.summary;
      }) as T;

    case "load_conversation_snapshot":
      return mutateBrowserDebugState((state) => {
        const conversationId = (
          args?.input as { conversationId?: string } | undefined
        )?.conversationId;
        if (!conversationId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId is required"
          );
        }

        const conversation = requireConversationRecord(state, conversationId);
        const now = Date.now();
        conversation.summary.lastOpenedAt = now;
        conversation.summary.updatedAt = Math.max(conversation.summary.updatedAt, now);
        state.conversationOrder = [
          conversationId,
          ...state.conversationOrder.filter((id) => id !== conversationId),
        ];
        state.lastWorkspace = {
          conversationId,
          branchId:
            state.lastWorkspace?.conversationId === conversationId
              ? state.lastWorkspace.branchId
              : conversation.summary.mainlineBranchId,
        };

        const snapshot: ConversationSnapshot = {
          summary: conversation.summary,
          entities: {
            messages: conversation.messages,
            branches: conversation.branches,
          },
          indexes: conversation.indexes,
          loadedAt: now,
        };

        return snapshot;
      }) as T;

    case "rename_conversation":
      return mutateBrowserDebugState((state) => {
        const conversationId = args?.conversationId as string | undefined;
        const title = args?.title as string | undefined;
        if (!conversationId || !title?.trim()) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId and title are required"
          );
        }

        const conversation = requireConversationRecord(state, conversationId);
        conversation.summary.title = title.trim();
        conversation.summary.updatedAt = Date.now();
        return conversation.summary;
      }) as T;

    case "archive_conversation":
      return mutateBrowserDebugState((state) => {
        const conversationId = args?.conversationId as string | undefined;
        if (!conversationId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId is required"
          );
        }

        const conversation = requireConversationRecord(state, conversationId);
        conversation.summary.archivedAt = Date.now();
        conversation.summary.updatedAt = conversation.summary.archivedAt;
        state.conversationOrder = state.conversationOrder.filter(
          (id) => id !== conversationId
        );

        if (state.lastWorkspace?.conversationId === conversationId) {
          state.lastWorkspace = {
            conversationId: null,
            branchId: null,
          };
        }

        return conversation.summary;
      }) as T;

    case "unarchive_conversation":
      return mutateBrowserDebugState((state) => {
        const conversationId = args?.conversationId as string | undefined;
        if (!conversationId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId is required"
          );
        }

        const conversation = requireConversationRecord(state, conversationId);
        conversation.summary.archivedAt = null;
        conversation.summary.updatedAt = Date.now();
        if (!state.conversationOrder.includes(conversationId)) {
          state.conversationOrder.unshift(conversationId);
        }
        return conversation.summary;
      }) as T;

    case "delete_conversation":
      return mutateBrowserDebugState((state) => {
        const conversationId = args?.conversationId as string | undefined;
        if (!conversationId || !state.conversationsById[conversationId]) {
          throwBrowserDebugError("NOT_FOUND", `Conversation ${conversationId} was not found`);
        }

        delete state.conversationsById[conversationId];
        state.conversationOrder = state.conversationOrder.filter(
          (id) => id !== conversationId
        );

        if (state.lastWorkspace?.conversationId === conversationId) {
          state.lastWorkspace = {
            conversationId: null,
            branchId: null,
          };
        }

        return undefined;
      }) as T;

    case "generate_conversation_title":
      // No-op in browser debug: title generation requires a real AI backend
      return Promise.resolve(null) as T;

    case "create_branch":
    case "rename_branch":
    case "set_branch_preferred_model":
    case "set_branch_head_message":
    case "archive_branch":
    case "unarchive_branch":
    case "set_mainline_branch":
    case "create_user_message":
    case "create_assistant_placeholder_for_branch":
    case "create_assistant_variant_placeholder":
    case "complete_assistant_message":
    case "fail_assistant_message":
    case "build_prompt_messages":
    case "check_db_invariants":
      break;
  }

  return invokeBrowserDebugCommandPostConversationCommands<T>(commandName, args);
}

/** Run browser-debug implementations for branch, message, and debug commands. */
async function invokeBrowserDebugCommandPostConversationCommands<T>(
  commandName: BrowserDebugCommandName,
  args?: Record<string, unknown>
): Promise<T> {
  switch (commandName) {
    case "create_branch":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as CreateBranchInput | undefined;
        if (!input?.conversationId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId is required"
          );
        }

        const conversation = requireConversationRecord(state, input.conversationId);
        const sourceBranch = input.sourceBranchId
          ? conversation.branches[input.sourceBranchId]
          : null;
        const forkPointMessageId =
          input.forkPointMessageId ?? sourceBranch?.headMessageId ?? null;
        const now = Date.now();
        const branch: BranchEntity = {
          id: createBrowserDebugId("branch"),
          conversationId: input.conversationId,
          name:
            input.name?.trim() ||
            `新分支 ${Object.keys(conversation.branches).length + 1}`,
          status: "ACTIVE",
          isMainline: false,
          sourceBranchId: input.sourceBranchId ?? null,
          forkPointMessageId,
          forkSourceType: input.forkSourceType,
          forkSourceMessageId: input.forkSourceMessageId ?? null,
          headMessageId: forkPointMessageId,
          preferredModelId:
            input.preferredModelId ?? sourceBranch?.preferredModelId ?? undefined,
          createdAt: now,
          updatedAt: now,
        };

        conversation.branches[branch.id] = branch;
        if (forkPointMessageId) {
          registerForkPointBranch(conversation, forkPointMessageId, branch.id);
        }
        syncConversationSummary(conversation, now);
        return branch;
      }) as T;

    case "set_branch_preferred_model":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as SetBranchPreferredModelInput | undefined;
        if (!input?.branchId) {
          throwBrowserDebugError("INVALID_ARGUMENT", "branchId is required");
        }

        const { conversation, branch } = requireBranchRecord(state, input.branchId);
        branch.preferredModelId = input.modelId ?? undefined;
        branch.updatedAt = Date.now();
        syncConversationSummary(conversation, branch.updatedAt);
        return branch;
      }) as T;

    case "set_branch_head_message":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as SetBranchHeadMessageInput | undefined;
        if (!input?.branchId || !input.messageId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "branchId and messageId are required"
          );
        }

        const { conversation, branch } = requireBranchRecord(state, input.branchId);
        const message = conversation.messages[input.messageId];
        if (!message) {
          throwBrowserDebugError("NOT_FOUND", `Message ${input.messageId} was not found`);
        }

        branch.headMessageId = message.id;
        branch.updatedAt = Date.now();
        syncConversationSummary(conversation, branch.updatedAt);
        return branch;
      }) as T;

    case "rename_branch":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as RenameBranchInput | undefined;
        if (!input?.branchId || !input.name?.trim()) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "branchId and name are required"
          );
        }

        const { conversation, branch } = requireBranchRecord(state, input.branchId);
        branch.name = input.name.trim();
        branch.updatedAt = Date.now();
        syncConversationSummary(conversation, branch.updatedAt);
        return branch;
      }) as T;

    case "archive_branch":
      return mutateBrowserDebugState((state) => {
        const branchId = args?.branchId as string | undefined;
        if (!branchId) {
          throwBrowserDebugError("INVALID_ARGUMENT", "branchId is required");
        }

        const { conversation, branch } = requireBranchRecord(state, branchId);
        if (branch.isMainline) {
          throwBrowserDebugError(
            "CONFLICT",
            "Mainline branch cannot be archived"
          );
        }

        branch.status = "ARCHIVED";
        branch.archivedAt = Date.now();
        branch.updatedAt = branch.archivedAt;
        syncConversationSummary(conversation, branch.updatedAt);
        return branch;
      }) as T;

    case "unarchive_branch":
      return mutateBrowserDebugState((state) => {
        const branchId = args?.branchId as string | undefined;
        if (!branchId) {
          throwBrowserDebugError("INVALID_ARGUMENT", "branchId is required");
        }

        const { conversation, branch } = requireBranchRecord(state, branchId);
        branch.status = "ACTIVE";
        delete branch.archivedAt;
        branch.updatedAt = Date.now();
        syncConversationSummary(conversation, branch.updatedAt);
        return branch;
      }) as T;

    case "set_mainline_branch":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as SetMainlineBranchInput | undefined;
        if (!input?.conversationId || !input.branchId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId and branchId are required"
          );
        }

        const conversation = requireConversationRecord(state, input.conversationId);
        const branch = conversation.branches[input.branchId];
        if (!branch) {
          throwBrowserDebugError("NOT_FOUND", `Branch ${input.branchId} was not found`);
        }
        if (branch.status !== "ACTIVE") {
          throwBrowserDebugError(
            "CONFLICT",
            "Only active branches can become mainline"
          );
        }

        const oldMainlineBranch = Object.values(conversation.branches).find(
          (currentBranch) => currentBranch.isMainline
        );
        if (oldMainlineBranch) {
          oldMainlineBranch.isMainline = false;
          oldMainlineBranch.updatedAt = Date.now();
        }

        branch.isMainline = true;
        branch.updatedAt = Date.now();
        syncConversationSummary(conversation, branch.updatedAt);

        const result: SetMainlineResult = {
          oldMainlineBranchId: oldMainlineBranch?.id ?? null,
          newMainlineBranch: branch,
        };

        return result;
      }) as T;

    case "create_user_message":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as CreateUserMessageInput | undefined;
        if (!input?.conversationId || !input.branchId || !input.contentText.trim()) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId, branchId and contentText are required"
          );
        }

        const conversation = requireConversationRecord(state, input.conversationId);
        const branch = conversation.branches[input.branchId];
        if (!branch) {
          throwBrowserDebugError("NOT_FOUND", `Branch ${input.branchId} was not found`);
        }

        const parentMessage = input.parentMessageId
          ? conversation.messages[input.parentMessageId] ?? null
          : branch.headMessageId
            ? conversation.messages[branch.headMessageId] ?? null
            : null;
        const message = buildUserMessageEntity(input, parentMessage);

        conversation.messages[message.id] = message;
        if (message.parentId) {
          registerChildRelationship(conversation, message.parentId, message.id);
        } else {
          registerRootMessage(conversation, message.id);
        }

        branch.headMessageId = message.id;
        branch.updatedAt = message.updatedAt;
        syncConversationSummary(conversation, message.updatedAt);
        return message;
      }) as T;

    case "create_assistant_placeholder_for_branch":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as CreateAssistantPlaceholderForBranchInput | undefined;
        if (!input?.conversationId || !input.branchId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId and branchId are required"
          );
        }

        const conversation = requireConversationRecord(state, input.conversationId);
        const branch = conversation.branches[input.branchId];
        if (!branch) {
          throwBrowserDebugError("NOT_FOUND", `Branch ${input.branchId} was not found`);
        }

        const parentMessage = branch.headMessageId
          ? conversation.messages[branch.headMessageId] ?? null
          : null;
        const message = buildAssistantPlaceholderEntity({
          conversationId: input.conversationId,
          parentMessage,
          providerId: input.providerId,
          modelId: input.modelId,
          requestId: input.requestId,
          generationParams: input.generationParams,
        });

        conversation.messages[message.id] = message;
        if (message.parentId) {
          registerChildRelationship(conversation, message.parentId, message.id);
        } else {
          registerRootMessage(conversation, message.id);
        }

        branch.headMessageId = message.id;
        branch.updatedAt = message.updatedAt;
        syncConversationSummary(conversation, message.updatedAt);
        return message;
      }) as T;

    case "create_assistant_variant_placeholder":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as CreateAssistantVariantPlaceholderInput | undefined;
        if (!input?.conversationId || !input.parentMessageId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId and parentMessageId are required"
          );
        }

        const conversation = requireConversationRecord(state, input.conversationId);
        const parentMessage = conversation.messages[input.parentMessageId];
        if (!parentMessage) {
          throwBrowserDebugError(
            "NOT_FOUND",
            `Parent message ${input.parentMessageId} was not found`
          );
        }

        const message = buildAssistantPlaceholderEntity({
          conversationId: input.conversationId,
          parentMessage,
          providerId: input.providerId,
          modelId: input.modelId,
          requestId: input.requestId,
          generationParams: input.generationParams,
        });

        conversation.messages[message.id] = message;
        registerChildRelationship(conversation, parentMessage.id, message.id);
        syncConversationSummary(conversation, message.updatedAt);
        return message;
      }) as T;

    case "complete_assistant_message":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as CompleteAssistantMessageInput | undefined;
        if (!input?.messageId) {
          throwBrowserDebugError("INVALID_ARGUMENT", "messageId is required");
        }

        const { conversation, message } = requireMessageRecord(state, input.messageId);
        const now = Date.now();
        message.status = "COMPLETED";
        message.content = {
          text: input.contentText,
          format: "MARKDOWN",
        };
        message.updatedAt = now;
        if (message.generation) {
          message.generation.usage = input.usage;
        }
        delete message.error;

        Object.values(conversation.branches).forEach((branch) => {
          if (branch.headMessageId === message.id) {
            branch.updatedAt = now;
          }
        });

        syncConversationSummary(conversation, now);
        return message;
      }) as T;

    case "fail_assistant_message":
      return mutateBrowserDebugState((state) => {
        const input = args?.input as FailAssistantMessageInput | undefined;
        if (!input?.messageId) {
          throwBrowserDebugError("INVALID_ARGUMENT", "messageId is required");
        }

        const { conversation, message } = requireMessageRecord(state, input.messageId);
        const now = Date.now();
        message.status = "FAILED";
        message.content = {
          text: input.partialContentText ?? "",
          format: "MARKDOWN",
        };
        message.updatedAt = now;
        message.error = {
          code: input.errorCode,
          message: input.errorMessage,
          retriable: input.errorRetriable,
        };

        Object.values(conversation.branches).forEach((branch) => {
          if (branch.headMessageId === message.id) {
            branch.updatedAt = now;
          }
        });

        syncConversationSummary(conversation, now);
        return message;
      }) as T;

    case "build_prompt_messages":
      return readBrowserDebugCommand((state) => {
        const input = args?.input as BuildPromptMessagesInput | undefined;
        if (!input?.conversationId || !input.upToMessageId) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "conversationId and upToMessageId are required"
          );
        }

        const conversation = requireConversationRecord(state, input.conversationId);
        const promptMessages: PromptMessage[] = [];
        let cursor: MessageNode | undefined =
          conversation.messages[input.upToMessageId];

        while (cursor) {
          promptMessages.push({
            role: cursor.role.toLowerCase(),
            content: cursor.content.text,
          });
          cursor = cursor.parentId
            ? conversation.messages[cursor.parentId]
            : undefined;
        }

        return promptMessages.reverse();
      }) as T;

    case "delete_message":
      return mutateBrowserDebugState((state) => {
        const messageId = args?.messageId as string | undefined;
        if (!messageId) {
          throwBrowserDebugError("INVALID_ARGUMENT", "messageId is required");
        }
        const { conversation, message } = requireMessageRecord(state, messageId);
        if (message.role !== "ASSISTANT") {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "Only ASSISTANT messages can be deleted as variants"
          );
        }
        if (message.status === "STREAMING") {
          throwBrowserDebugError("INVALID_ARGUMENT", "Cannot delete a streaming message");
        }
        if (message.childIds.length > 0) {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "Cannot delete a message that has child messages"
          );
        }
        const isBranchHead = Object.values(conversation.branches).some(
          (branch) => branch.headMessageId === messageId
        );
        if (isBranchHead) {
          throwBrowserDebugError(
            "CONFLICT",
            "Cannot delete a message that is currently a branch head"
          );
        }
        if (message.parentId) {
          const parent = conversation.messages[message.parentId];
          if (parent) {
            parent.childIds = parent.childIds.filter((id) => id !== messageId);
          }
          const siblings = conversation.indexes.childMessageIdsByParentId[message.parentId] ?? [];
          conversation.indexes.childMessageIdsByParentId[message.parentId] = siblings.filter(
            (id) => id !== messageId
          );
        } else {
          conversation.indexes.rootMessageIds = conversation.indexes.rootMessageIds.filter(
            (id) => id !== messageId
          );
        }
        delete conversation.indexes.childMessageIdsByParentId[messageId];
        delete conversation.indexes.branchIdsByForkPointId[messageId];
        delete conversation.messages[messageId];
        syncConversationSummary(conversation, Date.now());
        return undefined;
      }) as T;

    case "edit_user_message_inline":
      return mutateBrowserDebugState((state) => {
        const messageId = args?.messageId as string | undefined;
        const newContent = args?.newContent as string | undefined;
        if (!messageId || typeof newContent !== "string") {
          throwBrowserDebugError("INVALID_ARGUMENT", "messageId and newContent are required");
        }
        const { conversation, message } = requireMessageRecord(state, messageId);
        if (message.role !== "USER") {
          throwBrowserDebugError(
            "INVALID_ARGUMENT",
            "Only USER messages can be edited inline"
          );
        }
        const descendants = collectDescendantMessageIds(conversation, messageId);
        const hasForkPointReference = Object.values(conversation.branches).some(
          (branch) =>
            branch.forkPointMessageId !== null &&
            descendants.has(branch.forkPointMessageId)
        );
        if (hasForkPointReference) {
          throwBrowserDebugError(
            "CONFLICT",
            "Cannot edit inline when downstream messages are fork points of existing branches"
          );
        }
        const now = Date.now();
        for (const descendantId of descendants) {
          const descendant = conversation.messages[descendantId];
          if (descendant?.parentId) {
            const siblings = conversation.indexes.childMessageIdsByParentId[descendant.parentId] ?? [];
            conversation.indexes.childMessageIdsByParentId[descendant.parentId] = siblings.filter(
              (id) => id !== descendantId
            );
          }
          conversation.indexes.rootMessageIds = conversation.indexes.rootMessageIds.filter(
            (id) => id !== descendantId
          );
          delete conversation.indexes.childMessageIdsByParentId[descendantId];
          delete conversation.indexes.branchIdsByForkPointId[descendantId];
          delete conversation.messages[descendantId];
        }
        Object.values(conversation.branches).forEach((branch) => {
          if (branch.headMessageId && descendants.has(branch.headMessageId)) {
            branch.headMessageId = messageId;
            branch.updatedAt = now;
          }
        });
        message.content = { text: newContent, format: "MARKDOWN" };
        message.childIds = [];
        message.updatedAt = now;
        conversation.indexes.childMessageIdsByParentId[messageId] = [];
        syncConversationSummary(conversation, now);
        return message;
      }) as T;

    case "check_db_invariants":
      return readBrowserDebugCommand((state): InvariantCheckResult => ({
        ok: true,
        checkedAt: Date.now(),
        checks: [
          {
            code: "BROWSER_DEBUG_DATASET_OK",
            label: `Browser debug dataset healthy (${Object.keys(state.conversationsById).length} conversations)`,
            passed: true,
            rowCount: 0,
            sampleRows: [],
          },
        ],
      })) as T;

    case "search_messages":
      return readBrowserDebugCommand((state): T => {
        const input = args?.input as { query: string; conversationId?: string; limit?: number } | undefined;
        if (!input?.query) return [] as T;
        const keyword = input.query.toLowerCase();
        const limit = input.limit ?? 50;
        const results: Array<{
          messageId: string;
          conversationId: string;
          role: string;
          snippet: string;
          createdAt: number;
        }> = [];
        for (const conv of Object.values(state.conversationsById)) {
          if (input.conversationId && conv.summary.id !== input.conversationId) continue;
          for (const msg of Object.values(conv.messages)) {
            if (msg.content.text.toLowerCase().includes(keyword)) {
              const idx = msg.content.text.toLowerCase().indexOf(keyword);
              const start = Math.max(0, idx - 30);
              const end = Math.min(msg.content.text.length, idx + input.query.length + 30);
              results.push({
                messageId: msg.id,
                conversationId: conv.summary.id,
                role: msg.role,
                snippet: (start > 0 ? "..." : "") + msg.content.text.slice(start, end) + (end < msg.content.text.length ? "..." : ""),
                createdAt: msg.createdAt,
              });
              if (results.length >= limit) return results as T;
            }
          }
        }
        return results as T;
      });

    case "generate_branch_diff_summary":
      return readBrowserDebugCommand((_state): T => {
        return { summary: buildBrowserDebugDiffSummary() } as T;
      });

    default:
      throwBrowserDebugError(
        "INVALID_ARGUMENT",
        `Unsupported browser debug command: ${commandName}`
      );
  }
}

/** Start a simulated browser-debug model stream. */
export async function startBrowserDebugModelStream(
  input: StartModelStreamInput,
  onEvent: (event: ModelStreamEvent) => void
): Promise<void> {
  startBrowserDebugStream(input, onEvent);
}

/** Abort a simulated browser-debug model stream. */
export async function abortBrowserDebugModelStream(
  requestId: string
): Promise<void> {
  abortBrowserDebugStream(requestId);
}

/** Reset browser debug state for deterministic tests. */
export function resetBrowserDebugRuntimeForTests(): void {
  browserDebugStreams.forEach((_controller, requestId) =>
    abortBrowserDebugStream(requestId)
  );
  browserDebugMemoryState = createInitialBrowserDebugState();

  if (typeof window !== "undefined") {
    window.localStorage.removeItem(BROWSER_DEBUG_STORAGE_KEY);
  }
}
