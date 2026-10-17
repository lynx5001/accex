//! Watches the currently viewed directory with the `notify` crate.
//!
//! The engine stays UI-agnostic: changes are delivered to a plain callback,
//! and the bridge decides how to forward them (Tauri events).

use std::path::{Path, PathBuf};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Simplified kind of a file system change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    /// An entry appeared.
    Created,
    /// An entry disappeared.
    Removed,
    /// An entry was renamed or moved.
    Renamed,
    /// Content or metadata changed.
    Modified,
    /// The watcher lost track; the listing must be re-read.
    Rescan,
}

/// A change inside the watched directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    /// The watched directory.
    pub directory: PathBuf,
    /// What happened.
    pub kind: ChangeKind,
    /// Affected paths (may be empty for `Rescan`).
    pub paths: Vec<PathBuf>,
}

/// Keeps a non-recursive watch on one directory alive until dropped.
pub struct DirWatcher {
    directory: PathBuf,
    _inner: RecommendedWatcher,
}

impl DirWatcher {
    /// Starts watching `directory`, calling `on_change` for every relevant
    /// event (from a background thread).
    pub fn watch<F>(directory: &Path, on_change: F) -> AppResult<Self>
    where
        F: Fn(FsChange) + Send + 'static,
    {
        let dir = directory.to_path_buf();
        let mut inner = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let change = match res {
                Ok(event) => match classify(&event.kind) {
                    Some(kind) => FsChange {
                        directory: dir.clone(),
                        kind,
                        paths: event.paths,
                    },
                    None => return,
                },
                Err(_) => FsChange {
                    directory: dir.clone(),
                    kind: ChangeKind::Rescan,
                    paths: Vec::new(),
                },
            };
            on_change(change);
        })
        .map_err(|e| AppError::Io(e.to_string()))?;
        inner
            .watch(directory, RecursiveMode::NonRecursive)
            .map_err(|e| AppError::Io(e.to_string()))?;
        Ok(Self {
            directory: directory.to_path_buf(),
            _inner: inner,
        })
    }

    /// The directory being watched.
    pub fn directory(&self) -> &Path {
        &self.directory
    }
}

fn classify(kind: &EventKind) -> Option<ChangeKind> {
    use notify::event::ModifyKind;
    match kind {
        EventKind::Create(_) => Some(ChangeKind::Created),
        EventKind::Remove(_) => Some(ChangeKind::Removed),
        EventKind::Modify(ModifyKind::Name(_)) => Some(ChangeKind::Renamed),
        EventKind::Modify(_) => Some(ChangeKind::Modified),
        EventKind::Other => Some(ChangeKind::Rescan),
        EventKind::Access(_) | EventKind::Any => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn reports_created_files() {
        let dir = tempfile::TempDir::new().unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = DirWatcher::watch(dir.path(), move |c| {
            let _ = tx.send(c);
        })
        .unwrap();
        assert_eq!(watcher.directory(), dir.path());

        std::fs::write(dir.path().join("new.txt"), "x").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let change = rx
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("no create event within 5s");
            if change.kind == ChangeKind::Created {
                assert!(change.paths.iter().any(|p| p.ends_with("new.txt")));
                break;
            }
        }
    }
}
