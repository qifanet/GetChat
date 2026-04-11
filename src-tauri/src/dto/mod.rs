/**
 * @file dto/mod.rs
 * @description DTO module registry.
 *
 * Each command/service imports DTOs from the concrete submodule it needs
 * (`dto::messages`, `dto::branches`, etc.) so module boundaries remain
 * explicit and unused umbrella re-exports do not accumulate warning noise.
 */

pub mod common;
pub mod conversations;
pub mod debug;
pub mod branches;
pub mod messages;
pub mod settings;
pub mod streaming;
