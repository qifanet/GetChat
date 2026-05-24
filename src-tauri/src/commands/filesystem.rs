/**
 * @file commands/filesystem.rs
 * @description Filesystem exploration commands for the file preview sidebar.
 *
 * These commands are read-only and scoped to the conversation's workspace directory.
 * They are NOT part of the tool executor — they serve the frontend UI directly.
 *
 * Security: all path arguments are validated against the workspace root to prevent
 * directory traversal. Paths outside the workspace are rejected.
 */

use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::state::AppState;
use tauri::State;

// ============================================================================
// DTOs
// ============================================================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewDto {
    pub path: String,
    pub content: String,
    pub total_lines: usize,
    pub truncated: bool,
    pub language: Option<String>,
    pub is_binary: bool,
    pub file_size: u64,
}

// ============================================================================
// Helpers
// ============================================================================

/// Resolve and validate a path against the workspace root.
async fn resolve_workspace_path(
    state: &State<'_, AppState>,
    conversation_id: &str,
    relative_or_absolute: &str,
) -> Result<PathBuf, AppError> {
    let ws_root = {
        let db = &state.db;
        crate::repositories::conversations::get_workspace_path(db, conversation_id)
            .await?
            .ok_or_else(|| AppError::invalid_argument("Conversation has no workspace directory"))?
    };

    let ws_root = Path::new(&ws_root);
    if !ws_root.exists() {
        return Err(AppError::not_found("Workspace directory does not exist"));
    }

    let candidate = if Path::new(relative_or_absolute).is_absolute() {
        PathBuf::from(relative_or_absolute)
    } else {
        ws_root.join(relative_or_absolute)
    };

    // Canonicalize both to resolve symlinks and normalize
    let canonical_root = ws_root
        .canonicalize()
        .map_err(|e| AppError::not_found(&format!("Cannot resolve workspace root: {e}")))?;
    let canonical_candidate = candidate
        .canonicalize()
        .or_else(|_| {
            // Path may not exist yet — check parent
            candidate
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .map(|p| p.join(candidate.file_name().unwrap_or_default()))
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "path not found"))
        })
        .map_err(|e| AppError::not_found(&format!("Cannot resolve path: {e}")))?;

    // Security: ensure the resolved path is within the workspace root
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(AppError::invalid_argument(
            "Path is outside the workspace directory",
        ));
    }

    Ok(canonical_candidate)
}

/// Infer a language identifier from file extension.
fn infer_language(path: &Path) -> Option<String> {
    match path.extension().and_then(|e| e.to_str())?.to_lowercase().as_str() {
        "rs" => Some("rust".to_string()),
        "ts" | "tsx" => Some("typescript".to_string()),
        "js" | "jsx" => Some("javascript".to_string()),
        "py" => Some("python".to_string()),
        "md" => Some("markdown".to_string()),
        "json" => Some("json".to_string()),
        "toml" => Some("toml".to_string()),
        "yaml" | "yml" => Some("yaml".to_string()),
        "html" => Some("html".to_string()),
        "css" | "scss" => Some("css".to_string()),
        "sql" => Some("sql".to_string()),
        "go" => Some("go".to_string()),
        "java" => Some("java".to_string()),
        "c" | "h" => Some("c".to_string()),
        "cpp" | "hpp" | "cc" => Some("cpp".to_string()),
        "sh" | "bash" => Some("bash".to_string()),
        "ps1" => Some("powershell".to_string()),
        _ => None,
    }
}

// ============================================================================
// Commands
// ============================================================================

/// List directory entries within the workspace.
/// Returns immediate children (non-recursive).
#[tauri::command]
pub async fn list_directory_entries(
    state: State<'_, AppState>,
    conversation_id: String,
    dir_path: String,
) -> Result<Vec<DirectoryEntryDto>, AppError> {
    let resolved = resolve_workspace_path(&state, &conversation_id, &dir_path).await?;

    if !resolved.is_dir() {
        return Err(AppError::invalid_argument("Path is not a directory"));
    }

    let mut entries = Vec::new();
    let mut read_dir = std::fs::read_dir(&resolved)
        .map_err(|e| AppError::db_error(&format!("Cannot read directory: {e}")))?;

    while let Some(entry) = read_dir
        .next()
        .transpose()
        .map_err(|e| AppError::db_error(&format!("Cannot read entry: {e}")))?
    {
        let name = entry
            .file_name()
            .to_str()
            .unwrap_or("(invalid)")
            .to_string();

        // Skip hidden files/dirs (starting with .)
        if name.starts_with('.') {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => match std::fs::metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => continue,
            },
        };

        let modified = metadata
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);

        entries.push(DirectoryEntryDto {
            path: entry.path().to_str().unwrap_or("").to_string(),
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified,
        });
    }

    // Sort: directories first, then files, alphabetically within each group
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// Check if bytes appear to be binary (contain null bytes in the first 8 KB).
fn is_likely_binary(data: &[u8]) -> bool {
    let check_len = data.len().min(8192);
    data[..check_len].iter().any(|&b| b == 0)
}

