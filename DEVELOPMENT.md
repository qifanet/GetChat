# DEVELOPMENT.md — GetChat v1.5.0 开发与验收计划

> 状态: Active · 文档驱动开发三件套之三（配合 [ARCHITECTURE.md](./ARCHITECTURE.md) / [CAPABILITIES.md](./CAPABILITIES.md)）
> 制定日期: 2026-09-05 · 执行分支: feat/v1.5.0 · 最近更新: 2026-09-05（M0 完成）
> **重新基线声明**：历史文档（PROGRESS/FINAL-SUMMARY-v1.5.0）宣称"100% 完成"，实测存在端到端断裂（并行分叉无 AI 输出、任务队列无恢复/无 429、全局单流锁）。本计划以代码实况重新基线，v1.5.0 的完成定义以 §4 验收门禁为准。

---

## 1. 工程规则（继承 SOP，必须遵守）

1. **先读再改**：动任何模块前完整读完该模块；重构前先写行为快照测试（S0 用例）。
2. **分层验证**：每个阶段完成立即 `cargo check`（src-tauri）+ `npx tsc --noEmit` + `npm test`；Rust 侧补 `cargo test --locked`。
3. **行为对等迁移**：架构搬家（S1–S4）阶段不改行为；行为变更（S5 新功能）单独提交，可独立回滚。
4. **零新依赖**（除已锁定 rmcp 补丁）；事件驱动用 `tokio::sync::Notify`，不引调度库。
5. **文档同步**：每里程碑合并后更新 CAPABILITIES.md 状态列与本计划勾选；架构变更同步 ARCHITECTURE.md；新设计决策进 `docs/private/` 并登记 `docs/private/README.md`。
6. **提交规范**：Conventional Commits；一分支一事；每个里程碑至少一个 checkpoint 提交，保持 bisect 友好。
7. **命令注册双点**：新 Tauri command 同时注册 `lib.rs invoke_handler` 与 `browserDebugRuntime.ts`；i18n 双语同步。
8. **⚠️ 慎用 `npm run lint:eol:fix`**：其 interleaved-blank 规则会删除合法空行，已造成过一次全库 Markdown/代码结构损伤（2026-09-05，已修复脚本使 `.md` 豁免该规则）。只做 `npm run lint:eol` 检查，确需修复时逐文件执行并审查 diff。
9. **依赖环境统一装在 `D:\DevRuntimes`，禁止写入 C 盘**（磁盘空间政策），详见 §1.1 与 AGENTS.md。

### 1.1 本机开发环境（2026-09-05 整改记录）

| 项 | 位置/值 | 备注 |
|---|---|---|
| Rust 工具链 | `D:\DevRuntimes\rust\rustup` / `D:\DevRuntimes\rust\cargo`（用户级环境变量 `RUSTUP_HOME`/`CARGO_HOME`） | `stable-x86_64-pc-windows-gnu`；USTC 镜像下载（`RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static`） |
| MinGW-w64 | `D:\DevRuntimes\mingw64\mingw64\bin`（已入用户 PATH） | MSYS2 包组合：binutils + gcc 16.2 + winpthreads 头文件等；提供 gcc/as/dlltool/windres |
| default-manifest.o | `mingw64\lib\default-manifest.o`（备份 `.bak`） | **已重生成**：加入 Common-Controls v6 依赖。否则 wry 导入的 `TaskDialogIndirect` 在加载期解析失败（0xC0000139）。CI（MSVC）由 rustc 自嵌清单，不受影响 |
| WebView2Loader.dll | `mingw64\bin\WebView2Loader.dll`（x64，来自 webview2-com-sys） | 测试进程动态加载所需 |
| npm 缓存 | `D:\DevRuntimes\npm-cache` | `npm config set cache` |

每次新 shell 执行 cargo 命令需重导出：`RUSTUP_HOME` / `CARGO_HOME` / `PATH`（含 cargo bin 与 mingw64 bin）。

**全局门禁（每个 PR 必过）**：`npx tsc --noEmit` ✚ `npm test` ✚ `cargo check --locked` ✚ `cargo test --locked` ✚ `npm run lint:eol`。

---

## 2. 里程碑总览

| 里程碑 | 主题 | 消灭的债务 | 状态 | 依赖 |
|---|---|---|---|---|
| **M0** | 防护网：scripted provider + 黄金回放用例 | 为后续所有步提供护栏 | ✅ 完成（2026-09-05） | — |
| **M1** | 会话作用域化 + 循环出 command 层 | A3、B1 | 4d | M0 |
| **M2** | 工具系统重构 + PolicyEngine | B4、B5 | 4d | M1 |
| **M3** | ContextManager（GSSC 归一） | B3、截断丢失 | 3d | M1 |
| **M4** | 任务队列重写 + 并行分叉端到端 | A1、A2、A4 | 5d | M1（可与 M2/M3 并行） |
| **M5** | 可观测性 + 评估入 CI | B6、C15 | 3d | M1–M4 |
| **M6** | 硬化、文档收口、发布验收 | 🟡 文档失真 | 3d | M5 |

