/**
 * @file commands/settings.rs
 * @description Provider management commands.
 *
 * Security enforcement:
 *   - save_provider: raw api_key goes to SecureKeyStore, only ref goes to DB
 *   - list_providers: returns has_api_key bool, never api_key_ref
 *   - delete_provider: cleans up both DB and secure storage with rollback
 *   - test_provider_connection: performs a real lightweight HTTP probe
 */

use std::{collections::HashSet, time::Duration};

use sqlx::SqlitePool;
use tauri::State;

use crate::dto::common::ProviderType;
use crate::dto::settings::{
    ProviderDto, ProviderModelDto, SaveProviderInput, SaveProviderModelInput,
};
use crate::error::AppError;
use crate::repositories::{provider_models, providers};
use crate::state::AppState;

// ============================================================================
// Commands
// ============================================================================

const PROVIDER_TEST_TIMEOUT_SECONDS: u64 = 10;
const PROVIDER_TEST_BODY_PREVIEW_LIMIT: usize = 256;

#[derive(Debug, Clone)]
struct NormalizedProviderModelInput {
    id: String,
    request_name: String,
    display_name: String,
}

/** Normalize provider base URLs so probe endpoints can be appended safely. */
fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

/** Limit error details so backend errors stay readable in the frontend. */
fn truncate_probe_details(details: String) -> String {
    if details.chars().count() <= PROVIDER_TEST_BODY_PREVIEW_LIMIT {
        return details;
    }

    let truncated: String = details
        .chars()
        .take(PROVIDER_TEST_BODY_PREVIEW_LIMIT)
        .collect();
    format!("{truncated}...")
}

/** Build ordered probe endpoints for each provider type. */
fn build_probe_urls(provider_type: &str, base_url: &str) -> Vec<String> {
    let normalized_base = normalize_base_url(base_url);
    if normalized_base.is_empty() {
        return Vec::new();
    }

    let mut probe_urls = Vec::new();
    let mut push_unique = |url: String| {
        if !probe_urls.contains(&url) {
            probe_urls.push(url);
        }
    };

    match provider_type {
        "OLLAMA" => {
            if normalized_base.ends_with("/v1") {
                push_unique(format!("{normalized_base}/models"));
                let legacy_base = normalized_base.trim_end_matches("/v1").trim_end_matches('/');
                if !legacy_base.is_empty() {
                    push_unique(format!("{legacy_base}/api/tags"));
                }
            } else {
                push_unique(format!("{normalized_base}/api/tags"));
                push_unique(format!("{normalized_base}/v1/models"));
            }
        }
        _ => {
            push_unique(format!("{normalized_base}/models"));
        }
    }

    probe_urls
}

/** Map one provider model row into the frontend DTO contract. */
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

/** Load all provider model DTOs for one provider. */
async fn load_provider_model_dtos(
    pool: &SqlitePool,
    provider_id: &str,
) -> Result<Vec<ProviderModelDto>, AppError> {
    let rows = provider_models::list_by_provider_id(pool, provider_id).await?;
    Ok(rows.into_iter().map(map_provider_model_row).collect())
}

