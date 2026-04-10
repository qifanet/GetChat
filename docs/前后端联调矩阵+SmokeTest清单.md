# 前后端联调矩阵 + Smoke Test 清单

> 版本：v1.1 | 日期：2026-04-09
> 基于：SQLite schema 0001_init.sql + 26 个 Tauri commands + 前端 TypeScript 类型

---

## 0. 2026-04-09 当前实现进展

- `bootstrap/settings/workspace-first` 主链已接通，前端已具备真实 Provider 管理页面。
- compare 已由显式 `workspaceMode = COMPARE` 驱动，主界面可实际进入只读对比视图。
- 分支 rename / archive / unarchive / set mainline 已从 UI 接入真实 store/Tauri commands。
- 左侧会话栏已补 conversation rename / archive / delete 的真实入口。
- `send -> placeholder -> Rust model stream -> complete/fail/cancel` 代码链路已补齐。
- 新增运行时 streaming 命令：
  - `start_model_stream`
  - `abort_model_stream`
- Rust 侧已补 `model_stream_service`：
  - `OPENAI_COMPATIBLE`：`/chat/completions` SSE
  - `OLLAMA`：优先 `/api/chat`，必要时回退 `/v1/chat/completions`
- Rust 侧 `delete_provider` 补偿与 `test_provider_connection` 真实 HTTP probe 代码已完成本机 `cargo build/test` 复验。
- Rust 侧已补本地 mock HTTP 验证基础设施：
  - `test_support.rs`
  - `TestKeyStore`
  - `spawn_mock_http_server()`
- provider probe mock smoke 已通过：
  - `OPENAI_COMPATIBLE` `GET /v1/models` + Bearer Auth
  - `OLLAMA` `/api/tags -> /v1/models` fallback
  - `401` 映射 `INVALID_ARGUMENT`
- streaming mock smoke 已通过：
  - `OPENAI_COMPATIBLE` SSE stream
  - `OLLAMA` native NDJSON stream
  - `OLLAMA` `/api/chat` `404` 后回退 `/v1/chat/completions`
- 真实 Tauri dev 启动 smoke 已通过：
  - 成功拉起 `getchat.exe`
  - 真实壳层日志确认 `bootstrap_app`
  - 空环境结果：`has_last_workspace=false`、`providers_count=0`、`has_default_model=false`
  - 当前仅确认壳层启动与启动命令链，尚未完成页面交互级 smoke
- Rust warning 清理已完成：
  - `dto/mod.rs` 未使用 re-export 已移除
  - `repositories/*` 未使用 helper 已移除
  - `commands/branches.rs`、`commands/messages.rs` 未使用变量已修正
  - 复验 `cargo test` 22 项继续全部通过
- 前端生产包分包优化已完成：
  - `MarkdownRenderer` 已切到 `PrismLight` + 按需语言注册
  - `vite.config.ts` 已补 vendor chunk 划分
  - `npm.cmd run build` 复验已不再出现 `>500 kB` chunk warning
- `delete_conversation` 已切到 deferred-FK 事务删除，避免消息树自引用 `RESTRICT` 约束阻断整会话删除。
- `MarkdownRenderer` 已升级为正式 GFM 渲染实现，支持表格、外链与代码块高亮。
- `PendingConvergePill` 已接通 compare 入口，不再停留在空 `TODO`。
- `MessageList` 相关 selector 已补稳定引用缓存，修复 React 19 下的无限更新问题。
- 无 provider 场景已改为直接进入 workspace shell，不再强制首屏 onboarding。
- 紧凑宽度下左右侧栏已切为 overlay drawer，主阅读区不再被三栏内联布局挤压。
- `Composer` 已改为前置禁发策略：无启用 provider 或无默认模型时直接提示，不再点击发送后才报错。
- `Composer` 首次创建会话后的 hooks 顺序错误已修复，当前空工作区 -> 新建会话路径稳定。
- 中文界面已补系统默认名展示层本地化：
  - `New Conversation` -> `新建会话`
  - `Main` -> `主线`
- 最近一次前端复验结果：
  - `npm.cmd run build`：通过
  - `npm.cmd run test`：通过，8 个测试文件 / 110 个测试
  - 说明：分包优化后最大 JS chunk 约 `207 kB`，构建输出已无 chunk size warning
- 本轮 `workspace-first / responsive shell / Composer` 补丁后的再次复验：
  - `npm.cmd run test`：通过，8 个测试文件 / 110 个测试
  - `npm.cmd run build`：通过
