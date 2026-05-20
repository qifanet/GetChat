/**
 * @file provider_profiles.rs
 * @description Provider-specific request/response compatibility rules.
 *
 * Keep provider quirks out of model_stream_service so each vendor profile can
 * evolve independently while the stream parser remains provider-agnostic.
 */

use serde_json::{Map, Value};

/// Runtime profile used to adapt OpenAI-compatible request/response details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderProfile {
    OpenAiCompatible,
    DeepSeek,
    OpenRouter,
    Groq,
    Ollama,
}

impl ProviderProfile {
    /// Infer the best profile from persisted provider type and base URL.
    pub fn resolve(provider_type: &str, base_url: &str) -> Self {
        match provider_type.trim().to_ascii_uppercase().as_str() {
            "OLLAMA" => Self::Ollama,
            "DEEPSEEK" => Self::DeepSeek,
            "OPENROUTER" => Self::OpenRouter,
            "GROQ" => Self::Groq,
            _ => Self::from_base_url(base_url),
        }
    }

    fn from_base_url(base_url: &str) -> Self {
        let normalized = base_url.trim().to_ascii_lowercase();
        if normalized.contains("deepseek.com") {
            Self::DeepSeek
        } else if normalized.contains("openrouter.ai") {
            Self::OpenRouter
        } else if normalized.contains("groq.com") {
            Self::Groq
        } else {
            Self::OpenAiCompatible
        }
    }

    /// Whether assistant `reasoning_content` must be replayed in later turns.
    pub fn should_replay_reasoning_content(self) -> bool {
        matches!(self, Self::DeepSeek)
    }

    /// Apply provider-specific request body adjustments after the common body is built.
    pub fn apply_chat_request_body(self, _body: &mut Map<String, Value>) {
        match self {
            // DeepSeek thinking mode validates assistant reasoning continuity in
            // message history; no extra top-level flags are needed here.
            Self::DeepSeek | Self::OpenAiCompatible | Self::OpenRouter | Self::Groq | Self::Ollama => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ProviderProfile;

    #[test]
    fn resolves_deepseek_from_type_or_base_url() {
        assert_eq!(ProviderProfile::resolve("DEEPSEEK", "https://example.com"), ProviderProfile::DeepSeek);
        assert_eq!(
            ProviderProfile::resolve("OPENAI_COMPATIBLE", "https://api.deepseek.com/v1"),
            ProviderProfile::DeepSeek
        );
    }

    #[test]
    fn generic_openai_does_not_replay_reasoning_content() {
        assert!(!ProviderProfile::OpenAiCompatible.should_replay_reasoning_content());
        assert!(ProviderProfile::DeepSeek.should_replay_reasoning_content());
    }
}
