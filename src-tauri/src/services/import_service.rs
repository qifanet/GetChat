/**
 * @file import_service.rs
 * @description Import conversations from external formats (ChatGPT, GetChat JSON).
 *
 * Parses external JSON formats, converts them to GetChat's message tree model,
 * and persists them within a single SQLite transaction.
 */

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::AppError;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ============================================================================
// DTOs
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInput {
    pub format: String,
    pub json_content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported_count: u32,
    pub skipped_count: u32,
    pub errors: Vec<String>,
}

// ============================================================================
// ChatGPT format types
// ============================================================================

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ChatGptExport {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    create_time: Option<f64>,
    #[serde(default)]
    mapping: serde_json::Map<String, Value>,
}

#[derive(Debug, Deserialize)]
struct ChatGptNode {
    id: String,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    children: Vec<String>,
    #[serde(default)]
    message: Option<ChatGptMessage>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ChatGptMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<ChatGptContent>,
}

#[derive(Debug, Deserialize)]
struct ChatGptContent {
    #[serde(default)]
    parts: Vec<Value>,
}

// ============================================================================
// Import logic
// ============================================================================

pub async fn import_conversations(pool: &SqlitePool, input: &ImportInput) -> Result<ImportResult, AppError> {
    match input.format.as_str() {
        "chatgpt" => import_chatgpt(pool, &input.json_content).await,
        "getchat" => import_getchat(pool, &input.json_content).await,
        _ => Err(AppError::invalid_argument(format!("Unsupported import format: {}", input.format))),
    }
}

async fn import_chatgpt(pool: &SqlitePool, json_content: &str) -> Result<ImportResult, AppError> {
    let conversations: Vec<ChatGptExport> = serde_json::from_str(json_content)
        .map_err(|e| AppError::invalid_argument(format!("Invalid ChatGPT JSON: {}", e)))?;

    let mut imported_count = 0u32;
    let mut skipped_count = 0u32;
    let mut errors = Vec::new();

    for conv in &conversations {
        match import_single_chatgpt_conversation(pool, conv).await {
            Ok(()) => imported_count += 1,
            Err(e) => {
                let msg = format!(
                    "Skipped '{}': {}",
                    conv.title.as_deref().unwrap_or("untitled"),
                    e.message
                );
                tracing::warn!(%msg);
                errors.push(msg);
                skipped_count += 1;
            }
        }
    }

    Ok(ImportResult { imported_count, skipped_count, errors })
}

async fn import_single_chatgpt_conversation(
    pool: &SqlitePool,
    conv: &ChatGptExport,
) -> Result<(), AppError> {
    let ts = now_secs();
    let conv_id = uuid::Uuid::new_v4().to_string();
    let title = conv.title.as_deref().unwrap_or("Imported Conversation").to_string();

    // Parse nodes
    let mut nodes: Vec<ChatGptNode> = Vec::new();
    for (_, value) in &conv.mapping {
        match serde_json::from_value::<ChatGptNode>(value.clone()) {
            Ok(node) => nodes.push(node),
            Err(_) => continue,
        }
    }

    if nodes.is_empty() {
        return Err(AppError::invalid_argument("No valid nodes in mapping"));
    }

    // Build parent → children and find root
    let mut node_map: std::collections::HashMap<String, &ChatGptNode> = std::collections::HashMap::new();
    let mut root_id: Option<String> = None;
    for node in &nodes {
        if node.parent.is_none() {
            root_id = Some(node.id.clone());
        }
        node_map.insert(node.id.clone(), node);
    }

    let root_id = match root_id {
        Some(id) => id,
        None => return Err(AppError::invalid_argument("No root node found")),
    };

    // Collect valid messages (skip null messages and system role)
    // Build: chatgpt_node_id → (parent_chatgpt_id, role, text, children)
    let mut valid_messages: Vec<(String, Option<String>, String, String, Vec<String>)> = Vec::new();
    collect_valid_messages(&node_map, &root_id, &mut valid_messages)?;

    if valid_messages.is_empty() {
        return Err(AppError::invalid_argument("No user/assistant messages found"));
    }

    // Transaction
    let mut tx = pool.begin().await.map_err(AppError::from)?;

    // Create conversation
    crate::repositories::conversations::insert(&mut *tx, &conv_id, &title, ts)
        .await
        .map_err(AppError::from)?;

    // Map ChatGPT node IDs → GetChat message IDs
    let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut mainline_head_id: Option<String> = None;

    for (idx, (cg_id, cg_parent_id, role, text, children)) in valid_messages.iter().enumerate() {
        let _ = children;
        let msg_id = uuid::Uuid::new_v4().to_string();
        let parent_msg_id = cg_parent_id.as_ref().and_then(|pid| id_map.get(pid));

        let gc_role = match role.as_str() {
            "user" | "USER" => "USER",
            "assistant" | "ASSISTANT" => "ASSISTANT",
            _ => continue,
        };

        let depth = idx as i32;
        let sibling_index = 0i32;

        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, status, parent_message_id,
             depth, sibling_index, content_text, content_format, created_at, updated_at)
             VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, 'MARKDOWN', ?, ?)"
        )
        .bind(&msg_id)
        .bind(&conv_id)
        .bind(gc_role)
        .bind(parent_msg_id)
        .bind(depth)
        .bind(sibling_index)
        .bind(text)
        .bind(ts + idx as i64)
        .bind(ts + idx as i64)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;

        id_map.insert(cg_id.clone(), msg_id.clone());

        if idx == valid_messages.len() - 1 {
            mainline_head_id = Some(msg_id);
        }
    }

    // Create mainline branch
    let mainline_branch_id = uuid::Uuid::new_v4().to_string();
    crate::repositories::branches::insert(
        &mut *tx,
        &mainline_branch_id,
        &conv_id,
        "Mainline",
        "ACTIVE",
        None,
        None,
        "ROOT",
        None,
        mainline_head_id.as_deref(),
        None,
        ts,
    )
    .await
    .map_err(AppError::from)?;

    crate::repositories::conversations::set_mainline_branch(&mut *tx, &conv_id, &mainline_branch_id)
        .await
        .map_err(AppError::from)?;

    tx.commit().await.map_err(AppError::from)?;

    tracing::info!(
        conv_id = %conv_id,
        title = %title,
        messages = valid_messages.len(),
        "import_chatgpt: conversation imported"
    );

    Ok(())
}

