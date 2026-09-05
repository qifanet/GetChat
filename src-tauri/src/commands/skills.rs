/**
 * @file commands/skills.rs
 * @description Skills & slash-command commands (v1.5.0 M1.5).
 *
 * Verbatim relocation from `commands/streaming.rs`: filesystem skill
 * discovery, MCP prompt execution, and the skills directory query that back
 * the composer's slash-command palette.
 */

use tauri::{Manager, State};

use crate::error::AppError;
use crate::state::AppState;

// ============================================================================
// Skills & Slash Commands
// ============================================================================

/// Return all skills and MCP prompts available for slash commands.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashItemDto {
    pub item_type: String, // "skill" | "mcp_prompt"
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub arguments_json: String,
    pub server_name: Option<String>,
}

/// List slash items from filesystem skills + MCP prompts.
#[tauri::command]
pub async fn list_slash_items(
    state: State<'_, AppState>,
) -> Result<Vec<SlashItemDto>, AppError> {
    let mut items = Vec::new();

    // Skills from filesystem
    if let Ok(app_data) = state.app_handle.path().app_data_dir() {
        let skills_dir = crate::services::skill_fs::skills_root_from_app_data(&app_data);
        let skills = crate::services::skill_fs::discover_skills(&skills_dir);
        for skill in skills {
            items.push(SlashItemDto {
                item_type: "skill".to_string(),
                name: skill.name,
                display_name: skill.display_name,
                description: skill.description,
                arguments_json: "[]".to_string(),
                server_name: None,
            });
        }
    }

    // MCP prompts from connected servers
    let manager = state.mcp_manager.lock().await;
    let mcp_prompts = manager.all_prompts();
    for (server_name, prompt) in mcp_prompts {
        let args_json = serde_json::to_string(&prompt.arguments)
            .unwrap_or_else(|_| "[]".to_string());
        items.push(SlashItemDto {
            item_type: "mcp_prompt".to_string(),
            name: prompt.name.clone(),
            display_name: prompt.name,
            description: prompt.description.unwrap_or_default(),
            arguments_json: args_json,
            server_name: Some(server_name),
        });
    }

    Ok(items)
}

/// Execute an MCP prompt by server name + prompt name.
#[tauri::command]
pub async fn execute_mcp_prompt(
    state: State<'_, AppState>,
    server_name: String,
    prompt_name: String,
    arguments_json: String,
) -> Result<String, AppError> {
    let args: std::collections::HashMap<String, String> =
        serde_json::from_str(&arguments_json).unwrap_or_default();

    let mut manager = state.mcp_manager.lock().await;
    let messages = manager
        .get_prompt(&server_name, &prompt_name, args)
        .await
        .map_err(|e| AppError::invalid_argument(&e))?;

    let texts: Vec<String> = messages
        .iter()
        .filter_map(|m| match &m.content {
            crate::services::mcp_client::McpPromptContent::Text { text } => Some(text.clone()),
        })
        .collect();

    Ok(texts.join("\n\n"))
}

/// Return (and create if needed) the skills directory path under app data.
#[tauri::command]
pub async fn get_skills_directory(state: State<'_, AppState>) -> Result<String, AppError> {
    let app_data = state.app_handle.path().app_data_dir()
        .map_err(|e| AppError::invalid_argument(&format!("Failed to resolve app data dir: {e}")))?;
    let dir = crate::services::skill_fs::skills_root_from_app_data(&app_data);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::db_error(&format!("Failed to create skills dir: {e}")))?;
    Ok(dir.to_string_lossy().to_string())
}
