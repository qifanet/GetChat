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

use crate::dto::common::{GenerationParamsDto, TokenUsageDto, ToolCallDto, ToolDefinitionDto};
use crate::dto::streaming::{ModelPromptMessageDto, ModelStreamEventDto, StartModelStreamInput};
use crate::repositories::{conversations, provider_models, providers};
use crate::services::provider_profiles::ProviderProfile;
use crate::state::SecureKeyStore;

const MODEL_CONNECT_TIMEOUT_SECONDS: u64 = 10;
const MODEL_STREAM_TIMEOUT_SECONDS: u64 = 600;
const ERROR_BODY_PREVIEW_LIMIT: usize = 2048;
const DSML_MARKER_GUARD_CHARS: usize = 32;
const DSML_TOOL_CALL_BUFFER_LIMIT_CHARS: usize = 128_000;

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
    pub provider_profile: ProviderProfile,
    pub base_url: String,
    pub api_key: Option<String>,
    /// Internal model ID for traceability; used in logging and ReAct loop metadata.
    #[allow(dead_code)]
    pub model_id: String,
    pub request_model_name: String,
    pub prompt_messages: Vec<ModelPromptMessageDto>,
    pub generation_params: Option<GenerationParamsDto>,
    pub tools: Vec<ToolDefinitionDto>,
    pub tool_choice: Option<String>,
    /// Conversation ID for context-aware tools (e.g. todo scoping).
    pub conversation_id: Option<String>,
    /// Branch ID for branch-aware context compression.
    pub branch_id: Option<String>,
    /// Per-conversation workspace root for file-scoped tools.
    pub workspace_path: Option<String>,
    /// Skill name activated by the user via slash command (Tier 3).
    pub activated_skill: Option<String>,
}

