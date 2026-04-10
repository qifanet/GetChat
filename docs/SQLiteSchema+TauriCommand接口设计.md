下面给你一份**《SQLite Schema + Tauri Command 接口设计》**

---

# 一、先定 8 条持久化设计原则

这部分非常关键，后面的 schema 和 command 都围绕它来。

## 原则 1：SQLite 只存“真结构”，不存 UI 派生状态
数据库存：

- conversations
- branches
- messages
- providers
- app_kv / workspace prefs

数据库**不存**：

- 当前右侧面板是否展开
- 当前候选回答预览是哪一个
- 当前 compare 页面滚动位置
- streaming chunk buffer

---

## 原则 2：Branch 是“命名路径指针”，不是 branch_messages 映射表
v1 不建议做 `branch_messages` 中间表。

因为这款产品底层本质是：

- `messages` 形成树
- `branches` 只是对某条路径叶子节点的命名引用

所以 branch 只需要记录：

- fork 元信息
- 当前 `head_message_id`

然后整条路径可通过 `head_message_id -> parent_message_id` 一路回溯得到。

**好处**：
- 结构简单
- 不容易出现路径冗余
- 非破坏性历史编辑更自然

---

## 原则 3：历史编辑永远是“新建 message”，不是 update 原 message
这条必须写进接口设计里。

- 不提供通用 `update_message_content` 公开 command
- 历史用户消息编辑必须新建一条 user message
- 原 message 永远保留

---

## 原则 4：候选回答 variant 不单独建表
v1 推荐不建 `variants` 表。

因为 variant 本质上就是：

> 同一个 user message 下的多个 assistant children

所以它天然能从 `messages.parent_message_id` 推导。

**这样能避免三套概念打架**：

- 普通消息树
- 候选回答
- 分支路径

---

## 原则 5：Branch 主线只在 conversation 上存一个指针
不要在 `branches` 表里再存 `is_mainline` 真值列。

数据库里只存：

- `conversations.mainline_branch_id`

然后在 DTO / snapshot 层派生：

- `branch.isMainline = branch.id === conversation.mainline_branch_id`

**好处**：
- 避免双写不一致
- 设主线操作非常明确

---

## 原则 6：childIds / indexes 不落库，加载 snapshot 时构建
数据库只存：

- `parent_message_id`
- `fork_point_message_id`
- `head_message_id`

运行时构建：

- `childIds`
- `rootMessageIds`
- `childMessageIdsByParentId`
- `branchIdsByForkPointId`

---

## 原则 7：流式生成分两层
数据库层只存：

- assistant placeholder message
- streaming/completed/failed 状态
- 最终文本 / partial 文本

数据库不存：

- token chunks
- flush timer
- surface 实例

---

## 原则 8：Command 必须是“意图型接口”，不是随便 patch 数据
推荐暴露这种 command：

- `create_branch`
- `create_user_message`
- `complete_assistant_message`
- `set_mainline_branch`

不推荐暴露这种 command：

- `update_branch_head`
- `update_message`
- `patch_anything`

**原因**：
意图型接口更不容易把 non-destructive 规则破坏掉。

---

# 二、SQLite Schema 设计

---

# 2.1 表结构总览

建议 v1 只做 5 张核心表：

1. `app_kv`
2. `providers`
3. `conversations`
4. `messages`
5. `branches`

---

# 2.2 各表职责

## `app_kv`
存少量全局配置 / 上次工作区恢复信息，例如：

- default_model_id
- last_workspace
- ui_preferences

---

## `providers`
存模型服务配置，但**不存明文 API Key**。
只存：

- provider 基础信息
- `api_key_ref`（指向系统安全存储）

---

## `conversations`
存会话级信息：

- 标题
- 主线 branch id
- 创建/更新时间
- 是否归档

---

## `messages`
存消息树节点：

- role
- parent_message_id
- depth
- content_text
- generation meta
- error
- edited_from_message_id

---

## `branches`
存路径实体：

- name
- source_branch_id
- fork_point_message_id
- fork_source_type
- fork_source_message_id
- head_message_id
- status(active/archived)

---

# 2.3 核心结构关系图

```text
conversations
  └── branches (一会话多路径)
         └── head_message_id --> messages.id

messages
  └── parent_message_id --> messages.id  // 形成树

branches
  ├── source_branch_id --> branches.id
  ├── fork_point_message_id --> messages.id
  └── fork_source_message_id --> messages.id
```

---

# 2.4 一个非常重要的边界：历史编辑的 fork point

这个要特别强调，因为最容易做错。

假设原路径是：