- 最近一次浏览器 smoke（基于 Vite dev + Tauri mock）：
  - 结果：通过
  - 范围：
    - workspace 主壳层
    - 无 provider 直入 workspace 空态
    - settings 页面
    - compare 只读视图
    - 紧凑宽度左右侧栏抽屉
    - 新建会话后的 composer 禁发提示
    - markdown 表格 / 链接 / 代码块渲染
  - 截图：
    - `output/playwright/compare-smoke-desktop.png`
    - `output/playwright/settings-smoke-desktop.png`
    - `output/playwright/workspace-shell-desktop.png`
    - `output/playwright/provider-settings-desktop.png`
    - `output/playwright/workspace-shell-compact.png`
    - `output/playwright/workspace-left-drawer-compact.png`
    - `output/playwright/workspace-right-drawer-compact.png`
    - `output/playwright/workspace-conversation-created.png`
  - 说明：这轮 smoke 只验证前端壳层与状态流转，不替代真实 Tauri/provider 验收
- 最近一次后端复验结果：
  - `cargo build`：通过
  - `cargo test`：通过，`settings` provider probe mock tests、`model_stream_service` streaming mock tests + `invariant_tests` 共 22 个测试全部通过
- 最近一次真实 Tauri 壳层复验结果：
  - `npx.cmd tauri dev`：部分通过
  - 摘要：桌面壳层可成功启动，且在真实壳层中执行了 `bootstrap_app`；当前仍缺页面交互级 smoke
- 仍待完成：
  - 真实 provider/Tauri smoke
  - Rust/Tauri 手工 smoke
  - 显式双分支 compare 选择器

---

## 一、联调矩阵

---

### SMOKE-01 首次启动无 provider

**前置条件**
- 全新本地环境，DB 文件不存在
- 无 provider 配置

**操作步骤**
1. 启动应用
2. 观察 bootstrap 结果

**预期前端表现**
- 直接进入 workspace shell
- 中区显示无 provider 的产品化空状态
- 可从当前壳层直接进入 Settings 配置 Provider
- 不出现空白页或无限 loading

**2026-04-09 补充说明**
- 旧版“无 provider 必须先过 onboarding”的预期已作废，不再作为当前联调验收标准。

**预期后端 command 序列**
```
bootstrap_app()
  → app_kv.get("last_workspace")           → None
  → providers.list_all()                    → []
  → app_kv.get("default_model_id")          → None
  → 返回 { lastWorkspace: null, providers: [], defaultModelId: null }
```

**关键 DB 不变量**
- `conversations` 表为空
- `branches` 表为空
- `messages` 表为空
- `app_kv` 可能只有 schema 初始化状态

---

### SMOKE-02 保存 provider 并重启恢复

**前置条件**
- 应用已启动，无 provider
- 用户已填写 provider 表单

**操作步骤**
1. 填写 provider name、baseUrl、apiKey
2. 点击保存
3. 关闭应用
4. 重新打开

**预期前端表现**
- 保存成功后留在当前 settings/workspace 语境内，不要求强制跳转
- provider 列表展示 1 条，`hasApiKey = true`
- 在当前草稿无未保存改动时，连接测试按钮可用
- 重启后 `bootstrap_app` 返回 provider 列表
- **前端拿不到明文 apiKey，也拿不到 apiKeyRef**

**预期后端 command 序列**
```
save_provider({ type: "OPENAI_COMPATIBLE", name: "GPT", baseUrl: "...", apiKey: "sk-..." })
  → key_store.save(provider_id, "sk-...")   → api_key_ref
  → providers.insert(..., api_key_ref, ...)  → DB 写入
  → 返回 ProviderDto { hasApiKey: true, ... }    // 无 apiKey/apiKeyRef

重启后：
bootstrap_app()
  → providers.list_all()           → [ProviderRow{...}]
  → key_store.exists(provider_id)  → true
  → 返回 ProviderDto { hasApiKey: true, ... }
```

**关键 DB 不变量**
- `providers` 表有 1 条记录
- `providers.api_key_ref` 非空（是安全存储引用，不是明文）
- `providers.api_key_ref` 不是 "sk-..." 形式

**高风险点**
- secure storage 写入成功但 DB 写入失败 → provider 列表空但 key 已存
- DB 写入成功但 secure storage 失败 → hasApiKey = false，需重新填写

---

### SMOKE-03 创建会话

**前置条件**
- 应用已完成启动
- Provider 可未配置；若未配置则本用例只验证“创建会话 + 禁用发送”主路径

**操作步骤**
1. 点击"新建会话"

