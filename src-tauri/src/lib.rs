//! The bridge: Tauri commands that validate input coming from the webview
//! and translate it into engine calls.
//!
//! Every path received from the frontend passes through
//! [`engine::fs::resolve_path`] before it touches the file system. The
//! command palette maps to fixed Rust functions; no shell is ever invoked.

pub mod engine;
pub mod error;
pub mod state;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use engine::bookmarks::{Bookmark, BookmarkStore};
use engine::fs::{self as efs, EntryKind, FileEntry, PathSegment};
use engine::search::{self, SearchIndex, SearchOptions, SearchResults};
use engine::watcher::DirWatcher;
use error::{AppError, AppResult};
use state::{AppState, ClipboardItem, ClipboardMode};

/// Name of the event carrying [`engine::watcher::FsChange`] payloads.
pub const FS_CHANGE_EVENT: &str = "fs-change";

/// Everything the UI needs to render one folder.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    /// Canonical folder path.
    pub path: PathBuf,
    /// Folder name for announcements.
    pub name: String,
    /// Parent folder, `None` at the root.
    pub parent: Option<PathBuf>,
    /// Breadcrumb segments, root first.
    pub breadcrumbs: Vec<PathSegment>,
    /// Folder contents, folders first.
    pub entries: Vec<FileEntry>,
}

/// Result of resolving a typed location.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLocation {
    /// Canonical path.
    pub path: PathBuf,
    /// Whether it is a folder (navigate) or a file (open / focus).
    pub is_directory: bool,
}

/// Operations offered by the command palette.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Operation {
    /// Open a file with its default application.
    Open,
    /// Put the target on the clipboard for copying.
    Copy,
    /// Put the target on the clipboard for moving.
    Cut,
    /// Paste the clipboard into the target folder.
    Paste,
    /// Move the target to the trash.
    Delete,
    /// Rename the target.
    #[serde(rename_all = "camelCase")]
    Rename {
        /// New file name (not a path).
        new_name: String,
    },
    /// Bookmark the target folder.
    Bookmark,
}

/// What an operation did, so the UI can announce it and refocus.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OperationOutcome {
    /// A file was handed to its default application.
    Opened {
        /// Opened file name.
        name: String,
    },
    /// The target is a folder; the UI should navigate into it.
    Navigate {
        /// Folder to open.
        path: PathBuf,
    },
    /// The clipboard now holds the target.
    Clipboard {
        /// Copy or cut.
        mode: ClipboardMode,
        /// Name of the clipboard item.
        name: String,
    },
    /// The clipboard item was pasted.
    Pasted {
        /// Copy or cut.
        mode: ClipboardMode,
        /// Created path.
        path: PathBuf,
        /// Created name.
        name: String,
    },
    /// The target was moved to the trash.
    Deleted {
        /// Deleted name.
        name: String,
    },
    /// The target was renamed.
    Renamed {
        /// New path.
        path: PathBuf,
        /// New name.
        name: String,
    },
    /// A bookmark was created (or already existed).
    Bookmarked {
        /// Bookmark name.
        name: String,
        /// `false` if it already existed.
        added: bool,
    },
}

