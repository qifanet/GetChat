/**
 * @file agent/prompt.rs
 * @description Prompt assembly for the agent loop (v1.5.0 M1.4, sectioned in
 * M3.2 per ARCHITECTURE.md §4.5).
 *
 * The guidance that used to live inline in `run_react_loop` (and was
 * relocated here verbatim in M1.4) is now composed as ordered sections:
 *
 *   Core      — ① the app system prompt (already in place) and ② an
 *               environment snapshot (platform, workspace), injected every
 *               run with stable wording for prompt-cache friendliness;
 *   Extension — ④ tool-usage guidance, ⑤ skill Tier-1 metadata, ⑥ the
 *               Tier-3 slash-activation hint;
 *   Gates     — ⑦/⑧ write/final-answer gates (later milestones; the section
 *               renders nothing while empty).
 *
 * The rendered block is appended to the leading SYSTEM message (or prepended
 * as a new SYSTEM message when absent) exactly as before, so the golden
 * replay cases in `agent/eval/cases.rs` keep passing on `contains` checks.
 */

use crate::dto::common::ToolDefinitionDto;
use crate::dto::streaming::ModelPromptMessageDto;

/**
 * Ordered prompt sections (Core → Extension → Gates). Section order — and
 * the wording inside each entry — is stable so the composed system prompt
 * stays a byte-stable prefix across iterations and compressions.
 */
pub(crate) struct PromptSections {
    /** ① app system prompt prefix (already in place, not rebuilt here) + ② environment snapshot. */
    core: Vec<String>,
    /** ④ tool guidance, ⑤ skill Tier-1 metadata, ⑥ Tier-3 activation hint. */
    extension: Vec<String>,
    /** ⑦ memory-write gate, ⑧ final-answer review gate (empty until later milestones). */
    gates: Vec<String>,
}

impl PromptSections {
    /** Compose the sections for one run. Called once, before the first call. */
    pub(crate) fn build(
        tools: &[ToolDefinitionDto],
        workspace_path: Option<&str>,
        app_data_dir: Option<&std::path::Path>,
        activated_skill: Option<&str>,
    ) -> PromptSections {
        let mut core = Vec::new();
        let mut extension = Vec::new();

        core.push(environment_snapshot(workspace_path));

        if !tools.is_empty() {
            let tool_names: Vec<&str> = tools.iter().map(|t| t.function.name.as_str()).collect();

            extension.push("You have access to tools. Use them proactively when they can help answer the user's request more accurately or efficiently.".to_string());

            if tool_names.contains(&"todo") {
                extension.push("When the user's request involves multiple steps or a complex task, proactively use the todo tool (action=write) to create a todo list first, then work through each item and update statuses as you progress. This helps track progress and ensures nothing is missed.".to_string());
            }

            if tool_names.contains(&"file") {
                extension.push("When asked about files or code, use file tools to read actual file contents rather than guessing. Always verify information by reading the files first.".to_string());
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
                extension.push(terminal_guidance);
            }
        }

        // Inject skill metadata (Tier 1) and activation hint (Tier 3).
        if let Some(app_data) = app_data_dir {
            let skills_dir = crate::services::skill_fs::skills_root_from_app_data(app_data);
            let skills = crate::services::skill_fs::discover_skills(&skills_dir);
            if !skills.is_empty() {
                extension.push(crate::services::skill_fs::build_skill_metadata_prompt(&skills));
            }
            if let Some(skill_name) = activated_skill {
                extension.push(crate::services::skill_fs::build_skill_activation_hint(skill_name));
            }
        }

        PromptSections {
            core,
            extension,
            gates: Vec::new(),
        }
    }