**预期前端表现**
- 会话列表新增一项
- workspace 进入该会话
- 当前 branch 自动就绪
- 在中文界面下，标题显示为“新建会话”，路径名称显示为“主线”
- 若尚未配置启用 provider 或默认模型，`Composer` 可见但发送按钮保持禁用，并显示明确提示
- 若 provider 与默认模型都已准备好，`Composer` 才允许发送

**预期后端 command 序列**
```
create_conversation({ title: undefined })
  → [事务开始]
    → conversations.insert(conv_id, "New Conversation")
    → branches.insert(branch_id, conv_id, "Main", "ROOT", ...)
    → conversations.set_mainline_branch(conv_id, branch_id)
  → [事务提交]
  → 返回 ConversationSummaryDto
```

**2026-04-09 补充说明**
- 当前“新建会话 / 主线”是展示层本地化结果；后端默认持久化值仍可能分别是 `New Conversation` / `Main`。

**关键 DB 不变量**
```sql
-- 会话必须有 mainline branch
SELECT * FROM conversations c
LEFT JOIN branches b ON b.id = c.mainline_branch_id
WHERE c.mainline_branch_id IS NULL OR b.id IS NULL;
-- 预期：0 行

-- 初始 branch 的 fork_source_type 必须是 ROOT
SELECT * FROM branches WHERE fork_source_type = 'ROOT' AND conversation_id = ?;
-- 预期：1 行
```

---

### SMOKE-04 正常发送消息

**前置条件**
- 1 个空会话，1 条 root branch

**操作步骤**
1. 输入 "你好" 并点击发送
2. 等待 assistant 回复完成

**预期前端表现**
- user message 立即出现
- assistant placeholder 进入 streaming（StreamingAssistantContent）
- 流式渲染稳定、不抖动
- 完成后切 MarkdownRenderer
- branch 不变

**预期后端 command 序列**
```
create_user_message({ conversationId, branchId, contentText: "你好" })
  → messages.insert_user_message(...)    // role=USER, parent=branch head
  → branches.update_head(branch_id, msg_id)
  → 返回 MessageDto { status: COMPLETED, ... }

build_prompt_messages({ conversationId, upToMessageId: msg_id })
  → 返回 [{ role: "USER", content: "你好" }]

create_assistant_placeholder_for_branch({ conversationId, branchId, providerId, modelId, requestId })
  → messages.insert_assistant_placeholder(...)   // status=STREAMING
  → branches.update_head(branch_id, placeholder_id)
  → 返回 MessageDto { status: STREAMING, ... }

start_model_stream({ requestId, providerId, modelId, promptMessages, generationParams, channel })
  → Rust 加载 provider 配置与 secure storage API key
  → 向模型 provider 发起真实 HTTP streaming 请求
  → 解析 SSE / NDJSON 并通过 Tauri Channel 推送 CHUNK / COMPLETED / FAILED

complete_assistant_message({ messageId, contentText: "你好！...", usage: {...} })
  → messages.complete_streaming(msg_id, final_text, usage_json)
  → 返回 MessageDto { status: COMPLETED, ... }
```

**关键 DB 不变量**
```sql
-- user message 必须是 COMPLETED
SELECT status FROM messages WHERE id = ? AND role = 'USER';
-- 预期：COMPLETED

-- assistant message 必须是 COMPLETED（流式完成后）
SELECT status FROM messages WHERE id = ? AND role = 'ASSISTANT';
-- 预期：COMPLETED

-- branch head 必须指向 assistant message
SELECT head_message_id FROM branches WHERE id = ?;
-- 预期：assistant message id

-- request_id 必须唯一
SELECT COUNT(*) FROM messages WHERE request_id = ?;
-- 预期：1
```

**高风险点**
- placeholder 创建了但 complete 没落库 → DB 永远 STREAMING
- 流式 chunk 不应出现在 message.content_text 中
- 若用户主动停止，必须先调用 `abort_model_stream(requestId)`，再以 `USER_CANCELLED` 做失败落库

---

### SMOKE-05 sendMode=newBranch

**前置条件**
- 当前路径有若干消息：U1 → A1 → U2 → A2
- 当前 branch head = A2

**操作步骤**
1. 切 sendMode = `NEW_BRANCH`
2. 输入消息并发送

**预期前端表现**
- 新 branch 被创建，自动切换到新 branch
- 原 branch 保持不变
- 右侧 branch panel 显示两条 branch

