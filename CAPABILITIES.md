# CAPABILITIES.md — GetChat 能力清单

> 状态: Active · 文档驱动开发三件套之二（配合 [ARCHITECTURE.md](./ARCHITECTURE.md) / [DEVELOPMENT.md](./DEVELOPMENT.md)）
> 基线: v1.5.0 分支实测代码（2026-09-05）· 状态以**代码实况**为准，不以历史总结文档的宣称为准。
> 每个里程碑验收后更新本表；状态标记：✅ 可用 · 🟡 部分/骨架 · ❌ 缺失或端到端断裂 · 📐 仅规划。

---

## 1. 能力总览

| # | 能力 | 状态 | 一句话实况 |
|---|---|---|---|
| C01 | 会话树 / 非破坏性分支 | ✅ | v1.0 核心模型，生产验证 |
| C02 | 分支比较 / 设主线 / 导入导出 | ✅ | 含 AI diff summary |
| C03 | 双层流式输出管线 | ✅ | registry+surface 架构干净 |
| C04 | 多 Provider 接入（OpenAI 协议 / Ollama） | ✅ | 含 DSML 兜底解析、5 次退避重试 |
| C05 | 上下文管理与压缩 | 🟡 | 三套策略并存于循环内，口径分裂 |
| C06 | 内置工具（file/terminal/todo/web_search/skill/calculator） | 🟡 | 可用但单体 2049 行、串行执行、结果硬截断 |
| C07 | MCP 集成 | 🟡 | 含密钥 keyring、stdio/http；工具与内置工具双轨 |
| C08 | Skills（Tier1 元数据 / Tier3 slash） | 🟡 | 热插拔可用；Tier2 语义未分层 |
| C09 | 工具审批（安全策略/黑名单/超时） | 🟡 | 机制可用，策略硬编码在循环里 |
| C10 | Agent 循环（ReAct） | 🟡 | 循环本体已迁 `agent/runner.rs` 并受 76 项金测护栏（M1）；可测性达成，范式可插拔（paradigms/）待 M2+ |
| C11 | 任务队列（Task Queue） | ✅ | M4 `agent/taskqueue` 单实现：Notify 事件驱动、启动恢复、429 退避重试、运行中取消、进度字段 |
| C12 | 并行分支分叉（Parallel Fork） | ✅ | M4 端到端：提案→编辑→入队→服务端驱动完整 ReAct 流→分支产真实回复；桌面双分支冒烟留待 M6 |
| C13 | Dual-Queue 中途注入 | ✅ | M4/M4.6：会话作用域队列 + 注入持久化（`source=inject`）+ 生效前撤回（`cancel_injected_message`）+ Composer 排队 chip |
| C14 | Agent 可观测性（run 审计/轨迹） | ✅ | M5.1/M5.3：`agent_runs` 表 + RunAuditor 缝全退出路径埋点 + 导出命令 + 设置页轨迹导出 + 侧栏折叠指标面板 |
| C15 | Agent 评估（golden 用例/scripted provider） | ✅ | M5.2/M5.4：BFCL 四类用例 + CI eval job + 漂移检测雏形；LLM Judge 保留为发布前人工门禁 |
| C16 | 记忆系统（核心硬编码层/情景/语义） | 📐 | 仅压缩摘要雏形（compressed_contexts） |
| C17 | 子代理 / 上下文交接 | 📐 | 手册 §7.3 目标，规划中 |

---

## 2. 能力明细（用户可见契约 + 缺陷 + 目标态）

> 每项能力写清：它对用户承诺什么（契约）、现在差在哪（缺陷）、v1.5.0 收敛到什么（目标态）。
> 括号内为能力对应的验收锚点，详细门禁在 [DEVELOPMENT.md](./DEVELOPMENT.md) §4。

### C01 会话树 / 非破坏性分支 ✅