```text
A(user) -> B(assistant) -> C(user) -> D(assistant)
```

如果用户编辑历史用户消息 `C`，新路径应该是：

```text
A -> B -> C'(new user) -> D'(new assistant)
```

这意味着：

- `fork_source_message_id = C`
- `fork_point_message_id = B`
- 新的 `C'` 的 `parent_message_id = B`
- **不是** `parent_message_id = C`

这是防止“UI 看起来像修改了原历史”的关键。

---

# 三、推荐 SQLite DDL

下面这份 SQL 可以作为 `0001_init.sql` 的基础版本。

---

## 3.1 建表 SQL

```sql
-- app_kv：少量全局设置 / 工作区恢复信息
CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- providers：不存明文 API Key，只存安全存储引用
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('openai-compatible', 'ollama')),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ref TEXT,
  default_model_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- conversations：mainline_branch_id 建议由 command 层保证有效性
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mainline_branch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  archived_at INTEGER
);

-- messages：消息树节点
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'aborted')),
  parent_message_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  sibling_index INTEGER NOT NULL DEFAULT 0,

  content_text TEXT NOT NULL DEFAULT '',
  content_format TEXT NOT NULL DEFAULT 'markdown' CHECK (content_format IN ('markdown')),

  provider_id TEXT,
  model_id TEXT,
  request_id TEXT,
  generation_params_json TEXT,
  usage_json TEXT,

  error_code TEXT,
  error_message TEXT,
  error_retriable INTEGER NOT NULL DEFAULT 0 CHECK (error_retriable IN (0, 1)),

  edited_from_message_id TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (edited_from_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

-- branches：路径指针 + 分叉元信息
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),

  source_branch_id TEXT,
  fork_point_message_id TEXT,
  fork_source_type TEXT NOT NULL CHECK (
    fork_source_type IN ('root', 'currentLeaf', 'historyAssistant', 'historyUserEdit', 'variant')
  ),
  fork_source_message_id TEXT,

  head_message_id TEXT,

  color TEXT,
  summary TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,

  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  FOREIGN KEY (fork_point_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (fork_source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (head_message_id) REFERENCES messages(id) ON DELETE SET NULL
);
```

---

## 3.2 索引 SQL

```sql
CREATE INDEX IF NOT EXISTS idx_providers_enabled
  ON providers(enabled);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_archived_at
  ON conversations(archived_at);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_parent_sibling
  ON messages(parent_message_id, sibling_index);

CREATE INDEX IF NOT EXISTS idx_messages_parent_created
  ON messages(parent_message_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_request_id_unique
  ON messages(request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_edited_from
  ON messages(edited_from_message_id);

CREATE INDEX IF NOT EXISTS idx_branches_conversation_status_updated
  ON branches(conversation_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_branches_fork_point
  ON branches(fork_point_message_id);

CREATE INDEX IF NOT EXISTS idx_branches_source_branch
  ON branches(source_branch_id);
```

---

# 四、启动时推荐 SQLite PRAGMA

这些建议在 Tauri 后端初始化 DB 连接时执行，不建议写死在 migration 里。

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

## 说明
- `foreign_keys=ON`：保证树结构引用正确
- `WAL`：桌面端本地读写体验更稳
- `busy_timeout`：减少并发读写时瞬时锁冲突

---

# 五、命令层必须遵守的领域约束

---

## 5.1 Message 不可被“通用修改”
建议：

- **不要公开** `update_message_content`
- 只允许：
  - `create_user_message`
  - `create_assistant_placeholder_for_branch`
  - `create_assistant_variant_placeholder`
  - `complete_assistant_message`
  - `fail_assistant_message`

这样可以从接口层阻止“直接改历史”。

---

## 5.2 Branch 不能随便 patch head
不要暴露：

- `set_branch_head`
- `patch_branch`

应该只通过这些意图型动作改变 head：

- `create_user_message`
- `create_assistant_placeholder_for_branch`
- `create_branch`

---

## 5.3 Mainline 只允许切 active branch
`set_mainline_branch` 时应校验：

- branch 属于该 conversation
- branch.status = active

如果是 archived branch：
- 要么拒绝
- 要么先 unarchive 再设主线

v1 建议：**直接拒绝**，行为更明确。

---

## 5.4 归档主线分支时应拒绝
v1 建议：

- 如果要 archive 当前 mainline branch，直接返回错误
- 提示用户先切换主线

---

## 5.5 Regenerate variant 不更新 branch head
重新回答只会：

- 在同一个 user message 下新增 assistant sibling
- 不更新 branch head
- 不创建 branch

只有用户“沿该候选继续”时，才创建新 branch。

