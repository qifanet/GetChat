# ARCHITECTURE.md — GetChat 架构文档

> 状态: Active · 文档驱动开发三件套之一（配合 [CAPABILITIES.md](./CAPABILITIES.md) / [DEVELOPMENT.md](./DEVELOPMENT.md)）
> 基线版本: v1.5.0（feat/v1.5.0 分支）· 更新日期: 2026-09-05
> 本文档回答三个问题：系统现在长什么样（As-Is）、目标长什么样（To-Be）、怎么从现在走到目标（迁移路径）。
> 修改架构相关代码时，必须同步更新本文档对应章节；文档与代码不一致视为缺陷。

---

## 1. 文档驱动开发读法

三份文档各管一件事，禁止互相复制内容：

| 文档 | 回答的问题 | 变更频率 |
|---|---|---|
| **ARCHITECTURE.md**（本文） | 模块如何分层、数据如何流动、不变量是什么、为什么这样设计 | 架构决策变更时 |
| **CAPABILITIES.md** | 系统能做什么、每项能力做到什么程度、缺陷在哪里 | 每个里程碑验收时 |
| **DEVELOPMENT.md** | 按什么顺序做、每步的验收门禁是什么、风险如何应对 | 每周 / 每里程碑 |

理论依据：`docs/private/Agent开发指导手册.md`（下称"手册"）；既有工程约束：`CLAUDE.md`、`.cursor/rules/development-sop.mdc`、`docs/private/TECHDESIGN-agent-loop-harness-guidelines.md`。

---

## 2. 系统全景（As-Is）

### 2.1 模块地图

```
┌─ Frontend (React 19 + TS strict + Zustand + Tailwind v4) ──────────────┐
│ components/            UI 组件（chat/branches/compare/settings/...）    │
│ services/
│   ├─ tauriCommands.ts  全部 Tauri invoke 的类型安全封装（唯一入口）       │
│   ├─ streamController  流式编排：chunk→registry→surface→一次性提交       │
│   └─ streamRuntimeRegistry  非序列化运行时（buffer/timer/surface）       │
│ stores/ (useAppStore/useStreamStore/useThemeStore)  仅快照+UI 状态       │
│ selectors/  树路径/兄弟/共享上下文纯函数                                  │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ Tauri Channel + invoke
┌──────────────────────────────▼─────────────────────────────────────────┐
│ Backend (Rust + Tauri v2 + sqlx + SQLite)                               │
│ commands/    Tauri command 层（★ streaming.rs 3453 行，含 Agent 循环）   │
│ services/    model_stream / snapshot / helper_ai / mcp_client / ...     │
│ repositories/  SQL 访问层（messages/branches/conversations/task_queue） │
│ db/migrations/  0001–0014 编号迁移                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 一次对话请求的数据流（现状）

```
用户发送
 → streamController.startStream() → tauriCommands.startModelStream(input)
 → [Rust] start_model_stream (streaming.rs:159)
    ├─ 全局单流检查（同一时刻只允许一个 stream，streaming.rs:169）★
    ├─ resolve_stream_request（model_stream_service.rs，密钥来自 keyring）
    └─ run_react_loop(streaming.rs:1215-1924) —— 一个 ~710 行函数：
        1) 内联拼装提示词（工具指引/技能元数据/激活提示，字符串追加到首条 system）
        2) maybe_compress_react_prompt（60% 预算触发 AI 压缩）
        3) stream_model_response（SSE + DSML 兜底解析，带 5 次指数退避重试）
        4) 收到 tool_calls → 串行逐个：审批判断 → oneshot 等用户 → 执行 → 截断(8000 字符)
           → 预追加压缩(96% 阈值) → 写入 prompt
        5) tool boundary 处 drain 全局 inject queue（Dual-Queue 注入）
        6) 连续失败/最大轮次 → 兜底"无工具最终回答"
 → 前端 Channel 事件 → streamController → DOM TextNode 表面（~24ms 节流）
 → 完成后一次性提交 appStore + SQLite → MarkdownRenderer 接管
