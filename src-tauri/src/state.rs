//! Shared application state managed by Tauri.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

use crate::engine::bookmarks::BookmarkStore;
use crate::engine::search::SearchIndex;
use crate::engine::watcher::DirWatcher;

/// Whether the clipboard entry is copied or moved on paste.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardMode {
    /// Paste duplicates the source.
    Copy,
    /// Paste moves the source.
    Cut,
}

/// The single item held by the internal clipboard (v1 has no multi-select).
#[derive(Debug, Clone)]
pub struct ClipboardItem {
    /// Absolute source path.
    pub path: PathBuf,
    /// Copy or cut.
    pub mode: ClipboardMode,
}

/// Everything the bridge needs between commands.
pub struct AppState {
    /// Internal clipboard for copy/cut/paste.
    pub clipboard: Mutex<Option<ClipboardItem>>,
    /// Persistent bookmarks.
    pub bookmarks: Mutex<BookmarkStore>,
    /// Metadata cache used by search.
    pub index: Mutex<SearchIndex>,
    /// Watcher on the currently displayed directory.
    pub watcher: Mutex<Option<DirWatcher>>,
}

impl AppState {
    /// Creates the state from already-opened stores.
    pub fn new(bookmarks: BookmarkStore, index: SearchIndex) -> Self {
        Self {
            clipboard: Mutex::new(None),
            bookmarks: Mutex::new(bookmarks),
            index: Mutex::new(index),
            watcher: Mutex::new(None),
        }
    }
}