**预期后端 command 序列**
```
create_branch({ conversationId, sourceBranchId: current_branch, forkSourceType: "CURRENT_LEAF", forkPointMessageId: A2_id })
  → branches.insert(...)   // fork_source_type=CURRENT_LEAF, head=A2
  → 返回 BranchDto

create_user_message({ conversationId, branchId: new_branch_id, contentText: "...", parentMessageId: A2_id })
  → messages.insert_user_message(...)
  → branches.update_head(new_branch_id, msg_id)
  → 返回 MessageDto
```

**关键 DB 不变量**
```sql
-- 原 branch.head_message_id 不应被改写
SELECT head_message_id FROM branches WHERE id = 'original_branch';
-- 预期：仍然是 A2_id

-- 新 branch 的 fork_source_type
SELECT fork_source_type FROM branches WHERE id = 'new_branch';
-- 预期：CURRENT_LEAF
```

---

### SMOKE-06 从历史 assistant 继续

**前置条件**
- 路径：U1 → A1 → U2 → A2
- 用户点击 A1 的"从这里继续"

**操作步骤**
1. 点击 A1 的"从这里继续"
2. 确认进入 HISTORY_FORK 模式
3. 输入新消息并发送

**预期前端表现**
- 进入 historyFork 模式，消息截断到 A1
- 显示 banner："将创建新分支"
- 发送后切换到新 branch，回到 normal

**预期后端 command 序列**
```
create_branch({
  conversationId,
  sourceBranchId: current_branch,
  forkSourceType: "HISTORY_ASSISTANT",
  forkPointMessageId: A1_id,        // 分叉点在 A1
  forkSourceMessageId: A1_id
})

create_user_message({ conversationId, branchId: new_branch, contentText: "...", parentMessageId: A1_id })
```

**关键 DB 不变量**
```sql
-- 原 branch 和消息完全不变
SELECT * FROM messages WHERE id = 'A2';
-- 预期：仍然存在，未修改

-- 新 branch 的 fork_point
SELECT fork_point_message_id, fork_source_message_id FROM branches WHERE id = 'new_branch';
-- 预期：都是 A1_id
```

---

### SMOKE-07 编辑历史 user 消息 ⚠️ 高风险

**前置条件**
- 路径：U1 → A1 → U2 → A2
- 用户编辑 U2

**操作步骤**
1. 点击 U2 的"编辑并分支"
2. 修改文本为 "U2'"
3. 保存并发送

**预期前端表现**
- 进入 editFork 模式
- 原 U2 后续消息被隐藏
- 显示 banner："不会覆盖原路径"
- 成功后跳到新 branch

**预期后端 command 序列**
```
create_branch({
  conversationId,
  sourceBranchId: current_branch,
  forkSourceType: "HISTORY_USER_EDIT",
  forkSourceMessageId: U2_id,         // 被编辑的消息
  // fork_point_message_id 由 service 自动计算为 U2.parent_message_id = A1_id
})

create_user_message({
  conversationId,
  branchId: new_branch,
  contentText: "U2'",
  parentMessageId: A1_id,            // 注意：是 U2 的 parent，不是 U2
  editedFromMessageId: U2_id
})
```

**关键 DB 不变量 — 必须逐条验证**
```sql
-- U2 内容未被修改
SELECT content_text FROM messages WHERE id = 'U2';
-- 预期：原始内容

-- U2' 是新 message id
SELECT id FROM messages WHERE edited_from_message_id = 'U2';
-- 预期：新的 id，不是 U2

-- U2' 的 parent 是 A1，不是 U2
SELECT parent_message_id FROM messages WHERE edited_from_message_id = 'U2';
-- 预期：A1_id（U2 的 parent）

-- 新 branch 的 fork_point 是 A1，不是 U2
SELECT fork_point_message_id FROM branches WHERE fork_source_message_id = 'U2';
-- 预期：A1_id

-- 新 branch 的 fork_source_type
SELECT fork_source_type FROM branches WHERE fork_source_message_id = 'U2';
-- 预期：HISTORY_USER_EDIT
```

**如果 fork_point 错误写成了 U2 而非 A1：**
- UI 会显示"原历史被覆盖了"
- 这是最严重的不变量违反

---

### SMOKE-08 regenerate 候选回答

**前置条件**
- 路径：U1 → A1 → U2 → A2
- 用户点击 U2 的"重新回答"

**操作步骤**
1. 点击"重新回答"
2. 等待 A2b 完成

**预期前端表现**
- U2 下新增一个 assistant 候选（variant switcher）
- 不进入 compare
- **不创建 branch**
- **右侧 branch panel 无变化**
- 当前 branch 仍指向 A2