- **契约**：任意消息分叉、历史编辑产生新分支、regenerate 产生 variant、原消息永不改写。
- **缺陷**：无已知缺陷。任务队列创建分支时 sibling_index 用哈希取模可能撞 UNIQUE（低概率）。
- **目标态**：保持；并行分叉复用同一套 branch 创建服务（消灭 task_worker 里的复制粘贴实现）。

### C02 比较/主线/导入导出 ✅

- **契约**：双栏对比 + AI 差异摘要、设主线、导入导出。
- **目标态**：无变更。

### C03 双层流式输出 ✅

- **契约**：流式期间纯文本表面渲染（~24ms 节流），完成后一次性提交 + MarkdownRenderer。
- **目标态**：无变更；`agent::events` 新增事件类型必须兼容现有 sink 语义（事件序号 `event_seq` 新增字段，前端可选消费）。

### C04 多 Provider ✅

- **契约**：OpenAI 兼容协议 + Ollama；流式；重试 5 次指数退避。
- **缺陷**：退避不读 `Retry-After`；DSML 解析与 provider 适配耦合在一个 2019 行文件。
- **目标态**：拆 `provider/` 适配层；429/`Retry-After` 语义进入重试分类（S5）。

### C05 上下文管理与压缩 🟡

- **契约（现状）**：上下文状态条、60% 触发 AI 压缩并持久化摘要、96% 预追加压缩、旧工具结果修剪、确定性预算裁剪。
- **缺陷**：四者互相独立、无统一预算台账；超长工具结果 8K 字符硬截断即丢；压缩触发点写死在循环两处。
- **目标态（v1.5）**：`ContextManager` 单一入口 + token 预算台账；工具结果超长落盘 + 引用句柄；触发阈值进配置。**验收锚点：预算场景单测 + 长对话冒烟**。

### C06 内置工具 🟡

- **契约（现状）**：file（读/写/列目录）、terminal（shell）、todo、web_search、load_skill、calculator、parallel_branch_fork。
- **缺陷**：单体文件；每轮多工具串行；工具输出无结构化规范（纯字符串）；无按工具的超时/风险分级元数据。
- **目标态（v1.5）**：一工具一模块进 `agent/tools/builtin/`；Registry 提供风险等级/并发安全性/结果尺寸策略元数据；**无副作用工具同一轮并行执行**。**验收锚点：工具单测 + 并行执行用例**。

### C07 MCP 🟡

- **契约（现状）**：stdio/streamable-http 服务器配置、keyring 存密钥、工具热加载、config.json 导入导出。
- **缺陷**：与内置工具走 `execute_tool_with_mcp` 分叉路径，审批行为不一致的风险；无统一命名空间说明注入。
- **目标态（v1.5）**：MCP 工具以 `mcp__<server>__<tool>` 命名并入 ToolRegistry，审批/超时/结果规范化走同一 PolicyEngine。

### C08 Skills 🟡

- **契约（现状）**：`SKILL.md` 热插拔；Tier1 元数据进 system、Tier3 slash 激活提示。
- **目标态（v1.5）**：无功能变更；发现逻辑从循环内联迁到 PromptBuilder（行为对等搬家）。

### C09 工具审批 🟡

- **契约（现状）**：安全策略（模式/黑名单/超时）、审批事件、后端超时视为"未拒绝可重试"。
- **缺陷**：`requires_tool_approval` 与黑名单匹配逻辑硬编码在 `streaming.rs`；审批等待内联循环 110 行。
- **目标态（v1.5）**：`PolicyEngine` 数据化规则表（工具 → 风险等级 → 审批策略），支持"破坏性操作强制审批"（手册 §8.3）；行为对等迁移。**验收锚点：审批矩阵测试（放行/强制审批/黑名单/超时/拒绝）**。

### C10 Agent 循环（ReAct） 🟡

