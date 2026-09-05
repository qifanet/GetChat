# AGENTS.md — GetChat

Local-first desktop AI chat app where every conversation is a **tree, not a line**: branch from any message, compare branches side-by-side, set a mainline, never destroy history. Tauri v2 desktop app — no cloud, no telemetry.

- **Frontend** (`src/`): React 19 + TypeScript (strict) + Zustand + Tailwind CSS v4, Vite, Vitest.
- **Backend** (`src-tauri/`): Rust + Tauri v2 + sqlx + SQLite (migrations in `src/db/migrations/`), MCP client (`rmcp`), keyring for secrets.
- Bilingual UI: `src/i18n/locales/en.json` **and** `zh-CN.json` must always be updated together.
- Doc-driven development in progress (v1.5.0): see root `ARCHITECTURE.md` / `CAPABILITIES.md` / `DEVELOPMENT.md` — keep them in sync when touching architecture or capabilities.

## Commands

| Task | Command |
|---|---|
| Dev (full desktop app) | `npx tauri dev` (Vite on port 1420, strictPort) |
| Dev (browser-only UI) | `npm run dev` — uses `browserDebugRuntime` mocks, no Tauri needed |
| Typecheck (CI gate) | `npx tsc --noEmit` |
| Frontend tests | `npm test` / `npm run test:watch` (Vitest, jsdom) |
| Rust check / test | `cd src-tauri && cargo check --locked && cargo test --locked` (CI runs on windows-latest) |
| Build installer | `npx tauri build` → `src-tauri/target/release/bundle/` |
| Line endings check | `npm run lint:eol` (**check only** — see warning below) |

There is no ESLint/Prettier; `tsc --noEmit` + tests are the gates.

⚠️ **Never run `npm run lint:eol:fix` on the whole repo.** Its interleaved-blank rule deletes legitimate blank lines (it damaged Markdown paragraphs and code spacing repo-wide once already). The script now exempts `.md` from that rule, but run fixes per-file only and review the diff.

## Local dev environment (this machine)

- **All toolchains live under `D:\DevRuntimes`, never on C:** (disk-space policy).
  - Rust: `RUSTUP_HOME=D:\DevRuntimes\rust\rustup`, `CARGO_HOME=D:\DevRuntimes\rust\cargo` (user env vars), toolchain `stable-x86_64-pc-windows-gnu`.
  - MinGW-w64 (gcc/as/dlltool/ld, MSYS2 packages): `D:\DevRuntimes\mingw64\mingw64\bin` (on user PATH).
  - npm cache: `D:\DevRuntimes\npm-cache`.
- **windows-gnu specifics**: MSYS2's `default-manifest.o` was regenerated to include the Common-Controls v6 dependency (backup at `default-manifest.o.bak`) — without it, binaries that import `TaskDialogIndirect` (via wry) die at load with `STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139). `WebView2Loader.dll` (x64, from webview2-com-sys) is placed in `mingw64\bin` for test runs. CI (MSVC) is unaffected.
- USTC mirrors are the reliable download path on this network: `RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static`; large downloads sometimes need retries.
- Shell state does not persist between commands: re-export `RUSTUP_HOME`/`CARGO_HOME`/`PATH` for every cargo invocation.

## Git conventions (from CONTRIBUTING.md)

- Never commit directly to `main`; PRs only, squash merge.
- Branch names: `feature/…`, `fix/…`, `docs/…`, `refactor/…`, `test/…`, `chore/…`.
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Architecture boundaries

### Frontend layering

1. `src/services/tauriTypes.ts` → 2. `src/services/tauriCommands.ts` → 3. components/stores. **Never call `invoke()` directly in components** — all Tauri calls go through the typed wrappers in `tauriCommands.ts` (they normalize errors to `TauriAppError` and log `[tauri] CODE command (duration)`).
- A new Tauri command must be registered **both** in `lib.rs` `invoke_handler` **and** in `BrowserDebugCommandName` in `src/services/browserDebugRuntime.ts`.
- SQLite/Tauri is the single source of truth. Zustand stores (`useAppStore`, `useStreamStore`, `useThemeStore`) hold only the current session snapshot, workspace mode, and UI state.
- **Streaming is dual-layer**: `streamRuntimeRegistry.ts` (NOT a store; only `streamController.ts` may touch it) holds chunk buffers, flush timers, and imperative text surfaces. Streaming text must never enter React state, Zustand, or the DB per-token; commit the final text once, then render via `MarkdownRenderer`.
- Tree path / sibling / shared-context computations go in `src/selectors/` as pure functions — never scattered through components.
- New Rust `AppState` fields must be initialized in `lib.rs` setup.

