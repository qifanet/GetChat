/**
 * @file agent/tools/registry.rs
 * @description Tool metadata registry (M2.1).
 *
 * Every tool — built-in or MCP — carries a `ToolMeta` describing its risk
 * class, concurrency class, output budget, and execution timeout. The policy
 * layer (M2.3) consumes `risk` for approval decisions and the parallel
 * executor (M2.4) consumes `concurrency` for scheduling.
 */

/** How destructive a tool can be; drives the approval policy. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolRisk {
    /** Pure computation, no side effects outside the app. */
    Low,
    /** Mutates state inside the workspace sandbox (file writes). */
    Medium,
    /** Runs arbitrary commands or external code (terminal, MCP). */
    High,
}

/** Whether a tool can run alongside others in the same ReAct round. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolConcurrency {
    /** Safe to run concurrently with other Safe tools (pure reads/compute). */
    Safe,
    /** Touches shared state; run alone but no OS-level interference. */
    Isolated,
    /** Mutates the workspace/OS; must run strictly alone. */
    Exclusive,
}

/** Static execution metadata attached to every registered tool. */
#[derive(Debug, Clone, Copy)]
pub(crate) struct ToolMeta {
    /** Consumed by the approval policy (M2.3). */
    #[allow(dead_code)]
    pub risk: ToolRisk,
    pub concurrency: ToolConcurrency,
    /** Consumed by the result-normalization path (M2.4). */
    #[allow(dead_code)]
    pub max_output_chars: usize,
    /** Consumed by the parallel executor's per-tool deadline (M2.4). */
    #[allow(dead_code)]
    pub timeout_secs: u64,
}