```

> M1 更新：循环迁入 `agent/runner.rs`、压缩编排迁入 `agent/context.rs`、注入队列会话作用域化（`agent/session.rs`）；`commands/streaming.rs` 缩为 command 壳（695 行），MCP 管理/Skills 拆至 `commands/mcp.rs`、`commands/skills.rs`。全局单流检查仍在 `start_model_stream`（M4/S5 引入 per-conversation 流锁）；`TODO_STORE` 按 conversation_id 键控的全局静态留待 M2 工具模块落库。
>
> M4 更新：per-conversation 流锁落地（A1 ✅）；任务队列收口为 `agent/taskqueue/mod.rs::TaskQueueScheduler` 单实现（A4 ✅，`services/task_worker.rs`/`task_queue_service.rs` 删除），并行分叉经 `execute_parallel_fork` → 入队 → 服务端 `drive_task_stream` 驱动完整 ReAct 循环（A2 ✅），事件经 `task_stream_event`/`task_queue_changed` 桥接前端（`services/taskStreamBridge.ts`，worker 会话 `completionMode: TASK_WORKER` 全服务端持久化）；注入撤回 `cancel_injected_message`（M4.6）。

### 2.3 数据所有权（继续有效的核心不变量）

这些不变量来自 v1.0–v1.4 的设计并继续有效，任何重构不得破坏：

1. **SQLite 是唯一事实源**；Zustand 只存当前快照、workspaceMode、UI 状态。
2. **消息树非破坏性**：`messages.parent_message_id` 成树；branch 是命名路径指针（`source_branch_id / fork_point_message_id / fork_source_type / fork_source_message_id / head_message_id`）；`conversations.mainline_branch_id` 是唯一主线指针；regenerate 产生 assistant variant（兄弟节点）而非 branch。
3. **流式 chunk 不进 React state / Zustand / SQLite**（双层流式架构，streamRuntimeRegistry ↔ streamController）。
4. **API Key 只存 keyring 引用**，DB 与前端不接触明文。
5. **意图型 commands**，禁止 `update_message_content / patch_branch_head / generic_patch_entity`。
6. DB 不存 childIds/indexes 等运行时派生字段，快照加载时构建。

---

## 3. Agent 运行时债务清单（As-Is 诊断）

> 以下每条都有代码证据，是目标架构的立项依据。严重度：🔴 阻断功能/并发正确性 · 🟠 结构性债务 · 🟡 改进项。

### 🔴 正确性与功能阻断类

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| A1 | ~~**全局单流锁堵死并行分叉**：`start_model_stream` 在全局 `active_model_streams` 上检查"已有任意流活动即拒绝"，而 v1.5.0 的核心卖点就是并行分支流~~ ✅ M4.3 落地：per-conversation 流锁（同 conversation 独占、跨会话/分支放行，`STREAM_ALREADY_ACTIVE` 语义保留；worker 流与主动流共用该锁） | `commands/streaming.rs`（`agent_sessions` 按 conversation_id 索引） | ~~PRD Feature A 端到端不可实现；任务队列串行执行也会与用户主动对话互相顶掉~~ 并行分叉端到端可达成 |
| A2 | ~~**并行分叉不产生任何 AI 输出**：`execute_parallel_fork` 中创建分支是 TODO，只入队任务；`TaskWorker::execute_parallel_fork` 只建 branch+user message，从不调用 `start_model_stream`~~ ✅ M4.4 落地：`execute_parallel_fork` 走 `snapshot_service::create_parallel_fork_branch`（assistant placeholder + sibling_index max+1），执行由 `agent/taskqueue` 调度器 `drive_task_stream` 服务端驱动完整 ReAct 循环，事件经 `task_stream_event` 前端渲染 | `commands/proposal.rs`、`agent/taskqueue/mod.rs` | ~~分支创建后是空壳，无 assistant placeholder、无流~~ 分支创建即入队即执行 |
| A3 | ~~**全局可变静态状态导致并发会话互相污染**：inject_queue 全局静态；todo 工具的会话上下文全局变量~~ ✅ M1/M2 落地：inject 队列会话作用域化（`agent/session.rs`，随 agent session 生命周期）；TODO_STORE 按 conversation_id 键控（`ToolExecutionContext.conversation_id`，全局 setter 已删除） | `agent/session.rs`、`agent/tools/builtin/todo.rs` | ~~两个并发流同时运行时 todo 写串、注入串会话~~ 并发流互不污染 |
| A4 | ~~**TaskWorker 与 TaskQueueService 双实现并存**：后者整体 `#[allow(dead_code)]` 是死代码；真实 worker 用 1s 忙轮询，无事件唤醒、无重启恢复（RUNNING 任务永久卡死）、无 429 处理~~ ✅ M4.1 落地：双实现删除，`agent/taskqueue/mod.rs::TaskQueueScheduler` 单实现——`Notify` 事件驱动 + 30s 兜底轮询、启动恢复（RUNNING→QUEUED attempts+1 + resume PAUSED）、429 读 Retry-After 缺省 30s PAUSED 退避（attempts≤5）、进度合并写 `config_json.progress`；watch 通道支持运行中取消 | `agent/taskqueue/mod.rs`、`repositories/task_queue.rs` | ~~队列语义碎片化；重启后任务永远 RUNNING；PRD 承诺的 429 暂停/重试不存在~~ 队列语义统一，恢复/退避/取消齐备 |

