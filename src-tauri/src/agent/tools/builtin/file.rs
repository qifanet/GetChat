/**
 * @file agent/tools/builtin/file.rs
 * @description Unified `file` tool — read/write/list/search inside the
 * workspace sandbox. Verbatim relocation from services/tool_executor.rs (M2.1).
 */

use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{json, Value};

use crate::agent::tools::executor::{BuiltinToolExecutor, ToolExecutionContext, ToolExecutionResult};
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta, ToolRisk};
use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

/** Register the unified file tool — merges file_read, file_write, file_list, grep. */
pub(crate) fn register(executor: &mut BuiltinToolExecutor) {
    let definition = ToolDefinitionDto {
        tool_type: "function".to_string(),
        function: ToolFunctionDefDto {
            name: "file".to_string(),
            description: "File operations within the workspace sandbox. All paths must be within the configured workspace directory.\n\nActions:\n- read: Read file contents with line numbers. Supports offset/limit and multiple encodings (utf-8, gbk, gb2312, gb18030, big5, shift_jis, latin1).\n- write: Create or overwrite a file. Creates parent directories if needed. Max 100KB.\n- list: List directory contents with sizes and types. Supports recursive listing.\n- search: Search file contents with regex pattern. Limited to 50 results.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["read", "write", "list", "search"],
                        "description": "The file operation to perform"
                    },
                    "path": {
                        "type": "string",
                        "description": "File or directory path (relative to workspace root, or absolute path within workspace)"
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write (required for write action)"
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Starting line number for read (0-indexed, default: 0)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum lines to read (default: 2000)"
                    },
                    "encoding": {
                        "type": "string",
                        "description": "Character encoding for read (utf-8, gbk, gb2312, gb18030, big5, shift_jis, latin1, default: utf-8)"
                    },
                    "recursive": {
                        "type": "boolean",
                        "description": "Recurse into subdirectories (for list/search)"
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Regex pattern to search for (required for search action)"
                    },
                    "include": {
                        "type": "string",
                        "description": "File extension filter for search, e.g. 'ts' or 'rs'"
                    }
                },
                "required": ["action", "path"]
            }),
        },
    };

    const META: ToolMeta = ToolMeta {
        risk: ToolRisk::Medium,
        concurrency: ToolConcurrency::Isolated,
        max_output_chars: 50_000,
        timeout_secs: 30,
    };

    executor.register(definition, META, |args, context| file_tool_handler(args, &context));
}

// ============================================================================
// Workspace Path Validation
// ============================================================================

pub(crate) fn validate_path_in_workspace(path: &str, workspace_root: &Path) -> Result<PathBuf, String> {
    let target = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        workspace_root.join(path)
    };

    let canonical_workspace = workspace_root
        .canonicalize()
        .map_err(|e| format!("Invalid workspace root '{}': {}", workspace_root.display(), e))?;

    let canonical_target = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| format!("Invalid path: '{}'", path))?;
        if !parent.exists() {
            return Err(format!(
                "Parent directory does not exist for path: '{}'",
                path
            ));
        }
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Cannot resolve parent of '{}': {}", path, e))?;
        canonical_parent.join(
            target
                .file_name()
                .ok_or_else(|| format!("Invalid file name in path: '{}'", path))?,
        )
    };

    if !canonical_target.starts_with(&canonical_workspace) {
        return Err(format!(
            "Path '{}' is outside the workspace directory '{}'. Access denied for security.",
            path,
            workspace_root.display()
        ));
    }

    Ok(canonical_target)
}

fn get_workspace(context: &ToolExecutionContext) -> Result<PathBuf, String> {
    match context.workspace_path.as_deref() {
        Some(path) => Ok(PathBuf::from(path)),
        None => Err("No workspace directory configured. Please set a workspace path for this conversation before using file tools.".to_string()),
    }
}

// ============================================================================
// Unified File Tool Handler (action-based routing)
// ============================================================================

fn file_tool_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let action = match args.get("action").and_then(Value::as_str) {
        Some(a) => a.to_lowercase(),
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: action (read|write|list|search)".to_string() },
    };

    match action.as_str() {
        "read" => file_read_handler(args, context),
        "write" => file_write_handler(args, context),
        "list" => file_list_handler(args, context),
        "search" => grep_handler(args, context),
        _ => ToolExecutionResult { success: false, output: format!("Unknown file action: '{}'. Use read, write, list, or search.", action) },
    }
}

