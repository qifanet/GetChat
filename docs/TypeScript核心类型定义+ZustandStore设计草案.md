好，这一层我会更偏**工程落地**。

## 2026-04-09 增量更新

- 当前仓库已按本文“双层流式架构”补入真实运行时代码：
  - 前端通过 `start_model_stream` + `Channel<ModelStreamEvent>` 接收真实 chunk/completed/failed 事件
  - Rust 侧新增 `model_stream_service` 统一解析 `OPENAI_COMPATIBLE` SSE 与 `OLLAMA` NDJSON/SSE
  - `cancelStream()` 先请求 `abort_model_stream`，再持久化 `USER_CANCELLED`
- 仍需保留的现实约束：
  - 当前环境无 `cargo`，上述 Rust 代码尚未完成本机编译与 Tauri smoke 复验
  - 因此前文设计已基本落地，但端到端验收状态仍应以审计追踪文档为准

---

先给结论：

# 先定 4 个关键实现原则

1. **SQLite / Tauri 是数据真源，Zustand 不是数据库**
   - Zustand 只存：
     - 当前工作区状态
     - 当前会话快照
     - UI 状态
     - 流式生成的轻量元信息
   - 不要把全量历史都塞进 Zustand persist

2. **消息树和分支数据，与流式文本状态分离**
   - `conversation store`：存最终消息、分支、索引
   - `stream store`：只存流式会话元数据
   - `stream runtime registry`：存 chunk 缓冲和 pretext / DOM surface 句柄

3. **流式阶段不要每个 token 都更新 React state**
   - 否则你很快会遇到：
     - 整个消息列表反复 rerender
     - markdown 反复全量 parse
     - code block 反复高亮
     - 滚动抖动
   - 正确做法：**流式阶段走命令式 append surface，完成后一次性提交最终文本**

4. **结合 pretext 的正确姿势**
   - 把它当成一个**streaming text surface**
   - 只用于 **assistant 正在生成中的正文区域**
   - 完成后切回正常 `MarkdownRenderer`
   - 也就是说：
     - **in-flight = pretext/DOM 文本 surface**
     - **completed = markdown 渲染**

> 我无法实时查看该仓库最新 API 细节，所以我下面会给你一个**adapter 化接入方案**。
> 你只要把 pretext 的真实 API 填到 adapter 层就可以，不会绑死你的整体架构。

---

# 一、TypeScript 核心类型定义

我建议按下面这些文件来定义。

---

## 1.1 `types/base.ts`

```ts
export type UnixMs = number;

export type ConversationId = string;
export type BranchId = string;
export type MessageId = string;
export type ProviderId = string;
export type ModelId = string;
export type RequestId = string;
export type ToastId = string;

export type MessageRole = "system" | "user" | "assistant";
export type MessageStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted";

export type BranchStatus = "active" | "archived";

export type WorkspaceMode =
  | "normal"
  | "historyFork"
  | "editFork"
  | "compare";

export type SendMode = "append" | "newBranch";

export type ForkSourceType =
  | "root"
  | "currentLeaf"
  | "historyAssistant"
  | "historyUserEdit"
  | "variant";

export type RightPanelTab = "branches" | "details";

export type StreamRendererMode = "pretext" | "dom-text";
```

---

## 1.2 `types/settings.ts`

```ts
import { ModelId, ProviderId, UnixMs } from "./base";

export type ProviderType = "openai-compatible" | "ollama";

export interface ProviderConfig {
  id: ProviderId;
  type: ProviderType;
  name: string;
  baseUrl: string;
  apiKeyRef?: string; // 存系统安全存储引用，不存明文
  defaultModelId?: ModelId;
  enabled: boolean;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ModelProfile {
  id: ModelId;
  providerId: ProviderId;
  name: string;       // 例如 gpt-4.1
  label: string;      // 例如 GPT-4.1
  supportsStreaming: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
}

export interface GenerationParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream: boolean;
}
```

---

## 1.3 `types/conversation.ts`

这是最核心的领域模型。

```ts
import {
  BranchId,
  BranchStatus,
  ConversationId,
  ForkSourceType,
  MessageId,
  MessageRole,
  MessageStatus,
  ModelId,
  ProviderId,
  RequestId,
  UnixMs,
} from "./base";

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface MessageError {
  code: string;
  message: string;
  retriable: boolean;
}

export interface MessageContent {
  /**
   * 只存最终提交文本。
   * streaming 中的增量文本不要频繁写这里。
   */
  text: string;
  format: "markdown";
}

export interface MessageGenerationMeta {
  providerId: ProviderId;
  modelId: ModelId;
  requestId?: RequestId;
  params?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
  usage?: TokenUsage;
}

export interface MessageNode {
  id: MessageId;
  conversationId: ConversationId;

  role: MessageRole;
  status: MessageStatus;

  /**
   * 树结构核心：只需要 parentId 即可表达路径
   */
  parentId: MessageId | null;

  /**
   * 运行时索引，可由 parentId 构建
   * 可不持久化，也可在 snapshot 中带上
   */
  childIds: MessageId[];

  /**
   * 从根到当前节点的深度，便于快速回溯路径
   */
  depth: number;

  content: MessageContent;

  createdAt: UnixMs;
  updatedAt: UnixMs;

  generation?: MessageGenerationMeta;
  error?: MessageError;

  /**
   * 仅历史用户消息被“编辑并分支”时使用
   * 表示这个新消息是从哪个旧消息改写出来的
   */
  editedFromMessageId?: MessageId;
}

export interface BranchEntity {
  id: BranchId;
  conversationId: ConversationId;

  name: string;
  status: BranchStatus;

  /**
   * 主线只是默认打开路径，不是数据结构特权
   */
  isMainline: boolean;

  /**
   * 这条 branch 是从哪条 branch 分出来的
   */
  sourceBranchId: BranchId | null;

  /**
   * 分叉点消息
   * 主线可为 null
   */
  forkPointMessageId: MessageId | null;

  /**
   * 分叉动作来源
   */
  forkSourceType: ForkSourceType;

  /**
   * 真正触发分叉的源消息
   * 例如：
   * - historyAssistant: 某条助手消息
   * - historyUserEdit: 某条用户消息
   * - variant: 某个 assistant variant 消息
   */
  forkSourceMessageId: MessageId | null;

  /**
   * 当前 branch 最新叶子节点
   * 空会话时可为 null
   */
  headMessageId: MessageId | null;

  /**
   * 展示层需要的信息
   */
  color?: string;
  summary?: string;

  createdAt: UnixMs;
  updatedAt: UnixMs;
  archivedAt?: UnixMs;
}

export interface ConversationSummary {
  id: ConversationId;
  title: string;

  createdAt: UnixMs;
  updatedAt: UnixMs;
  lastOpenedAt?: UnixMs;

  mainlineBranchId: BranchId | null;
  activeBranchCount: number;
  archivedBranchCount: number;
  totalMessageCount: number;
}

export interface ConversationIndexes {
  /**
   * 为了更快渲染当前路径和 variant group
   * 可以在加载 snapshot 时构建
   */
  rootMessageIds: MessageId[];
  childMessageIdsByParentId: Record<MessageId, MessageId[]>;
  branchIdsByForkPointId: Record<MessageId, BranchId[]>;
}

export interface ConversationEntities {
  messages: Record<MessageId, MessageNode>;
  branches: Record<BranchId, BranchEntity>;
}

export interface ConversationSnapshot {
  summary: ConversationSummary;
  entities: ConversationEntities;
  indexes: ConversationIndexes;
  loadedAt: UnixMs;
}
```

