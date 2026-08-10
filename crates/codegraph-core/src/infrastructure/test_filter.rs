//! Canonical test/fixture path detection — mirrors
//! `src/infrastructure/test-filter.ts`. See that file's doc comment for the
//! full rationale (#2256); summarized here:
//!
//! `TEST_FILE_LIKE_PATTERNS` is the single source of truth for "does this
//! path look like test/fixture infrastructure" behind every `-T`-style
//! filter in this engine. `test_file_filter_col` (consumed by
//! `graph/classifiers/roles.rs` and `db/repository/graph_read.rs`) turns
//! these into `NOT LIKE` clauses; `is_test_file` re-implements the same
//! intent as a boolean check for query paths that filter in Rust memory
//! rather than in SQL.
//!
//! A literal `_` in a pattern means a literal underscore — `_` is SQL
//! LIKE's own single-character wildcard, so `escape_like_underscores` escapes
//! it before use (SQLite's LIKE is case-insensitive for ASCII by default).
//! Path segments are bounded by `/` (or path start/end) so a segment name
//! only matches a WHOLE directory component — `tests/`/`test/` never matches
//! `contests/`, `latest/`, or a production `test-utils/` directory.
//!
//! The Java `TestFoo.java` / `FooTest.java` filename convention is
//! deliberately excluded from `TEST_FILE_LIKE_PATTERNS` — SQLite's LIKE is
//! case-insensitive, so a substring-based approximation would also match
//! ordinary words merely containing "test" (`Latest.java`, `Contest.java`,
//! `Testament.java`). `is_test_file` below still recognizes the Java
//! convention precisely (case-sensitive, camelCase-boundary-aware) since it
//! isn't constrained to LIKE syntax; the standard Maven/Gradle
//! `src/test/java/` directory layout is covered by the `test` path segment
//! either way.

/// SQL LIKE templates (`%` = any run of characters). Keep in lockstep with
/// TS `TEST_FILE_LIKE_PATTERNS` (`src/infrastructure/test-filter.ts`).
pub const TEST_FILE_LIKE_PATTERNS: &[&str] = &[
    // Filename substring markers.
    "%.test.%",
    "%.spec.%",
    "%__test__%",
    "%__tests__%",
    "%.stories.%",
    // Test/fixture directory segments (#2256).
    "%/tests/%",
    "tests/%",
    "%/test/%",
    "test/%",
    "%/fixtures/%",
    "fixtures/%",
    "%/__fixtures__/%",
    "__fixtures__/%",
    // Go: foo_test.go (#2256 follow-up).
    "%_test.go",
    // Python: test_foo.py / foo_test.py (#2256 follow-up).
    "%/test_%.py",
    "test_%.py",
    "%_test.py",
];

/// Escape LIKE's `_` single-character wildcard so it matches a literal underscore.
pub fn escape_like_underscores(pattern: &str) -> String {
    pattern.replace('_', "\\_")
}

