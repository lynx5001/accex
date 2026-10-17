//! File system abstraction: path validation, directory listing, metadata and
//! the write operations offered by the command palette.
//!
//! Symlinks are never followed (they are reported as [`EntryKind::Symlink`])
//! to rule out infinite loops during listing, copying and searching.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// What kind of file system object an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    /// A regular folder.
    Directory,
    /// A regular file.
    File,
    /// A symbolic link (never followed).
    Symlink,
}

impl EntryKind {
    /// Stable string form used by the search index.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File => "file",
            Self::Symlink => "symlink",
        }
    }

    /// Inverse of [`EntryKind::as_str`]; unknown values map to `File`.
    pub fn parse(s: &str) -> Self {
        match s {
            "directory" => Self::Directory,
            "symlink" => Self::Symlink,
            _ => Self::File,
        }
    }
}

/// One file or folder as shown in the listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// File name including extension.
    pub name: String,
    /// Absolute path.
    pub path: PathBuf,
    /// File, folder or symlink.
    pub kind: EntryKind,
    /// Size in bytes (files only).
    pub size: Option<u64>,
    /// Last modification time in milliseconds since the Unix epoch.
    pub modified: Option<i64>,
    /// Lower-case extension without the dot, if any.
    pub extension: Option<String>,
    /// Whether the OS considers this entry hidden.
    pub hidden: bool,
}

/// One clickable segment of the location breadcrumb.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSegment {
    /// Display name of the segment (`/` for the root).
    pub name: String,
    /// Absolute path up to and including this segment.
    pub path: PathBuf,
}

/// Expands `~`, requires an absolute path and canonicalizes it.
///
/// This is the single entry point for every path that arrives from the UI,
/// so `..` tricks and dangling inputs are resolved or rejected here.
pub fn resolve_path(input: &str) -> AppResult<PathBuf> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(AppError::InvalidPath(input.to_owned()));
    }
    let expanded = if trimmed == "~" {
        home_dir()
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        home_dir().join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    if !expanded.is_absolute() {
        return Err(AppError::InvalidPath(input.to_owned()));
    }
    let canonical = fs::canonicalize(&expanded).map_err(|e| AppError::from_io(e, &expanded))?;
    Ok(strip_verbatim(canonical))
}

/// Like [`resolve_path`] but additionally requires a directory.
pub fn resolve_directory(input: &str) -> AppResult<PathBuf> {
    let path = resolve_path(input)?;
    if !path.is_dir() {
        return Err(AppError::NotADirectory(path));
    }
    Ok(path)
}

/// The user's home directory, falling back to the file system root.
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(std::path::MAIN_SEPARATOR_STR))
}

/// Windows' `canonicalize` returns `\\?\C:\...`; strip that for display.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return PathBuf::from(rest);
            }
        }
    }
    path
}

/// Returns `path` itself if it is an existing directory, otherwise its
/// nearest existing ancestor, or the home directory as a last resort.
///
/// Used when the current folder disappears (e.g. a disk was unplugged).
pub fn nearest_existing_directory(path: &Path) -> PathBuf {
    path.ancestors()
        .find(|p| p.is_dir())
        .map(Path::to_path_buf)
        .unwrap_or_else(home_dir)
}

/// Splits an absolute path into breadcrumb segments, root first.
pub fn breadcrumbs(path: &Path) -> Vec<PathSegment> {
    let mut segments: Vec<PathSegment> = Vec::new();
    let mut acc = PathBuf::new();
    for component in path.components() {
        acc.push(component.as_os_str());
        let name = match component {
            Component::Prefix(p) => p.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => {
                if segments.is_empty() {
                    std::path::MAIN_SEPARATOR_STR.to_owned()
                } else {
                    // Windows: `C:` followed by `\` -> keep a single segment.
                    if let Some(last) = segments.last_mut() {
                        last.path = acc.clone();
                    }
                    continue;
                }
            }
            Component::Normal(n) => n.to_string_lossy().into_owned(),
            Component::CurDir | Component::ParentDir => continue,
        };
        segments.push(PathSegment {
            name,
            path: acc.clone(),
        });
    }
    segments
}

/// Builds a [`FileEntry`] for `path` without following symlinks.
pub fn entry_for(path: &Path) -> AppResult<FileEntry> {
    let meta = fs::symlink_metadata(path).map_err(|e| AppError::from_io(e, path))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let file_type = meta.file_type();
    let kind = if file_type.is_symlink() {
        EntryKind::Symlink
    } else if file_type.is_dir() {
        EntryKind::Directory
    } else {
        EntryKind::File
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let extension = if kind == EntryKind::Directory {
        None
    } else {
        path.extension().map(|e| e.to_string_lossy().to_lowercase())
    };
    Ok(FileEntry {
        hidden: is_hidden(&name, &meta),
        size: (kind == EntryKind::File).then_some(meta.len()),
        name,
        path: path.to_path_buf(),
        kind,
        modified,
        extension,
    })
}

/// OS convention for hidden entries: dot-files on Unix, the hidden
/// attribute on Windows.
#[cfg_attr(not(windows), allow(unused_variables))]
fn is_hidden(name: &str, meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(windows))]
    {
        name.starts_with('.')
    }
}