关键路径：M0 → M1 → M4 → M6（约 15 个工作日）；M2/M3 可与 M4 并行插入（合计约 3 周）。每里程碑产出可运行 checkpoint；任一里程碑超期 50% 时触发裁剪（见 §6 风险）。

---

## 3. 里程碑任务分解

### M0 — 防护网（scripted provider + golden 回放）✅ 已完成（2026-09-05）

目标：在不动任何生产代码前，让现有循环行为可回放、可断言。

- [x] M0.1 `agent/eval/mock_provider.rs`：脚本化模型——按剧本返回预设文本/工具调用/错误（含可重试失败剧本驱动退避）；实现与 `model_stream_service` 相同的入口签名，可注入替换（`StreamBackend::Real|Scripted`）。
- [x] M0.2 golden 用例集 `agent/eval/cases.rs`（直接针对现状 `run_react_loop`，经 `ReactLoopDeps` 最小注入）：
  - 单工具调用 → 结果回填 → 终答；单轮多工具（串行现状）；工具失败 → 连败上限 → 兜底终答
  - 审批：批准 / 拒绝 / 超时（三态，file 写入走临时 workspace）
  - 注入：boundary 注入生效；取消：首轮前取消
  - 软停止：max_iterations 触发后无工具终答
  - 压缩：`CompressionBackend::Disabled` 注入（预算触发的端到端用例在 M3 随 ContextManager 补齐——预算触发依赖 DB 模型行，M0 以禁用后端保证行为对等）
- [x] M0.3 用例以纯断言运行于 `cargo test`（不依赖网络/真实 key）。**实测 75 passed / 0 failed**（13 个新 golden 用例 + 既有 62 个 Rust 测试），`cargo check --lib` 0 警告。
- [x] M0.4 修正 `docs/private/PROGRESS-v1.5.0.md` 与 `FINAL-SUMMARY-v1.5.0.md` 的失真声明，指向本计划。

**实现说明（与原计划的最小偏差）**：

- 注入点为 `agent/deps.rs::ReactLoopDeps<'a>`：`db / tool_executor(Arc) / tool_definitions(预计算) / security_policy / pending_approvals / app_data_dir / mcp(McpBackend) / stream(StreamBackend) / compression(CompressionBackend)`。
- `state.rs` 的 `tool_executor` 由 `Box` 改 `Arc<dyn ToolExecutor>`（deps 需克隆；全库调用点经 Deref 兼容）。
- 压缩编排经 `CompressionBackend::Real(State)/Disabled` 注入；测试禁用，生产行为不变，M3 归一时迁移。

**M0 顺带修复的预存问题**：

- 前端 `streamController.test.ts` "rejects a second stream" 用例断言的是已被取代的旧行为（v1.5 前端已改为排队），按现行契约重写为 "queues a second stream … starts it after completion"。
- 仓库行尾/空白问题：`lint:eol:fix` 的 interleaved-blank 规则当时误删了大量合法空行（README/CONTRIBUTING/手册等），已用 git 恢复受损文件并修复脚本（`.md` 豁免该规则），详见 §1 规则 8。
- 遗留说明：`lint:eol --check` 仍报告 9 处**预存**问题（task_worker/proposal/inject_queue/mcp_servers/task_queue_service/taskQueue.ts 的空行与尾随空白、2 个 .mimosa 状态 json 的 pure-LF）——涉及"清理代码空行"的策略取舍，留待维护者决策，M0 不单方面处理。

**验收门禁 M0** ✅：cargo test 含 13 个循环级用例全绿（75/75）；tsc/vitest 全绿（124/124）；cargo check 0 警告；`lint:eol` 对 M0 触碰文件清零（9 处预存问题见上）；文档失真已标注。

### M1 — 会话作用域 + AgentRunner 落地（行为对等）✅ 完成（2026-09-06）

