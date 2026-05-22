/**
 * @file services/mcp_client.rs
 * @description MCP (Model Context Protocol) client implementation.
 *
 * Implements the MCP JSON-RPC 2.0 client that communicates with MCP servers
 * over stdio transport (subprocess stdin/stdout) or Streamable HTTP.
 *
 * Configuration format (Claude Desktop compatible):
 * ```json
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *       "env": {}
 *     }
 *   }
 * }
 * ```
 *
 * Lifecycle:
 *   1. Start server process → spawn child with stdin/stdout piped
 *   2. Send "initialize" → receive capabilities
 *   3. Send "notifications/initialized"
 *   4. Call "tools/list" → discover available tools
 *   5. Call "tools/call" → execute tools via the server
 *   6. Shutdown on drop or explicit close
 *
 * Message format (stdio):
 *   Each JSON-RPC message is a single line terminated by \n
 */

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const MCP_REQUEST_TIMEOUT_SECONDS: u64 = 60;
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

// ============================================================================
// JSON-RPC Types
// ============================================================================

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i64,
    message: String,
}

fn parse_http_json_rpc_response(body: &str) -> Result<JsonRpcResponse, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("empty response body".to_string());
    }

    if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(trimmed) {
        return Ok(response);
    }

    // Streamable HTTP may answer as SSE. We only need the JSON-RPC data event
    // for request/response calls; long-lived GET event streams are out of scope.
    let mut data_lines = Vec::new();
    for line in trimmed.lines() {
        let Some(data) = line.trim_start().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        data_lines.push(data.to_string());
    }

    if data_lines.is_empty() {
        return Err("response is neither JSON nor SSE data".to_string());
    }

    serde_json::from_str::<JsonRpcResponse>(&data_lines.join("\n"))
        .map_err(|e| format!("failed to parse SSE JSON-RPC payload: {e}"))
}

// ============================================================================
// MCP Protocol Types
// ============================================================================

/// Per-server configuration, matching Claude Desktop's JSON schema.
///
/// The server name is the key in the `mcpServers` map, not a field here.
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