---

# 六、推荐 Tauri Command 分组设计

建议按模块分 command，不要全部堆在一个文件。

---

# 6.1 Command 模块建议

```text
src-tauri/src/
├─ commands/
│  ├─ bootstrap.rs
│  ├─ settings.rs
│  ├─ conversations.rs
│  ├─ branches.rs
│  ├─ messages.rs
│  └─ export.rs
├─ db/
│  ├─ mod.rs
│  └─ migrations/
│     └─ 0001_init.sql
├─ dto/
│  ├─ settings.rs
│  ├─ conversations.rs
│  ├─ branches.rs
│  ├─ messages.rs
│  └─ common.rs
├─ repositories/
│  ├─ app_kv.rs
│  ├─ providers.rs
│  ├─ conversations.rs
│  ├─ branches.rs
│  └─ messages.rs
├─ services/
│  ├─ snapshot_service.rs
│  └─ prompt_service.rs
└─ error.rs
```

---

# 七、Tauri Command 接口清单

下面是推荐的最小可用接口。

---

# 7.1 Bootstrap / App 状态

## `bootstrap_app`
用于首次进入应用时减少 round trip。

### 输入
无

### 输出
```ts
type BootstrapDto = {
  hasProvider: boolean;
  defaultModelId: string | null;
  providers: ProviderSummaryDto[];
  conversationSummaries: ConversationSummaryDto[];
  lastWorkspace: {
    conversationId: string | null;
    branchId: string | null;
  } | null;
};
```

### 说明
- 可选，如果你已经拆成多个 command，也可以不用这个聚合接口
- 但桌面端通常做一个 bootstrap command 很省事

---

## `save_last_workspace`

### 输入
```ts
type SaveLastWorkspaceInput = {
  conversationId: string | null;
  branchId: string | null;
};
```

### 输出
`void`

---

# 7.2 Settings / Providers

## `list_providers`

### 输出
```ts
type ProviderDto = {
  id: string;
  type: "openai-compatible" | "ollama";
  name: string;
  baseUrl: string;
  defaultModelId: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
};
```

> 不要把 `apiKeyRef` 或明文 key 返回给前端。

---

## `save_provider`

### 输入
```ts
type SaveProviderInput = {
  id?: string;
  type: "openai-compatible" | "ollama";
  name: string;
  baseUrl: string;
  apiKeyPlaintext?: string; // 仅输入时可带
  defaultModelId?: string | null;
  enabled: boolean;
};
```

### 行为
- 如有 `apiKeyPlaintext`：
  - 写入 OS secure storage / keychain
  - DB 只保存 `api_key_ref`
- 返回 sanitized `ProviderDto`

---

## `delete_provider`

### 输入
```ts
type DeleteProviderInput = {
  providerId: string;
};
```

### 行为
- 删 DB 记录
- 删 secure storage 对应 secret

---

## `set_default_model`

### 输入
```ts
type SetDefaultModelInput = {
  modelId: string | null;
};
```

### 行为
- 存到 `app_kv`

---

## `test_provider_connection`

### 输入
两种都可以，但 v1 推荐这个：

```ts
type TestProviderConnectionInput = {
  providerId?: string; // 优先支持已保存 provider
  override?: {
    type: "openai-compatible" | "ollama";
    baseUrl: string;
    apiKeyPlaintext?: string;
    modelId?: string;
  };
};
```

### 说明
- 用于 onboarding 时测试连接
- 不要求在这次任务里实现完整 streaming

---

# 7.3 Conversations

## `list_conversation_summaries`

### 输出
```ts
type ConversationSummaryDto = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  mainlineBranchId: string | null;
  activeBranchCount: number;
  archivedBranchCount: number;
  totalMessageCount: number;
  archivedAt: number | null;
};
```

---

## `create_conversation`

### 输入
```ts
type CreateConversationInput = {
  id?: string;
  title?: string;
};
```

### 行为
事务内完成：

1. 创建 conversation
2. 创建 root/main branch
3. 更新 conversation.mainline_branch_id
4. 返回 summary + 初始 branch

### 输出
```ts
type CreateConversationResult = {
  summary: ConversationSummaryDto;
  initialBranch: BranchDto;
};
```

---

## `load_conversation_snapshot`

### 输入
```ts
type LoadConversationSnapshotInput = {
  conversationId: string;
};
```

### 输出
建议直接返回前端可用 snapshot：

```ts
type ConversationSnapshotDto = {
  summary: ConversationSummaryDto;
  entities: {
    messages: Record<string, MessageDto>;
    branches: Record<string, BranchDto>;
  };
  indexes: {
    rootMessageIds: string[];
    childMessageIdsByParentId: Record<string, string[]>;
    branchIdsByForkPointId: Record<string, string[]>;
  };
  loadedAt: number;
};
```

