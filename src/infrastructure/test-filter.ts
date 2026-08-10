/**
 * Canonical test/fixture path markers, expressed as SQL LIKE templates
 * (`%` = any run of characters; a literal `_` here means a literal
 * underscore — `escapeLikeUnderscores` below escapes it for LIKE, since `_`
 * is LIKE's own single-character wildcard). SQLite's LIKE is
 * case-insensitive for ASCII by default.
 *
 * This is the single source of truth for "does this path look like
 * test/fixture infrastructure" behind every `-T`-style filter —
 * `testFilterSQL` (`src/db/query-builder.ts`) turns these into `NOT LIKE`
 * clauses directly; `isTestFile` below re-implements the same intent as
 * boolean/regex checks (LIKE syntax isn't usable outside a query). The
 * mirrored Rust module (`crates/codegraph-core/src/infrastructure/test_filter.rs`)
 * keeps both forms in lockstep — see its own doc comment (#2256).
 *
 * Path segments are bounded by `/` (or path start/end) so a segment name
 * only matches a WHOLE directory component — `tests/`/`test/` never matches
 * `contests/`, `latest/`, or a production `test-utils/` directory.
 *
 * The Go/Python filename-suffix patterns are included here because their
 * real-world false-positive rate is negligible. The Java `TestFoo.java` /
 * `FooTest.java` convention is deliberately EXCLUDED from this LIKE list —
 * SQLite's LIKE is unconditionally case-insensitive, so a substring-based
 * approximation would also match ordinary words merely containing "test"
 * (`Latest.java`, `Contest.java`, `Protest.java`, `Testament.java`,
 * `Testimony.java`). `isTestFile`'s regex below still recognizes the Java
 * convention precisely (case-sensitive, camelCase-boundary-aware) since it
 * isn't constrained to LIKE syntax; the standard Maven/Gradle
 * `src/test/java/` directory layout is covered by the `test` path segment
 * either way.
 */
export const TEST_FILE_LIKE_PATTERNS: readonly string[] = [
  // Filename substring markers.
  '%.test.%',
  '%.spec.%',
  '%__test__%',
  '%__tests__%',
  '%.stories.%',
  // Test/fixture directory segments (#2256).
  '%/tests/%',
  'tests/%',
  '%/test/%',
  'test/%',
  '%/fixtures/%',
  'fixtures/%',
  '%/__fixtures__/%',
  '__fixtures__/%',
  // Go: foo_test.go (#2256 follow-up).
  '%_test.go',
  // Python: test_foo.py / foo_test.py (#2256 follow-up).
  '%/test_%.py',
  'test_%.py',
  '%_test.py',
];

/** Escape LIKE's `_` single-character wildcard so it matches a literal underscore. */
export function escapeLikeUnderscores(pattern: string): string {
  return pattern.replace(/_/g, '\\_');
}

const FILENAME_SUBSTRING_MARKERS: readonly string[] = [
  '.test.',
  '.spec.',
  '__test__',
  '__tests__',
  '.stories.',
];

const TEST_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'tests',
  'test',
  'fixtures',
  '__fixtures__',
]);

/**
 * Go/Python filename-suffix conventions — mirror the LIKE patterns above, so
 * matched case-insensitively (`i` flag) for parity with SQLite's
 * case-insensitive `LIKE` (Greptile review, #2256): a mixed-case path like
 * `pkg/foo_TEST.go` must be excluded consistently whether it's evaluated via
 * `testFilterSQL`/`NOT LIKE` or via `isTestFile`.
 */
const CASE_INSENSITIVE_LANGUAGE_PATTERNS: readonly RegExp[] = [
  /_test\.go$/i, // Go: foo_test.go
  /(?:^|\/)test_[^/]*\.py$/i, // Python: test_foo.py
  /_test\.py$/i, // Python: foo_test.py
];

/**
 * Java filename convention not covered by a directory segment or a simple
 * substring — camelCase-boundary-aware so `TestFoo`/`FooTest` match but
 * `Testament`/`Latest`/`Contest` don't (#2256 follow-up). Case-sensitive by
 * design (real Java test classes are always capitalized this way) and, unlike
 * the patterns above, deliberately NOT mirrored in `TEST_FILE_LIKE_PATTERNS`
 * — see this file's top doc comment for why a LIKE-based approximation can't
 * express this precisely.
 */
const JAVA_LANGUAGE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)Test[A-Z]\w*\.java$/, // Java: TestFoo.java
  /[a-z0-9]Test\.java$/, // Java: FooTest.java
];

/** Check whether a file path looks like a test file. */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (FILENAME_SUBSTRING_MARKERS.some((marker) => lower.includes(marker))) return true;
  if (lower.split('/').some((segment) => TEST_PATH_SEGMENTS.has(segment))) return true;
  if (CASE_INSENSITIVE_LANGUAGE_PATTERNS.some((pattern) => pattern.test(filePath))) return true;
  return JAVA_LANGUAGE_PATTERNS.some((pattern) => pattern.test(filePath));
}
