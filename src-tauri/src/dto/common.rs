/**
 * @file dto/common.rs
 * @description Shared enums and sub-DTOs used across multiple DTO modules.
 *
 * All enum values use SCREAMING_SNAKE_CASE to match the frontend TypeScript
 * type definitions exactly. No conversion layer needed on the frontend.
 *
 * Naming convention: Frontend type → Rust enum/struct with matching serde rename.
 */

use serde::{Deserialize, Serialize};

// ============================================================================
// Shared Enums
// ============================================================================

/** Message role in the conversation tree — matches frontend MessageRole */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

/**
 * Lifecycle status of a message node — matches frontend MessageStatus.
 *
 * State transitions (DB-enforced):
 *   STREAMING → COMPLETED  (normal completion)
 *   STREAMING → FAILED     (error with optional retry)
 *   STREAMING → ABORTED    (user cancelled)
 *
 * Note: PENDING is a frontend-only transient state (before the Tauri
 * command returns). It is never stored in the DB.
 */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MessageStatus {
    Pending,
    Streaming,
    Completed,
    Failed,
    Aborted,
}

/** Status of a branch — matches frontend BranchStatus */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BranchStatus {
    Active,
    Archived,
}

/**
 * What triggered a fork operation — matches frontend ForkSourceType.
 *
 * - ROOT:            Initial branch of a new conversation
 * - CURRENT_LEAF:    User explicitly created a new branch from the leaf
 * - HISTORY_ASSISTANT: User continued from a historical assistant message
 * - HISTORY_USER_EDIT: User edited a historical user message
 * - VARIANT:         User continued from a variant with downstream conflict
 */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ForkSourceType {
    Root,
    CurrentLeaf,
    HistoryAssistant,
    HistoryUserEdit,
    Variant,
}

/** Message content format */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ContentFormat {
    Markdown,
    Plain,
}

/** Supported provider types — matches frontend ProviderType */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProviderType {
    OpenaiCompatible,
    Ollama,
}

// ============================================================================
// Shared Sub-DTOs
// ============================================================================

/**
 * Token usage statistics for a model generation request.
 * Matches frontend TokenUsage interface.
 */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<i32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<i32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i32>,
}

/**
 * Generation parameters for model requests.
 * Matches frontend GenerationParams interface.
 */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationParamsDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,

    #[serde(default)]
    pub stream: bool,
}
