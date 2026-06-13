/**
 * @file dto/proposal.rs
 * @description Proposal DTOs for parallel fork review (v1.5.0)
 */

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProposalStatus {
    Pending,
    Approved,
    Rejected,
    Executed,
}

impl ProposalStatus {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            ProposalStatus::Pending => "PENDING",
            ProposalStatus::Approved => "APPROVED",
            ProposalStatus::Rejected => "REJECTED",
            ProposalStatus::Executed => "EXECUTED",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "PENDING" => Some(ProposalStatus::Pending),
            "APPROVED" => Some(ProposalStatus::Approved),
            "REJECTED" => Some(ProposalStatus::Rejected),
            "EXECUTED" => Some(ProposalStatus::Executed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalBranchDto {
    pub branch_name: String,
    pub initial_message: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDto {
    pub id: String,
    pub conversation_id: String,
    pub fork_point_message_id: String,
    pub proposal_type: String,
    pub status: ProposalStatus,
    pub branches: Vec<ProposalBranchDto>,
    pub created_at: i64,
    pub executed_at: Option<i64>,
}
