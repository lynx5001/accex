//! SQLite cache of previously visited directories.
//!
//! Every directory the user opens is recorded here, so later searches can
//! also find matches deeper than the flat-walk depth limit.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::engine::fs::{EntryKind, FileEntry};
use crate::error::AppResult;

/// Ordered schema migrations; index `i` upgrades `user_version` `i` -> `i + 1`.
const MIGRATIONS: &[&str] = &[include_str!("../../../migrations/0001_init.sql")];

/// Handle to the metadata cache database.
pub struct SearchIndex {
    conn: Connection,
}

impl SearchIndex {
    /// Opens (or creates) the database file and applies pending migrations.
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| crate::error::AppError::from_io(e, parent))?;
        }
        Self::init(Connection::open(path)?)
    }

    /// Opens a throwaway in-memory database (tests, or fallback when the
    /// data directory is unavailable).
    pub fn in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let version: usize = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", i + 1)?;
        }
        Ok(Self { conn })
    }

    /// Replaces the cached children of `dir` with `entries`.
    pub fn record_directory(&mut self, dir: &Path, entries: &[FileEntry]) -> AppResult<()> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default();
        let parent = dir.to_string_lossy();
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM entries WHERE parent = ?1", params![parent])?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT OR REPLACE INTO entries
                 (path, parent, name, name_lower, kind, size, modified, extension, hidden, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for e in entries {
                insert.execute(params![
                    e.path.to_string_lossy(),
                    parent,
                    e.name,
                    e.name.to_lowercase(),
                    e.kind.as_str(),
                    e.size.map(|s| s as i64),
                    e.modified,
                    e.extension,
                    e.hidden,
                    now,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Removes `path` and everything cached below it.
    pub fn forget(&mut self, path: &Path) -> AppResult<()> {
        let p = path.to_string_lossy();
        let prefix = format!("{}%", escape_like(&with_separator(&p)));
        self.conn.execute(
            "DELETE FROM entries WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'",
            params![p, prefix],
        )?;
        Ok(())
    }

    /// Returns cached entries below `scope` whose lower-case name contains
    /// `needle` (empty `needle` matches all), at most `limit` rows.
    pub fn candidates(
        &self,
        scope: &Path,
        needle: &str,
        show_hidden: bool,
        limit: usize,
    ) -> AppResult<Vec<FileEntry>> {
        let prefix = format!(
            "{}%",
            escape_like(&with_separator(&scope.to_string_lossy()))
        );
        let pattern = format!("%{}%", escape_like(needle));
        let mut stmt = self.conn.prepare_cached(
            "SELECT path, name, kind, size, modified, extension, hidden FROM entries
             WHERE path LIKE ?1 ESCAPE '\\' AND name_lower LIKE ?2 ESCAPE '\\'
               AND (?3 OR hidden = 0)
             LIMIT ?4",
        )?;
        let rows = stmt.query_map(params![prefix, pattern, show_hidden, limit as i64], |r| {
            Ok(FileEntry {
                path: PathBuf::from(r.get::<_, String>(0)?),
                name: r.get(1)?,
                kind: EntryKind::parse(&r.get::<_, String>(2)?),
                size: r.get::<_, Option<i64>>(3)?.map(|s| s as u64),
                modified: r.get(4)?,
                extension: r.get(5)?,
                hidden: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

fn with_separator(path: &str) -> String {
    if path.ends_with(std::path::MAIN_SEPARATOR) {
        path.to_owned()
    } else {
        format!("{path}{}", std::path::MAIN_SEPARATOR)
    }
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, kind: EntryKind) -> FileEntry {
        let path = PathBuf::from(path);
        FileEntry {
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            extension: path.extension().map(|e| e.to_string_lossy().into_owned()),
            path,
            kind,
            size: None,
            modified: None,
            hidden: false,
        }
    }

    #[cfg(unix)]
    #[test]
    fn records_and_finds_entries_below_scope() {
        let mut idx = SearchIndex::in_memory().unwrap();
        idx.record_directory(
            Path::new("/home/u/deep/er"),
            &[
                entry("/home/u/deep/er/Report_2024.pdf", EntryKind::File),
                entry("/home/u/deep/er/other.txt", EntryKind::File),
            ],
        )
        .unwrap();
        idx.record_directory(
            Path::new("/elsewhere"),
            &[entry("/elsewhere/report.pdf", EntryKind::File)],
        )
        .unwrap();

        let hits = idx
            .candidates(Path::new("/home/u"), "report", false, 10)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "Report_2024.pdf");

        // `_` must be matched literally, not as a LIKE wildcard.
        assert_eq!(
            idx.candidates(Path::new("/home/u"), "t_2", false, 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            idx.candidates(Path::new("/home/u"), "r_t", false, 10)
                .unwrap()
                .len(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn re_recording_replaces_children_and_forget_prunes() {
        let mut idx = SearchIndex::in_memory().unwrap();
        let dir = Path::new("/d");
        idx.record_directory(dir, &[entry("/d/a.txt", EntryKind::File)])
            .unwrap();
        idx.record_directory(dir, &[entry("/d/b.txt", EntryKind::File)])
            .unwrap();
        let all = idx.candidates(Path::new("/"), "", false, 10).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "b.txt");

        idx.forget(dir).unwrap();
        assert!(idx
            .candidates(Path::new("/"), "", false, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn migrations_are_idempotent_on_reopen() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = dir.path().join("index.sqlite");
        drop(SearchIndex::open(&db).unwrap());
        assert!(SearchIndex::open(&db).is_ok());
    }
}
