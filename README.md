<div align="center">

<img src="src/assets/brand/getchat-logo.svg" width="64" height="64" alt="GetChat Logo" />

# GetChat

**Get inspiration, get creativity, get infinite possibilities.**

A local-first desktop AI chat application that supports branching conversations and side-by-side comparison.

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

## Why GetChat?

Most AI chat tools treat conversations as a flat timeline. Once you hit "regenerate" or try a different prompt, the previous response is gone. GetChat takes a different approach: **every conversation is a tree**, not a line.

- **Branch anywhere** — Fork from any message in history. Try different prompts, models, or approaches without losing context.
- **Compare side by side** — Place two branches next to each other to see which response works best.
- **Your data stays local** — All conversations, branches, and settings are stored in a local SQLite database. Nothing is sent to any server except the AI API calls you configure.

## Features

### Branching Conversations

Every message can be the starting point of a new branch. Edit-and-resend, regenerate, or manually fork — the original path is always preserved. Navigate the full tree in the sidebar.

### Side-by-Side Comparison

Select any two branches and compare them in a split view. Shared context is highlighted, so you can focus on what actually differs.

### Multi-Provider Support

Connect to OpenAI, DeepSeek, Ollama, or any OpenAI-compatible API. Configure multiple providers and switch between them per-branch. Set a global default model for quick access.

### Local-First & Private

- All data lives in a local SQLite database on your machine.
- No telemetry, no analytics, no cloud sync.
- Only the AI API calls you explicitly configure leave your machine.

### Cross-Platform Desktop App

Built with Tauri v2 for a lightweight, native experience on Windows, macOS, and Linux. No Electron, no heavy browser bundled.

### Auto-Update

The app checks for new versions in the background and notifies you when an update is available. You stay in control of when to install.

### Internationalization

Supports English and Simplified Chinese. Switch at any time in Settings.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Tailwind CSS |
| State Management | Zustand v5 with Immer |
| Desktop Runtime | Tauri v2 (Rust) |
| Database | SQLite (WAL mode, local-first) |
| Streaming | Rust-based stream pipeline with imperative text rendering |
| i18n | i18next |
| Testing | Vitest (frontend), Cargo test (backend) |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- Platform-specific requirements for [Tauri v2](https://tauri.app/start/prerequisites/)

### Install & Run

```bash
# Clone the repository
git clone https://github.com/qifanet/GetChat.git
cd GetChat

# Install frontend dependencies
npm install

# Start development mode (hot reload for frontend + backend)
npx tauri dev
```

### Build for Production

```bash
npx tauri build
```

The installer will be generated in `src-tauri/target/release/bundle/`.

### Run Tests

```bash
# Frontend tests
npm test

# Backend tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Project Structure

```
GetChat/
├── src/                          # Frontend source (React + TypeScript)
│   ├── components/               # UI components
│   │   ├── chat/                 # Message list and conversation view
│   │   ├── composer/             # Message input area
│   │   ├── compare/              # Side-by-side comparison workspace
│   │   ├── conversations/        # Conversation sidebar
│   │   ├── settings/             # Provider and app settings
│   │   └── ...
│   ├── features/                 # Feature modules (composer, models)
│   ├── services/                 # Tauri IPC, streaming runtime
│   ├── stores/                   # Zustand state stores
│   └── i18n/                     # Internationalization resources
├── src-tauri/                    # Backend source (Rust + Tauri)
│   ├── src/
│   │   ├── commands/             # Tauri IPC command handlers
│   │   ├── services/             # Business logic services
│   │   ├── repositories/         # Database access layer
│   │   └── db/migrations/        # SQLite schema migrations
│   └── icons/                    # App icons for all platforms
├── docs/                         # Design documents and specs
└── scripts/                      # Build and lint scripts
```

## Documentation

Design documents and technical specs are in the [`docs/`](./docs/) directory:

- **PRD-v1.md** — Product requirements
- **SQLiteSchema + TauriCommand Interface Design** — Database schema and IPC API
- **TypeScript Core Types + Zustand Store Design** — Frontend architecture

## Contributing

We welcome contributions! Please read the [Contributing Guide](./CONTRIBUTING.md) for details on:

- Branch naming conventions
- Commit message format (`feat:`, `fix:`, `docs:`, etc.)
- Pull request workflow and review process

## License

[MIT License](./LICENSE) — free to use, modify, and distribute.

---

<div align="center">

Built with care by [QiFans](https://github.com/qifanet)

</div>
