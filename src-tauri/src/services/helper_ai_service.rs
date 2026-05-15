/**
 * @file helper_ai_service.rs
 * @description Non-streaming AI calls for background tasks (title generation, summaries).
 *
 * Unlike model_stream_service which uses SSE streaming + Channel IPC,
 * this service makes simple request/response HTTP calls and returns
 * the complete result. Suitable for background tasks where real-time
 * token display is not needed.
 */

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dto::common::ProviderType;
use crate::error::AppError;
use crate::repositories::{app_kv, provider_models, providers};
use crate::state::AppState;

// ============================================================================
// Title Generation
// ============================================================================

const TITLE_SYSTEM_PROMPT: &str = concat!(
    "根据对话内容生成简短标题。\n",
    "要求：\n",
    "- 不超过20字\n",
    "- 中文概括主题\n",
    "- 只输出标题，无任何其他内容"
);

const TITLE_MAX_USER_CHARS: usize = 500;
const TITLE_MAX_ASSISTANT_CHARS: usize = 300;

/** Result of a title generation attempt. */
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleGenerationResult {
    pub title: String,
}

/**
 * Auto-generate a conversation title using the configured helper model.
 *
 * Prerequisites:
 *   - helper_model_id must be configured in app_kv
 *   - The conversation must exist and have title_source = 'DEFAULT'
 *   - The conversation must have at least one user message
 *
 * On failure, returns silently (caller should fall back to default title).
 */
pub async fn generate_conversation_title(
    state: &tauri::State<'_, AppState>,
    conversation_id: &str,
) -> Result<Option<TitleGenerationResult>, AppError> {
    // 1. Check helper model is configured
    let helper_model_id = app_kv::get(&state.db, "helper_model_id")
        .await
        .map_err(AppError::from)?
        .and_then(|v| serde_json::from_str::<String>(&v).ok());

    let helper_model_id = match helper_model_id {
        Some(id) => {
            tracing::info!(helper_model_id = %id, "generate_conversation_title: helper model found");
            id
        }
        None => {
            tracing::info!("generate_conversation_title: no helper model configured, skipping");
            return Ok(None);
        }
    };

    // 2. Check conversation title_source is still DEFAULT
    let conversation = crate::repositories::conversations::find_by_id(&state.db, conversation_id)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

    tracing::info!(
        conv_id = %conversation_id,
        title_source = %conversation.title_source,
        title = %conversation.title,
        "generate_conversation_title: checking conversation"
    );

    if conversation.title_source != "DEFAULT" {
        tracing::info!(
            conv_id = %conversation_id,
            title_source = %conversation.title_source,
            "generate_conversation_title: title already set, skipping"
        );
        return Ok(None);
    }

    // 3. Resolve helper model → provider + request_name
    let model_row = provider_models::find_by_id(&state.db, &helper_model_id)
        .await
        .map_err(AppError::from)?;

    let model_row = match model_row {
        Some(row) => row,
        None => {
            tracing::warn!(
                helper_model_id = %helper_model_id,
                "generate_conversation_title: helper model not found in DB, skipping"
            );
            return Ok(None);
        }
    };

    let provider_row = providers::find_by_id(&state.db, &model_row.provider_id)
        .await
        .map_err(AppError::from)?;

    let provider_row = match provider_row {
        Some(row) => row,
        None => {
            tracing::warn!(
                provider_id = %model_row.provider_id,
                "generate_conversation_title: provider not found, skipping"
            );
            return Ok(None);
        }
    };

    // 4. Collect first user + assistant messages for the prompt
    let messages = collect_title_prompt_messages(&state.db, conversation_id).await?;

    tracing::info!(
        conv_id = %conversation_id,
        msg_count = messages.len(),
        "generate_conversation_title: collected messages"
    );

    if messages.is_empty() {
        tracing::info!("generate_conversation_title: no messages found, skipping");
        return Ok(None);
    }

    // 5. Make non-streaming AI call
    let api_key = if provider_row.r#type == "OLLAMA" {
        None
    } else {
        state.key_store.load(&provider_row.id).ok().flatten()
    };

    let provider_type = match provider_row.r#type.as_str() {
        "OLLAMA" => ProviderType::Ollama,
        _ => ProviderType::OpenaiCompatible,
    };

    tracing::info!(
        provider_type = ?provider_type,
        model = %model_row.request_name,
        base_url = %provider_row.base_url,
        "generate_conversation_title: calling helper model"
    );

    let title = match call_helper_model(
        provider_type,
        &provider_row.base_url,
        api_key.as_deref(),
        &model_row.request_name,
        &messages,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e.message, "generate_conversation_title: helper model call failed, skipping");
            return Ok(None);
        }
    };

    let title = truncate_title(&title);

    if title.is_empty() {
        tracing::info!("generate_conversation_title: empty title returned, skipping");
        return Ok(None);
    }

    // 6. Update conversation title
    crate::repositories::conversations::update_title_and_source(
        &state.db,
        conversation_id,
        &title,
        "AI_GENERATED",
    )
    .await
    .map_err(AppError::from)?;

    tracing::info!(
        conv_id = %conversation_id,
        title = %title,
        "generate_conversation_title: title updated"
    );

    Ok(Some(TitleGenerationResult { title }))
}

