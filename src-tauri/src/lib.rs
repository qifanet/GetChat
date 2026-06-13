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

use services::tool_executor::BuiltinToolExecutor;
use state::{
    AppState, SystemKeyStore, ToolLimits, SecurityPolicy, BUILTIN_DISABLED_TOOLS_KV_KEY,
    SECURITY_POLICY_KV_KEY, TOOL_LIMITS_KV_KEY,
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

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

async fn load_persisted_tool_limits(pool: &sqlx::SqlitePool) -> ToolLimits {
    match crate::repositories::app_kv::get(pool, TOOL_LIMITS_KV_KEY).await {
        Ok(Some(value_json)) => match serde_json::from_str::<ToolLimits>(&value_json) {
            Ok(limits) => limits.normalized(),
            Err(error) => {
                tracing::warn!(
                    key = TOOL_LIMITS_KV_KEY,
                    error = %error,
                    "invalid persisted tool limits, falling back to defaults"
                );
                ToolLimits::default()
            }
        },
        Ok(None) => ToolLimits::default(),
        Err(error) => {
            tracing::warn!(
                key = TOOL_LIMITS_KV_KEY,
                error = %error,
                "failed to load persisted tool limits, falling back to defaults"
            );
            ToolLimits::default()
        }
    }
}

async fn load_persisted_builtin_disabled_tools(pool: &sqlx::SqlitePool) -> HashSet<String> {
    let raw: HashSet<String> = match crate::repositories::app_kv::get(pool, BUILTIN_DISABLED_TOOLS_KV_KEY).await {
        Ok(Some(value_json)) => match serde_json::from_str::<Vec<String>>(&value_json) {
            Ok(names) => names.into_iter().collect(),
            Err(error) => {
                tracing::warn!(
                    key = BUILTIN_DISABLED_TOOLS_KV_KEY,
                    error = %error,
                    "invalid persisted disabled tool list, falling back to defaults"
                );
                HashSet::new()
            }
        },
        Ok(None) => HashSet::new(),
        Err(error) => {
            tracing::warn!(
                key = BUILTIN_DISABLED_TOOLS_KV_KEY,
                error = %error,
                "failed to load disabled tool list, falling back to defaults"
            );
            HashSet::new()
        }
    };

    // Migrate legacy tool names to unified tool names
    let migrated: HashSet<String> = raw.into_iter().map(|name| {
        match name.as_str() {
            "file_read" | "file_write" | "file_list" | "grep" => "file".to_string(),
            "todo_read" | "todo_write" => "todo".to_string(),
            _ => name,
        }
    }).collect();

    migrated
}

async fn load_persisted_security_policy(pool: &sqlx::SqlitePool) -> SecurityPolicy {
    match crate::repositories::app_kv::get(pool, SECURITY_POLICY_KV_KEY).await {
        Ok(Some(value_json)) => match serde_json::from_str::<SecurityPolicy>(&value_json) {
            Ok(policy) => policy,
            Err(error) => {
                tracing::warn!(
                    key = SECURITY_POLICY_KV_KEY,
                    error = %error,
                    "invalid persisted security policy, falling back to defaults"
                );
                SecurityPolicy::default()
            }
        },
        Ok(None) => SecurityPolicy::default(),
        Err(error) => {
            tracing::warn!(
                key = SECURITY_POLICY_KV_KEY,
                error = %error,
                "failed to load persisted security policy, falling back to defaults"
            );
            SecurityPolicy::default()
        }
    }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            setup_tracing();
            tracing::info!("GetChat starting...");

            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async {
                let pool = setup_database(&app_handle).await;
                let key_store = Box::new(SystemKeyStore::new());
                let tool_limits = load_persisted_tool_limits(&pool).await;
                let disabled_builtin_tools = load_persisted_builtin_disabled_tools(&pool).await;
                let security_policy = load_persisted_security_policy(&pool).await;
                let tool_executor = Box::new(BuiltinToolExecutor::new_with_disabled(
                    disabled_builtin_tools,
                ));
                let mcp_manager = Arc::new(tokio::sync::Mutex::new(
                    crate::services::mcp_client::McpManager::new(),
                ));

                app_handle.manage(AppState {
                    db: pool.clone(),
                    key_store,
                    active_model_streams: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                    pending_model_stream: Arc::new(tokio::sync::Mutex::new(None)),
                    tool_executor,
                    tool_limits: Arc::new(tokio::sync::Mutex::new(tool_limits)),
                    security_policy: Arc::new(tokio::sync::Mutex::new(security_policy)),
                    pending_approvals: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                    mcp_manager: mcp_manager.clone(),
                    app_handle: app_handle.clone(),
                });

                // Load MCP servers in background — do not block app startup.
                let mcp_pool = pool.clone();
                let mcp_app_handle = app_handle.clone();
                tokio::spawn(async move {
                    let key_store = crate::state::SystemKeyStore::new();
                    crate::commands::streaming::reload_mcp_servers_from_file(
                        &mcp_app_handle,
                        &mcp_pool,
                        &key_store,
                        &mcp_manager,
                    )
                    .await;
                });

                // Start TaskWorker in background
                let worker_pool = pool.clone();
                tokio::spawn(async move {
                    let worker = Arc::new(crate::services::task_worker::TaskWorker::new(worker_pool));
                    worker.start().await;
                });
            });

            tracing::info!("GetChat initialized successfully");

            // Create system tray icon
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let check_update_item = MenuItem::with_id(app, "check_update", "Check for Updates", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &sep, &check_update_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("GetChat")
                .menu(&tray_menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "check_update" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let updater = match handle.updater_builder().build() {
                                Ok(u) => u,
                                Err(e) => {
                                    tracing::warn!(error = %e, "Failed to build updater");
                                    return;
                                }
                            };
                            match updater.check().await {
                                Ok(Some(update)) => {
                                    let version = &update.version;
                                    tracing::info!(version = %version, "Update available");
                                    let _ = handle.emit("update-available", serde_json::json!({
                                        "version": version,
                                        "body": update.body,
                                    }));
                                }
                                Ok(None) => {
                                    tracing::info!("App is up to date");
                                    let _ = handle.emit("update-not-available", ());
                                }
                                Err(e) => {
                                    tracing::warn!(error = %e, "Update check failed");
                                }
                            }
                        });
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    let show_hide = |app: &tauri::AppHandle| {
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    };
                    match event {
                        TrayIconEvent::DoubleClick { .. } => {
                            show_hide(tray.app_handle());
                        }
                        TrayIconEvent::Click { button, button_state, .. } => {
                            // On Windows, left click also toggles visibility
                            if button == MouseButton::Left && button_state == MouseButtonState::Up {
                                show_hide(tray.app_handle());
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Bootstrap (4+2)
            commands::bootstrap::bootstrap_app,
            commands::bootstrap::save_last_workspace,
            commands::bootstrap::get_default_model,
            commands::bootstrap::set_default_model,
            commands::bootstrap::get_helper_model,
            commands::bootstrap::set_helper_model,
            // Conversations (7+1)
            commands::conversations::list_conversation_summaries,
            commands::conversations::create_conversation,
            commands::conversations::load_conversation_snapshot,
            commands::conversations::rename_conversation,
            commands::conversations::archive_conversation,
            commands::conversations::unarchive_conversation,
            commands::conversations::delete_conversation,
            commands::conversations::generate_conversation_title,
            commands::conversations::generate_branch_diff_summary,
            commands::conversations::set_conversation_workspace,
            commands::conversations::read_todo_items,
            commands::conversations::import_conversations,
            // Branches (5+2)
            commands::branches::create_branch,
            commands::branches::rename_branch,
            commands::branches::set_branch_preferred_model,
            commands::branches::archive_branch,
            commands::branches::unarchive_branch,
            commands::branches::delete_branch,
            commands::branches::set_mainline_branch,
            // Messages (6+2)
            commands::messages::create_user_message,
            commands::messages::direct_overwrite_user_message,
            commands::messages::create_assistant_placeholder_for_branch,
            commands::messages::create_assistant_variant_placeholder,
            commands::messages::complete_assistant_message,
            commands::messages::fail_assistant_message,
            commands::messages::build_prompt_messages,
            commands::messages::delete_assistant_variant_message,
            commands::messages::search_messages,
            // Streaming runtime (3+1+2)
            commands::streaming::get_enabled_tool_definitions,
            commands::streaming::get_builtin_tool_states,
            commands::streaming::set_builtin_tool_enabled,
            commands::streaming::start_model_stream,
            commands::streaming::abort_model_stream,
            commands::streaming::approve_tool_action,
            commands::streaming::get_tool_settings,
            commands::streaming::update_tool_settings,
            commands::streaming::get_security_policy,
            commands::streaming::update_security_policy,
            commands::streaming::inject_user_message_to_stream,
            // MCP Server management (4 + 2 file-based)
            commands::streaming::list_mcp_servers,
            commands::streaming::add_mcp_server,
            commands::streaming::remove_mcp_server,
            commands::streaming::get_mcp_tool_definitions,
            commands::streaming::set_mcp_server_enabled,
            commands::streaming::get_mcp_config_json,
            commands::streaming::save_mcp_config_json,
            commands::streaming::get_context_status,
            commands::streaming::compress_context,
            // Skills & Slash Commands (3)
            commands::streaming::list_slash_items,
            commands::streaming::execute_mcp_prompt,
            commands::streaming::get_skills_directory,
            // Settings (4)
            commands::settings::list_providers,
            commands::settings::get_system_prompt,
            commands::settings::set_system_prompt,
            commands::settings::save_provider,
            commands::settings::delete_provider,
            commands::settings::test_provider_connection,
            commands::settings::fetch_ollama_models,
            commands::settings::get_close_behavior,
            commands::settings::set_close_behavior,
            commands::settings::get_shell_path,
            commands::settings::set_shell_path,
            commands::settings::detect_shell_path,
            // Debug (1)
            commands::debug::check_db_invariants,
            // Filesystem (2)
            commands::filesystem::list_directory_entries,
            commands::filesystem::read_file_preview,
            commands::filesystem::reveal_in_file_manager,
            // Task Queue (3)
            commands::task_queue::list_task_queue,
            commands::task_queue::cancel_task,
            // Proposals (3)
            commands::proposal::get_proposal,
            commands::proposal::list_proposals,
            commands::proposal::execute_parallel_fork,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Check user preference: "exit" (default) or "tray"
                let should_hide = {
                    let state = window.try_state::<AppState>();
                    match state {
                        Some(s) => {
                            let pool = &s.db;
                            // Use block_on in this sync context
                            tauri::async_runtime::block_on(async {
                                match crate::repositories::app_kv::get(pool, "close_behavior").await {
                                    Ok(Some(raw)) => {
                                        let decoded = serde_json::from_str::<String>(&raw)
                                            .unwrap_or_else(|_| raw.trim_matches('"').to_string());
                                        matches!(decoded.as_str(), "tray" | "minimize")
                                    }
                                    _ => false,
                                }
                            })
                        }
                        None => false,
                    }
                };

                if should_hide {
                    let _ = window.hide();
                    api.prevent_close();
                }
                // else: default behavior — close the window and exit
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