fn file_read_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let path = match args.get("path").and_then(Value::as_str) {
        Some(p) => p,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: path".to_string() },
    };
    let offset = args.get("offset").and_then(Value::as_i64).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(2000) as usize;
    let encoding = args.get("encoding").and_then(Value::as_str).unwrap_or("utf-8").to_lowercase();
    let max_chars = 50000usize;

    let full_path = match validate_path_in_workspace(path, &workspace) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };

    let raw_bytes = match std::fs::read(&full_path) {
        Ok(b) => b,
        Err(e) => return ToolExecutionResult { success: false, output: format!("Failed to read file '{}': {}", path, e) },
    };

    let content: String = match encoding.as_str() {
        "utf-8" | "utf8" => match String::from_utf8(raw_bytes) {
            Ok(s) => s,
            Err(e) => {
                let _lossy = String::from_utf8_lossy(e.as_bytes()).to_string();
                return ToolExecutionResult {
                    success: false,
                    output: format!(
                        "File '{}' is not valid UTF-8. Try specifying an encoding like 'gbk', 'gb2312', or 'latin1'. Error: {}",
                        path, e
                    ),
                };
            }
        },
        enc => {
            let decoder = match enc {
                "gbk" => encoding_rs::GBK,
                "gb2312" => encoding_rs::GBK,
                "gb18030" => encoding_rs::GB18030,
                "big5" => encoding_rs::BIG5,
                "shift_jis" | "shift-jis" | "sjis" => encoding_rs::SHIFT_JIS,
                "latin1" | "iso-8859-1" | "iso_8859_1" => encoding_rs::WINDOWS_1252,
                "euc-kr" | "euc_kr" => encoding_rs::EUC_KR,
                other => {
                    return ToolExecutionResult {
                        success: false,
                        output: format!(
                            "Unsupported encoding '{}'. Supported: utf-8, gbk, gb2312, gb18030, big5, shift_jis, latin1, euc-kr",
                            other
                        ),
                    };
                }
            };
            let (cow, _encoding_used, _had_errors) = decoder.decode(&raw_bytes);
            let content: String = cow.into_owned();
            content
        }
    };

    let _file_size = content.len();
    let total_lines = content.lines().count();
    let lines: Vec<&str> = content.lines().collect();
    let selected: Vec<String> = lines
        .into_iter()
        .enumerate()
        .skip(offset)
        .take(limit)
        .map(|(i, line)| format!("{:>6} | {}", i + 1, line))
        .collect();

    if selected.is_empty() {
        return ToolExecutionResult { success: true, output: "(empty file or offset beyond end)".to_string() };
    }

    let mut output = format!(
        "File: {} | Encoding: {} | Total lines: {} | Showing lines {}-{}\n",
        path,
        encoding,
        total_lines,
        offset + 1,
        (offset + selected.len()).min(total_lines)
    );

    let mut char_count = 0usize;
    let mut truncated = false;
    for line in &selected {
        char_count += line.len() + 1;
        if char_count > max_chars {
            truncated = true;
            break;
        }
        output.push_str(line);
        output.push('\n');
    }

    if truncated {
        output.push_str(&format!(
            "\n... [truncated at {} characters, max output is {} chars. Use offset/limit to read more.]",
            max_chars, max_chars
        ));
    }

    ToolExecutionResult { success: true, output }
}

fn file_write_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let path = match args.get("path").and_then(Value::as_str) {
        Some(p) => p,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: path".to_string() },
    };
    let content = match args.get("content").and_then(Value::as_str) {
        Some(c) => c,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: content".to_string() },
    };

    const MAX_CONTENT_SIZE: usize = 100_000;
    if content.len() > MAX_CONTENT_SIZE {
        return ToolExecutionResult {
            success: false,
            output: format!(
                "Content too large ({} bytes). Maximum allowed is {} bytes.",
                content.len(), MAX_CONTENT_SIZE
            ),
        };
    }

    let full_path = match validate_path_in_workspace(path, &workspace) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };

    if let Some(parent) = full_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return ToolExecutionResult { success: false, output: format!("Failed to create parent directory: {}", e) };
        }
    }

    match std::fs::write(&full_path, content) {
        Ok(()) => ToolExecutionResult { success: true, output: format!("Successfully wrote to '{}'", path) },
        Err(e) => ToolExecutionResult { success: false, output: format!("Failed to write file '{}': {}", path, e) },
    }
}