fn normalize_mcp_transport(transport: &str) -> String {
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

/// Shared state for routing JSON-RPC responses to waiting request handlers.
struct PendingMap {
    map: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
}

// SAFETY: The PendingMap is only accessed from the reader task and the
// send_request method, both of which run on the Tokio runtime. The
// Mutex ensures exclusive access.
unsafe impl Send for PendingMap {}
unsafe impl Sync for PendingMap {}

// ============================================================================
// MCP Client
// ============================================================================

/// Manages a single MCP server connection over stdio.
pub struct McpClient {
    server_name: String,
    config: McpServerConfig,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    http_client: reqwest::Client,
    http_session_id: Option<String>,
    http_running: bool,
    pending: Arc<Mutex<PendingMap>>,
    next_id: Arc<AtomicU64>,
    tools: Vec<McpToolDef>,
    prompts: Vec<McpPromptDef>,
    reader_handle: Option<tokio::task::JoinHandle<()>>,
    stderr_handle: Option<tokio::task::JoinHandle<()>>,
}

impl McpClient {
    pub fn new(server_name: String, config: McpServerConfig) -> Self {
        Self {
            server_name,
            config,
            child: None,
            stdin: None,
            http_client: reqwest::Client::new(),
            http_session_id: None,
            http_running: false,
            pending: Arc::new(Mutex::new(PendingMap {
                map: HashMap::new(),
            })),
            next_id: Arc::new(AtomicU64::new(1)),
            tools: Vec::new(),
            prompts: Vec::new(),
            reader_handle: None,
            stderr_handle: None,
        }
    }

    /// Drain stderr so a noisy MCP subprocess cannot block on a full pipe.
    fn spawn_stderr_drain(
        server_name: String,
        stderr: ChildStderr,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            let mut logged_lines = 0usize;
            while let Ok(Some(line)) = lines.next_line().await {
                if logged_lines < 20 {
                    let preview: String = line.chars().take(500).collect();
                    tracing::debug!(
                        server = %server_name,
                        stderr = %preview,
                        truncated = line.chars().count() > 500,
                        "MCP server stderr"
                    );
                    logged_lines += 1;
                }
            }
        })
    }

    /// Start the MCP server process and perform initialization handshake.
    pub async fn start(&mut self) -> Result<(), String> {
        match normalize_mcp_transport(&self.config.transport).as_str() {
            "stdio" => self.start_stdio().await,
            "streamable_http" => self.start_streamable_http().await,
            "sse" => Err(
                "Legacy HTTP+SSE MCP transport is not implemented yet; use Streamable HTTP"
                    .to_string(),
            ),
            other => Err(format!("Unsupported MCP transport: {other}")),
        }
    }

    async fn start_stdio(&mut self) -> Result<(), String> {
        if self.config.command.trim().is_empty() {
            return Err("stdio MCP transport requires a command".to_string());
        }

        let mut cmd = Command::new(&self.config.command);
        cmd.args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // On Windows, prevent the child process from creating a visible console window.
        #[cfg(target_os = "windows")]
        {
            #[allow(unused_imports)]
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        for (k, v) in &self.config.env {
            cmd.env(k, v);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| {
                format!(
                    "Failed to spawn MCP server '{}': {}",
                    self.server_name, e
                )
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get stdin handle".to_string())?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to get stdout handle".to_string())?;

        let stderr = child.stderr.take();

        self.stdin = Some(stdin);
        self.child = Some(child);
        if let Some(stderr) = stderr {
            self.stderr_handle = Some(Self::spawn_stderr_drain(
                self.server_name.clone(),
                stderr,
            ));
        }

        // Start the response reader task
        let pending = self.pending.clone();
        let reader = BufReader::new(stdout);
        let handle = tokio::spawn(async move {
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let response: JsonRpcResponse = match serde_json::from_str(&line) {
                    Ok(r) => r,
                    Err(_) => continue,
                };

                let id = match response.id {
                    Some(id) => id,
                    None => continue,
                };

                let mut guard = pending.lock().await;
                if let Some(tx) = guard.map.remove(&id) {
                    let result = if let Some(error) = response.error {
                        Err(error.message)
                    } else {
                        Ok(response.result.unwrap_or(Value::Null))
                    };
                    let _ = tx.send(result);
                }
            }
        });

        self.reader_handle = Some(handle);

        // Send initialize request
        let init_result = self
            .send_request(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "GetChat",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .await?;

        tracing::info!(
            server = %self.server_name,
            result = ?init_result,
            "MCP server initialized"
        );

        // Send initialized notification
        self.send_notification("notifications/initialized", json!({}))
            .await?;

        // Discover tools
        self.discover_tools().await?;

        // Discover prompts (non-fatal if not supported)
        if let Err(e) = self.discover_prompts().await {
            tracing::debug!(
                server = %self.server_name,
                error = %e,
                "MCP server does not support prompts (this is normal)"
            );
        }

        tracing::info!(
            server = %self.server_name,
            tools_count = self.tools.len(),
            prompts_count = self.prompts.len(),
            "MCP server ready"
        );

        Ok(())
    }

    async fn start_streamable_http(&mut self) -> Result<(), String> {
        if self.config.url.trim().is_empty() {
            return Err("Streamable HTTP MCP transport requires a url".to_string());
        }

        let init_result = self
            .send_request(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "GetChat",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .await?;

        tracing::info!(
            server = %self.server_name,
            result = ?init_result,
            "HTTP MCP server initialized"
        );

        self.send_notification("notifications/initialized", json!({}))
            .await?;
        self.discover_tools().await?;
        if let Err(e) = self.discover_prompts().await {
            tracing::debug!(
                server = %self.server_name,
                error = %e,
                "HTTP MCP server does not support prompts (this is normal)"
            );
        }
        self.http_running = true;
        Ok(())
    }

    pub async fn discover_tools(&mut self) -> Result<(), String> {
        let result = self.send_request("tools/list", json!({})).await?;

        let tools: Vec<McpToolDef> = result
            .get("tools")
            .and_then(|t| serde_json::from_value(t.clone()).ok())
            .unwrap_or_default();

        self.tools = tools;
        Ok(())
    }

    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: Value,
    ) -> Result<String, String> {
        let result = self
            .send_request(
                "tools/call",
                json!({
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await?;

        if let Some(content) = result.get("content").and_then(Value::as_array) {
            let texts: Vec<String> = content
                .iter()
                .filter_map(|c| {
                    if c.get("type").and_then(Value::as_str) == Some("text") {
                        c.get("text")
                            .and_then(Value::as_str)
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            if !texts.is_empty() {
                return Ok(texts.join("\n"));
            }
        }

        Ok(serde_json::to_string_pretty(&result)
            .unwrap_or_else(|_| "Tool completed but returned no text content".to_string()))
    }

    #[allow(dead_code)]
    pub fn tools(&self) -> &[McpToolDef] {
        &self.tools
    }

    #[allow(dead_code)]
    pub fn config(&self) -> &McpServerConfig {
        &self.config
    }

    pub async fn discover_prompts(&mut self) -> Result<(), String> {
        let result = self.send_request("prompts/list", json!({})).await?;

        let prompts: Vec<McpPromptDef> = result
            .get("prompts")
            .and_then(|p| serde_json::from_value(p.clone()).ok())
            .unwrap_or_default();

        self.prompts = prompts;
        Ok(())
    }

    pub async fn get_prompt(
        &mut self,
        name: &str,
        arguments: HashMap<String, String>,
    ) -> Result<Vec<McpPromptMessage>, String> {
        let result = self
            .send_request(
                "prompts/get",
                json!({
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await?;

        let messages: Vec<McpPromptMessage> = result
            .get("messages")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();

        Ok(messages)
    }

    pub fn is_running(&self) -> bool {
        self.child.is_some() || self.http_running
    }

    async fn send_request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if normalize_mcp_transport(&self.config.transport) == "streamable_http" {
            return self.send_http_request(method, params).await;
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.map.insert(id, tx);
        }

        let mut line = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {e}"))?;
        line.push('\n');

        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "Server stdin not available".to_string())?;

        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            let mut guard = self.pending.lock().await;
            guard.map.remove(&id);
            return Err(format!("Failed to write to server stdin: {e}"));
        }

        if let Err(e) = stdin.flush().await {
            let mut guard = self.pending.lock().await;
            guard.map.remove(&id);
            return Err(format!("Failed to flush stdin: {e}"));
        }

        match tokio::time::timeout(
            std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECONDS),
            rx,
        )
        .await
        {
            Ok(result) => result.map_err(|_| "Response channel closed".to_string())?,
            Err(_) => {
                let mut guard = self.pending.lock().await;
                guard.map.remove(&id);
                Err(format!(
                    "MCP request '{}' timed out after {} seconds",
                    method, MCP_REQUEST_TIMEOUT_SECONDS
                ))
            }
        }
    }

    fn build_http_headers(&self) -> Result<HeaderMap, String> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/event-stream"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            HeaderName::from_static("mcp-protocol-version"),
            HeaderValue::from_static(MCP_PROTOCOL_VERSION),
        );
        if let Some(session_id) = &self.http_session_id {
            headers.insert(
                HeaderName::from_static("mcp-session-id"),
                HeaderValue::from_str(session_id)
                    .map_err(|e| format!("Invalid MCP session id header: {e}"))?,
            );
        }
        for (key, value) in &self.config.headers {
            let header_name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|e| format!("Invalid MCP HTTP header name '{key}': {e}"))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|e| format!("Invalid MCP HTTP header value for '{key}': {e}"))?;
            headers.insert(header_name, header_value);
        }
        Ok(headers)
    }

    async fn send_http_request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };

        let response = self
            .http_client
            .post(self.config.url.trim())
            .headers(self.build_http_headers()?)
            .timeout(std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECONDS))
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("HTTP MCP request '{method}' failed: {e}"))?;

        if let Some(session_id) = response.headers().get("mcp-session-id") {
            if let Ok(value) = session_id.to_str() {
                self.http_session_id = Some(value.to_string());
            }
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read HTTP MCP response: {e}"))?;
        if !status.is_success() {
            let preview: String = body.chars().take(500).collect();
            return Err(format!(
                "HTTP MCP request '{method}' failed with status {status}: {preview}"
            ));
        }

        let rpc_response = parse_http_json_rpc_response(&body)
            .map_err(|e| format!("Invalid HTTP MCP response for '{method}': {e}"))?;
        if rpc_response.id != Some(id) {
            tracing::debug!(
                server = %self.server_name,
                method,
                expected_id = id,
                response_id = ?rpc_response.id,
                "HTTP MCP response id did not match request id"
            );
        }
        if let Some(error) = rpc_response.error {
            Err(error.message)
        } else {
            Ok(rpc_response.result.unwrap_or(Value::Null))
        }
    }

    async fn send_notification(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<(), String> {
        if normalize_mcp_transport(&self.config.transport) == "streamable_http" {
            let notification = json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            });
            let response = self
                .http_client
                .post(self.config.url.trim())
                .headers(self.build_http_headers()?)
                .timeout(std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECONDS))
                .json(&notification)
                .send()
                .await
                .map_err(|e| format!("HTTP MCP notification '{method}' failed: {e}"))?;
            if let Some(session_id) = response.headers().get("mcp-session-id") {
                if let Ok(value) = session_id.to_str() {
                    self.http_session_id = Some(value.to_string());
                }
            }
            if !response.status().is_success() {
                return Err(format!(
                    "HTTP MCP notification '{method}' failed with status {}",
                    response.status()
                ));
            }
            return Ok(());
        }

        let notification = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });

        let mut line = serde_json::to_string(&notification)
            .map_err(|e| format!("Serialize error: {e}"))?;
        line.push('\n');

        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "Server stdin not available".to_string())?;

        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Write error: {e}"))?;

        stdin
            .flush()
            .await
            .map_err(|e| format!("Flush error: {e}"))?;

        Ok(())
    }

    pub async fn stop(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.child = None;
        self.stdin = None;
        self.http_running = false;
        self.http_session_id = None;
        self.tools.clear();
        {
            let mut guard = self.pending.lock().await;
            guard.map.clear();
        }
        if let Some(handle) = self.reader_handle.take() {
            handle.abort();
        }
        if let Some(handle) = self.stderr_handle.take() {
            handle.abort();
        }
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
        if let Some(handle) = self.reader_handle.take() {
            handle.abort();
        }
    }
}