/** Normalize provider model payloads and enforce per-provider uniqueness. */
fn normalize_provider_models(
    input: &SaveProviderInput,
) -> Result<Vec<NormalizedProviderModelInput>, AppError> {
    let effective_models: Vec<SaveProviderModelInput> = if input.models.is_empty() {
        input
            .default_model_id
            .as_ref()
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|legacy_name| SaveProviderModelInput {
                id: None,
                request_name: legacy_name.to_string(),
                display_name: legacy_name.to_string(),
            })
            .into_iter()
            .collect()
    } else {
        input.models.clone()
    };

    let mut normalized = Vec::with_capacity(effective_models.len());
    let mut seen_ids = HashSet::new();
    let mut seen_request_names = HashSet::new();
    let mut seen_display_names = HashSet::new();

    for (index, model) in effective_models.into_iter().enumerate() {
        let request_name = model.request_name.trim().to_string();
        let display_name = model.display_name.trim().to_string();
        let id = model
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("model_{}", uuid::Uuid::new_v4()));

        if request_name.is_empty() {
            return Err(AppError::invalid_argument(format!(
                "Model {} request name is required",
                index + 1
            )));
        }

        if display_name.is_empty() {
            return Err(AppError::invalid_argument(format!(
                "Model {} display name is required",
                index + 1
            )));
        }

        if !seen_ids.insert(id.clone()) {
            return Err(AppError::conflict(
                "Provider model IDs must be unique within one provider",
            ));
        }

        if !seen_request_names.insert(request_name.to_ascii_lowercase()) {
            return Err(AppError::conflict(
                "Provider model request names must be unique within one provider",
            ));
        }

        if !seen_display_names.insert(display_name.to_ascii_lowercase()) {
            return Err(AppError::conflict(
                "Provider model display names must be unique within one provider",
            ));
        }

        normalized.push(NormalizedProviderModelInput {
            id,
            request_name,
            display_name,
        });
    }

    Ok(normalized)
}

/** Resolve which model profile should become the provider default after save. */
fn resolve_default_model_id(
    input: &SaveProviderInput,
    normalized_models: &[NormalizedProviderModelInput],
    existing_default_model_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    let explicit_default = input
        .default_model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if input.models.is_empty() {
        if explicit_default.is_some() && normalized_models.len() == 1 {
            return Ok(Some(normalized_models[0].id.clone()));
        }

        return Ok(existing_default_model_id
            .filter(|value| !value.is_empty())
            .map(ToString::to_string));
    }

    if let Some(default_model_id) = explicit_default {
        if normalized_models
            .iter()
            .any(|model| model.id == default_model_id)
        {
            return Ok(Some(default_model_id.to_string()));
        }

        return Err(AppError::invalid_argument(
            "defaultModelId must reference one of the saved model profiles",
        ));
    }

    if normalized_models.len() == 1 {
        return Ok(Some(normalized_models[0].id.clone()));
    }

    if let Some(existing_default_model_id) = existing_default_model_id.filter(|value| !value.is_empty()) {
        if normalized_models
            .iter()
            .any(|model| model.id == existing_default_model_id)
        {
            return Ok(Some(existing_default_model_id.to_string()));
        }
    }

    Ok(None)
}

/** Sync the full provider model list for one provider inside a transaction. */
async fn sync_provider_models(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    provider_id: &str,
    normalized_models: &[NormalizedProviderModelInput],
) -> Result<(), AppError> {
    let mut keep_ids = Vec::with_capacity(normalized_models.len());

    for model in normalized_models {
        let existing = provider_models::find_by_id(&mut **tx, &model.id).await?;
        if let Some(existing) = existing {
            if existing.provider_id != provider_id {
                return Err(AppError::conflict(
                    "Provider model ID already belongs to another provider",
                ));
            }

            provider_models::update(
                &mut **tx,
                &model.id,
                &model.request_name,
                &model.display_name,
            )
            .await?;
        } else {
            provider_models::insert(
                &mut **tx,
                &model.id,
                provider_id,
                &model.request_name,
                &model.display_name,
            )
            .await?;
        }

        keep_ids.push(model.id.clone());
    }

    provider_models::delete_missing_for_provider(&mut **tx, provider_id, &keep_ids).await?;
    Ok(())
}

/** Build the frontend provider DTO from a provider row plus nested models. */
fn map_provider_row_to_dto(
    row: &providers::ProviderRow,
    has_api_key: bool,
    models: Vec<ProviderModelDto>,
) -> ProviderDto {
    ProviderDto {
        id: row.id.clone(),
        provider_type: match row.r#type.as_str() {
            "OLLAMA" => ProviderType::Ollama,
            _ => ProviderType::OpenaiCompatible,
        },
        name: row.name.clone(),
        base_url: row.base_url.clone(),
        default_model_id: if row.default_model_id.is_empty() {
            None
        } else {
            Some(row.default_model_id.clone())
        },
        models,
        has_api_key,
        enabled: row.enabled,
        created_at: row.created_at * 1000,
        updated_at: row.updated_at * 1000,
    }
}

