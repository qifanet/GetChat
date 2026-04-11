/**
 * @file dto/settings.rs
 * @description Provider configuration DTOs and input types.
 *
 * Security note:
 *   - ProviderDto NEVER exposes api_key_ref or plaintext API keys to the frontend
 *   - has_api_key is a derived boolean (api_key_ref is non-empty)
 *   - SaveProviderInput accepts a raw api_key only for secure storage writing;
 *     the command layer stores it in OS secure storage and saves only the ref
 */

use serde::{Deserialize, Serialize};

use super::common::ProviderType;

// ============================================================================
// Output DTOs
// ============================================================================

/**
 * Provider model profile returned to the frontend.
 *
 * request_name is used for the real API request body, while display_name is
 * used in settings, selectors, and message badges.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelDto {
    pub id: String,
    pub provider_id: String,
    pub request_name: String,
    pub display_name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/**
 * Provider configuration returned to the frontend.
 * Matches frontend ProviderConfig, with api_key_ref replaced by has_api_key.
 *
 * Derived fields:
 *   - has_api_key: true if api_key_ref is non-empty in the DB
 *
 * Deliberately NOT returned: api_key_ref, any plaintext key
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDto {
    pub id: String,

    #[serde(rename = "type")]
    pub provider_type: ProviderType,

    pub name: String,
    pub base_url: String,
    pub default_model_id: Option<String>,
    pub models: Vec<ProviderModelDto>,

    /** Derived: true if a key reference exists in secure storage */
    pub has_api_key: bool,

    pub enabled: bool,

    /** Unix timestamp in milliseconds */
    pub created_at: i64,

    /** Unix timestamp in milliseconds */
    pub updated_at: i64,
}

// ============================================================================
// Input Types
// ============================================================================

/** Input for one provider model profile inside save_provider. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderModelInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub request_name: String,
    pub display_name: String,
}

/**
 * Input for saving (creating or updating) a provider configuration.
 *
 * - id = None → create new provider (auto-generated ID)
 * - id = Some → update existing provider
 * - api_key = Some("sk-...") → save key to OS secure storage
 * - api_key = None → keep existing key unchanged
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderInput {
    /// Provider ID. None for new providers (auto-generated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    #[serde(rename = "type")]
    pub provider_type: ProviderType,

    pub name: String,
    pub base_url: String,

    /**
     * Raw API key to store in OS secure storage.
     * Some(key) → update the stored key
     * None → keep existing key unchanged (useful for name/URL-only updates)
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model_id: Option<String>,

    #[serde(default)]
    pub models: Vec<SaveProviderModelInput>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}
