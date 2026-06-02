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
use crate::repositories::{app_kv, compressed_contexts, provider_models, providers};
use crate::services::prompt_service::PromptMessage;
use crate::state::AppState;

// ============================================================================
// Title Generation
// ============================================================================

const TITLE_SYSTEM_PROMPT: &str = concat!(
    "Based on the user's messages below, generate a concise conversation title.\n",
    "Requirements:\n",
    "- Maximum 20 characters\n",
    "- Use the same language as the user's messages\n",
    "- Output ONLY the title, nothing else"
);

const TITLE_MAX_USER_MESSAGES: usize = 3;
const TITLE_MAX_USER_CHARS: usize = 300;

/** Result of a title generation attempt. */
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleGenerationResult {
    pub title: Option<String>,
    /** When generation is skipped or fails, contains a human-readable reason. */
    pub skip_reason: Option<String>,
}

impl TitleGenerationResult {
    fn skipped(reason: &str) -> Self {
        Self { title: None, skip_reason: Some(reason.to_string()) }
    }

    fn success(title: String) -> Self {
        Self { title: Some(title), skip_reason: None }
    }
}

/**
 * Auto-generate a conversation title using the configured helper model.
 *
 * Returns TitleGenerationResult with either a new title or a skip_reason
 * explaining what happened. The frontend can use skip_reason for diagnostics.
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
            tracing::info!("generate_conversation_title: no helper model configured");
            return Ok(Some(TitleGenerationResult::skipped("NO_HELPER_MODEL")));
        }
    };

    // 2. Check conversation title_source is still DEFAULT
    let conversation = crate::repositories::conversations::find_by_id(&state.db, conversation_id)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::not_found("Conversation not found"))?;

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
                "generate_conversation_title: helper model not found in DB"
            );
            return Ok(Some(TitleGenerationResult::skipped("MODEL_NOT_FOUND")));
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
                "generate_conversation_title: provider not found"
            );
            return Ok(Some(TitleGenerationResult::skipped("PROVIDER_NOT_FOUND")));
        }
    };

    // 4. Collect first user messages for the prompt (only USER role, no assistant)
    let messages = collect_title_prompt_messages(&state.db, conversation_id).await?;

    tracing::info!(
        conv_id = %conversation_id,
        msg_count = messages.len(),
        "generate_conversation_title: collected messages"
    );

    if messages.is_empty() {
        tracing::info!("generate_conversation_title: no completed messages found");
        return Ok(Some(TitleGenerationResult::skipped("NO_MESSAGES")));
    }

    // 5. Make non-streaming AI call
    let api_key = if provider_row.r#type == "OLLAMA" {
        None
    } else {
        let key = state.key_store.load(&provider_row.id).ok().flatten();
        if key.is_none() {
            tracing::warn!(
                provider_id = %provider_row.id,
                "generate_conversation_title: API key not found in key store"
            );
        }
        key
    };

    let provider_type = match provider_row.r#type.as_str() {
        "OLLAMA" => ProviderType::Ollama,
        _ => ProviderType::OpenaiCompatible,
    };

    tracing::info!(
        provider_type = ?provider_type,
        model = %model_row.request_name,
        base_url = %provider_row.base_url,
        has_api_key = api_key.is_some(),
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
        Err(first_err) => {
            tracing::warn!(error = %first_err.message, "generate_conversation_title: first attempt failed, retrying in 500ms");
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            match call_helper_model(
                provider_type,
                &provider_row.base_url,
                api_key.as_deref(),
                &model_row.request_name,
                &messages,
            )
            .await
            {
                Ok(t) => t,
                Err(retry_err) => {
                    tracing::warn!(error = %retry_err.message, "generate_conversation_title: retry also failed");
                    return Ok(Some(TitleGenerationResult::skipped(&format!("API_ERROR_RETRY: {}", retry_err.message))));
                }
            }
        }
    };

    let title = truncate_title(&title);

    if title.is_empty() {
        tracing::info!("generate_conversation_title: empty title returned from model");
        return Ok(Some(TitleGenerationResult::skipped("EMPTY_RESPONSE")));
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

    Ok(Some(TitleGenerationResult::success(title)))
}

// ============================================================================
// Prompt Building
// ============================================================================

struct TitlePromptMessage {
    role: String,
    content: String,
}

async fn collect_title_prompt_messages(
    pool: &sqlx::SqlitePool,
    conversation_id: &str,
) -> Result<Vec<TitlePromptMessage>, AppError> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT id, content_text FROM messages \
         WHERE conversation_id = ? AND role = 'USER' AND status = 'COMPLETED' \
         ORDER BY created_at ASC LIMIT ?",
    )
    .bind(conversation_id)
    .bind(TITLE_MAX_USER_MESSAGES as i64)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)?;

    let messages: Vec<TitlePromptMessage> = rows
        .into_iter()
        .map(|(_id, content)| {
            let truncated: String = content.chars().take(TITLE_MAX_USER_CHARS).collect();
            TitlePromptMessage {
                role: "user".to_string(),
                content: truncated,
            }
        })
        .collect();

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
    let has_explicit_system_prompt = messages.iter().any(|m| m.role == "system");
    let prompt_messages: Vec<Value> = if has_explicit_system_prompt {
        messages
            .iter()
            .map(|m| {
                json!({
                    "role": m.role,
                    "content": m.content
                })
            })
            .collect()
    } else {
        std::iter::once(json!({
            "role": "system",
            "content": TITLE_SYSTEM_PROMPT
        }))
        .chain(messages.iter().map(|m| {
            json!({
                "role": m.role,
                "content": m.content
            })
        }))
        .collect()
    };

    match provider_type {
        ProviderType::Ollama => call_ollama(base_url, model_name, &prompt_messages).await,
        ProviderType::OpenaiCompatible
        | ProviderType::DeepSeek
        | ProviderType::OpenRouter
        | ProviderType::Groq => {
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
        return Err(AppError::invalid_argument(format!(
            "Ollama returned {}: {}", status, text
        )));
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

    // max_tokens must be generous enough for models with built-in reasoning
    // (e.g. GLM-5, DeepSeek V4 Flash use reasoning_content + content; if
    // max_tokens is too small, the reasoning chain consumes all tokens and
    // content is empty). 4096 tokens provides ample room for both the
    // internal reasoning chain and the structured summary output.
    let max_tokens: u32 = 4096;
    let mut request = reqwest::Client::new()
        .post(&url)
        .json(&json!({
            "model": model_name,
            "messages": messages,
            "stream": false,
            "max_tokens": max_tokens,
        }))
        .timeout(std::time::Duration::from_secs(90));

    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }

    tracing::info!(url = %url, model = %model_name, has_api_key = api_key.is_some(), "call_openai_compatible: sending request");

    let response = request
        .send()
        .await
        .map_err(|e| AppError::invalid_argument(format!("API request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        tracing::warn!(
            status = %status,
            body = %text,
            model = %model_name,
            url = %url,
            "call_openai_compatible: API returned non-2xx"
        );
        return Err(AppError::invalid_argument(format!(
            "API returned HTTP {}: {}", status, &text[..text.len().min(200)]
        )));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| AppError::invalid_argument(format!("API response parse failed: {e}")))?;

    let mut content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    if content.is_empty() {
        // Some reasoning models (e.g. GLM-5) may consume all tokens on the
        // reasoning chain and produce empty content.  When reasoning_content
        // is present, use it as a fallback so the caller still gets a usable
        // result instead of triggering an unnecessary retry.
        let reasoning = json["choices"][0]["message"]["reasoning_content"]
            .as_str()
            .unwrap_or("")
            .trim();
        if !reasoning.is_empty() {
            let finish_reason = json["choices"][0]["finish_reason"]
                .as_str()
                .unwrap_or("");
            tracing::warn!(
                has_reasoning = true,
                finish_reason = %finish_reason,
                reasoning_chars = reasoning.len(),
                "call_openai_compatible: content empty, using reasoning_content as fallback"
            );
            content = reasoning.to_string();
        } else {
            tracing::warn!(
                content_empty = true,
                has_reasoning_content = false,
                response_preview = %serde_json::to_string(&json).unwrap_or_default().chars().take(300).collect::<String>(),
                "call_openai_compatible: content is empty in API response"
            );
        }
    }

    tracing::info!(content_len = content.len(), "call_openai_compatible: extracted content");

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

/**
 * Generate an AI summary of differences between two branches.
 */
