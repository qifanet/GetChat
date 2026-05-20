
# 《前后端联调验收清单 + Tauri/SQLite 常见坑位清单》

我会分成下面 部分：

1. **联调通过的 Definition of Done**
2. **前后端联调验收清单**
3. **数据库不变量检查 SQL**
4. **Tauri/SQLite 常见坑位清单**
5. **联调期日志与诊断建议**

---

# 一、联调通过的 Definition of Done

先定一个明确标准，不然后面会一直处于“好像能跑，但不知道算不算过”。

## 1.1 最低通过标准

满足以下条件，才算“前后端联调基本过关”：

### A. 核心流程可闭环
以下流程都能跑通：

- 启动应用 → onboarding / workspace 正确进入
- 保存 provider → 重启后仍可加载
- 新建会话 → 创建默认 branch
- 正常发送消息 → assistant 流式完成
- 从当前叶子新分支发送
- 从历史 assistant 继续 → 创建 branch
- 编辑历史 user 消息 → 创建 branch，不覆盖原消息
- regenerate 候选回答 → 不创建 branch
- 基于候选继续 → 必要时创建 branch
- compare 两条路径 → 只读对比
- 设某条路径为主线 → 仅改 mainline，不改树结构
- 归档 / 取消归档 branch
- 删除会话 → 级联删除 branches/messages

### B. 关键不变量成立
至少这些 SQL 检查结果为 0 条异常：

- 跨会话 parent_message_id 引用
- branch.head_message_id 指向别的会话
- mainline branch 不存在或已 archived
- edited_from_message_id 指向非 user message
- fork_point_message_id / fork_source_message_id 跨会话

### C. 流式不会把前端打爆
- 流式阶段不做 token 级 React 大量重渲染
- `message.content.text` 不在每个 chunk 时更新
- 重启后不会留下永远 `status=streaming` 的僵尸消息

### D. 重启恢复正常
- 能恢复最近 workspace
- 已完成消息正常显示
- 未完成 streaming 消息会被修复为 `failed` 或 `aborted`
- 不会因为 runtime registry 丢失导致 UI 卡死

### E. 错误处理可感知
- Tauri command 错误前端能拿到结构化错误
- 前端 toast / error banner 能显示有意义信息
- 不会出现 Rust panic 直接让前端一脸空白

---

# 二、前后端联调验收清单

---

# 2.1 联调建议方式

建议分三层验收，不要只靠“UI 点一点”。

## 第一层：命令契约验收
检查：

- command 名是否一致
- 输入输出字段名是否一致
- `null / undefined / Option` 是否对齐
- snake_case / camelCase 是否对齐

## 第二层：领域流程验收
检查：

- 分支创建逻辑
- 历史编辑是否 non-destructive
- variant 是否没误当成 branch
- mainline / archived 是否冲突

## 第三层：持久化与恢复验收
检查：

- 重启恢复
- snapshot 加载
- DB 不变量
- command 执行后 DB 是否正确落地

---

# 2.2 联调验收总表

下面这张表适合你直接作为手工验收清单。

---

## INT-01 启动与 bootstrap

### 前置条件
- 全新本地环境
- DB 为空
- 无 provider

### 操作
1. 启动应用
2. 观察启动页

### 预期前端
- 进入 `OnboardingPage`
- 不会进入空 workspace
- 不会出现空白页或无限 loading

### 预期后端
- `bootstrap_app` 返回：
  - `hasProvider = false`
  - `conversationSummaries = []`
  - `lastWorkspace = null`

### 关键检查
- command 能返回结构化 JSON
- 字段命名和前端类型一致

---

## INT-02 保存 provider 并重启恢复

### 操作
1. 填写 provider
2. 点击测试连接
3. 保存 provider
4. 关闭应用并重新打开

### 预期前端
- 第一次保存成功后能进入 workspace
- 重启后不再进入 onboarding
- provider 列表可正常展示
- 前端拿不到明文 api key

### 预期后端
- `providers` 表有记录
- DB 中只存 `api_key_ref`，不存明文
- `bootstrap_app.hasProvider = true`

### 风险点
- secure storage 写入成功但 DB 写入失败
- 或反过来 DB 成功但 secure storage 失败