### 🟠 结构性债务类

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| B1 | **Agent 循环长在 command 层**：`run_react_loop`（~710 行）+ 审批 + 重试 + 压缩编排全部内联在 `commands/streaming.rs`（3453 行，还混有 MCP 密钥编解码、工具设置、安全策略、slash 命令） | `streaming.rs:1215-1924` 等 | 违反自家 SOP"commands 只做参数接入"；不可单测、不可复用、不可替换范式 |
| B2 | **范式层缺失**：只有单一硬编码 ReAct 循环；无 Plan/Reflect 阶段、无策略抽象、无会话级策略配置；工具指引/技能元数据/激活提示是循环内的字符串拼接，无 PromptBuilder | `streaming.rs:1277-1376` | 手册 §3.4 混合范式、§5.1 策略模式无法落地；提示词散落 Rust 源码，无法评审与测试 |
| B3 | **上下文管理三套策略散落在循环里**：`maybe_compress_react_prompt`(60%) / pre-append 压缩(96%) / `prune_old_tool_results`+`apply_deterministic_budget_trim`，加上 8000 字符硬截断，彼此不知道对方 | ~~`streaming.rs` 内联三处~~ ✅ M3 归一：预算台账 `agent/budget.rs`（Budget + 可配置阈值）+ `enforce_budget()` 单入口（`agent/context.rs`）；超长结果落盘 `tool_result_overflow` + `read_tool_result` JIT 取回 | 手册 §7.2 GSSC 流水线无从谈起；预算口径分裂，行为难预测（口径已归一；GSSC 全流水线随记忆系统 v1.6） |
| B4 | **工具系统单体**：7 个内置工具 + MCP 路由 + 审批黑名单 + 一个 ~400 行手写计算器解析器全部在 `tool_executor.rs`（2049 行）；单轮多工具串行执行，无并行策略 | ~~`services/tool_executor.rs`~~ ✅ M2 全部完成：拆分为 `agent/tools/`（registry + executor + builtin/ 七模块）；审批数据化为 `agent/policy.rs` 规则表；并行执行落地（免审批+Safe 连续段 `join_all`、按序回填、串行回退开关） | 新工具必须改单体；BFCL 意义上的 parallel 调用无法兑现；无法按工具做风险分级 |
| B5 | **审批策略与机制耦合**：`requires_tool_approval` + 黑名单匹配 + oneshot 等待全部内联在工具循环里（~110 行嵌套） | `streaming.rs:1543-1654`（决策与等待均已迁入 `agent/policy.rs`：规则表 + `request_user_approval`，✅ M2.3/M2.5） | 手册 §8.3 的"规则强制审批/审计"无法演进；无法配置化（审计持久化随 M5） |
| B6 | **可观测性缺失**：循环只有 tracing 日志；无 run 级审计（轮次、每轮 token、工具时延、审批记录），前端无法展示 Agent 轨迹 | 全局检索无 `agent_runs` 类持久化 | 无法调试"这轮为什么调了这个工具"，无法做手册 §10 的持续评估 |

### 🟡 改进项