pub async fn generate_branch_diff_summary(
    state: &tauri::State<'_, AppState>,
    conversation_id: &str,
    left_branch_id: &str,
    right_branch_id: &str,
) -> Result<Option<DiffSummaryResult>, AppError> {
    // 0. Check cache first
    let cached = sqlx::query_as::<_, (String,)>(
        "SELECT summary_text FROM branch_diff_summaries \
         WHERE conversation_id = ? AND branch_a_id = ? AND branch_b_id = ?",
    )
    .bind(conversation_id)
    .bind(left_branch_id)
    .bind(right_branch_id)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::from)?;

    if let Some((text,)) = cached {
        tracing::info!(
            conv_id = %conversation_id,
            "generate_branch_diff_summary: cache hit"
        );
        return Ok(Some(DiffSummaryResult { summary: text }));
    }

    // 1. Resolve helper model
    let helper_model_id = app_kv::get(&state.db, "helper_model_id")
        .await
        .map_err(AppError::from)?
        .and_then(|v| serde_json::from_str::<String>(&v).ok());

    let helper_model_id = match helper_model_id {
        Some(id) => id,
        None => {
            tracing::info!("generate_branch_diff_summary: no helper model configured");
            return Ok(None);
        }
    };

    let model_row = provider_models::find_by_id(&state.db, &helper_model_id)
        .await
        .map_err(AppError::from)?;

    let model_row = match model_row {
        Some(row) => row,
        None => {
            tracing::warn!("generate_branch_diff_summary: helper model not found in DB");
            return Ok(None);
        }
    };

    let provider_row = providers::find_by_id(&state.db, &model_row.provider_id)
        .await
        .map_err(AppError::from)?;

    let provider_row = match provider_row {
        Some(row) => row,
        None => {
            tracing::warn!("generate_branch_diff_summary: provider not found");
            return Ok(None);
        }
    };

    // 2. Collect messages from both branches
    let left_messages = collect_branch_messages(&state.db, conversation_id, left_branch_id).await?;
    let right_messages = collect_branch_messages(&state.db, conversation_id, right_branch_id).await?;

    if left_messages.is_empty() && right_messages.is_empty() {
        tracing::info!("generate_branch_diff_summary: no messages in either branch");
        return Ok(None);
    }

    // 3. Build diff prompt
    let user_prompt = build_diff_user_prompt(&left_messages, &right_messages);

    let api_key = if provider_row.r#type == "OLLAMA" {
        None
    } else {
        state.key_store.load(&provider_row.id).ok().flatten()
    };

    let provider_type = match provider_row.r#type.as_str() {
        "OLLAMA" => ProviderType::Ollama,
        _ => ProviderType::OpenaiCompatible,
    };

    let diff_messages = vec![
        TitlePromptMessage { role: "system".to_string(), content: DIFF_SUMMARY_SYSTEM_PROMPT.to_string() },
        TitlePromptMessage { role: "user".to_string(), content: user_prompt },
    ];

    let summary = call_helper_model(
        provider_type,
        &provider_row.base_url,
        api_key.as_deref(),
        &model_row.request_name,
        &diff_messages,
    )
    .await
    .map_err(|e| {
        tracing::warn!(error = %e.message, "generate_branch_diff_summary: call failed");
        e
    })?;

    if summary.is_empty() {
        return Ok(None);
    }

    // Persist to cache (INSERT OR REPLACE)
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let cache_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT OR REPLACE INTO branch_diff_summaries (id, conversation_id, branch_a_id, branch_b_id, summary_text, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(&cache_id)
    .bind(conversation_id)
    .bind(left_branch_id)
    .bind(right_branch_id)
    .bind(&summary)
    .bind(now_secs)
    .execute(&state.db)
    .await
    .map_err(AppError::from)?;

    tracing::info!(
        conv_id = %conversation_id,
        "generate_branch_diff_summary: cached"
    );

    Ok(Some(DiffSummaryResult { summary }))
}