### 验收建议
- 保存 provider 时最好事务外分两步，但错误回滚逻辑要清晰
- 至少要有“半成功”错误处理

---

## INT-03 新建会话

### 操作
1. 点击新建会话

### 预期前端
- 会话列表新增一项
- 当前进入该会话 workspace
- 当前 branch 自动就绪
- 标题默认值正确

### 预期后端
- `conversations` 新增一条
- `branches` 新增 root/main branch
- `conversations.mainline_branch_id` 已设值

### 关键不变量
- 会话不应该出现“创建成功但没有 branch”

---

## INT-04 正常发送消息

### 操作
1. 在空会话输入消息
2. 点击发送

### 预期前端
- 新 user message 立即出现
- assistant placeholder 进入 streaming
- 流式阶段渲染稳定、不抖动
- 完成后切 MarkdownRenderer
- branch 仍是当前 branch

### 预期后端 command 序列
```text
create_user_message
→ build_prompt_messages
→ create_assistant_placeholder_for_branch
→ complete_assistant_message
```

### 数据库预期
- user message:
  - `role = user`
  - `parent_message_id = 当前 head`
- assistant message:
  - `role = assistant`
  - `status = completed`
  - `request_id` 有值
- branch.head_message_id 指向 assistant message

### 核心风险
- assistant placeholder 创建了，但 complete 没有落库
- 前端看起来完成了，但 DB 仍然是 streaming

---

## INT-05 “作为新分支发送”

### 操作
1. 当前路径已有若干消息
2. 切 sendMode = `newBranch`
3. 输入并发送

### 预期前端
- 新 branch 被创建
- 当前工作区切换到新 branch
- 原 branch 保持不变
- 右侧 branch panel 能看到新路线

### 预期后端
- `create_branch`
- `create_user_message`
- `create_assistant_placeholder_for_branch`
- `complete_assistant_message`

### 关键不变量
- 原 branch.head_message_id 不应被改写
- 新 branch.source_branch_id 正确
- `fork_source_type = currentLeaf`

---

## INT-06 从历史 assistant 继续

### 操作
1. 在历史某条 assistant message 上点击“从这里继续”
2. 输入新消息并发送

### 预期前端
- 进入 `historyFork` 模式
- 中间消息只显示到该 assistant message
- 显示 banner：将创建新分支，不覆盖原路径
- 成功发送后切换到新 branch，并回到 normal

### 预期后端
- 新 branch 创建成功
- `fork_source_type = historyAssistant`
- `fork_point_message_id = 该 assistant message id`
- `fork_source_message_id = 该 assistant message id`

### 核心不变量
- 原路径后续消息仍保留在 DB 中
- 只是当前工作区“可见消息”被截断

---

## INT-07 编辑历史 user 消息并分支

这是最高风险场景之一。

### 操作
1. 在历史某条 user message 上点击“编辑并分支”
2. 修改文本
3. 保存并发送

### 预期前端
- 进入 `editFork`
- 显示 banner：不会覆盖原路径
- 原后续消息被隐藏并显示 `DownstreamHiddenCard`
- 成功后跳到新 branch

### 预期后端
- 新 branch 创建
- 新 user message 被插入
- 原 user message 不被修改
- 新 assistant message 完成
- branch.head 指向新 assistant

### 最关键的不变量
假设原用户消息是 `U_old`，其 parent 是 `P`：

- `new_user_message.edited_from_message_id = U_old.id`
- `new_user_message.parent_message_id = P.id`
- **不是** `U_old.id`
- `branch.fork_source_message_id = U_old.id`
- `branch.fork_point_message_id = P.id`

### 这是必须重点验收的原因
如果这里做错，UI 看起来就会像“原历史被覆盖了”。

---

## INT-08 regenerate 候选回答

### 操作
1. 在某条 user message 下点击“重新回答”

### 预期前端
- 当前 user message 下新增一个 assistant 候选
- 不进入 compare
- 不自动创建 branch
- 不污染右侧 branch panel

### 预期后端
- `create_assistant_variant_placeholder`
- `complete_assistant_message`

### 关键不变量
- branch.head_message_id 不变
- 只是该 user message 下多了一个 assistant child

