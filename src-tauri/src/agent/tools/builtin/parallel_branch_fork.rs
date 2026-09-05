/**
 * @file agent/tools/builtin/parallel_branch_fork.rs
 * @description `parallel_branch_fork` tool (v1.5.0) — creates a fork proposal
 * for user review. Verbatim relocation from services/tool_executor.rs (M2.1).
 */

use serde_json::{json, Value};

use crate::agent::tools::executor::{BuiltinToolExecutor, ToolExecutionContext, ToolExecutionResult};
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta, ToolRisk};
use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

pub(crate) fn register(executor: &mut BuiltinToolExecutor) {
    let definition = ToolDefinitionDto {
        tool_type: "function".to_string(),
        function: ToolFunctionDefDto {
            name: "parallel_branch_fork".to_string(),
            description: "Propose multiple parallel conversation branches for exploration. Creates a fork proposal that the user can review, edit, and launch. After calling this tool, output a brief confirmation message and wait for user to review the proposal. Do NOT summarize or conclude.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "fork_point_message_id": {
                        "type": "string",
                        "description": "The message ID to fork from (use 'current' for latest message)"
                    },
                    "branches": {
                        "type": "array",
                        "description": "Array of branch proposals (2-5 branches)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "branch_name": {
                                    "type": "string",
                                    "description": "Short name for this branch (e.g., 'Context API', 'Zustand')"
                                },
                                "initial_message": {
                                    "type": "string",
                                    "description": "The initial user message for this branch exploration"
                                }
                            },
                            "required": ["branch_name", "initial_message"]
                        },
                        "minItems": 2,
                        "maxItems": 5
                    }
                },
                "required": ["fork_point_message_id", "branches"]
            }),
        },
    };

    const META: ToolMeta = ToolMeta {
        risk: ToolRisk::Low,
        concurrency: ToolConcurrency::Safe,
        max_output_chars: 20_000,
        timeout_secs: 15,
    };

    executor.register_async(definition, META, |args, ctx| {
        Box::pin(async move {
            parallel_branch_fork_handler(args, ctx).await
        })
    });
}

async fn parallel_branch_fork_handler(
    args: Value,
    ctx: ToolExecutionContext,
) -> ToolExecutionResult {
    use crate::dto::proposal::ProposalBranchDto;
    use crate::repositories::proposal::ProposalRepository;

    let Some(pool) = ctx.db_pool else {
        return ToolExecutionResult {
            success: false,
            output: "Database pool not available in context".to_string(),
        };
    };

    let Some(conversation_id) = ctx.conversation_id else {
        return ToolExecutionResult {
            success: false,
            output: "Conversation ID not available in context".to_string(),
        };
    };

    // Get fork_point_message_id - if not provided, use a placeholder
    // The frontend will determine the actual fork point when executing
    let fork_point = args.get("fork_point_message_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "PLACEHOLDER".to_string());

    let branches_array = match args.get("branches").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => {
            return ToolExecutionResult {
                success: false,
                output: "Missing or invalid 'branches' parameter".to_string(),
            };
        }
    };

    let mut branches = Vec::new();
    for branch_val in branches_array {
        let branch_name = branch_val.get("branch_name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unnamed Branch")
            .to_string();

        let initial_message = match branch_val.get("initial_message").and_then(|v| v.as_str()) {
            Some(msg) => msg.to_string(),
            None => {
                return ToolExecutionResult {
                    success: false,
                    output: "Missing 'initial_message' in branch".to_string(),
                };
            }
        };

        branches.push(ProposalBranchDto {
            branch_name,
            initial_message,
            model_id: "".to_string(), // User will choose during review
        });
    }

    if branches.is_empty() {
        return ToolExecutionResult {
            success: false,
            output: "At least one branch is required".to_string(),
        };
    }

    // Generate proposal ID
    let proposal_id = format!("proposal_{}", uuid::Uuid::new_v4().simple());

    // Serialize branches
    let branches_json = match serde_json::to_string(&branches) {
        Ok(json) => json,
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Failed to serialize branches: {}", e),
            };
        }
    };

    // Save proposal to database
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    match ProposalRepository::create(
        &pool,
        &proposal_id,
        &conversation_id,
        &fork_point,
        &branches_json,
        now,
    ).await {
        Ok(_) => {
            tracing::info!(
                proposal_id = %proposal_id,
                branches_count = branches.len(),
                "Parallel fork proposal created"
            );

            ToolExecutionResult {
                success: true,
                output: serde_json::json!({
                    "fork_proposal_id": proposal_id,
                    "status": "PENDING_USER_REVIEW",
                    "branches_proposed": branches.len(),
                    "fork_point_message_id": fork_point,
                    "branches": branches,
                }).to_string(),
            }
        }
        Err(e) => {
            tracing::error!(
                error = %e,
                "Failed to create parallel fork proposal"
            );
            ToolExecutionResult {
                success: false,
                output: format!("Failed to save proposal: {}", e),
            }
        }
    }
}