/// Build a `NOT LIKE ... ESCAPE '\'` filter clause for `column` from
/// `TEST_FILE_LIKE_PATTERNS`. Mirrors TS `testFilterSQL`
/// (`src/db/query-builder.ts`).
pub fn test_file_filter_col(column: &str) -> String {
    TEST_FILE_LIKE_PATTERNS
        .iter()
        .map(|p| {
            format!(
                "AND {column} NOT LIKE '{}' ESCAPE '\\'",
                escape_like_underscores(p)
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

const FILENAME_SUBSTRING_MARKERS: &[&str] =
    &[".test.", ".spec.", "__test__", "__tests__", ".stories."];

const TEST_PATH_SEGMENTS: &[&str] = &["tests", "test", "fixtures", "__fixtures__"];

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Go: `foo_test.go` (#2256 follow-up). `path` must already be lowercased —
/// matched case-insensitively for parity with SQLite's case-insensitive
/// `LIKE` (Greptile review, #2256): a mixed-case path like `pkg/foo_TEST.go`
/// must be excluded consistently whether evaluated via `test_file_filter_col`
/// or `is_test_file`.
fn is_go_test_filename(lower_path: &str) -> bool {
    lower_path.ends_with("_test.go")
}

/// Python: `test_foo.py` (prefix, checked on the basename) or `foo_test.py`
/// (suffix, checked on the whole path) (#2256 follow-up). `lower_path` must
/// already be lowercased — see `is_go_test_filename`'s doc comment.
fn is_python_test_filename(lower_path: &str) -> bool {
    let base = basename(lower_path);
    if base.starts_with("test_") && base.ends_with(".py") {
        return true;
    }
    lower_path.ends_with("_test.py")
}

/// Java: `TestFoo.java` (prefix, camelCase-boundary-aware) or `FooTest.java`
/// (suffix) — case-sensitive by design: real Java test classes are always
/// capitalized this way, which is what avoids matching `Testament.java`/
/// `Latest.java`/`Contest.java`/`Protest.java` (#2256 follow-up).
fn is_java_test_filename(path: &str) -> bool {
    let base = basename(path);
    if base.starts_with("Test") && base.ends_with(".java") {
        if let Some(next) = base[4..].chars().next() {
            if next.is_ascii_uppercase() {
                return true;
            }
        }
    }
    if let Some(prefix) = path.strip_suffix("Test.java") {
        if let Some(prev) = prefix.chars().last() {
            if prev.is_ascii_lowercase() || prev.is_ascii_digit() {
                return true;
            }
        }
    }
    false
}

/// Check whether a file path looks like a test file. Mirrors TS `isTestFile`
/// (`src/infrastructure/test-filter.ts`). Every check except the Java
/// filename convention is case-insensitive, for parity with SQLite's
/// case-insensitive `LIKE` (Greptile review, #2256) — the Java check stays
/// case-sensitive on the original `path`, matching TS and this module's own
/// top-of-file doc comment on why it's deliberately excluded from
/// `TEST_FILE_LIKE_PATTERNS`.
pub fn is_test_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    if FILENAME_SUBSTRING_MARKERS.iter().any(|m| lower.contains(m)) {
        return true;
    }
    if lower
        .split('/')
        .any(|seg| TEST_PATH_SEGMENTS.contains(&seg))
    {
        return true;
    }
    if is_go_test_filename(&lower) || is_python_test_filename(&lower) {
        return true;
    }
    is_java_test_filename(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOULD_MATCH: &[&str] = &[
        "src/foo.test.ts",
        "src/foo.spec.ts",
        "src/__tests__/foo.ts",
        "src/__test__/foo.ts",
        "src/foo.stories.tsx",
        "tests/foo.ts",
        "src/tests/foo.ts",
        "test/foo.go",
        "src/test/foo.java",
        "fixtures/foo.json",
        "src/__fixtures__/foo.json",
        "pkg/foo_test.go",
        "test_foo.py",
        "src/test_foo.py",
        "foo_test.py",
        "src/TestFoo.java",
        "src/FooTest.java",
    ];

    const SHOULD_NOT_MATCH: &[&str] = &[
        "src/contests/foo.ts",
        "src/latest/foo.ts",
        "src/test-utils/foo.ts",
        "src/protest.py",
        "src/latest.py",
        "src/Testament.java",
        "src/Contest.java",
        "src/Latest.java",
        "src/Protest.java",
    ];

    // Mixed-case variants of the filename/segment/Go/Python markers — must
    // match, for parity with SQLite's case-insensitive LIKE (#2256).
    const MIXED_CASE_MATCH: &[&str] = &[
        "src/foo.TEST.ts",
        "src/Tests/foo.ts",
        "src/TEST/foo.go",
        "pkg/foo_TEST.go",
        "TEST_foo.py",
        "src/FOO_TEST.py",
    ];

    #[test]
    fn matches_expected_test_paths() {
        for path in SHOULD_MATCH {
            assert!(is_test_file(path), "expected {path} to be a test file");
        }
    }

    #[test]
    fn matches_mixed_case_variants() {
        for path in MIXED_CASE_MATCH {
            assert!(is_test_file(path), "expected {path} to be a test file");
        }
    }

    #[test]
    fn does_not_match_ordinary_paths_containing_test_as_a_substring() {
        for path in SHOULD_NOT_MATCH {
            assert!(!is_test_file(path), "expected {path} to NOT be a test file");
        }
    }
}
