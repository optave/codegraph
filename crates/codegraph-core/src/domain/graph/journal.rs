//! Read/write the `changes.journal` file for incremental build fast paths.
//!
//! Format:
//! ```text
//! # codegraph-journal v1 <timestamp_ms>
//! relative/path/to/changed.ts
//! DELETED relative/path/to/removed.ts
//! ```

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const HEADER_PREFIX: &str = "# codegraph-journal v1 ";

#[derive(Debug, Default)]
pub struct JournalResult {
    pub valid: bool,
    pub timestamp: f64,
    pub changed: Vec<String>,
    pub removed: Vec<String>,
}

fn journal_path(journal_dir: &str) -> PathBuf {
    Path::new(journal_dir).join("changes.journal")
}

/// Read and parse the changes journal.
///
/// `journal_dir` is the directory the journal lives in directly — normally
/// the database's own directory (`Path::new(db_path).parent()`), NOT
/// `root_dir`. `db_path` defaults to `root_dir/.codegraph/graph.db`, so the
/// common case is unchanged (`root_dir/.codegraph`), but a caller-supplied
/// `dbPath` override relocates the database — and the journal must follow
/// it, or a build targeting a custom `dbPath` writes a stray `.codegraph/`
/// into `root_dir` that the actual database never uses (#2426). Mirrors TS
/// `readJournal` in `src/domain/graph/journal.ts`.
pub fn read_journal(journal_dir: &str) -> JournalResult {
    let path = journal_path(journal_dir);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return JournalResult::default(),
    };

    let mut lines = content.lines();
    let header = match lines.next() {
        Some(h) if h.starts_with(HEADER_PREFIX) => h,
        _ => return JournalResult::default(),
    };

    let timestamp: f64 = match header[HEADER_PREFIX.len()..].trim().parse::<f64>() {
        Ok(t) if t > 0.0 && t.is_finite() => t,
        _ => return JournalResult::default(),
    };

    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut seen_changed = HashSet::new();
    let mut seen_removed = HashSet::new();

    for line in lines {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(file_path) = line.strip_prefix("DELETED ") {
            if !file_path.is_empty() && seen_removed.insert(file_path.to_string()) {
                removed.push(file_path.to_string());
            }
        } else if seen_changed.insert(line.to_string()) {
            changed.push(line.to_string());
        }
    }

    JournalResult {
        valid: true,
        timestamp,
        changed,
        removed,
    }
}

/// Write a fresh journal header, atomically replacing the old journal.
///
/// `journal_dir` — see `read_journal`'s doc comment: the database's own
/// directory, not `root_dir`.
pub fn write_journal_header(journal_dir: &str, timestamp: f64) {
    let dir = Path::new(journal_dir);
    let path = dir.join("changes.journal");
    let tmp = dir.join("changes.journal.tmp");

    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("Warning: failed to create journal dir: {e}");
        return;
    }

    let content = format!("{HEADER_PREFIX}{timestamp}\n");
    if fs::write(&tmp, &content).is_ok() && fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn round_trip_journal() {
        let tmp = std::env::temp_dir().join("codegraph_journal_test");
        let dir = tmp.join(".codegraph");
        let journal_dir = dir.to_str().unwrap();
        fs::create_dir_all(&dir).unwrap();

        // Write header
        write_journal_header(journal_dir, 1700000000000.0);

        // Append some entries manually
        let journal_file = dir.join("changes.journal");
        let mut content = fs::read_to_string(&journal_file).unwrap();
        content.push_str("src/foo.ts\n");
        content.push_str("DELETED src/bar.ts\n");
        content.push_str("src/foo.ts\n"); // duplicate
        fs::write(&journal_file, &content).unwrap();

        let result = read_journal(journal_dir);
        assert!(result.valid);
        assert_eq!(result.timestamp, 1700000000000.0);
        assert_eq!(result.changed, vec!["src/foo.ts"]);
        assert_eq!(result.removed, vec!["src/bar.ts"]);

        // Cleanup
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn round_trip_journal_in_a_dir_not_named_dot_codegraph() {
        // #2426: a caller-supplied `dbPath` need not live under a
        // `.codegraph`-named directory at all — the journal must follow
        // whatever directory actually holds the database, verbatim.
        let tmp = std::env::temp_dir().join("codegraph_journal_custom_dbpath");
        let journal_dir = tmp.to_str().unwrap();
        fs::create_dir_all(&tmp).unwrap();

        write_journal_header(journal_dir, 1700000000000.0);
        let journal_file = tmp.join("changes.journal");
        assert!(journal_file.exists());

        let result = read_journal(journal_dir);
        assert!(result.valid);
        assert_eq!(result.timestamp, 1700000000000.0);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn invalid_journal() {
        let tmp = std::env::temp_dir().join("codegraph_journal_invalid");
        let dir = tmp.join(".codegraph");
        let journal_dir = dir.to_str().unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("changes.journal"), "garbage\n").unwrap();

        let result = read_journal(journal_dir);
        assert!(!result.valid);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_journal() {
        let result = read_journal("/nonexistent/path");
        assert!(!result.valid);
    }
}
