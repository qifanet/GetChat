/**
 * @file services/mcp_config_file.rs
 * @description MCP server configuration file management.
 *
 * Manages the `mcps.json` configuration file in the app data directory.
 * This replaces the previous SQLite-based MCP server storage with a
 * simple JSON file approach that is more flexible and compatible with
 * other AI tools (Claude Desktop, Cursor, Windsurf).
 *
 * The file uses the standard `{ "mcpServers": { ... } }` format.
 * Format errors in individual servers are tolerated — the server is
 * skipped with a warning, but the rest of the config still loads.
 */

use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

const MCPS_FILENAME: &str = "mcps.json";

/// Parsed server entry from mcps.json.
#[derive(Debug, Clone)]
pub struct ParsedMcpServer {
    pub name: String,
    pub config: serde_json::Value,
    #[allow(dead_code)]
    pub error: Option<String>,
}

/// Result of loading the mcps.json file.
#[derive(Debug)]
pub struct McpConfigFileResult {
    pub servers: Vec<ParsedMcpServer>,
    #[allow(dead_code)]
    pub raw_json: String,
    pub parse_errors: Vec<String>,
}

/// The top-level structure expected in mcps.json.
#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
struct McpConfigRoot {
    #[serde(default)]
    mcp_servers: HashMap<String, serde_json::Value>,
}

/// Resolve the path to mcps.json.
pub fn mcps_json_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join(MCPS_FILENAME)
}

/// Load and parse mcps.json. Returns the result even if individual servers have errors.
pub fn load_mcp_config_file(app_data_dir: &PathBuf) -> McpConfigFileResult {
    let path = mcps_json_path(app_data_dir);
    let mut parse_errors = Vec::new();

    let raw_json = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return McpConfigFileResult {
                servers: Vec::new(),
                raw_json: String::new(),
                parse_errors: vec![format!("Config file not found: {}", path.display())],
            };
        }
        Err(e) => {
            return McpConfigFileResult {
                servers: Vec::new(),
                raw_json: String::new(),
                parse_errors: vec![format!("Failed to read {}: {}", path.display(), e)],
            };
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&raw_json) {
        Ok(v) => v,
        Err(e) => {
            return McpConfigFileResult {
                servers: Vec::new(),
                raw_json,
                parse_errors: vec![format!("Invalid JSON in {}: {}", MCPS_FILENAME, e)],
            };
        }
    };

    // Extract the server map from either { "mcpServers": { ... } } or a bare { ... }
    let server_map = extract_server_map(&parsed);
    let mut servers = Vec::new();

    for (name, value) in server_map {
        if name.trim().is_empty() {
            parse_errors.push("Skipping server with empty name".to_string());
            continue;
        }

        if !value.is_object() {
            parse_errors.push(format!("Skipping '{}': value must be an object", name));
            continue;
        }

        servers.push(ParsedMcpServer {
            name: name.trim().to_string(),
            config: value.clone(),
            error: None,
        });
    }

    McpConfigFileResult {
        servers,
        raw_json,
        parse_errors,
    }
}

/// Save raw JSON content to mcps.json. Validates JSON syntax before writing.
pub fn save_mcp_config_file(app_data_dir: &PathBuf, json_content: &str) -> Result<(), String> {
    // Validate JSON syntax
    let _: serde_json::Value = serde_json::from_str(json_content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let path = mcps_json_path(app_data_dir);

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }

    // Write atomically: write to temp file, then replace
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, json_content)
        .map_err(|e| format!("Failed to write {}: {}", temp_path.display(), e))?;

    // On Windows, rename fails if destination already exists — remove it first.
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to remove old {}: {}", path.display(), e))?;
    }
    std::fs::rename(&temp_path, &path)
        .map_err(|e| format!("Failed to rename {} -> {}: {}", temp_path.display(), path.display(), e))?;

    Ok(())
}