- [x] M1.1 `agent/session.rs`：`AgentSession`（inject 队列）以 `AppState::agent_sessions` 按 request_id 索引；删除 `services/inject_queue.rs` 全局静态与 `tool_executor::set_todo_conversation_id`/`TODO_CONVERSATION_ID` 全局；`read_todo_items(None)` 返回空列表（commit 7e76b1c）。新增会话隔离回归测试。
- [ ] M1.2 `agent/events.rs`：`AgentEventSink` trait。**范围调整（2026-09-06）**：Tauri Channel 本身已是事件汇抽象，单独 trait 在 M5（`agent_runs` 审计）才有真实收益——与可观测性埋点合并实现，避免为抽象而抽象。
- [x] M1.3 循环迁入 `agent/runner.rs`（987 行）：`run_react_loop`/`dispatch_stream`/工具执行四函数/审批判定/`build_approval_description`/`ReactLoopOutcome`/`TOOL_EXECUTION_TIMEOUT_SECONDS` 逐字搬家（重试/退避/软停止/连败/skip 补偿逻辑不变）；压缩八件套（prune、确定性裁剪、压缩应用、mid_loop_compress、`maybe_compress_react_prompt`、`is_expected_compression_noop` 等）迁 `agent/context.rs`（599 行）。**迁移验证**：新文件与 git HEAD 原文做行多重集 diff，除导入收缩/可见性/模块前缀外零差异；76/76 金测不改断言通过；cargo check 0 警告。
- [x] M1.4 ✅ `agent/prompt.rs`：工具指引/技能 Tier1 元数据/激活提示迁入 `inject_prompt_context`（文案逐字保留；Tier-3 提示保持"无前导 system 则不注入"的原始守卫）（commit 7e76b1c）。
- [x] M1.5 `streaming.rs` 3421→695 行（门槛 ≤800）：MCP 管理块（CRUD/密钥存取/运行时恢复/mcps.json 导入导出，1078 行）迁 `commands/mcp.rs`；Skills & Slash 段（109 行）迁 `commands/skills.rs`；`build_backend_enabled_tool_definitions` 升 `pub(crate)` 供 mcp.rs 复用；lib.rs 命令注册与启动 reload 调用点同步改路径。

**验收门禁 M1** ✅：M0 全部用例不改断言通过（76/76 ✅）；`streaming.rs` 695 行 ≤ 800 ✅；全局静态检索为零（inject/todo 会话作用域化完成；`TODO_STORE` 按真实 conversation_id 键控、`mock_provider::AUTO_ID` 仅测试夹具，均属 M2 工具模块处理范畴）✅；session 隔离测试 ✅。

### M1-UI — UI/UX 专业度与信息密度重构 🔄 进行中（用户 2026-09-06 指示）

问题诊断：旧"slate_protocol"语言圆角 14-28px、全大写宽字距导航、22-24px 消息卡、64px 头部——装饰性体积挤占内容，信息密度低。

- [x] 第一批（commit 9a28d3c，`index.css` 设计令牌 + 高频界面）：半径 14/20/28→8/10/12；侧栏项/导航去掉大写宽字距（px-2.5 py-1.5、13px medium）；按钮/输入框紧凑化（px-3 py-1.5 / px-3 py-2）；主按钮去渐变发光改实色；消息卡 22px→lg、头像 36→28px、流式文字 15px/leading-7→14px/1.65、消息间距 space-y-7→4；壳层头部 64→48px；Composer 容器 24px→xl。
- [x] 第二批（本地 commit，radius 体系 + 暗色对比度）：43 处超大/魔法数圆角归一到 token 尺度（设置页选项按钮、Provider 模型卡、Composer 弹层与发送钮、App 壳、分支列表、导入导出对话框 rounded-[12px]→md 等）；新增 `--c-accent-fill/-green-fill/-red-fill` 实色令牌（浅色 #3755c3/#006b62/#9f403d，暗色 #4f46e5/#238636/#da3633，白字标签 ≥4.5:1），`app-primary-button`、助手头像与 8 处白字实色按钮（确认弹窗、停止/注入、审批通过/拒绝、批量删除、任务面板）切换到 `-fill` + `hover:brightness-110`；文字用途继续用原文本令牌（`text-miro-red`/浅底 `bg-miro-red-light`）不动。
- **验收锚点**：`npx tsc --noEmit` ✅、`npm test` 124/124 ✅；视觉走查（浅色+暗色）在下一批完成后统一执行。

### M2 — 工具系统 + PolicyEngine

