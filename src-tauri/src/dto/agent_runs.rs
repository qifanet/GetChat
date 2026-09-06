/**
 * @file dto/agent_runs.rs
 * @description Agent run audit DTOs (v1.5.0 M5.1).
 *
 * `turns` and `approvals` are carried as pre-built JSON documents (exactly
 * what the auditor persisted) so the frontend can render and export the
 * trail without a second schema to keep in sync.
 */

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::repositories::agent_runs::AgentRunRow;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunDto {
    pub id: String,
    pub conversation_id: String,
    pub branch_id: Option<String>,
    pub model_id: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub turns: Value,
    pub approvals: Value,
    pub outcome: Option<String>,
    pub outcome_detail: Option<String>,
}

impl AgentRunDto {
    pub fn from_row(row: AgentRunRow) -> Self {
        let parse = |raw: &str| -> Value {
            serde_json::from_str(raw).unwrap_or_else(|_| Value::Array(vec![]))
        };
        Self {
            id: row.id,
            conversation_id: row.conversation_id,
            branch_id: row.branch_id,
            model_id: row.model_id,
            started_at: row.started_at,
            finished_at: row.finished_at,
            turns: parse(&row.turns_json),
            approvals: parse(&row.approvals_json),
            outcome: row.outcome,
            outcome_detail: row.outcome_detail,
        }
    }
}
