//! Unified error type shared by the engine and the IPC bridge.
//!
//! Errors cross the bridge as `{ "kind": "...", "path": "..." }` so the
//! frontend can pick a translated, screen-reader-friendly message by `kind`
//! instead of displaying raw OS strings.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Every failure the application can report to the user.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// The OS refused access to a path.
    #[error("access denied: {0}")]
    PermissionDenied(PathBuf),
    /// The path does not exist (e.g. a disk was unplugged).
    #[error("not found: {0}")]
    NotFound(PathBuf),
    /// The target of a copy, move or rename already exists.
    #[error("already exists: {0}")]
    AlreadyExists(PathBuf),
    /// The path is syntactically unacceptable (relative, empty, ...).
    #[error("invalid path: {0}")]
    InvalidPath(String),
    /// A file name contains separators or other forbidden characters.
    #[error("invalid name: {0}")]
    InvalidName(String),
    /// A folder operation was attempted on a file or vice versa.
    #[error("not a directory: {0}")]
    NotADirectory(PathBuf),
    /// The operation is refused for safety (e.g. deleting the home folder).
    #[error("refused: {0}")]
    Refused(String),
    /// Paste was requested with an empty clipboard.
    #[error("clipboard is empty")]
    ClipboardEmpty,
    /// Any other I/O failure.
    #[error("i/o error: {0}")]
    Io(String),
    /// Search index failure.
    #[error("index error: {0}")]
    Index(String),
}

impl AppError {
    /// Maps an [`std::io::Error`] to the matching variant for `path`.
    pub fn from_io(err: std::io::Error, path: &Path) -> Self {
        use std::io::ErrorKind;
        match err.kind() {
            ErrorKind::PermissionDenied => Self::PermissionDenied(path.to_path_buf()),
            ErrorKind::NotFound => Self::NotFound(path.to_path_buf()),
            ErrorKind::AlreadyExists => Self::AlreadyExists(path.to_path_buf()),
            ErrorKind::NotADirectory => Self::NotADirectory(path.to_path_buf()),
            _ => Self::Io(err.to_string()),
        }
    }

    /// Stable machine-readable identifier used as the i18n key suffix.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::PermissionDenied(_) => "permissionDenied",
            Self::NotFound(_) => "notFound",
            Self::AlreadyExists(_) => "alreadyExists",
            Self::InvalidPath(_) => "invalidPath",
            Self::InvalidName(_) => "invalidName",
            Self::NotADirectory(_) => "notADirectory",
            Self::Refused(_) => "refused",
            Self::ClipboardEmpty => "clipboardEmpty",
            Self::Io(_) => "io",
            Self::Index(_) => "index",
        }
    }

    /// The path the error refers to, if any.
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::PermissionDenied(p)
            | Self::NotFound(p)
            | Self::AlreadyExists(p)
            | Self::NotADirectory(p) => Some(p),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Index(err.to_string())
    }
}

#[derive(Serialize)]
struct WireError<'a> {
    kind: &'a str,
    path: Option<String>,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        WireError {
            kind: self.kind(),
            path: self.path().map(|p| p.to_string_lossy().into_owned()),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

/// Convenience alias used throughout the crate.
pub type AppResult<T> = Result<T, AppError>;
