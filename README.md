<div align="center">

# GetChat

**Desktop-first, local-first AI workspace for branching conversations**

[![TypeScript][badge-ts]][link-ts]
[![React 19][badge-react]][link-react]
[![Tauri v2][badge-tauri]][link-tauri]
[![SQLite][badge-sqlite]][link-sqlite]
[![Vitest][badge-vitest]][link-vitest]
[![MIT License][badge-license]][link-license]

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

## Overview

GetChat is a Tauri desktop application for people who need more than a linear chat log.

It keeps conversations as a branchable message tree, lets you compare paths side by side, and keeps the main workspace usable even before any AI provider is configured. Provider onboarding happens in **Settings**, not as a first-launch blocker.

## Product Highlights

| Capability | Current behavior |
| --- | --- |
| Workspace-first entry | The app opens into a usable workspace even when no provider is configured yet |
| Branching conversations | Fork from history, edit-and-resend, regenerate, and preserve prior paths |
| Compare mode | Review two branches side by side with shared context awareness |
| Provider settings | Configure OpenAI-compatible and other providers inside the Settings surface |
| Model presentation | UI surfaces show model `displayName`; stable IDs and request names remain internal |
| Stream performance | Long responses stream through a runtime registry and imperative text surfaces to avoid heavy React re-render churn |
| Local-first persistence | SQLite is the source of truth for workspace state, conversations, branches, and messages |
| Unified branding | In-app logo, favicon, and Tauri bundle icons are aligned with the same brand assets |

## Architecture

### Frontend

- React 19 + TypeScript power the desktop shell.
- Zustand stores app state, workspace state, and streaming metadata.
- Compare mode, provider settings, composer, sidebar navigation, and workspace chrome live in the same shell.
- Model labels are resolved through shared display helpers so the UI consistently prefers human-friendly names.

### Backend

- Rust + Tauri v2 provide the desktop runtime and IPC layer.
- Commands are split by domain: bootstrap, settings, conversations, branches, messages, streaming, and debug.
- Repositories and services keep the data layer explicit and testable.

### Persistence and Streaming

- SQLite runs in local-first mode and backs the full conversation tree.
- Streaming text is buffered outside React state and committed cleanly when complete.
- Backend stream services normalize provider output into a single desktop stream pipeline.

## Project Structure

```text
GetChat/
├── src/
│   ├── components/
│   │   ├── brand/          # Brand logo and lockup
│   │   ├── chat/           # Message list and workspace conversation view
│   │   ├── composer/       # Message composer
│   │   ├── compare/        # Compare workspace
│   │   ├── conversations/  # Conversation sidebar items
│   │   ├── layout/         # Desktop shell header and contextual chrome
│   │   ├── settings/       # Provider settings screen
│   │   └── workspace/      # Branch/fork workspace banners
│   ├── features/
│   │   ├── composer/       # Send-plan and send-message flow
│   │   └── models/         # Model display and selection helpers
│   ├── services/           # Tauri commands, streaming runtime, browser debug runtime
│   ├── stores/             # Zustand stores
│   ├── i18n/               # zh-CN / en resources and display helpers
│   └── assets/brand/       # Shared brand SVG assets
├── public/                 # Favicon and static web assets
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   ├── services/
│   │   ├── repositories/
│   │   ├── db/migrations/
│   │   └── dto/
│   └── icons/              # Desktop and mobile bundle icons
├── docs/                   # PRD, schema, stitch references, audit records
└── README*.md
```

## Getting Started

### Prerequisites

- Node.js 18+
- Rust stable
- Tauri CLI
- Windows desktop toolchain required by Tauri on your machine

### Install

```bash
git clone https://github.com/qifanet/GetChat.git
cd GetChat
npm install
```

### Run the desktop app

```bash
npx tauri dev
```

### Run tests

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

### Build

```bash
npx tauri build
```

## Test Status

Current automated coverage in the repository includes:

| Suite | Count |
| --- | ---: |
| Frontend automated tests | 115 |
| Rust invariant tests | 11 |

Frontend test coverage currently includes:

| Area | Count |
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

## Documentation

Key project documents live under [`docs/`](./docs/):

- `PRD-v1.md`
- `SQLiteSchema+TauriCommand接口设计.md`
- `TypeScript核心类型定义+ZustandStore设计草案.md`

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for workflow, commit conventions, and pull request expectations.

## License

MIT License. See [LICENSE](./LICENSE).

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