    /**
     * Render all sections into one block: Core first, then Extension, then
     * Gates, entries joined by a blank line. `None` when everything is empty
     * (nothing should be appended to the prompt).
     */
    pub(crate) fn render(&self) -> Option<String> {
        let mut parts: Vec<&str> = Vec::new();
        for section in [&self.core, &self.extension, &self.gates] {
            for part in section {
                if !part.trim().is_empty() {
                    parts.push(part.as_str());
                }
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n\n"))
        }
    }
}

/**
 * ② Environment snapshot (Core layer): platform and workspace, hardcoded
 * semantics — no model calls, no user configuration. Byte-stable for equal
 * inputs so the Core prefix survives compressions unchanged.
 */
fn environment_snapshot(workspace_path: Option<&str>) -> String {
    let workspace_part = match workspace_path {
        Some(ws) => format!("; workspace='{}'", ws.replace('\\', "/")),
        None => "; no workspace configured".to_string(),
    };
    format!(
        "Environment: platform={}{}.",
        std::env::consts::OS,
        workspace_part
    )
}

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
 * Compose the sectioned prompt block into the prompt. Called once per run,
 * before the first model call. With tools disabled the builder still emits
 * the Core environment snapshot (§4.5: Core is injected every run), so the
 * early return of the pre-M3.2 implementation is intentionally gone.
 */
pub(crate) fn inject_prompt_context(
    prompt_messages: &mut Vec<ModelPromptMessageDto>,
    tools: &[ToolDefinitionDto],
    workspace_path: Option<&str>,
    app_data_dir: Option<&std::path::Path>,
    activated_skill: Option<&str>,
) {
    let sections = PromptSections::build(tools, workspace_path, app_data_dir, activated_skill);
    if let Some(text) = sections.render() {
        append_to_system(prompt_messages, &text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str) -> ToolDefinitionDto {
        crate::dto::common::ToolDefinitionDto {
            tool_type: "function".to_string(),
            function: crate::dto::common::ToolFunctionDefDto {
                name: name.to_string(),
                description: format!("{name} test tool"),
                parameters: serde_json::json!({"type": "object", "properties": {}}),
            },
        }
    }

    /** Core 渲染先于 Extension，且环境快照在最前（前缀稳定性锚点）。 */
    #[test]
    fn render_orders_core_before_extension() {
        let tools = vec![tool("file")];
        let sections = PromptSections::build(
            &tools,
            Some("D:\\CodeProject\\GetChat"),
            None,
            None,
        );
        let rendered = sections.render().expect("sections must render");

        let env_pos = rendered.find("Environment: platform=").expect("env snapshot");
        let guidance_pos = rendered
            .find("You have access to tools")
            .expect("tool guidance");
        assert!(env_pos < guidance_pos, "Core must precede Extension");
    }

    /** 同输入两次构建字节一致（Core 分节字节不变）。 */
    #[test]
    fn render_is_byte_stable_for_equal_inputs() {
        let tools = vec![tool("calculator"), tool("terminal")];
        let a = PromptSections::build(&tools, Some("/tmp/ws"), None, None)
            .render()
            .unwrap();
        let b = PromptSections::build(&tools, Some("/tmp/ws"), None, None)
            .render()
            .unwrap();
        assert_eq!(a, b);
    }

    /** 环境快照：平台 + workspace 反斜杠归一；无 workspace 时语义仍在。 */
    #[test]
    fn environment_snapshot_formats_workspace_and_platform() {
        let with_ws = environment_snapshot(Some("D:\\CodeProject\\GetChat"));
        assert!(with_ws.starts_with("Environment: platform="));
        assert!(with_ws.contains("workspace='D:/CodeProject/GetChat'"), "{with_ws}");

        let without_ws = environment_snapshot(None);
        assert!(without_ws.contains("no workspace configured"), "{without_ws}");
    }

    /** 全空分节不渲染（不污染无上下文的 prompt）。 */
    #[test]
    fn render_returns_none_when_all_sections_empty() {
        let sections = PromptSections {
            core: Vec::new(),
            extension: Vec::new(),
            gates: Vec::new(),
        };
        assert!(sections.render().is_none());
    }

    /** Gates 分节渲染在最后（当前为空，为 M5/M6 门禁预留顺序）。 */
    #[test]
    fn gates_render_last_when_present() {
        let sections = PromptSections {
            core: vec!["CORE".to_string()],
            extension: vec!["EXT".to_string()],
            gates: vec!["GATE".to_string()],
        };
        let rendered = sections.render().unwrap();
        let core = rendered.find("CORE").unwrap();
        let ext = rendered.find("EXT").unwrap();
        let gate = rendered.find("GATE").unwrap();
        assert!(core < ext && ext < gate);
    }
}