### Backend layering (src-tauri/src)

- Order: `commands/` (thin: parse args → call service/repository; no complex SQL in `#[tauri::command]`) → `services/` → `repositories/` → `db/migrations/`.
- New backend feature order: DTO → service/repository → command → AppState → `invoke_handler`.
- Wrap multi-step creates (conversation + branch + messages) in transactions. New schemas = numbered migration file.
- Use intent-named commands (e.g. `set_mainline_branch`), never generic patch commands (`update_message_content`, `patch_branch_head`, `generic_patch_entity` are forbidden).
- No runtime-derived fields in the DB (no `childIds`/indexes) — snapshot loading builds them.
- Agent runtime lives in `src-tauri/src/agent/` (deps seam + eval harness); the ReAct loop is being migrated out of `commands/streaming.rs` — see `ARCHITECTURE.md` §5 for the migration table.

## Non-destructive conversation model (critical domain rules)

- `messages.parent_message_id` forms the tree. `branches` are named path pointers storing `source_branch_id`, `fork_point_message_id`, `fork_source_type`, `fork_source_message_id`, `head_message_id` — not a messages-mapping table.
- `conversations.mainline_branch_id` is the **only** mainline pointer. Branch DTO `isMainline` is derived from it; never add an `is_mainline` column. `set_mainline` only changes that pointer.
- Continue-from-history and edit-historical-user-message **create a new branch** (new user message row; the original message row is never mutated). For a history user edit: new message's `parent_message_id` = original's `parent_message_id`, `fork_point_message_id` = original's parent, `fork_source_message_id` = original.
- Regenerate produces an **assistant variant** (sibling under the same user message) — not a branch, and it must not move the branch head. A variant only becomes a branch when the user continues from it.
- `workspaceMode` is an explicit state: `normal | historyFork | editFork | compare`. `compare` is read-only (composer disabled/hidden).
- The chat area shows only the current path — never the whole tree; branch structure lives in the right sidebar.

## Security

- API keys are stored only as references in SQLite; the secret lives in the OS keyring (`keyring` crate). The frontend never receives plaintext keys.
- Extra security review required for anything touching tool-call approval, file path operations, API keys, or raw SQL.

## Gotchas

- Repo enforces **CRLF** line endings (`.editorconfig`); run `npm run lint:eol` (check mode) after editing. Indent: 2 spaces everywhere except Rust/TOML (4).
- `rmcp` is patched from a git fork via `[patch.crates-io]` in `src-tauri/Cargo.toml` (tolerates MCP servers missing `Content-Type`); do not remove without checking the upstream fix.
- Vitest aliases `@tauri-apps/api/core` to the stub `src/test/stubs/tauriApiCore.ts`; test setup is `src/test/setup.ts`.
- TypeScript is strict — avoid `any`.
- Rust pitfalls: `json!`/`Value` need `use serde_json::{json, Value}`; `watch::Receiver` needs `mut` for `.changed()`; `Duration::from_secs` takes `u64`.
- Golden tests for the ReAct loop live in `src-tauri/src/agent/eval/cases.rs` — run `cargo test --lib` after touching the loop, tools, or prompt assembly; do not change their assertions during M1–M4 refactors.

## Docs to read before sensitive changes

- `docs/private/` — internal SOP and per-version design docs (`SOP-development-workflow.md`, `PRD-*.md`, `TECHDESIGN-*.md`, `SQLiteSchema+TauriCommand接口设计.md` for schema/command contracts). Register new/archived docs in `docs/private/README.md`.
- `docs/编译指导手册.md` — build/compile troubleshooting guide.
- `CLAUDE.md` — the same constraints written in Chinese.
