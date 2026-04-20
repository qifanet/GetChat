// Hide the console window in release builds unless -dev is passed.
// In debug builds (cargo build / tauri dev) the console is always visible.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

/**
 * @file main.rs
 * @description GetChat application entry point.
 *
 * Delegates to lib::run() which sets up Tauri, registers commands,
 * initializes the database, and starts the event loop.
 *
 * In release builds the console window is hidden by default.
 * Pass `-dev` as a CLI argument to force-show the console for debugging.
 */

fn main() {
    // In release mode, re-attach console when -dev flag is present
    #[cfg(all(windows, not(debug_assertions)))]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.iter().any(|a| a == "-dev" || a == "--dev") {
            unsafe {
                let _ = windows::Win32::System::Console::AllocConsole();
            }
        }
    }

    getchat_lib::run()
}
