/**
 * @file db/mod.rs
 * @description Database initialization and connection pool management.
 *
 * Responsibilities:
 *   - Create SqlitePool with proper PRAGMA settings
 *   - Run migrations on startup
 *   - Ensure foreign key enforcement, WAL mode, and busy timeout
 *
 * PRAGMA rationale:
 *   - foreign_keys = ON: Required for CASCADE deletes (delete_conversation)
 *     and FK constraint enforcement. Without this, SQLite silently ignores
 *     all foreign key constraints and CASCADE operations.
 *   - journal_mode = WAL: Enables concurrent readers during writes. Critical
 *     for desktop UX — snapshot loading must not block during streaming.
 *   - busy_timeout = 5000: When two writes overlap (e.g., inflight repair
 *     during user action), wait up to 5s instead of immediately failing
 *     with SQLITE_BUSY error.
 *
 * Each PRAGMA is set per-connection via sqlx's after_connect hook.
 * Migrations are run once after pool creation.
 */

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;
use std::path::Path;

// ============================================================================
// Connection Configuration
// ============================================================================

/** Busy timeout in milliseconds — how long to wait if another write is in progress. */
const BUSY_TIMEOUT_MS: u32 = 5000;

/**
 * Build SqliteConnectOptions with all required PRAGMAs.
 *
 * Note: foreign_keys must be enabled via SqliteConnectOptions::foreign_keys(true)
 * rather than a raw PRAGMA statement, because sqlx executes it at the right
 * point in the connection lifecycle.
 */
fn connect_options(db_path: &str) -> SqliteConnectOptions {
    SqliteConnectOptions::from_str(db_path)
        .expect("Invalid SQLite connection string")
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS as u64))
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the database connection pool with all required settings.
 *
 * This function:
 *   1. Creates a connection pool (single-writer, multi-reader for SQLite)
 *   2. Runs all pending migrations
 *   3. Returns the pool ready for use
 *
 * Must be called once during app startup, before any command handlers run.
 *
 * # Panics
 * Panics if the database file cannot be opened or migrations fail.
 */
pub async fn init_pool(db_path: &Path) -> SqlitePool {
    let conn_str = format!("sqlite://{}?mode=rwc", db_path.display());
    let options = connect_options(&conn_str);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .unwrap_or_else(|e| panic!("Failed to open database at {:?}: {}", db_path, e));

    // Run migrations
    run_migrations(&pool).await;

    tracing::info!(
        "Database initialized at {:?} (WAL mode, foreign_keys=ON, busy_timeout={}ms)",
        db_path,
        BUSY_TIMEOUT_MS
    );

    pool
}

/**
 * Run all pending migrations.
 *
 * SQL files are split by semicolons for individual execution (SQLite's execute
 * does not support multiple statements). Before splitting, standalone comment
 * lines (-- ...) are stripped to prevent comment blocks from being merged with
 * SQL statements after the split.
 *
 * Migrations are idempotent (IF NOT EXISTS) but should only run once per DB.
 */
async fn run_migrations(pool: &SqlitePool) {
    // 0001: Initial schema
    let init_sql = include_str!("migrations/0001_init.sql");
    execute_migration_sql(pool, init_sql, "Migration 0001").await;

    // 0002: Sibling unique constraint
    let sql_0002 = include_str!("migrations/0002_sibling_unique.sql");
    execute_migration_sql(pool, sql_0002, "Migration 0002").await;

    // 0003: Provider model normalization + branch model preference
    let sql_0003 = include_str!("migrations/0003_provider_models_and_branch_preferences.sql");
    execute_migration_sql(pool, sql_0003, "Migration 0003").await;
}

/**
 * Execute a SQL migration by stripping comment lines and splitting by semicolons.
 *
 * The split-by-semicolon approach requires that comment-only lines be removed
 * first. Otherwise, comment blocks preceding each CREATE TABLE would cause the
 * entire segment (comment + SQL) to start with "--" and get filtered out.
 */
async fn execute_migration_sql(pool: &SqlitePool, sql: &str, label: &str) {
    // Remove standalone comment lines (-- ...) before splitting.
    // Inline comments (e.g., "col TEXT -- note") are preserved because the
    // line does not start with "--" after trimming.
    let clean_sql: String = sql
        .lines()
        .filter(|line| !line.trim().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");

    for stmt in clean_sql.split(';') {
        let trimmed = stmt.trim();
        if !trimmed.is_empty() {
            if let Err(error) = sqlx::query(trimmed).execute(pool).await {
                let error_message = error.to_string();
                let is_duplicate_column = error_message.contains("duplicate column name");
                if !is_duplicate_column {
                    panic!("{} failed for: {}\nError: {}", label, trimmed, error);
                }
            }
        }
    }
}
