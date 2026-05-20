/**
 * @file services/system_prompt_service.rs
 * @description Stores and normalizes the application-level system prompt.
 *
 * The system prompt is intentionally kept in app_kv instead of provider/model
 * rows because it is an application-wide instruction prefix. Prompt assembly
 * injects it as the first stable SYSTEM message to keep provider prompt-cache
 * prefixes deterministic across turns.
 */
use sqlx::SqlitePool;
use crate::error::AppError;
use crate::repositories::app_kv;
const SYSTEM_PROMPT_KEY: &str = "system_prompt_v1";
const MAX_SYSTEM_PROMPT_CHARS: usize = 12_000;
pub const DEFAULT_SYSTEM_PROMPT: &str = r#"You are GetChat, a local-first desktop AI assistant.
Core behavior:
- Reply in the user's language unless the user explicitly asks for another language.
- Be concise, accurate, and practical. Explain trade-offs when they affect architecture, security, data loss, or user experience.
- Use available tools when they materially improve correctness, inspect local project state, or complete the user's task. Do not invent tool results.
- When tool calls are needed, call tools step by step, wait for their results, and summarize what changed or what was learned.
- Treat destructive file, database, branch, or message-history operations as high risk. Require explicit user intent and follow approval prompts when they appear.
- Respect the active conversation branch, workspace sandbox, and provided context. If context is incomplete or approximate, say so briefly.
- Never request, reveal, or log secrets. Do not expose hidden reasoning or provider credentials."#;
fn normalize_line_endings(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}
fn normalize_system_prompt(value: &str) -> Result<String, AppError> {
    let normalized = normalize_line_endings(value).trim().to_string();
    let effective = if normalized.is_empty() {
        DEFAULT_SYSTEM_PROMPT.to_string()
    } else {
        normalized
    };
    if effective.chars().count() > MAX_SYSTEM_PROMPT_CHARS {
        return Err(AppError::invalid_argument(format!(
            "System prompt must be at most {MAX_SYSTEM_PROMPT_CHARS} characters"
        )));
    }
    Ok(effective)
}
/** Read the configured system prompt, falling back to the release default. */
pub async fn get_system_prompt(pool: &SqlitePool) -> Result<String, AppError> {
    let raw = app_kv::get(pool, SYSTEM_PROMPT_KEY)
        .await
        .map_err(AppError::from)?;

    let Some(raw) = raw else {
        return Ok(DEFAULT_SYSTEM_PROMPT.to_string());
    };
    let parsed = serde_json::from_str::<String>(&raw)
        .unwrap_or_else(|_| raw.trim_matches('"').to_string());
    normalize_system_prompt(&parsed)
}
/** Persist a user-edited system prompt and return the normalized value. */
pub async fn set_system_prompt(pool: &SqlitePool, prompt: &str) -> Result<String, AppError> {
    let normalized = normalize_system_prompt(prompt)?;
    let payload = serde_json::to_string(&normalized).map_err(|error| {
        AppError::invalid_argument(format!("Failed to serialize system prompt: {error}"))
    })?;

    app_kv::set(pool, SYSTEM_PROMPT_KEY, &payload)
        .await
        .map_err(AppError::from)?;
    Ok(normalized)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_prompt_resets_to_default() {
        let prompt = normalize_system_prompt("  \n  ").expect("prompt should normalize");
        assert_eq!(prompt, DEFAULT_SYSTEM_PROMPT);
    }
    #[test]
    fn normalizes_windows_line_endings() {
        let prompt = normalize_system_prompt("Line 1\r\nLine 2\rLine 3")
            .expect("prompt should normalize");
        assert_eq!(prompt, "Line 1\nLine 2\nLine 3");
    }
}
