//! Persistent app configuration (bookmarks) stored as JSON in the platform's
//! config directory. SQLite is reserved for the search index.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// A saved file or folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    /// Display name (the file or folder name by default).
    pub name: String,
    /// Absolute path.
    pub path: PathBuf,
    /// Folder or file; bookmarks saved before files were allowed are folders.
    #[serde(default = "folder")]
    pub is_directory: bool,
}

fn folder() -> bool {
    true
}

/// On-disk shape of the config file. New settings get `#[serde(default)]`
/// so older files keep loading.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFile {
    #[serde(default)]
    bookmarks: Vec<Bookmark>,
}

/// Bookmarks backed by a JSON file.
pub struct BookmarkStore {
    file: PathBuf,
    config: ConfigFile,
}

impl BookmarkStore {
    /// Loads the store from `file`. A missing file yields an empty store; a
    /// corrupt one is logged and replaced on the next save.
    pub fn load(file: &Path) -> Self {
        let config = match fs::read_to_string(file) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
                tracing::warn!(%err, "config file is corrupt; starting with defaults");
                ConfigFile::default()
            }),
            Err(_) => ConfigFile::default(),
        };
        Self {
            file: file.to_path_buf(),
            config,
        }
    }

    /// All bookmarks: folders first, then files, each alphabetically
    /// (case-insensitive). The file keeps insertion order.
    pub fn list(&self) -> Vec<Bookmark> {
        let mut sorted = self.config.bookmarks.clone();
        sorted.sort_by_cached_key(|b| (!b.is_directory, b.name.to_lowercase(), b.path.clone()));
        sorted
    }

    /// Adds a bookmark for `path` unless one exists. Returns `true` if added.
    pub fn add(&mut self, path: &Path) -> AppResult<bool> {
        if self.config.bookmarks.iter().any(|b| b.path == path) {
            return Ok(false);
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        self.config.bookmarks.push(Bookmark {
            name,
            path: path.to_path_buf(),
            is_directory: path.is_dir(),
        });
        self.save()?;
        Ok(true)
    }

    /// Removes the bookmark for `path`. Returns `true` if one was removed.
    pub fn remove(&mut self, path: &Path) -> AppResult<bool> {
        let before = self.config.bookmarks.len();
        self.config.bookmarks.retain(|b| b.path != path);
        let removed = self.config.bookmarks.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Writes atomically (temp file + rename) so a crash never leaves a
    /// half-written config.
    fn save(&self) -> AppResult<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| AppError::from_io(e, dir))?;
        }
        let json =
            serde_json::to_string_pretty(&self.config).map_err(|e| AppError::Io(e.to_string()))?;
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| AppError::from_io(e, &tmp))?;
        fs::rename(&tmp, &self.file).map_err(|e| AppError::from_io(e, &self.file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_persists_and_deduplicates() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("cfg").join("config.json");
        let mut store = BookmarkStore::load(&file);
        assert!(store.list().is_empty());
        assert!(store.add(Path::new("/tmp/Projects")).unwrap());
        assert!(!store.add(Path::new("/tmp/Projects")).unwrap());

        let reloaded = BookmarkStore::load(&file);
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.list()[0].name, "Projects");
    }

    #[test]
    fn remove_deletes_bookmark() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("config.json");
        let mut store = BookmarkStore::load(&file);
        store.add(Path::new("/a")).unwrap();
        assert!(store.remove(Path::new("/a")).unwrap());
        assert!(!store.remove(Path::new("/a")).unwrap());
        assert!(BookmarkStore::load(&file).list().is_empty());
    }

    #[test]
    fn list_puts_folders_first_then_sorts_by_name() {
        let dir = tempfile::TempDir::new().unwrap();
        for folder in ["zeta", "Alpha"] {
            fs::create_dir(dir.path().join(folder)).unwrap();
        }
        for file in ["beta.txt", "Aaa.md"] {
            fs::write(dir.path().join(file), "").unwrap();
        }
        let mut store = BookmarkStore::load(&dir.path().join("config.json"));
        for name in ["beta.txt", "zeta", "Aaa.md", "Alpha"] {
            store.add(&dir.path().join(name)).unwrap();
        }
        let names: Vec<_> = store.list().into_iter().map(|b| b.name).collect();
        assert_eq!(names, ["Alpha", "zeta", "Aaa.md", "beta.txt"]);
    }

    #[test]
    fn old_bookmarks_without_kind_load_as_folders() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("config.json");
        fs::write(&file, r#"{"bookmarks":[{"name":"a","path":"/a"}]}"#).unwrap();
        assert!(BookmarkStore::load(&file).list()[0].is_directory);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("config.json");
        fs::write(&file, "{ not json").unwrap();
        assert!(BookmarkStore::load(&file).list().is_empty());
    }
}