---

## 1.4 `types/variant.ts`

我建议 **variant 不做太重的一等持久化实体**。
v1 里它更适合做**运行时衍生结构**。

```ts
import { MessageId } from "./base";

export interface DerivedVariantGroup {
  /**
   * 某条用户消息
   */
  userMessageId: MessageId;

  /**
   * 该用户消息下的多个 assistant sibling
   */
  assistantMessageIds: MessageId[];
}
```

> 原因：
> variant 本质上就是“同一个 user message 下的多个 assistant child”
> 完全可以从消息树推导出来。
> 这样不会把模型重试、候选组、路径选择三套概念绑死。

---

## 1.5 `types/workspace.ts`

```ts
import {
  BranchId,
  ConversationId,
  ForkSourceType,
  MessageId,
  RightPanelTab,
  SendMode,
  WorkspaceMode,
} from "./base";
import { GenerationParams, ModelProfile } from "./settings";

export interface ForkIntent {
  sourceType: ForkSourceType;
  sourceBranchId: BranchId;
  sourceMessageId: MessageId;

  /**
   * historyUserEdit 时使用
   */
  originalEditableMessageId?: MessageId;

  /**
   * variant 继续时使用
   */
  selectedVariantMessageId?: MessageId;
}

export interface CompareState {
  leftBranchId: BranchId;
  rightBranchId: BranchId;
}

export interface VariantPreviewContext {
  /**
   * 当前正在预览哪个 user message 下的某个 assistant 候选
   */
  userMessageId: MessageId;
  assistantMessageId: MessageId;

  /**
   * 若当前路径后续依赖的是另一个 assistant 候选，
   * 则继续输入会创建新分支
   */
  hasDownstreamConflict: boolean;
}

export interface WorkspaceState {
  activeConversationId: ConversationId | null;
  currentBranchId: BranchId | null;

  workspaceMode: WorkspaceMode;
  forkIntent: ForkIntent | null;

  compareState: CompareState | null;
  variantPreview: VariantPreviewContext | null;

  pendingConvergeCount: number;
}

export interface ComposerState {
  draft: string;
  selectedModelId: ModelProfile["id"] | null;
  sendMode: SendMode;
  params: GenerationParams;

  isSending: boolean;
  activeRequestId: string | null;
}

export interface UiState {
  leftSidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  rightPanelTab: RightPanelTab;

  exportDialogOpen: boolean;
  branchRenameDialogOpen: boolean;
}
```

---

## 1.6 `types/stream.ts`

这是解决流式渲染灾难的关键。

```ts
import {
  BranchId,
  ConversationId,
  MessageId,
  RequestId,
  StreamRendererMode,
  UnixMs,
} from "./base";

export interface StreamError {
  code: string;
  message: string;
}

export interface StreamSessionMeta {
  requestId: RequestId;
  conversationId: ConversationId;
  branchId: BranchId;
  targetMessageId: MessageId;

  status: "starting" | "streaming" | "completed" | "failed" | "cancelled";

  rendererMode: StreamRendererMode;

  startedAt: UnixMs;
  lastChunkAt: UnixMs | null;
  lastFlushAt: UnixMs | null;

  chunkCount: number;
  visibleVersion: number;
  visibleCharCount: number;

  error?: StreamError;
}

/**
 * 命令式文本 surface 适配层
 * 你可以用 pretext 来实现，也可以先用原生 TextNode fallback
 */
export interface ImperativeTextSurface {
  mount(container: HTMLElement): void;
  append(chunk: string): void;
  replaceAll(text: string): void;
  destroy(): void;
}

/**
 * 非序列化 runtime 状态
 * 不要放进 Zustand
 */
export interface StreamRuntimeSession {
  requestId: RequestId;

  /**
   * 用 chunk 数组而不是不断 text += chunk
   * 避免超长文本下的字符串拼接成本
   */
  chunks: string[];
  totalChars: number;

  surface: ImperativeTextSurface | null;

  flushTimer: number | null;
  lastEmitAt: UnixMs | null;

  /**
   * 只有用户接近底部时才自动跟随滚动
   */
  shouldStickToBottom: boolean;
}
```

---

## 1.7 `types/internal.ts`

建议增加一个内部 helper type，专门用来统一发送逻辑。

```ts
import {
  BranchId,
  ConversationId,
  ForkSourceType,
  MessageId,
} from "./base";

export interface SendPlan {
  conversationId: ConversationId;

  /**
   * 当前发起动作的路径
   */
  sourceBranchId: BranchId;

  /**
   * 真正写入消息的目标路径
   * append 时可能等于 sourceBranchId
   * fork 时是新 branch
   */
  targetBranchId: BranchId;

  /**
   * 新用户消息挂在哪个 parent 上
   */
  targetParentMessageId: MessageId | null;

  /**
   * 如果发送前需要先创建 branch，则在这里描述
   */
  createBranch?:
    | {
        sourceType: ForkSourceType;
        forkPointMessageId: MessageId | null;
        forkSourceMessageId: MessageId | null;
      }
    | undefined;

  /**
   * 历史用户消息编辑场景
   */
  editedFromMessageId?: MessageId;

  /**
   * 基于某个 variant 继续的场景
   */
  continueFromVariantMessageId?: MessageId;
}
```

---

# 二、Zustand Store 设计草案

我建议你不要只用一个 store。

最稳的方案是：

# 2.1 Store 总体拆分

## A. `useAppStore`
存：
- 启动状态
- 设置
- 会话摘要
- 当前会话 snapshot
- 工作区状态
- composer 状态
- UI 状态

## B. `useStreamStore`
存：
- 流式会话元数据
- 轻量 visibleVersion / visibleCharCount
- requestId 与 targetMessageId 关系

## C. `streamRuntimeRegistry`
存：
- chunk 数组
- flush timer
- pretext / dom-text surface 句柄

> **不要把 runtime chunk buffer 放进 Zustand**
> 这是最关键的一条。

---

继续。下面我把 **Zustand Store 设计草案**完整补上，并重点加入：

- **如何组织 slice**
- **如何避免流式更新导致 React 频繁重渲染**
- **如何结合 pretext 做“命令式流式文本 surface”**
- **哪些状态进 Zustand，哪些绝对不能进 Zustand**

---

# 二、Zustand Store 设计草案（续）

## 2.2 `stores/appStore.ts`

### Store 接口定义

