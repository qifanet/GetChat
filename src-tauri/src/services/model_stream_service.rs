/**
 * @file services/model_stream_service.rs
 * @description Runtime model streaming service that normalizes provider
 *              protocols into a single chunk/completion outcome contract.
 *
 * Supported transports:
 *   - OPENAI_COMPATIBLE: POST /chat/completions with SSE parsing
 *   - OLLAMA:
 *       - /v1/chat/completions when baseUrl ends with /v1
 *       - /api/chat with newline-delimited JSON otherwise
 *
 * Security constraints:
 *   - API keys are loaded from SecureKeyStore inside the backend only
 *   - The frontend never receives plaintext keys
 */

use std::time::Duration;

use reqwest::{
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Client, Response, StatusCode,
};
use serde_json::{json, Map, Value};
use sqlx::SqlitePool;
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::dto::common::{GenerationParamsDto, TokenUsageDto};
use crate::dto::streaming::{ModelPromptMessageDto, ModelStreamEventDto, StartModelStreamInput};
use crate::repositories::{provider_models, providers};
use crate::state::SecureKeyStore;

const MODEL_CONNECT_TIMEOUT_SECONDS: u64 = 10;
const MODEL_STREAM_TIMEOUT_SECONDS: u64 = 600;
const ERROR_BODY_PREVIEW_LIMIT: usize = 256;

/**
 * Provider-resolved stream request with secure credentials already loaded.
 *
 * This is intentionally kept internal so the command layer only passes around
 * validated, provider-ready runtime data.
 */
#[derive(Debug, Clone)]
pub struct ResolvedModelStreamRequest {
    pub request_id: String,
    pub provider_type: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model_id: String,
    pub request_model_name: String,
    pub prompt_messages: Vec<ModelPromptMessageDto>,
    pub generation_params: Option<GenerationParamsDto>,
}

/** Normalized terminal outcome of a provider streaming session. */
#[derive(Debug, Clone)]
pub enum ModelStreamOutcome {
    Completed { usage: Option<TokenUsageDto> },
    Cancelled,
}

/**
 * Structured runtime failure for model streaming.
 *
 * This is intentionally more specific than AppError because these failures are
 * shown to users as assistant-generation errors, not generic command failures.
 */
#[derive(Debug, Clone)]
pub struct ModelStreamFailure {
    pub code: String,
    pub message: String,
    pub retriable: bool,
}

impl ModelStreamFailure {
    /** Build a retriable runtime failure. */
    fn retriable(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retriable: true,
        }
    }

    /** Build a non-retriable runtime failure. */
    fn terminal(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retriable: false,
        }
    }

    /** Convert a runtime failure into the channel event shape used by the frontend. */
    pub fn to_event(&self, request_id: &str) -> ModelStreamEventDto {
        ModelStreamEventDto::Failed {
            request_id: request_id.to_string(),
            code: self.code.clone(),
            message: self.message.clone(),
            retriable: self.retriable,
        }
    }
}

/**
 * Resolve a frontend streaming request into a provider-ready backend request.
 *
 * This validates the provider, loads any required API key from secure storage,
 * and rejects obviously invalid requests before any network activity starts.
 */
