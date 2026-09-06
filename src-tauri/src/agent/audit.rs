/**
 * @file agent/audit.rs
 * @description Run-level audit seam for the ReAct loop (v1.5.0 M5.1, debt B6).
 *
 * The runner reports its lifecycle through [`RunAuditor`]; production wiring
 * (`commands/streaming.rs`, the M4 task scheduler) installs a
 * [`SqliteRunAuditor`] so every run leaves a durable trail in `agent_runs`:
 * turns with token usage and per-call tool timings, approval decisions, and
 * the terminal outcome. Golden tests run with `auditor: None` (or
 * [`MemoryAuditor`] when a case asserts on the trail itself).
 *
 * Audit writes are best-effort by contract: a failed audit log warns and
 * never disturbs the stream it observes.
 */

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::repositories::agent_runs as repo;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Identity of one run, captured by the runner before the first turn.
#[derive(Debug, Clone)]
pub(crate) struct RunAuditSeed {
    pub run_id: String,
    /// `ResolvedModelStreamRequest.conversation_id` is optional; the audit
    /// row persists it as-is (empty string when absent).
    pub conversation_id: Option<String>,
    pub branch_id: Option<String>,
    pub model_id: Option<String>,
}

/// One tool call inside a turn (timed by the runner).
#[derive(Debug, Clone)]
pub(crate) struct AuditedToolCall {
    pub name: String,
    pub success: bool,
    pub duration_ms: u64,
}

/// One loop iteration: tokens (when the provider reported usage), wall-clock
/// duration, and the tool calls executed in the iteration.
#[derive(Debug, Clone, Default)]
pub(crate) struct TurnAuditRecord {
    pub turn: u32,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub duration_ms: u64,
    pub tool_calls: Vec<AuditedToolCall>,
}

/// An approval decision the runner mediated for a tool call.
#[derive(Debug, Clone)]
pub(crate) struct ApprovalAuditRecord {
    pub turn: u32,
    pub call_id: String,
    pub function_name: String,
    /// "APPROVED" | "REJECTED" | "TIMED_OUT"
    pub decision: String,
}

/// Terminal outcome of an audited run.
#[derive(Debug, Clone)]
pub(crate) enum RunAuditOutcome {
    Completed,
    Cancelled,
    Failed(String),
}

impl RunAuditOutcome {
    fn code(&self) -> &'static str {
        match self {
            RunAuditOutcome::Completed => "COMPLETED",
            RunAuditOutcome::Cancelled => "CANCELLED",
            RunAuditOutcome::Failed(_) => "FAILED",
        }
    }

    fn detail(&self) -> Option<&str> {
        match self {
            RunAuditOutcome::Failed(detail) => Some(detail),
            _ => None,
        }
    }
}

impl TurnAuditRecord {
    fn to_json(&self) -> Value {
        json!({
            "turn": self.turn,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "durationMs": self.duration_ms,
            "toolCalls": self
                .tool_calls
                .iter()
                .map(|c| json!({
                    "name": c.name,
                    "success": c.success,
                    "durationMs": c.duration_ms,
                }))
                .collect::<Vec<_>>(),
        })
    }
}

impl ApprovalAuditRecord {
    fn to_json(&self) -> Value {
        json!({
            "turn": self.turn,
            "callId": self.call_id,
            "functionName": self.function_name,
            "decision": self.decision,
        })
    }
}

/** Audit sink observed by the runner. One instance serves one run. */
#[async_trait]
pub(crate) trait RunAuditor: Send + Sync {
    async fn run_started(&self, seed: &RunAuditSeed);
    async fn turn_recorded(&self, record: TurnAuditRecord);
    async fn approval_recorded(&self, record: ApprovalAuditRecord);
    async fn run_finished(&self, outcome: RunAuditOutcome);
}

/// Per-run accumulation shared by both auditor implementations.
#[derive(Default)]
struct AuditState {
    seed: Option<RunAuditSeed>,
    turns: Vec<TurnAuditRecord>,
    approvals: Vec<ApprovalAuditRecord>,
}

/// Production auditor: persists the trail to `agent_runs` incrementally.
/// The internal lock serializes snapshots so monotonic updates cannot
/// interleave (each run owns its auditor instance).
pub(crate) struct SqliteRunAuditor {
    db: sqlx::SqlitePool,
    state: Mutex<AuditState>,
}