/** List all configured providers (without API key references). */
#[tauri::command]
pub async fn list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderDto>, AppError> {
    let rows = providers::list_all(&state.db).await?;
    let mut dtos = Vec::with_capacity(rows.len());

    for row in &rows {
        let has_key = state.key_store.exists(&row.id).unwrap_or(false);
        let models = load_provider_model_dtos(&state.db, &row.id).await?;
        dtos.push(map_provider_row_to_dto(row, has_key, models));
    }

    Ok(dtos)
}

/**
 * Save (create or update) a provider configuration.
 *
 * Security flow:
 *   1. If api_key is provided: save to secure storage → get ref
 *   2. Store only the ref in the DB (never the plaintext key)
 *   3. Return ProviderDto with has_api_key (no ref, no key)
 */
#[tauri::command]
pub async fn save_provider(
    state: State<'_, AppState>,
    input: SaveProviderInput,
) -> Result<ProviderDto, AppError> {
    let provider_type_str = match input.provider_type {
        ProviderType::OpenaiCompatible => "OPENAI_COMPATIBLE",
        ProviderType::Ollama => "OLLAMA",
    };
    let normalized_models = normalize_provider_models(&input)?;

    match &input.id {
        None => {
            // Create new provider
            let id = uuid::Uuid::new_v4().to_string();
            let effective_default_model_id =
                resolve_default_model_id(&input, &normalized_models, None)?;

            // Handle API key: save to secure storage if provided
            let api_key_ref = match &input.api_key {
                Some(key) if !key.is_empty() => {
                    state
                        .key_store
                        .save(&id, key)
                        .map_err(|e| AppError::secure_storage_error(e))?
                }
                _ => String::new(),
            };

            let mut tx = state.db.begin().await.map_err(AppError::from)?;
            if let Err(error) = providers::insert(
                &mut *tx,
                &id,
                provider_type_str,
                &input.name,
                &input.base_url,
                &api_key_ref,
                effective_default_model_id.as_deref().unwrap_or(""),
                input.enabled.unwrap_or(true),
            )
            .await
            {
                let _ = tx.rollback().await;
                if !api_key_ref.is_empty() {
                    let _ = state.key_store.delete(&id);
                }
                return Err(AppError::from(error));
            }

            if let Err(error) = sync_provider_models(&mut tx, &id, &normalized_models).await {
                let _ = tx.rollback().await;
                if !api_key_ref.is_empty() {
                    let _ = state.key_store.delete(&id);
                }
                return Err(error);
            }

            if let Err(error) = tx.commit().await {
                if !api_key_ref.is_empty() {
                    let _ = state.key_store.delete(&id);
                }
                return Err(AppError::from(error));
            }

            let has_key = state
                .key_store
                .exists(&id)
                .map_err(|e| AppError::secure_storage_error(e))?;
            let models = load_provider_model_dtos(&state.db, &id).await?;
            let row = providers::find_by_id(&state.db, &id)
                .await?
                .ok_or_else(|| AppError::not_found("Provider not found after create"))?;

            Ok(map_provider_row_to_dto(&row, has_key, models))
        }
        Some(id) => {
            // Update existing provider
            let existing = providers::find_by_id(&state.db, id)
                .await?
                .ok_or_else(|| AppError::not_found("Provider not found"))?;
            let effective_default_model_id =
                resolve_default_model_id(&input, &normalized_models, Some(&existing.default_model_id))?;
            let should_update_key =
                input.api_key.as_ref().is_some_and(|key| !key.is_empty());
            let previous_key = if should_update_key {
                state
                    .key_store
                    .load(id)
                    .map_err(|e| AppError::secure_storage_error(e))?
            } else {
                None
            };

            // Handle API key: update if provided, keep existing if not
            let api_key_ref = match &input.api_key {
                Some(key) if !key.is_empty() => {
                    state
                        .key_store
                        .save(id, key)
                        .map_err(|e| AppError::secure_storage_error(e))?
                }
                _ => existing.api_key_ref.clone(), // keep existing ref
            };

            let mut tx = state.db.begin().await.map_err(AppError::from)?;
            if let Err(error) = providers::update(
                &mut *tx,
                id,
                provider_type_str,
                &input.name,
                &input.base_url,
                &api_key_ref,
                effective_default_model_id.as_deref().unwrap_or(""),
                input.enabled.unwrap_or(existing.enabled),
            )
            .await
            {
                let _ = tx.rollback().await;
                if should_update_key {
                    match previous_key {
                        Some(previous_key) => {
                            if let Err(restore_error) = state.key_store.save(id, &previous_key) {
                                tracing::error!(
                                    provider_id = %id,
                                    error = %restore_error,
                                    "failed to restore provider api key after db update failure"
                                );
                            }
                        }
                        None => {
                            let _ = state.key_store.delete(id);
                        }
                    }
                }
                return Err(AppError::from(error));
            }

            if let Err(error) = sync_provider_models(&mut tx, id, &normalized_models).await {
                let _ = tx.rollback().await;
                if should_update_key {
                    match previous_key {
                        Some(previous_key) => {
                            let _ = state.key_store.save(id, &previous_key);
                        }
                        None => {
                            let _ = state.key_store.delete(id);
                        }
                    }
                }
                return Err(error);
            }

            if let Err(commit_error) = tx.commit().await {
                if should_update_key {
                    match previous_key {
                        Some(previous_key) => {
                            let _ = state.key_store.save(id, &previous_key);
                        }
                        None => {
                            let _ = state.key_store.delete(id);
                        }
                    }
                }
                return Err(AppError::from(commit_error));
            }

            let has_key = state
                .key_store
                .exists(id)
                .map_err(|e| AppError::secure_storage_error(e))?;
            let models = load_provider_model_dtos(&state.db, id).await?;
            let updated = providers::find_by_id(&state.db, id)
                .await?
                .ok_or_else(|| AppError::not_found("Provider not found after update"))?;

            Ok(map_provider_row_to_dto(&updated, has_key, models))
        }
    }
}