pub async fn resolve_stream_request(
    pool: &SqlitePool,
    key_store: &dyn SecureKeyStore,
    input: &StartModelStreamInput,
) -> Result<ResolvedModelStreamRequest, ModelStreamFailure> {
    if input.request_id.trim().is_empty() {
        return Err(ModelStreamFailure::terminal(
            "INVALID_MODEL_REQUEST",
            "requestId is required",
        ));
    }

    if input.model_id.trim().is_empty() {
        return Err(ModelStreamFailure::terminal(
            "INVALID_MODEL_REQUEST",
            "modelId is required",
        ));
    }

    if input.prompt_messages.is_empty() {
        return Err(ModelStreamFailure::terminal(
            "INVALID_MODEL_REQUEST",
            "promptMessages must contain at least one message",
        ));
    }

    let provider = providers::find_by_id(pool, &input.provider_id)
        .await
        .map_err(|error| {
            ModelStreamFailure::retriable(
                "MODEL_PROVIDER_LOOKUP_FAILED",
                format!("Failed to load provider configuration: {error}"),
            )
        })?
        .ok_or_else(|| {
            ModelStreamFailure::terminal(
                "MODEL_PROVIDER_NOT_FOUND",
                "The selected provider no longer exists",
            )
        })?;

    if !provider.enabled {
        return Err(ModelStreamFailure::terminal(
            "MODEL_PROVIDER_DISABLED",
            "The selected provider is disabled",
        ));
    }

    let api_key = key_store.load(&provider.id).map_err(|error| {
        ModelStreamFailure::terminal(
            "PROVIDER_AUTH_LOAD_FAILED",
            format!("Failed to load provider credentials: {error}"),
        )
    })?;

    if provider.r#type != "OLLAMA" && api_key.is_none() {
        return Err(ModelStreamFailure::terminal(
            "PROVIDER_AUTH_FAILED",
            "No API key is configured for the selected provider",
        ));
    }

    let base_url = normalize_base_url(&provider.base_url);
    if base_url.is_empty() {
        return Err(ModelStreamFailure::terminal(
            "INVALID_MODEL_REQUEST",
            "Provider base URL is required",
        ));
    }

    let request_model_name = match provider_models::find_by_id(pool, &input.model_id).await {
        Ok(Some(model_profile)) => {
            if model_profile.provider_id != provider.id {
                return Err(ModelStreamFailure::terminal(
                    "MODEL_PROVIDER_MISMATCH",
                    "The selected model does not belong to the active provider",
                ));
            }

            model_profile.request_name
        }
        Ok(None) => input.model_id.clone(),
        Err(error) => {
            return Err(ModelStreamFailure::retriable(
                "MODEL_PROFILE_LOOKUP_FAILED",
                format!("Failed to load model profile: {error}"),
            ))
        }
    };

    Ok(ResolvedModelStreamRequest {
        request_id: input.request_id.clone(),
        provider_type: provider.r#type,
        base_url,
        api_key,
        model_id: input.model_id.clone(),
        request_model_name,
        prompt_messages: input.prompt_messages.clone(),
        generation_params: input.generation_params.clone(),
    })
}

/**
 * Execute a provider stream and emit normalized chunk events to the frontend.
 *
 * The frontend remains responsible for:
 *   - accumulating chunks in the runtime registry
 *   - committing final text to SQLite through complete_assistant_message
 *   - persisting failure state through fail_assistant_message
 */