---

## INT-09 基于候选继续

### 操作
1. 预览某个非当前下游来源的 assistant variant
2. 输入新消息继续

### 预期前端
- 若存在 downstream conflict，提示“将创建新分支”
- 发送后创建新 branch
- 切到新路径

### 预期后端
- `create_branch`
- `fork_source_type = variant`
- `fork_point_message_id = selected_variant_message_id`
- `fork_source_message_id = selected_variant_message_id`

### 核心检查
- 仅“继续”时升级为 branch
- 单纯 regenerate 不应该有 branch 产生

---

## INT-10 Compare 两条路径并设主线

### 操作
1. 选择两个 branch
2. 进入 compare
3. 点击“设左侧为主线”

### 预期前端
- compare 模式只读
- composer 禁用或隐藏
- 设主线后返回 normal
- 默认打开路径可更新

### 预期后端
- 只调用 `set_mainline_branch`
- `conversations.mainline_branch_id` 更新
- 消息树结构不变

### 核心不变量
- 不能新增 / 删除消息
- 不能重写任何 branch head
- 不能把另一个 branch 删除掉

---

## INT-11 Archive / Unarchive branch

### 操作
1. 归档一条非主线 branch
2. 再取消归档

### 预期前端
- 归档后从 active 区移到 archived 区
- unarchive 后恢复
- 当前 branch 若被归档，要有明确策略（建议先禁止归档当前打开 branch 或归档后切走）

### 后端约束
- 不允许 archive mainline branch
- archived branch 不应被设为 mainline

### 关键检查
- 错误码要明确，比如 `conflict`

---

## INT-12 删除会话级联删除

### 操作
1. 删除一个会话

### 预期前端
- 会话从列表消失
- 若是当前会话，workspace 清空或切到其他会话
- 无残留 branch / message UI

### 预期后端
- `conversations` 删除
- `messages` / `branches` 级联删除

### 核心检查
- `ON DELETE CASCADE` 是否真的生效
- `PRAGMA foreign_keys=ON` 是否打开

---

## INT-13 重启恢复最近工作区

### 操作
1. 打开某会话某 branch
2. 关闭应用
3. 重启

### 预期前端
- 恢复到最近会话 / branch
- 路径与 branch panel 高亮一致
- compare 模式不建议强恢复；恢复为 normal 更稳

### 预期后端
- `save_last_workspace` 已落库
- `bootstrap_app.lastWorkspace` 返回正确值

### 风险点
- branch 被删除或归档后，lastWorkspace 恢复失效
- 应优雅降级到 mainline

---

## INT-14 流式中断与重启修复

### 操作
1. 发送消息开始 streaming
2. 在未完成时强制关闭应用
3. 重启应用

### 预期前端
- 不会一直显示“正在生成”
- 该消息应被修复为：
  - `failed`
  或
  - `aborted`
- 若有 partial text，应能显示

### 预期后端
建议在 bootstrap 时执行 inflight repair：
- 找出旧 `status=streaming` 的消息
- 标记为 `aborted` 或 `failed`
- `error_code = APP_RESTART_INTERRUPTED`

### 这是联调必须过的一项
因为 runtime registry 不可能跨重启恢复。

---

## INT-15 错误映射与 toast

### 操作
分别制造这些错误：

- 归档 mainline branch
- set_mainline 到 archived branch
- create_user_message 时 parent 不存在
- provider connection 失败

### 预期前端
- 能拿到结构化错误
- UI 显示清晰文案
- 不会因为 Tauri 错误变成一整串不可读字符串

### 预期后端
- 使用统一 `AppError`
- 包含至少：
  - code
  - message

---

# 2.3 高风险场景详细验收步骤

下面这 4 个建议你每次版本迭代都回归一次。

---

## 场景 A：历史编辑 non-destructive 验收

### 原始路径
```text
U1 -> A1 -> U2 -> A2
```

### 操作
编辑 `U2`，变成 `U2'`，再生成 `A2'`

### UI 应该看到
- 原路径仍存在：`U1 -> A1 -> U2 -> A2`
- 新路径存在：`U1 -> A1 -> U2' -> A2'`

