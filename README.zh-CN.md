<div align="center">

<img src="src/assets/brand/getchat-logo.svg" width="64" height="64" alt="GetChat Logo" />

# GetChat

**Get inspiration, get creativity, get infinite possibilities.**

本地优先的桌面端 AI 对话应用，支持分支式会话与并排对比。

[![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows11&logoColor=white)](#)
[![macOS](https://img.shields.io/badge/macOS-Intel%20%2F%20Apple%20Silicon-000000?logo=apple&logoColor=white)](#)
[![Linux](https://img.shields.io/badge/Linux-x64-FCC624?logo=linux&logoColor=black)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=black)](https://tauri.app/)
[![MIT License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

## 为什么选择 GetChat？

大多数 AI 对话工具把会话当作一条时间线。一旦你点击"重新生成"或换一个提示词，之前的回答就没了。GetChat 不一样：**每一段对话都是一棵树，而不是一条线。**

- **任意分叉** — 从历史中的任意一条消息创建分支，尝试不同的提示词、模型或方案，原路径始终保留。
- **并排对比** — 将两条分支并排放在一起，直观比较哪个回答更好。
- **数据留在本地** — 所有对话、分支和设置都存储在本地 SQLite 数据库中，除了你配置的 AI API 调用外，没有任何数据被发送到服务器。

## 功能特性

### 分支式对话

每条消息都可以成为新分支的起点。编辑重发、重新生成、手动分叉 — 原始路径始终保留。在侧边栏中可以自由浏览完整的对话树。

### 并排对比

选择任意两条分支，在分屏视图中进行对比。共享上下文高亮显示，让你专注于实际差异。

### 多 Provider 支持

接入 OpenAI、DeepSeek、Ollama 或任何兼容 OpenAI 协议的 API。可以配置多个 Provider，在不同分支间切换使用，也可以设置全局默认模型方便快速调用。

### 本地优先 & 隐私安全

- 所有数据存储在本地 SQLite 数据库中。
- 无遥测、无分析、无云同步。
- 只有你明确配置的 AI API 调用会连接外部服务。

### 跨平台桌面应用

基于 Tauri v2 构建，在 Windows、macOS 和 Linux 上提供轻量原生的体验。不使用 Electron，不捆绑浏览器。

### 自动更新

应用在后台检查新版本，发现更新后会通知你。你可以自主决定何时下载安装。

### 国际化

支持中文和英文，可随时在设置中切换。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Tailwind CSS |
| 状态管理 | Zustand v5 + Immer |
| 桌面运行时 | Tauri v2 (Rust) |
| 数据库 | SQLite (WAL 模式，本地优先) |
| 流式输出 | 基于 Rust 的流式管道 + 命令式文本渲染 |
| 国际化 | i18next |
| 测试 | Vitest (前端)、Cargo test (后端) |

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) 稳定版工具链
- [Tauri v2](https://tauri.app/start/prerequisites/) 所需的平台依赖

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/qifanet/GetChat.git
cd GetChat

# 安装前端依赖
npm install

# 启动开发模式（前后端热重载）
npx tauri dev
```

### 生产构建

```bash
npx tauri build
```

安装包将生成在 `src-tauri/target/release/bundle/` 目录下。

### 运行测试

```bash
# 前端测试
npm test

# 后端测试
cargo test --manifest-path src-tauri/Cargo.toml
```

## 项目结构

```
GetChat/
├── src/                          # 前端源码 (React + TypeScript)
│   ├── components/               # UI 组件
│   │   ├── chat/                 # 消息列表与对话视图
│   │   ├── composer/             # 消息输入区
│   │   ├── compare/              # 并排对比工作区
│   │   ├── conversations/        # 会话侧边栏
│   │   ├── settings/             # Provider 与应用设置
│   │   └── ...
│   ├── features/                 # 功能模块 (发送逻辑、模型管理)
│   ├── services/                 # Tauri IPC 通信、流式运行时
│   ├── stores/                   # Zustand 状态仓库
│   └── i18n/                     # 国际化资源
├── src-tauri/                    # 后端源码 (Rust + Tauri)
│   ├── src/
│   │   ├── commands/             # Tauri IPC 命令处理
│   │   ├── services/             # 业务逻辑服务
│   │   ├── repositories/         # 数据库访问层
│   │   └── db/migrations/        # SQLite 迁移脚本
│   └── icons/                    # 各平台应用图标
├── docs/                         # 设计文档与技术规格
└── scripts/                      # 构建与 lint 脚本
```

## 文档

设计文档和技术规格位于 [`docs/`](./docs/) 目录：

- **PRD-v1.md** — 产品需求文档
- **SQLiteSchema + TauriCommand 接口设计** — 数据库结构与 IPC API
- **TypeScript 核心类型 + Zustand Store 设计** — 前端架构设计

## 参与贡献

欢迎贡献代码！请阅读 [贡献指南](./CONTRIBUTING.md) 了解：

- 分支命名规范
- 提交信息格式（`feat:`、`fix:`、`docs:` 等）
- Pull Request 工作流程与审查规范

## 许可证

[MIT License](./LICENSE) — 可自由使用、修改和分发。

---

<div align="center">

Built with care by [QiFans](https://github.com/qifanet)

</div>
