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
| C11 | 任务队列（Task Queue） | 🟡 | 骨架可用：1s 忙轮询、无恢复、无 429、双实现并存 |
| C12 | 并行分支分叉（Parallel Fork） | ❌ | 只建空分支不产 AI 输出，端到端断裂 |
| C13 | Dual-Queue 中途注入 | 🟡 | 后端注入已会话作用域化（M1 `agent/session.rs`，并发污染消除）；无持久化 |
| C14 | Agent 可观测性（run 审计/轨迹） | ❌ | 仅 tracing 日志 |
| C15 | Agent 评估（golden 用例/scripted provider） | 🟡 | M0 已落地 scripted model + 13 个 golden 回放用例进 `cargo test`；BFCL 式用例与 CI eval job 待 M5 |
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

### C11 任务队列 🟡

- **契约（现状）**：SQLite 持久化任务、串行执行、取消、前端面板 2s 轮询展示。
- **缺陷**：1s 忙轮询无事件唤醒；重启后 RUNNING 卡死；无 429 暂停/重试；`TaskQueueService` 是死代码双实现；无任务进度。
- **目标态（v1.5）**：`agent::taskqueue`——Notify 事件驱动 + 启动恢复（RUNNING→QUEUED 重置）+ 429 按 `Retry-After` 暂停重试 + 任务进度字段 + 删除死代码。**验收锚点：队列状态机单测 + 重启恢复集成测试**。

### C12 并行分支分叉 ❌（v1.5.0 旗舰能力）

- **承诺契约（PRD）**：AI 提议或用户主动发起 → 提案（毫秒级）→ 用户编辑分支/选模型 → 启动 → 队列串行跑流 → 各分支产真实 AI 回复 → 可比较。
- **实况**：提案/审批面板存在；`execute_parallel_fork` 建分支是 TODO；TaskWorker 只建 branch+user message，**从不启动模型流**；全局单流锁也使多分支流不可能（ARCHITECTURE.md §3 A1/A2）。
- **目标态（v1.5）**：补齐全链路——分支创建走统一 branch 服务（含 assistant placeholder）→ 每任务驱动一个完整 stream session → per-conversation 流锁放行跨分支并行 → 前端 ParallelForkReviewPanel 与 TaskQueuePanel 进度联动。**验收锚点：PRD §6.3 全部用例 + 三分支端到端冒烟**。

### C13 Dual-Queue 注入 🟡

- **契约（现状）**：Ctrl+Enter 在 tool boundary 注入 `[User supplement]`，UserInjected 事件回显。
- **缺陷**：全局静态队列（并发污染风险）；注入消息不入消息树/无持久化（刷新即丢，历史不可见）；thinking 模型无 boundary 时注入延迟无 UI 提示。
- **目标态（v1.5）**：会话作用域队列（S1 顺带解决）；注入消息作为消息节点持久化（非破坏性：独立 `source=inject` 标记）；"等待注入/将在下一轮生效"状态提示。**验收锚点：注入用例（含取消）+ 持久化验证**。

### C14 Agent 可观测性 ❌

- **目标态（v1.5）**：`agent_runs` 表（run_id、conversation_id、轮次、每轮 token、工具调用记录、审批结果、时长、终止原因）+ 设置页"导出本轮 Agent 轨迹"调试入口。**验收锚点：一次多轮工具对话的轨迹完整性检查**。

### C15 Agent 评估 🟡（M0 已落地基座）

- **已落地（M0）**：`agent/eval/mock_provider.rs` 脚本化模型（文本/工具调用/可重试失败剧本 + 请求录制）+ 13 个 golden 回放用例覆盖：单工具/多工具/空工具调用、连败上限、回内跳过、软停止、审批三态、注入、取消、重试退避、提示词组装、脚本耗尽。
- **目标态（v1.5 剩余，M5）**：BFCL 四类风格用例（simple/multiple/parallel/irrelevance）扩充进 CI eval job；LLM Judge 质量冒烟作为发布前人工门禁；漂移检测雏形（golden 基线偏差 >20% 报警）。**验收锚点：CI 新增 eval job 全绿**。

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