```ts
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import {
  BranchEntity,
  BranchId,
  ConversationId,
  ConversationSnapshot,
  ConversationSummary,
  MessageId,
  MessageNode,
} from "../types/conversation";
import {
  CompareState,
  ComposerState,
  ForkIntent,
  UiState,
  VariantPreviewContext,
  WorkspaceState,
} from "../types/workspace";
import { ModelId, ProviderConfig } from "../types/settings";

export interface AppSlice {
  bootStatus: "idle" | "loading" | "ready" | "failed";
  bootError?: string;

  initializeApp: () => Promise<void>;
  restoreLastWorkspace: () => Promise<void>;
}

export interface SettingsSlice {
  providers: Record<string, ProviderConfig>;
  providerOrder: string[];
  defaultModelId: ModelId | null;

  loadSettings: () => Promise<void>;
  saveProvider: (provider: ProviderConfig) => Promise<void>;
  removeProvider: (providerId: string) => Promise<void>;
  setDefaultModel: (modelId: ModelId) => Promise<void>;
}

export interface ConversationSlice {
  summariesById: Record<ConversationId, ConversationSummary>;
  summaryOrder: ConversationId[];

  /**
   * v1 推荐只缓存当前打开会话的完整 snapshot
   * 其他会话只保留 summary，防止 Zustand 体积膨胀
   */
  activeSnapshot: ConversationSnapshot | null;
  activeSnapshotStatus: "idle" | "loading" | "ready" | "failed";
  activeSnapshotError?: string;

  loadConversationSummaries: () => Promise<void>;
  createConversation: () => Promise<ConversationId>;
  openConversation: (conversationId: ConversationId) => Promise<void>;
  renameConversation: (conversationId: ConversationId, title: string) => Promise<void>;
  archiveConversation: (conversationId: ConversationId) => Promise<void>;
  deleteConversation: (conversationId: ConversationId) => Promise<void>;

  upsertMessageLocal: (message: MessageNode) => void;
  upsertBranchLocal: (branch: BranchEntity) => void;
  patchMessageLocal: (messageId: MessageId, patch: Partial<MessageNode>) => void;
  patchBranchLocal: (branchId: BranchId, patch: Partial<BranchEntity>) => void;
  replaceActiveSnapshot: (snapshot: ConversationSnapshot) => void;
}

export interface WorkspaceSlice {
  workspace: WorkspaceState;

  setActiveConversation: (conversationId: ConversationId | null) => void;
  setCurrentBranch: (branchId: BranchId | null) => void;
  setWorkspaceMode: (mode: WorkspaceState["workspaceMode"]) => void;

  startHistoryFork: (intent: ForkIntent) => void;
  startEditFork: (intent: ForkIntent) => void;
  clearForkIntent: () => void;

  enterCompare: (compareState: CompareState) => void;
  exitCompare: () => void;

  setVariantPreview: (ctx: VariantPreviewContext | null) => void;
  setPendingConvergeCount: (count: number) => void;
}

export interface ComposerSlice {
  composer: ComposerState;

  setDraft: (draft: string) => void;
  clearDraft: () => void;
  setSelectedModelId: (modelId: ModelId | null) => void;
  setSendMode: (mode: ComposerState["sendMode"]) => void;
  patchParams: (patch: Partial<ComposerState["params"]>) => void;

  setSendingState: (patch: Partial<Pick<ComposerState, "isSending" | "activeRequestId">>) => void;
  resetComposerAfterSend: () => void;
}

export interface UiSlice {
  ui: UiState;

  setLeftSidebarCollapsed: (collapsed: boolean) => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  setRightPanelTab: (tab: UiState["rightPanelTab"]) => void;

  openExportDialog: () => void;
  closeExportDialog: () => void;
  openBranchRenameDialog: () => void;
  closeBranchRenameDialog: () => void;
}

export type AppStore = AppSlice &
  SettingsSlice &
  ConversationSlice &
  WorkspaceSlice &
  ComposerSlice &
  UiSlice;
```

---

## 2.3 `useAppStore` 实现草案

这里先给一个结构范式，不把全部 service 细节写死。

