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
 * M1 scope: the loop body itself now lives in `agent::runner`, mid-loop and
 * pre-append context compression in `agent::context`, prompt composition in
 * `agent::prompt`, and per-run session state in `agent::session`.
 * `commands/streaming.rs` is a thin command shell over these.
 * M2 adds `agent::tools`, M4 adds `agent::taskqueue` per the same plan.
 */

pub(crate) mod budget;
pub(crate) mod context;
pub(crate) mod deps;
pub(crate) mod eval;
pub(crate) mod policy;
pub(crate) mod prompt;
pub(crate) mod runner;
pub(crate) mod session;
pub(crate) mod tools;