**预期后端 command 序列**
```
// 注意：用 variant placeholder，不是 branch placeholder
create_assistant_variant_placeholder({
  conversationId,
  parentMessageId: U2_id,        // 与 A2 共享同一 parent
  providerId, modelId, requestId
})
  → messages.insert_assistant_placeholder(...)  // sibling_index = 1
  → // 不调用 branches.update_head !!!
  → 返回 MessageDto

complete_assistant_message({ messageId: A2b_id, contentText: "..." })
```

**关键 DB 不变量**
```sql
-- branch head 不应改变
SELECT head_message_id FROM branches WHERE id = 'current_branch';
-- 预期：仍然是 A2_id，不是 A2b_id

-- A2b 的 parent 是 U2
SELECT parent_message_id FROM messages WHERE id = 'A2b';
-- 预期：U2_id

-- A2 和 A2b 是 siblings
SELECT id, sibling_index FROM messages WHERE parent_message_id = 'U2_id' ORDER BY sibling_index;
-- 预期：A2(index=0), A2b(index=1)

-- 不应有新 branch 产生
SELECT COUNT(*) FROM branches WHERE fork_source_message_id = 'A2b';
-- 预期：0
```

---

### SMOKE-09 基于候选继续

**前置条件**
- U2 下有两个 assistant：A2（当前）和 A2b（variant）
- A2 下游还有消息

**操作步骤**
1. 切换预览 A2b
2. 输入新消息继续（存在 downstream conflict）

**预期前端表现**
- 提示"将创建新分支"
- 发送后创建新 branch，切到新路径

**预期后端 command 序列**
```
create_branch({
  conversationId,
  forkSourceType: "VARIANT",
  forkPointMessageId: A2b_id,
  forkSourceMessageId: A2b_id
})

create_user_message({ conversationId, branchId: new_branch, contentText: "...", parentMessageId: A2b_id })
```

**关键 DB 不变量**
```sql
SELECT fork_source_type FROM branches WHERE fork_source_message_id = 'A2b';
-- 预期：VARIANT

-- A2b 没有被修改
SELECT * FROM messages WHERE id = 'A2b';
-- 预期：内容不变
```

---

### SMOKE-10 Compare + 设主线

**前置条件**
- 会话有两条 branch：L 和 R

**操作步骤**
1. 选择 L 和 R 进入 compare
2. 点击"设右侧为主线"
3. 返回 normal

**预期前端表现**
- compare 模式只读，composer 隐藏
- 设主线后返回 normal
- 默认打开路径更新

**预期后端 command 序列**
```
set_mainline_branch({ conversationId, branchId: R_id })
  → conversations.set_mainline_branch(conv_id, R_id)
  → 返回 ()
```

**关键 DB 不变量**
```sql
-- 只有 mainline_branch_id 改变了
SELECT mainline_branch_id FROM conversations WHERE id = ?;
-- 预期：R_id

-- 不应有新增消息
SELECT COUNT(*) FROM messages WHERE conversation_id = ?;
-- 预期：与操作前相同

-- 不应有 branch 被删除
SELECT COUNT(*) FROM branches WHERE conversation_id = ?;
-- 预期：与操作前相同

-- 不应有 branch head 被改写
SELECT id, head_message_id FROM branches WHERE conversation_id = ?;
-- 预期：所有 head 与操作前相同
```

---

### SMOKE-11 Archive / Unarchive branch

**前置条件**
- 会话有 3 条 active branch，其中 1 条是 mainline

**操作步骤**
1. 归档一条非 mainline branch
2. 尝试归档 mainline branch
3. 取消归档第一条

**预期前端表现**
- 归档后从 active 区移到 archived 区
- 尝试归档 mainline → 报错 CONFLICT
- unarchive 后恢复

**预期后端 command 序列**
```
archive_branch(branch_id)
  → branches.update_status(branch_id, "ARCHIVED")

archive_branch(mainline_branch_id)
  → 检测到 mainline → 返回 AppError { code: "CONFLICT" }

unarchive_branch(branch_id)
  → branches.update_status(branch_id, "ACTIVE")
```

**关键 DB 不变量**
```sql
-- mainline branch 不能被归档
SELECT b.status FROM branches b
JOIN conversations c ON c.mainline_branch_id = b.id
WHERE b.status = 'ARCHIVED';
-- 预期：0 行

-- 归档后 archived_at 有值
SELECT archived_at FROM branches WHERE id = 'archived_branch';
-- 预期：非 NULL

-- 取消归档后 archived_at 为 NULL
SELECT archived_at FROM branches WHERE id = 'unarchived_branch';
-- 预期：NULL
```

