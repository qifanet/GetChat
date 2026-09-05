/**
 * @file agent/policy.rs
 * @description Approval policy (M2.3) — verbatim relocation of the approval
 * decision core from agent/runner.rs, with the per-tool/per-level decision
 * matrix expressed as a declarative rule table (`APPROVAL_RULES`).
 *
 * Semantics are preserved bit-for-bit from v1.4/1.5-M1:
 *   - MCP tools (`mcp__` prefix) always require approval;
 *   - `file` writes: Permissive approves unless the path blacklist matches,
 *     Standard/Strict always approve;
 *   - `terminal`: Permissive/Standard approve on blacklist match, Strict
 *     always approves;
 *   - argument parse failures fail safe (approval required);
 *   - everything else runs without approval.
 */

use serde_json::Value;
use tauri::ipc::Channel;

use crate::agent::deps::ReactLoopDeps;
use crate::dto::streaming::ModelStreamEventDto;
use crate::state::{SecurityLevel, SecurityPolicy};

/** Decision kind for one (tool, security level) cell of the rule table. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleKind {
    /** Always require approval at this level. */
    Always,
    /** Require approval only when the tool's blacklist matches. */
    Blacklist,
}

/**
 * Approval rules per resolved tool name: `(tool, action-filter, [Permissive,
 * Standard, Strict])`. The action filter selects the rule by the tool's
 * `action` argument (empty string = any action). First matching row wins.
 */
const APPROVAL_RULES: &[(&str, &str, [RuleKind; 3])] = &[
    // File writes are destructive; reads/list/search never need approval.
    ("file", "write", [RuleKind::Blacklist, RuleKind::Always, RuleKind::Always]),
    // Any terminal command can mutate the system; Strict requires approval.
    ("terminal", "", [RuleKind::Blacklist, RuleKind::Blacklist, RuleKind::Always]),
];

pub(crate) fn requires_tool_approval(
    function_name: &str,
    arguments: &str,
    policy: &SecurityPolicy,
) -> bool {
    // MCP tools always require approval
    if function_name.starts_with("mcp__") {
        return true;
    }

    // Resolve legacy tool names so approval checks work for old names too
    let resolved_name = resolve_legacy_tool_name(function_name);

    let args: Option<Value> = serde_json::from_str(arguments).ok();

    let level_index = match policy.level {
        SecurityLevel::Permissive => 0,
        SecurityLevel::Standard => 1,
        SecurityLevel::Strict => 2,
    };

    for (tool, rule_action, kinds) in APPROVAL_RULES {
        if *tool != resolved_name {
            continue;
        }
        // Fail-safe: require approval on parse failure (checked before the
        // action filter, matching the original matcher's order)
        let Some(args) = args.as_ref() else {
            return true;
        };
        let action = args.get("action").and_then(|a| a.as_str()).unwrap_or("");
        if !rule_action.is_empty() && *rule_action != action {
            continue;
        }
        return match kinds[level_index] {
            RuleKind::Always => true,
            RuleKind::Blacklist => matches_blacklist(
                blacklist_input(*tool, args),
                blacklist_for(*tool, policy),
            ),
        };
    }

    false
}

/** The text the blacklist is matched against for a given tool call. */
fn blacklist_input<'a>(tool: &str, args: &'a Value) -> &'a str {
    match tool {
        "file" => args.get("path").and_then(|p| p.as_str()).unwrap_or(""),
        "terminal" => args.get("command").and_then(|c| c.as_str()).unwrap_or(""),
        _ => "",
    }
}

/** The configured blacklist for a given tool. */
fn blacklist_for<'a>(tool: &str, policy: &'a SecurityPolicy) -> &'a [String] {
    match tool {
        "file" => &policy.file_write_blacklist,
        "terminal" => &policy.terminal_blacklist,
        _ => &[],
    }
}

fn matches_blacklist(text: &str, patterns: &[String]) -> bool {
    for pattern in patterns {
        match regex::Regex::new(pattern) {
            Ok(re) => {
                if re.is_match(text) {
                    return true;
                }
            }
            Err(err) => {
                // Fail-closed: invalid regex pattern treated as match for safety
                tracing::warn!(
                    pattern = %pattern,
                    error = %err,
                    "invalid regex in blacklist, treating as match for safety"
                );
                return true;
            }
        }
    }
    false
}

/** Resolve legacy tool names to their current unified equivalents. */
pub(crate) fn resolve_legacy_tool_name(tool_name: &str) -> String {
    match tool_name {
        "file_read" | "file_write" | "file_list" | "grep" => "file".to_string(),
        "todo_read" | "todo_write" => "todo".to_string(),
        _ => tool_name.to_string(),
    }
}

/**
 * Build a human-readable description of a tool action for the approval dialog.
 */
pub(crate) fn build_approval_description(function_name: &str, arguments: &str) -> String {
    let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
    match function_name {
        "rm" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("unknown");
            let recursive = args.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
            if recursive {
                format!("Delete directory '{}' and all its contents recursively", path)
            } else {
                format!("Delete file '{}'", path)
            }
        }
        "file_write" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("unknown");
            format!("Write/overwrite file '{}'", path)
        }
        _ => format!("Execute destructive tool: {}", function_name),
    }
}

// ============================================================================
// Approval round-trip (M2.5) — verbatim relocation of the runner's inline
// approval-wait block: pending registration, frontend event, timed wait.
// ============================================================================

/** How an approval request resolved. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApprovalOutcome {
    /** The user explicitly approved the operation. */
    Approved,
    /** The user rejected, or the approval channel closed without a response. */
    Rejected,
    /** The backend-side timeout elapsed without any user response. */
    TimedOut,
}