```ts
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import type { AppStore } from "./appStore.types";
import * as conversationService from "../services/conversationService";
import * as settingsService from "../services/settingsService";
import * as workspaceService from "../services/workspaceService";

const initialWorkspace = {
  activeConversationId: null,
  currentBranchId: null,
  workspaceMode: "normal" as const,
  forkIntent: null,
  compareState: null,
  variantPreview: null,
  pendingConvergeCount: 0,
};

const initialComposer = {
  draft: "",
  selectedModelId: null,
  sendMode: "append" as const,
  params: { stream: true, temperature: 0.7 },
  isSending: false,
  activeRequestId: null,
};

const initialUi = {
  leftSidebarCollapsed: false,
  rightPanelCollapsed: false,
  rightPanelTab: "branches" as const,
  exportDialogOpen: false,
  branchRenameDialogOpen: false,
};

export const useAppStore = create<AppStore>()(
  devtools(
    subscribeWithSelector(
      immer((set, get) => ({
        // AppSlice
        bootStatus: "idle",
        bootError: undefined,

        initializeApp: async () => {
          set((s) => {
            s.bootStatus = "loading";
            s.bootError = undefined;
          });

          try {
            await Promise.all([
              get().loadSettings(),
              get().loadConversationSummaries(),
            ]);

            set((s) => {
              s.bootStatus = "ready";
            });
          } catch (err: any) {
            set((s) => {
              s.bootStatus = "failed";
              s.bootError = err?.message ?? "Failed to initialize app";
            });
          }
        },

        restoreLastWorkspace: async () => {
          const restored = await workspaceService.restoreLastWorkspace();
          if (!restored) return;

          const { conversationId, branchId } = restored;
          await get().openConversation(conversationId);
          get().setActiveConversation(conversationId);
          get().setCurrentBranch(branchId);
        },

        // SettingsSlice
        providers: {},
        providerOrder: [],
        defaultModelId: null,

        loadSettings: async () => {
          const settings = await settingsService.loadSettings();
          set((s) => {
            s.providers = settings.providers;
            s.providerOrder = settings.providerOrder;
            s.defaultModelId = settings.defaultModelId;
            s.composer.selectedModelId = settings.defaultModelId;
          });
        },

        saveProvider: async (provider) => {
          await settingsService.saveProvider(provider);
          set((s) => {
            s.providers[provider.id] = provider;
            if (!s.providerOrder.includes(provider.id)) {
              s.providerOrder.push(provider.id);
            }
          });
        },

        removeProvider: async (providerId) => {
          await settingsService.removeProvider(providerId);
          set((s) => {
            delete s.providers[providerId];
            s.providerOrder = s.providerOrder.filter((id) => id !== providerId);
          });
        },

        setDefaultModel: async (modelId) => {
          await settingsService.setDefaultModel(modelId);
          set((s) => {
            s.defaultModelId = modelId;
            s.composer.selectedModelId = modelId;
          });
        },

        // ConversationSlice
        summariesById: {},
        summaryOrder: [],
        activeSnapshot: null,
        activeSnapshotStatus: "idle",
        activeSnapshotError: undefined,

        loadConversationSummaries: async () => {
          const summaries = await conversationService.listConversationSummaries();
          set((s) => {
            s.summariesById = Object.fromEntries(summaries.map((x) => [x.id, x]));
            s.summaryOrder = summaries.map((x) => x.id);
          });
        },

        createConversation: async () => {
          const summary = await conversationService.createConversation();
          set((s) => {
            s.summariesById[summary.id] = summary;
            s.summaryOrder.unshift(summary.id);
          });
          return summary.id;
        },

        openConversation: async (conversationId) => {
          set((s) => {
            s.activeSnapshotStatus = "loading";
            s.activeSnapshotError = undefined;
          });

          try {
            const snapshot = await conversationService.loadConversationSnapshot(conversationId);
            set((s) => {
              s.activeSnapshot = snapshot;
              s.activeSnapshotStatus = "ready";
            });
          } catch (err: any) {
            set((s) => {
              s.activeSnapshotStatus = "failed";
              s.activeSnapshotError = err?.message ?? "Failed to load conversation";
            });
          }
        },

        renameConversation: async (conversationId, title) => {
          await conversationService.renameConversation(conversationId, title);
          set((s) => {
            if (s.summariesById[conversationId]) {
              s.summariesById[conversationId].title = title;
              s.summariesById[conversationId].updatedAt = Date.now();
            }
            if (s.activeSnapshot?.summary.id === conversationId) {
              s.activeSnapshot.summary.title = title;
              s.activeSnapshot.summary.updatedAt = Date.now();
            }
          });
        },

        archiveConversation: async (conversationId) => {
          await conversationService.archiveConversation(conversationId);
          // v1 可只刷新 summaries
          await get().loadConversationSummaries();
        },

        deleteConversation: async (conversationId) => {
          await conversationService.deleteConversation(conversationId);
          set((s) => {
            delete s.summariesById[conversationId];
            s.summaryOrder = s.summaryOrder.filter((id) => id !== conversationId);
            if (s.workspace.activeConversationId === conversationId) {
              s.workspace.activeConversationId = null;
              s.workspace.currentBranchId = null;
              s.activeSnapshot = null;
            }
          });
        },

        upsertMessageLocal: (message) => {
          set((s) => {
            if (!s.activeSnapshot) return;
            s.activeSnapshot.entities.messages[message.id] = message;
            if (message.parentId) {
              const children = s.activeSnapshot.indexes.childMessageIdsByParentId[message.parentId] ?? [];
              if (!children.includes(message.id)) {
                children.push(message.id);
                s.activeSnapshot.indexes.childMessageIdsByParentId[message.parentId] = children;
              }
            } else {
              if (!s.activeSnapshot.indexes.rootMessageIds.includes(message.id)) {
                s.activeSnapshot.indexes.rootMessageIds.push(message.id);
              }
            }
          });
        },

        upsertBranchLocal: (branch) => {
          set((s) => {
            if (!s.activeSnapshot) return;
            s.activeSnapshot.entities.branches[branch.id] = branch;
            if (branch.forkPointMessageId) {
              const ids =
                s.activeSnapshot.indexes.branchIdsByForkPointId[branch.forkPointMessageId] ?? [];
              if (!ids.includes(branch.id)) {
                ids.push(branch.id);
                s.activeSnapshot.indexes.branchIdsByForkPointId[branch.forkPointMessageId] = ids;
              }
            }
          });
        },

        patchMessageLocal: (messageId, patch) => {
          set((s) => {
            if (!s.activeSnapshot?.entities.messages[messageId]) return;
            Object.assign(s.activeSnapshot.entities.messages[messageId], patch);
          });
        },

        patchBranchLocal: (branchId, patch) => {
          set((s) => {
            if (!s.activeSnapshot?.entities.branches[branchId]) return;
            Object.assign(s.activeSnapshot.entities.branches[branchId], patch);
          });
        },

        replaceActiveSnapshot: (snapshot) => {
          set((s) => {
            s.activeSnapshot = snapshot;
            s.activeSnapshotStatus = "ready";
            s.activeSnapshotError = undefined;
          });
        },

        // WorkspaceSlice
        workspace: initialWorkspace,

        setActiveConversation: (conversationId) => {
          set((s) => {
            s.workspace.activeConversationId = conversationId;
          });
        },

        setCurrentBranch: (branchId) => {
          set((s) => {
            s.workspace.currentBranchId = branchId;
          });
        },

        setWorkspaceMode: (mode) => {
          set((s) => {
            s.workspace.workspaceMode = mode;
          });
        },

        startHistoryFork: (intent) => {
          set((s) => {
            s.workspace.forkIntent = intent;
            s.workspace.workspaceMode = "historyFork";
          });
        },

        startEditFork: (intent) => {
          set((s) => {
            s.workspace.forkIntent = intent;
            s.workspace.workspaceMode = "editFork";
          });
        },

        clearForkIntent: () => {
          set((s) => {
            s.workspace.forkIntent = null;
            s.workspace.workspaceMode = "normal";
          });
        },

        enterCompare: (compareState) => {
          set((s) => {
            s.workspace.compareState = compareState;
            s.workspace.workspaceMode = "compare";
          });
        },

        exitCompare: () => {
          set((s) => {
            s.workspace.compareState = null;
            s.workspace.workspaceMode = "normal";
          });
        },

        setVariantPreview: (ctx) => {
          set((s) => {
            s.workspace.variantPreview = ctx;
          });
        },

        setPendingConvergeCount: (count) => {
          set((s) => {
            s.workspace.pendingConvergeCount = count;
          });
        },

        // ComposerSlice
        composer: initialComposer,

        setDraft: (draft) => {
          set((s) => {
            s.composer.draft = draft;
          });
        },

        clearDraft: () => {
          set((s) => {
            s.composer.draft = "";
          });
        },

        setSelectedModelId: (modelId) => {
          set((s) => {
            s.composer.selectedModelId = modelId;
          });
        },

        setSendMode: (mode) => {
          set((s) => {
            s.composer.sendMode = mode;
          });
        },

        patchParams: (patch) => {
          set((s) => {
            Object.assign(s.composer.params, patch);
          });
        },

        setSendingState: (patch) => {
          set((s) => {
            Object.assign(s.composer, patch);
          });
        },

        resetComposerAfterSend: () => {
          set((s) => {
            s.composer.draft = "";
            s.composer.sendMode = "append";
            s.composer.isSending = false;
            s.composer.activeRequestId = null;
          });
        },

        // UiSlice
        ui: initialUi,

        setLeftSidebarCollapsed: (collapsed) => {
          set((s) => {
            s.ui.leftSidebarCollapsed = collapsed;
          });
        },

        setRightPanelCollapsed: (collapsed) => {
          set((s) => {
            s.ui.rightPanelCollapsed = collapsed;
          });
        },

        setRightPanelTab: (tab) => {
          set((s) => {
            s.ui.rightPanelTab = tab;
          });
        },

        openExportDialog: () => {
          set((s) => {
            s.ui.exportDialogOpen = true;
          });
        },

        closeExportDialog: () => {
          set((s) => {
            s.ui.exportDialogOpen = false;
          });
        },

        openBranchRenameDialog: () => {
          set((s) => {
            s.ui.branchRenameDialogOpen = true;
          });
        },

        closeBranchRenameDialog: () => {
          set((s) => {
            s.ui.branchRenameDialogOpen = false;
          });
        },
      }))
    )
  )
);
```

---

# 三、专门的流式 Store 设计

这个部分是重点。
**如果你把流式文本直接堆进 `activeSnapshot.entities.messages[text]`，你会很快卡住。**

---

## 3.1 为什么不能每个 chunk 都写 message.content.text

因为每来一个 chunk：

- Zustand state 变了
- React 依赖这个 message 的组件 rerender
- 可能整个列表 re-render
- markdown 重新 parse
- syntax highlight 重新执行
- 自动滚动逻辑重新测量

结果就是：
- 长回答越来越卡
- CPU 飙升
- 滚动抖动
- 中文输入 / 生成同时发生时掉帧

---

## 3.2 正确结构：双层流式架构

```text
Model Stream
→ StreamController
→ StreamRuntimeRegistry (chunks, timers, imperative surface)
→ useStreamStore (meta only, low frequency)
→ onCompleted => commit final text to appStore.activeSnapshot
```

---

## 3.3 `stores/streamStore.ts`