---

### SMOKE-12 删除会话级联删除

**前置条件**
- 1 个会话，3 条 branch，10+ 条 messages

**操作步骤**
1. 删除该会话

**预期前端表现**
- 会话从列表消失
- workspace 清空或切到其他会话

**预期后端 command 序列**
```
delete_conversation(conversationId)
  → [事务开始]
    → PRAGMA defer_foreign_keys = ON
    → DELETE FROM conversations WHERE id = ?
    → 由 FK 级联删除 branches/messages
  → [事务提交]
```

**关键 DB 不变量**
```sql
-- 无 orphan branches
SELECT COUNT(*) FROM branches WHERE conversation_id = 'deleted_conv';
-- 预期：0

-- 无 orphan messages
SELECT COUNT(*) FROM messages WHERE conversation_id = 'deleted_conv';
-- 预期：0
```

**前置条件补充**
- `PRAGMA foreign_keys = ON` 必须在连接初始化时执行
- 如果未开启，CASCADE 不生效，会出现 orphan 数据

---

### SMOKE-13 重启恢复中断的 streaming

**前置条件**
- 消息流到一半，assistant 消息 status = STREAMING
- 强制关闭应用

**操作步骤**
1. 发送消息，streaming 到一半
2. 强制关闭应用（kill process）
3. 重启应用

**预期前端表现**
- 该消息显示为 FAILED 或 ABORTED（不是永远"生成中"）
- 若有 partial text，应能显示
- composer 不被禁用

**预期后端处理**
```
// 在 bootstrap 或 app init 阶段执行 inflight repair：
UPDATE messages
SET status = 'ABORTED',
    error_code = 'APP_RESTART_INTERRUPTED',
    error_message = 'Generation interrupted by app restart',
    updated_at = unixepoch()
WHERE status = 'STREAMING';
```

**关键 DB 不变量**
```sql
SELECT COUNT(*) FROM messages WHERE status = 'STREAMING';
-- 预期：0（重启修复后）
```

> ✅ inflight repair 已实现（2026-04-08），见 `services/message_repair_service.rs` + `commands/bootstrap.rs`。

---

### SMOKE-14 结构化错误传播

**前置条件**
- 正常运行的应用

**操作步骤**
分别触发以下错误场景：

1. 归档 mainline branch
2. set_mainline 到 archived branch
3. create_user_message 时 parent 不存在
4. 操作不存在的 conversation

**预期前端表现**
- 每种场景都能拿到结构化错误 `{ code, message }`
- UI 显示清晰错误文案（toast / banner）
- 不会出现 Rust panic 或一整串不可读字符串

**预期后端返回**
```typescript
// 每种错误的预期 code
archive_branch(mainline_id)  → { code: "CONFLICT", message: "Cannot archive the mainline branch..." }
set_mainline(archived_id)   → { code: "INVALID_ARGUMENT", message: "Only active branches..." }
create_user_message(bad_id) → { code: "NOT_FOUND", message: "Parent message not found" }
load_snapshot(bad_id)       → { code: "NOT_FOUND", message: "Conversation xxx not found" }
```

**关键检查**
- `TauriAppError.code` 可用于前端 switch/case
- 错误不会导致 Rust panic（unwrap 会 panic，必须处理）

---

## 二、最低回归用例集合

每次迭代至少跑以下 5 个用例：

| 编号 | 场景 | 覆盖的领域 |
|------|------|-----------|
| **REG-1** | SMOKE-03 + SMOKE-04 | 会话创建 + 正常发送 |
| **REG-2** | SMOKE-07 | 历史编辑 non-destructive（最高风险） |
| **REG-3** | SMOKE-08 | regenerate 不创建 branch |
| **REG-4** | SMOKE-10 | compare 设主线不改树 |
| **REG-5** | SMOKE-13 | streaming 中断重启修复 |

如果以上 5 个全部通过，核心架构大概率没被破坏。

---

## 三、发布前必须手测的高风险场景

| 优先级 | 场景 | 为什么高风险 |
|--------|------|-------------|
| **P0** | SMOKE-07 编辑历史 user 消息 | fork_point 算错 = "原历史被覆盖"，产品致命问题 |
| **P0** | SMOKE-08 regenerate | variant 误更新 branch head = "树爆炸" |
| **P0** | SMOKE-13 streaming 中断恢复 | 不修复 = 永远卡住，composer 被禁用 |
| **P1** | SMOKE-06 历史 assistant 继续 | 分支创建 + 路径截断，状态机复杂 |
| **P1** | SMOKE-09 基于候选继续 | variant → branch 升级，buildSendPlan 核心逻辑 |
| **P1** | SMOKE-10 compare 设主线 | 必须保证只改 mainline_branch_id |
| **P2** | SMOKE-02 provider 保存 | secure storage 与 DB 一致性 |
| **P2** | SMOKE-12 级联删除 | PRAGMA foreign_keys 是否生效 |
| **P2** | SMOKE-14 错误传播 | 前端能否拿到结构化错误 |

