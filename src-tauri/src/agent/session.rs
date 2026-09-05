/**
 * @file agent/session.rs
 * @description Per-request agent session state (v1.5.0 M1).
 *
 * Replaces the global statics the loop used to reach for (the inject queue in
 * `services/inject_queue.rs` and the todo conversation id in
 * `tool_executor.rs`): everything request-scoped now lives in an
 * `AgentSession` stored in `AppState::agent_sessions`, keyed by `request_id`.
 *
 * Two concurrent streams therefore cannot observe each other's injections or
 * todo context — the concurrency bug ARCHITECTURE.md §3 A3 described.
 *
 * Lifecycle: created by `start_model_stream` before `run_react_loop`, removed
 * when the stream finishes (all outcome paths). The deps keep an `Arc` clone
 * so the runner can drain injections even while the command layer unwinds.
 */

use tokio::sync::Mutex;

/** Everything a single agent run accumulates from the outside world. */
#[derive(Default)]
pub(crate) struct AgentSession {
    /// Dual-Queue messages queued by the user, drained at each tool boundary.
    pub injections: Vec<String>,
}

/** Shared handle stored in `AppState::agent_sessions`. */
pub(crate) type SharedAgentSession = std::sync::Arc<Mutex<AgentSession>>;

/** Create a session handle for `request_id` (empty session). */
pub(crate) fn new_shared_session() -> SharedAgentSession {
    std::sync::Arc::new(Mutex::new(AgentSession::default()))
}

/** Drain and return every queued injection for this session. */
pub(crate) async fn drain_injections(session: &SharedAgentSession) -> Vec<String> {
    let mut session = session.lock().await;
    session.injections.drain(..).collect()
}