```ts
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { StreamSessionMeta } from "../types/stream";
import { MessageId, RequestId } from "../types/base";

interface StreamStore {
  sessionsByRequestId: Record<RequestId, StreamSessionMeta>;
  requestIdByMessageId: Record<MessageId, RequestId>;

  createSession: (meta: StreamSessionMeta) => void;
  patchSession: (
    requestId: RequestId,
    patch: Partial<StreamSessionMeta>
  ) => void;
  completeSession: (requestId: RequestId) => void;
  failSession: (requestId: RequestId, error: { code: string; message: string }) => void;
  removeSession: (requestId: RequestId) => void;
}

export const useStreamStore = create<StreamStore>()(
  devtools((set) => ({
    sessionsByRequestId: {},
    requestIdByMessageId: {},

    createSession: (meta) =>
      set((s) => ({
        sessionsByRequestId: {
          ...s.sessionsByRequestId,
          [meta.requestId]: meta,
        },
        requestIdByMessageId: {
          ...s.requestIdByMessageId,
          [meta.targetMessageId]: meta.requestId,
        },
      })),

    patchSession: (requestId, patch) =>
      set((s) => ({
        sessionsByRequestId: {
          ...s.sessionsByRequestId,
          [requestId]: {
            ...s.sessionsByRequestId[requestId],
            ...patch,
          },
        },
      })),

    completeSession: (requestId) =>
      set((s) => ({
        sessionsByRequestId: {
          ...s.sessionsByRequestId,
          [requestId]: {
            ...s.sessionsByRequestId[requestId],
            status: "completed",
          },
        },
      })),

    failSession: (requestId, error) =>
      set((s) => ({
        sessionsByRequestId: {
          ...s.sessionsByRequestId,
          [requestId]: {
            ...s.sessionsByRequestId[requestId],
            status: "failed",
            error,
          },
        },
      })),

    removeSession: (requestId) =>
      set((s) => {
        const next = { ...s.sessionsByRequestId };
        const targetMessageId = next[requestId]?.targetMessageId;
        delete next[requestId];

        const nextMap = { ...s.requestIdByMessageId };
        if (targetMessageId) delete nextMap[targetMessageId];

        return {
          sessionsByRequestId: next,
          requestIdByMessageId: nextMap,
        };
      }),
  }))
);
```

---

# 四、streamRuntimeRegistry：不要进 Zustand

这是最关键的性能层。

---

## 4.1 `streamRuntimeRegistry.ts`

```ts
import { RequestId } from "../types/base";
import { StreamRuntimeSession } from "../types/stream";

const registry = new Map<RequestId, StreamRuntimeSession>();

export function getRuntimeSession(requestId: RequestId) {
  return registry.get(requestId) ?? null;
}

export function setRuntimeSession(session: StreamRuntimeSession) {
  registry.set(session.requestId, session);
}

export function deleteRuntimeSession(requestId: RequestId) {
  const session = registry.get(requestId);
  if (session?.flushTimer) {
    window.clearTimeout(session.flushTimer);
  }
  session?.surface?.destroy();
  registry.delete(requestId);
}
```

---

# 五、结合 pretext 的推荐接入方式

你提到 pretext，我建议采用这种方式：

> **封装一个 `ImperativeTextSurface` adapter**
>
> 这样你可以：
> - 有 pretext 就走 pretext
> - 没有或 API 不稳定就 fallback 到 DOM text node
> - React 层完全不用知道底层具体怎么 append

---

## 5.1 统一接口

前面已定义：

```ts
export interface ImperativeTextSurface {
  mount(container: HTMLElement): void;
  append(chunk: string): void;
  replaceAll(text: string): void;
  destroy(): void;
}
```

---

## 5.2 Fallback：原生 DOM TextNode surface

先给你一个一定能跑的版本。

```ts
export class DomTextSurface implements ImperativeTextSurface {
  private container: HTMLElement | null = null;
  private textNode: Text | null = null;

  mount(container: HTMLElement) {
    this.container = container;
    container.innerHTML = "";
    this.textNode = document.createTextNode("");
    container.appendChild(this.textNode);
  }

  append(chunk: string) {
    if (!this.textNode) return;
    this.textNode.data += chunk;
  }

  replaceAll(text: string) {
    if (!this.textNode) return;
    this.textNode.data = text;
  }

  destroy() {
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.container = null;
    this.textNode = null;
  }
}
```

这个虽然简单，但已经比“每个 token setState + rerender markdown”强很多。

---

## 5.3 Pretext adapter 结构

我不知道你那边会用 pretext 的哪个实际 API，所以给你一个 adapter 模板。

```ts
import { ImperativeTextSurface } from "../types/stream";

export class PretextSurfaceAdapter implements ImperativeTextSurface {
  private container: HTMLElement | null = null;
  private instance: any = null;

  mount(container: HTMLElement) {
    this.container = container;
    container.innerHTML = "";

    // 这里替换成 pretext 的真实初始化逻辑
    // 例如：
    // this.instance = createPretextSurface(container)
    this.instance = this.createPretextInstance(container);
  }

  append(chunk: string) {
    if (!this.instance) return;

    // 这里替换成 pretext 的真实 append API
    // this.instance.append(chunk)
    this.instance.append(chunk);
  }

  replaceAll(text: string) {
    if (!this.instance) return;

    // this.instance.setText(text)
    this.instance.replaceAll?.(text) ?? this.instance.setText?.(text);
  }

  destroy() {
    // this.instance.destroy?.()
    this.instance?.destroy?.();
    this.instance = null;

    if (this.container) {
      this.container.innerHTML = "";
    }
    this.container = null;
  }

  private createPretextInstance(container: HTMLElement) {
    // TODO: 替换成 pretext 实际 API
    return {
      append(chunk: string) {
        container.textContent = (container.textContent ?? "") + chunk;
      },
      replaceAll(text: string) {
        container.textContent = text;
      },
      destroy() {
        container.innerHTML = "";
      },
    };
  }
}
```

---

## 5.4 surface 工厂

```ts
import { ImperativeTextSurface, StreamRendererMode } from "../types/stream";
import { DomTextSurface } from "./DomTextSurface";
import { PretextSurfaceAdapter } from "./PretextSurfaceAdapter";

export function createTextSurface(mode: StreamRendererMode): ImperativeTextSurface {
  if (mode === "pretext") {
    return new PretextSurfaceAdapter();
  }
  return new DomTextSurface();
}
```

---

# 六、流式控制器设计

这个控制器是关键。
它负责：

- 创建 placeholder assistant message
- 创建 stream session
- 增量 chunk 不直接进 React
- 按节流刷新 imperative surface
- 完成后一次性提交 final text 到 appStore

---

## 6.1 核心思路

```text
send()
→ 创建 assistant 占位消息(status=streaming, text="")
→ MessageBubble 检测到该 message 有 stream session
→ 挂载 ImperativeTextSurface
→ chunk 到达时 append 到 runtime buffer
→ 按帧/按 16~40ms flush 到 surface
→ stream 完成
→ 将 buffer.join("") 一次性写回 message.content.text
→ message.status = completed
→ 移除 stream session
→ Bubble 切换为 MarkdownRenderer
```

---

## 6.2 `services/streamController.ts`