async fn collect_branch_messages(
    pool: &sqlx::SqlitePool,
    conversation_id: &str,
    branch_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT m.role, m.content_text \
         FROM messages m \
         JOIN branches b ON b.conversation_id = m.conversation_id \
         WHERE m.conversation_id = ? AND b.id = ? AND m.status = 'COMPLETED' \
         ORDER BY m.created_at ASC",
    )
    .bind(conversation_id)
    .bind(branch_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)?;

    Ok(rows
        .into_iter()
        .map(|(role, content)| format!("{}: {}", role, content))
        .collect())
}

fn build_diff_user_prompt(left: &[String], right: &[String]) -> String {
    let left_text = if left.is_empty() {
        "(无消息)".to_string()
    } else {
        left.join("\n")
    };
    let right_text = if right.is_empty() {
        "(无消息)".to_string()
    } else {
        right.join("\n")
    };
    format!(
        "分支A:\n{}\n\n分支B:\n{}\n\n请分析两条分支的差异。",
        left_text, right_text
    )
}

// ============================================================================
// Context Compression — opencode-inspired anchored iterative summarization
// ============================================================================

const COMPRESS_SYSTEM_PROMPT: &str = concat!(
    "你是一个锚定对话上下文总结助手，专为编程会话设计。\n\n",
    "任务：总结你收到的对话历史。最新的几轮可能被完整保留在摘要之外，因此请聚焦于更早但仍然重要的上下文。\n\n",
    "如果提示包含 <previous-summary> 块，将其视为当前锚定摘要，用新历史更新它：",
    "保留仍然有效的细节，移除过时内容，合并新事实。\n\n",
    "严格输出以下 Markdown 结构，保持章节顺序不变：\n\n",
    "## 目标\n",
    "- [一句话任务总结]\n\n",
    "## 约束与偏好\n",
    "- [用户约束、偏好、规格说明，或\"(无)\"]\n\n",
    "## 进展\n",
    "### 已完成\n",
    "- [已完成的工作，或\"(无)\"]\n\n",
    "### 进行中\n",
    "- [当前正在做的工作，或\"(无)\"]\n\n",
    "### 阻塞\n",
    "- [阻塞项，或\"(无)\"]\n\n",
    "## 关键决策\n",
    "- [决策及原因，或\"(无)\"]\n\n",
    "## 下一步\n",
    "- [按优先级排列的后续行动，或\"(无)\"]\n\n",
    "## 关键上下文\n",
    "- [重要技术事实、错误信息、未解决问题，或\"(无)\"]\n\n",
    "## 相关文件\n",
    "- [文件或目录路径：为何重要，或\"(无)\"]\n\n",
    "规则：\n",
    "- 每个章节都必须保留，即使内容为\"(无)\"\n",
    "- 使用简洁的要点，不要写段落\n",
    "- 保留确切的文件路径、命令、错误字符串和标识符\n",
    "- 使用与对话相同的语言\n",
    "- 不要提及总结过程或上下文被压缩"
);