- **契约（现状）**：多轮工具调用、连败停止、软停止兜底、取消、审批、注入。
- **缺陷**：710 行单函数长在 command 层（ARCHITECTURE.md §3 B1/B2）；无状态机显式化；不可单测。
- **目标态（v1.5）**：`agent::runner` 模板方法 + 显式状态机 + `AgentSession` 会话作用域（消灭全局静态）；范式策略接口就位（仅 ReAct 实现）。**验收锚点：golden 回放全绿（S0 用例）+ streaming.rs ≤ 800 行**。
- **M0 进展**：依赖缝合 `ReactLoopDeps` 落地（流/MCP/压缩后端可注入），13 个 golden 用例锁定现行为。

### C11 任务队列 ✅

- **契约（现状，M4 后）**：SQLite 持久化任务、`agent/taskqueue::TaskQueueScheduler` 单实现（死代码双实现已删除）——Notify 事件驱动 + 30s 兜底轮询、启动恢复（RUNNING→QUEUED attempts+1 + resume 到期 PAUSED）、429 按 `Retry-After` 暂停（缺省 30s，attempts≤5）、`config_json.progress` 进度（phase/工具计数，合并写）、watch 通道运行中取消；`max_parallel` 经 app_kv 可配（默认 1）。
- **已落地（M4）**：迁移 `0016_task_queue_resilience.sql`（attempts/next_run_at）；仓储单测覆盖调度/恢复/取消/进度合并。
- **验收锚点**：队列状态机单测 ✅；重启恢复集成测试 ✅（`startup_recovery_requeues_running_with_attempt_bump`）；桌面端到端冒烟随 M6 清单。

### C12 并行分支分叉 ✅（v1.5.0 旗舰能力）

- **承诺契约（PRD）**：AI 提议或用户主动发起 → 提案（毫秒级）→ 用户编辑分支/选模型 → 启动 → 队列跑流 → 各分支产真实 AI 回复 → 可比较。
- **已落地（M4）**：`execute_parallel_fork` 走 `snapshot_service::create_parallel_fork_branch`（assistant placeholder + sibling_index `max+1`）→ 任务入队即唤醒 → `drive_task_stream` 服务端驱动完整 ReAct 循环 → 事件经 `task_stream_event` 信封桥接前端（`taskStreamBridge.ts` + TASK_WORKER 会话，服务端持久化）→ COMPLETED 可从面板跳转分支；per-conversation 流锁放行跨会话并行。
- **验收锚点**：PRD §6.3 全部用例 + 三分支端到端冒烟 —— 单测层已覆盖（分支创建/入队/调度），桌面三分支并行冒烟随 M6 发布清单。

### C13 Dual-Queue 注入 ✅

- **契约（现状，M4 后）**：Ctrl+Enter 在 tool boundary 注入 `[User supplement]`，UserInjected 事件回显；队列会话作用域（`agent/session.rs`，随 agent session 生命周期）。
- **已落地（M4/M4.6）**：注入消息作为消息节点持久化（迁移 `0017_message_source.sql`，`source=inject`，非破坏性；刷新/历史可见）；`cancel_injected_message` 在下一 boundary 前撤回排队注入（命中返回 true，已被消费返回 false）；Composer 已排队注入 chip 可视可撤回，流结束自动清空。
- **验收锚点**：注入用例（含取消）✅（boundary drain golden + `cancel_injection` 单测：命中移除/重复取消/未知内容均断言）；持久化验证 ✅（`0017` 迁移 + 消息节点单测）。

### C14 Agent 可观测性 ✅