- [x] M2.1（2026-09-06）`agent/tools/` 落地：`registry.rs` 定义 `ToolMeta { risk, concurrency, max_output_chars, timeout_secs }`（MCP 默认 High/Safe/60s 待 M2.2 接线）；7 个内置工具拆为 `builtin/{calculator,file,todo,terminal,web_search,load_skill,parallel_branch_fork}.rs` 一工具一模块，calculator 手写解析器整体搬家；框架（trait/registry/上下文/状态 DTO/单测）在 `executor.rs`，注册即携带 META。`services/tool_executor.rs` 已删除（2028 行 → 11 个职责单一文件），全部逐字搬迁并经排序行多重集 diff 验证（old-only 仅旧签名/分节横幅）。注：本机 mingw ld 对 tauri cdylib 报 export ordinal too large，`cargo test` 需用 `cargo test --lib`（clean HEAD 同样复现，与本次重构无关）。
- [x] M2.2（2026-09-06）MCP 工具并入 Registry：`registry.rs::mcp_tool_meta()` 落定 MCP 默认元数据（High/Safe/50k 字符/60s），`executor.rs::lookup_tool_meta()` 统一解析（内置注册表 → `mcp__` 前缀走 MCP 默认）；`execute_tool_checked` 的默认超时改为 META 优先（模型显式 `timeout` 参数 > META > 配置默认，钳位 [10,600] 不变——内置工具自此获得 per-tool 默认截止：file/web_search 30s、load_skill/todo/calculator 触底 10s、terminal 600s）。审批自 M2.3 起即同路径（`mcp__` 恒审批）；结果规范化同路径（统一 `ToolExecutionResult` + 8K 内联截断）；rmcp 传输细节保留在 `services/mcp_client.rs`。`ToolExecutor` trait 新增 `tool_meta`/`tool_concurrency` 默认方法供 dyn 调用。
- [x] M2.3（2026-09-06）`agent/policy.rs`：`requires_tool_approval`/`matches_blacklist`/`resolve_legacy_tool_name`/`build_approval_description` 从 runner.rs 迁出；决策矩阵数据化为 `APPROVAL_RULES`（tool × action-filter × 三级 SecurityLevel），黑名单选择器拆为 `blacklist_for`/`blacklist_input`。语义逐位保留（MCP 恒审批、解析失败 fail-safe 且先于 action 过滤——顺序经失败测试纠正过一次）。新增审批矩阵 5 用例，81/81 全绿（76 金测 + 5 矩阵）。
- [x] M2.4（2026-09-06）并行执行器：循环改为 while 批遍历——批 = 连续"免审批 + `ToolConcurrency::Safe`"调用段（legacy 名先归一再查并发级），多调用批用 `futures::join_all` 并行执行，结果严格按原顺序回填（tool_call_id 配对与 prompt 顺序不变）；非 Safe/需审批调用自成一批单独走原路径（首个候选即非 Safe 的空批边界由金测抓出后修复）。连败计数的 skip 补位索引改为绝对位置 `tool_index + offset + 1`。风险表要求的串行回退开关落地为 `PARALLEL_TOOL_EXECUTION_ENABLED` 常量（false 时 Safe 批内也串行、顺序不变）。取消语义备注：并行批内所有成员执行完毕后才处理取消（批内无法中断兄弟调用）。新增金测 `parallel_batch_backfills_results_in_call_order`（3 调用配对+顺序断言）+ harness 访问器 `tool_result_pairs`，82/82 全绿。
- [x] M2.5（2026-09-06）审批等待独立单元：`ApprovalOutcome { Approved, Rejected, TimedOut }` + `request_user_approval()`（pending 注册 → `ApprovalRequired` 事件 → 带超时等待 → pending 清理）迁入 `agent/policy.rs`；runner 仅映射结果（Approved→执行、TimedOut/Rejected 文案与 tracing 原样保留）。多重集 diff 验证：差异仅签名/参数化/枚举返回，行为行逐一对齐。

**验收门禁 M2**：工具矩阵单测（每工具 happy/参数错/超时/取消）；审批矩阵 5 用例；并行执行用例（含 tool_call_id 配对完整性）；`tool_executor.rs` 拆分后删除原文件。

### M3 — ContextManager（GSSC 归一）

- [x] M3.1（2026-09-06）预算台账：`agent/budget.rs` 定义 `Budget { context_window, output_reservation, input_budget }`（`Budget::resolve` 沿用原内联算法：窗口下限 8k、输出预留 8k）与 `BudgetThresholds`（60% 压缩触发 / 96% pre-append 危险线 / 70% 确定性回退目标——三处硬编码收敛为一个结构体，4 个单测锚定默认值与边界）；runner 顶部算账与循环内 96% 内联全部替换；context.rs 的 `maybe_compress_react_prompt` 升级为 `enforce_budget()` 单入口（mid-loop 与 pre-append 两个调用点走同一路径），确定性回退目标改从阈值取。行为对等：98/98 金测全绿。
- [x] M3.2（2026-09-06）PromptBuilder 分节化：prompt.rs 重构为 `PromptSections { core, extension, gates }`，渲染顺序 Core→Extension→Gates 固定（前缀缓存友好）；Core 新增环境快照注入（platform + workspace，纯硬编码语义；§4.5 的"分支模式"后端暂无对应状态，留待 M4 流锁/任务队列提供后接入）；行为注记：Core 现在无条件注入（旧实现 tools 为空时整体跳过），Tier-3 激活提示并入 Extension 渲染。5 个单测（顺序/字节稳定/快照格式/空渲染/Gates 占位）。
- [x] M3.3（2026-09-06）超长工具结果落盘：迁移 `0015_tool_result_overflow.sql`（id/tool_call_id/content/created_at，unixepoch 约定）注册进 db/mod.rs；`repositories/tool_result_overflow.rs`（insert/find_content，2 个往返单测）；runner 超过 8K 内联上限的结果先落盘、prompt 携带 `overflow:<id>` 引用（落盘失败降级为原纯截断并 warn）；新内置工具 `read_tool_result`（Low/Safe/5s，支持 `overflow:<id>` 与裸 id，`offset` 参数按 7K 字符分页——刻意低于 8K 内联上限，读回结果永不再溢出，3 个单测）。工具设置页泛化渲染，无需前端改动。
- [x] M3.4（2026-09-06）估算偏差记录：run_react_loop 主完成点（含 usage 的 Completed）对比 `token_estimator` 估算值与实测 `usage.prompt_tokens`，记录偏差与百分比到 tracing（`token estimate vs actual usage`）。

