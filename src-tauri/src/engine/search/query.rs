//! Turns what the user typed into a structured query.
//!
//! Besides plain name fragments, a few natural-language words are understood
//! (English and German): "pdf invoices", "images from holiday",
//! "folders named projects", "*.rs". Filler words are ignored.

use crate::engine::fs::EntryKind;

/// Restricts results to files or folders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindFilter {
    /// Only regular files (and symlinks).
    Files,
    /// Only folders.
    Directories,
}

/// A parsed search request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    /// Lower-case fragments that must all occur in the name.
    pub terms: Vec<String>,
    /// Optional file/folder restriction.
    pub kind: Option<KindFilter>,
    /// Allowed lower-case extensions; empty means any.
    pub extensions: Vec<String>,
}

const STOPWORDS: &[&str] = &[
    // English
    "a", "all", "an", "and", "any", "called", "find", "for", "from", "in", "me", "my", "named",
    "of", "on", "search", "show", "some", "that", "the", "with", // German
    "alle", "aus", "das", "der", "die", "ein", "eine", "finde", "für", "im", "in", "mit", "namens",
    "suche", "vom", "von", "zeige", "zeig", "zum",
];

const IMAGES: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "tif", "tiff",
];
const DOCUMENTS: &[&str] = &["pdf", "doc", "docx", "odt", "rtf", "txt", "md"];
const SPREADSHEETS: &[&str] = &["xls", "xlsx", "ods", "csv"];
const PRESENTATIONS: &[&str] = &["ppt", "pptx", "odp", "key"];
const VIDEOS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm"];
const AUDIO: &[&str] = &["mp3", "flac", "wav", "ogg", "m4a", "aac", "opus"];
const ARCHIVES: &[&str] = &["zip", "tar", "gz", "tgz", "7z", "rar", "xz", "bz2"];
const STANDALONE_EXTENSIONS: &[&str] = &["pdf", "docx", "xlsx", "pptx", "csv", "mp3", "mp4", "zip"];

fn category(word: &str) -> Option<&'static [&'static str]> {
    Some(match word {
        "image" | "images" | "photo" | "photos" | "picture" | "pictures" | "bild" | "bilder"
        | "foto" | "fotos" => IMAGES,
        "document" | "documents" | "doc" | "docs" | "dokument" | "dokumente" => DOCUMENTS,
        "spreadsheet" | "spreadsheets" | "tabelle" | "tabellen" => SPREADSHEETS,
        "presentation" | "presentations" | "slides" | "präsentation" | "präsentationen" => {
            PRESENTATIONS
        }
        "video" | "videos" | "movie" | "movies" | "film" | "filme" => VIDEOS,
        "audio" | "music" | "song" | "songs" | "musik" | "lied" | "lieder" => AUDIO,
        "archive" | "archives" | "archiv" => ARCHIVES,
        _ => return None,
    })
}

fn kind_word(word: &str) -> Option<KindFilter> {
    match word {
        "folder" | "folders" | "directory" | "directories" | "dir" | "dirs" | "ordner"
        | "verzeichnis" | "verzeichnisse" => Some(KindFilter::Directories),
        "file" | "files" | "datei" | "dateien" => Some(KindFilter::Files),
        _ => None,
    }
}

impl SearchQuery {
    /// Parses free text into a query. Never fails; an all-filler input falls
    /// back to treating every word as a name fragment.
    pub fn parse(input: &str) -> Self {
        let lower = input.trim().to_lowercase();
        let words: Vec<&str> = lower.split_whitespace().collect();
        let mut query = SearchQuery::default();

        for word in &words {
            if let Some(ext) = word.strip_prefix("*.").or_else(|| word.strip_prefix('.')) {
                if !ext.is_empty() && ext.chars().all(char::is_alphanumeric) {
                    query.extensions.push(ext.to_owned());
                    continue;
                }
            }
            if let Some(kind) = kind_word(word) {
                query.kind = Some(kind);
                continue;
            }
            if let Some(exts) = category(word) {
                query.kind.get_or_insert(KindFilter::Files);
                query
                    .extensions
                    .extend(exts.iter().map(|e| (*e).to_owned()));
                continue;
            }
            if STANDALONE_EXTENSIONS.contains(word) && words.len() > 1 {
                query.extensions.push((*word).to_owned());
                continue;
            }
            if STOPWORDS.contains(word) {
                continue;
            }
            query.terms.push((*word).to_owned());
        }

        if query.is_empty() && !words.is_empty() {
            query.terms = words.iter().map(|w| (*w).to_owned()).collect();
        }
        query.extensions.sort();
        query.extensions.dedup();
        query
    }

