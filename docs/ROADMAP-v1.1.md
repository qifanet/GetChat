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
- 错误处理改进：`call_helper_model` 失败时返回 `Ok(None)` 而非 `Err`，避免前端收到异常
- 空标题保护：模型返回空内容时跳过数据库更新，不覆盖原始标题
- 关键节点 INFO 日志：Ollama/OpenAI 调用的每个步骤都有可追踪的日志
- 实测验证：使用 `gpt-4.1-mini` 辅助模型，3 秒内完成标题生成（如"工具类型及应用场景介绍"）

---

## 4. 消息操作菜单完善

**状态**: 待开发  
**优先级**: P2 — 中（可与其他任务并行）

### 背景

当前消息的操作入口（复制、从这里继续、编辑、删除等）不够统一和直观。需要设计统一的右键/悬浮菜单。

### 验收标准

- [ ] 每条消息悬浮时显示操作按钮栏（hover toolbar），包含：复制、更多（...）
- [ ] 点击"更多"展开下拉菜单，包含所有可用操作
- [ ] User 消息可用操作：复制、编辑消息（创建新分支）、从这里继续（创建新分支）
- [ ] Assistant 消息可用操作：复制、重新生成（创建候选回答）、从这里继续
- [ ] 操作按钮使用 icon + tooltip，不占用消息阅读空间
- [ ] 移动端/窄屏下操作按钮通过右键或长按触发

### 涉及文件

- `src/components/chat/` — MessageBubble 组件增加 hover toolbar
- `src/components/common/` — 可能需要 ContextMenu 或 DropdownMenu 通用组件

---

## 5. 快捷键支持

**状态**: 待开发  
**优先级**: P2 — 中（独立任务，可并行）

### 验收标准

- [ ] `Ctrl/Cmd + N` — 新建会话
- [ ] `Ctrl/Cmd + Shift + N` — 新建会话并作为新分支发送（如果当前有活跃会话）
- [ ] `Ctrl/Cmd + Enter` — 发送消息
- [ ] `Escape` — 取消/停止当前流式生成
- [ ] `Ctrl/Cmd + ,` — 打开设置
- [ ] `Ctrl/Cmd + K` — 打开全文搜索（为 #6 预留）
- [ ] 快捷键列表在设置页面可查看
- [ ] 输入框聚焦时，单字母快捷键不触发（避免打字冲突）

### 涉及文件

- `src/hooks/useKeyboardShortcuts.ts` — 新增全局快捷键 hook
- `src/App.tsx` — 注册全局快捷键
- `src/components/settings/ProviderSettingsScreen.tsx` — 快捷键展示区

---

## 6. 全文搜索

**状态**: 待开发  
**优先级**: P2 — 中（独立任务，可并行）

### 验收标准

- [ ] 搜索栏位于顶部工具栏，支持 `Ctrl/Cmd + K` 快捷唤出
- [ ] 输入关键词后实时搜索所有会话的消息内容
- [ ] 搜索结果按会话分组，显示会话标题 + 匹配消息的摘要（关键词高亮）
- [ ] 点击搜索结果跳转到对应会话的对应消息
- [ ] 支持中英文搜索
- [ ] 空搜索时显示最近打开的会话列表

### 涉及文件

- `src-tauri/src/commands/` — 新增 search_messages command
- `src-tauri/src/repositories/messages.rs` — SQL LIKE 或 FTS 查询
- `src/components/layout/` — 搜索弹窗 UI
- `src/components/common/` — SearchDialog 通用组件

---

## 7. AI 分支差异总结

**状态**: 待开发  
**优先级**: P3 — 低（依赖 #2 辅助模型设置）

### 验收标准

- [ ] Compare 模式界面新增"AI 总结差异"按钮
- [ ] 点击后调用辅助模型，将两条分支的消息内容作为输入
- [ ] 模型输出包含：各分支的关键观点、主要差异点、推荐建议
- [ ] 总结结果以 Markdown 格式显示在 Compare 面板中
- [ ] 如果辅助模型未配置，按钮显示为禁用状态并提示用户配置
- [ ] 调用过程中显示 loading 状态，不阻塞页面交互

### 涉及文件

- `src/components/compare/CompareWorkspace.tsx` — 增加 AI 总结按钮和展示区
- `src-tauri/src/commands/` — 新增 summarize_branch_diff command
- `src-tauri/src/services/` — 分支差异总结 service

---

## 开发顺序建议

```text
阶段 1（可并行）:
  ├── #1 Ollama Provider 支持
  ├── #4 消息操作菜单
  └── #5 快捷键支持

阶段 2（依赖阶段 1）:
  ├── #2 辅助 AI 模型设置
  └── #6 全文搜索

阶段 3（依赖阶段 2）:
  ├── #3 AI 自动生成会话标题
  └── #7 AI 分支差异总结
```