fn collect_valid_messages<'a>(
    node_map: &std::collections::HashMap<String, &'a ChatGptNode>,
    root_id: &str,
    result: &mut Vec<(String, Option<String>, String, String, Vec<String>)>,
) -> Result<(), AppError> {
    // BFS walk following the first child to get the mainline path
    let mut current_id: Option<String> = Some(root_id.to_string());
    while let Some(cid) = current_id {
        let node = match node_map.get(&cid) {
            Some(n) => n,
            None => break,
        };

        if let Some(ref msg) = node.message {
            if let Some(ref role) = msg.role {
                let role_lower = role.to_lowercase();
                if role_lower == "user" || role_lower == "assistant" {
                    let text = extract_text(msg);
                    if !text.trim().is_empty() {
                        result.push((
                            node.id.clone(),
                            node.parent.clone(),
                            role_lower,
                            text,
                            node.children.clone(),
                        ));
                    }
                }
            }
        }

        // Follow first child for mainline
        current_id = node.children.first().cloned();
    }

    Ok(())
}

fn extract_text(msg: &ChatGptMessage) -> String {
    match &msg.content {
        Some(content) => {
            content.parts
                .iter()
                .filter_map(|p| p.as_str().map(String::from))
                .collect::<Vec<_>>()
                .join("\n")
        }
        None => String::new(),
    }
}

async fn import_getchat(pool: &SqlitePool, json_content: &str) -> Result<ImportResult, AppError> {
    let value: Value = serde_json::from_str(json_content)
        .map_err(|e| AppError::invalid_argument(format!("Invalid JSON: {}", e)))?;

    // Accept either a single snapshot or an array of snapshots
    let snapshots: Vec<&Value> = if value.is_array() {
        value.as_array().unwrap().iter().collect()
    } else {
        vec![&value]
    };

    let mut imported_count = 0u32;
    let mut skipped_count = 0u32;
    let mut errors = Vec::new();
    let ts = now_secs();

    for snapshot in &snapshots {
        let conv_title = snapshot["summary"]["title"].as_str().unwrap_or("Imported");
        let conv_id = uuid::Uuid::new_v4().to_string();

        let messages = match snapshot["messages"].as_array() {
            Some(m) => m,
            None => {
                errors.push(format!("Skipped '{}': no messages array", conv_title));
                skipped_count += 1;
                continue;
            }
        };

        if messages.is_empty() {
            errors.push(format!("Skipped '{}': empty messages", conv_title));
            skipped_count += 1;
            continue;
        }

        let mut tx = pool.begin().await.map_err(AppError::from)?;

        crate::repositories::conversations::insert(&mut *tx, &conv_id, conv_title, ts)
            .await
            .map_err(AppError::from)?;

        let mut msg_id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut head_id: Option<String> = None;

        for (idx, msg) in messages.iter().enumerate() {
            let old_id = msg["id"].as_str().unwrap_or("");
            let new_id = uuid::Uuid::new_v4().to_string();
            let role = msg["role"].as_str().unwrap_or("USER");
            let content = msg["content"].as_str().unwrap_or("");
            let parent_old = msg["parentId"].as_str().unwrap_or("");
            let parent_msg_id = if parent_old.is_empty() { None } else { msg_id_map.get(parent_old).cloned() };

            sqlx::query(
                "INSERT INTO messages (id, conversation_id, role, status, parent_message_id,
                 depth, sibling_index, content_text, content_format, created_at, updated_at)
                 VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, 'MARKDOWN', ?, ?)"
            )
            .bind(&new_id)
            .bind(&conv_id)
            .bind(role)
            .bind(parent_msg_id)
            .bind(idx as i32)
            .bind(0i32)
            .bind(content)
            .bind(ts + idx as i64)
            .bind(ts + idx as i64)
            .execute(&mut *tx)
            .await
            .map_err(AppError::from)?;

            msg_id_map.insert(old_id.to_string(), new_id.clone());
            head_id = Some(new_id);
        }

        // Create mainline branch
        let branch_id = uuid::Uuid::new_v4().to_string();
        crate::repositories::branches::insert(
            &mut *tx, &branch_id, &conv_id, "Mainline", "ACTIVE",
            None, None, "ROOT", None,
            head_id.as_deref(), None, ts,
        ).await.map_err(AppError::from)?;

        crate::repositories::conversations::set_mainline_branch(&mut *tx, &conv_id, &branch_id)
            .await.map_err(AppError::from)?;

        tx.commit().await.map_err(AppError::from)?;
        imported_count += 1;
    }

    Ok(ImportResult { imported_count, skipped_count, errors })
}
