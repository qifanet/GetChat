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
use tokio::sync::{watch, Mutex};

const KEYRING_SERVICE_NAME: &str = "GetChat.ProviderApiKeys";

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
}
