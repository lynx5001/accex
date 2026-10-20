//! Application entry point. All setup lives in the library crate so it can
//! be shared with tests and mobile targets.

// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    accex_lib::run()
}