const COMPRESS_KEEP_RECENT_SOURCE_MESSAGES: usize = 6;
const COMPRESS_MIN_SOURCE_MESSAGES: usize = 3;
const COMPRESS_MAX_MESSAGE_CHARS: usize = 2_000;
const COMPRESS_MIN_INPUT_CHARS: usize = 6_000;
const COMPRESS_MAX_INPUT_CHARS: usize = 60_000;

#[derive(Clone)]
struct CompressionSourceGroup<'a> {
    source_message_id: String,
    messages: Vec<&'a PromptMessage>,
}

fn compression_input_char_budget(context_window_kb: i32) -> usize {
    let context_tokens = context_window_kb.max(8) as usize * 1_000;
    context_tokens
        .saturating_mul(2)
        .clamp(COMPRESS_MIN_INPUT_CHARS, COMPRESS_MAX_INPUT_CHARS)
}

fn role_label(role: &str) -> &str {
    match role {
        "USER" => "用户",
        "ASSISTANT" => "助手",
        "SYSTEM" => "系统",
        "TOOL" => "工具",
        _ => role,
    }
}

fn append_limited(buf: &mut String, used_chars: &mut usize, max_chars: usize, text: &str) -> bool {
    if *used_chars >= max_chars {
        return false;
    }

    let remaining = max_chars - *used_chars;
    let text_chars = text.chars().count();
    if text_chars <= remaining {
        buf.push_str(text);
        *used_chars += text_chars;
        true
    } else {
        let chunk: String = text.chars().take(remaining).collect();
        buf.push_str(&chunk);
        *used_chars = max_chars;
        false
    }
}

