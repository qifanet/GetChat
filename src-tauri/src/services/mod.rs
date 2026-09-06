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
pub mod importance_scorer;
pub mod import_service;
pub mod invariant_service;
pub mod mcp_client;
pub mod mcp_config_file;
pub mod model_stream_service;
pub mod message_repair_service;
pub mod provider_profiles;
pub mod prompt_service;
pub mod snapshot_service;
pub mod skill_fs;
pub mod system_prompt_service;
pub mod token_estimator;
