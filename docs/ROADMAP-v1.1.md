# GetChat v1.1 Development Roadmap

> 本文档跟踪 v1.1 开发进度，每项任务都包含明确的验收标准。

## 依赖关系

```text
Ollama 完善 ──→ 辅助 AI 模型设置 ──→ AI 自动生成标题
                                      └→ AI 分支差异总结
消息操作菜单（独立，可并行）
快捷键支持（独立，可并行）
全文搜索（独立，可并行）
```

---

## 1. Ollama Provider 支持

**状态**: ✅ 已完成
**优先级**: P1 — 最高（其他 AI 辅助功能依赖此功能降低用户成本）

### 完成内容

- 新增 `fetch_ollama_models` 后端命令，从 `/api/tags` 自动拉取可用模型
- 前端 Provider 设置页添加"从 Ollama 获取模型"按钮
- Ollama 类型自动隐藏 API Key 输入框
- 路由优化：Ollama 始终优先走原生 `/api/chat` 端点
- 上下文修复：添加 `num_ctx: 32768` 扩展上下文窗口（默认 4096 太小）
- 性能优化：添加 `think: false` 禁用思考模式，避免生成不可见的 thinking tokens

---

## 2. 辅助 AI 模型设置

**状态**: ✅ 已完成
**优先级**: P1 — 高（AI 标题生成、分支差异总结等辅助功能需要用此模型）

### 完成内容

- 后端：利用现有 `app_kv` 表存储 `helper_model_id`，新增 `get_helper_model` / `set_helper_model` command
- 后端：`BootstrapResult` 新增 `helperModelId` 字段，启动时自动加载
- 前端：`AppSettings` 类型新增 `helperModelId`，store 实现读写与持久化
- 前端：Settings 页面新增"辅助 AI 模型"选择区，下拉框列出所有可用模型
- 前端：未配置时显示黄色提示文字，不阻塞正常使用
- i18n：添加中英文翻译键（`helperModelTitle`、`helperModelHelp` 等）
- Browser debug runtime：同步支持 `get_helper_model` / `set_helper_model`

---

## 3. AI 自动生成会话标题

**状态**: ✅ 已完成
**优先级**: P1 — 高（依赖 #1 Ollama + #2 辅助模型设置）

### 完成内容

- DB Migration 0004: `conversations` 表新增 `title_source` 字段（DEFAULT / AI_GENERATED / USER_SET）
- 后端新增 `helper_ai_service.rs`: 非流式 AI 调用服务，支持 Ollama 和 OpenAI Compatible
- 后端新增 `generate_conversation_title` command: 自动检查条件后调用辅助模型生成标题
- 后端 `rename_conversation` 改用 `update_title_user_set`，手动重命名不会被 AI 覆盖
- 前端 store 新增 `autoGenerateTitle` action，fire-and-forget 调用后端
- 前端 `streamController.ts` 的 `completeStream` 中自动触发标题生成
- 条件判断：仅当 `title_source = DEFAULT` 且当前标题是默认值时才触发
- 失败静默降级，不弹错误、不阻塞用户操作

---

## 4. 消息操作菜单完善

**状态**: ✅ 已完成
**优先级**: P2 — 中

### 完成内容

- 新增 `MessageActionToolbar` / `MessageActionButton` / `MessageActionMoreMenu` 组件
- 新增 6 个 Icon 组件：`IconCopy`、`IconRefresh`、`IconBranch`、`IconEllipsis`、`IconCheck`
- User 消息：hover 时显示复制 + 更多（编辑、从这里继续）按钮
- Assistant 消息：hover 时显示复制 + 重新生成 + 应用到分支 + 更多（从这里继续）按钮
- 更多菜单：下拉菜单，点击外部或 Escape 关闭
- 使用 `group/message` + `group-hover/message:opacity-100` 实现 hover 触发

---

## 5. 快捷键支持

**状态**: ✅ 已完成
**优先级**: P2 — 中

### 完成内容

- 新增 `useGlobalShortcuts` hook，注册 7 个全局快捷键
- `Ctrl/Cmd + N` → 新建会话
- `Ctrl/Cmd + Enter` → 发送消息（即使 textarea 聚焦也生效）
- `Escape` → 取消流式生成 → 取消分叉 → 退出对比（优先级）
- `Ctrl/Cmd + ,` → 打开设置
- `Ctrl/Cmd + B` → 切换左侧边栏
- `Ctrl/Cmd + .` → 切换右侧面板
- `Ctrl/Cmd + K` → 打开全文搜索
- Settings 页面新增"键盘快捷键"帮助区，使用 `<kbd>` 元素展示
- 输入框聚焦时，单字母快捷键不触发（`isEditableTarget()` 检测）

---

## 6. 全文搜索

**状态**: ✅ 已完成
**优先级**: P2 — 中

### 完成内容

- 后端 `repositories/messages.rs` 新增 `search_messages` SQL LIKE 查询
- 后端 `commands/messages.rs` 新增 `search_messages` command，含 snippet 提取
- 前端 `tauriCommands.ts` 新增 `searchMessages` / `SearchResultItem` 类型
- 新增 `SearchDialog` 组件：弹窗式搜索界面
- 300ms 防抖搜索，结果按会话分组
- 关键词高亮（`<mark>` 标签 + amber 背景色）
- 空搜索时显示最近 5 个会话
- 搜索图标 + placeholder 提示
- i18n：中英文搜索相关翻译键
- Browser debug runtime：同步支持搜索 mock

---

## 7. AI 分支差异总结

**状态**: ✅ 已完成
**优先级**: P3 — 低（依赖 #2 辅助模型设置）

### 完成内容

- 后端 `helper_ai_service.rs` 新增 `generate_branch_diff_summary` 服务
- 后端新增 `generate_branch_diff_summary` command（Ollama + OpenAI Compatible 双适配）
- 分支文本收集：从 head 向 root 回溯，最多 10 条消息，每条截断 300 字符
- 前端 `tauriCommands.ts` 新增 `generateBranchDiffSummary` 函数
- CompareToolbar 新增"AI 差异总结"按钮 + Markdown 结果展示区
- 未配置辅助模型时按钮禁用 + tooltip 提示
- Loading 状态展示
- i18n：中英文对比模式 AI 总结翻译键
- Browser debug runtime：同步支持 diff summary mock

---

## 版本信息

- **版本号**: 1.1.0
- **发布日期**: 2026-05
- **涉及文件版本更新**: `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`

---

## 开发顺序

```text
阶段 1（可并行）:
  ├── #1 Ollama Provider 支持 ✅
  ├── #4 消息操作菜单 ✅
  └── #5 快捷键支持 ✅

阶段 2（依赖阶段 1）:
  ├── #2 辅助 AI 模型设置 ✅
  └── #6 全文搜索 ✅

阶段 3（依赖阶段 2）:
  ├── #3 AI 自动生成会话标题 ✅
  └── #7 AI 分支差异总结 ✅
```