pub async fn stream_model_response(
    request: &ResolvedModelStreamRequest,
    channel: &Channel<ModelStreamEventDto>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<ModelStreamOutcome, ModelStreamFailure> {
    let result = tokio::time::timeout(
        Duration::from_secs(MODEL_STREAM_TIMEOUT_SECONDS),
        async {
            if request.provider_type == "OLLAMA" {
                return stream_ollama_response(request, channel, cancel_rx).await;
            }
            let endpoint = build_openai_chat_completions_url(&request.base_url);
            stream_openai_compatible_response(request, &endpoint, channel, cancel_rx).await
        },
    )
    .await;
    match result {
        Ok(inner) => inner,
        Err(_) => Err(ModelStreamFailure::retriable(
            "MODEL_STREAM_TIMEOUT",
            format!("Generation timed out after {} seconds", MODEL_STREAM_TIMEOUT_SECONDS),
        )),
    }
}

/** Normalize a configured base URL so endpoint builders can append paths safely. */
fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

/** Convert stored prompt roles into provider-compatible lowercase values. */
fn normalize_prompt_role(role: &str) -> &str {
    match role {
        "SYSTEM" => "system",
        "USER" => "user",
        "ASSISTANT" => "assistant",
        other => other,
    }
}

/** Build the OpenAI-compatible chat completions endpoint from a provider base URL. */
fn build_openai_chat_completions_url(base_url: &str) -> String {
    if base_url.ends_with("/chat/completions") {
        return base_url.to_string();
    }

    format!("{base_url}/chat/completions")
}

/** Build the Ollama native /api/chat endpoint from a provider base URL. */
fn build_ollama_api_chat_url(base_url: &str) -> String {
    if base_url.ends_with("/api/chat") {
        return base_url.to_string();
    }

    if base_url.ends_with("/api") {
        return format!("{base_url}/chat");
    }

    format!("{base_url}/api/chat")
}

/** Build a fallback OpenAI-compatible base URL for Ollama root URLs. */
fn build_ollama_openai_base_url(base_url: &str) -> String {
    if base_url.ends_with("/v1") {
        return base_url.to_string();
    }

    if base_url.ends_with("/api") {
        return format!("{}/v1", base_url.trim_end_matches("/api"));
    }

    format!("{base_url}/v1")
}

/** Create a reqwest client configured for long-lived streaming responses. */
fn build_stream_client() -> Result<Client, ModelStreamFailure> {
    Client::builder()
        .connect_timeout(Duration::from_secs(MODEL_CONNECT_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| {
            ModelStreamFailure::terminal(
                "MODEL_CLIENT_INIT_FAILED",
                format!("Failed to initialize model client: {error}"),
            )
        })
}

/** Build an OpenAI-compatible JSON request body from the normalized request. */
fn build_openai_request_body(request: &ResolvedModelStreamRequest) -> Value {
    let messages: Vec<Value> = request
        .prompt_messages
        .iter()
        .map(|message| {
            json!({
                "role": normalize_prompt_role(&message.role),
                "content": message.content.clone(),
            })
        })
        .collect();

    let mut body = Map::from_iter([
        (
            "model".to_string(),
            Value::String(request.request_model_name.clone()),
        ),
        ("messages".to_string(), Value::Array(messages)),
        ("stream".to_string(), Value::Bool(true)),
    ]);

    if let Some(params) = request.generation_params.as_ref() {
        if let Some(temperature) = params.temperature {
            body.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(top_p) = params.top_p {
            body.insert("top_p".to_string(), json!(top_p));
        }
        if let Some(max_tokens) = params.max_tokens {
            body.insert("max_tokens".to_string(), json!(max_tokens));
        }
    }

    Value::Object(body)
}

/** Build an Ollama native /api/chat JSON request body from the normalized request. */
fn build_ollama_request_body(request: &ResolvedModelStreamRequest) -> Value {
    let messages: Vec<Value> = request
        .prompt_messages
        .iter()
        .map(|message| {
            json!({
                "role": normalize_prompt_role(&message.role),
                "content": message.content.clone(),
            })
        })
        .collect();

    let mut body = Map::from_iter([
        (
            "model".to_string(),
            Value::String(request.request_model_name.clone()),
        ),
        ("messages".to_string(), Value::Array(messages)),
        ("stream".to_string(), Value::Bool(true)),
    ]);

    let mut options = Map::new();
    if let Some(params) = request.generation_params.as_ref() {
        if let Some(temperature) = params.temperature {
            options.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(top_p) = params.top_p {
            options.insert("top_p".to_string(), json!(top_p));
        }
        if let Some(max_tokens) = params.max_tokens {
            options.insert("num_predict".to_string(), json!(max_tokens));
        }
    }

    if !options.is_empty() {
        body.insert("options".to_string(), Value::Object(options));
    }

    Value::Object(body)
}

/**
 * Stream an OpenAI-compatible SSE response and forward text deltas to the channel.
 *
 * This parser tolerates chunk boundaries inside SSE frames by buffering partial
 * data until a full "\n\n" frame separator is received.
 */
async fn stream_openai_compatible_response(
    request: &ResolvedModelStreamRequest,
    endpoint: &str,
    channel: &Channel<ModelStreamEventDto>,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<ModelStreamOutcome, ModelStreamFailure> {
    let client = build_stream_client()?;
    let body = build_openai_request_body(request);
    let response = send_json_request(
        &client,
        endpoint,
        &body,
        request.api_key.as_deref(),
        "text/event-stream",
    )
    .await?;
    let mut response = response;
    let mut buffer = String::new();
    let mut usage: Option<TokenUsageDto> = None;

    loop {
        tokio::select! {
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    return Ok(ModelStreamOutcome::Cancelled);
                }
            }
            next_chunk = response.chunk() => {
                let Some(bytes) = next_chunk.map_err(map_response_chunk_error)? else {
                    return Ok(ModelStreamOutcome::Completed { usage });
                };

                buffer.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));

                while let Some(frame) = take_sse_frame(&mut buffer) {
                    let Some(data) = collect_sse_data(&frame) else {
                        continue;
                    };

                    if data == "[DONE]" {
                        return Ok(ModelStreamOutcome::Completed { usage });
                    }

                    let value: Value = serde_json::from_str(&data).map_err(|error| {
                        ModelStreamFailure::retriable(
                            "MODEL_STREAM_PARSE_ERROR",
                            format!("Failed to parse streaming event: {error}"),
                        )
                    })?;

                    if let Some(provider_error) = extract_provider_error(&value) {
                        return Err(provider_error);
                    }

                    if usage.is_none() {
                        usage = extract_openai_usage(&value);
                    }

                    if let Some(text) = value
                        .pointer("/choices/0/delta/content")
                        .and_then(Value::as_str)
                        .or_else(|| value.pointer("/choices/0/message/content").and_then(Value::as_str))
                    {
                        emit_chunk(channel, &request.request_id, text)?;
                    }
                }
            }
        }
    }
}

/** Pull the next complete SSE frame from the buffered response text. */
fn take_sse_frame(buffer: &mut String) -> Option<String> {
    let frame_end = buffer.find("\n\n")?;
    let frame = buffer[..frame_end].to_string();
    let remainder = buffer[(frame_end + 2)..].to_string();
    *buffer = remainder;
    Some(frame)
}

/** Collect all `data:` lines from an SSE frame into a single payload. */
fn collect_sse_data(frame: &str) -> Option<String> {
    let payloads: Vec<&str> = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .filter(|segment| !segment.is_empty())
        .collect();

    if payloads.is_empty() {
        return None;
    }

    Some(payloads.join("\n"))
}

/** Extract OpenAI-compatible token usage from a stream event if present. */
fn extract_openai_usage(value: &Value) -> Option<TokenUsageDto> {
    let usage = value.get("usage")?;
    Some(TokenUsageDto {
        prompt_tokens: usage
            .get("prompt_tokens")
            .and_then(Value::as_i64)
            .map(|value| value as i32),
        completion_tokens: usage
            .get("completion_tokens")
            .and_then(Value::as_i64)
            .map(|value| value as i32),
        total_tokens: usage
            .get("total_tokens")
            .and_then(Value::as_i64)
            .map(|value| value as i32),
    })
}

/**
 * Stream an Ollama response using either the OpenAI-compatible or native API.
 *
 * The native `/api/chat` endpoint is preferred for root URLs. When it returns a
 * 404, the service falls back to the `/v1/chat/completions` compatibility path.
 */
async fn stream_ollama_response(
    request: &ResolvedModelStreamRequest,
    channel: &Channel<ModelStreamEventDto>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<ModelStreamOutcome, ModelStreamFailure> {
    if request.base_url.ends_with("/v1") {
        let endpoint = build_openai_chat_completions_url(&request.base_url);
        return stream_openai_compatible_response(request, &endpoint, channel, cancel_rx).await;
    }

    let native_endpoint = build_ollama_api_chat_url(&request.base_url);
    let native_result =
        stream_ollama_native_response(request, &native_endpoint, channel, cancel_rx.clone()).await;

    let should_fallback = matches!(
        &native_result,
        Err(ModelStreamFailure { code, .. }) if code == "MODEL_ENDPOINT_NOT_FOUND"
    );

    if should_fallback {
        let compat_base = build_ollama_openai_base_url(&request.base_url);
        let compat_endpoint = build_openai_chat_completions_url(&compat_base);
        return stream_openai_compatible_response(request, &compat_endpoint, channel, cancel_rx)
            .await;
    }

    native_result
}

/**
 * Stream Ollama's native `/api/chat` newline-delimited JSON response.
 *
 * Each line is a standalone JSON object that may contain:
 *   - message.content: text delta
 *   - done: terminal flag
 *   - prompt_eval_count / eval_count: usage-like token counters
 */
async fn stream_ollama_native_response(
    request: &ResolvedModelStreamRequest,
    endpoint: &str,
    channel: &Channel<ModelStreamEventDto>,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<ModelStreamOutcome, ModelStreamFailure> {
    let client = build_stream_client()?;
    let body = build_ollama_request_body(request);
    let response = send_json_request(
        &client,
        endpoint,
        &body,
        request.api_key.as_deref(),
        "application/x-ndjson",
    )
    .await?;
    let mut response = response;
    let mut buffer = String::new();
    let mut usage: Option<TokenUsageDto> = None;

    loop {
        tokio::select! {
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    return Ok(ModelStreamOutcome::Cancelled);
                }
            }
            next_chunk = response.chunk() => {
                let Some(bytes) = next_chunk.map_err(map_response_chunk_error)? else {
                    while let Some(line) = take_json_line(&mut buffer) {
                        if line.trim().is_empty() {
                            continue;
                        }

                        let value: Value = serde_json::from_str(&line).map_err(|error| {
                            ModelStreamFailure::retriable(
                                "MODEL_STREAM_PARSE_ERROR",
                                format!("Failed to parse Ollama stream line: {error}"),
                            )
                        })?;

                        if let Some(provider_error) = extract_provider_error(&value) {
                            return Err(provider_error);
                        }

                        if let Some(text) = value.pointer("/message/content").and_then(Value::as_str) {
                            emit_chunk(channel, &request.request_id, text)?;
                        }

                        if value.get("done").and_then(Value::as_bool) == Some(true) {
                            usage = extract_ollama_usage(&value).or(usage);
                        }
                    }

                    if !buffer.trim().is_empty() {
                        let line = std::mem::take(&mut buffer);
                        let value: Value = serde_json::from_str(line.trim()).map_err(|error| {
                            ModelStreamFailure::retriable(
                                "MODEL_STREAM_PARSE_ERROR",
                                format!("Failed to parse Ollama stream line: {error}"),
                            )
                        })?;

                        if let Some(provider_error) = extract_provider_error(&value) {
                            return Err(provider_error);
                        }

                        if let Some(text) = value.pointer("/message/content").and_then(Value::as_str) {
                            emit_chunk(channel, &request.request_id, text)?;
                        }

                        if value.get("done").and_then(Value::as_bool) == Some(true) {
                            usage = extract_ollama_usage(&value).or(usage);
                        }
                    }

                    return Ok(ModelStreamOutcome::Completed { usage });
                };

                buffer.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));

                while let Some(line) = take_json_line(&mut buffer) {
                    if line.trim().is_empty() {
                        continue;
                    }

                    let value: Value = serde_json::from_str(&line).map_err(|error| {
                        ModelStreamFailure::retriable(
                            "MODEL_STREAM_PARSE_ERROR",
                            format!("Failed to parse Ollama stream line: {error}"),
                        )
                    })?;

                    if let Some(provider_error) = extract_provider_error(&value) {
                        return Err(provider_error);
                    }

                    if let Some(text) = value.pointer("/message/content").and_then(Value::as_str) {
                        emit_chunk(channel, &request.request_id, text)?;
                    }

                    if value.get("done").and_then(Value::as_bool) == Some(true) {
                        usage = extract_ollama_usage(&value).or(usage);
                        return Ok(ModelStreamOutcome::Completed { usage });
                    }
                }
            }
        }
    }
}