```ts
import { nanoid } from "nanoid";
import { useAppStore } from "../stores/appStore";
import { useStreamStore } from "../stores/streamStore";
import { setRuntimeSession, getRuntimeSession, deleteRuntimeSession } from "./streamRuntimeRegistry";
import { createTextSurface } from "./surfaceFactory";
import type { BranchId, ConversationId, MessageId, RequestId } from "../types/base";
import * as conversationService from "./conversationService";
import * as modelClient from "./modelClient";

const FLUSH_INTERVAL_MS = 24;

export async function startAssistantStream(params: {
  conversationId: ConversationId;
  branchId: BranchId;
  parentMessageId: MessageId;
  providerId: string;
  modelId: string;
  promptMessages: Array<{ role: string; content: string }>;
  rendererMode?: "pretext" | "dom-text";
}) {
  const requestId: RequestId = nanoid();
  const assistantMessageId: MessageId = nanoid();
  const now = Date.now();

  // 1) 本地先创建占位 assistant message
  useAppStore.getState().upsertMessageLocal({
    id: assistantMessageId,
    conversationId: params.conversationId,
    role: "assistant",
    status: "streaming",
    parentId: params.parentMessageId,
    childIds: [],
    depth: 0, // 可由 service 计算后返回更准确值
    content: { text: "", format: "markdown" },
    createdAt: now,
    updatedAt: now,
    generation: {
      providerId: params.providerId,
      modelId: params.modelId,
      requestId,
    },
  });

  // 2) stream store 写轻量元数据
  useStreamStore.getState().createSession({
    requestId,
    conversationId: params.conversationId,
    branchId: params.branchId,
    targetMessageId: assistantMessageId,
    status: "starting",
    rendererMode: params.rendererMode ?? "pretext",
    startedAt: now,
    lastChunkAt: null,
    lastFlushAt: null,
    chunkCount: 0,
    visibleVersion: 0,
    visibleCharCount: 0,
  });

  // 3) runtime session
  setRuntimeSession({
    requestId,
    chunks: [],
    totalChars: 0,
    surface: null,
    flushTimer: null,
    lastEmitAt: null,
    shouldStickToBottom: true,
  });

  // 4) 标记 composer 状态
  useAppStore.getState().setSendingState({
    isSending: true,
    activeRequestId: requestId,
  });

  useStreamStore.getState().patchSession(requestId, {
    status: "streaming",
  });

  try {
    for await (const chunk of modelClient.streamChatCompletion({
      providerId: params.providerId,
      modelId: params.modelId,
      messages: params.promptMessages,
    })) {
      onStreamChunk(requestId, chunk);
    }

    await completeStream(requestId);
  } catch (err: any) {
    await failStream(requestId, {
      code: "STREAM_FAILED",
      message: err?.message ?? "Streaming failed",
    });
  }

  return { requestId, assistantMessageId };
}
```

---

## 6.3 chunk 处理：节流 flush，不频繁 setState

```ts
export function onStreamChunk(requestId: RequestId, chunk: string) {
  const runtime = getRuntimeSession(requestId);
  if (!runtime) return;

  runtime.chunks.push(chunk);
  runtime.totalChars += chunk.length;

  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  if (!session) return;

  useStreamStore.getState().patchSession(requestId, {
    chunkCount: session.chunkCount + 1,
    lastChunkAt: Date.now(),
  });

  if (runtime.surface) {
    scheduleFlush(requestId);
  }
}

function scheduleFlush(requestId: RequestId) {
  const runtime = getRuntimeSession(requestId);
  if (!runtime || runtime.flushTimer != null) return;

  runtime.flushTimer = window.setTimeout(() => {
    runtime.flushTimer = null;
    flushToSurface(requestId);
  }, FLUSH_INTERVAL_MS);
}

function flushToSurface(requestId: RequestId) {
  const runtime = getRuntimeSession(requestId);
  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  if (!runtime || !session || !runtime.surface) return;

  const allText = runtime.chunks.join("");
  runtime.surface.replaceAll(allText);

  useStreamStore.getState().patchSession(requestId, {
    lastFlushAt: Date.now(),
    visibleVersion: session.visibleVersion + 1,
    visibleCharCount: runtime.totalChars,
  });

  runtime.lastEmitAt = Date.now();
}
```

> 这里用了 `replaceAll(allText)`，是最稳的通用方案。
> 如果 pretext 支持真正高效的 append 增量能力，你可以升级成：
> - 记录上次 flush 到第几个 chunk
> - 只 append 新 chunk
> 但架构不变。

---

## 6.4 挂载 surface

React 组件只负责把 container DOM 交给 runtime session。

```ts
export function attachSurfaceToRequest(
  requestId: RequestId,
  container: HTMLElement,
  mode: "pretext" | "dom-text"
) {
  const runtime = getRuntimeSession(requestId);
  if (!runtime) return;

  if (runtime.surface) {
    runtime.surface.destroy();
  }

  const surface = createTextSurface(mode);
  surface.mount(container);

  runtime.surface = surface;

  // 如果在挂载前已经有 chunk，立即补刷
  if (runtime.chunks.length > 0) {
    surface.replaceAll(runtime.chunks.join(""));
  }
}
```

---

## 6.5 完成流式：一次性提交最终文本

```ts
async function completeStream(requestId: RequestId) {
  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  const runtime = getRuntimeSession(requestId);
  if (!session || !runtime) return;

  const finalText = runtime.chunks.join("");
  const now = Date.now();

  // 1) 先写数据库
  await conversationService.completeAssistantMessage({
    conversationId: session.conversationId,
    messageId: session.targetMessageId,
    finalText,
    status: "completed",
    updatedAt: now,
  });

  // 2) 再写 app store
  useAppStore.getState().patchMessageLocal(session.targetMessageId, {
    status: "completed",
    updatedAt: now,
    content: {
      text: finalText,
      format: "markdown",
    },
  });

  // 3) 更新 session
  useStreamStore.getState().completeSession(requestId);

  // 4) 清 composer
  useAppStore.getState().setSendingState({
    isSending: false,
    activeRequestId: null,
  });

  // 5) 清 runtime
  deleteRuntimeSession(requestId);

  // 6) 可以稍后清理 stream store
  window.setTimeout(() => {
    useStreamStore.getState().removeSession(requestId);
  }, 1500);
}
```

---

## 6.6 失败流式

```ts
async function failStream(
  requestId: RequestId,
  error: { code: string; message: string }
) {
  const session = useStreamStore.getState().sessionsByRequestId[requestId];
  if (!session) return;

  const runtime = getRuntimeSession(requestId);
  const partialText = runtime?.chunks.join("") ?? "";
  const now = Date.now();

  await conversationService.failAssistantMessage({
    conversationId: session.conversationId,
    messageId: session.targetMessageId,
    partialText,
    error,
    updatedAt: now,
  });

  useAppStore.getState().patchMessageLocal(session.targetMessageId, {
    status: "failed",
    updatedAt: now,
    content: {
      text: partialText,
      format: "markdown",
    },
    error: {
      code: error.code,
      message: error.message,
      retriable: true,
    },
  });

  useStreamStore.getState().failSession(requestId, error);

  useAppStore.getState().setSendingState({
    isSending: false,
    activeRequestId: null,
  });

  deleteRuntimeSession(requestId);
}
```

---

# 七、React 组件如何接入 streaming surface

---

## 7.1 `StreamingAssistantContent.tsx`

```tsx
import { useEffect, useRef } from "react";
import { useStreamStore } from "../stores/streamStore";
import { attachSurfaceToRequest } from "../services/streamController";

interface Props {
  requestId: string;
  rendererMode: "pretext" | "dom-text";
}

export function StreamingAssistantContent({ requestId, rendererMode }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const session = useStreamStore((s) => s.sessionsByRequestId[requestId]);

  useEffect(() => {
    if (!ref.current || !session) return;
    attachSurfaceToRequest(requestId, ref.current, rendererMode);
  }, [requestId, rendererMode, session]);

  return (
    <div
      ref={ref}
      className="streaming-surface whitespace-pre-wrap break-words"
      data-request-id={requestId}
    />
  );
}
```

### 核心点
这个组件**不会**因为每个 chunk 而 rerender。
它只在：
- mounted
- requestId 变化
- session 存在时
才处理一次。

后续 chunk 更新走 imperative surface。

---

## 7.2 在 `AssistantMessageBubble` 中切换渲染模式