### DB 必须满足
- `U2` 内容未被更新
- `U2'` 是新 message id
- `U2'.edited_from_message_id = U2.id`
- `U2'.parent_message_id = A1.id`
- 新 branch 的 `fork_point_message_id = A1.id`
- 新 branch 的 `fork_source_message_id = U2.id`

### 若失败，通常意味着
- 你误把 `U2'` 挂在了 `U2` 下
- 或直接 `UPDATE messages SET content_text = ... WHERE id = U2`

---

## 场景 B：regenerate 不应创建 branch

### 原始路径
```text
U1 -> A1 -> U2 -> A2
```

### 操作
对 `U2` 重新回答，得到 `A2b`

### UI 应该看到
- `U2` 下有候选切换器
- 右侧 branch panel 不应新增 branch
- 当前 branch 仍然是原 branch

### DB 必须满足
- 新增 message `A2b`
- `A2b.parent_message_id = U2.id`
- branch.head_message_id 仍然可以是 A2 或当前路线 head，不因 regenerate 自动改变

---

## 场景 C：compare 设主线不改树

### 操作
对比 branch L / R，设 R 为主线

### DB 应该只发生
- `conversations.mainline_branch_id = R.id`

### 不应该发生
- 不应该新增消息
- 不应该删 branch
- 不应该改 branch.head

---

## 场景 D：streaming 中断恢复

### 操作
assistant streaming 到一半强退

### 重启后 DB 应该看到
- 不存在一直卡在 streaming 的旧消息
- 该消息被标记为 failed/aborted
- partial text 若有则保留

---

# 三、数据库不变量检查 SQL

下面这部分非常适合你联调时直接跑。

建议你准备一个 debug 脚本或 debug-only command 来执行这些 SQL。

---

## 3.1 检查跨会话 parent 引用

```sql
SELECT
  m.id AS message_id,
  m.conversation_id AS child_conversation_id,
  p.id AS parent_id,
  p.conversation_id AS parent_conversation_id
FROM messages m
JOIN messages p ON m.parent_message_id = p.id
WHERE m.conversation_id <> p.conversation_id;
```

**预期结果：0 行**

---

## 3.2 检查 branch.head 指向错误会话

```sql
SELECT
  b.id AS branch_id,
  b.conversation_id AS branch_conversation_id,
  m.id AS head_message_id,
  m.conversation_id AS head_conversation_id
FROM branches b
JOIN messages m ON b.head_message_id = m.id
WHERE b.conversation_id <> m.conversation_id;
```

**预期结果：0 行**

---

## 3.3 检查 mainline branch 非法

```sql
SELECT
  c.id AS conversation_id,
  c.mainline_branch_id,
  b.status AS branch_status,
  b.conversation_id AS branch_conversation_id
FROM conversations c
LEFT JOIN branches b ON b.id = c.mainline_branch_id
WHERE c.mainline_branch_id IS NOT NULL
  AND (
    b.id IS NULL
    OR b.conversation_id <> c.id
    OR b.status <> 'active'
  );
```

**预期结果：0 行**

---

## 3.4 检查 edited_from 指向非法消息

```sql
SELECT
  m.id AS new_message_id,
  m.edited_from_message_id,
  src.role AS source_role,
  m.conversation_id AS new_conv,
  src.conversation_id AS src_conv
FROM messages m
LEFT JOIN messages src ON src.id = m.edited_from_message_id
WHERE m.edited_from_message_id IS NOT NULL
  AND (
    src.id IS NULL
    OR src.role <> 'user'
    OR src.conversation_id <> m.conversation_id
  );
```

**预期结果：0 行**

---

## 3.5 检查 branch.fork_point 跨会话

```sql
SELECT
  b.id AS branch_id,
  b.conversation_id AS branch_conv,
  fp.id AS fork_point_id,
  fp.conversation_id AS fork_point_conv
FROM branches b
JOIN messages fp ON fp.id = b.fork_point_message_id
WHERE b.fork_point_message_id IS NOT NULL
  AND b.conversation_id <> fp.conversation_id;
```

**预期结果：0 行**

---

## 3.6 检查 branch.fork_source 跨会话

