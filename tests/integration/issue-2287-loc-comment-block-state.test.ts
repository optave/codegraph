/**
 * Integration test for #2287: LOC comment-line detection misclassified a
 * code line starting with a comment-prefix character as a comment.
 *
 * `computeLOCMetrics()` (TS) and the LOC-counting logic in
 * `compute_all_metrics()` (native, `crates/codegraph-core/src/ast_analysis/complexity.rs`)
 * classified a line as a comment purely by checking whether the trimmed
 * line text starts with any of a language's comment prefixes. For any
 * language whose comment prefixes included a bare `*` (needed to match
 * Javadoc-style continuation lines), this also matched any line that
 * merely happens to start with `*` after trimming — most notably a
 * pointer-dereference assignment (`*ptr = 5;`), which Rust, C, C#, and Go
 * all allow as a statement.
 *
 * The fix tracks Javadoc-style block-comment state across lines instead of
 * trusting a bare opening/continuation/closing marker unconditionally: a
 * line is only a block-comment continuation while a genuine block-opening
 * line has been seen and the block hasn't closed yet. Mirrored identically
 * in both engines.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  // The issue's own exact repro: a pointer-dereference-heavy function with
  // no real comments at all.
  'deref.rs': `
fn deref_heavy(ptr: *mut i32) -> i32 {
    unsafe {
        *ptr = 5;
        *ptr = *ptr + 1;
        return *ptr;
    }
}
`,
  // A genuine multi-line block comment inside a function body, to guard
  // against the fix over-correcting and losing #2058's own coverage.
  'documented.rs': `
fn documented() -> i32 {
    /**
     * Doc comment.
     * More doc.
     */
    1
}
`,
};

function locRow(
  dbPath: string,
  file: string,
  name: string,
): { loc: number; sloc: number; comment_lines: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT fc.loc AS loc, fc.sloc AS sloc, fc.comment_lines AS comment_lines
         FROM function_complexity fc
         JOIN nodes n ON n.id = fc.node_id
         WHERE n.file = ? AND n.name = ?`,
      )
      .get(file, name) as { loc: number; sloc: number; comment_lines: number } | undefined;
    expect(row, `no function_complexity row for ${file}:${name}`).toBeDefined();
    return row!;
  } finally {
    db.close();
  }
}

function runShared(getDbPath: () => string) {
  it('does not misclassify pointer-dereference assignments as comment continuation lines', () => {
    const row = locRow(getDbPath(), 'deref.rs', 'deref_heavy');
    expect(row.comment_lines).toBe(0);
    expect(row.sloc).toBe(row.loc);
  });

  it('still tracks a genuine multi-line block comment inside the function body', () => {
    const row = locRow(getDbPath(), 'documented.rs', 'documented');
    expect(row.comment_lines).toBe(4);
  });
}

describe('issue #2287: LOC comment-line block-comment-state tracking — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2287-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  runShared(() => path.join(tmpDir, '.codegraph', 'graph.db'));
});

describe.skipIf(!isNativeAvailable())(
  'issue #2287: LOC comment-line block-comment-state tracking — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2287-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    runShared(() => path.join(nativeTmpDir, '.codegraph', 'graph.db'));
  },
);