### 说明
- `childIds` 可以直接塞进 `MessageDto`
- 也可以仅返回 `indexes`
- 推荐 Rust 侧构建好 snapshot，前端少做一遍归并

---

## `rename_conversation`

### 输入
```ts
type RenameConversationInput = {
  conversationId: string;
  title: string;
};
```

---

## `archive_conversation`

### 输入
```ts
type ArchiveConversationInput = {
  conversationId: string;
};
```

---

## `delete_conversation`

### 输入
```ts
type DeleteConversationInput = {
  conversationId: string;
};
```

### 说明
- 依赖 `ON DELETE CASCADE`
- 连带删 messages / branches

---

# 7.4 Branches

## `create_branch`

### 输入
```ts
type CreateBranchInput = {
  id?: string;
  conversationId: string;
  sourceBranchId: string;
  name?: string;

  forkSourceType:
    | "currentLeaf"
    | "historyAssistant"
    | "historyUserEdit"
    | "variant";

  forkPointMessageId: string | null;
  forkSourceMessageId: string | null;

  /**
   * 很关键：
   * branch 创建后此时“共享到哪一个节点为止”
   * currentLeaf/historyAssistant/variant 通常等于 forkPointMessageId
   * historyUserEdit 通常等于“被编辑消息的 parent_message_id”
   */
  initialHeadMessageId: string | null;
};
```

### 核心说明
这个 `initialHeadMessageId` 非常重要。
它可以正确处理**编辑历史用户消息**这个特殊场景。

---

## `rename_branch`

### 输入
```ts
type RenameBranchInput = {
  branchId: string;
  name: string;
};
```

---

## `archive_branch`

### 输入
```ts
type ArchiveBranchInput = {
  branchId: string;
};
```

### 校验建议
- 不允许归档当前 conversation 的 mainline branch

---

## `unarchive_branch`

### 输入
```ts
type UnarchiveBranchInput = {
  branchId: string;
};
```

---

## `set_mainline_branch`

### 输入
```ts
type SetMainlineBranchInput = {
  conversationId: string;
  branchId: string;
};
```

### 行为
只更新：
- `conversations.mainline_branch_id`
- `conversations.updated_at`

不改 messages / branches 树结构。

---

# 7.5 Messages

这里是最关键的一组。

---

## `create_user_message`

### 输入
```ts
type CreateUserMessageInput = {
  id?: string;
  conversationId: string;
  branchId: string;
  parentMessageId: string | null;
  text: string;
  editedFromMessageId?: string | null;
};
```

### 行为
事务内完成：

1. 校验 branch 与 conversation 一致
2. 校验 parentMessageId 合法
3. 计算 `depth`
4. 计算 `sibling_index`
5. 插入 user message
6. 更新 branch.head_message_id = 新 message
7. touch branch.updated_at / conversation.updated_at

### 特别校验
如果 `editedFromMessageId` 存在：
- 该旧消息必须是 `role=user`
- 新消息的 `parentMessageId` 必须等于旧消息的 `parent_message_id`

这能从后端阻止“编辑历史时接错父节点”。

---

## `create_assistant_placeholder_for_branch`

### 输入
```ts
type CreateAssistantPlaceholderForBranchInput = {
  id?: string;
  conversationId: string;
  branchId: string;
  parentMessageId: string;
  providerId: string;
  modelId: string;
  requestId: string;
  generationParams?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
};
```

### 行为
事务内完成：

1. 插入 assistant message，`status=streaming`
2. `content_text=''`
3. 更新 `branch.head_message_id = assistant message`
4. touch branch / conversation

---

## `create_assistant_variant_placeholder`

### 输入
```ts
type CreateAssistantVariantPlaceholderInput = {
  id?: string;
  conversationId: string;
  userMessageId: string;
  providerId: string;
  modelId: string;
  requestId: string;
  generationParams?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
};
```

### 行为
- 在该 user message 下新增 assistant child
- `status=streaming`
- **不更新 branch head**
- **不创建 branch**

这正是 “regenerate = candidate，不是 branch”。

---

## `complete_assistant_message`

### 输入
```ts
type CompleteAssistantMessageInput = {
  messageId: string;
  finalText: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};
```

### 行为
- 更新 message.status = completed
- 更新 content_text
- 写 usage_json
- 不触碰树结构

---

## `fail_assistant_message`

