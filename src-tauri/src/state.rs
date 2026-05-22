/**
 * @file state.rs
 * @description Shared application state injected into all Tauri commands.
 *
 * AppState holds:
 *   - db: SqlitePool for all database operations
 *   - key_store: SecureKeyStore implementation for API key management
 *
 * Security design:
 *   API keys flow through SecureKeyStore ONLY:
 *   - save_provider: raw key → key_store.save() → store ref in DB
 *   - list_providers: check key_store.has_key() → return has_api_key: bool
 *   - test_provider: key_store.load() → use key for test request → never return key
 *
 * The frontend NEVER receives api_key_ref or plaintext keys.
 */

use sqlx::SqlitePool;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{watch, Mutex, oneshot};

const KEYRING_SERVICE_NAME: &str = "GetChat.ProviderApiKeys";

pub const TOOL_LIMITS_KV_KEY: &str = "tool_limits";
pub const BUILTIN_DISABLED_TOOLS_KV_KEY: &str = "builtin_disabled_tools";
pub const SECURITY_POLICY_KV_KEY: &str = "security_policy";

// ============================================================================
// Secure Key Store Trait
// ============================================================================

/**
 * Abstraction for secure API key storage.
 * Implementations use OS-specific secure storage:
 *   - macOS: Keychain
 *   - Windows: Credential Manager
 *   - Linux: libsecret / keyring
 *
 * The key parameter is a provider-specific identifier (e.g., "provider:{id}").
 */
pub trait SecureKeyStore: Send + Sync {
    /** Save a key and return a storage reference. */
    fn save(&self, provider_id: &str, key: &str) -> Result<String, String>;

    /** Load a key by provider ID. Returns None if not found. */
    fn load(&self, provider_id: &str) -> Result<Option<String>, String>;

    /** Delete a stored key. */
    fn delete(&self, provider_id: &str) -> Result<(), String>;

    /** Check if a key exists for this provider. */
    fn exists(&self, provider_id: &str) -> Result<bool, String>;
}

/** Build the deterministic storage reference persisted in SQLite. */
fn build_key_ref(provider_id: &str) -> String {
    format!("keyring://{KEYRING_SERVICE_NAME}/{provider_id}")
}

/** Normalize keyring crate errors into stable string messages. */
fn map_keyring_error(error: keyring::Error) -> String {
    error.to_string()
}

/** Real OS-backed secure storage built on top of the cross-platform keyring crate. */
pub struct SystemKeyStore {
    service_name: String,
}

impl SystemKeyStore {
    pub fn new() -> Self {
        Self {
            service_name: KEYRING_SERVICE_NAME.to_string(),
        }
    }

    /** Create the keyring entry for a provider-scoped credential. */
    fn entry(&self, provider_id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service_name, provider_id).map_err(map_keyring_error)
    }
}

impl SecureKeyStore for SystemKeyStore {
    fn save(&self, provider_id: &str, key: &str) -> Result<String, String> {
        let entry = self.entry(provider_id)?;
        entry.set_password(key).map_err(map_keyring_error)?;
        Ok(build_key_ref(provider_id))
    }

    fn load(&self, provider_id: &str) -> Result<Option<String>, String> {
        let entry = self.entry(provider_id)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn delete(&self, provider_id: &str) -> Result<(), String> {
        let entry = self.entry(provider_id)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn exists(&self, provider_id: &str) -> Result<bool, String> {
        Ok(self.load(provider_id)?.is_some())
    }
}

// ============================================================================
// App State
// ============================================================================

/** Runtime cancellation registry for active provider streams. */
pub type ActiveModelStreamRegistry =
    Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;

/** Shared application state, managed by Tauri's state system. */
pub struct AppState {
    pub db: SqlitePool,
    pub key_store: Box<dyn SecureKeyStore>,
    pub active_model_streams: ActiveModelStreamRegistry,
    pub tool_executor: Box<dyn crate::services::tool_executor::ToolExecutor>,
    pub tool_limits: Arc<Mutex<ToolLimits>>,
    pub security_policy: Arc<Mutex<SecurityPolicy>>,
    pub pending_approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    pub mcp_manager: Arc<Mutex<crate::services::mcp_client::McpManager>>,
    pub app_handle: tauri::AppHandle,
}

/** Configuration for tool-calling loop limits. */
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolLimits {
    /** Maximum consecutive tool call rounds (default: 10). */
    pub max_iterations: u32,
    /** Maximum consecutive tool failures before soft-stopping (default: 7). */
    pub max_consecutive_failures: u32,
    /** Approval timeout in seconds for destructive tools (default: 60). */
    pub approval_timeout_secs: u32,
}

impl Default for ToolLimits {
    fn default() -> Self {
        Self {
            max_iterations: 10,
            max_consecutive_failures: 7,
            approval_timeout_secs: 60,
        }
    }
}

impl ToolLimits {
    pub fn normalized(mut self) -> Self {
        self.max_iterations = self.max_iterations.clamp(1, 50);
        self.max_consecutive_failures = self.max_consecutive_failures.clamp(1, 20);
        self.approval_timeout_secs = self.approval_timeout_secs.clamp(10, 300);
        self
    }
}

// ============================================================================
// Security Policy
// ============================================================================

/** Security level controlling how aggressively approval is required. */
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityLevel {
    /** Only destructive write operations require approval. */
    Permissive,
    /** Write operations + terminal commands matching blacklist require approval (default). */
    Standard,
    /** All file writes and all terminal commands require approval. */
    Strict,
}

impl Default for SecurityLevel {
    fn default() -> Self {
        Self::Standard
    }
}

impl SecurityLevel {
    pub fn from_u8(level: u8) -> Self {
        match level {
            0 => Self::Permissive,
            1 => Self::Standard,
            2.. => Self::Strict,
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            Self::Permissive => 0,
            Self::Standard => 1,
            Self::Strict => 2,
        }
    }
}

/**
 * Policy governing which tool operations require user approval.
 *
 * Stored in app_kv as JSON. Blacklist entries are regex patterns matched
 * against command text (terminal) or file paths (file write).
 */
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SecurityPolicy {
    /** Current security level. */
    pub level: SecurityLevel,
    /** Regex patterns for terminal commands that always require approval. */
    pub terminal_blacklist: Vec<String>,
    /** Regex patterns for file paths that always require approval on write. */
    pub file_write_blacklist: Vec<String>,
}

impl Default for SecurityPolicy {
    fn default() -> Self {
        Self {
            level: SecurityLevel::Standard,
            terminal_blacklist: vec![
                r"rm\s+-rf\s+/".to_string(),
                r"del\s+/[sS]".to_string(),
                r"format\s+[a-zA-Z]:".to_string(),
                r"shutdown".to_string(),
                r"reboot".to_string(),
                r"rmdir\s+/[sS]".to_string(),
                r"rd\s+/[sS]".to_string(),
                r"taskkill".to_string(),
                r"reg\s+(delete|add)".to_string(),
                r"net\s+(user|localgroup)".to_string(),
                r"curl\s+.*\|\s*(ba)?sh".to_string(),
                r"wget\s+.*\|\s*(ba)?sh".to_string(),
                r"chmod\s+777".to_string(),
                r"iex\s*\(".to_string(),
                r"Invoke-Expression".to_string(),
                r"Start-Process.*-Verb\s+RunAs".to_string(),
            ],
            file_write_blacklist: vec![
                r"\.env$".to_string(),
                r"(?i)credential".to_string(),
                r"(?i)password".to_string(),
                r"(?i)secret".to_string(),
            ],
        }
    }
}