/// Locks a mutex, recovering the data if a previous holder panicked.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Hides file names from production logs (PII); full paths in debug builds.
fn redact(path: &Path) -> String {
    if cfg!(debug_assertions) {
        path.display().to_string()
    } else {
        "[redacted]".to_owned()
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// The folder the app opens on start (the user's home).
#[tauri::command]
fn initial_location() -> PathBuf {
    efs::home_dir()
}

/// Lists a folder, caches it for search and watches it for changes.
#[tauri::command]
fn read_directory(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    show_hidden: bool,
) -> AppResult<DirectoryListing> {
    let dir = efs::resolve_directory(&path)?;
    let entries = efs::list_directory(&dir, show_hidden).inspect_err(|e| {
        tracing::info!(kind = e.kind(), dir = %redact(&dir), "read_directory failed");
    })?;

    if let Err(err) = lock(&state.index).record_directory(&dir, &entries) {
        tracing::warn!(%err, "could not update search index");
    }
    watch(&app, &state, &dir);

    Ok(DirectoryListing {
        name: display_name(&dir),
        parent: dir.parent().map(Path::to_path_buf),
        breadcrumbs: efs::breadcrumbs(&dir),
        entries,
        path: dir,
    })
}

fn watch(app: &AppHandle, state: &AppState, dir: &Path) {
    let mut current = lock(&state.watcher);
    if current.as_ref().is_some_and(|w| w.directory() == dir) {
        return;
    }
    *current = None;
    let handle = app.clone();
    match DirWatcher::watch(dir, move |change| {
        if let Err(err) = handle.emit(FS_CHANGE_EVENT, change) {
            tracing::warn!(%err, "failed to emit fs-change");
        }
    }) {
        Ok(w) => *current = Some(w),
        Err(err) => tracing::warn!(%err, "could not watch directory"),
    }
}

/// Nearest existing folder for a path that disappeared (disk unplugged).
#[tauri::command]
fn fallback_directory(path: String) -> PathBuf {
    efs::nearest_existing_directory(Path::new(&path))
}

/// Canonicalizes a typed location and checks that it exists.
#[tauri::command]
fn resolve_location(input: String) -> AppResult<ResolvedLocation> {
    let path = efs::resolve_path(&input)?;
    Ok(ResolvedLocation {
        is_directory: path.is_dir(),
        path,
    })
}

/// Searches below `scope` (current folder + 2 levels, plus cached deeper
/// folders). Runs off the main thread.
#[tauri::command]
async fn search_files(
    app: AppHandle,
    scope: String,
    query: String,
    limit: usize,
    show_hidden: bool,
) -> AppResult<SearchResults> {
    let scope = efs::resolve_directory(&scope)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let index = lock(&state.index);
        let options = SearchOptions {
            limit: limit.clamp(1, 10_000),
            show_hidden,
            ..SearchOptions::default()
        };
        search::search(&scope, &query, options, Some(&index))
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

/// Executes a command-palette operation on `path`.
#[tauri::command]
fn execute_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    operation: Operation,
    path: String,
) -> AppResult<OperationOutcome> {
    let target = efs::resolve_path(&path)?;
    let name = display_name(&target);
    tracing::info!(op = ?operation, target = %redact(&target), "execute_operation");

    match operation {
        Operation::Open => {
            let kind = efs::entry_for(&target)?.kind;
            if kind == EntryKind::Directory {
                return Ok(OperationOutcome::Navigate { path: target });
            }
            app.opener()
                .open_path(target.to_string_lossy(), None::<&str>)
                .map_err(|e| AppError::Io(e.to_string()))?;
            Ok(OperationOutcome::Opened { name })
        }
        Operation::Copy | Operation::Cut => {
            let mode = if matches!(operation, Operation::Copy) {
                ClipboardMode::Copy
            } else {
                ClipboardMode::Cut
            };
            *lock(&state.clipboard) = Some(ClipboardItem { path: target, mode });
            Ok(OperationOutcome::Clipboard { mode, name })
        }
        Operation::Paste => {
            let dest = if target.is_dir() {
                target
            } else {
                target
                    .parent()
                    .map(Path::to_path_buf)
                    .ok_or(AppError::NotADirectory(target))?
            };
            let mut clipboard = lock(&state.clipboard);
            let item = clipboard.clone().ok_or(AppError::ClipboardEmpty)?;
            let created = match item.mode {
                ClipboardMode::Copy => efs::copy_into(&item.path, &dest)?,
                ClipboardMode::Cut => {
                    let moved = efs::move_into(&item.path, &dest)?;
                    let _ = lock(&state.index).forget(&item.path);
                    *clipboard = None;
                    moved
                }
            };
            Ok(OperationOutcome::Pasted {
                mode: item.mode,
                name: display_name(&created),
                path: created,
            })
        }
        Operation::Delete => {
            efs::delete(&target)?;
            let _ = lock(&state.index).forget(&target);
            Ok(OperationOutcome::Deleted { name })
        }
        Operation::Rename { new_name } => {
            let renamed = efs::rename(&target, &new_name)?;
            let _ = lock(&state.index).forget(&target);
            Ok(OperationOutcome::Renamed {
                name: display_name(&renamed),
                path: renamed,
            })
        }
        Operation::Bookmark => {
            if !target.is_dir() {
                return Err(AppError::NotADirectory(target));
            }
            let added = lock(&state.bookmarks).add(&target)?;
            Ok(OperationOutcome::Bookmarked { name, added })
        }
    }
}

/// All saved bookmarks.
#[tauri::command]
fn list_bookmarks(state: State<'_, AppState>) -> Vec<Bookmark> {
    lock(&state.bookmarks).list().to_vec()
}

/// Removes a bookmark by path.
#[tauri::command]
fn remove_bookmark(state: State<'_, AppState>, path: String) -> AppResult<bool> {
    lock(&state.bookmarks).remove(Path::new(&path))
}

fn init_logging(app: &AppHandle) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(if cfg!(debug_assertions) {
            "debug"
        } else {
            "info"
        })
    });
    let (file_layer, guard) = match app.path().app_log_dir() {
        Ok(dir) => {
            let appender = tracing_appender::rolling::daily(dir, "accessible-explorer.log");
            let (writer, guard) = tracing_appender::non_blocking(appender);
            (
                Some(fmt::layer().with_ansi(false).with_writer(writer)),
                Some(guard),
            )
        }
        Err(_) => (None, None),
    };
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(file_layer)
        .try_init();
    guard
}

fn open_state(app: &AppHandle) -> AppState {
    let paths = app.path();
    let bookmarks = match paths.app_config_dir() {
        Ok(dir) => BookmarkStore::load(&dir.join("config.json")),
        Err(_) => BookmarkStore::load(&std::env::temp_dir().join("accessible-explorer.json")),
    };
    let index = paths
        .app_cache_dir()
        .map_err(|e| AppError::Io(e.to_string()))
        .and_then(|dir| SearchIndex::open(&dir.join("index.sqlite")))
        .or_else(|err| {
            tracing::warn!(%err, "falling back to in-memory search index");
            SearchIndex::in_memory()
        })
        .expect("in-memory SQLite is always available");
    AppState::new(bookmarks, index)
}

/// Builds and runs the application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(guard) = init_logging(&handle) {
                app.manage(guard);
            }
            app.manage(open_state(&handle));
            tracing::info!("application started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_location,
            read_directory,
            fallback_directory,
            resolve_location,
            search_files,
            execute_operation,
            list_bookmarks,
            remove_bookmark,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