### 输入
```ts
type FailAssistantMessageInput = {
  messageId: string;
  partialText?: string;
  error: {
    code: string;
    message: string;
    retriable: boolean;
  };
};
```

### 行为
- 更新 message.status = failed
- 保留 partialText
- 写 error

---

## `build_prompt_messages`

### 输入
```ts
type BuildPromptMessagesInput = {
  conversationId: string;
  leafMessageId: string;
};
```

### 输出
```ts
type PromptMessageDto = {
  role: "system" | "user" | "assistant";
  content: string;
};
```

### 说明
这个 command 很有价值：

- 前端不必自己拼 prompt
- Rust 侧按 DB 真结构回溯路径
- 可以统一过滤无效消息（如 failed/incomplete）

---

# 八、推荐 DTO 设计

建议分成两层：

1. **DB Record**
2. **前端 DTO**

例如 provider：

- DB 里有 `api_key_ref`
- DTO 里只返回 `has_api_key`

---

## 8.1 `BranchDto` 建议

```ts
type BranchDto = {
  id: string;
  conversationId: string;
  name: string;
  status: "active" | "archived";
  isMainline: boolean;

  sourceBranchId: string | null;
  forkPointMessageId: string | null;
  forkSourceType: "root" | "currentLeaf" | "historyAssistant" | "historyUserEdit" | "variant";
  forkSourceMessageId: string | null;

  headMessageId: string | null;

  color?: string | null;
  summary?: string | null;

  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};
```

> `isMainline` 建议在 command / snapshot 组装时派生，不直接落库。

---

## 8.2 `MessageDto` 建议

```ts
type MessageDto = {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant";
  status: "pending" | "streaming" | "completed" | "failed" | "aborted";

  parentId: string | null;
  childIds: string[];
  depth: number;

  siblingIndex: number;

  content: {
    text: string;
    format: "markdown";
  };

  generation?: {
    providerId?: string | null;
    modelId?: string | null;
    requestId?: string | null;
    params?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    };
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };

  error?: {
    code: string;
    message: string;
    retriable: boolean;
  };

  editedFromMessageId?: string | null;

  createdAt: number;
  updatedAt: number;
};
```

---

# 九、推荐事务边界

这里很重要，能减少很多脏状态。

---

## 9.1 `create_conversation`
一个事务内完成：

- insert conversation
- insert root branch
- update conversation.mainline_branch_id

---

## 9.2 `create_branch`
一个事务内完成：

- 校验 source branch / source message / fork point
- insert branch
- touch conversation.updated_at

---

## 9.3 `create_user_message`
一个事务内完成：

- 校验 parent / branch / conversation
- insert message
- update branch.head_message_id
- touch branch.updated_at & conversation.updated_at

---

## 9.4 `create_assistant_placeholder_for_branch`
一个事务内完成：

- insert placeholder
- update branch.head_message_id
- touch branch.updated_at & conversation.updated_at

---

## 9.5 `complete_assistant_message`
单事务：

- patch message.status/content/usage
- 不改 branch tree

---

# 十、建议不要在 v1 做的数据库层复杂化

不建议 v1 优先做：

- 触发器自动维护 summary count
- branch_messages 映射表
- variants 独立表
- FTS 搜索
- embedding / vector 表
- 自动垃圾回收 orphan nodes

原因很简单：
这些都不是你第一阶段验证“分叉-比较-收敛”核心价值所必需的。

---

# 十一、最推荐你的落地顺序

建议你这样驱动 AI coding assistant：

1. **B0 全局母提示**
2. **B1 SQLite migration**
3. **B2 DTO + AppError**
4. **B3 repository / service**
5. **B4 Tauri commands**
6. **B5 前端 invoke 封装**
7. **B6 审查**

这个顺序有个很大的好处：

- 先把数据边界固化
- 再做命令层
- 最后再接前端
- 不会一上来就出现“前端先写了假接口，后端又推翻”的问题

---

# 十二、最后给你 6 条特别重要的“防跑偏提醒”

## 1. 不要公开通用 update message
这是最危险的一类接口。

---

## 2. `historyUserEdit` 一定要用“原消息的 parent 作为 fork point”
这是整个非破坏性历史编辑能否成立的关键。

---

## 3. 不要让 regenerate 改 branch head
否则候选回答和分支路径会混在一起。

---

## 4. `isMainline` 不要双写
库里只保留 `conversation.mainline_branch_id`。

---

## 5. snapshot 可以重，不要把逻辑分散
建议 `load_conversation_snapshot` 一次把前端需要的结构准备好。

---

## 6. secure storage 与 SQLite 分开
provider 的明文 key 不该在 DB，也不该返回前端。

---