/** Delete a provider and its stored API key. */
#[tauri::command]
pub async fn delete_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), AppError> {
    let existing_provider = providers::find_by_id(&state.db, &provider_id)
        .await?
        .ok_or_else(|| AppError::not_found("Provider not found"))?;
    let existing_key = state
        .key_store
        .load(&provider_id)
        .map_err(|e| AppError::secure_storage_error(e))?;

    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    providers::delete_by_id(&mut *tx, &provider_id).await?;

    if let Err(delete_error) = state.key_store.delete(&provider_id) {
        let _ = tx.rollback().await;
        return Err(AppError::secure_storage_error(delete_error));
    }

    if let Err(commit_error) = tx.commit().await {
        if let Some(previous_key) = existing_key {
            if let Err(restore_error) = state.key_store.save(&provider_id, &previous_key) {
                tracing::error!(
                    provider_id = %provider_id,
                    provider_name = %existing_provider.name,
                    error = %restore_error,
                    "failed to restore provider api key after delete_provider commit failure"
                );
            }
        }

        return Err(AppError::from(commit_error));
    }

    Ok(())
}

/**
 * Test provider connection by making a simple API request.
 *
 * Loads the API key from secure storage when required, performs a lightweight
 * probe against the provider's model-listing endpoint, and returns success/failure.
 */
#[tauri::command]
pub async fn test_provider_connection(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), AppError> {
    test_provider_connection_impl(&state.db, state.key_store.as_ref(), &provider_id).await
}

