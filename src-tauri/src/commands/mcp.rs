/**
 * @file commands/mcp.rs
 * @description MCP server management commands (v1.5.0 M1.5).
 *
 * Verbatim relocation of the MCP management block that used to live in
 * `commands/streaming.rs`: server CRUD over mcps.json, sensitive env/header
 * handling through the secure key store, runtime restore, config-file
 * import/export, and startup reload.
 *
 * The streaming runtime (ReAct loop, tool execution, approval) lives in
 * `agent/runner.rs`; this module only manages MCP server lifecycle.
 */

use std::collections::{HashMap, HashSet};

use tauri::{Manager, State};

use crate::error::AppError;
use crate::services::mcp_client::McpServerConfig;
use crate::state::AppState;

// ============================================================================
// MCP Server Management Commands
// ============================================================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStateDto {
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub status: String,
    pub enabled: bool,
    pub tools: Vec<McpToolDto>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDto {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<serde_json::Value>,
}

/** Input format matching Claude Desktop: `{ "name": { "command": ..., "args": ..., "env": ... } }`. */
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AddMcpServerInput {
    /// Server name (key in mcpServers map).
    pub name: String,
    /// Per-server config (command, args, env).
    pub config: McpServerConfig,
}

fn is_valid_mcp_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && !name.contains("__")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    // Match token-like *segments* instead of arbitrary substrings so ordinary
    // numeric settings such as MAX_TOKENS are not treated as secrets.
    let segments: Vec<&str> = upper
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect();

    segments.iter().enumerate().any(|(index, segment)| {
        matches!(
            *segment,
            "KEY"
                | "SECRET"
                | "PASSWORD"
                | "AUTH"
                | "AUTHORIZATION"
                | "CREDENTIAL"
                | "CREDENTIALS"
                | "BEARER"
                | "PAT"
        ) || (*segment == "TOKEN" && index + 1 == segments.len())
    })
}

fn normalize_mcp_transport_for_storage(transport: &str) -> String {
    match transport.trim().to_ascii_lowercase().as_str() {
        "" | "stdio" => "stdio".to_string(),
        "http" | "streamable_http" | "streamable-http" | "streamablehttp" => {
            "streamable_http".to_string()
        }
        "sse" | "legacy_sse" | "legacy-sse" => "sse".to_string(),
        other => other.to_string(),
    }
}

fn is_sensitive_header_key(key: &str) -> bool {
    is_sensitive_env_key(key)
}

#[cfg(test)]
mod mcp_env_tests {
    use super::is_sensitive_env_key;

    #[test]
    fn sensitive_env_key_detection_uses_segments() {
        assert!(is_sensitive_env_key("OPENAI_API_KEY"));
        assert!(is_sensitive_env_key("github-token"));
        assert!(is_sensitive_env_key("CLIENT_SECRET"));
        assert!(is_sensitive_env_key("PASSWORD"));

        assert!(!is_sensitive_env_key("FEEDBACK_MAX_TOKENS"));
        assert!(!is_sensitive_env_key("TOKEN_LIMIT"));
        assert!(!is_sensitive_env_key("TOKENIZER_MODEL"));
        assert!(!is_sensitive_env_key("PORT"));
    }
}

fn mcp_secret_store_key(server_name: &str, env_key: &str) -> String {
    format!("mcp:{server_name}:env:{env_key}")
}

fn mcp_header_secret_store_key(server_name: &str, header_key: &str) -> String {
    format!("mcp:{server_name}:header:{header_key}")
}

