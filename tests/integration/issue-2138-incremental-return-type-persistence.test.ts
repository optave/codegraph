/**
 * Regression test for #2138: an incremental `codegraph build` triggered by
 * editing a file with NO relationship to a getter/class dispatch pair
 * permanently lost the `calls`/`receiver` edges for that dispatch.
 *
 * Root cause (see issue for the full trace): Stage 6b's barrel-candidate
 * re-parse re-parses any file the changed file imports from, if that file
 * has its own re-export (making it "barrel-like" in the DB's eyes) —
 * regardless of whether the changed file's edit has anything to do with
 * that file's own logic. Re-parsing wipes the barrel-like file's outgoing
 * `calls`/`receiver` edges and re-derives them from an in-memory
 * cross-file return-type index scoped only to *this build's* file set. A
 * factory/getter defined in a file that wasn't re-parsed this build (like
 * `producer.js`'s `getPool()` below) silently drops out of that index, so
 * the dispatch edges it fed are lost — and stay lost, since reverting the
 * triggering edit re-triggers the same re-parse/re-derive cycle.
 *
 * The fix persists per-file return-type evidence into a durable
 * `return_types` table (both engines) whenever a file is parsed, so a later
 * build's cross-file return-type propagation has a whole-graph view of
 * files it doesn't itself re-parse.
 *
 * Fixture:
 *   producer.js       — defines `Pool` (class, `doWork()` method) and the
 *                        factory `getPool()` returning a `Pool` instance.
 *                        Never touched after the initial build.
 *   reexport-target.js — trivial file `caller.js` re-exports from, so
 *                        caller.js has its own outgoing `reexports` edge
 *                        and is classified barrel-like.
 *   caller.js         — imports `getPool` from producer.js and calls
 *                        `getPool().doWork()`; also re-exports from
 *                        reexport-target.js. This is the file whose
 *                        `calls`/`receiver` edges get wiped and re-derived.
 *   trigger.js        — imports something from caller.js (making caller.js
 *                        a Stage-6b barrel-reparse candidate) but is
 *                        otherwise unrelated to producer.js/Pool. This is
 *                        the file actually edited between builds.
 *
 * Parametrized on engine to exercise both population paths: the JS
 * pipeline (`persistReturnTypes` in build-edges.ts) and the native
 * orchestrator (`import_edges::persist_return_types` in Rust).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNodeId as getNodeIdQuery, initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FILES: Record<string, string> = {
  'producer.js': `
export class Pool {
  doWork() { return 1; }
}

export function getPool() {
  return new Pool();
}
`,
  'reexport-target.js': `
export const reexported = 1;
`,
  // Two own definitions (run, extra) vs. one reexport — deliberately kept
  // above parity so caller.js is classified "hybrid" (barrel-like enough to
  // be pulled into Stage 6b's reparse via its own reexports edge, but NOT
  // "barrel-only") and its own calls/receiver edges are still emitted. At
  // reexports == ownDefs parity, the barrel-only heuristic (reexports >=
  // ownDefs) misclassifies it and strips its outgoing edges entirely,
  // independent of this issue's fix — a real edge case, but not this one.
  'caller.js': `
export { reexported } from './reexport-target.js';
import { getPool } from './producer.js';

export function run() {
  const pool = getPool();
  return pool.doWork();
}

export function extra() {
  return 2;
}
`,
  'trigger.js': `
import { run } from './caller.js';

export function callRun() {
  return run();
}
`,
};

function writeFixture(dir: string) {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function readEdges(dbPath: string, kind: 'calls' | 'receiver') {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.file AS src_file, n2.name AS tgt, n2.file AS tgt_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = ?
         ORDER BY n1.name, n2.name`,
      )
      .all(kind) as Array<{ src: string; src_file: string; tgt: string; tgt_file: string }>;
  } finally {
    db.close();
  }
}

function readReturnTypes(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT file, fn_name, type_name FROM return_types ORDER BY file, fn_name')
      .all() as Array<{ file: string; fn_name: string; type_name: string }>;
  } finally {
    db.close();
  }
}

function makeStmts(db: ReturnType<typeof openDb>) {
  return {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line, accessor_kind) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    getNodeId: {
      get: (name: string, kind: string, file: string, line: number) => {
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    insertEdge: db.prepare(
      'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdges: db.prepare(
      'SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    findNodeInFile: db.prepare(
      "SELECT id, kind, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file, kind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
    upsertFileHash: db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    ),
    deleteFileHash: db.prepare('DELETE FROM file_hashes WHERE file = ?'),
  };
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'codegraph build scoped-incremental rebuild keeps cross-file dispatch to an untouched factory (#2138) — engine: %s',
  (engine) => {
    let buildDir: string;
    let dbPath: string;

    beforeAll(async () => {
      buildDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2138-${engine}-`));
      writeFixture(buildDir);
      dbPath = path.join(buildDir, '.codegraph', 'graph.db');

      // Initial build establishes file_hashes so the second build below is a
      // genuinely scoped incremental rebuild, not another full one.
      await buildGraph(buildDir, { incremental: true, skipRegistry: true, engine });
      expect(readEdges(dbPath, 'calls').find((e) => e.tgt === 'Pool.doWork')).toBeDefined();
      expect(readEdges(dbPath, 'receiver').find((e) => e.tgt === 'Pool')).toBeDefined();

      // Touch ONLY trigger.js — completely unrelated to producer.js/Pool.
      // caller.js and producer.js are both untouched.
      fs.appendFileSync(path.join(buildDir, 'trigger.js'), '\n// touch\n');
      await buildGraph(buildDir, { incremental: true, skipRegistry: true, engine });
    }, 60_000);

    afterAll(() => {
      try {
        if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('the calls -> Pool.doWork edge survives the unrelated-file incremental rebuild', () => {
      const edges = readEdges(dbPath, 'calls');
      const edge = edges.find((e) => e.tgt === 'Pool.doWork');
      expect(
        edge,
        `Expected a calls edge to doWork after touching only trigger.js\nActual calls edges:\n${JSON.stringify(edges, null, 2)}`,
      ).toBeDefined();
    });

    it('the receiver -> Pool edge survives the unrelated-file incremental rebuild', () => {
      const edges = readEdges(dbPath, 'receiver');
      const edge = edges.find((e) => e.tgt === 'Pool');
      expect(
        edge,
        `Expected a receiver edge to Pool after touching only trigger.js\nActual receiver edges:\n${JSON.stringify(edges, null, 2)}`,
      ).toBeDefined();
    });
  },
);

/**
 * Regression guard for a gap found in review: `codegraph watch`'s
 * single-file rebuild (`rebuildFile`/`buildCallEdges` in incremental.ts)
 * purges a rebuilt file's `return_types` row via `purgeFileData` (issue
 * #2138's own purge-statement addition) but, before this fix, never wrote
 * it back — permanently erasing that file's return-type evidence the first
 * time it was touched via watch mode. A later scoped `codegraph build`
 * incremental rebuild (this issue's actual fix) would then find no
 * evidence at all for that file, worse than the pre-fix state where the
 * table didn't exist. `persistReturnTypesForFile` closes this by
 * restoring the row immediately after the purge, every time.
 */
