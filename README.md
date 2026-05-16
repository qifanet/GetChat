<div align="center">

<img src="src/assets/brand/getchat-logo.svg" width="64" height="64" alt="GetChat Logo" />

# GetChat

**Get inspiration, get creativity, get infinite possibilities.**

A local-first desktop AI chat app where every conversation is a tree, not a line. Branch anywhere, compare side-by-side, and never lose a great idea again.

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

## The Problem

Ever had this happen? You're deep in a conversation with an AI, the response is almost perfect — so you tweak the prompt and hit regenerate. Now the old answer is gone. Or you try a completely different approach, and the entire context resets.

Most AI chat tools treat conversations as a straight line. One wrong turn and you lose your work.

## The Idea

**What if every conversation was a tree instead of a line?**

GetChat lets you branch from *any* message — like forking a Git repo, but for your train of thought. The original path is never destroyed. You can explore freely, compare branches side-by-side, and merge your favorite path back as the main thread.

## What Can You Do?

### Branch From Anywhere

Spotted a message halfway through the conversation that could go in a different direction? Click and branch. Want to try a different model for the same question? Regenerate creates a variant without touching the original. Your exploration is always non-destructive.

### Compare Branches Side-by-Side

Pick two branches and view them in a split pane. Shared context is highlighted so you can focus on what's different. There's even an AI-powered diff summary to help you decide which path to keep.

### Rich Markdown Rendering

AI responses come alive with full Markdown rendering: syntax-highlighted code blocks (30+ languages), LaTeX math formulas, Mermaid diagrams, tables, and more. User messages get the same treatment — because your words deserve nice formatting too.

### Connect Any Provider

OpenAI, DeepSeek, Ollama, or anything that speaks the OpenAI protocol. Add as many providers as you like, set a default model for quick chats, or pick different models per branch. Your local Ollama models work out of the box.

### Your Data, Your Machine

Everything lives in a local SQLite database. No cloud sync, no telemetry, no accounts. The only network calls are the AI APIs you configure yourself. Your conversations stay where they belong — on your computer.

### Small & Fast

Built on Tauri v2 (Rust backend), not Electron. The app is lightweight, starts instantly, and uses a fraction of the memory. Runs natively on Windows, macOS, and Linux.

### Keyboard-First

Chat with keyboard shortcuts: send messages, switch conversations, navigate branches — all without reaching for the mouse.

### Speaks Your Language

English and Chinese out of the box. Switch anytime in Settings.

## Quick Start

### For Users

Head to the [Releases page](https://github.com/qifanet/GetChat/releases) and grab the latest installer for your platform. That's it.

### For Developers

```bash
git clone https://github.com/qifanet/GetChat.git
cd GetChat
npm install
npx tauri dev
```

You'll need [Node.js](https://nodejs.org/) 18+, the [Rust](https://www.rust-lang.org/tools/install) stable toolchain, and the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for your platform.

### Build from Source

```bash
npx tauri build
```

The installer will be in `src-tauri/target/release/bundle/`.

## Contributing

We'd love your help! Check out the [Contributing Guide](./CONTRIBUTING.md) for branch naming conventions, commit message format, and the PR workflow.

## License

[MIT License](./LICENSE) — use it, fork it, share it.

---

<div align="center">

Built with care by [QiFans](https://github.com/qifanet)

</div>
