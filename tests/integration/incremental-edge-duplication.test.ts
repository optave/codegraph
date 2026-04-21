/**
 * Regression test for #979: incremental rebuilds leak duplicate edges.
 *
 * Root cause: when `reparse_barrel_candidates` (Stage 6b, native engine) picks
 * up a file imported by a reverse-dep, it used to purge only the 'imports' and
 * 'reexports' edge kinds before Stage 7 re-emitted every edge kind, so every
 * rebuild appended new copies of 'calls', 'receiver', 'extends', 'implements',
 * 'imports-type', and 'dynamic-imports' edges.
 *
 * This test modifies a source file multiple times in a row and asserts:
 *   1. The total edge count does not grow across incremental rebuilds.
 *   2. The count of `(source_id, target_id, kind)` rows never exceeds the
 *      pre-existing duplicates from a fresh full build (i.e. incremental
 *      does not introduce new duplicates).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'issue-979-hybrid-barrel');

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function edgeStats(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const total = (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
    const duplicates = (
      db
        .prepare(
          `SELECT source_id, target_id, kind, COUNT(*) AS c FROM edges
           GROUP BY source_id, target_id, kind HAVING c > 1`,
        )
        .all() as Array<{ c: number }>
    ).reduce((sum, row) => sum + row.c - 1, 0);
    return { total, duplicates };
  } finally {
    db.close();
  }
}

describe('Issue #979: incremental edges do not duplicate', () => {
  it('3 incremental rebuilds produce stable edge counts with no new duplicates', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-979-'));
    const fullDir = path.join(tmpBase, 'full');
    const incrDir = path.join(tmpBase, 'incr');

    try {
      copyDirSync(FIXTURE_DIR, fullDir);
      copyDirSync(FIXTURE_DIR, incrDir);

      // Baseline full build on the incr copy so subsequent rebuilds are truly incremental.
      await buildGraph(incrDir, { incremental: false, skipRegistry: true });

      // Apply 3 rounds of "change one file" + incremental rebuild, recording
      // edge totals and duplicate counts after each rebuild.
      const history: Array<{ total: number; duplicates: number }> = [];
      for (let i = 0; i < 3; i++) {
        fs.appendFileSync(path.join(incrDir, 'consumers', 'driver.js'), `\n// bump ${i}\n`);
        await buildGraph(incrDir, { incremental: true, skipRegistry: true });
        history.push(edgeStats(path.join(incrDir, '.codegraph', 'graph.db')));
      }

      // Mirror all 3 mutations on the full copy, then do a single clean full build.
      for (let i = 0; i < 3; i++) {
        fs.appendFileSync(path.join(fullDir, 'consumers', 'driver.js'), `\n// bump ${i}\n`);
      }
      await buildGraph(fullDir, { incremental: false, skipRegistry: true });
      const freshFull = edgeStats(path.join(fullDir, '.codegraph', 'graph.db'));

      // Invariant 1: incremental edge count must not grow across rebuilds.
      expect(history[1].total).toBe(history[0].total);
      expect(history[2].total).toBe(history[0].total);

      // Invariant 2: incremental must not introduce new duplicates beyond the
      // pre-existing duplicates present in a clean full build.
      expect(history[2].duplicates).toBeLessThanOrEqual(freshFull.duplicates);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  }, 60_000);
});
