/**
 * @file services/skill_fs.rs
 * @description Filesystem-based skill discovery and loading.
 *
 * Skills are hot-pluggable directories under `{app_data}/skills/`, each
 * containing a `SKILL.md` with YAML frontmatter + Markdown body.
 *
 * Architecture follows Progressive Disclosure (inspired by Claude Code):
 *   Tier 1: name + description always injected into system prompt for discovery
 *   Tier 2: full SKILL.md content loaded on-demand via `load_skill` built-in tool
 *   Tier 3: user slash commands trigger implicit system hint
 *
 * No database involved — skills are discovered by scanning the filesystem
 * on each call, so adding/removing directories takes effect immediately.
 */

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

// ============================================================================
// Skill Info (in-memory, no DB)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub display_name: String,
    pub description: String,
    /// Full SKILL.md body (Markdown content after frontmatter).
    pub content: String,
    /// Absolute path to the skill directory on disk.
    pub directory: PathBuf,
}

// ============================================================================
// Discovery — scan {app_data}/skills/ for SKILL.md
// ============================================================================

/// Return the skills root directory: `{app_data}/skills/`.
/// In Tauri v2 there is no `tauri::api::path`, so the caller must provide
/// the app data path via `tauri::Manager::path()`.
pub fn skills_root_from_app_data(app_data: &std::path::Path) -> PathBuf {
    app_data.join("skills")
}

/// Scan `skills_dir` for subdirectories containing `SKILL.md` and return
/// parsed skill metadata for each one. Invalid/unreadable entries are
/// skipped with a warning log.
pub fn discover_skills(skills_dir: &std::path::Path) -> Vec<SkillInfo> {
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return Vec::new();
    };

    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        match parse_skill_md(&skill_md, &path) {
            Ok(info) => skills.push(info),
            Err(e) => {
                tracing::warn!(
                    path = %skill_md.display(),
                    error = %e,
                    "Failed to parse skill, skipping"
                );
            }
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// Find a single skill by name.
pub fn find_skill_by_name(
    skills_dir: &std::path::Path,
    name: &str,
) -> Result<SkillInfo, AppError> {
    let skills = discover_skills(skills_dir);
    skills
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| {
            AppError::not_found(&format!("Skill '{name}' not found on disk"))
        })
}

// ============================================================================
// Tier 1: Metadata prompt for system prompt injection
// ============================================================================

/// Build the `[Available Skills]` block for system prompt injection.
/// Only includes name + description (Tier 1 — always in context).
pub fn build_skill_metadata_prompt(skills: &[SkillInfo]) -> String {
    if skills.is_empty() {
        return String::new();
    }

    let mut lines = vec!["[Available Skills]".to_string()];
    lines.push(
        "The following skills are available. Call the load_skill tool when the task matches one of them."
            .to_string(),
    );
    for skill in skills {
        let desc = if skill.description.is_empty() {
            "(no description)"
        } else {
            &skill.description
        };
        lines.push(format!("- {}: {}", skill.name, desc));
    }

    lines.join("\n")
}

// ============================================================================
// Tier 3: Skill activation hint for slash commands
// ============================================================================

/// Build the `[Skill Activation]` hint injected when user uses a slash command.
pub fn build_skill_activation_hint(skill_name: &str) -> String {
    format!(
        "[Skill Activation]\n\
         The user has activated skill '{}'. Call the load_skill tool immediately \
         to load and follow this skill's instructions.",
        skill_name
    )
}

// ============================================================================
// SKILL.md Parsing
// ============================================================================

/// Parse a SKILL.md file into a SkillInfo struct.
fn parse_skill_md(
    skill_md_path: &std::path::Path,
    skill_dir: &std::path::Path,
) -> Result<SkillInfo, AppError> {
    let content = std::fs::read_to_string(skill_md_path).map_err(|e| {
        AppError::db_error(&format!("Failed to read {}: {e}", skill_md_path.display()))
    })?;

    let (frontmatter, body) = parse_frontmatter(&content)?;

    let directory_name = skill_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed-skill");

    let raw_name = frontmatter
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(directory_name)
        .trim();
    let name = normalize_skill_name(raw_name)?;

    let display_name = frontmatter
        .get("displayName")
        .or_else(|| frontmatter.get("display_name"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(&name)
        .to_string();

    let description = frontmatter
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| first_markdown_paragraph(body));

    Ok(SkillInfo {
        name,
        display_name,
        description,
        content: body.trim().to_string(),
        directory: skill_dir.to_path_buf(),
    })
}

/// Split SKILL.md into (frontmatter_yaml, markdown_body).
fn parse_frontmatter(content: &str) -> Result<(serde_json::Map<String, serde_json::Value>, &str), AppError> {
    let trimmed = content.strip_prefix("---").ok_or_else(|| {
        AppError::invalid_argument("SKILL.md must start with YAML frontmatter (---)")
    })?;
    let trimmed = trimmed
        .strip_prefix("\r\n")
        .or_else(|| trimmed.strip_prefix('\n'))
        .unwrap_or(trimmed);
    let end_index = trimmed.find("\n---").ok_or_else(|| {
        AppError::invalid_argument("SKILL.md frontmatter must be closed with ---")
    })?;
    let frontmatter_str = &trimmed[..end_index];
    let body = &trimmed[end_index + "\n---".len()..];
    let body = body
        .strip_prefix("\r\n")
        .or_else(|| body.strip_prefix('\n'))
        .unwrap_or(body);

    let yaml_value: serde_yaml::Value =
        serde_yaml::from_str(frontmatter_str).map_err(|e| {
            AppError::invalid_argument(&format!("Invalid YAML in SKILL.md: {e}"))
        })?;
    let json_value = serde_json::to_value(yaml_value).map_err(|e| {
        AppError::invalid_argument(&format!("Invalid SKILL.md frontmatter: {e}"))
    })?;
    let map = json_value.as_object().cloned().ok_or_else(|| {
        AppError::invalid_argument("SKILL.md frontmatter must be a YAML object")
    })?;

    Ok((map, body))
}

fn normalize_skill_name(raw: &str) -> Result<String, AppError> {
    let normalized = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' {
                ch
            } else if ch == '_' || ch.is_whitespace() {
                '-'
            } else {
                '\0'
            }
        })
        .filter(|ch| *ch != '\0')
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if normalized.is_empty() || normalized.len() > 64 {
        return Err(AppError::invalid_argument(
            "Skill name must be 1-64 lowercase letters, numbers, or hyphens",
        ));
    }
    Ok(normalized)
}

fn first_markdown_paragraph(body: &str) -> String {
    body.split("\n\n")
        .map(str::trim)
        .find(|p| !p.is_empty() && !p.starts_with('#'))
        .unwrap_or("")
        .chars()
        .take(512)
        .collect()
}