impl SqliteRunAuditor {
    pub(crate) fn new(db: sqlx::SqlitePool) -> Self {
        Self {
            db,
            state: Mutex::new(AuditState::default()),
        }
    }
}

#[async_trait]
impl RunAuditor for SqliteRunAuditor {
    async fn run_started(&self, seed: &RunAuditSeed) {
        {
            let mut state = self.state.lock().await;
            state.seed = Some(seed.clone());
            state.turns.clear();
            state.approvals.clear();
        }
        if let Err(error) = repo::insert_started(
            &self.db,
            &seed.run_id,
            seed.conversation_id.as_deref().unwrap_or(""),
            seed.branch_id.as_deref(),
            seed.model_id.as_deref(),
            now_secs(),
        )
        .await
        {
            tracing::warn!(run_id = %seed.run_id, error = %error, "agent run audit: start persist failed");
        }
    }

    async fn turn_recorded(&self, record: TurnAuditRecord) {
        let (run_id, turns) = {
            let mut state = self.state.lock().await;
            let Some(seed) = state.seed.clone() else {
                return;
            };
            state.turns.push(record);
            let turns: Vec<Value> = state.turns.iter().map(|t| t.to_json()).collect();
            (seed.run_id, turns)
        };
        let json = Value::Array(turns).to_string();
        if let Err(error) = repo::update_turns(&self.db, &run_id, &json).await {
            tracing::warn!(run_id = %run_id, error = %error, "agent run audit: turn persist failed");
        }
    }

    async fn approval_recorded(&self, record: ApprovalAuditRecord) {
        let (run_id, approvals) = {
            let mut state = self.state.lock().await;
            let Some(seed) = state.seed.clone() else {
                return;
            };
            state.approvals.push(record);
            let approvals: Vec<Value> = state.approvals.iter().map(|a| a.to_json()).collect();
            (seed.run_id, approvals)
        };
        let json = Value::Array(approvals).to_string();
        if let Err(error) = repo::update_approvals(&self.db, &run_id, &json).await {
            tracing::warn!(run_id = %run_id, error = %error, "agent run audit: approval persist failed");
        }
    }

    async fn run_finished(&self, outcome: RunAuditOutcome) {
        let run_id = {
            let state = self.state.lock().await;
            state.seed.as_ref().map(|seed| seed.run_id.clone())
        };
        let Some(run_id) = run_id else {
            return;
        };
        if let Err(error) =
            repo::finish(&self.db, &run_id, outcome.code(), outcome.detail(), now_secs()).await
        {
            tracing::warn!(run_id = %run_id, error = %error, "agent run audit: finish persist failed");
        }
    }
}

/// In-memory collector for tests: same contract, no persistence.
/// (Grouped `#[cfg(test)]` blocks keep the trait impls out of release builds.)
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryAuditor {
    state: Mutex<AuditState>,
    finished: Mutex<Vec<RunAuditSnapshot>>,
}

/// Read-back snapshot for assertions.
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct RunAuditSnapshot {
    pub turns: Vec<TurnAuditRecord>,
    pub approvals: Vec<ApprovalAuditRecord>,
    pub outcome: Option<String>,
}

#[cfg(test)]
#[async_trait]
impl RunAuditor for MemoryAuditor {
    async fn run_started(&self, seed: &RunAuditSeed) {
        let mut state = self.state.lock().await;
        state.seed = Some(seed.clone());
        state.turns.clear();
        state.approvals.clear();
    }

    async fn turn_recorded(&self, record: TurnAuditRecord) {
        self.state.lock().await.turns.push(record);
    }

    async fn approval_recorded(&self, record: ApprovalAuditRecord) {
        self.state.lock().await.approvals.push(record);
    }

    async fn run_finished(&self, outcome: RunAuditOutcome) {
        let state = self.state.lock().await;
        let snapshot = RunAuditSnapshot {
            turns: state.turns.clone(),
            approvals: state.approvals.clone(),
            outcome: Some(outcome.code().to_string()),
        };
        drop(state);
        self.finished.lock().await.push(snapshot);
    }
}

#[cfg(test)]
impl MemoryAuditor {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Tests poll after the loop returns, so a plain clone is sufficient.
    pub(crate) async fn snapshots(&self) -> Vec<RunAuditSnapshot> {
        self.finished.lock().await.clone()
    }
}

/// Convenience alias used by `ReactLoopDeps`.
pub(crate) type SharedRunAuditor = Arc<dyn RunAuditor>;
