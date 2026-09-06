# Changelog

All notable changes to GetChat are documented here. For architecture/capability
detail, see `ARCHITECTURE.md` / `CAPABILITIES.md` / `DEVELOPMENT.md`.

## [Unreleased — v1.5.0]

Agent Harness 重构收尾（DEVELOPMENT.md M0–M6）+ 可观测性与评估入 CI。

### Added
- **并行分支分叉（旗舰能力）**：AI 提案或手动发起 → 毫秒级提案 → 编辑分支/选模型 → 任务队列并行跑流 → 分支可比较（`execute_parallel_fork`，服务端驱动完整 ReAct 循环）。
- **任务队列（Dual-Queue）**：后台任务调度、重启恢复、429/Retry-After 退避、attempts 计数、per-conversation 流锁（同会话串行、跨会话并行）、队列面板进度/跳转/取消/QUEUED 编辑。
- **中途注入与撤回**：工具边界注入 `[User supplement]`（会话作用域队列），注入消息持久化（`source=inject`），生效前可撤回（`cancel_injected_message`）。
- **Agent 运行轨迹（可观测性）**：`agent_runs` 审计表 + `RunAuditor` 缝（每轮 token/耗时、工具调用时延、审批记录、终止原因全退出路径埋点）；设置页"Agent 运行轨迹"导出 JSON；侧栏折叠循环指标面板。
- **评估入 CI**：BFCL 风格四类用例（simple/multiple/parallel/irrelevance）；CI 新增 eval job；漂移检测雏形（场景基线 ±20% 报警）。
- **上下文管理**：预算台账单入口（`enforce_budget`）、分段提示词、超长工具结果落盘 + `read_tool_result` JIT 取回。

### Hardened
- 工具名允许列表门禁前移至审批流之前：模型幻觉/禁用/伪造 `mcp__` 命名空间工具名不再触发审批弹窗，直接得到合成失败结果（golden 用例钉死）。
- 任务流注册流锁改为与交互流对称的"检查后插入"：会话忙时任务进入 PAUSED 退避重试（`CONVERSATION_BUSY`，30s，受 attempts 上限约束），不再覆盖交互流的取消句柄。
- 审计轨迹与流事件不含任何密钥材料（keyring 泄漏 grep 审计通过）。

### Changed
- 交互流/任务流统一由 `agent::runner` 驱动；`services/tool_executor.rs`、`task_worker.rs`、`task_queue_service.rs` 等单体拆解归位 `agent/`（详见 ARCHITECTURE.md B1–B6 ✅）。
- 并行工具执行：免审批 + Safe 连续段并行、结果按调用序回填（`PARALLEL_TOOL_EXECUTION_ENABLED` 可全局回退串行）。

## [1.4.0] — 2026-06-02

- 配置简化、上下文管理 overhaul、Skills 重构、导入/导出（ChatGPT/GetChat JSON）、UI polish（#21）。

## [1.3.0] — 2026-05-24

- 上下文管理重做、passive timeout、审批 UX 与 UI polish（#19）。

## [1.2.0] — 2026

- Skills 体系、MCP 传输配置、消息推理内容（reasoning content）。

## [1.0.0 – 1.1.2] — 2026

- 树状会话内核（branch/mainline/compare）、MCP 客户端、内建工具与审批、自动更新与发布流水线。