fn encode_mcp_env_for_storage(
    server_name: &str,
    env: &HashMap<String, String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<String, AppError> {
    let mut stored = serde_json::Map::new();
    for (key, value) in env {
        if is_sensitive_env_key(key) {
            let secret_key = mcp_secret_store_key(server_name, key);
            key_store
                .save(&secret_key, value)
                .map_err(AppError::secure_storage_error)?;
            stored.insert(key.clone(), serde_json::json!({ "kind": "secure" }));
        } else {
            stored.insert(
                key.clone(),
                serde_json::json!({ "kind": "plain", "value": value }),
            );
        }
    }
    Ok(serde_json::Value::Object(stored).to_string())
}

fn encode_mcp_headers_for_storage(
    server_name: &str,
    headers: &HashMap<String, String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<String, AppError> {
    let mut stored = serde_json::Map::new();
    for (key, value) in headers {
        if is_sensitive_header_key(key) {
            let secret_key = mcp_header_secret_store_key(server_name, key);
            key_store
                .save(&secret_key, value)
                .map_err(AppError::secure_storage_error)?;
            stored.insert(key.clone(), serde_json::json!({ "kind": "secure" }));
        } else {
            stored.insert(
                key.clone(),
                serde_json::json!({ "kind": "plain", "value": value }),
            );
        }
    }
    Ok(serde_json::Value::Object(stored).to_string())
}

fn decode_mcp_env_from_storage(
    server_name: &str,
    env_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<HashMap<String, String>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(env_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid MCP env metadata: {e}")))?;
    let Some(object) = parsed.as_object() else {
        return Ok(HashMap::new());
    };

    let mut env = HashMap::new();
    for (key, value) in object {
        if let Some(raw) = value.as_str() {
            if is_sensitive_env_key(key) {
                tracing::warn!(
                    server = %server_name,
                    env_key = %key,
                    "Skipping legacy plaintext sensitive MCP env value"
                );
            } else {
                env.insert(key.clone(), raw.to_string());
            }
            continue;
        }

        match value.get("kind").and_then(|v| v.as_str()) {
            Some("secure") => {
                let secret_key = mcp_secret_store_key(server_name, key);
                if let Some(secret) = key_store
                    .load(&secret_key)
                    .map_err(AppError::secure_storage_error)?
                {
                    env.insert(key.clone(), secret);
                } else {
                    tracing::warn!(
                        server = %server_name,
                        env_key = %key,
                        "Missing secure MCP env value"
                    );
                }
            }
            Some("plain") => {
                if let Some(raw) = value.get("value").and_then(|v| v.as_str()) {
                    env.insert(key.clone(), raw.to_string());
                }
            }
            _ => {}
        }
    }
    Ok(env)
}

fn decode_mcp_headers_from_storage(
    server_name: &str,
    headers_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<HashMap<String, String>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(headers_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid MCP header metadata: {e}")))?;
    let Some(object) = parsed.as_object() else {
        return Ok(HashMap::new());
    };

    let mut headers = HashMap::new();
    for (key, value) in object {
        if let Some(raw) = value.as_str() {
            if is_sensitive_header_key(key) {
                tracing::warn!(
                    server = %server_name,
                    header = %key,
                    "Skipping legacy plaintext sensitive MCP HTTP header value"
                );
            } else {
                headers.insert(key.clone(), raw.to_string());
            }
            continue;
        }

        match value.get("kind").and_then(|v| v.as_str()) {
            Some("secure") => {
                let secret_key = mcp_header_secret_store_key(server_name, key);
                if let Some(secret) = key_store
                    .load(&secret_key)
                    .map_err(AppError::secure_storage_error)?
                {
                    headers.insert(key.clone(), secret);
                } else {
                    tracing::warn!(
                        server = %server_name,
                        header = %key,
                        "Missing secure MCP HTTP header value"
                    );
                }
            }
            Some("plain") => {
                if let Some(raw) = value.get("value").and_then(|v| v.as_str()) {
                    headers.insert(key.clone(), raw.to_string());
                }
            }
            _ => {}
        }
    }
    Ok(headers)
}

fn cleanup_mcp_env_secrets(
    server_name: &str,
    env_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
    retain_sensitive_keys: &HashSet<String>,
) -> Result<(), AppError> {
    let parsed: serde_json::Value = serde_json::from_str(env_json).unwrap_or_default();
    let Some(object) = parsed.as_object() else {
        return Ok(());
    };

    for (key, value) in object {
        if retain_sensitive_keys.contains(key) {
            continue;
        }
        let stored_secure = value.get("kind").and_then(|v| v.as_str()) == Some("secure");
        if stored_secure || is_sensitive_env_key(key) {
            key_store
                .delete(&mcp_secret_store_key(server_name, key))
                .map_err(AppError::secure_storage_error)?;
        }
    }
    Ok(())
}

fn cleanup_mcp_header_secrets(
    server_name: &str,
    headers_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
    retain_sensitive_keys: &HashSet<String>,
) -> Result<(), AppError> {
    let parsed: serde_json::Value = serde_json::from_str(headers_json).unwrap_or_default();
    let Some(object) = parsed.as_object() else {
        return Ok(());
    };

    for (key, value) in object {
        if retain_sensitive_keys.contains(key) {
            continue;
        }
        let stored_secure = value.get("kind").and_then(|v| v.as_str()) == Some("secure");
        if stored_secure || is_sensitive_header_key(key) {
            key_store
                .delete(&mcp_header_secret_store_key(server_name, key))
                .map_err(AppError::secure_storage_error)?;
        }
    }
    Ok(())
}

fn snapshot_mcp_env_secrets(
    server_name: &str,
    env_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<HashMap<String, String>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(env_json).unwrap_or_default();
    let Some(object) = parsed.as_object() else {
        return Ok(HashMap::new());
    };

    let mut secrets = HashMap::new();
    for (key, value) in object {
        let stored_secure = value.get("kind").and_then(|v| v.as_str()) == Some("secure");
        if stored_secure || is_sensitive_env_key(key) {
            if let Some(secret) = key_store
                .load(&mcp_secret_store_key(server_name, key))
                .map_err(AppError::secure_storage_error)?
            {
                secrets.insert(key.clone(), secret);
            }
        }
    }
    Ok(secrets)
}

fn snapshot_mcp_header_secrets(
    server_name: &str,
    headers_json: &str,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<HashMap<String, String>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(headers_json).unwrap_or_default();
    let Some(object) = parsed.as_object() else {
        return Ok(HashMap::new());
    };

    let mut secrets = HashMap::new();
    for (key, value) in object {
        let stored_secure = value.get("kind").and_then(|v| v.as_str()) == Some("secure");
        if stored_secure || is_sensitive_header_key(key) {
            if let Some(secret) = key_store
                .load(&mcp_header_secret_store_key(server_name, key))
                .map_err(AppError::secure_storage_error)?
            {
                secrets.insert(key.clone(), secret);
            }
        }
    }
    Ok(secrets)
}

fn restore_mcp_env_secrets(
    server_name: &str,
    secrets: &HashMap<String, String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<(), AppError> {
    for (key, value) in secrets {
        key_store
            .save(&mcp_secret_store_key(server_name, key), value)
            .map_err(AppError::secure_storage_error)?;
    }
    Ok(())
}

fn restore_mcp_header_secrets(
    server_name: &str,
    secrets: &HashMap<String, String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<(), AppError> {
    for (key, value) in secrets {
        key_store
            .save(&mcp_header_secret_store_key(server_name, key), value)
            .map_err(AppError::secure_storage_error)?;
    }
    Ok(())
}

fn delete_mcp_env_secret_keys(
    server_name: &str,
    keys: &HashSet<String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<(), AppError> {
    for key in keys {
        key_store
            .delete(&mcp_secret_store_key(server_name, key))
            .map_err(AppError::secure_storage_error)?;
    }
    Ok(())
}

fn delete_mcp_header_secret_keys(
    server_name: &str,
    keys: &HashSet<String>,
    key_store: &dyn crate::state::SecureKeyStore,
) -> Result<(), AppError> {
    for key in keys {
        key_store
            .delete(&mcp_header_secret_store_key(server_name, key))
            .map_err(AppError::secure_storage_error)?;
    }
    Ok(())
}

async fn restore_mcp_runtime_from_row(
    state: &State<'_, AppState>,
    row: &crate::repositories::mcp_servers::McpServerRow,
) {
    if !row.enabled {
        return;
    }

    let args: Vec<String> = match serde_json::from_str(&row.args_json) {
        Ok(args) => args,
        Err(error) => {
            tracing::warn!(server = %row.name, error = %error, "Failed to restore previous MCP args");
            return;
        }
    };
    let env = match decode_mcp_env_from_storage(&row.name, &row.env_json, state.key_store.as_ref()) {
        Ok(env) => env,
        Err(error) => {
            tracing::warn!(server = %row.name, error = %error, "Failed to restore previous MCP env");
            return;
        }
    };
    let headers = match decode_mcp_headers_from_storage(&row.name, &row.headers_json, state.key_store.as_ref()) {
        Ok(headers) => headers,
        Err(error) => {
            tracing::warn!(server = %row.name, error = %error, "Failed to restore previous MCP HTTP headers");
            return;
        }
    };

    let mut manager = state.mcp_manager.lock().await;
    if let Err(error) = manager
        .add_server(
            row.name.clone(),
            McpServerConfig {
                transport: row.transport.clone(),
                command: row.command.clone(),
                args,
                env,
                url: row.url.clone(),
                headers,
            },
        )
        .await
    {
        tracing::warn!(server = %row.name, error = %error, "Failed to restore previous MCP runtime");
    }
}

#[tauri::command]
pub async fn list_mcp_servers(
    state: State<'_, AppState>,
) -> Result<Vec<McpServerStateDto>, AppError> {
    let app_data_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::db_error(&format!("Failed to resolve app data dir: {e}")))?;

    let config_result = crate::services::mcp_config_file::load_mcp_config_file(&app_data_dir);

    let runtime_states: HashMap<String, crate::services::mcp_client::McpServerState> = {
        let manager = state.mcp_manager.lock().await;
        manager
            .server_states()
            .into_iter()
            .map(|state| (state.name.clone(), state))
            .collect()
    };

    let mut result = Vec::with_capacity(config_result.servers.len());
    for parsed in &config_result.servers {
        let config = &parsed.config;
        let disabled = config
            .get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let transport_raw = config
            .get("transport")
            .or_else(|| config.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("stdio");
        let transport = normalize_mcp_transport_for_storage(transport_raw).to_string();

        let command = config
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let args: Vec<String> = config
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let url = config
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let env: HashMap<String, String> = config
            .get("env")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        let headers: HashMap<String, String> = config
            .get("headers")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        let runtime_state = runtime_states.get(&parsed.name);
        let status = if disabled {
            "disabled".to_string()
        } else if let Some(state) = runtime_state {
            match &state.status {
                crate::services::mcp_client::McpServerStatus::Running => "running".to_string(),
                crate::services::mcp_client::McpServerStatus::Starting => "starting".to_string(),
                crate::services::mcp_client::McpServerStatus::Error(e) => format!("error: {e}"),
                _ => "stopped".to_string(),
            }
        } else {
            "stopped".to_string()
        };

        let mut tools: Vec<McpToolDto> = runtime_state
            .map(|state| {
                state
                    .tools
                    .iter()
                    .cloned()
                    .map(|t| McpToolDto {
                        name: t.name,
                        description: t.description,
                        input_schema: t.input_schema,
                    })
                    .collect()
            })
            .unwrap_or_default();
        tools.sort_by(|a, b| a.name.cmp(&b.name));

        result.push(McpServerStateDto {
            enabled: !disabled,
            name: parsed.name.clone(),
            transport,
            command,
            args,
            env,
            url,
            headers,
            status,
            tools,
        });
    }

    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

#[tauri::command]
pub async fn add_mcp_server(
    state: State<'_, AppState>,
    input: AddMcpServerInput,
) -> Result<(), AppError> {
    let name = input.name.trim().to_string();
    if !is_valid_mcp_server_name(&name) {
        return Err(AppError::invalid_argument(
            "Server name must be 1-40 chars and contain only letters, numbers, '_' or '-'",
        ));
    }

    let previous_row = crate::repositories::mcp_servers::find_by_name(&state.db, &name)
        .await
        .map_err(|e| AppError::db_error(&format!("Failed to load existing MCP config: {e}")))?;

    // Validate metadata before touching runtime state or secure storage.
    let transport = normalize_mcp_transport_for_storage(&input.config.transport);
    let command = input.config.command.clone();
    let args_json = serde_json::to_string(&input.config.args)
        .map_err(|e| AppError::invalid_argument(&format!("Invalid args: {e}")))?;
    let url = input.config.url.trim().to_string();
    let current_secret_keys: HashSet<String> = input
        .config
        .env
        .keys()
        .filter(|key| is_sensitive_env_key(key))
        .cloned()
        .collect();
    let current_header_secret_keys: HashSet<String> = input
        .config
        .headers
        .keys()
        .filter(|key| is_sensitive_header_key(key))
        .cloned()
        .collect();
    let previous_secret_values = if let Some(previous_row) = &previous_row {
        snapshot_mcp_env_secrets(&name, &previous_row.env_json, state.key_store.as_ref())?
    } else {
        HashMap::new()
    };
    let previous_header_secret_values = if let Some(previous_row) = &previous_row {
        snapshot_mcp_header_secrets(&name, &previous_row.headers_json, state.key_store.as_ref())?
    } else {
        HashMap::new()
    };

    let mut effective_env = input.config.env.clone();
    for key in &current_secret_keys {
        if effective_env.get(key).is_some_and(|value| value.is_empty()) {
            if let Some(previous_value) = previous_secret_values.get(key) {
                effective_env.insert(key.clone(), previous_value.clone());
            }
        }
    }
    let mut effective_headers = input.config.headers.clone();
    for key in &current_header_secret_keys {
        if effective_headers.get(key).is_some_and(|value| value.is_empty()) {
            if let Some(previous_value) = previous_header_secret_values.get(key) {
                effective_headers.insert(key.clone(), previous_value.clone());
            }
        }
    }

    let runtime_config = McpServerConfig {
        transport: transport.clone(),
        command: input.config.command.clone(),
        args: input.config.args.clone(),
        env: effective_env.clone(),
        url: input.config.url.clone(),
        headers: effective_headers.clone(),
    };

    // Validate/start the server process before mutating DB/secure-storage state.
    // This prevents a failed add from leaving a saved config that the UI reports as enabled/running.
    let mut manager = state.mcp_manager.lock().await;
    if let Err(error) = manager.add_server(name.clone(), runtime_config).await {
        return Err(AppError::invalid_argument(&error));
    }
    drop(manager);

    let env_json = match encode_mcp_env_for_storage(&name, &effective_env, state.key_store.as_ref()) {
        Ok(value) => value,
        Err(error) => {
            let mut manager = state.mcp_manager.lock().await;
            manager.remove_server(&name).await;
            delete_mcp_env_secret_keys(&name, &current_secret_keys, state.key_store.as_ref())?;
            delete_mcp_header_secret_keys(&name, &current_header_secret_keys, state.key_store.as_ref())?;
            restore_mcp_env_secrets(&name, &previous_secret_values, state.key_store.as_ref())?;
            restore_mcp_header_secrets(&name, &previous_header_secret_values, state.key_store.as_ref())?;
            if let Some(previous_row) = &previous_row {
                restore_mcp_runtime_from_row(&state, previous_row).await;
            }
            return Err(error);
        }
    };

    let headers_json = match encode_mcp_headers_for_storage(&name, &effective_headers, state.key_store.as_ref()) {
        Ok(value) => value,
        Err(error) => {
            let mut manager = state.mcp_manager.lock().await;
            manager.remove_server(&name).await;
            cleanup_mcp_env_secrets(&name, &env_json, state.key_store.as_ref(), &HashSet::new())?;
            delete_mcp_header_secret_keys(&name, &current_header_secret_keys, state.key_store.as_ref())?;
            restore_mcp_env_secrets(&name, &previous_secret_values, state.key_store.as_ref())?;
            restore_mcp_header_secrets(&name, &previous_header_secret_values, state.key_store.as_ref())?;
            if let Some(previous_row) = &previous_row {
                restore_mcp_runtime_from_row(&state, previous_row).await;
            }
            return Err(error);
        }
    };

    let upsert_result = crate::repositories::mcp_servers::upsert(
        &state.db,
        &name,
        &transport,
        &command,
        &args_json,
        &env_json,
        &url,
        &headers_json,
        true,
    )
    .await;
    if let Err(error) = upsert_result {
        let mut manager = state.mcp_manager.lock().await;
        manager.remove_server(&name).await;
        cleanup_mcp_env_secrets(&name, &env_json, state.key_store.as_ref(), &HashSet::new())?;
        cleanup_mcp_header_secrets(&name, &headers_json, state.key_store.as_ref(), &HashSet::new())?;
        restore_mcp_env_secrets(&name, &previous_secret_values, state.key_store.as_ref())?;
        restore_mcp_header_secrets(&name, &previous_header_secret_values, state.key_store.as_ref())?;
        if let Some(previous_row) = &previous_row {
            restore_mcp_runtime_from_row(&state, previous_row).await;
        }
        return Err(AppError::db_error(&format!(
            "Failed to save MCP config: {error}"
        )));
    }

    if let Some(previous_row) = previous_row {
        cleanup_mcp_env_secrets(
            &name,
            &previous_row.env_json,
            state.key_store.as_ref(),
            &current_secret_keys,
        )?;
        cleanup_mcp_header_secrets(
            &name,
            &previous_row.headers_json,
            state.key_store.as_ref(),
            &current_header_secret_keys,
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_mcp_server(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), AppError> {
    let app_data_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::db_error(&format!("Failed to resolve app data dir: {e}")))?;

    let raw_json = std::fs::read_to_string(
        crate::services::mcp_config_file::mcps_json_path(&app_data_dir),
    )
    .map_err(|e| AppError::db_error(&format!("Failed to read mcps.json: {e}")))?;

    let mut parsed: serde_json::Value = serde_json::from_str(&raw_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid mcps.json: {e}")))?;

    let server_map = crate::services::mcp_config_file::extract_server_map_mut(&mut parsed)
        .ok_or_else(|| AppError::not_found("No server map found in mcps.json"))?;

    if server_map.remove(&name).is_none() {
        return Err(AppError::not_found(&format!("MCP server not found: {name}")));
    }

    let new_json = serde_json::to_string_pretty(&parsed)
        .map_err(|e| AppError::db_error(&format!("Failed to serialize mcps.json: {e}")))?;
    crate::services::mcp_config_file::save_mcp_config_file(&app_data_dir, &new_json)
        .map_err(|e| AppError::db_error(&format!("Failed to save mcps.json: {e}")))?;

    // Stop and remove from runtime
    let mut manager = state.mcp_manager.lock().await;
    manager.remove_server(&name).await;

    tracing::info!(cmd = "remove_mcp_server", server = %name, "ok");
    Ok(())
}

#[tauri::command]
pub async fn get_mcp_tool_definitions(
    state: State<'_, AppState>,
) -> Result<Vec<crate::dto::common::ToolDefinitionDto>, AppError> {
    Ok(crate::commands::streaming::build_backend_enabled_tool_definitions(&state)
        .await
        .into_iter()
        .filter(|definition| definition.function.name.starts_with("mcp__"))
        .collect())
}

#[tauri::command]
pub async fn set_mcp_server_enabled(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<bool, AppError> {
    let app_data_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::db_error(&format!("Failed to resolve app data dir: {e}")))?;

    // Read current mcps.json
    let raw_json = std::fs::read_to_string(
        crate::services::mcp_config_file::mcps_json_path(&app_data_dir),
    )
    .map_err(|e| AppError::db_error(&format!("Failed to read mcps.json: {e}")))?;

    let mut parsed: serde_json::Value = serde_json::from_str(&raw_json)
        .map_err(|e| AppError::invalid_argument(format!("Invalid mcps.json: {e}")))?;

    // Find the server entry
    let server_obj = crate::services::mcp_config_file::extract_server_map_mut(&mut parsed)
        .and_then(|map| map.get_mut(&name))
        .ok_or_else(|| AppError::not_found(&format!("MCP server not found: {name}")))?;

    if enabled {
        server_obj.as_object_mut().map(|o| o.remove("disabled"));
    } else {
        server_obj.as_object_mut().map(|o| o.insert("disabled".to_string(), serde_json::Value::Bool(true)));
    }

    // Save updated file
    let new_json = serde_json::to_string_pretty(&parsed)
        .map_err(|e| AppError::db_error(&format!("Failed to serialize mcps.json: {e}")))?;
    crate::services::mcp_config_file::save_mcp_config_file(&app_data_dir, &new_json)
        .map_err(|e| AppError::db_error(&format!("Failed to save mcps.json: {e}")))?;

    // Reload only the affected server
    let mut manager = state.mcp_manager.lock().await;
    if enabled {
        // Parse the server config from the saved JSON and start it
        let smap = parsed.get("mcpServers")
            .or_else(|| parsed.get("servers"))
            .and_then(|v| v.as_object())
            .or_else(|| parsed.as_object());
        if let Some(smap) = smap {
            if let Some(config_value) = smap.get(&name) {
                let transport_raw = config_value.get("transport")
                    .or_else(|| config_value.get("type"))
                    .and_then(|v| v.as_str()).unwrap_or("stdio");
                let transport = crate::services::mcp_client::normalize_mcp_transport(transport_raw);
                let command = config_value.get("command")
                    .and_then(|v| v.as_str()).unwrap_or("").to_string();
                let args: Vec<String> = config_value.get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let url = config_value.get("url")
                    .and_then(|v| v.as_str()).unwrap_or("").to_string();
                let env = config_value.get("env")
                    .and_then(|v| v.as_object())
                    .map(|obj| obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect())
                    .unwrap_or_default();
                let headers = config_value.get("headers")
                    .and_then(|v| v.as_object())
                    .map(|obj| obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect())
                    .unwrap_or_default();

                let config = crate::services::mcp_client::McpServerConfig {
                    transport, command, args, env, url, headers,
                };

                match manager.add_server(name.clone(), config).await {
                    Ok(()) => tracing::info!(server = %name, "MCP server re-enabled"),
                    Err(e) => tracing::warn!(server = %name, error = %e, "Failed to start re-enabled MCP server"),
                }
            }
        }
    } else {
        // Just stop the single server
        manager.remove_server(&name).await;
        tracing::info!(server = %name, "MCP server disabled and stopped");
    }

    tracing::info!(cmd = "set_mcp_server_enabled", server = %name, enabled, "ok");
    Ok(true)
}

/**
 * Reload all persisted MCP servers from database on startup.
 * Silently skips servers that fail to connect.
 */
/**
 * Reload MCP servers from mcps.json file (or migrate from SQLite on first run).
 */
pub async fn reload_mcp_servers_from_file(
    app_handle: &tauri::AppHandle,
    db: &sqlx::SqlitePool,
    _key_store: &dyn crate::state::SecureKeyStore,
    mcp_manager: &std::sync::Arc<tokio::sync::Mutex<crate::services::mcp_client::McpManager>>,
) {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to resolve app data directory");

    use crate::services::mcp_config_file;

    // Migration: if mcps.json doesn't exist but SQLite has servers, export first
    let mcps_path = mcp_config_file::mcps_json_path(&app_dir);
    if !mcps_path.exists() {
        if let Ok(rows) = crate::repositories::mcp_servers::list_all(db).await {
            if !rows.is_empty() {
                let json = mcp_config_file::export_sqlite_to_mcps_json(&rows);
                if let Err(e) = mcp_config_file::save_mcp_config_file(&app_dir, &json) {
                    tracing::warn!("Failed to export MCP servers to mcps.json: {e}");
                } else {
                    tracing::info!(count = rows.len(), "Migrated MCP servers from SQLite to mcps.json");
                }
            }
        }
    }

    let result = mcp_config_file::load_mcp_config_file(&app_dir);

    for err in &result.parse_errors {
        tracing::warn!("MCP config: {err}");
    }

    if result.servers.is_empty() {
        return;
    }

    tracing::info!(count = result.servers.len(), "Loading MCP servers from mcps.json...");

    let mut manager = mcp_manager.lock().await;
    for server in &result.servers {
        let config_value = &server.config;

        // Extract fields from JSON value, tolerating missing/wrong types
        let transport_raw = config_value.get("transport")
            .or_else(|| config_value.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("stdio");
        let transport = crate::services::mcp_client::normalize_mcp_transport(transport_raw);
        let command = config_value.get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args: Vec<String> = config_value.get("args")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let url = config_value.get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let disabled = config_value.get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if disabled {
            tracing::info!(server = %server.name, "MCP server is disabled; skipping");
            continue;
        }

        // For env and headers, extract as plain string maps
        // Sensitive values stored in keyring are NOT used in file mode
        // Users should put real values directly in the JSON (or use env var references)
        let env = config_value.get("env")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<String, String>>()
            )
            .unwrap_or_default();
        let headers = config_value.get("headers")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<String, String>>()
            )
            .unwrap_or_default();

        let config = crate::services::mcp_client::McpServerConfig {
            transport,
            command,
            args,
            env,
            url,
            headers,
        };

        match manager.add_server(server.name.clone(), config.clone()).await {
            Ok(()) => {
                tracing::info!(server = %server.name, "MCP server loaded from file");
            }
            Err(e) => {
                tracing::warn!(server = %server.name, error = %e, "Failed to start MCP server");
            }
        }
    }
}

#[tauri::command]
pub async fn get_mcp_config_json(
    app_handle: tauri::AppHandle,
) -> Result<String, AppError> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_argument(format!("Failed to resolve app data dir: {e}")))?;

    use crate::services::mcp_config_file;
    let path = mcp_config_file::mcps_json_path(&app_dir);

    if !path.exists() {
        // Return empty template
        return Ok("{\n  \"mcpServers\": {}\n}".to_string());
    }

    std::fs::read_to_string(&path)
        .map_err(|e| AppError::invalid_argument(format!("Failed to read mcps.json: {e}")))
}

#[tauri::command]
pub async fn save_mcp_config_json(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    json_content: String,
) -> Result<String, AppError> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_argument(format!("Failed to resolve app data dir: {e}")))?;

    use crate::services::mcp_config_file;

    mcp_config_file::save_mcp_config_file(&app_dir, &json_content)
        .map_err(|e| AppError::invalid_argument(e))?;

    // Reload all servers from the updated file
    reload_mcp_servers_from_file(&app_handle, &state.db, state.key_store.as_ref(), &state.mcp_manager).await;

    // Return validation info
    let result = mcp_config_file::load_mcp_config_file(&app_dir);
    let mut info = Vec::new();
    for server in &result.servers {
        info.push(format!("✓ {}", server.name));
    }
    for err in &result.parse_errors {
        info.push(format!("⚠ {err}"));
    }
    Ok(info.join("\n"))
}