- **已落地（M5.1/M5.3）**：`agent_runs` 表（迁移 `0018_agent_runs.sql`：run_id、conversation/branch/model、每轮 token 与耗时、tool_calls JSON、审批记录 JSON、终止原因）由 `RunAuditor` 缝（`agent/audit.rs`）在 `run_react_loop` 包装层写入——增量快照替换持久化，退出路径全覆盖（完成/取消/失败/软停止/连败停止），审计写失败仅告警不阻断流；`list_agent_runs`（按会话过滤/限量）与 `export_agent_run` 命令；前端：设置页"Agent 运行轨迹"分区（最近 20 次，逐条 JSON 导出）+ 侧栏 `AgentMetricsPanel` 折叠指标面板（默认收起，轮次/token/工具时延，运行中低频轮询，逐 run 导出）。
- **验收锚点**：轨迹完整性 ✅（`run_auditor_records_turns_and_outcome` golden：两轮记录 + 终态 + 工具时延；仓储单测：first-write-wins/最新序/限量）；导出链路 `export_agent_run` 未知 id 返回 null ✅。桌面端真实多轮对话导出人工抽查随 M6 smoke 清单。

### C15 Agent 评估 ✅（CI 覆盖落地；LLM Judge 留人工门禁）

- **已落地（M0）**：`agent/eval/mock_provider.rs` 脚本化模型（文本/工具调用/可重试失败剧本 + 请求录制）+ golden 回放用例覆盖：单工具/多工具/空工具调用、连败上限、回内跳过、软停止、审批三态、注入、取消、重试退避、提示词组装、脚本耗尽。
- **已落地（M5.2/M5.4）**：BFCL 四类风格用例（`bfcl_simple`/`bfcl_multiple`/`bfcl_parallel`/`bfcl_irrelevance`：目录暴露、参数透传、去杂执行、拒绝工具权）进用例集；CI 新增 `eval` job（`cargo test --locked --lib agent::eval`）；漂移检测雏形 `agent/eval/drift.rs`（四场景轮次/工具数基线，偏差 >20% 报警并输出漂移报告；token 基线待真实 usage 接入）。
- **验收锚点**：CI eval job 全绿 ✅。LLM Judge 质量冒烟保留为发布前人工门禁（M6 清单）。

### C16 记忆系统 📐（v1.6 方向，v1.5 只落地基座）

- v1.5：Core 层环境快照注入（PromptBuilder）+ 记忆写入门禁接口（复用 importance_scorer）。
- v1.6+：情景/语义记忆分层、检索工具化、敏感信息级联删除（手册 §6）。

### C17 子代理 / 上下文交接 📐（v1.6+）

- v1.5 的并行分叉是它的本地优先形态（每分支独立上下文）；泛化接口在 `agent::paradigms` 预留。

---

## 3. 能力 → 模块映射

| 能力 | 现载体 | 目标载体 |
|---|---|---|
| C05 | streaming.rs 内联四策略 | `agent/context/` |
| C06/C07 | tool_executor.rs 单体 | `agent/tools/{builtin,mcp}` + Registry |
| C09 | streaming.rs 内联 | `agent/tools/policy.rs` |
| C10 | streaming.rs:1215-1924 | `agent/runner.rs` + `agent/session.rs` + `agent/events.rs` |
| C11 | task_worker.rs + 死代码 task_queue_service.rs | `agent/taskqueue/` |
| C12 | proposal.rs + task_worker.rs（断裂） | proposal.rs（提案）→ `agent/taskqueue`（编排）→ `agent::runner`（执行） |
| C13 | inject_queue.rs 全局静态 | `agent/session.rs` |
| C14/C15 | —（M0 起有 `agent/eval/`） | `agent_runs` 表 + `agent/eval/` 扩充 |
| C04 | model_stream_service.rs | `provider/`（适配层）+ `agent/eval`（回归） |

## 4. v1.5.0 明确不做（Non-goals）

1. 语义记忆/向量检索（C16 完整体）——地基先落。
2. 子代理泛化与 A2A（C17）——接口预留。
3. Reflect 自动质量门禁默认开启——实现开关但默认关闭，避免不可控行为回归。
4. 引入向量库/新运行时依赖——延续零新依赖决策（rmcp 补丁除外）。
5. 修改消息树 schema 或破坏 CLAUDE.md 不变量清单中的任何一条。