describe('codegraph watch restores return_types after purging it (#2138 review)', () => {
  let watchDir: string;
  let dbPath: string;

  beforeAll(async () => {
    watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2138-watch-'));
    writeFixture(watchDir);
    dbPath = path.join(watchDir, '.codegraph', 'graph.db');

    await buildGraph(watchDir, { incremental: false, skipRegistry: true, engine: 'wasm' });
    expect(readReturnTypes(dbPath)).toContainEqual({
      file: 'producer.js',
      fn_name: 'getPool',
      type_name: 'Pool',
    });

    // Rebuild producer.js itself via codegraph watch's single-file path —
    // this purges (and, with the fix, restores) its own return_types row.
    const producerFile = path.join(watchDir, 'producer.js');
    fs.appendFileSync(producerFile, '\n// touch\n');
    const db = openDb(dbPath);
    initSchema(db);
    await rebuildFile(db, watchDir, producerFile, makeStmts(db), { engine: 'wasm' }, null);
    db.close();
  }, 60_000);

  afterAll(() => {
    try {
      if (watchDir) fs.rmSync(watchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("producer.js's return_types row survives its own watch-mode rebuild", () => {
    expect(readReturnTypes(dbPath)).toContainEqual({
      file: 'producer.js',
      fn_name: 'getPool',
      type_name: 'Pool',
    });
  });

  it('a later scoped incremental build can still resolve dispatch through producer.js', async () => {
    // Touch ONLY trigger.js, exactly like the main describe block above —
    // proves the watch-rebuilt row is not just present but actually usable
    // by the main build pipeline's cross-file propagation.
    fs.appendFileSync(path.join(watchDir, 'trigger.js'), '\n// touch\n');
    await buildGraph(watchDir, { incremental: true, skipRegistry: true, engine: 'wasm' });

    const edges = readEdges(dbPath, 'calls');
    expect(edges.find((e) => e.tgt === 'Pool.doWork')).toBeDefined();
    expect(readEdges(dbPath, 'receiver').find((e) => e.tgt === 'Pool')).toBeDefined();
  });
});
