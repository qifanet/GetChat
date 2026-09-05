/**
 * @file agent/prompt.rs
 * @description Prompt assembly for the agent loop (v1.5.0 M1.4).
 *
 * `inject_prompt_context` is a verbatim relocation of the guidance injection
 * that used to live inline in `run_react_loop`: tool usage guidance, skill
 * Tier-1 metadata, and the Tier-3 slash activation hint are appended to the
 * leading SYSTEM message (or prepended as a new SYSTEM message when absent).
 *
 * Behavior is intentionally identical to the pre-move implementation — the
 * golden replay cases in `agent/eval/cases.rs` assert on the composed system
 * prompt. M3 replaces the ad-hoc string sections with the structured
 * Core/Extension/Gates PromptBuilder (ARCHITECTURE.md §4.5).
 */

use crate::dto::common::ToolDefinitionDto;
use crate::dto::streaming::ModelPromptMessageDto;

/** Append guidance text to the first SYSTEM message (or prepend one). */
fn append_to_system(prompt_messages: &mut Vec<ModelPromptMessageDto>, text: &str) {
    if let Some(first) = prompt_messages.first_mut() {
        if first.role == "system" || first.role == "SYSTEM" {
            first.content.push_str("\n\n");
            first.content.push_str(text);
            return;
        }
    }
    prompt_messages.insert(
        0,
        ModelPromptMessageDto {
            source_message_id: None,
            role: "system".to_string(),
            content: text.to_string(),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
        },
    );
}

/**
 * Append to the first SYSTEM message only; silently do nothing when there is
 * no leading SYSTEM message. This mirrors the original Tier-3 activation
 * hint behavior exactly (it never prepended a new system message).
 */
fn append_to_system_if_present(prompt_messages: &mut Vec<ModelPromptMessageDto>, text: &str) {
    if let Some(first) = prompt_messages.first_mut() {
        if first.role == "system" || first.role == "SYSTEM" {
            first.content.push_str("\n\n");
            first.content.push_str(text);
        }
    }
}

/**
 * Compose tool guidance, skill metadata, and the skill activation hint into
 * the prompt. Called once per run, before the first model call.
 */
pub(crate) fn inject_prompt_context(
    prompt_messages: &mut Vec<ModelPromptMessageDto>,
    tools: &[ToolDefinitionDto],
    workspace_path: Option<&str>,
    app_data_dir: Option<&std::path::Path>,
    activated_skill: Option<&str>,
) {
    if tools.is_empty() {
        return;
    }

    let tool_names: Vec<&str> = tools.iter().map(|t| t.function.name.as_str()).collect();
    let mut guidance_parts: Vec<String> = Vec::new();

    guidance_parts.push("You have access to tools. Use them proactively when they can help answer the user's request more accurately or efficiently.".to_string());

    if tool_names.contains(&"todo") {
        guidance_parts.push("When the user's request involves multiple steps or a complex task, proactively use the todo tool (action=write) to create a todo list first, then work through each item and update statuses as you progress. This helps track progress and ensures nothing is missed.".to_string());
    }

    if tool_names.contains(&"file") {
        guidance_parts.push("When asked about files or code, use file tools to read actual file contents rather than guessing. Always verify information by reading the files first.".to_string());
    }

    if tool_names.contains(&"terminal") {
        let mut terminal_guidance = String::from(
            "IMPORTANT: This is a local desktop environment, NOT a container or sandbox. ",
        );
        if let Some(ws) = workspace_path {
            terminal_guidance.push_str(&format!(
                "The current working directory is '{}'. ",
                ws.replace('\\', "/"),
            ));
        }
        terminal_guidance.push_str(
            "Do NOT use /workspace as a path — that is a container convention and does not exist here. \
             Always verify a directory exists before cd-ing into it (e.g., use 'ls DIR && cd DIR' or check with 'if exist DIR' on Windows). \
             If a cd command fails, list available directories first before trying another path.",
        );
        guidance_parts.push(terminal_guidance);
    }

    if !guidance_parts.is_empty() {
        let guidance = guidance_parts.join(" ");
        append_to_system(prompt_messages, &guidance);
    }

    // Inject skill metadata (Tier 1) and activation hint (Tier 3).
    let Some(app_data) = app_data_dir else {
        return;
    };
    let skills_dir = crate::services::skill_fs::skills_root_from_app_data(app_data);
    let skills = crate::services::skill_fs::discover_skills(&skills_dir);

    if !skills.is_empty() {
        let skill_metadata = crate::services::skill_fs::build_skill_metadata_prompt(&skills);
        append_to_system(prompt_messages, &skill_metadata);
    }

    if let Some(skill_name) = activated_skill {
        let hint = crate::services::skill_fs::build_skill_activation_hint(skill_name);
        append_to_system_if_present(prompt_messages, &hint);
    }
}