/// Lists a directory: folders first, then files, each sorted
/// case-insensitively. Entries that vanish while reading are skipped.
pub fn list_directory(dir: &Path, show_hidden: bool) -> AppResult<Vec<FileEntry>> {
    let read = fs::read_dir(dir).map_err(|e| AppError::from_io(e, dir))?;
    let mut entries: Vec<FileEntry> = read
        .filter_map(Result::ok)
        .filter_map(|e| entry_for(&e.path()).ok())
        .filter(|e| show_hidden || !e.hidden)
        .collect();
    sort_entries(&mut entries);
    Ok(entries)
}

/// Folders first, then case-insensitive by name.
pub fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by_cached_key(|e| (e.kind != EntryKind::Directory, e.name.to_lowercase()));
}

/// Rejects names that are empty, special or would escape the folder.
pub fn validate_name(name: &str) -> AppResult<()> {
    let forbidden: &[char] = if cfg!(windows) {
        &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0']
    } else {
        &['/', '\0']
    };
    if name.trim().is_empty() || name == "." || name == ".." || name.contains(forbidden) {
        return Err(AppError::InvalidName(name.to_owned()));
    }
    Ok(())
}

/// Paths that must never be deleted or moved: the root, the home folder and
/// every ancestor of the home folder.
fn is_protected(path: &Path) -> bool {
    path.parent().is_none() || home_dir().starts_with(path)
}

/// Renames `path` to `new_name` inside the same folder; returns the new path.
pub fn rename(path: &Path, new_name: &str) -> AppResult<PathBuf> {
    validate_name(new_name)?;
    if is_protected(path) {
        return Err(AppError::Refused(path.to_string_lossy().into_owned()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidPath(path.to_string_lossy().into_owned()))?;
    let target = parent.join(new_name);
    if target == path {
        return Ok(target);
    }
    // Allow case-only renames on case-insensitive file systems.
    let case_only =
        target.to_string_lossy().to_lowercase() == path.to_string_lossy().to_lowercase();
    if !case_only && fs::symlink_metadata(&target).is_ok() {
        return Err(AppError::AlreadyExists(target));
    }
    fs::rename(path, &target).map_err(|e| AppError::from_io(e, path))?;
    Ok(target)
}

/// Moves `path` to the OS trash (recoverable deletion).
pub fn delete(path: &Path) -> AppResult<()> {
    if is_protected(path) {
        return Err(AppError::Refused(path.to_string_lossy().into_owned()));
    }
    fs::symlink_metadata(path).map_err(|e| AppError::from_io(e, path))?;
    trash::delete(path).map_err(|e| AppError::Io(e.to_string()))
}

/// Returns a path inside `dir` named like `name` that does not exist yet:
/// `report.txt`, `report (2).txt`, `report (3).txt`, ...
pub fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if fs::symlink_metadata(&candidate).is_err() {
        return candidate;
    }
    let as_path = Path::new(name);
    let (stem, ext) = match (as_path.file_stem(), as_path.extension()) {
        (Some(stem), Some(ext)) if !name.starts_with('.') || name.matches('.').count() > 1 => (
            stem.to_string_lossy().into_owned(),
            format!(".{}", ext.to_string_lossy()),
        ),
        _ => (name.to_owned(), String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| fs::symlink_metadata(p).is_err())
        .expect("unbounded range always yields a free name")
}

/// Refuses to copy or move a folder into itself or one of its descendants.
fn ensure_not_into_self(src: &Path, dest_dir: &Path) -> AppResult<()> {
    if dest_dir.starts_with(src) {
        return Err(AppError::Refused(src.to_string_lossy().into_owned()));
    }
    Ok(())
}

/// Copies `src` (file, symlink or folder, recursively) into `dest_dir`.
/// Name collisions get a numbered suffix. Returns the created path.
pub fn copy_into(src: &Path, dest_dir: &Path) -> AppResult<PathBuf> {
    if !dest_dir.is_dir() {
        return Err(AppError::NotADirectory(dest_dir.to_path_buf()));
    }
    ensure_not_into_self(src, dest_dir)?;
    let name = file_name(src)?;
    let target = unique_target(dest_dir, &name);
    copy_recursive(src, &target)?;
    Ok(target)
}

/// Moves `src` into `dest_dir`, falling back to copy + delete across
/// devices. Returns the new path.
pub fn move_into(src: &Path, dest_dir: &Path) -> AppResult<PathBuf> {
    if is_protected(src) {
        return Err(AppError::Refused(src.to_string_lossy().into_owned()));
    }
    if !dest_dir.is_dir() {
        return Err(AppError::NotADirectory(dest_dir.to_path_buf()));
    }
    if src.parent() == Some(dest_dir) {
        return Ok(src.to_path_buf());
    }
    ensure_not_into_self(src, dest_dir)?;
    let name = file_name(src)?;
    let target = unique_target(dest_dir, &name);
    match fs::rename(src, &target) {
        Ok(()) => Ok(target),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_recursive(src, &target)?;
            remove_permanently(src)?;
            Ok(target)
        }
        Err(e) => Err(AppError::from_io(e, src)),
    }
}

fn file_name(path: &Path) -> AppResult<String> {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::InvalidPath(path.to_string_lossy().into_owned()))
}

