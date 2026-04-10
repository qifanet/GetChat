/**
 * @file main.rs
 * @description GetChat application entry point.
 *
 * Delegates to lib::run() which sets up Tauri, registers commands,
 * initializes the database, and starts the event loop.
 */

fn main() {
    getchat_lib::run()
}
