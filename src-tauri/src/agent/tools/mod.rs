/**
 * @file agent/tools/mod.rs
 * @description Tool subsystem (M2.1): registry metadata, the execution
 * framework, and the built-in tool modules.
 *
 * Verbatim relocation of services/tool_executor.rs; that file is deleted by
 * this milestone and all import sites now point here.
 */

pub(crate) mod builtin;
pub(crate) mod registry;

pub mod executor;

pub use executor::{
    BuiltinToolExecutor, ToolExecutionContext, ToolExecutionResult, ToolExecutor, ToolStateDto,
};
pub(crate) use executor::lookup_tool_meta;
pub(crate) use registry::ToolConcurrency;
pub use builtin::todo::read_todos_for_conversation;
