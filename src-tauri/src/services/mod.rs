/**
 * @file services/mod.rs
 * @description Service layer — domain logic, validation, and transaction orchestration.
 *
 * Services call repositories and handle:
 *   - Domain rule enforcement (e.g., editedFromMessageId must be USER)
 *   - Cross-table operations within transactions
 *   - DB row → DTO mapping (including timestamp conversion)
 *   - Runtime index construction (childIds, branchIdsByForkPointId)
 */

pub mod helper_ai_service;
pub mod invariant_service;
pub mod model_stream_service;
pub mod message_repair_service;
pub mod prompt_service;
pub mod snapshot_service;