// ============================================================================
// MCP Manager
// ============================================================================

/// Manages multiple MCP server connections, keyed by server name.
pub struct McpManager {
    clients: HashMap<String, McpClient>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    /// Add and start an MCP server. The `name` is used as both the map key
    /// and the tool namespace prefix (`mcp__{name}__{tool}`).
    pub async fn add_server(
        &mut self,
        name: String,
        config: McpServerConfig,
    ) -> Result<(), String> {
        let mut client = McpClient::new(name, config);
        client.start().await?;

        if let Some(mut existing) = self.clients.remove(&client.server_name) {
            existing.stop().await;
        }

        self.clients.insert(client.server_name.clone(), client);
        Ok(())
    }

    /// Stop and remove an MCP server by name.
    pub async fn remove_server(&mut self, name: &str) {
        if let Some(mut client) = self.clients.remove(name) {
            client.stop().await;
        }
    }

    /// Return all tools from all connected servers as (server_name, tool) pairs.
    pub fn all_tools(&self) -> Vec<(String, McpToolDef)> {
        let mut tools = Vec::new();
        for client in self.clients.values() {
            for tool in &client.tools {
                tools.push((client.server_name.clone(), tool.clone()));
            }
        }
        tools
    }

    /// Return all prompts from all connected servers as (server_name, prompt) pairs.
    pub fn all_prompts(&self) -> Vec<(String, McpPromptDef)> {
        let mut prompts = Vec::new();
        for client in self.clients.values() {
            for prompt in &client.prompts {
                prompts.push((client.server_name.clone(), prompt.clone()));
            }
        }
        prompts
    }