- ~~工具结果 8000 字符硬截断无落盘引用（超长结果信息直接丢失）。~~ ✅ M3.3 落盘 + `read_tool_result` JIT 取回。
- ~~重试退避未读取 `Retry-After`（PRD 已承诺）。~~ ✅ M4.1 任务队列读 `retry_after`（缺省 30s）；交互流重试退避仍在 `agent/runner.rs`。
- ~~`task_worker` 的 sibling_index 用 task_id 哈希 %1000，仍可能撞 UNIQUE 约束（`task_worker.rs:152`）。~~ ✅ M4.4 `max+1` 查询，task_worker 已删除。
- `model_stream_service.rs`（2019 行）混合了 provider 适配、SSE 解析、DSML 兜底解析、序列校验——DSML 兜底对不支持原生 function calling 的 provider 有价值，但应独立成模块。
- 文档失真：`FINAL-SUMMARY-v1.5.0.md` 宣称"100% / 无债务 / 可发布"，但 smoke 清单全部未勾选，A2/A4 与之矛盾。（M0 已标注修正；A2/A4 已由 M4 收口）

---

## 4. 目标架构（To-Be）

### 4.1 设计原则（手册 → GetChat 的映射）

| 手册原则 | GetChat 落地 |
|---|---|
| §5.1 分层架构、模板方法、策略模式 | `agent::runner` 模板方法固定流程骨架；`agent::paradigm` 策略接口（ReAct 先行，Plan/Reflect 可插拔） |
| §5.3 核心硬编码 + 扩展工具化 + 验收门禁 | PromptBuilder 三段式：**Core**（身份/环境快照/任务状态，每轮必注入，不给模型选择权）+ **Extension**（工具/技能/MCP 经 function calling）+ **Gates**（记忆写入门禁、最终回答门禁） |
| §7.2 GSSC 流水线 | `agent::context::ContextManager`：Gather(快照/选择器) → Select(importance 评分) → Structure(PromptBuilder 分节) → Compress(helper_ai 摘要 + 确定性裁剪) |
| §7.1 JIT / 渐进披露 | 技能只注入 Tier1 元数据（现状保留）；超长工具结果落盘 + 引用句柄，模型按需取回 |
| §7.3 子代理/上下文交接 | 任务队列的每个分支/子任务 = 独立上下文的隔离会话，只把结果摘要回传（v1.5 用并行分叉兑现，v1.6 泛化） |
| §8.1 MCP | 保留现有 rmcp 集成，工具命名空间化（`mcp__<server>__<tool>`）并入统一 Registry |
| §8.3 Guardrails/强制审批/审计 | `agent::policy::PolicyEngine`（数据化规则表：风险等级→审批策略）+ `agent_runs` 审计持久化 |
| §10 三层评估 | 任务级（run 指标）/ 质量级（LLM Judge 冒烟）/ 漂移检测（golden 用例集进 CI） |
| §3.1 Function Calling 优先 | 继续以原生 tools 为主协议；DSML 兜底仅服务无原生工具调用的 provider，独立模块 |
| §3.4 混合范式 | 默认 ReAct；检测到多步任务时引导 Plan（todo 工具即计划状态载体）；最终回答可选 Reflect 门禁（helper 模型） |

### 4.2 目标模块边界

```
src-tauri/src/
├─ agent/                      【新】Agent 运行时（纯 Rust，不依赖 tauri::command）
│  ├─ mod.rs                   AgentRunner 模板方法 + LoopState 状态机
│  ├─ session.rs               AgentSession：request_id 作用域的一切可变状态
│  │                           （inject 队列、todo 上下文、审批注册表、取消令牌）
│  ├─ events.rs                AgentEventSink trait + TauriChannelSink 实现
│  ├─ prompt/                  PromptBuilder（Core/Extension/Gates 分节，纯函数可单测）
│  ├─ context/                 ContextManager（预算台账 + GSSC + 三套策略归一）
│  ├─ tools/                   ToolRegistry + 每工具一文件 + 并行执行器（M2.1/M2.4）
│  │   ├─ registry.rs  executor.rs（含 META 查询/并发级）
│  │   └─ builtin/{file,terminal,todo,web_search,load_skill,parallel_branch_fork,read_tool_result,calculator}.rs
│  ├─ policy.rs                审批决策矩阵 + 审批等待单元（M2.3/M2.5）
│  ├─ budget.rs                预算台账 Budget + 可配置阈值 BudgetThresholds（M3.1）
│  ├─ paradigms/               react.rs（默认）；plan_execute.rs / reflect.rs（预留接口）
│  ├─ taskqueue/               调度器（Notify 事件驱动 + 重启恢复 + 429 退避）+ worker
│  └─ eval/                    scripted provider（脚本化模型）+ golden 用例
├─ commands/                   瘦身为参数接入：streaming.rs 仅保留 command 壳 + 审批/设置类命令
├─ services/model_stream_service.rs  拆为 provider/ 适配层（见 4.4）
└─ （repositories/db/dto 不变）
```