fn copy_recursive(src: &Path, target: &Path) -> AppResult<()> {
    let meta = fs::symlink_metadata(src).map_err(|e| AppError::from_io(e, src))?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        let link = fs::read_link(src).map_err(|e| AppError::from_io(e, src))?;
        create_symlink(&link, target, src)
    } else if ft.is_dir() {
        fs::create_dir(target).map_err(|e| AppError::from_io(e, target))?;
        for child in fs::read_dir(src).map_err(|e| AppError::from_io(e, src))? {
            let child = child.map_err(|e| AppError::from_io(e, src))?;
            copy_recursive(&child.path(), &target.join(child.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, target)
            .map(|_| ())
            .map_err(|e| AppError::from_io(e, src))
    }
}

#[cfg(unix)]
fn create_symlink(link: &Path, target: &Path, _src: &Path) -> AppResult<()> {
    std::os::unix::fs::symlink(link, target).map_err(|e| AppError::from_io(e, target))
}

#[cfg(windows)]
fn create_symlink(link: &Path, target: &Path, src: &Path) -> AppResult<()> {
    let result = if fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false) {
        std::os::windows::fs::symlink_dir(link, target)
    } else {
        std::os::windows::fs::symlink_file(link, target)
    };
    result.map_err(|e| AppError::from_io(e, target))
}