    /// Call a tool on a specific server.
    pub async fn call_tool(
        &mut self,
        server_name: &str,
        tool_name: &str,
        arguments: Value,
    ) -> Result<String, String> {
        let client = self
            .clients
            .get_mut(server_name)
            .ok_or_else(|| format!("MCP server '{server_name}' not found"))?;
        client.call_tool(tool_name, arguments).await
    }

    /// Get a prompt from a specific server with arguments.
    pub async fn get_prompt(
        &mut self,
        server_name: &str,
        prompt_name: &str,
        arguments: HashMap<String, String>,
    ) -> Result<Vec<McpPromptMessage>, String> {
        let client = self
            .clients
            .get_mut(server_name)
            .ok_or_else(|| format!("MCP server '{server_name}' not found"))?;
        client.get_prompt(prompt_name, arguments).await
    }

    /// Return the state of all managed servers for API responses.
    pub fn server_states(&self) -> Vec<McpServerState> {
        self.clients
            .values()
            .map(|client| McpServerState {
                name: client.server_name.clone(),
                status: if client.is_running() {
                    McpServerStatus::Running
                } else {
                    McpServerStatus::Stopped
                },
                tools: client.tools.clone(),
            })
            .collect()
    }

    #[allow(dead_code)]
    pub async fn stop_all(&mut self) {
        for client in self.clients.values_mut() {
            client.stop().await;
        }
        self.clients.clear();
    }
}
