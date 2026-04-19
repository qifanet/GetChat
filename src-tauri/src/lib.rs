/**
 * @file lib.rs
 * @description Tauri application library entry point.
 *
 * Registers all 27 Tauri commands and initializes application state:
 *   - AppState (SQLite pool + secure key store)
 *   - Database migrations
 *   - Tracing subscriber for structured logging
 *
 * Command modules:
 *   - bootstrap (4): bootstrap_app, save_last_workspace, get/set_default_model
 *   - conversations (7): list, create, load, rename, archive, unarchive, delete
 *   - branches (5): create, rename, archive, unarchive, set_mainline
 *   - messages (6): create_user, assistant_placeholder, variant, complete, fail, build_prompt
 *   - settings (4): list_providers, save_provider, delete_provider, test_connection
 *   - debug (1): check_db_invariants
 */

mod commands;
mod db;
mod dto;
mod error;
mod repositories;
mod services;
mod state;
#[cfg(test)]
mod test_support;

use state::{AppState, SystemKeyStore};
use std::{collections::HashMap, sync::Arc};
use tauri::Manager;

/// Run database migrations and return the SQLite pool.
async fn setup_database(app_handle: &tauri::AppHandle) -> sqlx::SqlitePool {
    // Resolve database path in app data directory
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to resolve app data directory");

    // Ensure the directory exists
    std::fs::create_dir_all(&app_dir).expect("Failed to create app data directory");

    let db_path = app_dir.join("getchat.db");
    db::init_pool(&db_path).await
}

/// Initialize the tracing subscriber for structured logging.
fn setup_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            setup_tracing();
            tracing::info!("GetChat starting...");

            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async {
                let pool = setup_database(&app_handle).await;
                let key_store = Box::new(SystemKeyStore::new());
                app_handle.manage(AppState {
                    db: pool,
                    key_store,
                    active_model_streams: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                });
            });

            tracing::info!("GetChat initialized successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Bootstrap (4)
            commands::bootstrap::bootstrap_app,
            commands::bootstrap::save_last_workspace,
            commands::bootstrap::get_default_model,
            commands::bootstrap::set_default_model,
            // Conversations (7)
            commands::conversations::list_conversation_summaries,
            commands::conversations::create_conversation,
            commands::conversations::load_conversation_snapshot,
            commands::conversations::rename_conversation,
            commands::conversations::archive_conversation,
            commands::conversations::unarchive_conversation,
            commands::conversations::delete_conversation,
            // Branches (5)
            commands::branches::create_branch,
            commands::branches::rename_branch,
            commands::branches::set_branch_preferred_model,
            commands::branches::set_branch_head_message,
            commands::branches::archive_branch,
            commands::branches::unarchive_branch,
            commands::branches::set_mainline_branch,
            // Messages (6)
            commands::messages::create_user_message,
            commands::messages::create_assistant_placeholder_for_branch,
            commands::messages::create_assistant_variant_placeholder,
            commands::messages::complete_assistant_message,
            commands::messages::fail_assistant_message,
            commands::messages::build_prompt_messages,
            commands::messages::delete_message,
            commands::messages::edit_user_message_inline,
            // Streaming runtime (2)
            commands::streaming::start_model_stream,
            commands::streaming::abort_model_stream,
            // Settings (4)
            commands::settings::list_providers,
            commands::settings::save_provider,
            commands::settings::delete_provider,
            commands::settings::test_provider_connection,
            // Debug (1)
            commands::debug::check_db_invariants,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