// ============================================================================
// Prompt Building
// ============================================================================

/** A simple message for the title generation prompt. */
struct TitlePromptMessage {
    role: String,
    content: String,
}

async fn collect_title_prompt_messages(
    pool: &sqlx::SqlitePool,
    conversation_id: &str,
) -> Result<Vec<TitlePromptMessage>, AppError> {
    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, role, content_text FROM messages \
         WHERE conversation_id = ? AND status = 'COMPLETED' \
         ORDER BY created_at ASC LIMIT 4",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)?;

    let mut messages = Vec::new();
    for (_id, role, content) in &rows {
        let max_chars = match role.as_str() {
            "USER" => TITLE_MAX_USER_CHARS,
            "ASSISTANT" => TITLE_MAX_ASSISTANT_CHARS,
            _ => continue,
        };
        let truncated: String = content.chars().take(max_chars).collect();
        messages.push(TitlePromptMessage {
            role: role.to_lowercase(),
            content: truncated,
        });
    }

    Ok(messages)
}

// ============================================================================
// Non-streaming API Call
// ============================================================================

async fn call_helper_model(
    provider_type: ProviderType,
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    messages: &[TitlePromptMessage],
) -> Result<String, AppError> {
    let prompt_messages: Vec<Value> = std::iter::once(json!({
        "role": "system",
        "content": TITLE_SYSTEM_PROMPT
    }))
    .chain(messages.iter().map(|m| {
        json!({
            "role": m.role,
            "content": m.content
        })
    }))
    .collect();

    match provider_type {
        ProviderType::Ollama => call_ollama(base_url, model_name, &prompt_messages).await,
        ProviderType::OpenaiCompatible => {
            call_openai_compatible(base_url, api_key, model_name, &prompt_messages).await
        }
    }
}

async fn call_ollama(
    base_url: &str,
    model_name: &str,
    messages: &[Value],
) -> Result<String, AppError> {
    let url = format!(
        "{}/api/chat",
        base_url.trim_end_matches("/v1").trim_end_matches('/')
    );

    tracing::info!(url = %url, model = %model_name, "call_ollama: sending request");

    let body = json!({
        "model": model_name,
        "messages": messages,
        "stream": false,
        "think": false,
        // Keep the helper context window aligned with streaming to avoid unexpected truncation.
        "options": { "num_ctx": 32768 }
    });

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "call_ollama: request failed");
            AppError::invalid_argument(format!("Ollama request failed: {e}"))
        })?;

    tracing::info!(status = %response.status(), "call_ollama: got response");

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        tracing::warn!(status = %status, body = %text, "Ollama title generation failed");
        return Ok(String::new());
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "call_ollama: response parse failed");
            AppError::invalid_argument(format!("Ollama response parse failed: {e}"))
        })?;

    let content = json["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    tracing::info!(content = %content, "call_ollama: extracted title");

    Ok(content)
}