---

## 四、联调前自检清单

在开始联调前，确认以下基础设施已就位：

- [x] `PRAGMA foreign_keys = ON` 在连接初始化时执行 → `db/mod.rs` init_pool()
- [x] `PRAGMA journal_mode = WAL` 已启用 → `db/mod.rs` connect_options()
- [x] `PRAGMA busy_timeout = 5000` 已设置 → `db/mod.rs` connect_options()
- [ ] DB 路径使用 Tauri app data dir（不是相对路径）
- [x] 启动时日志输出实际 DB 文件路径 → `db/mod.rs` tracing::info
- [x] Streaming inflight repair（修复 status=STREAMING 僵尸消息）已实现 → `message_repair_service.rs`
- [ ] 前端 `tauriCommands.ts` 中所有 invoke 都经过 `cmd()` 错误包装
- [ ] 前端错误处理可展示 TauriAppError.code 和 message
- [ ] 所有 command 的 serde rename_all = "camelCase" 统一

---

## 七、国际化（i18n）实施记录

> 日期：2026-04-08 | 基于：react-i18next 多语言支持

### 架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 框架 | i18next + react-i18next | React 生态标准，tree-shakable，插件丰富 |
| 检测 | i18next-browser-languagedetector | 自动检测浏览器语言，localStorage 持久化 |
| 默认语言 | zh-CN | 产品面向中文用户 |
| 命名空间 | 单一 "translation" | 当前规模不需要多命名空间 |
| 测试策略 | mock t() 返回 key | 测试稳定性不依赖翻译文本变化 |

### 新增文件

| 文件路径 | 职责 |
|----------|------|
| `src/i18n/index.ts` | i18n 配置、语言检测、资源加载 |
| `src/i18n/locales/zh-CN.json` | 简体中文翻译（47 个 key） |
| `src/i18n/locales/en.json` | 英文翻译（47 个 key） |

### 已更新组件（15 个文件）

| 组件 | 替换的硬编码文本数 |
|------|-------------------|
| `MainlineBadge.tsx` | 2 |
| `PathBreadcrumb.tsx` | 3 |
| `TopContextBar.tsx` | 4 |
| `PendingConvergePill.tsx` | 1 |
| `BranchHealthCard.tsx` | 5 |
| `BranchPanel.tsx` | 5 |
| `BranchListItem.tsx` | 5 |
| `HistoryForkBanner.tsx` | 3 |
| `EditForkBanner.tsx` | 3 |
| `DownstreamHiddenCard.tsx` | 2 |
| `AssistantMessageBubble.tsx` | 3 |
| `StreamingAssistantContent.tsx` | 1 |
| `CompareColumn.tsx` | 4 |
| `CompareToolbar.tsx` | 5 |
| `CompareWorkspace.tsx` | 3 |
| `SharedContextStrip.tsx` | 3 |

### 测试影响

| 文件 | 变更 |
|------|------|
| `src/test/setup.ts` | 新增 react-i18next 全局 mock（t() 返回 key） |
| `AssistantMessageBubble.test.tsx` | 更新 3 处文本断言为 translation key |
| `CompareWorkspace.test.tsx` | 更新 2 处文本断言为 translation key |

### 使用方式

在应用入口添加：
```typescript
import "./i18n";
```

在组件中使用：
```typescript
import { useTranslation } from "react-i18next";
const { t } = useTranslation();
<span>{t("common.mainline")}</span>
```

---

## 五、契约审查修复记录

> 日期：2026-04-08 | 基于：前后端联调契约审查报告

### 已修复的高风险问题

| # | 问题 | 修复内容 | 影响文件 |
|---|------|---------|---------|
| H-1 | `ProviderConfig.apiKeyRef` 与后端 `ProviderDto.hasApiKey` 不一致 | `apiKeyRef?: string` → `hasApiKey: boolean` | `src/types/settings.ts` |
| H-2 | `set_mainline_branch` 返回 `()` | 新增 `SetMainlineResult { oldMainlineBranchId, newMainlineBranch }` | Rust: `dto/branches.rs`, `commands/branches.rs`; TS: `tauriTypes.ts`, `tauriCommands.ts` |
| H-3 | `rename/archive/unarchive_branch` 返回 `()` | 改为返回 `BranchDto` | Rust: `commands/branches.rs`, `services/snapshot_service.rs`; TS: `tauriCommands.ts` |