```tsx
import { useStreamStore } from "../stores/streamStore";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { StreamingAssistantContent } from "./StreamingAssistantContent";
import type { MessageNode } from "../types/conversation";

export function AssistantMessageBubble({ message }: { message: MessageNode }) {
  const requestId = message.generation?.requestId;
  const session = useStreamStore((s) =>
    requestId ? s.sessionsByRequestId[requestId] : undefined
  );

  const isStreaming = message.status === "streaming" && requestId && session;

  if (isStreaming) {
    return (
      <StreamingAssistantContent
        requestId={requestId}
        rendererMode={session.rendererMode}
      />
    );
  }

  return <MarkdownRenderer content={message.content.text} />;
}
```

---

# 八、为什么这种方案能避免“前端渲染灾难”

这是你特别关心的点，我总结成 6 条。

## 8.1 React 不再承接 token 级状态更新
- chunk 不进组件 state
- chunk 不进 appStore message.text
- 只进 runtime registry

## 8.2 Zustand 只承接低频元数据
- `chunkCount`
- `visibleVersion`
- `status`
- `lastChunkAt`

这些不会触发重型 markdown 重渲染。

## 8.3 Markdown 只在“完成后”渲染一次
这是最大优化来源。

流式时：
- 用 pretext / text surface 展示纯文本

完成后：
- 再转 MarkdownRenderer

## 8.4 长文本字符串操作减少
runtime 里用 `chunks: string[]`
最后才 `join("")`

避免不停：
```ts
text += chunk
```
这种在长文本下的重复拷贝。

## 8.5 滚动逻辑可独立处理
因为 surface 是命令式更新，你可以：
- 只在用户接近底部时自动 scroll
- 用户向上查看历史时暂停 stick-to-bottom

## 8.6 列表不会因为 token 更新而整体重算
消息列表保持稳定，只有 streaming 消息内部 surface 在变。

---

# 九、Selectors 设计建议

为了配合 Zustand 使用，建议把“当前路径消息”做成 selector，且**返回稳定结构**。

---

## 9.1 `selectors/conversationSelectors.ts`

```ts
import { AppStore } from "../stores/appStore.types";
import { BranchId, ConversationId, MessageId } from "../types/base";
import { MessageNode } from "../types/conversation";

export function selectActiveSnapshot(state: AppStore) {
  return state.activeSnapshot;
}

export function selectCurrentConversationSummary(state: AppStore) {
  return state.activeSnapshot?.summary ?? null;
}

export function selectCurrentBranch(state: AppStore) {
  const snapshot = state.activeSnapshot;
  const branchId = state.workspace.currentBranchId;
  if (!snapshot || !branchId) return null;
  return snapshot.entities.branches[branchId] ?? null;
}
```

---

## 9.2 当前路径消息 selector

```ts
export function selectCurrentPathMessages(state: AppStore): MessageNode[] {
  const snapshot = state.activeSnapshot;
  const branchId = state.workspace.currentBranchId;
  if (!snapshot || !branchId) return [];

  const branch = snapshot.entities.branches[branchId];
  if (!branch?.headMessageId) return [];

  const result: MessageNode[] = [];
  let cursor: MessageId | null = branch.headMessageId;

  while (cursor) {
    const msg = snapshot.entities.messages[cursor];
    if (!msg) break;
    result.push(msg);
    cursor = msg.parentId;
  }

  return result.reverse();
}
```

---

## 9.3 历史模式可见消息 selector

```ts
export function selectVisibleMessagesForWorkspace(state: AppStore): MessageNode[] {
  const snapshot = state.activeSnapshot;
  const branchId = state.workspace.currentBranchId;
  if (!snapshot || !branchId) return [];

  const fullPath = selectCurrentPathMessages(state);

  if (state.workspace.workspaceMode === "normal") {
    return fullPath;
  }

  const sourceMessageId = state.workspace.forkIntent?.sourceMessageId;
  if (!sourceMessageId) return fullPath;

  const index = fullPath.findIndex((m) => m.id === sourceMessageId);
  if (index < 0) return fullPath;

  return fullPath.slice(0, index + 1);
}
```

---

## 9.4 variant 组 selector

```ts
export function selectVariantGroupByUserMessageId(
  state: AppStore,
  userMessageId: MessageId
): MessageId[] {
  const snapshot = state.activeSnapshot;
  if (!snapshot) return [];

  const childIds = snapshot.indexes.childMessageIdsByParentId[userMessageId] ?? [];
  return childIds.filter((id) => snapshot.entities.messages[id]?.role === "assistant");
}
```

---

## 9.5 分支健康 selector

```ts
export function selectBranchHealth(state: AppStore) {
  const snapshot = state.activeSnapshot;
  const currentBranchId = state.workspace.currentBranchId;
  if (!snapshot || !currentBranchId) {
    return {
      siblingCount: 0,
      activeCount: 0,
      needsWarning: false,
      level: "none" as const,
    };
  }

  const currentBranch = snapshot.entities.branches[currentBranchId];
  const allBranches = Object.values(snapshot.entities.branches);
  const activeBranches = allBranches.filter((b) => b.status === "active");

  const siblingCount = allBranches.filter(
    (b) =>
      b.status === "active" &&
      b.forkPointMessageId &&
      b.forkPointMessageId === currentBranch.forkPointMessageId
  ).length;

  const activeCount = activeBranches.length;

  let level: "none" | "soft" | "strong" = "none";
  if (siblingCount > 4 || activeCount > 8) level = "soft";
  if (siblingCount > 6 || activeCount > 12) level = "strong";

  return {
    siblingCount,
    activeCount,
    needsWarning: level !== "none",
    level,
  };
}
```

---

# 十、发送动作 Action 层草案

我建议把发送逻辑封装成 feature action，而不是直接写在组件里。

---

## 10.1 `features/composer/sendMessage.ts`

```ts
import { nanoid } from "nanoid";
import { useAppStore } from "../../stores/appStore";
import { buildSendPlan } from "./sendPlan";
import { startAssistantStream } from "../../services/streamController";
import * as conversationService from "../../services/conversationService";

export async function sendMessageAction() {
  const store = useAppStore.getState();

  const conversationId = store.workspace.activeConversationId;
  const currentBranchId = store.workspace.currentBranchId;
  const draft = store.composer.draft.trim();
  const modelId = store.composer.selectedModelId;

  if (!conversationId || !currentBranchId || !draft || !modelId) return;

  const plan = await buildSendPlan(store);
  const now = Date.now();
  const userMessageId = nanoid();

  // 1) 如需创建 branch，先创建
  if (plan.createBranch) {
    const newBranch = await conversationService.createBranch({
      conversationId,
      sourceBranchId: plan.sourceBranchId,
      forkPointMessageId: plan.createBranch.forkPointMessageId,
      forkSourceMessageId: plan.createBranch.forkSourceMessageId,
      sourceType: plan.createBranch.sourceType,
    });

    store.upsertBranchLocal(newBranch);
    store.setCurrentBranch(newBranch.id);
    plan.targetBranchId = newBranch.id;
  }

  // 2) 创建用户消息
  const userMessage = await conversationService.createUserMessage({
    id: userMessageId,
    conversationId,
    branchId: plan.targetBranchId,
    parentMessageId: plan.targetParentMessageId,
    text: draft,
    editedFromMessageId: plan.editedFromMessageId,
    createdAt: now,
  });

  store.upsertMessageLocal(userMessage);
  store.clearDraft();
  store.setWorkspaceMode("normal");
  store.clearForkIntent();
  store.setVariantPreview(null);

  // 3) 计算 prompt
  const promptMessages = await conversationService.buildPromptMessages({
    conversationId,
    branchId: plan.targetBranchId,
    leafMessageId: userMessage.id,
  });

  // 4) 启动 assistant streaming
  await startAssistantStream({
    conversationId,
    branchId: plan.targetBranchId,
    parentMessageId: userMessage.id,
    providerId: userMessage.generation?.providerId ?? "default-provider",
    modelId,
    promptMessages,
    rendererMode: "pretext",
  });
}
```