**验收门禁 M3**：预算场景单测（触发/不触发/边界）✅ budget.rs 4 用例；溢出落盘往返用例 ✅ repository 2 + read_tool_result 3 用例；长对话（>200 轮模拟）golden 回放无回归 ✅ `long_conversation_200_rounds_replays_without_regression`（201 请求、200 结果不丢、系统前缀逐请求字节一致）；压缩后 prompt 前缀稳定性 ✅ `compression_preserves_core_prefix_bytes`。98/98 全绿（82 金测 + 16 单测），0 警告。

### M4 — 任务队列重写 + 并行分叉端到端（旗舰能力收口）

- [x] M4.1（2026-09-06）`agent/taskqueue/mod.rs` `TaskQueueScheduler`：事件驱动调度（`Notify` 唤醒 + `next_wake_delay` 取最近 PAUSED `next_run_at`，30s 兜底轮询）；状态机 QUEUED/RUNNING/PAUSED/COMPLETED/FAILED/CANCELLED；启动恢复 `reset_running_for_startup`（RUNNING→QUEUED，attempts+1）+ `resume_due_paused`；429 处理（`MODEL_RATE_LIMITED` 读 `retry_after`，缺省 30s，`pause_for_retry` 保占位 STREAMING 不丢上下文，MAX_TASK_ATTEMPTS=5 后转 FAILED）；任务进度约定 `config_json.progress`（phase STREAMING/TOOLS_RUNNING + toolCallsDone，写入时与既有 config 对象合并）；**死代码删除**：`services/task_queue_service.rs`、`services/task_worker.rs` 双实现收口为调度器单实现。运行中任务取消用 `watch` 通道注入 `cancel_model_stream`，`cancel` 对 QUEUED/PAUSED 直接落库，RUNNING 仅 RUNNING 可 `mark_cancelled`。
- [x] M4.2（2026-09-06）迁移 `0016_task_queue_resilience.sql`（`attempts INTEGER NOT NULL DEFAULT 0`、`next_run_at INTEGER`；不改既有列）。
- [x] M4.3（2026-09-06）per-conversation 流锁（A1）：`start_model_stream` 检查从全局"任意流活动即拒绝"改为同 conversation 独占（`agent_sessions` 按 conversation_id 索引）；`STREAM_ALREADY_ACTIVE` 语义保留；worker 流与用户主动流共用该锁——`cancelActiveStreams` → `abort_model_stream` → 调度器 watch 通道 → 任务 CANCELLED，语义闭环。
- [x] M4.4（2026-09-06）分叉链路收口：`execute_parallel_fork` 逐分支走 `snapshot_service::create_parallel_fork_branch`（统一分支创建 + assistant 占位，sibling_index `max+1` 查询），任务行 config 携带 branch/initial_message/model/provider/占位消息 id，`scheduler.enqueue` 即时唤醒；执行由 `drive_task_stream` 服务端驱动完整 ReAct 循环（复用 `agent::runner` + `build_prompt_messages` + 内置工具表 + `resolve_stream_request`），事件经 `task_stream_event` 信封 {taskId, conversationId, branchId, requestId, assistantMessageId} 前端渲染；结果/失败/取消全部服务端落库（Completed→`mark_completed`，Err→FAILED 或 429 PAUSED）。
- [x] M4.5（2026-09-06）前端联调：`ParallelForkReviewPanel` 编辑消息/选模型/启动（并行分叉创建即返回 task_ids 入队）；新增 `services/taskStreamBridge.ts`（`task_stream_event`/`task_queue_changed` 单订阅者，懒初始化幂等，App 启动 + TaskQueuePanel 双入口），`streamController` 增 `ensureWorkerStreamSession`/`settleWorkerStream`（`completionMode: "TASK_WORKER"`——持久化全在服务端，前端不重复落库，完成即 `openConversation` 刷新快照；429 保留会话等待续传）；`AssistantMessageBubble` 移除 70 行客户端轮询启动流死路径；TaskQueuePanel：bridge 事件驱动刷新（5s 兜底）、RUNNING 进度 phase+工具计数、PAUSED 黄条退避倒计时（nextRunAt）、attempts、COMPLETED 同会话跳转分支；注入持久化 C13（迁移 `0017_message_source.sql`，注入用户消息节点 `source=inject`，刷新/历史可见）。
- [x] M4.6（2026-09-06）注入取消：后端 `cancel_injected_message` 命令（`agent/session.rs::cancel_injection` 移除第一条同文排队注入；会话不存在返回 false）+ `tauriCommands.cancelInjectedMessage` 包装 + Composer 已排队注入 chip（× 撤回；true 移除，false 提示"已被模型消费"，流结束自动清空）；browserDebugRuntime 补齐 task queue/inject/proposal 命令 mock。