async fn call_openai_compatible(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    messages: &[Value],
) -> Result<String, AppError> {
    let url = format!(
        "{}/chat/completions",
        base_url.trim_end_matches('/')
    );

    let mut request = reqwest::Client::new()
        .post(&url)
        .json(&json!({
            "model": model_name,
            "messages": messages,
            "stream": false,
            "max_tokens": 50,
        }))
        .timeout(std::time::Duration::from_secs(30));

    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|e| AppError::invalid_argument(format!("API request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        tracing::warn!(status = %status, body = %text, "OpenAI title generation failed");
        return Ok(String::new());
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| AppError::invalid_argument(format!("API response parse failed: {e}")))?;

    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(content)
}

fn truncate_title(title: &str) -> String {
    let trimmed = title.trim();
    let cleaned = trimmed.trim_matches('"').trim_matches('\'').trim();
    cleaned.chars().take(50).collect()
}

// ============================================================================
// Branch Diff Summary
// ============================================================================

const DIFF_SUMMARY_SYSTEM_PROMPT: &str = concat!(
    "你是一个对话分析助手。用户会给出两条分支路径的消息内容，请分析差异并总结。\n",
    "要求：\n",
    "- 用 Markdown 格式输出\n",
    "- 包含：各分支的关键观点、主要差异点、建议\n",
    "- 简洁明了，不超过300字\n",
    "- 使用中文"
);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummaryResult {
    pub summary: String,
}

/// Generate an AI summary of the differences between two branches.
pub async fn generate_branch_diff_summary(
    state: &AppState,
    conversation_id: &str,
    left_branch_id: &str,
    right_branch_id: &str,
) -> Result<Option<DiffSummaryResult>, AppError> {
    tracing::info!(
        conv_id = %conversation_id,
        left = %left_branch_id,
        right = %right_branch_id,
        "generate_branch_diff_summary: start"
    );

    // 1. Resolve helper model
    let helper_model_id = app_kv::get(&state.db, "helper_model_id")
        .await
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<String>(&raw).ok());
    let model_id = match helper_model_id {
        Some(id) => id,
        None => {
            tracing::info!("generate_branch_diff_summary: no helper model configured");
            return Ok(None);
        }
    };

    let model_row = provider_models::find_by_id(&state.db, &model_id)
        .await
        .map_err(|e| AppError::db_error(format!("Failed to query model: {e}")))?
        .ok_or_else(|| AppError::not_found(format!("Model not found: {model_id}")))?;

    let provider_row = providers::find_by_id(&state.db, &model_row.provider_id)
        .await
        .map_err(|e| AppError::db_error(format!("Failed to query provider: {e}")))?
        .ok_or_else(|| AppError::not_found("Provider not found"))?;

    let api_key = if provider_row.r#type == "OLLAMA" {
        None
    } else {
        state.key_store.load(&provider_row.id).ok().flatten()
    };

    // 2. Collect messages from both branches
    let all_messages = crate::repositories::messages::list_by_conversation(&state.db, conversation_id)
        .await
        .map_err(|e| AppError::db_error(format!("Failed to load messages: {e}")))?;

    let left_branch = crate::repositories::branches::find_by_id(&state.db, left_branch_id)
        .await
        .map_err(|e| AppError::db_error(format!("Failed to load left branch: {e}")))?;

    let right_branch = crate::repositories::branches::find_by_id(&state.db, right_branch_id)
        .await
        .map_err(|e| AppError::db_error(format!("Failed to load right branch: {e}")))?;

    let left_text = collect_branch_text(&all_messages, left_branch.and_then(|b| b.head_message_id).as_deref());
    let right_text = collect_branch_text(&all_messages, right_branch.and_then(|b| b.head_message_id).as_deref());

    if left_text.is_empty() && right_text.is_empty() {
        tracing::info!("generate_branch_diff_summary: both branches empty");
        return Ok(None);
    }

    // 3. Build prompt and call helper model
    let user_content = format!(
        "## 左分支内容\n{}\n\n## 右分支内容\n{}",
        if left_text.is_empty() { "（空）" } else { &left_text },
        if right_text.is_empty() { "（空）" } else { &right_text },
    );

    let messages = vec![TitlePromptMessage {
        role: "user".to_string(),
        content: user_content,
    }];

    let provider_type = match provider_row.r#type.as_str() {
        "OLLAMA" => ProviderType::Ollama,
        _ => ProviderType::OpenaiCompatible,
    };

    let summary = match call_diff_summary_model(
        provider_type,
        &provider_row.base_url,
        api_key.as_deref(),
        &model_row.request_name,
        &messages,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e.message, "generate_branch_diff_summary: helper model call failed");
            return Ok(None);
        }
    };

    if summary.is_empty() {
        tracing::info!("generate_branch_diff_summary: empty summary returned");
        return Ok(None);
    }

    tracing::info!(len = summary.len(), "generate_branch_diff_summary: success");
    Ok(Some(DiffSummaryResult { summary }))
}

