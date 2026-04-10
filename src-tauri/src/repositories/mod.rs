/**
 * @file repositories/mod.rs
 * @description Repository layer — SQL access only, no domain logic.
 *
 * Conventions:
 *   - Functions take generic `E: sqlx::Executor` to work with both
 *     SqlitePool (reads) and Transaction (transactional writes)
 *   - Return internal Row types with sqlx::FromRow derives
 *   - Enum values are stored/retrieved as String (SCREAMING_SNAKE_CASE)
 *     and converted to typed enums in the service layer
 *   - Timestamps from DB are in seconds (i64); service layer converts to ms
 */

pub mod app_kv;
pub mod branches;
pub mod conversations;
pub mod messages;
pub mod provider_models;
pub mod providers;