fn build_compression_prompt_text(
    prior_summary: Option<&str>,
    groups: &[CompressionSourceGroup<'_>],
    max_chars: usize,
) -> (String, Vec<String>) {
    let mut text = String::new();
    let mut used_chars = 0usize;
    let mut included_ids = Vec::new();

    if let Some(summary) = prior_summary.filter(|value| !value.trim().is_empty()) {
        let summary_limit = (max_chars / 3).max(COMPRESS_MIN_INPUT_CHARS / 2);
        let capped_summary: String = summary.chars().take(summary_limit).collect();
        let prior_block = format!("【已有压缩摘要】\n{}\n\n", capped_summary);
        append_limited(&mut text, &mut used_chars, max_chars, &prior_block);
    }

    for group in groups {
        if used_chars >= max_chars {
            break;
        }

        let before_group = used_chars;
        for msg in &group.messages {
            if used_chars >= max_chars {
                break;
            }
            let content_preview: String = msg
                .content
                .chars()
                .take(COMPRESS_MAX_MESSAGE_CHARS)
                .collect();
            let entry = format!("【{}】{}\n\n", role_label(&msg.role), content_preview);
            append_limited(&mut text, &mut used_chars, max_chars, &entry);
        }

        if used_chars > before_group {
            included_ids.push(group.source_message_id.clone());
        }
    }

    (text, included_ids)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressContextResult {
    pub compressed_id: String,
    pub summary_text: String,
    pub compressed_message_count: u32,
    pub estimated_tokens: u32,
}

pub async fn compress_context(
    state: &tauri::State<'_, AppState>,
    conversation_id: &str,
    branch_id: &str,
    model_id: &str,
) -> Result<CompressContextResult, AppError> {
    // 1. Resolve the model to use for compression
    let model_row = provider_models::find_by_id(&state.db, model_id)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::not_found("Model not found"))?;

    let provider_row = providers::find_by_id(&state.db, &model_row.provider_id)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::not_found("Provider not found"))?;

    // 2. Collect all messages in the branch path
    let branch = crate::repositories::branches::find_by_id(&state.db, branch_id)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::not_found("Branch not found"))?;

    let up_to_id = branch.head_message_id.unwrap_or_default();
    if up_to_id.is_empty() {
        return Err(AppError::invalid_argument("Branch has no messages"));
    }

    let prompt_input = crate::dto::messages::BuildPromptMessagesInput {
        conversation_id: conversation_id.to_string(),
        up_to_message_id: up_to_id.clone(),
        max_tokens_budget: None,
        branch_id: Some(branch_id.to_string()),
        skills_dir: None,
        activated_skill: None,
    };

    let latest_context = compressed_contexts::find_latest_by_branch(
        &state.db,
        conversation_id,
        branch_id,
    )
    .await
    .map_err(AppError::from)?;
    let prior_summary = latest_context
        .as_ref()
        .map(|row| row.summary_text.as_str())
        .filter(|summary| !summary.trim().is_empty());
    let mut prior_compressed_ids = latest_context
        .as_ref()
        .and_then(|row| serde_json::from_str::<Vec<String>>(&row.compressed_message_ids).ok())
        .unwrap_or_default();

    let messages = crate::services::prompt_service::build_prompt_messages(&state.db, &prompt_input).await?;

    // 3. Split into prefix (synthetic) and persisted source groups.
    //    Only persisted messages with source_message_id are candidates
    //    for compression; synthetic prefixes are always retained.
    let mut source_groups: Vec<CompressionSourceGroup<'_>> = Vec::new();
    for msg in messages.iter().filter(|msg| msg.source_message_id.is_some()) {
        let source_message_id = msg.source_message_id.clone().unwrap_or_default();
        if source_groups
            .last()
            .is_some_and(|group| group.source_message_id == source_message_id)
        {
            if let Some(group) = source_groups.last_mut() {
                group.messages.push(msg);
            }
        } else {
            source_groups.push(CompressionSourceGroup {
                source_message_id,
                messages: vec![msg],
            });
        }
    }

    if source_groups.len() < COMPRESS_MIN_SOURCE_MESSAGES {
        return Err(AppError::invalid_argument("Not enough messages to compress"));
    }

    // 4. Compute token usage ratio and determine compression level.
    let context_budget = (model_row.context_window_kb.max(8) as u32) * 1000;
    let total_tokens: u32 = messages
        .iter()
        .map(crate::services::token_estimator::estimate_prompt_message_tokens)
        .sum();
    let usage_ratio = if context_budget > 0 {
        total_tokens as f32 / context_budget as f32
    } else {
        0.0
    };

    let compression_level = crate::services::importance_scorer::CompressionLevel::from_usage_ratio(usage_ratio);

    tracing::info!(
        conv_id = %conversation_id,
        branch_id = %branch_id,
        total_tokens,
        context_budget,
        usage_ratio = format!("{:.2}", usage_ratio),
        level = ?compression_level,
        source_groups = source_groups.len(),
        "compress_context: starting importance-aware compression"
    );

    if compression_level == crate::services::importance_scorer::CompressionLevel::None {
        return Err(AppError::invalid_argument(
            "Context usage is below compression threshold",
        ));
    }

    // 5. Score groups and plan compression actions.
    let keep_recent = if source_groups.len() > COMPRESS_KEEP_RECENT_SOURCE_MESSAGES + COMPRESS_MIN_SOURCE_MESSAGES {
        COMPRESS_KEEP_RECENT_SOURCE_MESSAGES
    } else {
        2
    };

    let cloned_groups: Vec<Vec<PromptMessage>> = source_groups
        .iter()
        .map(|g| g.messages.iter().map(|m| (*m).clone()).collect())
        .collect();

    let scored = crate::services::importance_scorer::score_groups(&cloned_groups);

    let plan = crate::services::importance_scorer::plan_compression(
        &scored,
        compression_level,
        keep_recent,
    );

    tracing::info!(
        level = ?compression_level,
        keep = plan.keep_count,
        compress = plan.compress_count,
        drop = plan.drop_count,
        "compress_context: compression plan"
    );

    // 6. Collect groups to compress (Compress action only; Keep and Drop are
    //    handled by the prompt builder skipping them).
    let mut compress_indices: Vec<usize> = plan
        .actions
        .iter()
        .filter(|(_, action, _)| *action == crate::services::importance_scorer::GroupAction::Compress)
        .map(|(idx, _, _)| *idx)
        .collect();

    if compress_indices.is_empty() {
        let recent_start = source_groups.len().saturating_sub(keep_recent);
        let fallback_take = match compression_level {
            crate::services::importance_scorer::CompressionLevel::Level1 => 1,
            crate::services::importance_scorer::CompressionLevel::Level2 => 2,
            crate::services::importance_scorer::CompressionLevel::Level3 => 3,
            crate::services::importance_scorer::CompressionLevel::None => 0,
        };
        compress_indices = plan
            .actions
            .iter()
            .filter(|(idx, action, _)| {
                *idx < recent_start
                    && *action == crate::services::importance_scorer::GroupAction::Keep
            })
            .map(|(idx, _, _)| *idx)
            .take(fallback_take)
            .collect();

        if !compress_indices.is_empty() {
            tracing::info!(
                selected = compress_indices.len(),
                level = ?plan.level,
                "compress_context: selected oldest retained groups as fallback compression input"
            );
        }
    }

    if compress_indices.is_empty() {
        return Err(AppError::invalid_argument("No compressible content"));
    }

    // Build the compression input from only the groups selected for compression.
    let compress_groups: Vec<CompressionSourceGroup<'_>> = compress_indices
        .iter()
        .map(|&idx| source_groups[idx].clone())
        .collect();

    // 7. Call the helper model for compression (single attempt, no retry loop).
    //    The structured summary template + generous max_tokens (1024) make
    //    empty summaries very unlikely. If the model still returns empty,
    //    the error propagates and the caller falls back to deterministic trimming.
    let api_key = if provider_row.r#type == "OLLAMA" {
        None
    } else {
        state.key_store.load(&provider_row.id).ok().flatten()
    };

    let provider_type = match provider_row.r#type.as_str() {
        "OLLAMA" => ProviderType::Ollama,
        _ => ProviderType::OpenaiCompatible,
    };

    let input_char_budget = compression_input_char_budget(model_row.context_window_kb);
    let (conversation_text, new_compressed_ids) = build_compression_prompt_text(
        prior_summary,
        &compress_groups,
        input_char_budget,
    );

    if conversation_text.trim().is_empty() || new_compressed_ids.is_empty() {
        return Err(AppError::invalid_argument("No compressible content"));
    }

    let compress_messages = vec![
        TitlePromptMessage { role: "system".to_string(), content: COMPRESS_SYSTEM_PROMPT.to_string() },
        TitlePromptMessage { role: "user".to_string(), content: conversation_text },
    ];

    let summary = match call_helper_model(
        provider_type,
        &provider_row.base_url,
        api_key.as_deref(),
        &model_row.request_name,
        &compress_messages,
    )
    .await
    {
        Ok(summary) if !summary.trim().is_empty() => summary,
        Ok(_) => {
            // Empty summary — single retry
            tracing::warn!(
                "compress_context: helper returned empty summary, retrying once"
            );
            match call_helper_model(
                provider_type,
                &provider_row.base_url,
                api_key.as_deref(),
                &model_row.request_name,
                &compress_messages,
            )
            .await
            {
                Ok(retry_summary) if !retry_summary.trim().is_empty() => retry_summary,
                Ok(_) => {
                    tracing::warn!("compress_context: retry also returned empty");
                    return Err(AppError::invalid_argument(
                        "Compression helper returned an empty summary after retry",
                    ));
                }
                Err(retry_err) => {
                    tracing::warn!(error = %retry_err, "compress_context: retry failed");
                    return Err(retry_err);
                }
            }
        }
        Err(error) => {
            // First attempt failed — single retry
            tracing::warn!(error = %error, "compress_context: first attempt failed, retrying once");
            match call_helper_model(
                provider_type,
                &provider_row.base_url,
                api_key.as_deref(),
                &model_row.request_name,
                &compress_messages,
            )
            .await
            {
                Ok(retry_summary) if !retry_summary.trim().is_empty() => retry_summary,
                Ok(_) => {
                    tracing::warn!("compress_context: retry returned empty summary");
                    return Err(AppError::invalid_argument(
                        "Compression helper returned an empty summary after retry",
                    ));
                }
                Err(retry_err) => {
                    tracing::warn!(error = %retry_err, "compress_context: retry also failed");
                    return Err(retry_err);
                }
            }
        }
    };

    // Collect compressed source IDs
    for id in new_compressed_ids {
        if !prior_compressed_ids.contains(&id) {
            prior_compressed_ids.push(id);
        }
    }
    // Also mark dropped groups as compressed (they're removed from context)
    for (idx, action, _) in &plan.actions {
        if *action == crate::services::importance_scorer::GroupAction::Drop {
            let source_id = &source_groups[*idx].source_message_id;
            if !prior_compressed_ids.contains(source_id) {
                prior_compressed_ids.push(source_id.clone());
            }
        }
    }
    let compressed_count = prior_compressed_ids.len();
    let compressed_ids = prior_compressed_ids;

    // 8. Estimate tokens for the summary
    let estimated_tokens = crate::services::token_estimator::estimate_tokens(&summary);

    // 9. Store in compressed_contexts
    let compressed_id = format!("cc_{}", uuid::Uuid::new_v4());
    let compressed_msg_ids_json = serde_json::to_string(&compressed_ids).unwrap_or_else(|_| "[]".to_string());

    let row = crate::repositories::compressed_contexts::CompressedContextRow {
        id: compressed_id.clone(),
        conversation_id: conversation_id.to_string(),
        branch_id: branch_id.to_string(),
        summary_text: summary.clone(),
        compressed_message_ids: compressed_msg_ids_json,
        token_count: estimated_tokens as i64,
        created_at: format!("{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()),
    };

    crate::repositories::compressed_contexts::create(&state.db, &row).await.map_err(AppError::from)?;

    tracing::info!(
        conv_id = %conversation_id,
        branch_id = %branch_id,
        compressed_id = %compressed_id,
        msg_count = compressed_count,
        estimated_tokens,
        level = ?compression_level,
        usage_ratio = format!("{:.2}", usage_ratio),
        "compress_context: importance-aware compression complete"
    );

    Ok(CompressContextResult {
        compressed_id,
        summary_text: summary,
        compressed_message_count: compressed_count as u32,
        estimated_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual smoke test for the real local Ollama compression path.
    ///
    /// Run only when a local Ollama server and model are available, for example:
    /// `GETCHAT_TEST_OLLAMA_MODEL=qwen3:4b cargo test local_ollama_compression_smoke -- --ignored`.
    #[tokio::test]
    #[ignore = "requires a running local Ollama server and GETCHAT_TEST_OLLAMA_MODEL"]
    async fn local_ollama_compression_smoke() {
        let base_url = std::env::var("GETCHAT_TEST_OLLAMA_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:11434".to_string());
        let model_name = std::env::var("GETCHAT_TEST_OLLAMA_MODEL")
            .expect("set GETCHAT_TEST_OLLAMA_MODEL to an installed Ollama model name");
        let conversation_text = [
            "【用户】请调研上下文压缩方案，并列出风险。",
            "【助手】方案一：保留最近消息，压缩旧工具结果。风险是摘要丢失细节。",
            "【用户】继续补充 ReAct loop 中每轮预算检查和状态推送设计。",
            "【助手】每轮请求前估算 prompt + tools token，超过阈值时触发压缩或裁剪。",
        ]
        .join("\n\n");
        let messages = vec![
            TitlePromptMessage {
                role: "system".to_string(),
                content: COMPRESS_SYSTEM_PROMPT.to_string(),
            },
            TitlePromptMessage {
                role: "user".to_string(),
                content: conversation_text,
            },
        ];

        let summary = call_helper_model(
            ProviderType::Ollama,
            &base_url,
            None,
            &model_name,
            &messages,
        )
        .await
        .expect("local Ollama compression call should succeed");

        assert!(!summary.trim().is_empty());
    }
}