```sql
SELECT
  b.id AS branch_id,
  b.conversation_id AS branch_conv,
  fs.id AS fork_source_id,
  fs.conversation_id AS fork_source_conv
FROM branches b
JOIN messages fs ON fs.id = b.fork_source_message_id
WHERE b.fork_source_message_id IS NOT NULL
  AND b.conversation_id <> fs.conversation_id;
```

**预期结果：0 行**

---

## 3.7 检查 request_id 重复

如果你已经建了 partial unique index，这个理论上不会有结果，但联调期仍值得查。

```sql
SELECT request_id, COUNT(*) AS cnt
FROM messages
WHERE request_id IS NOT NULL
GROUP BY request_id
HAVING COUNT(*) > 1;
```

**预期结果：0 行**

---

## 3.8 检查会话没有 branch

```sql
SELECT c.id
FROM conversations c
LEFT JOIN branches b ON b.conversation_id = c.id
GROUP BY c.id
HAVING COUNT(b.id) = 0;
```

**预期结果：0 行**

---

## 3.9 检查长期卡住的 streaming 消息

```sql
SELECT
  id,
  conversation_id,
  request_id,
  updated_at
FROM messages
WHERE status = 'streaming'
  AND updated_at < (strftime('%s','now') * 1000 - 60000);
```

**预期结果：正常使用时 0 行**

---

## 3.10 检查 assistant variant 是否误更新了 branch head（启发式）

这个不是绝对错误检查，但可以辅助发现 regenerate 流程误改 head。

```sql
SELECT
  b.id AS branch_id,
  b.head_message_id,
  m.parent_message_id,
  parent.role AS parent_role
FROM branches b
JOIN messages m ON m.id = b.head_message_id
LEFT JOIN messages parent ON parent.id = m.parent_message_id
WHERE m.role = 'assistant'
  AND parent.role = 'user';
```

### 如何使用
- 如果你刚做了 regenerate，且没有继续分支
- 但 branch head 变成了新候选 message
- 就可能是错误实现

---

# 四、Tauri/SQLite 常见坑位清单

下面这些坑，基本都是联调时高频出现的。

我用“现象 → 根因 → 修复建议”的方式列。

---

# 坑 1：开发环境和生产环境用了不同数据库路径

## 现象
- 你明明保存了 provider / conversation
- 重启后像全新应用
- 或者 dev 能看到数据，打包后全没了

## 常见根因
- 使用了相对路径，如 `./app.db`
- 没有使用 Tauri app data dir
- dev 与 prod 的工作目录不同

## 修复建议
- 永远使用 Tauri 提供的 app data dir
- 启动时打印实际 db path
- 确保目录存在后再建库

## 联调必须检查
- 每次启动日志里都输出一次：
  - app data dir
  - db file path

---

# 坑 2：`PRAGMA foreign_keys=ON` 没开

## 现象
- 删除 conversation 后 messages / branches 残留
- 出现 parent_message_id 指向不存在节点
- 级联删除不生效

## 根因
- SQLite 默认不一定启用 foreign keys
- 你以为建了 FK 就一定生效，但其实连接级别没开

## 修复建议
在每个连接初始化时执行：

```sql
PRAGMA foreign_keys = ON;
```

## 联调检查
- 删除 conversation 后跑不变量 SQL
- 确认无 orphan rows

---

# 坑 3：`mainline_branch_id` 和 branch DTO 的 `isMainline` 双写不一致

## 现象
- 前端显示两个主线
- 右侧显示 A 是主线，但 bootstrap 后变成 B
- compare 设主线后 UI 一部分更新，一部分没更新

## 根因
- DB 里也存了 `branches.is_mainline`
- 又在 conversation 上存了 `mainline_branch_id`
- 两边没同步

## 修复建议
- 数据库里只保留 `conversations.mainline_branch_id`
- `BranchDto.isMainline` 只在返回 DTO 时派生

---

# 坑 4：历史编辑的 fork point 算错了

## 现象
- 编辑历史 user message 后，原路径像被覆盖
- 或新 branch 的消息顺序诡异
- selector 显示路径断裂

## 根因
把：
- `fork_point_message_id`
错误写成了：
- 原 user message 自己

而正确应该是：
- 原 user message 的 parent

## 修复建议
historyUserEdit 时：