/** Pull the next newline-delimited JSON line from the buffered response text. */
fn take_json_line(buffer: &mut String) -> Option<String> {
    let line_end = buffer.find('\n')?;
    let line = buffer[..line_end].to_string();
    let remainder = buffer[(line_end + 1)..].to_string();
    *buffer = remainder;
    Some(line)
}

/** Extract Ollama usage counters into the shared token usage DTO shape. */
fn extract_ollama_usage(value: &Value) -> Option<TokenUsageDto> {
    let prompt_tokens = value
        .get("prompt_eval_count")
        .and_then(Value::as_i64)
        .map(|value| value as i32);
    let completion_tokens = value
        .get("eval_count")
        .and_then(Value::as_i64)
        .map(|value| value as i32);

    if prompt_tokens.is_none() && completion_tokens.is_none() {
        return None;
    }

    Some(TokenUsageDto {
        prompt_tokens,
        completion_tokens,
        total_tokens: match (prompt_tokens, completion_tokens) {
            (Some(prompt), Some(completion)) => Some(prompt + completion),
            _ => None,
        },
    })
}

/**
 * Send a JSON POST request for streaming and validate the HTTP response.
 *
 * Non-success responses are converted into domain-specific runtime failures so
 * the frontend can render actionable assistant error states.
 */