/// Known binary file extensions that should not be read as text.
const BINARY_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite", "sqlite3",
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff",
    "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "zst", "cab", "deb", "rpm",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
    "pdf", "psd", "ai", "eps",
    "mp3", "mp4", "avi", "mkv", "mov", "wmv", "flv", "wav", "ogg", "flac",
    "iso", "dmg", "msi", "apk", "jar", "war",
    "woff", "woff2", "ttf", "otf", "eot",
    "pyc", "class", "o", "obj", "pdb",
];

fn is_known_binary_extension(path: &Path) -> bool {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return false,
    };
    BINARY_EXTENSIONS.contains(&ext.as_str())
}

fn format_file_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

/// Read a file's content for preview. Handles binary files gracefully.
#[tauri::command]
pub async fn read_file_preview(
    state: State<'_, AppState>,
    conversation_id: String,
    file_path: String,
    max_lines: Option<usize>,
) -> Result<FilePreviewDto, AppError> {
    let resolved = resolve_workspace_path(&state, &conversation_id, &file_path).await?;

    if !resolved.is_file() {
        return Err(AppError::invalid_argument("Path is not a file"));
    }

    let metadata = std::fs::metadata(&resolved)
        .map_err(|e| AppError::db_error(&format!("Cannot read file metadata: {e}")))?;
    let file_size = metadata.len();

    // Fast path: known binary extension → skip reading content
    if is_known_binary_extension(&resolved) {
        return Ok(FilePreviewDto {
            path: resolved.to_str().unwrap_or("").to_string(),
            content: String::new(),
            total_lines: 0,
            truncated: false,
            language: infer_language(&resolved),
            is_binary: true,
            file_size,
        });
    }

    // Enforce maximum file size to prevent OOM on large files
    const MAX_PREVIEW_BYTES: u64 = 4 * 1024 * 1024; // 4 MB
    if file_size > MAX_PREVIEW_BYTES {
        return Ok(FilePreviewDto {
            path: resolved.to_str().unwrap_or("").to_string(),
            content: format!(
                "File too large to preview ({}). Maximum preview size is {}.",
                format_file_size(file_size),
                format_file_size(MAX_PREVIEW_BYTES),
            ),
            total_lines: 0,
            truncated: true,
            language: infer_language(&resolved),
            is_binary: false,
            file_size,
        });
    }

    // Read raw bytes first for binary detection
    let raw_bytes = std::fs::read(&resolved)
        .map_err(|e| AppError::db_error(&format!("Cannot read file: {e}")))?;

    if is_likely_binary(&raw_bytes) {
        return Ok(FilePreviewDto {
            path: resolved.to_str().unwrap_or("").to_string(),
            content: String::new(),
            total_lines: 0,
            truncated: false,
            language: infer_language(&resolved),
            is_binary: true,
            file_size,
        });
    }

    // Text file: decode as UTF-8
    let content = String::from_utf8(raw_bytes)
        .map_err(|e| AppError::db_error(&format!("Cannot decode file as UTF-8: {e}")))?;

    let limit = max_lines.unwrap_or(500);
    let total_lines = content.lines().count();
    let truncated = total_lines > limit;

    let display_content = if truncated {
        content.lines().take(limit).collect::<Vec<_>>().join("\n")
    } else {
        content
    };

    Ok(FilePreviewDto {
        path: resolved.to_str().unwrap_or("").to_string(),
        content: display_content,
        total_lines,
        truncated,
        language: infer_language(&resolved),
        is_binary: false,
        file_size,
    })
}

/// Open a path in the system file manager (Finder / Explorer / etc.).
/// Validates that the path falls within the conversation's workspace directory.
#[tauri::command]
pub async fn reveal_in_file_manager(
    state: State<'_, AppState>,
    conversation_id: String,
    path: String,
) -> Result<(), AppError> {
    let workspace = resolve_workspace_path(&state, &conversation_id, "").await?;
    let p = Path::new(&path);

    if !p.exists() {
        return Err(AppError::not_found("Path does not exist"));
    }

    // Ensure the path is within the workspace directory
    let canonical_path = p.canonicalize().map_err(|_| AppError::invalid_argument("Invalid path"))?;
    let canonical_workspace = workspace.canonicalize().map_err(|_| AppError::invalid_argument("Invalid workspace"))?;
    if !canonical_path.starts_with(&canonical_workspace) {
        return Err(AppError::invalid_argument("Path is outside the workspace directory"));
    }

    tauri_plugin_opener::reveal_item_in_dir(
        p.to_str().ok_or_else(|| AppError::invalid_argument("Invalid path encoding"))?,
    )
    .map_err(|e| AppError::db_error(&format!("Cannot open file manager: {e}")))?;

    Ok(())
}
