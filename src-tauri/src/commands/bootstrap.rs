/**
 * @file commands/bootstrap.rs
 * @description App initialization and workspace persistence commands.
 *
 * Commands:
 *   - bootstrap_app: Load initial state on app launch
 *   - save_last_workspace: Persist workspace for next launch
 *   - get_default_model: Read default model setting
 *   - set_default_model: Write default model setting
 */

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::dto::settings::{ProviderDto, ProviderModelDto};
use crate::error::AppError;
use crate::repositories::{app_kv, provider_models, providers};
use crate::state::AppState;

// ============================================================================
// Output Types
// ============================================================================

/** Initial data returned on app launch. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastWorkspaceSelection {
    pub conversation_id: Option<String>,
    pub branch_id: Option<String>,
}

/** Initial data returned on app launch. */
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResult {
    pub last_workspace: Option<LastWorkspaceSelection>,
    pub providers: Vec<ProviderDto>,
    pub default_model_id: Option<String>,
    pub helper_model_id: Option<String>,
}

// ============================================================================
// Helpers
// ============================================================================

fn parse_provider_type(s: &str) -> crate::dto::common::ProviderType {
    match s {
        "OLLAMA" => crate::dto::common::ProviderType::Ollama,
        _ => crate::dto::common::ProviderType::OpenaiCompatible,
    }
}

fn map_provider_model_row(row: provider_models::ProviderModelRow) -> ProviderModelDto {
    ProviderModelDto {
        id: row.id,
        provider_id: row.provider_id,
        request_name: row.request_name,
        display_name: row.display_name,
        created_at: row.created_at * 1000,
        updated_at: row.updated_at * 1000,
    }
}

fn map_provider_row(
    row: &providers::ProviderRow,
    has_key: bool,
    models: Vec<ProviderModelDto>,
) -> ProviderDto {
    ProviderDto {
        id: row.id.clone(),
        provider_type: parse_provider_type(&row.r#type),
        name: row.name.clone(),
        base_url: row.base_url.clone(),
        default_model_id: if row.default_model_id.is_empty() {
            None
        } else {
            Some(row.default_model_id.clone())
        },
        models,
        has_api_key: has_key,
        enabled: row.enabled,
        created_at: row.created_at * 1000,
        updated_at: row.updated_at * 1000,
    }
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Load all data needed on app launch.
 * Returns: last workspace, provider list, default model.
 *
 * Also repairs zombie streaming messages from a previous session
 * (messages left in STREAMING status after an unclean shutdown).
 */
#[tauri::command]
pub async fn bootstrap_app(state: State<'_, AppState>) -> Result<BootstrapResult, AppError> {
    let start = std::time::Instant::now();

    // Phase 1: Repair zombie streaming messages BEFORE any data loading.
    let repair_result = crate::services::message_repair_service::repair_inflight_messages(&state.db)
        .await?;

    // Phase 2: Load last workspace
    let last_workspace = app_kv::get(&state.db, "last_workspace")
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok());

    // Load providers (without exposing api_key_ref)
    let provider_rows = providers::list_all(&state.db).await?;
    let mut provider_dtos = Vec::with_capacity(provider_rows.len());

    for row in &provider_rows {
        let has_key = state.key_store.exists(&row.id).unwrap_or(false);
        let models = provider_models::list_by_provider_id(&state.db, &row.id)
            .await?
            .into_iter()
            .map(map_provider_model_row)
            .collect();
        provider_dtos.push(map_provider_row(row, has_key, models));
    }

    // Load default model
    let default_model_id = app_kv::get(&state.db, "default_model_id")
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<String>(&v).ok());

    // Load helper model (used for AI title generation, summaries, etc.)
    let helper_model_id = app_kv::get(&state.db, "helper_model_id")
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<String>(&v).ok());

    let duration_ms = start.elapsed().as_millis() as u64;
    tracing::info!(
        cmd = "bootstrap_app",
        has_last_workspace = last_workspace.is_some(),
        providers_count = provider_dtos.len(),
        has_default_model = default_model_id.is_some(),
        has_helper_model = helper_model_id.is_some(),
        repaired_count = repair_result.repaired_count,
        duration_ms,
        "ok"
    );

    Ok(BootstrapResult {
        last_workspace,
        providers: provider_dtos,
        default_model_id,
        helper_model_id,
    })
}

/** Persist workspace state for restoration on next launch. */
#[tauri::command]
pub async fn save_last_workspace(
    state: State<'_, AppState>,
    workspace_json: LastWorkspaceSelection,
) -> Result<(), AppError> {
    let json_str = serde_json::to_string(&workspace_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid workspace JSON: {e}")))?;
    let size_bytes = json_str.len();

    app_kv::set(&state.db, "last_workspace", &json_str)
        .await
        .map_err(AppError::from)?;

    tracing::debug!(cmd = "save_last_workspace", size_bytes, "ok");
    Ok(())
}

/** Get the default model ID. */
#[tauri::command]
pub async fn get_default_model(state: State<'_, AppState>) -> Result<Option<String>, AppError> {
    let raw = app_kv::get(&state.db, "default_model_id")
        .await
        .map_err(AppError::from)?;
    Ok(raw.and_then(|v| serde_json::from_str::<String>(&v).ok()))
}

/** Set the default model ID. */
#[tauri::command]
pub async fn set_default_model(
    state: State<'_, AppState>,
    model_id: Option<String>,
) -> Result<(), AppError> {
    match model_id {
        Some(model_id) => {
            let json_str = serde_json::to_string(&model_id)
                .map_err(|e| AppError::invalid_argument(format!("Failed to serialize model_id: {e}")))?;
            app_kv::set(&state.db, "default_model_id", &json_str)
                .await
                .map_err(AppError::from)
        }
        None => app_kv::delete(&state.db, "default_model_id")
            .await
            .map_err(AppError::from),
    }
}

/** Get the helper model ID (used for AI title generation, summaries, etc.). */
#[tauri::command]
pub async fn get_helper_model(state: State<'_, AppState>) -> Result<Option<String>, AppError> {
    let raw = app_kv::get(&state.db, "helper_model_id")
        .await
        .map_err(AppError::from)?;
    Ok(raw.and_then(|v| serde_json::from_str::<String>(&v).ok()))
}

/** Set the helper model ID. Pass None to clear. */
#[tauri::command]
pub async fn set_helper_model(
    state: State<'_, AppState>,
    model_id: Option<String>,
) -> Result<(), AppError> {
    match model_id {
        Some(id) => {
            let json_str = serde_json::to_string(&id)
                .map_err(|e| AppError::invalid_argument(format!("Failed to serialize model_id: {e}")))?;
            app_kv::set(&state.db, "helper_model_id", &json_str)
                .await
                .map_err(AppError::from)
        }
        None => app_kv::delete(&state.db, "helper_model_id")
            .await
            .map_err(AppError::from),
    }
}