> M1 已落地：`agent/deps.rs`（依赖缝合 + StreamBackend/McpBackend/CompressionBackend 注入）、`agent/runner.rs`（循环/工具执行本体，逐字迁移）、`agent/context.rs`（mid-loop + pre-append 压缩编排）、`agent/prompt.rs`（提示词组合）、`agent/session.rs`（request_id 作用域 inject 队列）、`agent/eval/`（mock_provider + golden 用例）。M2 已落地：`agent/tools/`（registry.rs 的 ToolMeta + executor.rs 框架 + builtin/ 七工具一模块，`services/tool_executor.rs` 已删除，逐字迁移经多重集 diff 验证）；`agent/policy.rs`（审批决策矩阵 APPROVAL_RULES + 审批等待单元 request_user_approval，语义逐位保留）；并行执行器（runner 内批遍历：免审批+Safe 连续段 `join_all` 并行、结果按原顺序回填，`PARALLEL_TOOL_EXECUTION_ENABLED` 常量可全局回退串行）；MCP 元数据默认 High/Safe/60s 并入 registry，per-tool META 超时接入 `execute_tool_checked`。后续里程碑继续填充 taskqueue/（M4）；`AgentEventSink` 并入 M5 可观测性（见 DEVELOPMENT.md M1.2）。

### 4.3 AgentRunner 状态机（对齐既有 harness 指导文档）

```
Idle → PreparingContext → CallingModel → Streaming
    → WaitingToolApproval → ExecutingTools → PersistingCheckpoint
    → (回 CallingModel | Completed | Failed | Canceled)
```

每次迁移携带 `run_id / conversation_id / turn_index / event_seq`；状态迁移本身是 `AgentEvent` 的一种，可被 UI 消费与审计持久化。退出条件保持现有四类：完成、取消、不可恢复失败、达到上限（max_iterations / max_consecutive_failures 软停止）。

### 4.4 数据流（To-Be）

```
start_model_stream (command 壳，<50 行)
 → AgentRunner::run(AgentRunPlan)                【agent::runner，模板方法】
    ├─ AgentSession::new(request_id)             【消灭全局静态（A3）】
    ├─ ContextManager.prepare() → PromptBundle   【GSSC：Core+Extension+Gates】
    ├─ paradigm.step():                          【策略模式（B2）】
    │    ModelAdapter.stream(request)            【provider/ 适配层 + 指数退避 + Retry-After】
    │    ToolRouter.execute(tool_calls)          【PolicyEngine 审批 → 无副作用工具并行 → 结果规范化】
    │    ContextManager.enforce_budget()         【统一预算台账（B3）】
    │    session.drain_injections()              【tool boundary 注入，作用域内】
    └─ Sink.emit(AgentEvent) → Channel + agent_runs 审计【B6】
```

并行能力：**流级锁从"全局一个"改为"每 conversation 一个"**（A1）——同一 conversation 内仍串行（保护消息树写序），跨 conversation/分支可并行；任务队列并发度 `max_parallel` 可配置，默认 1（尊重串行化规避 RPM 的既有决策）。

### 4.5 提示词与记忆的分层（手册 §5.3/§6.3 落地）

