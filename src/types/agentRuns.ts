/**
 * @file agentRuns.ts
 * @description Agent run audit trail types (v1.5.0 M5.1), mirroring the Rust
 * `AgentRunDto` (camelCase serde). One run = one ReAct loop execution; turns
 * and approvals arrive as the exact JSON documents the auditor persisted.
 */

/** One tool call observed inside a turn, with its execution timing. */
export interface AgentRunToolCall {
  name: string;
  success: boolean;
  durationMs: number;
}

/** One ReAct turn: token usage, wall time, and the tool calls it made. */
export interface AgentRunTurn {
  turn: number;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
  toolCalls: AgentRunToolCall[];
}

/** One approval decision inside a run. */
export interface AgentRunApproval {
  turn: number;
  callId: string;
  functionName: string;
  /** "APPROVED" | "REJECTED" | "TIMED_OUT" */
  decision: string;
}

/** Audit trail of a single agent run. */
export interface AgentRunDto {
  id: string;
  conversationId: string;
  branchId: string | null;
  modelId: string | null;
  /** Unix seconds. */
  startedAt: number;
  /** Unix seconds; null while the run is still active. */
  finishedAt: number | null;
  turns: AgentRunTurn[];
  approvals: AgentRunApproval[];
  /** "COMPLETED" | "CANCELLED" | "FAILED"; null while still active. */
  outcome: string | null;
  outcomeDetail: string | null;
}

/** Defensive parse: turns/approvals are JSON documents from the audit table. */
export function asAgentRunTurns(value: unknown): AgentRunTurn[] {
  return Array.isArray(value) ? (value as AgentRunTurn[]) : [];
}

export function asAgentRunApprovals(value: unknown): AgentRunApproval[] {
  return Array.isArray(value) ? (value as AgentRunApproval[]) : [];
}