/**
 * Request user approval for a tool call and block until it resolves.
 *
 * Registers a oneshot sender in `pending_approvals`, emits `ApprovalRequired`
 * to the frontend, and waits with a backend-side timeout. The pending entry is
 * always removed before returning.
 */
pub(crate) async fn request_user_approval(
    deps: &ReactLoopDeps<'_>,
    channel: &Channel<ModelStreamEventDto>,
    request_id: &str,
    tool_call_id: &str,
    function_name: &str,
    arguments: &str,
    approval_timeout_secs: u32,
) -> ApprovalOutcome {
    // Request user approval via oneshot channel
    let approval_id = format!("{}_{}", request_id, tool_call_id);
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

    // Register the pending approval
    {
        let mut pending = deps.pending_approvals.lock().await;
        pending.insert(approval_id.clone(), tx);
    }

    // Build description from arguments
    let description = build_approval_description(function_name, arguments);

    // Emit APPROVAL_REQUIRED event to frontend
    let _ = channel.send(ModelStreamEventDto::ApprovalRequired {
        request_id: request_id.to_string(),
        approval_id: approval_id.clone(),
        function_name: function_name.to_string(),
        description,
        timeout_secs: approval_timeout_secs,
    });

    tracing::info!(
        request_id = %request_id,
        approval_id = %approval_id,
        tool = %function_name,
        "react loop: waiting for user approval"
    );

    // Wait for user response with backend-side timeout
    let outcome = match tokio::time::timeout(
        std::time::Duration::from_secs(approval_timeout_secs as u64),
        rx,
    ).await {
        Ok(Ok(approved)) => {
            tracing::info!(
                approval_id = %approval_id,
                approved,
                "react loop: approval received, resuming"
            );
            if approved {
                ApprovalOutcome::Approved
            } else {
                ApprovalOutcome::Rejected
            }
        }
        Ok(Err(_)) => {
            tracing::warn!(
                approval_id = %approval_id,
                "approval channel closed, treating as rejected"
            );
            ApprovalOutcome::Rejected
        }
        Err(_) => {
            tracing::warn!(
                approval_id = %approval_id,
                timeout_secs = approval_timeout_secs,
                "approval timed out (backend)"
            );
            ApprovalOutcome::TimedOut
        }
    };

    // Clean up the pending approval entry
    {
        let mut pending = deps.pending_approvals.lock().await;
        pending.remove(&approval_id);
    }

    outcome
}

// ============================================================================
// Approval matrix unit tests (M2 gate: 审批矩阵 5 用例)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(level: SecurityLevel) -> SecurityPolicy {
        SecurityPolicy {
            level,
            ..SecurityPolicy::default()
        }
    }

    #[test]
    fn mcp_tools_always_require_approval() {
        for level in [SecurityLevel::Permissive, SecurityLevel::Standard, SecurityLevel::Strict] {
            assert!(requires_tool_approval(
                "mcp__fs__read_file",
                "{}",
                &policy(level),
            ));
        }
    }

    #[test]
    fn file_write_standard_always_approves_read_never_does() {
        let p = policy(SecurityLevel::Standard);
        assert!(requires_tool_approval(
            "file",
            r#"{"action": "write", "path": "a.txt", "content": "x"}"#,
            &p,
        ));
        assert!(!requires_tool_approval(
            "file",
            r#"{"action": "read", "path": "a.txt"}"#,
            &p,
        ));
    }

    #[test]
    fn file_write_permissive_honors_blacklist() {
        let mut p = policy(SecurityLevel::Permissive);
        p.file_write_blacklist = vec![r"(?i)secret".to_string()];
        assert!(requires_tool_approval(
            "file",
            r#"{"action": "write", "path": "secrets/key.txt", "content": "x"}"#,
            &p,
        ));
        assert!(!requires_tool_approval(
            "file",
            r#"{"action": "write", "path": "docs/readme.md", "content": "x"}"#,
            &p,
        ));
    }

    #[test]
    fn terminal_strict_always_approves_permissive_blacklist_only() {
        let strict = policy(SecurityLevel::Strict);
        assert!(requires_tool_approval(
            "terminal",
            r#"{"command": "echo hi"}"#,
            &strict,
        ));

        let mut permissive = policy(SecurityLevel::Permissive);
        permissive.terminal_blacklist = vec![r"(?i)^rm\s".to_string()];
        assert!(requires_tool_approval(
            "terminal",
            r#"{"command": "rm -rf /"}"#,
            &permissive,
        ));
        assert!(!requires_tool_approval(
            "terminal",
            r#"{"command": "echo hi"}"#,
            &permissive,
        ));
    }

    #[test]
    fn legacy_names_and_parse_failures_fail_safe() {
        // Legacy tool names resolve to the unified rules (same action rules)
        let standard = policy(SecurityLevel::Standard);
        assert!(requires_tool_approval(
            "file_write",
            r#"{"action": "write", "path": "a.txt", "content": "x"}"#,
            &standard,
        ));
        // Without an explicit action the write-rule cannot match (unchanged
        // from the pre-refactor matcher): no approval required.
        assert!(!requires_tool_approval(
            "file_write",
            r#"{"path": "a.txt", "content": "x"}"#,
            &standard,
        ));

        // Unparseable arguments require approval (fail-safe)
        let permissive = policy(SecurityLevel::Permissive);
        assert!(requires_tool_approval("file", "not-json", &permissive));

        // Unknown tools never require approval
        assert!(!requires_tool_approval("calculator", "{}", &permissive));
    }
}