async fn send_json_request(
    client: &Client,
    endpoint: &str,
    body: &Value,
    api_key: Option<&str>,
    accept_header: &str,
) -> Result<Response, ModelStreamFailure> {
    let mut request = client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, accept_header)
        .json(body);

    if let Some(api_key) = api_key {
        request = request.header(AUTHORIZATION, format!("Bearer {api_key}"));
    }

    let response = request.send().await.map_err(map_request_send_error)?;
    ensure_success_response(endpoint, response).await
}

/** Convert reqwest send errors into user-meaningful runtime failure codes. */
fn map_request_send_error(error: reqwest::Error) -> ModelStreamFailure {
    if error.is_timeout() {
        return ModelStreamFailure::retriable(
            "MODEL_REQUEST_TIMEOUT",
            "The model provider request timed out",
        );
    }

    ModelStreamFailure::retriable(
        "MODEL_NETWORK_ERROR",
        format!("Failed to connect to the model provider: {error}"),
    )
}

/** Convert response body read errors into a retriable runtime failure. */
fn map_response_chunk_error(error: reqwest::Error) -> ModelStreamFailure {
    if error.is_timeout() {
        return ModelStreamFailure::retriable(
            "MODEL_REQUEST_TIMEOUT",
            "The model provider stopped responding",
        );
    }

    ModelStreamFailure::retriable(
        "MODEL_STREAM_READ_ERROR",
        format!("Failed to read the streaming response: {error}"),
    )
}

