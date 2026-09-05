/**
 * @file agent/mod.rs
 * @description Agent runtime module (introduced in v1.5.0 M0).
 *
 * M0 scope: an explicit dependency seam (`deps::ReactLoopDeps`) and a
 * scripted-model golden harness (`eval`) so the ReAct loop can be replayed
 * and asserted without a Tauri runtime, network, or provider credentials.
 *
 * `eval::mock_provider` stays compiled in release builds on purpose: it backs
 * the `StreamBackend::Scripted` seam variant and stays ~150 lines with no
 * runtime dependencies. The golden cases themselves (`eval::cases`) are
 * test-only.
 *
 * The loop body itself still lives in `commands/streaming.rs`; it moves into
 * `agent::runner` in milestone M1 (see ARCHITECTURE.md §5 migration path).
 * M2 adds `agent::tools`, M4 adds `agent::taskqueue` per the same plan.
 */

pub(crate) mod deps;
pub(crate) mod eval;
