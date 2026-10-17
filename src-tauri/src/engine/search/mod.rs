//! Search engine: a bounded flat walk of the current scope, merged with
//! deeper matches from the SQLite cache of previously visited folders.

mod index;
mod query;

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub use index::SearchIndex;
pub use query::{KindFilter, SearchQuery};

use crate::engine::fs::{entry_for, EntryKind, FileEntry};
use crate::error::AppResult;

/// Tuning knobs for a single search.
#[derive(Debug, Clone, Copy)]
pub struct SearchOptions {
    /// Maximum number of hits returned.
    pub limit: usize,
    /// How many folder levels below the scope the walk descends
    /// (`0` = only the scope's direct children).
    pub max_depth: usize,
    /// Include hidden entries.
    pub show_hidden: bool,
    /// Upper bound on visited entries, protecting against huge trees.
    pub visit_budget: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            limit: 200,
            max_depth: 2,
            show_hidden: false,
            visit_budget: 200_000,
        }
    }
}

/// One search result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// The matching entry.
    #[serde(flatten)]
    pub entry: FileEntry,
    /// Full path of the folder containing the entry.
    pub parent: PathBuf,
    #[serde(skip)]
    score: i32,
    #[serde(skip)]
    depth: usize,
}

/// The outcome of a search.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// Best hits, at most `limit`.
    pub hits: Vec<SearchHit>,
    /// Total matches found (may exceed `hits.len()`).
    pub total: usize,
    /// More matches exist than were returned (or the walk budget ran out).
    pub truncated: bool,
}

/// Runs a search below `scope`.
pub fn search(
    scope: &Path,
    raw_query: &str,
    options: SearchOptions,
    index: Option<&SearchIndex>,
) -> AppResult<SearchResults> {
    let query = SearchQuery::parse(raw_query);
    if query.is_empty() {
        return Ok(SearchResults {
            hits: Vec::new(),
            total: 0,
            truncated: false,
        });
    }

    let (mut hits, budget_exhausted) = walk(scope, &query, options);

    if let Some(index) = index {
        let seen: HashSet<PathBuf> = hits.iter().map(|h| h.entry.path.clone()).collect();
        let needle = query.terms.first().map(String::as_str).unwrap_or("");
        for entry in index.candidates(scope, needle, options.show_hidden, 5_000)? {
            if seen.contains(&entry.path) || fs::symlink_metadata(&entry.path).is_err() {
                continue;
            }
            if let Some(score) = query.score(&entry.name, entry.kind, entry.extension.as_deref()) {
                let depth = entry
                    .path
                    .strip_prefix(scope)
                    .map(|p| p.components().count().saturating_sub(1))
                    .unwrap_or(usize::MAX);
                hits.push(hit(entry, score, depth));
            }
        }
    }

    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.depth.cmp(&b.depth))
            .then_with(|| {
                a.entry
                    .name
                    .to_lowercase()
                    .cmp(&b.entry.name.to_lowercase())
            })
    });
    let total = hits.len();
    hits.truncate(options.limit);
    Ok(SearchResults {
        truncated: budget_exhausted || total > hits.len(),
        total,
        hits,
    })
}

fn hit(entry: FileEntry, score: i32, depth: usize) -> SearchHit {
    SearchHit {
        parent: entry
            .path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default(),
        entry,
        score: score - depth as i32,
        depth,
    }
}

/// Breadth-first walk that never follows symlinks. Returns the matches and
/// whether the visit budget was exhausted.
fn walk(scope: &Path, query: &SearchQuery, options: SearchOptions) -> (Vec<SearchHit>, bool) {
    let mut hits = Vec::new();
    let mut visited = 0usize;
    let mut queue = VecDeque::from([(scope.to_path_buf(), 0usize)]);

    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for child in read.flatten() {
            visited += 1;
            if visited > options.visit_budget {
                return (hits, true);
            }
            let Ok(entry) = entry_for(&child.path()) else {
                continue;
            };
            if entry.hidden && !options.show_hidden {
                continue;
            }
            if entry.kind == EntryKind::Directory && depth < options.max_depth {
                queue.push_back((entry.path.clone(), depth + 1));
            }
            if let Some(score) = query.score(&entry.name, entry.kind, entry.extension.as_deref()) {
                hits.push(hit(entry, score, depth));
            }
        }
    }
    (hits, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// scope/
    ///   notes.txt
    ///   l1/report.txt
    ///   l1/l2/report-old.txt
    ///   l1/l2/l3/report-deep.txt   (beyond default depth)
    fn tree() -> TempDir {
        let dir = TempDir::new().unwrap();
        let l3 = dir.path().join("l1").join("l2").join("l3");
        fs::create_dir_all(&l3).unwrap();
        fs::write(dir.path().join("notes.txt"), "").unwrap();
        fs::write(dir.path().join("l1").join("report.txt"), "").unwrap();
        fs::write(dir.path().join("l1").join("l2").join("report-old.txt"), "").unwrap();
        fs::write(l3.join("report-deep.txt"), "").unwrap();
        dir
    }

    fn names(results: &SearchResults) -> Vec<&str> {
        results.hits.iter().map(|h| h.entry.name.as_str()).collect()
    }

    #[test]
    fn walk_respects_depth_limit() {
        let dir = tree();
        let r = search(dir.path(), "report", SearchOptions::default(), None).unwrap();
        assert_eq!(names(&r), ["report.txt", "report-old.txt"]);
        assert!(!r.truncated);
        assert_eq!(r.hits[0].parent, dir.path().join("l1"));
    }

    #[test]
    fn index_supplies_deeper_matches() {
        let dir = tree();
        let l3 = dir.path().join("l1").join("l2").join("l3");
        let mut index = SearchIndex::in_memory().unwrap();
        let listing = crate::engine::fs::list_directory(&l3, false).unwrap();
        index.record_directory(&l3, &listing).unwrap();

        let r = search(dir.path(), "report", SearchOptions::default(), Some(&index)).unwrap();
        assert_eq!(
            names(&r),
            ["report.txt", "report-old.txt", "report-deep.txt"]
        );
    }

    #[test]
    fn stale_index_entries_are_ignored() {
        let dir = tree();
        let l3 = dir.path().join("l1").join("l2").join("l3");
        let mut index = SearchIndex::in_memory().unwrap();
        let listing = crate::engine::fs::list_directory(&l3, false).unwrap();
        index.record_directory(&l3, &listing).unwrap();
        fs::remove_file(l3.join("report-deep.txt")).unwrap();

        let r = search(dir.path(), "deep", SearchOptions::default(), Some(&index)).unwrap();
        assert!(r.hits.is_empty());
    }

    #[test]
    fn limit_truncates_and_reports_total() {
        let dir = tree();
        let options = SearchOptions {
            limit: 1,
            ..SearchOptions::default()
        };
        let r = search(dir.path(), "txt", options, None).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.total, 3);
        assert!(r.truncated);
    }

    #[test]
    fn folder_filter() {
        let dir = tree();
        let r = search(dir.path(), "folders l", SearchOptions::default(), None).unwrap();
        assert_eq!(names(&r), ["l1", "l2", "l3"]);
    }

    #[test]
    fn empty_query_returns_nothing() {
        let dir = tree();
        let r = search(dir.path(), "   ", SearchOptions::default(), None).unwrap();
        assert!(r.hits.is_empty());
    }
}
