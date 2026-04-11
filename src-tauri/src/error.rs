/**
 * @file error.rs
 * @description Unified error type for all Tauri commands.
 *
 * Design decisions:
 *   - Uses a struct (not enum) for consistent JSON shape across all errors
 *   - AppErrorCode enum provides type-safe error categorization
 *   - Each variant maps to a SCREAMING_SNAKE_CASE string for frontend matching
 *   - Implements std::error::Error for compatibility with anyhow/thiserror ecosystems
 *
 * Required dependencies: serde, serde_json
 */

use serde::{Deserialize, Serialize};

// ============================================================================
// Error Code Enum
// ============================================================================

/**
 * Categorized error codes for Tauri command failures.
 * Serialized as SCREAMING_SNAKE_CASE to match frontend conventions.
 */
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppErrorCode {
    /// Requested entity does not exist
    NotFound,

    /// Input validation failed (missing required fields, invalid format)
    InvalidArgument,

    /// Operation conflicts with current state (e.g., duplicate ID)
    Conflict,

    /// A business rule was violated (e.g., sending in COMPARE mode)
    InvariantViolation,

    /// Database query or connection error
    DbError,

    /// Failed to read/write OS secure storage for API keys
    SecureStorageError,
}

// ============================================================================
// AppError
// ============================================================================

/**
 * Unified error type returned by all Tauri commands.
 *
 * JSON shape:
 * ```json
 * {
 *   "code": "NOT_FOUND",
 *   "message": "Conversation abc not found",
 *   "details": null
 * }
 * ```
 *
 * Frontend can pattern-match on `code` for localized error handling.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub code: AppErrorCode,
    pub message: String,

    /// Optional machine-readable detail for debugging
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

// ============================================================================
// Constructors
// ============================================================================

impl AppError {
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::NotFound,
            message: msg.into(),
            details: None,
        }
    }

    pub fn invalid_argument(msg: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::InvalidArgument,
            message: msg.into(),
            details: None,
        }
    }

    pub fn conflict(msg: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::Conflict,
            message: msg.into(),
            details: None,
        }
    }

    pub fn invariant_violation(msg: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::InvariantViolation,
            message: msg.into(),
            details: None,
        }
    }

    pub fn db_error(msg: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::DbError,
            message: msg.into(),
            details: None,
        }
    }

    pub fn secure_storage_error(msg: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::SecureStorageError,
            message: msg.into(),
            details: None,
        }
    }

    /** Create with additional debug details */
    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }
}

// ============================================================================
// Trait Implementations
// ============================================================================

impl std::fmt::Display for AppErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = serde_json::to_string(self).unwrap_or_else(|_| "\"UNKNOWN\"".into());
        // Remove surrounding quotes from JSON string
        write!(f, "{}", s.trim_matches('"'))
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

// Allow conversion from sqlx errors
impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => AppError::not_found("Record not found"),
            sqlx::Error::Database(ref db_err) => {
                // SQLite constraint violations → Conflict or InvariantViolation
                if db_err.code().map_or(false, |c| c == "2067" || c == "1555") {
                    // UNIQUE constraint failed
                    AppError::conflict("Duplicate entry").with_details(db_err.message().to_string())
                } else {
                    AppError::db_error("Database operation failed")
                        .with_details(db_err.message().to_string())
                }
            }
            _ => AppError::db_error("Database error").with_details(err.to_string()),
        }
    }
}
