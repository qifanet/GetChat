/**
 * @file agent/eval/mod.rs
 * @description Golden harness for the ReAct loop (v1.5.0 M0).
 *
 * `mock_provider` implements the provider contract with scripted steps;
 * `cases` replays the real loop against it and asserts on recorded model
 * requests and emitted channel events. See DEVELOPMENT.md M0.
 */

pub(crate) mod mock_provider;
#[cfg(test)]
mod cases;
