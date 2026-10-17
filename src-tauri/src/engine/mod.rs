//! Domain logic, independent of Tauri and the UI.
//!
//! Functions here take and return plain Rust types; the bridge in `lib.rs`
//! is responsible for validating input and translating to IPC.

pub mod bookmarks;
pub mod fs;
pub mod search;
pub mod watcher;