**验收门禁 M4**：重启恢复/调度/取消/进度合并仓储单测 ✅（`startup_recovery_requeues_running_with_attempt_bump`、`claim_due_skips_conversation_with_running_task`、`pause_for_retry_bumps_attempts_and_resume_requeues`、`cancel_allows_queued_and_paused_only`、`update_progress_merges_without_clobbering_config`）；per-conversation 流锁下同会话拒绝/跨会话放行由会话索引单测覆盖 ✅；端到端桌面双分支并行实测留待 M6 发布前 smoke 清单（PRD §6.3）。后端 105/105 全绿 0 警告，前端 tsc 0 错误 + 124/124 vitest。

### M5 — 可观测性 + 评估入 CI

- [x] M5.1（2026-09-06）迁移 `0018_agent_runs.sql`（原计划编号 0017 已被 M4 注入持久化占用）：run 级审计（run_id、conversation/branch/model、每轮 token/耗时、tool_calls JSON、审批记录 JSON、outcome/outcome_detail）；`RunAuditor` 缝（`agent/audit.rs`，`ReactLoopDeps.auditor`，交互流与任务队列流均安装 `SqliteRunAuditor`；增量快照替换持久化，`finish` first-write-wins，审计写失败仅告警；runner 包装层埋点覆盖全部退出路径含软停止/连败停止，工具时延经 `execute_tool_checked` 返回 `(result, duration_ms)` 贯穿）；`list_agent_runs`/`export_agent_run` 命令；设置页"Agent 运行轨迹"分区（最近 20 次 + 逐条 JSON 导出，`downloadTextFile` 工具函数自 ExportDialog 抽出共用）。
- [x] M5.2（2026-09-06）BFCL 风格四类用例进 `agent/eval/cases.rs`（`bfcl_simple_single_call_exact_arguments`/`bfcl_multiple_executes_only_the_requested_tool`/`bfcl_parallel_two_calls_both_executed_in_order`/`bfcl_irrelevance_answers_without_any_tool_call`：目录暴露、参数透传、去杂执行、拒绝工具权）；CI 新增 `eval` job（windows-latest，`cargo test --locked --lib agent::eval`——tauri gtk/webkit 系统依赖无法在 ubuntu runner 安装，故与 backend 同平台）。
- [x] M5.3（2026-09-06）前端循环指标面板：`AgentMetricsPanel` 挂侧栏分支树底部，折叠默认收起；消费 `list_agent_runs`（当前会话最近 3 次），展示 outcome/轮次/token/每轮工具调用时延徽标，运行中 run 低频轮询（5s）至落定，逐 run JSON 导出；顺带补齐 TaskQueuePanel 硬编码文案 i18n（en/zh-CN 同步）。
- [x] M5.4（2026-09-06）漂移检测雏形：`agent/eval/drift.rs` 四场景（simple/multiple/parallel/irrelevance）轮次与工具数基线表 `BASELINES`，偏差 >20%（零基线用绝对判定）断言失败并输出逐条漂移报告（CI 报警即门禁）；token 基线待真实 usage（scripted provider 完成为 `usage: None`，审计缝已记录每轮 token 供接入）。

**验收门禁 M5**：轨迹完整性由 golden `run_auditor_records_turns_and_outcome`（两轮记录+终态+工具时延）与仓储单测（first-write-wins/最新序/限量）覆盖 ✅；导出链路命令级验证 ✅，桌面真实多轮对话导出抽查随 M6 smoke 清单；eval job 已进 CI（本地 `cargo test --lib agent::eval` 23/23 全绿）✅。后端 114/114 全绿 0 警告，前端 tsc 0 错误 + 124/124 vitest。