/** Validate a streaming HTTP response and map status codes into domain errors. */
async fn ensure_success_response(
    endpoint: &str,
    response: Response,
) -> Result<Response, ModelStreamFailure> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let body = response.text().await.unwrap_or_default();
    let preview = truncate_error_preview(format!("{endpoint} -> HTTP {status}; body={body}"));

    let failure = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ModelStreamFailure::terminal(
            "PROVIDER_AUTH_FAILED",
            "The configured provider credentials were rejected",
        ),
        StatusCode::NOT_FOUND => ModelStreamFailure::terminal(
            "MODEL_ENDPOINT_NOT_FOUND",
            "The configured provider endpoint was not found. Check the Base URL.",
        ),
        StatusCode::TOO_MANY_REQUESTS => ModelStreamFailure::retriable(
            "MODEL_RATE_LIMITED",
            "The model provider rate-limited this request",
        ),
        _ => ModelStreamFailure::retriable(
            "MODEL_BAD_RESPONSE",
            format!("The model provider returned HTTP {status}"),
        ),
    };

    Err(ModelStreamFailure {
        code: failure.code,
        message: format!("{} ({preview})", failure.message),
        retriable: failure.retriable,
    })
}

/** Truncate provider error previews so frontend errors remain readable. */
fn truncate_error_preview(details: String) -> String {
    if details.chars().count() <= ERROR_BODY_PREVIEW_LIMIT {
        return details;
    }

    let truncated: String = details.chars().take(ERROR_BODY_PREVIEW_LIMIT).collect();
    format!("{truncated}...")
}

/** Extract provider-native error objects from JSON payloads into runtime failures. */
fn extract_provider_error(value: &Value) -> Option<ModelStreamFailure> {
    let error_value = value.get("error")?;

    if let Some(message) = error_value.as_str() {
        return Some(ModelStreamFailure::terminal("MODEL_PROVIDER_ERROR", message));
    }

    let message = error_value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error_value.get("error").and_then(Value::as_str))
        .unwrap_or("The model provider returned an unknown error");

    Some(ModelStreamFailure::terminal("MODEL_PROVIDER_ERROR", message))
}