/// Collect text content from a branch by walking from head towards root.
fn collect_branch_text(messages: &[crate::repositories::messages::MessageRow], head_id: Option<&str>) -> String {
    let Some(head_id) = head_id else { return String::new() };
    let msg_map: std::collections::HashMap<&str, &crate::repositories::messages::MessageRow> =
        messages.iter().map(|m| (m.id.as_str(), m)).collect();

    let mut path = Vec::new();
    let mut current_id = head_id;
    let mut count = 0;
    const MAX_MESSAGES: usize = 10;

    while let Some(msg) = msg_map.get(current_id) {
        path.push(format!("[{}] {}", msg.role, &msg.content_text.chars().take(300).collect::<String>()));
        current_id = match &msg.parent_message_id {
            Some(pid) => pid.as_str(),
            None => break,
        };
        count += 1;
        if count >= MAX_MESSAGES {
            break;
        }
    }

    path.reverse();
    path.join("\n")
}

/// Call the helper model for diff summary (higher token limit than title generation).
async fn call_diff_summary_model(
    provider_type: ProviderType,
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    messages: &[TitlePromptMessage],
) -> Result<String, AppError> {
    let prompt_messages: Vec<Value> = std::iter::once(json!({
        "role": "system",
        "content": DIFF_SUMMARY_SYSTEM_PROMPT
    }))
    .chain(messages.iter().map(|m| {
        json!({
            "role": m.role,
            "content": m.content
        })
    }))
    .collect();

    match provider_type {
        ProviderType::Ollama => call_ollama_summary(base_url, model_name, &prompt_messages).await,
        ProviderType::OpenaiCompatible => {
            call_openai_compatible_summary(base_url, api_key, model_name, &prompt_messages).await
        }
    }
}

async fn call_ollama_summary(
    base_url: &str,
    model_name: &str,
    messages: &[Value],
) -> Result<String, AppError> {
    let url = format!(
        "{}/api/chat",
        base_url.trim_end_matches("/v1").trim_end_matches('/')
    );

    let body = json!({
        "model": model_name,
        "messages": messages,
        "stream": false,
        "think": false,
        "options": { "num_ctx": 32768 }
    });

    let response = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| AppError::invalid_argument(format!("Ollama request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        tracing::warn!(status = %status, body = %text, "Ollama diff summary failed");
        return Ok(String::new());
    }

    let json: Value = response.json().await.map_err(|e| {
        AppError::invalid_argument(format!("Ollama response parse failed: {e}"))
    })?;

    Ok(json["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string())
}

async fn call_openai_compatible_summary(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    messages: &[Value],
) -> Result<String, AppError> {
    let url = format!(
        "{}/chat/completions",
        base_url.trim_end_matches('/')
    );

    let mut request = reqwest::Client::new()
        .post(&url)
        .json(&json!({
            "model": model_name,
            "messages": messages,
            "stream": false,
            "max_tokens": 1024,
        }))
        .timeout(std::time::Duration::from_secs(60));

    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|e| AppError::invalid_argument(format!("API request failed: {e}")))?;

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        tracing::warn!(body = %text, "OpenAI diff summary failed");
        return Ok(String::new());
    }

    let json: Value = response.json().await.map_err(|e| {
        AppError::invalid_argument(format!("API response parse failed: {e}"))
    })?;

    Ok(json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string())
}