- `fork_source_message_id = 原 user message`
- `fork_point_message_id = 原 user message.parent_message_id`
- 新 user message.parent = 原 user message.parent

---

# 坑 5：regenerate 候选回答错误更新了 branch head

## 现象
- 重新回答一次，右侧 branch panel 就像多了一条路
- 当前路径默认切到了新候选
- 用户觉得“树爆炸”

## 根因
把 variant 当 branch 处理了。

## 修复建议
regenerate 只做：
- 在同一 user message 下插入新的 assistant child
- 不更新 branch head
- 不创建 branch

---

# 坑 6：前端 optimistic patch 和后端真实 snapshot 漂移

## 现象
- 中间消息流显示 A 路
- 顶部 breadcrumb 是 B 路
- 右侧 branch 高亮是 C 路

## 根因
- 前端自己 patch 了一些本地状态
- 后端返回的数据字段又不同
- 没有统一使用 canonical DTO 或 refetch snapshot

## 修复建议
对于这些高风险变更，优先使用后端返回 canonical entity：
- create_branch
- create_user_message
- create_assistant_placeholder
- set_mainline_branch

必要时：
- 关键动作后 refetch summary/snapshot

---

# 坑 7：Tauri `invoke` 字段命名不一致

## 现象
- Rust command 明明存在，但前端报参数缺失
- 某些字段一直是 null
- 某些 bool / Option 对不上

## 根因
- Rust 用 snake_case
- TS 用 camelCase
- serde rename 没统一

## 修复建议
- command 输入输出 struct 统一：
  ```rust
  #[serde(rename_all = "camelCase")]
  ```
- 前端 DTO 统一 camelCase

---

# 坑 8：Tauri 错误返回不结构化

## 现象
- 前端拿到一整串字符串
- 很难根据错误码做 toast / 分支处理
- AI coding assistant 也难稳定生成调用层

## 根因
- `AppError` 没做统一序列化
- 直接把 anyhow/string 往外抛

## 修复建议
统一错误结构，例如：

```ts
type AppErrorDto = {
  code: string;
  message: string;
};
```

并保证 Tauri command 前端拿到的是这个结构。

---

# 坑 9：streaming 强退后留下永远 streaming 的消息

## 现象
- 重启后消息永远显示“生成中”
- composer 一直禁用
- request_id 已失效但前端还在等

## 根因
- runtime registry 是内存态，重启丢失
- DB 中 placeholder 仍然是 `status=streaming`
- 启动时没 repair inflight messages

## 修复建议
在 bootstrap / app init 阶段增加修复逻辑：
- 找出 `status=streaming` 的旧消息
- 标记为 `aborted` 或 `failed`
- 填错误码 `APP_RESTART_INTERRUPTED`

---

# 坑 10：没有 `ORDER BY`，导致列表顺序飘

## 现象
- 相同数据，每次加载路径顺序不一样
- variant 顺序抖动
- branch 列表刷新后跳动

## 根因
SQLite 不保证无 `ORDER BY` 的结果顺序稳定。

## 修复建议
所有这些地方都要显式排序：
- conversation summaries：`updated_at DESC`
- messages children：`sibling_index ASC, created_at ASC`
- branches：`updated_at DESC` 或明确分组排序

---

# 坑 11：SQLite 事务边界太小，导致半成功

## 现象
- create conversation 后有 conversation 但没 initial branch
- user message 写进去了，但 branch.head 没更新
- assistant placeholder 有了，但 conversation.updated_at 没变

## 根因
本该在一个事务内的多步动作分成了多个独立 SQL。

## 修复建议
这些操作必须进事务：
- create_conversation
- create_branch
- create_user_message
- create_assistant_placeholder_for_branch

---

# 坑 12：`sibling_index` 计算冲突或不稳定

## 现象
- 同一 parent 下候选顺序乱
- 并发 regenerate 时 sibling_index 重复

## 根因
- 用 `COUNT(*)` 算 sibling_index
- 并发事务时没有正确序列化

## 修复建议
v1 可接受方案：
- 在写入该 parent 子节点时使用事务并重试
- 保证获取 next sibling_index 的读写在一个事务里
- 至少在单机单用户场景下降低冲突

