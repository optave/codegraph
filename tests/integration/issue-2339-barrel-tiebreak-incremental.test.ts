/**
 * Regression for #2339: `detect_barrel_only_files` / `isBarrelFile` used
 * `reexports >= ownDefs` to decide whether a file is a pure barrel. A file
 * with exactly one reexport and exactly one own definition hit that `>=`
 * and got misclassified as barrel-only — even though it's a genuine hybrid
 * (real logic plus a reexport), not a pure barrel. Once misclassified,
 * `build_and_insert_call_edges` (and its JS equivalent) skip emitting ANY
 * of that file's own outgoing call edges, so on any incremental build where
 * the file gets pulled into Stage 6b's barrel-candidate reparse (because
 * something imports the reexported symbol from it), its own call edges are
 * silently dropped and never re-emitted — even on an otherwise-correct
 * build.
 *
 * Fixture shape:
 *
 *   app.js
 *     └─ imports `doWork` from hybrid.js
 *
 *   hybrid.js  (exact tie: 1 reexport + 1 own def)
 *     ├─ `export { Named } from './other.js'`
 *     └─ `doWork()` calls `helperFn` from helper.js
 *
 *   other.js   (defines the reexported symbol)
 *   helper.js  (defines the function hybrid.js's own def calls)
 *
 * Before the fix, editing app.js triggered a reparse of hybrid.js (it has
 * one reexport edge in the DB, so the orchestrator flags it as a barrel
 * candidate every incremental build), and the `>=` tie caused it to be
 * (re)classified barrel-only, dropping the doWork -> helperFn call edge.
 * Mirrors tests/integration/issue-1174-chained-barrel-incremental.test.ts's
 * structure (that fixture's hybrid file has 1 reexport vs. 4 defs, so it
 * never exercised this exact tie).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'issue-2339-barrel-tiebreak');

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

interface EdgeRow {
  source_file: string;
  source_name: string;
  target_file: string;
  target_name: string;
  kind: string;
}

function readEdges(dbPath: string): EdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.file AS source_file, n1.name AS source_name,
                n2.file AS target_file, n2.name AS target_name, e.kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         ORDER BY n1.file, n1.name, n2.file, n2.name, e.kind`,
      )
      .all() as EdgeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('Issue #2339 barrel reexports==ownDefs tie-break parity (%s)', (engine) => {
  let fullEdges: EdgeRow[];
  let incrEdges: EdgeRow[];
  let tmpBase: string;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-2339-${engine}-`));
    const fullDir = path.join(tmpBase, 'full');
    const incrDir = path.join(tmpBase, 'incr');
    copyDirSync(FIXTURE_DIR, fullDir);
    copyDirSync(FIXTURE_DIR, incrDir);

    // Establish baseline on the incremental copy
    await buildGraph(incrDir, { incremental: false, skipRegistry: true, engine });

    // Mutate app.js (the only "changed" file) on both copies
    const mutate = (dir: string) => {
      fs.appendFileSync(path.join(dir, 'app.js'), '\n// touch\n');
    };
    mutate(fullDir);
    mutate(incrDir);

    // Full build on the full copy
    await buildGraph(fullDir, { incremental: false, skipRegistry: true, engine });
    // Incremental rebuild on the incr copy
    await buildGraph(incrDir, { incremental: true, skipRegistry: true, engine });

    fullEdges = readEdges(path.join(fullDir, '.codegraph', 'graph.db'));
    incrEdges = readEdges(path.join(incrDir, '.codegraph', 'graph.db'));
  }, 90_000);

  afterAll(() => {
    if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('emits the doWork -> helperFn call edge on full build (hybrid.js is not barrel-only)', () => {
    const callEdge = fullEdges.filter(
      (e) =>
        e.source_file === 'hybrid.js' &&
        e.source_name === 'doWork' &&
        e.target_file === 'helper.js' &&
        e.target_name === 'helperFn' &&
        e.kind === 'calls',
    );
    expect(callEdge.length).toBeGreaterThan(0);
  });

  it('the doWork -> helperFn call edge survives the incremental rebuild', () => {
    const callEdge = incrEdges.filter(
      (e) =>
        e.source_file === 'hybrid.js' &&
        e.source_name === 'doWork' &&
        e.target_file === 'helper.js' &&
        e.target_name === 'helperFn' &&
        e.kind === 'calls',
    );
    expect(callEdge.length).toBeGreaterThan(0);
  });

  it('call edge count matches full rebuild', () => {
    const fullCalls = fullEdges.filter((e) => e.kind === 'calls');
    const incrCalls = incrEdges.filter((e) => e.kind === 'calls');
    expect(incrCalls.length).toBe(fullCalls.length);
  });
});
