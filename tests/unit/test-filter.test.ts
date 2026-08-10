import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { testFilterSQL } from '../../src/db/query-builder.js';
import { isTestFile } from '../../src/infrastructure/test-filter.js';

/** Runs testFilterSQL's generated NOT LIKE clauses against a real SQLite connection. */
function sqlExcludes(file: string): boolean {
  const db = new Database(':memory:');
  try {
    const sql = testFilterSQL('f');
    const row = db.prepare(`SELECT (1 ${sql}) AS included FROM (SELECT ? AS f)`).get(file) as {
      included: number;
    };
    return row.included === 0;
  } finally {
    db.close();
  }
}

const SHOULD_MATCH: readonly string[] = [
  // Filename markers (pre-existing).
  'src/foo.test.ts',
  'src/foo.spec.ts',
  'src/__tests__/foo.ts',
  'src/__test__/foo.ts',
  'src/foo.stories.tsx',
  // Test/fixture directory segments (#2256).
  'tests/foo.ts',
  'src/tests/foo.ts',
  'test/foo.go',
  'src/test/foo.java',
  'fixtures/foo.json',
  'src/__fixtures__/foo.json',
  // Go/Python filename-suffix conventions (#2256 follow-up).
  'pkg/foo_test.go',
  'test_foo.py',
  'src/test_foo.py',
  'foo_test.py',
];

const SHOULD_NOT_MATCH: readonly string[] = [
  // Path segments that merely contain "test" as a substring, not as a whole segment.
  'src/contests/foo.ts',
  'src/latest/foo.ts',
  'src/test-utils/foo.ts',
  // Filenames that merely contain "test" as a substring, not the Go/Python suffix convention.
  'src/protest.py',
  'src/latest.py',
];

// Mixed-case variants of the filename/segment/Go/Python markers — must match
// consistently with sqlExcludes, since SQLite's LIKE is case-insensitive
// (Greptile review, #2256).
const MIXED_CASE_MATCH: readonly string[] = [
  'src/foo.TEST.ts',
  'src/Tests/foo.ts',
  'src/TEST/foo.go',
  'pkg/foo_TEST.go',
  'TEST_foo.py',
  'src/FOO_TEST.py',
];

// Recognized only by isTestFile's precise, case-sensitive regex — deliberately
// excluded from the SQL LIKE list because SQLite's LIKE is case-insensitive,
// so a substring approximation would also match ordinary words like
// "Latest.java"/"Contest.java"/"Testament.java" (see test-filter.ts's doc comment).
const JAVA_FILENAME_MATCH: readonly string[] = ['src/TestFoo.java', 'src/FooTest.java'];
const JAVA_FILENAME_NON_MATCH: readonly string[] = [
  'src/Testament.java',
  'src/Contest.java',
  'src/Latest.java',
  'src/Protest.java',
];

describe('isTestFile', () => {
  it.each(SHOULD_MATCH)('matches %s', (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  it.each(SHOULD_NOT_MATCH)('does not match %s', (file) => {
    expect(isTestFile(file)).toBe(false);
  });

  it.each(MIXED_CASE_MATCH)('matches the mixed-case variant %s', (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  it.each(JAVA_FILENAME_MATCH)('recognizes the Java test-class filename convention: %s', (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  it.each(JAVA_FILENAME_NON_MATCH)(
    'does not treat an ordinary word containing "test" as a Java test class: %s',
    (file) => {
      expect(isTestFile(file)).toBe(false);
    },
  );
});

describe('isTestFile / testFilterSQL parity', () => {
  it.each([...SHOULD_MATCH, ...SHOULD_NOT_MATCH, ...MIXED_CASE_MATCH])(
    'agrees with the SQL filter for %s',
    (file) => {
      expect(sqlExcludes(file)).toBe(isTestFile(file));
    },
  );

  it.each(MIXED_CASE_MATCH)('both filters exclude the mixed-case variant %s', (file) => {
    expect(sqlExcludes(file)).toBe(true);
    expect(isTestFile(file)).toBe(true);
  });

  it('SQL filter does not attempt the Java filename convention (documented asymmetry)', () => {
    for (const file of JAVA_FILENAME_MATCH) {
      expect(sqlExcludes(file)).toBe(false);
      expect(isTestFile(file)).toBe(true);
    }
  });
});
