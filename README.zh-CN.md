<div align="center">

# GetChat

**桌面优先、本地优先的 AI 对话工作台，支持分支式会话**

[![TypeScript][badge-ts]][link-ts]
[![React 19][badge-react]][link-react]
[![Tauri v2][badge-tauri]][link-tauri]
[![SQLite][badge-sqlite]][link-sqlite]
[![Vitest][badge-vitest]][link-vitest]
[![MIT License][badge-license]][link-license]

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

## 项目概览

GetChat 是一个基于 Tauri 的桌面应用，不是简单的聊天套壳。

它把对话保存为可分叉的消息树，支持路径比较、主线收敛和本地工作区持久化。当前产品形态已经切换为 **workspace-first**：即使用户还没有配置任何 AI Provider，主工作区依然可用；Provider 的接入放在 **Settings** 页面完成，不再阻塞首次进入。

## 当前能力

| 能力 | 当前实现 |
| --- | --- |
| 工作区优先 | 首屏直接进入可用工作区，无需先强制配置 Provider |
| 分支式对话 | 支持从历史消息分叉、编辑后重发、重新生成，且不会破坏原路径 |
| Compare 模式 | 支持两条分支并排比较，并识别共享上下文 |
| Provider 配置 | 在 Settings 页面集中管理 Provider 与默认模型 |
| 模型展示 | UI 统一显示模型 `displayName`，稳定 ID 与请求名保留在内部链路 |
| 流式性能 | 长消息通过 runtime registry 与 imperative text surface 渲染，减少高频 React 重渲染 |
| 本地优先持久化 | SQLite 作为工作区、会话、分支、消息的事实来源 |
| 品牌统一 | 应用 Logo、favicon 与 Tauri 打包图标已统一到同一品牌资源体系 |

## 架构说明

### 前端

- 使用 React 19 + TypeScript 构建桌面壳层。
- 使用 Zustand 管理应用状态、工作区状态和流式会话元数据。
- 工作区、Compare、Settings、对话侧栏和顶部上下文栏运行在同一个桌面应用壳层中。
- 模型显示名通过统一的 display helper 解析，避免界面泄露模型 ID 或请求名。

### 后端

- 使用 Rust + Tauri v2 提供桌面运行时和 IPC。
- 命令按领域拆分为 bootstrap、settings、conversations、branches、messages、streaming、debug。
- repository 与 service 分层明确，便于测试和维护。

### 持久化与流式输出

- SQLite 负责保存完整的会话树和工作区状态。
- 流式文本缓冲不直接进入 React 状态，而是在运行时注册表中累积，完成后再稳定提交。
- 后端流服务负责把不同 Provider 的输出统一成一致的桌面流式事件。

## 项目结构

```text
GetChat/
├── src/
│   ├── components/
│   │   ├── brand/          # 品牌 Logo 与锁定版标识
│   │   ├── chat/           # 对话消息列表与工作区消息视图
│   │   ├── composer/       # 消息发送区
│   │   ├── compare/        # Compare 对比工作区
│   │   ├── conversations/  # 左侧会话列表项
│   │   ├── layout/         # 顶部上下文栏与桌面壳层
│   │   ├── settings/       # Provider 设置页
│   │   └── workspace/      # 分叉/编辑工作区提示区
│   ├── features/
│   │   ├── composer/       # 发送计划与发送流程
│   │   └── models/         # 模型显示与选择辅助逻辑
│   ├── services/           # Tauri 命令、流式运行时、浏览器调试运行时
│   ├── stores/             # Zustand 状态仓库
│   ├── i18n/               # 中英文资源与显示名辅助函数
│   └── assets/brand/       # 共用品牌 SVG 资源
├── public/                 # favicon 与静态资源
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   ├── services/
│   │   ├── repositories/
│   │   ├── db/migrations/
│   │   └── dto/
│   └── icons/              # 桌面与移动端打包图标
├── docs/                   # PRD、接口设计、stitch 设计输出、审计记录
└── README*.md
```

## 快速开始

### 环境要求

- Node.js 18+
- Rust stable
- Tauri CLI
- 当前机器上可用的 Windows Tauri 编译工具链

### 安装依赖

```bash
git clone https://github.com/qifanet/GetChat.git
cd GetChat
npm install
```

### 启动桌面开发模式

```bash
npx tauri dev
```

### 运行测试

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

### 构建发布版本

```bash
npx tauri build
```

## 测试状态

当前仓库内的自动化测试覆盖包括：

| 测试范围 | 数量 |
| --- | ---: |
| 前端自动化测试 | 115 |
| Rust 不变量测试 | 11 |

前端测试当前覆盖如下：

| 模块 | 数量 |
| --- | ---: |
| `buildSendPlan` | 11 |
| `branchSelectors` | 23 |
| `conversationSelectors` | 20 |
| `streamController` | 12 |
| `tauriCommands` | 28 |
| `browserDebugRuntime` | 4 |
| `AssistantMessageBubble` | 6 |
| `MarkdownRenderer` | 3 |
| `CompareWorkspace` | 8 |

## 文档目录

主要文档位于 [`docs/`](./docs/)：

- `PRD-v1.md`
- `SQLiteSchema+TauriCommand接口设计.md`
- `TypeScript核心类型定义+ZustandStore设计草案.md`

## 参与贡献

开发流程、提交规范和 PR 要求见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

本项目基于 MIT License，详见 [LICENSE](./LICENSE)。

[badge-ts]: https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white
[badge-react]: https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black
[badge-tauri]: https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=black
[badge-sqlite]: https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white
[badge-vitest]: https://img.shields.io/badge/Vitest-3-6E9F18?logo=vitest&logoColor=white
[badge-license]: https://img.shields.io/badge/License-MIT-green
[link-ts]: https://www.typescriptlang.org/
[link-react]: https://react.dev/
[link-tauri]: https://tauri.app/
[link-sqlite]: https://www.sqlite.org/
[link-vitest]: https://vitest.dev/
[link-license]: ./LICENSE