/// Export current SQLite MCP servers to mcps.json format.
pub fn export_sqlite_to_mcps_json(
    rows: &[crate::repositories::mcp_servers::McpServerRow],
) -> String {
    let mut mcp_servers = serde_json::Map::new();

    for row in rows {
        let mut server = serde_json::Map::new();

        if row.transport != "stdio" {
            server.insert("transport".to_string(), serde_json::Value::String(row.transport.clone()));
        }

        if !row.command.is_empty() {
            server.insert("command".to_string(), serde_json::Value::String(row.command.clone()));
        }

        let args: Vec<serde_json::Value> = serde_json::from_str(&row.args_json)
            .unwrap_or_default();
        if !args.is_empty() {
            server.insert("args".to_string(), serde_json::Value::Array(args));
        }

        let env: serde_json::Value = serde_json::from_str(&row.env_json)
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(map) = env {
            if !map.is_empty() {
                // Convert stored format { "key": {"kind":"plain","value":"x"} } → { "key": "x" }
                let plain_env: serde_json::Map<String, serde_json::Value> = map.into_iter()
                    .filter_map(|(k, v)| {
                        match v {
                            serde_json::Value::Object(obj) => {
                                match obj.get("kind").and_then(|k| k.as_str()) {
                                    Some("plain") => obj.get("value").cloned().map(|val| (k, val)),
                                    Some("secure") => Some((k, serde_json::Value::String("${KEYRING}".to_string()))),
                                    _ => None,
                                }
                            }
                            serde_json::Value::String(s) => Some((k, serde_json::Value::String(s))),
                            _ => None,
                        }
                    })
                    .collect();
                if !plain_env.is_empty() {
                    server.insert("env".to_string(), serde_json::Value::Object(plain_env));
                }
            }
        }

        if !row.url.is_empty() {
            server.insert("url".to_string(), serde_json::Value::String(row.url.clone()));
        }

        let headers: serde_json::Value = serde_json::from_str(&row.headers_json)
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(map) = headers {
            if !map.is_empty() {
                let plain_headers: serde_json::Map<String, serde_json::Value> = map.into_iter()
                    .filter_map(|(k, v)| {
                        match v {
                            serde_json::Value::Object(obj) => {
                                match obj.get("kind").and_then(|k| k.as_str()) {
                                    Some("plain") => obj.get("value").cloned().map(|val| (k, val)),
                                    Some("secure") => Some((k, serde_json::Value::String("${KEYRING}".to_string()))),
                                    _ => None,
                                }
                            }
                            serde_json::Value::String(s) => Some((k, serde_json::Value::String(s))),
                            _ => None,
                        }
                    })
                    .collect();
                if !plain_headers.is_empty() {
                    server.insert("headers".to_string(), serde_json::Value::Object(plain_headers));
                }
            }
        }

        if !row.enabled {
            server.insert("disabled".to_string(), serde_json::Value::Bool(true));
        }

        mcp_servers.insert(row.name.clone(), serde_json::Value::Object(server));
    }

    let root = serde_json::json!({ "mcpServers": mcp_servers });
    serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".to_string())
}

/// Extract server map from various JSON formats.
fn extract_server_map(parsed: &serde_json::Value) -> HashMap<String, serde_json::Value> {
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return HashMap::new(),
    };

    // Format 1: { "mcpServers": { ... } } or { "servers": { ... } }
    if let Some(servers_val) = obj.get("mcpServers").or_else(|| obj.get("servers")) {
        if let Some(map) = servers_val.as_object() {
            return map.clone().into_iter().collect();
        }
    }

    // Format 2: bare { "serverName": { ... }, ... }
    // Only treat as server map if values look like server configs
    let mut result = HashMap::new();
    for (key, value) in obj {
        if value.is_object() {
            let vobj = value.as_object().unwrap();
            // Heuristic: has "command" or "url" or "transport" → likely a server config
            let looks_like_server = vobj.contains_key("command")
                || vobj.contains_key("url")
                || vobj.contains_key("transport")
                || vobj.contains_key("args");
            if looks_like_server {
                result.insert(key.clone(), value.clone());
            }
        }
    }
    result
}

/// Extract mutable server map from parsed JSON (supports all three formats).
pub fn extract_server_map_mut(
    parsed: &mut serde_json::Value,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    let obj = parsed.as_object_mut()?;

    // Check for nested format keys: { "mcpServers": {...} } or { "servers": {...} }
    if obj.contains_key("mcpServers") {
        return obj.get_mut("mcpServers").and_then(|v| v.as_object_mut());
    }
    if obj.contains_key("servers") {
        return obj.get_mut("servers").and_then(|v| v.as_object_mut());
    }

    // Bare format: the top-level object IS the server map
    Some(obj)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_extract_mcp_servers_format() {
        let json = serde_json::json!({
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "@mcp/fs"] },
                "gh": { "transport": "streamable_http", "url": "https://api.github.com/mcp" }
            }
        });
        let map = extract_server_map(&json);
        assert_eq!(map.len(), 2);
        assert!(map.contains_key("fs"));
        assert!(map.contains_key("gh"));
    }

    #[test]
    fn test_extract_bare_format() {
        let json = serde_json::json!({
            "my-server": { "command": "node", "args": ["server.js"] }
        });
        let map = extract_server_map(&json);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("my-server"));
    }

    #[test]
    fn test_extract_skips_non_server_entries() {
        let json = serde_json::json!({
            "version": "1.0",
            "my-server": { "command": "node" },
            "notaserver": "just a string"
        });
        let map = extract_server_map(&json);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("my-server"));
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let dir = std::env::temp_dir();
        let test_dir = dir.join("getchat_test_mcp_config");
        let _ = std::fs::remove_dir_all(&test_dir);
        std::fs::create_dir_all(&test_dir).unwrap();

        let json = r#"{ "mcpServers": { "test": { "command": "echo" } } }"#;
        save_mcp_config_file(&test_dir, json).unwrap();

        let result = load_mcp_config_file(&test_dir);
        assert!(result.parse_errors.is_empty());
        assert_eq!(result.servers.len(), 1);
        assert_eq!(result.servers[0].name, "test");

        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn test_save_validates_json() {
        let dir = std::env::temp_dir().join("getchat_test_mcp_invalid");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let result = save_mcp_config_file(&dir, "not valid json {{{");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid JSON"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
