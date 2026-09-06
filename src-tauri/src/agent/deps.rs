/**
 * @file agent/deps.rs
 * @description Explicit dependency seam for the ReAct loop (v1.5.0 M0).
 *
 * The loop previously reached into `State<'_, AppState>` directly, which made
 * it impossible to test without a Tauri runtime. This struct carries exactly
 * what `run_react_loop` needs:
 *
 *   - the command layer builds it from `State<AppState>` (production path)
 *   - golden tests build it from fixtures (in-memory SQLite + scripted model)
 *
 * Keeping the loop a pure function of `(deps, request, channel, cancel_rx)`
 * is the M0 seam; M1's `agent::runner` formalizes this into `AgentContext`
 * together with a session-scoped inject queue and approval registry.
 */

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::{oneshot, Mutex};

use crate::dto::common::ToolDefinitionDto;
use crate::services::mcp_client::McpManager;
use crate::agent::tools::ToolExecutor;
use crate::state::{AppState, SecurityPolicy};

use super::eval::mock_provider::ScriptedModel;
use super::session::SharedAgentSession;

/** Where model requests are served from. */
#[derive(Clone, Default)]
pub(crate) enum StreamBackend {
    /// Provider HTTP stack (production path).
    #[default]
    Real,
    /// Golden-harness scripted model replaying a pre-registered script.
    /// Constructed only by tests; kept in release builds to keep the seam
    /// uniform across both compilations.
    #[allow(dead_code)]
    Scripted(Arc<ScriptedModel>),
}

/** MCP routing backend. Tests run without a Tauri runtime, so they carry
 * `Unavailable` and MCP tool calls fail closed instead of panicking. */
#[derive(Clone, Default)]
pub(crate) enum McpBackend {
    #[default]
    Unavailable,
    Real(Arc<Mutex<McpManager>>),
}

/**
 * Mid-loop context compression backend.
 *
 * Production routes to the helper-AI service, which needs Tauri state for the
 * key store (helper model credentials). Golden tests carry `Disabled`: the
 * deterministic budget checks still run, but AI compression never triggers.
 */
pub(crate) enum CompressionBackend<'a> {
    Real(&'a AppState),
    #[allow(dead_code)]
    Disabled,
}

/**
 * Everything `run_react_loop` needs from the outside world.
 *
 * Built once per stream start by the command layer; tests build an equivalent
 * fixture directly. `tool_definitions` is precomputed by the caller so the
 * loop does not need to re-derive the enabled-tool list (which requires the
 * full AppState in production).
 *
 * The lifetime `'a` exists only for `CompressionBackend::Real`, which borrows
 * the Tauri-managed state for the duration of one stream. Tests use `Disabled`
 * and are effectively `'static`.
 */
pub(crate) struct ReactLoopDeps<'a> {
    pub db: SqlitePool,
    pub tool_executor: Arc<dyn ToolExecutor>,
    pub tool_definitions: Vec<ToolDefinitionDto>,
    pub security_policy: Arc<Mutex<SecurityPolicy>>,
    pub pending_approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    /// App data dir used for skills discovery; `None` skips skill injection.
    pub app_data_dir: Option<PathBuf>,
    pub mcp: McpBackend,
    pub stream: StreamBackend,
    pub compression: CompressionBackend<'a>,
    /// This run's session handle (injections live here, scoped by request_id).
    pub session: SharedAgentSession,
}