---

## 10.2 `buildSendPlan`

这个函数很重要，它把 append/fork/variant/history/edit 统一起来。

```ts
import { AppStore } from "../../stores/appStore.types";
import { SendPlan } from "../../types/internal";

export async function buildSendPlan(state: AppStore): Promise<SendPlan> {
  const conversationId = state.workspace.activeConversationId!;
  const sourceBranchId = state.workspace.currentBranchId!;
  const snapshot = state.activeSnapshot!;
  const sourceBranch = snapshot.entities.branches[sourceBranchId];

  // compare 模式禁止发送
  if (state.workspace.workspaceMode === "compare") {
    throw new Error("Cannot send message in compare mode");
  }

  // history/edit mode
  if (state.workspace.forkIntent) {
    const intent = state.workspace.forkIntent;

    return {
      conversationId,
      sourceBranchId,
      targetBranchId: sourceBranchId, // 先占位，创建后会替换
      targetParentMessageId: intent.sourceMessageId,
      createBranch: {
        sourceType: intent.sourceType,
        forkPointMessageId: intent.sourceMessageId,
        forkSourceMessageId: intent.sourceMessageId,
      },
      editedFromMessageId: intent.originalEditableMessageId,
      continueFromVariantMessageId: intent.selectedVariantMessageId,
    };
  }

  // send mode = newBranch
  if (state.composer.sendMode === "newBranch") {
    return {
      conversationId,
      sourceBranchId,
      targetBranchId: sourceBranchId,
      targetParentMessageId: sourceBranch.headMessageId,
      createBranch: {
        sourceType: "currentLeaf",
        forkPointMessageId: sourceBranch.headMessageId,
        forkSourceMessageId: sourceBranch.headMessageId,
      },
    };
  }

  // variant continue
  if (state.workspace.variantPreview?.hasDownstreamConflict) {
    const preview = state.workspace.variantPreview;
    return {
      conversationId,
      sourceBranchId,
      targetBranchId: sourceBranchId,
      targetParentMessageId: preview.assistantMessageId,
      createBranch: {
        sourceType: "variant",
        forkPointMessageId: preview.assistantMessageId,
        forkSourceMessageId: preview.assistantMessageId,
      },
      continueFromVariantMessageId: preview.assistantMessageId,
    };
  }

  // normal append
  return {
    conversationId,
    sourceBranchId,
    targetBranchId: sourceBranchId,
    targetParentMessageId: sourceBranch.headMessageId,
  };
}
```

---

# 十一、哪些状态应该持久化，哪些不应该

这是很多人做 Zustand 时容易踩的坑。

---

## 11.1 应持久化到本地数据库 / 设置文件
- provider 配置
- conversation summaries
- conversation snapshot（在 SQLite）
- branch / message 实体
- mainline branch id
- conversation title
- archive 状态

---

## 11.2 可轻量持久化到本地 UI 偏好
- 左侧栏是否折叠
- 右侧栏是否折叠
- 右侧当前 tab
- 上次使用的模型
- 上次打开的 conversationId / branchId

---

## 11.3 不要持久化进 Zustand persist
- streaming chunk buffer
- request session runtime
- DOM / surface 引用
- compare 页面中的临时滚动位置
- markdown parse cache
- pretext instance

---

# 十二、pretext 接入时的几个额外建议

---

## 12.1 不要让 pretext 和 MarkdownRenderer 同时存在于同一个消息体里
错误做法：
- 上面一个 pretext surface
- 下面一个 markdown preview
- 每个 chunk 两套都更新

正确做法：
- 流式中只显示 pretext surface
- 完成后 unmount surface，切 MarkdownRenderer

---

## 12.2 流式阶段不要做完整 markdown parse
因为 markdown 结构在生成过程中经常不闭合，例如：
- 代码块没结束
- 列表没闭合
- 表格没完整
- 引用块断裂

所以流式阶段最稳的是：
- 纯文本显示
- 保留换行
- 不做语法高亮

完成后再 render markdown。

---

## 12.3 对代码块可以做“延迟升级”
如果你很在意流式代码体验，可以后面做增强：
- 流式阶段仍走 text surface
- 完成后如果检测到大代码块，再交给代码高亮组件

但 v1 不建议在流式阶段做语法解析。

---

## 12.4 flush 频率建议
建议：
- 16ms ~ 40ms 之间
- 默认 24ms 就不错

不要每个 chunk 都 flush。
很多模型 chunk 很细，会把主线程打爆。

---

## 12.5 长文本保护
可以加一个简单的保护策略：
- 当 `totalChars > 50_000`
- flush 间隔从 24ms 提高到 48ms
- 或只在动画帧里刷新

---

# 十三、建议再补一个 `useStreamingMessage` hook

这样组件层更干净。

```ts
import { useMemo } from "react";
import { useStreamStore } from "../stores/streamStore";
import type { MessageNode } from "../types/conversation";

export function useStreamingMessage(message: MessageNode) {
  const requestId = message.generation?.requestId;

  const session = useStreamStore((s) =>
    requestId ? s.sessionsByRequestId[requestId] : undefined
  );

  return useMemo(() => {
    const isStreaming = !!requestId && !!session && message.status === "streaming";
    return {
      isStreaming,
      requestId: requestId ?? null,
      rendererMode: session?.rendererMode ?? "dom-text",
      visibleCharCount: session?.visibleCharCount ?? 0,
      streamStatus: session?.status ?? null,
    };
  }, [message.status, requestId, session]);
}
```

---

# 十四、我建议你下一步的工程落地顺序

基于你现在已经有的 PRD 和前端架构，最合理的是：

## 第一步
先写这几个基础类型文件：
- `base.ts`
- `conversation.ts`
- `workspace.ts`
- `stream.ts`

## 第二步
搭 Zustand：
- `useAppStore`
- `useStreamStore`

## 第三步
实现一个最简单的 `DomTextSurface`
- 不依赖 pretext
- 先打通 streaming 架构

## 第四步
实现 `StreamingAssistantContent`
- 让流式消息不再走 React token 级更新

## 第五步
接入 pretext adapter
- 替换 surface 工厂
- 观察性能表现

## 第六步
最后再优化：
- flush 策略
- stick-to-bottom
- 错误恢复
- 长文本保护

---

# 十五、生成代码的开发约束

 AI coding assistant需要遵循以下规则：

```text
请为一个 React + Tauri 桌面应用实现本地优先的对话工作台。

关键约束：
1. 消息和分支数据保存在 SQLite/Tauri 层，Zustand 只保存当前会话 snapshot 和 UI 状态。
2. assistant 流式生成时，不要每个 token 更新 React state 或 message.content.text。
3. 采用双层流式架构：
   - useStreamStore: 只存 session meta
   - runtime registry: 存 chunk buffer、flush timer、imperative text surface
4. 流式消息显示采用 imperative text surface，优先支持 pretext，fallback 为原生 DOM TextNode。
5. assistant 流式完成后，才将完整文本一次性提交到 message.content.text，并切换到 MarkdownRenderer。
6. compare 模式下 composer 必须禁用。
7. 历史继续 / 编辑并分支必须进入显式 workspaceMode。
8. variant 只是同一 user message 下的 assistant sibling，不默认作为 branch 挂到侧边栏。
```

---