/// Permanent removal; only used after a successful cross-device copy.
/// `remove_dir_all` does not follow symlinks.
fn remove_permanently(path: &Path) -> AppResult<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| AppError::from_io(e, path))?;
    let result = if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|e| AppError::from_io(e, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tree() -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("Beta")).unwrap();
        fs::create_dir(dir.path().join("alpha")).unwrap();
        fs::write(dir.path().join("b.txt"), "bb").unwrap();
        fs::write(dir.path().join("A.md"), "a").unwrap();
        fs::write(dir.path().join(".hidden"), "").unwrap();
        fs::write(dir.path().join("alpha").join("inner.txt"), "inner").unwrap();
        dir
    }

    #[test]
    fn resolve_rejects_relative_and_empty() {
        assert!(matches!(resolve_path(""), Err(AppError::InvalidPath(_))));
        assert!(matches!(
            resolve_path("some/relative"),
            Err(AppError::InvalidPath(_))
        ));
    }

    #[test]
    fn resolve_canonicalizes_parent_components() {
        let dir = tree();
        let input = dir.path().join("alpha").join("..").join("Beta");
        let resolved = resolve_path(input.to_str().unwrap()).unwrap();
        assert_eq!(resolved, fs::canonicalize(dir.path().join("Beta")).unwrap());
    }

    #[test]
    fn resolve_reports_missing_paths() {
        let dir = tree();
        let missing = dir.path().join("nope");
        assert!(matches!(
            resolve_path(missing.to_str().unwrap()),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn resolve_directory_rejects_files() {
        let dir = tree();
        let file = dir.path().join("b.txt");
        assert!(matches!(
            resolve_directory(file.to_str().unwrap()),
            Err(AppError::NotADirectory(_))
        ));
    }

    #[test]
    fn listing_sorts_folders_first_and_hides_dotfiles() {
        let dir = tree();
        let names: Vec<_> = list_directory(dir.path(), false)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        if cfg!(windows) {
            assert!(names.contains(&".hidden".to_owned()));
        } else {
            assert_eq!(names, ["alpha", "Beta", "A.md", "b.txt"]);
        }
    }

    #[test]
    fn listing_can_include_hidden_files() {
        let dir = tree();
        let entries = list_directory(dir.path(), true).unwrap();
        assert!(entries.iter().any(|e| e.name == ".hidden"));
    }

    #[test]
    fn entry_metadata_is_populated() {
        let dir = tree();
        let e = entry_for(&dir.path().join("b.txt")).unwrap();
        assert_eq!(e.kind, EntryKind::File);
        assert_eq!(e.size, Some(2));
        assert_eq!(e.extension.as_deref(), Some("txt"));
        assert!(e.modified.is_some());
        let d = entry_for(&dir.path().join("alpha")).unwrap();
        assert_eq!(d.kind, EntryKind::Directory);
        assert_eq!(d.size, None);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_reported_not_followed() {
        let dir = tree();
        let link = dir.path().join("loop");
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        assert_eq!(entry_for(&link).unwrap().kind, EntryKind::Symlink);
    }

    #[test]
    fn breadcrumbs_start_at_root() {
        let dir = tree();
        let path = fs::canonicalize(dir.path().join("alpha")).unwrap();
        let crumbs = breadcrumbs(&path);
        assert_eq!(crumbs.last().unwrap().name, "alpha");
        assert_eq!(crumbs.last().unwrap().path, path);
        assert!(crumbs.first().unwrap().path.parent().is_none());
    }

    #[test]
    fn nearest_existing_directory_walks_up() {
        let dir = tree();
        let gone = dir.path().join("alpha").join("missing").join("deeper");
        assert_eq!(nearest_existing_directory(&gone), dir.path().join("alpha"));
    }

    #[test]
    fn validate_name_rejects_separators_and_dots() {
        assert!(validate_name("ok name.txt").is_ok());
        for bad in ["", "  ", ".", "..", "a/b", "a\0b"] {
            assert!(validate_name(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn rename_refuses_existing_target() {
        let dir = tree();
        let err = rename(&dir.path().join("b.txt"), "A.md").unwrap_err();
        assert!(matches!(err, AppError::AlreadyExists(_)));
    }

    #[test]
    fn rename_moves_within_folder() {
        let dir = tree();
        let new = rename(&dir.path().join("b.txt"), "c.txt").unwrap();
        assert_eq!(new, dir.path().join("c.txt"));
        assert!(new.exists());
        assert!(!dir.path().join("b.txt").exists());
    }

    #[test]
    fn unique_target_appends_counter_before_extension() {
        let dir = tree();
        assert_eq!(
            unique_target(dir.path(), "new.txt"),
            dir.path().join("new.txt")
        );
        assert_eq!(
            unique_target(dir.path(), "b.txt"),
            dir.path().join("b (2).txt")
        );
        fs::write(dir.path().join("b (2).txt"), "").unwrap();
        assert_eq!(
            unique_target(dir.path(), "b.txt"),
            dir.path().join("b (3).txt")
        );
        assert_eq!(
            unique_target(dir.path(), "alpha"),
            dir.path().join("alpha (2)")
        );
    }

    #[test]
    fn copy_folder_recursively_with_unique_name() {
        let dir = tree();
        let copied = copy_into(&dir.path().join("alpha"), dir.path()).unwrap();
        assert_eq!(copied, dir.path().join("alpha (2)"));
        assert_eq!(
            fs::read_to_string(copied.join("inner.txt")).unwrap(),
            "inner"
        );
    }

    #[test]
    fn copy_into_own_subfolder_is_refused() {
        let dir = tree();
        let alpha = dir.path().join("alpha");
        assert!(matches!(
            copy_into(&alpha, &alpha),
            Err(AppError::Refused(_))
        ));
    }

    #[test]
    fn move_relocates_file() {
        let dir = tree();
        let moved = move_into(&dir.path().join("b.txt"), &dir.path().join("Beta")).unwrap();
        assert_eq!(moved, dir.path().join("Beta").join("b.txt"));
        assert!(!dir.path().join("b.txt").exists());
    }

    #[test]
    fn deleting_home_or_root_is_refused() {
        assert!(matches!(delete(&home_dir()), Err(AppError::Refused(_))));
        let root = home_dir().ancestors().last().unwrap().to_path_buf();
        assert!(matches!(delete(&root), Err(AppError::Refused(_))));
    }

    #[test]
    fn deleting_missing_path_reports_not_found() {
        let dir = tree();
        assert!(matches!(
            delete(&dir.path().join("ghost")),
            Err(AppError::NotFound(_))
        ));
    }

    /// Performance goal: < 5,000 items read in well under 100 ms. This test
    /// uses 10,000 files and a generous bound to stay stable on CI.
    #[test]
    fn lists_ten_thousand_files_quickly() {
        let dir = TempDir::new().unwrap();
        for i in 0..10_000 {
            fs::File::create(dir.path().join(format!("file-{i:05}.txt"))).unwrap();
        }
        let start = std::time::Instant::now();
        let entries = list_directory(dir.path(), false).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(entries.len(), 10_000);
        assert!(elapsed.as_millis() < 1_000, "listing took {elapsed:?}");
    }
}