/** Shared provider probe implementation used by the Tauri command and backend tests. */
async fn test_provider_connection_impl(
    pool: &SqlitePool,
    key_store: &dyn crate::state::SecureKeyStore,
    provider_id: &str,
) -> Result<(), AppError> {
    let row = providers::find_by_id(pool, provider_id)
        .await?
        .ok_or_else(|| AppError::not_found("Provider not found"))?;

    if !row.enabled {
        return Err(AppError::invalid_argument("Provider is disabled"));
    }

    let api_key = key_store
        .load(provider_id)
        .map_err(|e| AppError::secure_storage_error(e))?;

    if row.r#type != "OLLAMA" && api_key.is_none() {
        return Err(AppError::invalid_argument(
            "No API key configured for this provider",
        ));
    }

    let probe_urls = build_probe_urls(&row.r#type, &row.base_url);
    if probe_urls.is_empty() {
        return Err(AppError::invalid_argument("Provider base URL is required"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PROVIDER_TEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| {
            AppError::db_error("Failed to build provider test client")
                .with_details(error.to_string())
        })?;

    let mut last_error: Option<AppError> = None;
    for probe_url in probe_urls {
        let mut request = client.get(&probe_url);
        if let Some(api_key) = api_key.as_deref() {
            request = request.bearer_auth(api_key);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(
                    AppError::db_error("Provider connection test failed")
                        .with_details(format!("GET {probe_url}: {error}")),
                );
                continue;
            }
        };

        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let details = truncate_probe_details(format!(
            "GET {probe_url} -> HTTP {status}; body={body}"
        ));

        last_error = Some(match status.as_u16() {
            401 | 403 => AppError::invalid_argument("Provider authentication failed")
                .with_details(details),
            404 => AppError::invalid_argument(
                "Provider probe endpoint not found. Check the configured Base URL.",
            )
            .with_details(details),
            _ => AppError::db_error(format!("Provider probe returned HTTP {status}"))
                .with_details(details),
        });
    }

    Err(last_error.unwrap_or_else(|| {
        AppError::db_error("Provider connection test failed")
    }))
}

// ============================================================================
// Tests
// ============================================================================

/**
 * Fetch available models from a running Ollama instance.
 *
 * Probes `/api/tags` on the given base URL and returns a list of model names.
 * Used by the frontend to auto-populate model profiles when adding an Ollama provider.
 */

#[derive(serde::Serialize)]
pub struct OllamaModelInfo {
    pub name: String,
    pub size: Option<u64>,
    pub quantization: Option<String>,
}

#[tauri::command]
pub async fn fetch_ollama_models(base_url: String) -> Result<Vec<OllamaModelInfo>, AppError> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err(AppError::invalid_argument("Base URL is required"));
    }

    let probe_url = if normalized.ends_with("/v1") {
        let legacy = normalized.trim_end_matches("/v1").trim_end_matches('/');
        format!("{legacy}/api/tags")
    } else {
        format!("{normalized}/api/tags")
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| {
            AppError::db_error("Failed to build HTTP client").with_details(error.to_string())
        })?;

    let response = client.get(&probe_url).send().await.map_err(|error| {
        AppError::db_error("Failed to connect to Ollama").with_details(format!(
            "GET {probe_url}: {error}. Make sure Ollama is running."
        ))
    })?;

    if !response.status().is_success() {
        let status = response.status();
        let fallback_url = format!("{normalized}/v1/models");
        let fallback = client.get(&fallback_url).send().await.map_err(|_| {
            AppError::db_error("Ollama returned an error").with_details(format!(
                "GET {probe_url} -> HTTP {status}"
            ))
        })?;

        if !fallback.status().is_success() {
            return Err(AppError::db_error("Ollama returned an error").with_details(format!(
                "GET {probe_url} -> HTTP {status}"
            )));
        }

        let body: serde_json::Value = fallback.json().await.map_err(|error| {
            AppError::db_error("Failed to parse Ollama response").with_details(error.to_string())
        })?;

        let models = body["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        item["id"].as_str().map(|name| OllamaModelInfo {
                            name: name.to_string(),
                            size: None,
                            quantization: None,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        return Ok(models);
    }

    let body: serde_json::Value = response.json().await.map_err(|error| {
        AppError::db_error("Failed to parse Ollama response").with_details(error.to_string())
    })?;

    let models = body["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let name = item["name"].as_str()?.to_string();
                    let size = item["size"].as_u64();
                    let quantization = item["details"]["quantization_level"]
                        .as_str()
                        .map(String::from);
                    Some(OllamaModelInfo {
                        name,
                        size,
                        quantization,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::AppErrorCode,
        repositories::providers,
        state::SecureKeyStore,
        test_support::{init_test_pool, spawn_mock_http_server, MockHttpRoute, TestKeyStore},
    };

    /** Verify OpenAI-compatible probe hits `/models` with a bearer token. */
    #[tokio::test]
    async fn test_provider_connection_openai_probe_uses_models_endpoint_with_auth() {
        let pool = init_test_pool().await;
        let key_store = TestKeyStore::new();
        let server = spawn_mock_http_server(vec![MockHttpRoute::new(
            "GET",
            "/v1/models",
            200,
            "application/json",
            r#"{"data":[{"id":"gpt-4.1-mini"}]}"#,
        )])
        .await;

        providers::insert(
            &pool,
            "prov-openai",
            "OPENAI_COMPATIBLE",
            "OpenAI Mock",
            &format!("{}/v1", server.base_url()),
            "test-key://prov-openai",
            "gpt-4.1-mini",
            true,
        )
        .await
        .unwrap();
        key_store.save("prov-openai", "sk-test").unwrap();

        test_provider_connection_impl(&pool, &key_store, "prov-openai")
            .await
            .expect("provider probe should succeed");

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].path, "/v1/models");
        assert_eq!(
            requests[0].headers.get("authorization").map(String::as_str),
            Some("Bearer sk-test")
        );
    }

    /** Verify Ollama probes fall back from `/api/tags` to `/v1/models` without requiring a key. */
    #[tokio::test]
    async fn test_provider_connection_ollama_probe_falls_back_without_api_key() {
        let pool = init_test_pool().await;
        let key_store = TestKeyStore::new();
        let server = spawn_mock_http_server(vec![
            MockHttpRoute::new(
                "GET",
                "/api/tags",
                404,
                "application/json",
                r#"{"error":"not found"}"#,
            ),
            MockHttpRoute::new(
                "GET",
                "/v1/models",
                200,
                "application/json",
                r#"{"data":[{"id":"llama3.1"}]}"#,
            ),
        ])
        .await;

        providers::insert(
            &pool,
            "prov-ollama",
            "OLLAMA",
            "Ollama Mock",
            &server.base_url(),
            "",
            "llama3.1",
            true,
        )
        .await
        .unwrap();

        test_provider_connection_impl(&pool, &key_store, "prov-ollama")
            .await
            .expect("ollama probe should succeed via fallback");

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].path, "/api/tags");
        assert_eq!(requests[1].path, "/v1/models");
        assert!(requests
            .iter()
            .all(|request| !request.headers.contains_key("authorization")));
    }

    /** Verify authentication failures surface as INVALID_ARGUMENT for the frontend. */
    #[tokio::test]
    async fn test_provider_connection_maps_unauthorized_to_invalid_argument() {
        let pool = init_test_pool().await;
        let key_store = TestKeyStore::new();
        let server = spawn_mock_http_server(vec![MockHttpRoute::new(
            "GET",
            "/v1/models",
            401,
            "application/json",
            r#"{"error":"bad key"}"#,
        )])
        .await;

        providers::insert(
            &pool,
            "prov-auth-error",
            "OPENAI_COMPATIBLE",
            "Unauthorized Mock",
            &format!("{}/v1", server.base_url()),
            "test-key://prov-auth-error",
            "gpt-4.1-mini",
            true,
        )
        .await
        .unwrap();
        key_store.save("prov-auth-error", "sk-invalid").unwrap();

        let error = test_provider_connection_impl(&pool, &key_store, "prov-auth-error")
            .await
            .expect_err("probe should fail");

        assert_eq!(error.code, AppErrorCode::InvalidArgument);
        assert!(error.message.contains("authentication failed"));
        assert!(
            error
                .details
                .as_deref()
                .unwrap_or_default()
                .contains("/v1/models")
        );
    }
}