---

# 坑 13：用阻塞式数据库调用卡住 Tauri UI

## 现象
- 点击某命令时 UI 卡顿
- 特别是 snapshot 加载、大量消息时明显

## 根因
- 在 command 里用阻塞操作
- 没有把查询/组装合理拆层

## 修复建议
- 使用 async sqlx
- snapshot service 做合理组装
- 不要在 command 里塞太多同步重活

---

# 坑 14：secure storage 与 DB 记录失配

## 现象
- provider 列表还在，但连接测试永远失败
- 删除 provider 后 secure storage 残留
- 重装后 provider 记录存在但 key 丢失

## 根因
- DB 和 secure storage 是两个系统
- 没有处理“只有一边成功”的情况

## 修复建议
- ProviderDto 返回 `hasApiKey`
- 启动时或 list 时可检查 key 是否还存在
- 若 key 丢失，前端提示“需要重新填写”

---

# 坑 15：compare 模式和 normal 模式边界不清

## 现象
- compare 页面还能发送
- 退出 compare 后 currentBranchId 错乱
- top bar / breadcrumb 没切回正常路径

## 根因
- compare 只是一个 UI overlay，而不是显式 workspaceMode
- 状态切换没有单点管理

## 修复建议
- compare 一定是显式 `workspaceMode = compare`
- composer 禁用或隐藏
- 退出 compare 时明确设置 target branch

---

# 五、联调期日志与诊断建议

这部分非常推荐你做，不然 debug 会非常痛苦。

---

# 5.1 后端每个 command 建议记录的字段

至少记录：

```text
command_name
trace_id
conversation_id
branch_id
message_id
request_id
duration_ms
result=ok|error
error_code
```

---

# 5.2 不建议记录的内容

不要随便打日志：

- 明文 api key
- 全量 prompt 内容
- 长文本完整 assistant 输出

可以替代记录：

- prompt message count
- content length
- request id
- provider/model id

---

# 5.3 前端建议记录的关键事件

你前面已经有事件体系，联调时至少打这些：

- `route.workspace.opened`
- `conversation.loaded`
- `workspace.branch.selected`
- `workspace.mode.changed`
- `composer.send.requested`
- `message.assistant.stream.started`
- `message.assistant.stream.completed`
- `message.assistant.stream.failed`
- `branch.created`
- `branch.mainline.set`

这样你能快速对齐：
- 前端以为发生了什么
- 后端实际上执行了什么

---

# 5.4 推荐增加一个 debug-only 命令

非常推荐做一个仅开发环境可用 command：

## `run_invariant_checks`

返回：

```ts
type InvariantCheckResult = {
  ok: boolean;
  issues: Array<{
    code: string;
    message: string;
    rowCount: number;
  }>;
};
```

这样联调时前端或 dev tools 一键点一下，就知道 DB 是否已脏。

---


# 七、我额外建议你做的两个“联调加速器”

---

## 7.1 增加一个 debug 面板
可以临时放在 settings 或 dev-only 页面，显示：

- 当前 conversationId
- currentBranchId
- mainlineBranchId
- workspaceMode
- activeRequestId
- activeSnapshot loadedAt
- 最近 20 条 command 调用结果
- `run_invariant_checks` 结果

这样很多错位问题一眼就能看出来。

---

## 7.2 给关键 command 返回 canonical DTO
联调阶段尤其推荐这几个 command 返回完整实体，而不是 `void`：

- `create_conversation`
- `create_branch`
- `create_user_message`
- `create_assistant_placeholder_for_branch`
- `complete_assistant_message`
- `set_mainline_branch`

理由很简单：
前端不用“猜自己改对没”，而是直接使用后端确认过的结果。

---

# 八、最后给你一个最推荐的联调执行顺序

建议你现在按这个顺序联调：

1. **I2 契约审查**
2. **I7 事务边界审查**
3. **I3 数据库不变量检查器**
4. **I5 启动修复 streaming**
5. **I1 联调矩阵**
6. **I6 集成测试**
7. **I8 日志埋点**
8. **I9 联调通过报告模板**

这个顺序能最大程度减少“UI 表面看起来能跑，但底层已经脏了”的问题。

---