    /// True when the query would match everything.
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.kind.is_none() && self.extensions.is_empty()
    }

    /// Scores a candidate; `None` means no match. Higher is better.
    pub fn score(&self, name: &str, kind: EntryKind, extension: Option<&str>) -> Option<i32> {
        if self.is_empty() {
            return None;
        }
        match (self.kind, kind) {
            (Some(KindFilter::Directories), EntryKind::Directory) => {}
            (Some(KindFilter::Directories), _) => return None,
            (Some(KindFilter::Files), EntryKind::Directory) => return None,
            _ => {}
        }
        if !self.extensions.is_empty()
            && !extension.is_some_and(|e| self.extensions.iter().any(|x| x == e))
        {
            return None;
        }
        let name = name.to_lowercase();
        if !self.terms.iter().all(|t| name.contains(t.as_str())) {
            return None;
        }
        let stem = name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s);
        let joined = self.terms.join(" ");
        Some(if self.terms.is_empty() {
            1
        } else if name == joined || stem == joined {
            100
        } else if name.starts_with(self.terms[0].as_str()) {
            50
        } else {
            10
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_words_become_terms() {
        let q = SearchQuery::parse("  Budget 2024 ");
        assert_eq!(q.terms, ["budget", "2024"]);
        assert_eq!(q.kind, None);
    }

    #[test]
    fn natural_language_is_understood() {
        let q = SearchQuery::parse("find all pdf invoices");
        assert_eq!(q.terms, ["invoices"]);
        assert_eq!(q.extensions, ["pdf"]);

        let q = SearchQuery::parse("folders named projects");
        assert_eq!(q.terms, ["projects"]);
        assert_eq!(q.kind, Some(KindFilter::Directories));

        let q = SearchQuery::parse("Bilder vom Urlaub");
        assert_eq!(q.kind, Some(KindFilter::Files));
        assert!(q.extensions.contains(&"jpg".to_owned()));
        assert_eq!(q.terms, ["urlaub"]);
    }

    #[test]
    fn extension_patterns() {
        let q = SearchQuery::parse("*.rs");
        assert!(q.terms.is_empty());
        assert_eq!(q.extensions, ["rs"]);
    }

    #[test]
    fn filler_only_input_is_kept_literally() {
        assert_eq!(SearchQuery::parse("the").terms, ["the"]);
        assert_eq!(SearchQuery::parse("pdf").terms, ["pdf"]);
    }

    #[test]
    fn scoring_prefers_exact_then_prefix() {
        let q = SearchQuery::parse("report");
        let exact = q.score("Report.pdf", EntryKind::File, Some("pdf")).unwrap();
        let prefix = q
            .score("report-final.pdf", EntryKind::File, Some("pdf"))
            .unwrap();
        let inner = q
            .score("old-report.pdf", EntryKind::File, Some("pdf"))
            .unwrap();
        assert!(exact > prefix && prefix > inner);
        assert_eq!(q.score("notes.txt", EntryKind::File, Some("txt")), None);
    }

    #[test]
    fn filters_apply() {
        let q = SearchQuery::parse("folders src");
        assert!(q.score("src", EntryKind::Directory, None).is_some());
        assert!(q.score("src", EntryKind::File, None).is_none());
        let q = SearchQuery::parse("*.md");
        assert!(q.score("README.md", EntryKind::File, Some("md")).is_some());
        assert!(q
            .score("README.txt", EntryKind::File, Some("txt"))
            .is_none());
    }
}