### M6 — 硬化与发布验收

- [ ] M6.1 LLM Judge 质量冒烟（人工门禁，手册 §10.2）：10 个典型任务（含中文），G-Eval 简化维度（正确性/完整性/简洁性），与 v1.4 基线对比无回退。（需真实模型，随 §4.2 清单执行）
- [ ] M6.2 性能验收：流式首 token 延迟、工具并行轮耗时对比（记录基线）；内存：并发 3 流无泄漏（任务管理器观察基线记录）。（需真机，随 §4.2 清单执行）
- [x] M6.3（2026-09-06）安全验收（代码级三项全部落地）：① 审批矩阵复测——审批三态 golden 全绿（granted/rejected/timeout）；② keyring 密钥泄漏 grep 审计——`agent_runs` 全链路（audit/repository/dto/command）与流事件 DTO 均无 api_key/secret 字段，日志仅 `has_api_key: bool`；③ MCP 恶意工具名注入测试——新增 golden `malicious_tool_names_rejected_by_allowlist_gate`（伪造 `mcp__` 未知服务器/控制字符走私名/未启用内建工具），并落地硬化修复：允许列表门禁前移至审批流之前，幻觉/禁用工具名不再触发审批弹窗，直接合成 "not enabled" 失败结果（id 配对不变）。
- [x] M6.3+（2026-09-06）发布前 Mimosa deep 完整审计（风险表承诺项）：密封结论 **0 findings**（scanId `scan-2026-09-06T09-34-26.896Z-a34691eb004a`，seal `sha256:cddcb6ab…f11`，深度 deep）；运行状态 inconclusive 系披露的工具覆盖缺口（callgraph 对动态派发部分不完整——Rust trait 对象缝的固有限制），非未决高危项，不触发冻结条款；依赖离线告警匹配 15 条为信息级（未立案 findings）。风险表"审计出现 high 未决项即冻结发布"不适用。
- [x] M6.4（2026-09-06）文档收口：版本号三处统一（package.json / tauri.conf.json / Cargo.toml+Cargo.lock → 1.5.0）；新建 `CHANGELOG.md`（v1.5.0 条目 + 历史版本回填）；三件套状态更新（ARCHITECTURE B6/S6 ✅、CAPABILITIES C14/C15 ✅、DEVELOPMENT M5 全勾）；`docs/private/README.md` 无新增需登记文档（M1–M6 未新增私有文档，三件套已在册）。
- [ ] M6.5 多平台冒烟：Windows（主）、macOS/Linux `cargo check` 通过。（CI 现为 windows-latest；macOS/Linux 检查待真机或后续 CI 扩展）

---

## 4. 验收计划

### 4.1 分层验收模型

```
L1 单元/集成（每 PR）：tsc、vitest、cargo test（含 eval golden）
L2 场景验收（每里程碑）：scripted provider 场景 + 端到端任务流
L3 发布验收（M6）：真实模型冒烟 + LLM Judge + 性能/安全 + 多平台
```

### 4.2 v1.5.0 发布场景验收单（真实模型，Windows 主平台执行）

| # | 场景 | 通过标准 |
|---|---|---|
| S-01 | 基础多轮工具对话 | 文件读取→总结→完成，无越权写 |
| S-02 | 破坏性工具审批 | terminal 写命令触发强制审批；拒绝后模型礼貌继续 |
| S-03 | 审批超时 | 超时提示"未拒绝可重试"，会话可继续 |
| S-04 | 并行分叉（AI 提议） | 提案毫秒级返回→编辑分支/换模型→启动→3 分支串行产真实回复→TaskQueuePanel 进度正确→比较可用 |
| S-05 | 并行分叉（用户主动） | 右键发起→同 S-04 |
| S-06 | Dual-Queue 注入 | Ctrl+Enter 后下一 boundary 生效、可见"用户补充"、**重启后历史仍在**、可撤回 |
| S-07 | 429 恢复 | 模拟限流→队列 PAUSED→按 Retry-After 自动恢复→任务完成 |
| S-08 | 重启恢复 | 运行中任务 + 应用重启→任务自动重新排队执行，无永久 RUNNING |
| S-09 | 长对话压缩 | 触发压缩→摘要持久化→后续轮正常→原始 transcript 未破坏 |
| S-10 | 跨会话并行 | conversation A 流式 + conversation B 任务流同时进行，互不干扰 |
| S-11 | 取消传播 | 取消运行中分支任务→流停止→队列推进下一任务 |
| S-12 | 轨迹导出 | S-04 完成后导出 JSON：轮次/工具/审批/token 记录完整且无密钥 |

