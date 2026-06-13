/**
 * @file repositories/proposal.rs
 * @description Proposal repository for parallel fork review (v1.5.0)
 */

use sqlx::{Row, SqlitePool};
use crate::dto::proposal::{ProposalDto, ProposalBranchDto, ProposalStatus};
use crate::error::AppError;

pub struct ProposalRepository;

impl ProposalRepository {
    pub async fn create(
        pool: &SqlitePool,
        id: &str,
        conversation_id: &str,
        fork_point_message_id: &str,
        branches_json: &str,
        created_at: i64,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO proposals (id, conversation_id, fork_point_message_id, proposal_type, status, branches_json, created_at)
             VALUES (?, ?, ?, 'PARALLEL_FORK', 'PENDING', ?, ?)"
        )
        .bind(id)
        .bind(conversation_id)
        .bind(fork_point_message_id)
        .bind(branches_json)
        .bind(created_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> Result<Option<ProposalDto>, AppError> {
        let row = sqlx::query(
            "SELECT id, conversation_id, fork_point_message_id, proposal_type, status, branches_json, created_at, executed_at
             FROM proposals WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        if let Some(row) = row {
            let status_str: String = row.get("status");
            let status = ProposalStatus::from_str(&status_str)
                .ok_or_else(|| AppError::invariant_violation(format!("Invalid status: {}", status_str)))?;

            let branches_json: String = row.get("branches_json");
            let branches: Vec<ProposalBranchDto> = serde_json::from_str(&branches_json)
                .map_err(|e| AppError::invariant_violation(format!("Invalid branches_json: {}", e)))?;

            Ok(Some(ProposalDto {
                id: row.get("id"),
                conversation_id: row.get("conversation_id"),
                fork_point_message_id: row.get("fork_point_message_id"),
                proposal_type: row.get("proposal_type"),
                status,
                branches,
                created_at: row.get("created_at"),
                executed_at: row.get("executed_at"),
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn update_status(
        pool: &SqlitePool,
        id: &str,
        status: &str,
        executed_at: Option<i64>,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE proposals SET status = ?, executed_at = ? WHERE id = ?"
        )
        .bind(status)
        .bind(executed_at)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_by_conversation(
        pool: &SqlitePool,
        conversation_id: &str,
    ) -> Result<Vec<ProposalDto>, AppError> {
        let rows = sqlx::query(
            "SELECT id, conversation_id, fork_point_message_id, proposal_type, status, branches_json, created_at, executed_at
             FROM proposals
             WHERE conversation_id = ?
             ORDER BY created_at DESC"
        )
        .bind(conversation_id)
        .fetch_all(pool)
        .await?;

        let mut proposals = Vec::new();
        for row in rows {
            let status_str: String = row.get("status");
            let status = ProposalStatus::from_str(&status_str)
                .ok_or_else(|| AppError::invariant_violation(format!("Invalid status: {}", status_str)))?;

            let branches_json: String = row.get("branches_json");
            let branches: Vec<ProposalBranchDto> = serde_json::from_str(&branches_json)
                .map_err(|e| AppError::invariant_violation(format!("Invalid branches_json: {}", e)))?;

            proposals.push(ProposalDto {
                id: row.get("id"),
                conversation_id: row.get("conversation_id"),
                fork_point_message_id: row.get("fork_point_message_id"),
                proposal_type: row.get("proposal_type"),
                status,
                branches,
                created_at: row.get("created_at"),
                executed_at: row.get("executed_at"),
            });
        }

        Ok(proposals)
    }
}
