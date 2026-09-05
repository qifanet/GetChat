/**
 * @file agent/tools/builtin/load_skill.rs
 * @description `load_skill` tool (Tier 2 — on-demand SKILL.md loading).
 * Verbatim relocation from services/tool_executor.rs (M2.1).
 */

use serde_json::{json, Value};

use crate::agent::tools::executor::{BuiltinToolExecutor, ToolExecutionContext, ToolExecutionResult};
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta, ToolRisk};
use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

/** Register the load_skill tool (Tier 2 — on-demand SKILL.md loading). */
pub(crate) fn register(executor: &mut BuiltinToolExecutor) {
    let definition = ToolDefinitionDto {
        tool_type: "function".to_string(),
        function: ToolFunctionDefDto {
            name: "load_skill".to_string(),
            description: "Load the full content of a skill by name. Returns the skill's SKILL.md instructions that should be followed for the current task. Call this tool when the user's task matches one of the available skills listed in the system prompt.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The skill name (from the [Available Skills] list in the system prompt)"
                    }
                },
                "required": ["name"]
            }),
        },
    };

    const META: ToolMeta = ToolMeta {
        risk: ToolRisk::Low,
        concurrency: ToolConcurrency::Safe,
        max_output_chars: 50_000,
        timeout_secs: 5,
    };

    executor.register(definition, META, |args, context| load_skill_handler(args, context));
}

fn load_skill_handler(args: Value, context: ToolExecutionContext) -> ToolExecutionResult {
    let name = match args.get("name").and_then(Value::as_str) {
        Some(n) => n.trim().to_string(),
        None => {
            return ToolExecutionResult {
                success: false,
                output: "Missing required parameter: name".to_string(),
            };
        }
    };

    if name.is_empty() {
        return ToolExecutionResult {
            success: false,
            output: "Skill name cannot be empty".to_string(),
        };
    }

    let skills_dir = match context.skills_dir.as_deref() {
        Some(d) => std::path::Path::new(d),
        None => {
            return ToolExecutionResult {
                success: false,
                output: "Skills directory is not configured for this session".to_string(),
            };
        }
    };

    match crate::services::skill_fs::find_skill_by_name(skills_dir, &name) {
        Ok(skill) => {
            let output = format!(
                "<skill_content name=\"{}\" display_name=\"{}\">\n{}\n</skill_content>",
                skill.name, skill.display_name, skill.content
            );
            ToolExecutionResult {
                success: true,
                output,
            }
        }
        Err(e) => ToolExecutionResult {
            success: false,
            output: format!("Failed to load skill '{name}': {e}"),
        },
    }
}