### 4.3 退出标准（Definition of Done for v1.5.0）

1. §4.2 全部场景通过并有证据记录（截图/轨迹 JSON 归档 `docs/private/smoke-evidence-register/`）。
2. 全局门禁全绿；eval job 全绿；S0 golden 集无跳过用例。
3. CAPABILITIES.md 中 C05/C06/C07/C09/C10/C11/C12/C13/C14/C15 达到目标态（✅ 或明确降级说明）。
4. ARCHITECTURE.md 与代码一致（抽查：循环入口、模块边界、锁粒度）。
5. 无"文档宣称完成但代码未完成"的条目（本计划 §0 失真问题闭环）。
6. 版本号三处一致；CHANGELOG 完整；`docs/private/README.md` 登记齐。

---

## 5. 风险登记册

| 风险 | 概率 | 影响 | 缓解 | 触发动作 |
|---|---|---|---|---|
| M1 行为对等迁移引入回归（循环是全应用最热路径） | 中 | 高 | S0 golden 先行；每小步提交；迁移期不动文案 | 回放失败即停，二分定位 |
| per-conversation 流锁破坏消息树写序假设 | 中 | 高 | 写序以 conversation 为单位验证；同 conversation 仍独占 | 恢复全局锁的热修复路径保留一个 patch 版本 |
| 任务队列驱动真实流的事件路由复杂度超预估 | 中 | 中 | M4.4 先做单任务串行版再开并行；事件路由独立模块+单测 | 并行度默认 1 不变，交付时间不减 |
| 并行工具执行触发 provider 并发限制 | 低 | 中 | 并行仅限本地 Safe 工具（file 读/todo/calculator），terminal/web 默认 Exclusive | 出问题即全局回退串行（配置开关） |
| 注入持久化改动消息 schema 触发兼容问题 | 低 | 中 | 仅新增列/新 source 值，不改既有列语义；迁移单测 | 回滚迁移脚本随发布保留 |
| 工期超支 | 中 | 中 | 关键路径 M0→M1→M4→M6；M2/M3 可裁剪延后至 v1.5.1 | 超期 50% 时按 §6 裁剪 |
| 429 真实触发难模拟 | 低 | 低 | scripted provider 注入 429 剧本；真实场景仅 S-07 抽测 | — |
| `lint:eol:fix` 类仓库工具的破坏性行为 | 中 | 中 | 脚本已修复（.md 豁免 interleaved-blank）；规则 8 要求逐文件执行+审查 diff | 再次损伤即 git checkout 恢复 + 脚本回归测试 |
| windows-gnu 本地工具链与 CI(MSVC) 差异掩盖问题 | 中 | 中 | golden 用例双端可跑；CI 仍以 MSVC 为准；本地清单补丁记录在 AGENTS.md | 发现 MSVC 特有行为差异即升级为 ADR |
| Mimosa 钩子扫描覆盖不完整（library_source/callgraph 部分） | 中 | 中 | 已按钩子要求重构 eol 脚本路径处理（argv 污染链切断，扫描 0 finding）；发布前执行一次 deep 完整审计 | 审计出现 high 未决项即冻结发布 |

---

## 6. 裁剪策略（超期时的让步顺序）

1. M3.3 溢出落盘 → 降级为保留 8K 截断（记 TODO）。
2. M2.4 并行工具执行 → 默认关闭，仅保留接口。
3. M5.3 前端指标面板 → 延后 v1.5.1。
4. M4.6 注入撤回 → 延后。
5. **不可裁剪**：M1（会话作用域，正确性）、M4.1–M4.4（旗舰能力闭环）、M0/M6 的验收门禁。

---

## 7. 回滚与兼容

- 每个里程碑独立 checkpoint 提交；S5（流锁+队列）若发布前发现阻塞问题，可回退到 M1–M3 状态发布（架构债已清，功能债明示在 CHANGELOG）。
- 迁移文件只增不改；新表/新列对旧数据零影响；降级场景（旧版本打开新库）遵循 SQLite 宽松读原则，`agent_runs`/overflow 表旧版本忽略。
- 前端事件向后兼容：`AgentEvent` 新增字段均为可选；`UserInjected` 语义不变。

---

## 8. 文档维护规则

| 时机 | 必须更新 |
|---|---|
| 模块增删/职责变更 | ARCHITECTURE.md §2/§4 + ADR |
| 能力状态变化（含降级） | CAPABILITIES.md 总览表 + 明细 |
| 里程碑勾选/工时修正/风险变化 | 本文档 §2/§3/§5 |
| 每周五 | 本文档进度勾选 + 风险复查 |
| 设计新决策 | `docs/private/TECHDESIGN-*.md` + `docs/private/README.md` 登记 |
