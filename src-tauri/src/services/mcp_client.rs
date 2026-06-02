/**
 * @file services/mcp_client.rs
 * @description MCP (Model Context Protocol) client implementation using the official rmcp SDK.
 *
 * Uses the `rmcp` crate (Model Context Protocol Rust SDK) for protocol handling.
 * Supports stdio transport (child process) and Streamable HTTP transport.
 */

use std::collections::HashMap;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;

use rmcp::ServiceExt;
use rmcp::service::{RoleClient, RunningService};

// ============================================================================
// MCP Config & Types (public interface preserved)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(default = "default_mcp_transport")]
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

fn default_mcp_transport() -> String {
    "stdio".to_string()
}

pub fn normalize_mcp_transport(transport: &str) -> String {
    match transport.trim().to_ascii_lowercase().as_str() {
        "" | "stdio" => "stdio".to_string(),
        "http" | "streamable_http" | "streamable-http" | "streamablehttp" => {
            "streamable_http".to_string()
        }
        "sse" | "legacy_sse" | "legacy-sse" => "sse".to_string(),
        other => other.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPromptDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub arguments: Vec<McpPromptArgument>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPromptArgument {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPromptMessage {
    pub role: String,
    pub content: McpPromptContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum McpPromptContent {
    #[serde(rename = "text")]
    Text { text: String },
}

#[derive(Debug)]
pub struct McpServerState {
    pub name: String,
    pub status: McpServerStatus,
    pub tools: Vec<McpToolDef>,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum McpServerStatus {
    Stopped,
    Starting,
    Running,
    Error(String),
}

// ============================================================================
// Type-erased running service
// ============================================================================

type DynRunningService = RunningService<RoleClient, Box<dyn rmcp::service::DynService<RoleClient>>>;

// ============================================================================
// Managed Client — wraps rmcp RunningService
// ============================================================================

struct ManagedClient {
    service: DynRunningService,
    _config: McpServerConfig,
    cached_tools: Vec<McpToolDef>,
}

impl ManagedClient {
    async fn connect(name: &str, config: &McpServerConfig) -> Result<Self, String> {
        let transport_type = normalize_mcp_transport(&config.transport);

        let service: DynRunningService = match transport_type.as_str() {
            "stdio" => {
                if config.command.trim().is_empty() {
                    return Err("stdio MCP transport requires a command".to_string());
                }

                let mut cmd = Command::new(&config.command);
                cmd.args(&config.args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                #[cfg(target_os = "windows")]
                {
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    #[allow(unused_imports)]
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(CREATE_NO_WINDOW);
                }

                for (k, v) in &config.env {
                    cmd.env(k, v);
                }

                let transport = rmcp::transport::TokioChildProcess::new(cmd)
                    .map_err(|e| format!("Failed to create stdio transport: {e}"))?;

                ().into_dyn()
                    .serve(transport)
                    .await
                    .map_err(|e| format!("MCP stdio init failed for '{name}': {e}"))?
            }
            "streamable_http" | "sse" => {
                if config.url.trim().is_empty() {
                    return Err(format!("{} MCP transport requires a url", transport_type));
                }

                // For custom headers, build a reqwest client with default headers.
                // rmcp re-exports reqwest through its transport modules.
                let transport = if config.headers.is_empty() {
                    rmcp::transport::StreamableHttpClientTransport::from_uri(
                        config.url.trim(),
                    )
                } else {
                    let mut headers = reqwest::header::HeaderMap::new();
                    for (key, value) in &config.headers {
                        let hdr_name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
                            .map_err(|e| format!("Invalid header name '{key}': {e}"))?;
                        let hdr_val = reqwest::header::HeaderValue::from_str(value)
                            .map_err(|e| format!("Invalid header value for '{key}': {e}"))?;
                        headers.insert(hdr_name, hdr_val);
                    }
                    let client = reqwest::Client::builder()
                        .default_headers(headers)
                        .build()
                        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
                    let cfg = rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(
                        config.url.trim(),
                    );
                    rmcp::transport::StreamableHttpClientTransport::with_client(client, cfg)
                };

                ().into_dyn()
                    .serve(transport)
                    .await
                    .map_err(|e| format!("MCP {} init failed for '{name}': {e}", transport_type))?
            }
            other => {
                return Err(format!("Unsupported MCP transport: {other}"));
            }
        };

        let mut client = ManagedClient {
            service,
            _config: config.clone(),
            cached_tools: Vec::new(),
        };

        client.refresh_tools().await?;
        Ok(client)
    }

    async fn refresh_tools(&mut self) -> Result<(), String> {
        let tools = self.service.list_all_tools().await
            .map_err(|e| format!("Failed to list MCP tools: {e}"))?;

        self.cached_tools = tools.into_iter().map(|t| McpToolDef {
            name: t.name.to_string(),
            description: t.description.map(|d| d.to_string()),
            input_schema: Some(Value::Object(t.input_schema.as_ref().clone())),
        }).collect();

        Ok(())
    }

    async fn call_tool(&self, name: &str, arguments: Value) -> Result<String, String> {
        let args: Option<serde_json::Map<String, Value>> = arguments.as_object()
            .map(|m| m.clone());

        let params = if let Some(args) = args {
            rmcp::model::CallToolRequestParams::new(name.to_string())
                .with_arguments(args)
        } else {
            rmcp::model::CallToolRequestParams::new(name.to_string())
        };

        let result = self.service.call_tool(params).await
            .map_err(|e| format!("MCP tool call '{name}' failed: {e}"))?;

        let texts: Vec<String> = result.content.iter()
            .filter_map(|c| c.as_text().map(|t| t.text.to_string()))
            .collect();

        if !texts.is_empty() {
            Ok(texts.join("\n"))
        } else {
            Ok(serde_json::to_string_pretty(&result)
                .unwrap_or_else(|_| "Tool completed but returned no text content".to_string()))
        }
    }

    async fn shutdown(self) {
        let _ = self.service.cancel().await;
    }
}

// ============================================================================
// MCP Manager
// ============================================================================

pub struct McpManager {
    clients: HashMap<String, ManagedClient>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    pub async fn add_server(
        &mut self,
        name: String,
        config: McpServerConfig,
    ) -> Result<(), String> {
        let client = ManagedClient::connect(&name, &config).await?;

        tracing::info!(
            server = %name,
            tools_count = client.cached_tools.len(),
            "MCP server connected via rmcp SDK"
        );

        if let Some(old) = self.clients.remove(&name) {
            old.shutdown().await;
        }

        self.clients.insert(name, client);
        Ok(())
    }

    pub async fn remove_server(&mut self, name: &str) {
        if let Some(client) = self.clients.remove(name) {
            client.shutdown().await;
        }
    }

    pub fn all_tools(&self) -> Vec<(String, McpToolDef)> {
        let mut tools = Vec::new();
        for (name, client) in &self.clients {
            for tool in &client.cached_tools {
                tools.push((name.clone(), tool.clone()));
            }
        }
        tools
    }

    pub fn all_prompts(&self) -> Vec<(String, McpPromptDef)> {
        Vec::new()
    }

    pub async fn call_tool(
        &mut self,
        server_name: &str,
        tool_name: &str,
        arguments: Value,
    ) -> Result<String, String> {
        let client = self.clients.get(server_name)
            .ok_or_else(|| format!("MCP server '{server_name}' not found"))?;
        client.call_tool(tool_name, arguments).await
    }

    pub async fn get_prompt(
        &mut self,
        _server_name: &str,
        _prompt_name: &str,
        _arguments: HashMap<String, String>,
    ) -> Result<Vec<McpPromptMessage>, String> {
        Err("Prompt support via rmcp SDK is not yet implemented".to_string())
    }

    pub fn server_states(&self) -> Vec<McpServerState> {
        self.clients.iter().map(|(name, client)| {
            McpServerState {
                name: name.clone(),
                status: McpServerStatus::Running,
                tools: client.cached_tools.clone(),
            }
        }).collect()
    }

    #[allow(dead_code)]
    pub async fn stop_all(&mut self) {
        let clients = std::mem::take(&mut self.clients);
        for (_, client) in clients {
            client.shutdown().await;
        }
    }
}
