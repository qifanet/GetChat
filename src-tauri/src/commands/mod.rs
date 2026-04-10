/**
 * @file commands/mod.rs
 * @description Tauri command module — thin API boundary between frontend and backend.
 *
 * All commands follow the pattern:
 *   1. Receive input DTOs from the frontend
 *   2. Access shared state (db pool, key store)
 *   3. Delegate to service or repository layer
 *   4. Return output DTOs or AppError
 *
 * Commands do NOT contain: SQL, domain validation, state calculations.
 */

pub mod bootstrap;
pub mod branches;
pub mod conversations;
pub mod debug;
pub mod messages;
pub mod settings;
pub mod streaming;