### 已修复的中风险问题

| # | 问题 | 修复内容 | 影响文件 |
|---|------|---------|---------|
| M-1 | `ConversationSummary.lastOpenedAt` 类型不精确 | `lastOpenedAt?: UnixMs` → `lastOpenedAt: UnixMs \| null` | `src/types/conversation.ts` |
| M-2 | `rename/archive/unarchive_conversation` 返回 `()` | 改为返回 `ConversationSummaryDto` | Rust: `commands/conversations.rs`, `repositories/conversations.rs`, `services/snapshot_service.rs`; TS: `tauriCommands.ts`, `appStore.types.ts` |

### 新增文件/函数

- `repositories/conversations.rs` → `get_summary()` 单会话摘要查询
- `services/snapshot_service.rs` → `get_conversation_summary()` 公开函数
- `services/snapshot_service.rs` → `map_branch_row_public()` 公开函数（原 `map_branch_row`）
- `dto/branches.rs` → `SetMainlineResult` DTO
- `tauriTypes.ts` → `SetMainlineResult` 接口

---

## 六、事务边界与锁冲突审查修复记录

> 日期：2026-04-08 | 基于：事务边界与锁冲突风险审查

### 审查发现的问题

| # | 优先级 | 问题 | 风险描述 |
|---|--------|------|---------|
| TX-1 | **P0** | 缺少 PRAGMA foreign_keys = ON | CASCADE 删除不生效，FK 约束不校验，delete_conversation 会留下 orphan 数据 |
| TX-2 | **P0** | 缺少 DB 初始化模块 | 无集中的连接池配置和 PRAGMA 管理 |
| TX-3 | **P1** | complete/fail_assistant_message 无事务 | read-check-update-re_fetch 不在事务内，存在竞态窗口 |
| TX-4 | **P1** | 缺少 WAL 模式 | 读阻塞写，写阻塞读，影响流式输出期间的用户体验 |
| TX-5 | **P1** | 缺少 busy_timeout | 并发写操作立即失败而非等待重试 |
| TX-6 | **P2** | sibling_index 无唯一约束 | 理论上可产生重复 sibling_index 导致树遍历顺序不稳定 |

### 已执行的修复

| # | 问题 | 修复内容 | 影响文件 |
|---|------|---------|---------|
| TX-1+2+4+5 | DB 初始化全部缺失 | 新增 `db/mod.rs`，在连接池创建时统一设置 foreign_keys=ON、journal_mode=WAL、busy_timeout=5000 | `src/db/mod.rs`（新增） |
| TX-3 | complete/fail 无事务 | 包裹 `pool.begin()` → `tx.commit()`，所有 4 次 DB 调用改为 `&mut *tx` | `services/snapshot_service.rs` |
| TX-6 | sibling_index 无唯一约束 | 新增 0002 迁移：`UNIQUE INDEX ON messages(parent_message_id, sibling_index)` + root 消息唯一约束 | `db/migrations/0002_sibling_unique.sql`（新增） |

### 新增测试覆盖

| 测试 ID | 覆盖场景 | 验证的不变量 |
|---------|---------|-------------|
| T-10 | sibling_index 唯一约束 | 重复 sibling_index 被 DB 拒绝；不同 sibling_index 成功 |
| T-11 | delete_conversation CASCADE | 删除会话后 branches 和 messages 表均为 0 行 |

### 事务覆盖现状（修复后）

所有写操作均在事务内：

| 操作 | 事务 | 步骤数 |
|------|------|--------|
| create_conversation | ✅ tx | 4 步（insert conv → insert msg → insert branch → set mainline） |
| create_branch | ✅ tx | 3 步（validate → insert branch → touch conv） |
| create_user_message | ✅ tx | 6 步（validate conv → validate branch → validate edit → compute → insert → update head） |
| create_assistant_placeholder_for_branch | ✅ tx | 5 步（validate → compute → insert → update head → touch） |
| create_assistant_variant_placeholder | ✅ tx | 4 步（validate → compute → insert → touch） |
| complete_assistant_message | ✅ tx | 3 步（validate → update → re-fetch） |
| fail_assistant_message | ✅ tx | 3 步（validate → update → re-fetch） |