/** Normalized terminal outcome of a provider streaming session. */
#[derive(Debug, Clone)]
pub enum ModelStreamOutcome {
    Completed {
        usage: Option<TokenUsageDto>,
        reasoning_content: Option<String>,
    },
    /// Model requested tool invocations before producing final text.
    ToolCallsRequested {
        tool_calls: Vec<ToolCallDto>,
        #[allow(dead_code)]
        usage: Option<TokenUsageDto>,
        reasoning_content: Option<String>,
    },
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
    pub(crate) fn terminal(code: &str, message: impl Into<String>) -> Self {
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

    for message in &input.prompt_messages {
        if normalize_prompt_role(&message.role).is_none() {
            return Err(ModelStreamFailure::terminal(
                "INVALID_MODEL_REQUEST",
                format!("Unsupported prompt message role: {}", message.role),
            ));
        }
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
    let provider_profile = ProviderProfile::resolve(&provider.r#type, &base_url);

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

    let workspace_path = if let Some(conversation_id) = input.conversation_id.as_deref() {
        let conversation = conversations::find_by_id(pool, conversation_id)
            .await
            .map_err(|error| {
                ModelStreamFailure::retriable(
                    "CONVERSATION_LOOKUP_FAILED",
                    format!("Failed to load conversation workspace: {error}"),
                )
            })?
            .ok_or_else(|| {
                ModelStreamFailure::terminal(
                    "CONVERSATION_NOT_FOUND",
                    "The active conversation no longer exists",
                )
            })?;
        conversation.workspace_path
    } else {
        None
    };

    Ok(ResolvedModelStreamRequest {
        request_id: input.request_id.clone(),
        provider_type: provider.r#type,
        provider_profile,
        base_url,
        api_key,
        model_id: input.model_id.clone(),
        request_model_name,
        prompt_messages: input.prompt_messages.clone(),
        generation_params: input.generation_params.clone(),
        tools: input.tools.clone(),
        tool_choice: input.tool_choice.clone(),
        conversation_id: input.conversation_id.clone(),
        branch_id: input.branch_id.clone(),
        workspace_path,
        activated_skill: input.activated_skill.clone(),
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
    validate_prompt_tool_sequence(&request.prompt_messages)?;

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
fn normalize_prompt_role(role: &str) -> Option<&'static str> {
    match role {
        "SYSTEM" | "system" => Some("system"),
        "USER" | "user" => Some("user"),
        "ASSISTANT" | "assistant" => Some("assistant"),
        "TOOL" | "tool" => Some("tool"),
        _ => None,
    }
}

/**
 * Validate OpenAI-compatible tool transcript ordering before sending upstream.
 *
 * Providers such as DeepSeek enforce this strictly: every `tool` message must
 * answer a preceding assistant `tool_calls` entry, and all tool calls from an
 * assistant turn must be answered before the next non-tool message.
 */
fn validate_prompt_tool_sequence(
    messages: &[ModelPromptMessageDto],
) -> Result<(), ModelStreamFailure> {
    let mut pending_tool_call_ids: Vec<String> = Vec::new();

    for (index, message) in messages.iter().enumerate() {
        let role = normalize_prompt_role(&message.role).ok_or_else(|| {
            ModelStreamFailure::terminal(
                "INVALID_MODEL_REQUEST",
                format!("Unsupported prompt message role: {}", message.role),
            )
        })?;

        match role {
            "assistant" => {
                if !pending_tool_call_ids.is_empty() {
                    return Err(ModelStreamFailure::terminal(
                        "INVALID_TOOL_TRANSCRIPT",
                        format!(
                            "Assistant tool_calls at prompt index {} were not fully answered before the next assistant message",
                            index
                        ),
                    ));
                }

                pending_tool_call_ids = message
                    .tool_calls
                    .as_ref()
                    .map(|tool_calls| {
                        tool_calls
                            .iter()
                            .map(|tool_call| tool_call.id.clone())
                            .filter(|id| !id.trim().is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
            }
            "tool" => {
                let tool_call_id = message
                    .tool_call_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        ModelStreamFailure::terminal(
                            "INVALID_TOOL_TRANSCRIPT",
                            format!(
                                "Tool message at prompt index {} is missing tool_call_id",
                                index
                            ),
                        )
                    })?;

                let Some(position) = pending_tool_call_ids
                    .iter()
                    .position(|pending_id| pending_id == tool_call_id)
                else {
                    return Err(ModelStreamFailure::terminal(
                        "INVALID_TOOL_TRANSCRIPT",
                        format!(
                            "Tool message at prompt index {} does not match a preceding assistant tool_call_id",
                            index
                        ),
                    ));
                };

                pending_tool_call_ids.remove(position);
            }
            _ => {
                if !pending_tool_call_ids.is_empty() {
                    return Err(ModelStreamFailure::terminal(
                        "INVALID_TOOL_TRANSCRIPT",
                        format!(
                            "Assistant tool_calls before prompt index {} are missing tool result messages",
                            index
                        ),
                    ));
                }
            }
        }
    }

    if !pending_tool_call_ids.is_empty() {
        return Err(ModelStreamFailure::terminal(
            "INVALID_TOOL_TRANSCRIPT",
            "Assistant tool_calls at the end of the prompt are missing tool result messages",
        ));
    }

    Ok(())
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

/** Serialize prompt messages with tool_calls and provider-specific replay fields. */
fn serialize_prompt_message(message: &ModelPromptMessageDto, profile: ProviderProfile) -> Value {
    let role = normalize_prompt_role(&message.role).unwrap_or("user");
    if role == "tool" {
        let mut m = json!({ "role": "tool", "content": &message.content });
        if let Some(ref id) = message.tool_call_id {
            m["tool_call_id"] = json!(id);
        }
        if let Some(ref name) = message.name {
            m["name"] = json!(name);
        }
        m
    } else if let Some(ref tool_calls) = message.tool_calls {
        // Empty string is accepted by more OpenAI-compatible providers than
        // `null` while preserving assistant tool-call semantics.
        let content = json!(message.content);
        let mut m = json!({ "role": role, "content": content, "tool_calls": tool_calls });
        if role == "assistant" && profile.should_replay_reasoning_content() {
            if let Some(reasoning_content) = message
                .reasoning_content
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                m["reasoning_content"] = json!(reasoning_content);
            }
        }
        m
    } else {
        let mut m = json!({ "role": role, "content": &message.content });
        if role == "assistant" && profile.should_replay_reasoning_content() {
            if let Some(reasoning_content) = message
                .reasoning_content
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                m["reasoning_content"] = json!(reasoning_content);
            }
        }
        m
    }
}

/** Build an OpenAI-compatible JSON request body from the normalized request. */
fn build_openai_request_body(request: &ResolvedModelStreamRequest) -> Value {
    let messages: Vec<Value> = request
        .prompt_messages
        .iter()
        .map(|message| serialize_prompt_message(message, request.provider_profile))
        .collect();

    let mut body = Map::from_iter([
        (
            "model".to_string(),
            Value::String(request.request_model_name.clone()),
        ),
        ("messages".to_string(), Value::Array(messages)),
        ("stream".to_string(), Value::Bool(true)),
    ]);

    if !request.tools.is_empty() {
        body.insert("tools".to_string(), json!(request.tools));
        if let Some(ref choice) = request.tool_choice {
            body.insert("tool_choice".to_string(), json!(choice));
        }
    }

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

    request.provider_profile.apply_chat_request_body(&mut body);

    Value::Object(body)
}

/** Build an Ollama native /api/chat JSON request body from the normalized request. */
fn build_ollama_request_body(request: &ResolvedModelStreamRequest) -> Value {
    let messages: Vec<Value> = request
        .prompt_messages
        .iter()
        .map(|message| {
            json!({
                "role": normalize_prompt_role(&message.role).unwrap_or("user"),
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

    // Disable thinking mode — prevents generating invisible thinking tokens that
    // slow down the response. Combined with num_ctx=32768 below, context is preserved.
    body.insert("think".to_string(), Value::Bool(false));

    let mut options = Map::new();

    // Expand context window to 32k tokens so long conversations aren't truncated.
    // Many models default to only 2048-4096 context, which silently drops earlier
    // messages when the conversation grows.
    options.insert("num_ctx".to_string(), json!(32768));

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

    body.insert("options".to_string(), Value::Object(options));

    Value::Object(body)
}

/** Return a reasoning payload only when the provider actually streamed one. */
fn finalize_reasoning_content(reasoning_content: &str) -> Option<String> {
    if reasoning_content.trim().is_empty() {
        None
    } else {
        Some(reasoning_content.to_string())
    }
}

enum DsmlToolCallParseResult {
    NotPresent,
    Incomplete,
    Parsed(Vec<ToolCallDto>),
    Invalid(String),
}

fn canonicalize_dsml_markup(input: &str) -> String {
    let mut normalized = input.replace('｜', "|");
    for (from, to) in [
        ("< |", "<|"),
        ("</ |", "</|"),
        ("| >", "|>"),
        (" |", "|"),
        ("| ", "|"),
        ("||DSML||", "|DSML|"),
        ("|DSML||", "|DSML|"),
        ("||DSML|", "|DSML|"),
    ] {
        while normalized.contains(from) {
            normalized = normalized.replace(from, to);
        }
    }
    normalized
}

fn find_dsml_start(text: &str) -> Option<usize> {
    let dsml_index = text.find("DSML")?;
    text[..dsml_index].rfind('<')
}

fn extract_dsml_attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn parse_dsml_parameter_value(raw: &str, string_attr: Option<&str>) -> Value {
    let force_string = string_attr
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if force_string {
        return Value::String(raw.to_string());
    }
    serde_json::from_str(raw.trim()).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn parse_dsml_parameters(body: &str) -> Result<Value, String> {
    let mut cursor = 0usize;
    let mut params = Map::new();
    let mut direct_arguments: Option<Value> = None;

    while let Some(start_rel) = body[cursor..].find("<|DSML|parameter") {
        let start = cursor + start_rel;
        let tag_end = body[start..]
            .find('>')
            .ok_or_else(|| "DSML parameter tag is incomplete".to_string())?
            + start;
        let tag = &body[start..=tag_end];
        let name = extract_dsml_attr(tag, "name")
            .ok_or_else(|| "DSML parameter is missing name".to_string())?;
        let close_tag = "</|DSML|parameter>";
        let value_start = tag_end + 1;
        let close_rel = body[value_start..]
            .find(close_tag)
            .ok_or_else(|| "DSML parameter close tag is missing".to_string())?;
        let value_end = value_start + close_rel;
        let value = parse_dsml_parameter_value(
            &body[value_start..value_end],
            extract_dsml_attr(tag, "string").as_deref(),
        );
        if name == "arguments" && direct_arguments.is_none() && params.is_empty() {
            direct_arguments = Some(value);
        } else {
            if let Some(arguments) = direct_arguments.take() {
                params.insert("arguments".to_string(), arguments);
            }
            params.insert(name, value);
        }
        cursor = value_end + close_tag.len();
    }

    if params.is_empty() {
        Ok(direct_arguments.unwrap_or_else(|| Value::Object(Map::new())))
    } else {
        Ok(Value::Object(params))
    }
}

fn parse_dsml_tool_calls(markup: &str) -> DsmlToolCallParseResult {
    let normalized = canonicalize_dsml_markup(markup);
    let Some(open_start) = normalized.find("<|DSML|tool_calls") else {
        return DsmlToolCallParseResult::NotPresent;
    };
    let Some(open_end_rel) = normalized[open_start..].find('>') else {
        return DsmlToolCallParseResult::Incomplete;
    };
    let body_start = open_start + open_end_rel + 1;
    let close_tag = "</|DSML|tool_calls>";
    let Some(close_rel) = normalized[body_start..].find(close_tag) else {
        return DsmlToolCallParseResult::Incomplete;
    };
    let body = &normalized[body_start..body_start + close_rel];
    let mut cursor = 0usize;
    let mut calls = Vec::new();

    while let Some(start_rel) = body[cursor..].find("<|DSML|invoke") {
        let start = cursor + start_rel;
        let Some(tag_end_rel) = body[start..].find('>') else {
            return DsmlToolCallParseResult::Incomplete;
        };
        let tag_end = start + tag_end_rel;
        let tag = &body[start..=tag_end];
        let Some(name) = extract_dsml_attr(tag, "name") else {
            return DsmlToolCallParseResult::Invalid("DSML invoke is missing name".to_string());
        };
        let invoke_close = "</|DSML|invoke>";
        let invoke_body_start = tag_end + 1;
        let Some(close_rel) = body[invoke_body_start..].find(invoke_close) else {
            return DsmlToolCallParseResult::Incomplete;
        };
        let invoke_body_end = invoke_body_start + close_rel;
        let arguments_value = match parse_dsml_parameters(&body[invoke_body_start..invoke_body_end]) {
            Ok(value) => value,
            Err(message) => return DsmlToolCallParseResult::Invalid(message),
        };
        let arguments = match serde_json::to_string(&arguments_value) {
            Ok(value) => value,
            Err(error) => {
                return DsmlToolCallParseResult::Invalid(format!(
                    "Failed to serialize DSML tool arguments: {error}"
                ))
            }
        };
        let id = extract_dsml_attr(tag, "id")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("dsml_call_{}", calls.len()));
        calls.push(ToolCallDto {
            id,
            call_type: "function".to_string(),
            function: crate::dto::common::ToolCallFunctionDto { name, arguments },
        });
        cursor = invoke_body_end + invoke_close.len();
    }

    if calls.is_empty() {
        DsmlToolCallParseResult::Invalid("DSML tool_calls block contains no invoke entries".to_string())
    } else {
        DsmlToolCallParseResult::Parsed(calls)
    }
}

fn try_parse_dsml_tool_call_buffer(
    buffer: &str,
) -> Result<Option<Vec<ToolCallDto>>, ModelStreamFailure> {
    if buffer.chars().count() > DSML_TOOL_CALL_BUFFER_LIMIT_CHARS {
        return Err(ModelStreamFailure::terminal(
            "MODEL_PROVIDER_TOOL_CALL_FORMAT_ERROR",
            "Provider emitted an oversized DSML tool-call block that could not be parsed safely",
        ));
    }

    match parse_dsml_tool_calls(buffer) {
        DsmlToolCallParseResult::Parsed(tool_calls) => Ok(Some(tool_calls)),
        DsmlToolCallParseResult::Invalid(message) => Err(ModelStreamFailure::terminal(
            "MODEL_PROVIDER_TOOL_CALL_FORMAT_ERROR",
            format!("Provider emitted invalid DSML tool-call markup: {message}"),
        )),
        DsmlToolCallParseResult::NotPresent | DsmlToolCallParseResult::Incomplete => Ok(None),
    }
}

fn finalize_dsml_tool_call_buffer(
    buffer: &mut Option<String>,
) -> Result<Option<Vec<ToolCallDto>>, ModelStreamFailure> {
    let Some(value) = buffer.take() else {
        return Ok(None);
    };

    match parse_dsml_tool_calls(&value) {
        DsmlToolCallParseResult::Parsed(tool_calls) => Ok(Some(tool_calls)),
        DsmlToolCallParseResult::NotPresent => Ok(None),
        DsmlToolCallParseResult::Incomplete => Err(ModelStreamFailure::terminal(
            "MODEL_PROVIDER_TOOL_CALL_FORMAT_ERROR",
            "Provider emitted an incomplete DSML tool-call block instead of structured tool_calls",
        )),
        DsmlToolCallParseResult::Invalid(message) => Err(ModelStreamFailure::terminal(
            "MODEL_PROVIDER_TOOL_CALL_FORMAT_ERROR",
            format!("Provider emitted invalid DSML tool-call markup: {message}"),
        )),
    }
}

fn flush_pending_text(
    channel: &Channel<ModelStreamEventDto>,
    request_id: &str,
    pending_text: &mut String,
) -> Result<(), ModelStreamFailure> {
    if !pending_text.is_empty() {
        let text = std::mem::take(pending_text);
        emit_chunk(channel, request_id, &text)?;
    }
    Ok(())
}

fn process_openai_content_delta(
    channel: &Channel<ModelStreamEventDto>,
    request_id: &str,
    pending_text: &mut String,
    dsml_tool_call_buffer: &mut Option<String>,
    text: &str,
) -> Result<Option<Vec<ToolCallDto>>, ModelStreamFailure> {
    if let Some(buffer) = dsml_tool_call_buffer.as_mut() {
        buffer.push_str(text);
        return try_parse_dsml_tool_call_buffer(buffer);
    }

    pending_text.push_str(text);
    if let Some(start) = find_dsml_start(pending_text) {
        let dsml_part = pending_text.split_off(start);
        flush_pending_text(channel, request_id, pending_text)?;
        *dsml_tool_call_buffer = Some(dsml_part);
        if let Some(buffer) = dsml_tool_call_buffer.as_ref() {
            return try_parse_dsml_tool_call_buffer(buffer);
        }
    } else if let Some(candidate_start) = pending_text.rfind('<') {
        let candidate_chars = pending_text[candidate_start..].chars().count();
        if candidate_chars <= DSML_MARKER_GUARD_CHARS {
            let suffix = pending_text.split_off(candidate_start);
            flush_pending_text(channel, request_id, pending_text)?;
            *pending_text = suffix;
        } else {
            flush_pending_text(channel, request_id, pending_text)?;
        }
    } else {
        flush_pending_text(channel, request_id, pending_text)?;
    }

    Ok(None)
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
    let mut reasoning_content = String::new();
    let mut pending_tool_calls: std::collections::HashMap<usize, (String, String, String)> = std::collections::HashMap::new();
    let mut pending_text = String::new();
    let mut dsml_tool_call_buffer: Option<String> = None;

    loop {
        tokio::select! {
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    return Ok(ModelStreamOutcome::Cancelled);
                }
            }
            next_chunk = response.chunk() => {
                let Some(bytes) = next_chunk.map_err(map_response_chunk_error)? else {
                    if !pending_tool_calls.is_empty() {
                        flush_pending_text(channel, &request.request_id, &mut pending_text)?;
                        let tool_calls = finalize_tool_calls(&mut pending_tool_calls);
                        return Ok(ModelStreamOutcome::ToolCallsRequested {
                            tool_calls,
                            usage,
                            reasoning_content: finalize_reasoning_content(&reasoning_content),
                        });
                    }
                    if let Some(tool_calls) = finalize_dsml_tool_call_buffer(&mut dsml_tool_call_buffer)? {
                        return Ok(ModelStreamOutcome::ToolCallsRequested {
                            tool_calls,
                            usage,
                            reasoning_content: finalize_reasoning_content(&reasoning_content),
                        });
                    }
                    flush_pending_text(channel, &request.request_id, &mut pending_text)?;
                    return Ok(ModelStreamOutcome::Completed {
                        usage,
                        reasoning_content: finalize_reasoning_content(&reasoning_content),
                    });
                };

                buffer.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));

                while let Some(frame) = take_sse_frame(&mut buffer) {
                    let Some(data) = collect_sse_data(&frame) else {
                        continue;
                    };

                    if data == "[DONE]" {
                        if !pending_tool_calls.is_empty() {
                            flush_pending_text(channel, &request.request_id, &mut pending_text)?;
                            let tool_calls = finalize_tool_calls(&mut pending_tool_calls);
                            return Ok(ModelStreamOutcome::ToolCallsRequested {
                                tool_calls,
                                usage,
                                reasoning_content: finalize_reasoning_content(&reasoning_content),
                            });
                        }
                        if let Some(tool_calls) = finalize_dsml_tool_call_buffer(&mut dsml_tool_call_buffer)? {
                            return Ok(ModelStreamOutcome::ToolCallsRequested {
                                tool_calls,
                                usage,
                                reasoning_content: finalize_reasoning_content(&reasoning_content),
                            });
                        }
                        flush_pending_text(channel, &request.request_id, &mut pending_text)?;
                        return Ok(ModelStreamOutcome::Completed {
                            usage,
                            reasoning_content: finalize_reasoning_content(&reasoning_content),
                        });
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

                    if let Some(reasoning_delta) = value
                        .pointer("/choices/0/delta/reasoning_content")
                        .and_then(Value::as_str)
                        .or_else(|| value.pointer("/choices/0/message/reasoning_content").and_then(Value::as_str))
                    {
                        reasoning_content.push_str(reasoning_delta);
                    }

                    if let Some(text) = value
                        .pointer("/choices/0/delta/content")
                        .and_then(Value::as_str)
                        .or_else(|| value.pointer("/choices/0/message/content").and_then(Value::as_str))
                    {
                        if let Some(tool_calls) = process_openai_content_delta(
                            channel,
                            &request.request_id,
                            &mut pending_text,
                            &mut dsml_tool_call_buffer,
                            text,
                        )? {
                            return Ok(ModelStreamOutcome::ToolCallsRequested {
                                tool_calls,
                                usage,
                                reasoning_content: finalize_reasoning_content(&reasoning_content),
                            });
                        }
                    }

                    // Accumulate tool_calls delta — check both delta and message paths
                    // (some providers use message/tool_calls for full non-streaming responses within SSE)
                    let tc_source = value.pointer("/choices/0/delta/tool_calls")
                        .or_else(|| value.pointer("/choices/0/message/tool_calls"))
                        .and_then(Value::as_array);
                    if let Some(tc_array) = tc_source {
                        for tc in tc_array {
                            let index = tc["index"].as_u64().unwrap_or(0) as usize;
                            let entry = pending_tool_calls.entry(index).or_insert((String::new(), String::new(), String::new()));
                            if let Some(id) = tc["id"].as_str() {
                                entry.0 = id.to_string();
                            }
                            if let Some(name) = tc.pointer("/function/name").and_then(Value::as_str) {
                                entry.1 = name.to_string();
                            }
                            // Arguments may be a JSON string (standard OpenAI) or a JSON
                            // object/array (some providers). Handle both cases.
                            if let Some(args) = tc.pointer("/function/arguments") {
                                match args {
                                    Value::String(s) => entry.2.push_str(s),
                                    Value::Object(_) | Value::Array(_) => {
                                        if let Ok(serialized) = serde_json::to_string(args) {
                                            entry.2.push_str(&serialized);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }

                    // Check finish_reason
                    if let Some(reason) = value.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
                        if reason == "tool_calls" {
                            flush_pending_text(channel, &request.request_id, &mut pending_text)?;
                            let tool_calls = finalize_tool_calls(&mut pending_tool_calls);
                            return Ok(ModelStreamOutcome::ToolCallsRequested {
                                tool_calls,
                                usage,
                                reasoning_content: finalize_reasoning_content(&reasoning_content),
                            });
                        }
                    }
                }
            }
        }
    }
}

/** Convert accumulated tool_calls deltas into resolved ToolCallDto list. */
fn finalize_tool_calls(pending: &mut std::collections::HashMap<usize, (String, String, String)>) -> Vec<ToolCallDto> {
    let mut keys: Vec<usize> = pending.keys().copied().collect();
    keys.sort();
    keys.into_iter().enumerate().map(|(seq, idx)| {
        let (id, name, arguments) = pending.remove(&idx).unwrap_or_default();
        // Some OpenAI-compatible providers (e.g., SenseNova) may not include
        // a tool_call ID in their streaming deltas. Generate a synthetic one
        // to ensure the tool transcript remains valid across iterations.
        let id = if id.trim().is_empty() {
            let synthetic = format!("call_synthetic_{}", seq);
            tracing::warn!(
                seq,
                name = %name,
                synthetic_id = %synthetic,
                "finalize_tool_calls: provider returned tool_call without ID, using synthetic"
            );
            synthetic
        } else {
            id
        };
        if name.trim().is_empty() || arguments.trim().is_empty() {
            tracing::warn!(
                seq,
                id = %id,
                name_len = name.len(),
                arguments_len = arguments.len(),
                "finalize_tool_calls: tool_call has empty name or arguments, provider may not support this"
            );
        }
        let arguments = if arguments.trim().is_empty() {
            "{}".to_string()
        } else {
            arguments
        };
        ToolCallDto {
            id,
            call_type: "function".to_string(),
            function: crate::dto::common::ToolCallFunctionDto { name, arguments },
        }
    }).collect()
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
    tracing::info!(
        provider_type = "OLLAMA",
        base_url = %request.base_url,
        model = %request.request_model_name,
        prompt_count = request.prompt_messages.len(),
        "stream_ollama_response: starting"
    );
    for (i, msg) in request.prompt_messages.iter().enumerate() {
        tracing::debug!(
            index = i,
            role = %msg.role,
            content_len = msg.content.len(),
            "prompt_message"
        );
    }

    // Always try native /api/chat first for Ollama for full feature support
    // and other native-only features. Fall back to OpenAI-compatible if needed.
    let native_base_url = if request.base_url.ends_with("/v1") {
        request.base_url.trim_end_matches("/v1").to_string()
    } else {
        request.base_url.clone()
    };
    let native_endpoint = build_ollama_api_chat_url(&native_base_url);
    tracing::info!(endpoint = %native_endpoint, "routing to native Ollama API (preferred)");

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

                    return Ok(ModelStreamOutcome::Completed {
                        usage,
                        reasoning_content: None,
                    });
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
                        return Ok(ModelStreamOutcome::Completed {
                            usage,
                            reasoning_content: None,
                        });
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

    /** Verify DeepSeek V4 raw DSML tool markup can be converted into tool calls. */
    #[test]
    fn test_parse_dsml_tool_calls_converts_fullwidth_markup() {
        let raw = r#"<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="todo_write">
<｜｜DSML｜｜parameter name="todos" string="false">[{"content":"calculator","id":"1","status":"completed"}]</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
<｜｜DSML｜｜invoke name="todo_read">
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>"#;

        let result = parse_dsml_tool_calls(raw);
        let DsmlToolCallParseResult::Parsed(calls) = result else {
            panic!("expected DSML tool calls to parse");
        };

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].function.name, "todo_write");
        let args: Value = serde_json::from_str(&calls[0].function.arguments).unwrap();
        assert_eq!(args["todos"][0]["status"], "completed");
        assert_eq!(calls[1].function.name, "todo_read");
        assert_eq!(calls[1].function.arguments, "{}");
    }

    /** Verify incomplete DSML blocks are held instead of leaking as text. */
    #[test]
    fn test_parse_dsml_tool_calls_reports_incomplete_block() {
        let result = parse_dsml_tool_calls(
            "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"todo_read\">",
        );

        assert!(matches!(result, DsmlToolCallParseResult::Incomplete));
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

    /** Verify role normalization accepts the provider-supported tool role. */
    #[test]
    fn test_normalize_prompt_role_accepts_tool_role() {
        assert_eq!(normalize_prompt_role("SYSTEM"), Some("system"));
        assert_eq!(normalize_prompt_role("USER"), Some("user"));
        assert_eq!(normalize_prompt_role("ASSISTANT"), Some("assistant"));
        assert_eq!(normalize_prompt_role("TOOL"), Some("tool"));
        assert_eq!(normalize_prompt_role("tool"), Some("tool"));
        assert_eq!(normalize_prompt_role("FUNCTION"), None);
    }

    /** Verify valid assistant tool-call transcripts pass provider preflight. */
    #[test]
    fn test_validate_prompt_tool_sequence_accepts_answered_tool_call() {
        let messages = vec![
            ModelPromptMessageDto {
                source_message_id: None,
                role: "USER".to_string(),
                content: "Please look this up".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
            ModelPromptMessageDto {
                source_message_id: None,
                role: "ASSISTANT".to_string(),
                content: String::new(),
                reasoning_content: None,
                tool_calls: Some(vec![ToolCallDto {
                    id: "call_1".to_string(),
                    call_type: "function".to_string(),
                    function: crate::dto::common::ToolCallFunctionDto {
                        name: "lookup".to_string(),
                        arguments: "{}".to_string(),
                    },
                }]),
                tool_call_id: None,
                name: None,
            },
            ModelPromptMessageDto {
                source_message_id: None,
                role: "TOOL".to_string(),
                content: "result".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: Some("call_1".to_string()),
                name: Some("lookup".to_string()),
            },
        ];

        assert!(validate_prompt_tool_sequence(&messages).is_ok());
    }

    /** Verify orphan tool messages are rejected before reaching strict providers. */
    #[test]
    fn test_validate_prompt_tool_sequence_rejects_orphan_tool_message() {
        let messages = vec![ModelPromptMessageDto {
            source_message_id: None,
            role: "tool".to_string(),
            content: "orphan".to_string(),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: Some("call_missing".to_string()),
            name: Some("lookup".to_string()),
        }];

        let error = validate_prompt_tool_sequence(&messages).expect_err("orphan tool should fail");

        assert_eq!(error.code, "INVALID_TOOL_TRANSCRIPT");
    }

    /** Verify assistant tool calls cannot be separated from their tool results. */
    #[test]
    fn test_validate_prompt_tool_sequence_rejects_missing_tool_result() {
        let messages = vec![
            ModelPromptMessageDto {
                source_message_id: None,
                role: "assistant".to_string(),
                content: String::new(),
                reasoning_content: None,
                tool_calls: Some(vec![ToolCallDto {
                    id: "call_1".to_string(),
                    call_type: "function".to_string(),
                    function: crate::dto::common::ToolCallFunctionDto {
                        name: "lookup".to_string(),
                        arguments: "{}".to_string(),
                    },
                }]),
                tool_call_id: None,
                name: None,
            },
            ModelPromptMessageDto {
                source_message_id: None,
                role: "user".to_string(),
                content: "continue".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
        ];

        let error = validate_prompt_tool_sequence(&messages).expect_err("missing tool result should fail");

        assert_eq!(error.code, "INVALID_TOOL_TRANSCRIPT");
    }

    /** Verify assistant tool-call turns use empty string content, not JSON null. */
    #[test]
    fn test_serialize_assistant_tool_calls_uses_empty_string_content() {
        let value = serialize_prompt_message(&ModelPromptMessageDto {
            source_message_id: None,
            role: "ASSISTANT".to_string(),
            content: String::new(),
            reasoning_content: None,
            tool_calls: Some(vec![ToolCallDto {
                id: "call_1".to_string(),
                call_type: "function".to_string(),
                function: crate::dto::common::ToolCallFunctionDto {
                    name: "lookup".to_string(),
                    arguments: "{}".to_string(),
                },
            }]),
            tool_call_id: None,
            name: None,
        }, ProviderProfile::OpenAiCompatible);

        assert_eq!(value.get("role").and_then(Value::as_str), Some("assistant"));
        assert_eq!(value.get("content").and_then(Value::as_str), Some(""));
        assert!(value.get("tool_calls").is_some());
        assert!(!value.get("content").is_some_and(Value::is_null));
    }

    /** Verify stored uppercase TOOL messages serialize to provider-compatible tool role. */
    #[test]
    fn test_serialize_tool_message_normalizes_role() {
        let value = serialize_prompt_message(&ModelPromptMessageDto {
            source_message_id: None,
            role: "TOOL".to_string(),
            content: "{\"ok\":true}".to_string(),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: Some("call_1".to_string()),
            name: Some("lookup".to_string()),
        }, ProviderProfile::OpenAiCompatible);

        assert_eq!(value.get("role").and_then(Value::as_str), Some("tool"));
        assert_eq!(value.get("tool_call_id").and_then(Value::as_str), Some("call_1"));
        assert_eq!(value.get("name").and_then(Value::as_str), Some("lookup"));
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
            provider_profile: ProviderProfile::OpenAiCompatible,
            base_url: format!("{}/v1", server.base_url()),
            api_key: Some("sk-live".to_string()),
            model_id: "gpt-4.1-mini".to_string(),
            request_model_name: "gpt-4.1-mini".to_string(),
            prompt_messages: vec![ModelPromptMessageDto {
                source_message_id: None,
                role: "USER".to_string(),
                content: "Hello provider".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            generation_params: Some(GenerationParamsDto {
                temperature: Some(0.2),
                top_p: None,
                max_tokens: Some(128),
                stream: true,
            }),
            tools: vec![],
            tool_choice: None,
            conversation_id: None,
            branch_id: None,
            workspace_path: None,
            activated_skill: None,
        };

        let (channel, events) = recording_channel();
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let outcome = stream_model_response(&request, &channel, cancel_rx)
            .await
            .expect("openai-compatible stream should succeed");

        let ModelStreamOutcome::Completed { usage, .. } = outcome else {
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
            provider_profile: ProviderProfile::Ollama,
            base_url: server.base_url(),
            api_key: None,
            model_id: "llama3.1".to_string(),
            request_model_name: "llama3.1".to_string(),
            prompt_messages: vec![ModelPromptMessageDto {
                source_message_id: None,
                role: "USER".to_string(),
                content: "Stream from ollama".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            generation_params: Some(GenerationParamsDto {
                temperature: Some(0.4),
                top_p: Some(0.95),
                max_tokens: Some(64),
                stream: true,
            }),
            tools: vec![],
            tool_choice: None,
            conversation_id: None,
            branch_id: None,
            workspace_path: None,
            activated_skill: None,
        };

        let (channel, events) = recording_channel();
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let outcome = stream_model_response(&request, &channel, cancel_rx)
            .await
            .expect("ollama native stream should succeed");

        let ModelStreamOutcome::Completed { usage, .. } = outcome else {
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
            provider_profile: ProviderProfile::Ollama,
            base_url: server.base_url(),
            api_key: None,
            model_id: "llama3.1".to_string(),
            request_model_name: "llama3.1".to_string(),
            prompt_messages: vec![ModelPromptMessageDto {
                source_message_id: None,
                role: "USER".to_string(),
                content: "Fallback please".to_string(),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            generation_params: None,
            tools: vec![],
            tool_choice: None,
            conversation_id: None,
            branch_id: None,
            workspace_path: None,
            activated_skill: None,
        };

        let (channel, events) = recording_channel();
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let outcome = stream_model_response(&request, &channel, cancel_rx)
            .await
            .expect("ollama fallback stream should succeed");

        let ModelStreamOutcome::Completed { usage, .. } = outcome else {
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