fn file_list_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let rel_path = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let recursive = args.get("recursive").and_then(Value::as_bool).unwrap_or(false);

    let full_path = match validate_path_in_workspace(rel_path, &workspace) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };

    if !full_path.is_dir() {
        return ToolExecutionResult { success: false, output: format!("'{}' is not a directory", rel_path) };
    }

    let mut entries = Vec::new();
    let max_entries = 500usize;
    collect_dir_entries(&full_path, recursive, &mut entries, 0, max_entries);

    if entries.is_empty() {
        return ToolExecutionResult { success: true, output: "(empty directory)".to_string() };
    }

    let display_entries: Vec<String> = entries
        .iter()
        .map(|(depth, name, size, is_dir)| {
            let indent = "  ".repeat(*depth);
            let type_icon = if *is_dir { "DIR " } else { "FILE" };
            let size_str = if *is_dir { String::new() } else { format!(" ({} bytes)", size) };
            format!("{}{} {}{}", indent, type_icon, name, size_str)
        })
        .collect();

    let mut output = format!("Directory listing of '{}':\n{}", rel_path, display_entries.join("\n"));
    if entries.len() >= max_entries {
        output.push_str(&format!("\n... (showing first {} entries)", max_entries));
    }
    ToolExecutionResult { success: true, output }
}

fn collect_dir_entries(
    dir: &Path,
    recursive: bool,
    entries: &mut Vec<(usize, String, u64, bool)>,
    depth: usize,
    max_entries: usize,
) {
    if entries.len() >= max_entries { return; }
    if let Ok(read_dir) = std::fs::read_dir(dir) {
        let mut dir_entries: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
        dir_entries.sort_by_key(|e| e.file_name());
        for entry in dir_entries {
            if entries.len() >= max_entries { return; }
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = entry.metadata().ok();
            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            entries.push((depth, name.clone(), size, is_dir));
            if recursive && is_dir {
                collect_dir_entries(&entry.path(), true, entries, depth + 1, max_entries);
            }
        }
    }
}

fn grep_handler(args: Value, context: &ToolExecutionContext) -> ToolExecutionResult {
    let workspace = match get_workspace(context) {
        Ok(p) => p,
        Err(e) => return ToolExecutionResult { success: false, output: e },
    };
    let pattern = match args.get("pattern").and_then(Value::as_str) {
        Some(p) => p,
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: pattern".to_string() },
    };
    let include_ext = args.get("include").and_then(Value::as_str).map(|s| s.to_string());

    let search_root = match args.get("path").and_then(Value::as_str) {
        Some(p) if !p.is_empty() && p != "." => {
            match validate_path_in_workspace(p, &workspace) {
                Ok(path) => path,
                Err(e) => return ToolExecutionResult { success: false, output: e },
            }
        }
        _ => workspace.clone(),
    };

    if !search_root.exists() {
        return ToolExecutionResult { success: false, output: format!("Search path does not exist: {}", search_root.display()) };
    }
    if !search_root.is_dir() {
        return ToolExecutionResult { success: false, output: format!("Search path is not a directory: {}", search_root.display()) };
    }

    let re = match Regex::new(pattern) {
        Ok(r) => r,
        Err(e) => return ToolExecutionResult { success: false, output: format!("Invalid regex pattern: {}", e) },
    };

    let mut results = Vec::new();
    let max_results = 50;
    grep_dir(&search_root, &re, &include_ext, &mut results, max_results, &workspace);

    if results.is_empty() {
        return ToolExecutionResult { success: true, output: "No matches found.".to_string() };
    }

    let truncated = if results.len() >= max_results {
        format!("{}\n... (showing first {} results)", results.join("\n"), max_results)
    } else {
        format!("Found {} matches:\n{}", results.len(), results.join("\n"))
    };
    ToolExecutionResult { success: true, output: truncated }
}

fn grep_dir(
    dir: &Path,
    re: &Regex,
    include_ext: &Option<String>,
    results: &mut Vec<String>,
    max_results: usize,
    workspace: &Path,
) {
    if results.len() >= max_results { return; }
    if let Ok(read_dir) = std::fs::read_dir(dir) {
        let mut entries: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if results.len() >= max_results { return; }
            let path = entry.path();
            if path.is_dir() {
                if let Ok(canonical) = path.canonicalize() {
                    if canonical.starts_with(workspace) {
                        grep_dir(&path, re, include_ext, results, max_results, workspace);
                    }
                }
            } else {
                let ext_match = match include_ext {
                    Some(ext) => {
                        let filter = ext.trim_start_matches('.').to_lowercase();
                        path.extension()
                            .map(|e| e.to_string_lossy().to_lowercase() == filter)
                            .unwrap_or(false)
                    },
                    None => true,
                };
                if !ext_match { continue; }
                // Read raw bytes and try UTF-8 first, fallback to lossy decode
                if let Ok(raw) = std::fs::read(&path) {
                    let content = String::from_utf8_lossy(&raw);
                    let rel = path.strip_prefix(workspace).unwrap_or(&path).display().to_string();
                    for (i, line) in content.lines().enumerate() {
                        if results.len() >= max_results { return; }
                        if re.is_match(line) {
                            results.push(format!("{}:{}: {}", rel, i + 1, line));
                        }
                    }
                }
            }
        }
    }
}