```
┌ Core（硬编码，每轮必注入，顺序稳定以保 prompt cache 前缀）─────────┐
│ ① 应用级 system prompt（现有 system_prompt_service，保持稳定前缀） │
│ ② 环境快照（workspace 路径、平台、shell、当前分支/模式）           │
│ ③ 任务状态（todo 工具的当前清单状态，自动注入而非靠模型自觉）        │
├ Extension（按需，function calling 约束）──────────────────────────┤
│ ④ 工具指引（现 1277-1307 行内容迁入 PromptBuilder，可测试）         │
│ ⑤ 技能 Tier1 元数据 + 激活提示                                     │
│ ⑥ MCP 工具命名空间说明                                             │
├ Gates（写入/收尾前检查）──────────────────────────────────────────┤
│ ⑦ 记忆写入门禁：冲突/重复/重要性/敏感信息（v1.5 只做重要性，复用     │
│    importance_scorer；v1.6 扩展语义记忆）                           │
│ ⑧ 最终回答门禁（Reflect，可选开关，默认关闭）：helper 模型审查       │
│    "是否回答了用户问题/是否有未兑现的工具承诺"                       │
└───────────────────────────────────────────────────────────────────┘
```

### 4.6 关键架构决策（ADR 摘要）

| 决策 | 结论 | 理由 |
|---|---|---|
| Agent 循环放哪 | 进程内 `agent/` 模块，不搞独立 sidecar 进程 | 本地优先、SQLite 共享、Tauri Channel 直连；拆进程只增加打包/IPC 复杂度 |
| 范式策略接口 | 先定义 trait + ReAct 一个实现；Plan/Reflect 只留接口不实现 | YAGNI；避免抽象兑现不了（v1.5 教训） |
| 单流锁 | 改为 per-conversation 锁 | A1；消息树写序以 conversation 为单位已足够 |
| 注入队列/todo 上下文 | 全部收进 `AgentSession`（AppState 中按 request_id 索引） | A3 并发正确性 |
| 任务调度 | `tokio::sync::Notify` 事件驱动 + DB 持久化 + 启动时 RUNNING→QUEUED 重置 | 1s 忙轮询浪费且无恢复 |
| DSML 兜底解析 | 保留，迁到 `provider/dsml.rs`，仅对声明不支持原生工具调用的 provider 启用 | 有真实 provider 依赖它 |
| 手写计算器 | 保留实现但隔离到 `tools/builtin/calculator.rs`，不引第三方 crate | 零新依赖是 v1.5 既定决策 |
| 工具结果超长 | 截断阈值保留 8K 字符，超长部分落盘 `tool_results_overflow`（引用句柄回填提示） | 信息不再丢失，预算可控 |
| 压缩策略 | 三套归一为 ContextManager 单一入口，触发条件可配置 | B3；口径唯一才可测 |
| 兼容性 | 不改消息树 schema；task_queue 表加 `attempts/next_run_at` 列（新迁移），不改既有列 | 保持 v1.0–v1.4 不变量 |

---

## 5. 迁移路径（Strangler Fig，行为对等优先）

原则：**先建防护网，再动刀；每步迁移保持行为对等，用 scripted provider 回放验证。**

| 步骤 | 动作 | 消灭的债务 | 状态 |
|---|---|---|---|
| S0 | 搭建 `agent/eval`：scripted provider + 现有行为的黄金回放用例（正常轮/审批拒/审批超时/注入/压缩触发/连败停止/软停止） | 为后续每一步提供回归护栏 | ✅ M0 |
| S1 | 抽 `AgentSession`，注入队列与 todo 上下文改为会话作用域；`streaming.rs` 调用点替换 | A3 | ✅ M1 |
| S2 | 循环整体迁入 `agent::runner`，压缩编排迁 `agent::context`；`streaming.rs` 变 command 壳（`AgentEventSink` 并入 M5 可观测性，见 DEVELOPMENT.md M1.2 范围调整） | B1 | ✅ M1 |
| S3 | PromptBuilder 抽取（先原样搬家，不改文案）；`tools/` 拆分与 PolicyEngine | B2、B4、B5 | M2 |
| S4 | ContextManager 归一三套策略 + 预算台账；工具结果落盘引用 | B3、🟡截断 | M3 |
| S5 | per-conversation 流锁 + 任务队列重写（Notify/恢复/429）+ 并行分叉端到端 | A1、A2、A4 | M4 |
| S6 | `agent_runs` 审计 + eval 用例进 CI（漂移检测雏形） | B6 | M5 |

每步的详细任务、工时与验收门禁见 [DEVELOPMENT.md](./DEVELOPMENT.md)；每步完成后在 [CAPABILITIES.md](./CAPABILITIES.md) 勾选对应能力状态。