/** Emit a normalized chunk event to the frontend channel. */
fn emit_chunk(
    channel: &Channel<ModelStreamEventDto>,
    request_id: &str,
    chunk: &str,
) -> Result<(), ModelStreamFailure> {
    if chunk.is_empty() {
        return Ok(());
    }

    channel
        .send(ModelStreamEventDto::Chunk {
            request_id: request_id.to_string(),
            chunk: chunk.to_string(),
        })
        .map_err(|error| {
            ModelStreamFailure::terminal(
                "STREAM_CHANNEL_CLOSED",
                format!("Failed to forward model stream chunk to the frontend: {error}"),
            )
        })
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use crate::test_support::{spawn_mock_http_server, MockHttpRoute};
    use tauri::ipc::Channel;

    /** Verify SSE frame extraction leaves the remaining buffer intact. */
    #[test]
    fn test_take_sse_frame_preserves_remainder() {
        let mut buffer =
            "data: {\"chunk\":1}\n\ndata: {\"chunk\":2}\n\npartial".to_string();

        let first = take_sse_frame(&mut buffer);
        let second = take_sse_frame(&mut buffer);

        assert_eq!(first.as_deref(), Some("data: {\"chunk\":1}"));
        assert_eq!(second.as_deref(), Some("data: {\"chunk\":2}"));
        assert_eq!(buffer, "partial");
    }

    /** Verify multi-line SSE payloads are joined back into a single JSON body. */
    #[test]
    fn test_collect_sse_data_joins_multiple_lines() {
        let frame = "event: message\ndata: {\"foo\":\ndata: \"bar\"}";
        let payload = collect_sse_data(frame);

        assert_eq!(payload.as_deref(), Some("{\"foo\":\n\"bar\"}"));
    }

    /** Verify OpenAI usage objects map into the shared token usage DTO shape. */
    #[test]
    fn test_extract_openai_usage_maps_fields() {
        let value = json!({
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 34,
                "total_tokens": 46
            }
        });

        let usage = extract_openai_usage(&value).expect("usage should exist");

        assert_eq!(usage.prompt_tokens, Some(12));
        assert_eq!(usage.completion_tokens, Some(34));
        assert_eq!(usage.total_tokens, Some(46));
    }

    /** Verify newline-delimited JSON extraction keeps the remaining tail intact. */
    #[test]
    fn test_take_json_line_preserves_remainder() {
        let mut buffer = "{\"a\":1}\n{\"b\":2}\npartial".to_string();

        let first = take_json_line(&mut buffer);
        let second = take_json_line(&mut buffer);

        assert_eq!(first.as_deref(), Some("{\"a\":1}"));
        assert_eq!(second.as_deref(), Some("{\"b\":2}"));
        assert_eq!(buffer, "partial");
    }

    /** Verify Ollama `/api` roots are normalized to `/v1` for OpenAI fallback. */
    #[test]
    fn test_build_ollama_openai_base_url_trims_api_suffix() {
        let base = build_ollama_openai_base_url("http://127.0.0.1:11434/api");
        assert_eq!(base, "http://127.0.0.1:11434/v1");
    }

    /** Verify OpenAI-compatible SSE streams emit chunk events and return usage metadata. */
    #[tokio::test]
    async fn test_stream_openai_response_emits_chunks_and_usage() {
        let server = spawn_mock_http_server(vec![MockHttpRoute::new(
            "POST",
            "/v1/chat/completions",
            200,
            "text/event-stream",
            concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n",
                "data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":5,\"total_tokens\":12},\"choices\":[{\"delta\":{}}]}\n\n",
                "data: [DONE]\n\n"
            ),
        )])
        .await;

        let request = ResolvedModelStreamRequest {
            request_id: "req-openai".to_string(),
            provider_type: "OPENAI_COMPATIBLE".to_string(),
            base_url: format!("{}/v1", server.base_url()),
            api_key: Some("sk-live".to_string()),
            model_id: "gpt-4.1-mini".to_string(),
            prompt_messages: vec![ModelPromptMessageDto {
                role: "USER".to_string(),
                content: "Hello provider".to_string(),
            }],
            generation_params: Some(GenerationParamsDto {
                temperature: Some(0.2),
                top_p: None,
                max_tokens: Some(128),
                stream: true,
            }),
        };

        let (channel, events) = recording_channel();
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let outcome = stream_model_response(&request, &channel, cancel_rx)
            .await
            .expect("openai-compatible stream should succeed");

        let ModelStreamOutcome::Completed { usage } = outcome else {
            panic!("expected completed outcome");
        };
        let usage = usage.expect("usage should be present");
        assert_eq!(usage.prompt_tokens, Some(7));
        assert_eq!(usage.completion_tokens, Some(5));
        assert_eq!(usage.total_tokens, Some(12));

        let events = events.lock().unwrap().clone();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            ModelStreamEventDto::Chunk { request_id, chunk }
                if request_id == "req-openai" && chunk == "Hello "
        ));
        assert!(matches!(
            &events[1],
            ModelStreamEventDto::Chunk { request_id, chunk }
                if request_id == "req-openai" && chunk == "world"
        ));

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/chat/completions");
        assert_eq!(
            requests[0].headers.get("authorization").map(String::as_str),
            Some("Bearer sk-live")
        );
        assert!(requests[0].body.contains("\"model\":\"gpt-4.1-mini\""));
        assert!(requests[0].body.contains("\"content\":\"Hello provider\""));
    }

    /** Verify Ollama native NDJSON streams emit chunks and usage counters. */
    #[tokio::test]
    async fn test_stream_ollama_native_response_emits_chunks_and_usage() {
        let server = spawn_mock_http_server(vec![MockHttpRoute::new(
            "POST",
            "/api/chat",
            200,
            "application/x-ndjson",
            concat!(
                "{\"message\":{\"content\":\"Alpha \"},\"done\":false}\n",
                "{\"message\":{\"content\":\"beta\"},\"done\":true,\"prompt_eval_count\":4,\"eval_count\":6}\n"
            ),
        )])
        .await;

        let request = ResolvedModelStreamRequest {
            request_id: "req-ollama-native".to_string(),
            provider_type: "OLLAMA".to_string(),
            base_url: server.base_url(),
            api_key: None,
            model_id: "llama3.1".to_string(),
            prompt_messages: vec![ModelPromptMessageDto {
                role: "USER".to_string(),
                content: "Stream from ollama".to_string(),
            }],
            generation_params: Some(GenerationParamsDto {
                temperature: Some(0.4),
                top_p: Some(0.95),
                max_tokens: Some(64),
                stream: true,
            }),
        };

        let (channel, events) = recording_channel();
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let outcome = stream_model_response(&request, &channel, cancel_rx)
            .await
            .expect("ollama native stream should succeed");

        let ModelStreamOutcome::Completed { usage } = outcome else {
            panic!("expected completed outcome");
        };
        let usage = usage.expect("usage should be present");
        assert_eq!(usage.prompt_tokens, Some(4));
        assert_eq!(usage.completion_tokens, Some(6));
        assert_eq!(usage.total_tokens, Some(10));

        let events = events.lock().unwrap().clone();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            ModelStreamEventDto::Chunk { request_id, chunk }
                if request_id == "req-ollama-native" && chunk == "Alpha "
        ));
        assert!(matches!(
            &events[1],
            ModelStreamEventDto::Chunk { request_id, chunk }
                if request_id == "req-ollama-native" && chunk == "beta"
        ));

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/api/chat");
        assert!(requests[0].body.contains("\"num_predict\":64"));
    }

    /** Verify Ollama falls back to `/v1/chat/completions` after `/api/chat` returns 404. */
    #[tokio::test]
    async fn test_stream_ollama_falls_back_to_openai_compat_after_404() {
        let server = spawn_mock_http_server(vec![
            MockHttpRoute::new(
                "POST",
                "/api/chat",
                404,
                "application/json",
                r#"{"error":"not found"}"#,
            ),
            MockHttpRoute::new(
                "POST",
                "/v1/chat/completions",
                200,
                "text/event-stream",
                concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"fallback \"}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
                    "data: [DONE]\n\n"
                ),
            ),
        ])
        .await;

        let request = ResolvedModelStreamRequest {
            request_id: "req-ollama-fallback".to_string(),
            provider_type: "OLLAMA".to_string(),
            base_url: server.base_url(),
            api_key: None,
            model_id: "llama3.1".to_string(),
            prompt_messages: vec![ModelPromptMessageDto {
                role: "USER".to_string(),
                content: "Fallback please".to_string(),
            }],
            generation_params: None,
        };

        let (channel, events) = recording_channel();
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let outcome = stream_model_response(&request, &channel, cancel_rx)
            .await
            .expect("ollama fallback stream should succeed");

        let ModelStreamOutcome::Completed { usage } = outcome else {
            panic!("expected completed outcome");
        };
        assert!(usage.is_none());

        let events = events.lock().unwrap().clone();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            ModelStreamEventDto::Chunk { request_id, chunk }
                if request_id == "req-ollama-fallback" && chunk == "fallback "
        ));
        assert!(matches!(
            &events[1],
            ModelStreamEventDto::Chunk { request_id, chunk }
                if request_id == "req-ollama-fallback" && chunk == "ok"
        ));

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].path, "/api/chat");
        assert_eq!(requests[1].path, "/v1/chat/completions");
    }

    /** Build a channel that records all emitted stream events for assertions. */
    fn recording_channel() -> (
        Channel<ModelStreamEventDto>,
        Arc<Mutex<Vec<ModelStreamEventDto>>>,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();

        let channel = Channel::new(move |body| {
            let event = body
                .deserialize::<ModelStreamEventDto>()
                .expect("stream event should deserialize");
            sink.lock().unwrap().push(event);
            Ok(())
        });

        (channel, events)
    }
}
