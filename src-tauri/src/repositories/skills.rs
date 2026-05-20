/**
 * @file repositories/skills.rs
 * @description Skill definition persistence (Rules + Skill Prompts).
 *
 * Skills are parameterized prompt templates with optional tool bindings
 * and trigger conditions. They are injected into the system prompt at
 * conversation start.
 */

use sqlx::{Executor, Sqlite};

// ============================================================================
// Row type
// ============================================================================

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SkillRow {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub trigger_type: String,
    pub prompt_template: String,
    pub variables_json: String,
    pub bound_tools: String,
    pub scope: String,
    pub source_type: String,
    pub enabled: bool,
    pub local_path: String,
}

// ============================================================================
// Queries
// ============================================================================

pub async fn list_all<'e, E>(executor: E) -> sqlx::Result<Vec<SkillRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, SkillRow>(
        "SELECT id, name, display_name, description, trigger_type, \
         prompt_template, variables_json, bound_tools, scope, source_type, enabled, local_path \
         FROM skill_definitions ORDER BY created_at",
    )
    .fetch_all(executor)
    .await
}

pub async fn list_enabled_always<'e, E>(executor: E) -> sqlx::Result<Vec<SkillRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, SkillRow>(
        "SELECT id, name, display_name, description, trigger_type, \
         prompt_template, variables_json, bound_tools, scope, source_type, enabled, local_path \
         FROM skill_definitions WHERE enabled = 1 AND trigger_type = 'ALWAYS'",
    )
    .fetch_all(executor)
    .await
}

pub async fn list_enabled_slash<'e, E>(executor: E) -> sqlx::Result<Vec<SkillRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, SkillRow>(
        "SELECT id, name, display_name, description, trigger_type, \
         prompt_template, variables_json, bound_tools, scope, source_type, enabled, local_path \
         FROM skill_definitions WHERE enabled = 1 AND trigger_type IN ('SLASH', 'MANUAL')",
    )
    .fetch_all(executor)
    .await
}

pub async fn get_by_name<'e, E>(executor: E, name: &str) -> sqlx::Result<Option<SkillRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as::<_, SkillRow>(
        "SELECT id, name, display_name, description, trigger_type, \
         prompt_template, variables_json, bound_tools, scope, source_type, enabled, local_path \
         FROM skill_definitions WHERE name = ?",
    )
    .bind(name)
    .fetch_optional(executor)
    .await
}

pub async fn upsert<'e, E>(
    executor: E,
    name: &str,
    display_name: &str,
    description: &str,
    trigger_type: &str,
    prompt_template: &str,
    variables_json: &str,
    bound_tools: &str,
    scope: &str,
    source_type: &str,
    enabled: bool,
    local_path: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    let id = format!("skill_{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO skill_definitions \
         (id, name, display_name, description, trigger_type, prompt_template, \
          variables_json, bound_tools, scope, source_type, enabled, local_path, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch()) \
         ON CONFLICT(name) DO UPDATE SET \
            display_name = excluded.display_name, \
            description = excluded.description, \
            trigger_type = excluded.trigger_type, \
            prompt_template = excluded.prompt_template, \
            variables_json = excluded.variables_json, \
            bound_tools = excluded.bound_tools, \
            scope = excluded.scope, \
            source_type = excluded.source_type, \
            enabled = excluded.enabled, \
            local_path = excluded.local_path, \
            updated_at = unixepoch()",
    )
    .bind(&id)
    .bind(name)
    .bind(display_name)
    .bind(description)
    .bind(trigger_type)
    .bind(prompt_template)
    .bind(variables_json)
    .bind(bound_tools)
    .bind(scope)
    .bind(source_type)
    .bind(enabled)
    .bind(local_path)
    .execute(executor)
    .await?;

    Ok(())
}

pub async fn delete<'e, E>(executor: E, id: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM skill_definitions WHERE id = ?")
        .bind(id)
        .execute(executor)
        .await?;

    Ok(())
}

pub async fn set_enabled<'e, E>(executor: E, id: &str, enabled: bool) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let result = sqlx::query(
        "UPDATE skill_definitions SET enabled = ?, updated_at = unixepoch() WHERE id = ?",
    )
    .bind(enabled)
    .bind(id)
    .execute(executor)
    .await?;

    Ok(result.rows_affected() > 0)
}
