/**
 * Regression test for #2078: the incremental single-file rebuild path
 * (`rebuildFile`/`applyChaDispatchPostPass` in
 * `src/domain/graph/builder/incremental.ts`) only re-evaluated CHA/RTA
 * dispatch call sites in the rebuilt file plus its reverse-dep cascade
 * (`findReverseDeps` — files that already hold an edge to the rebuilt
 * file's OLD nodes).
 *
 * That misses a caller that dispatches through an *interface type*, not a
 * direct reference: such a caller has no edge to a brand-new implementor
 * added elsewhere in the same rebuild, so it is never revisited and the
 * caller -> new-implementor dispatch edge is silently missing until a full
 * rebuild runs.
 *
 * Reuses the `tests/fixtures/cha-dispatch` fixture (`Dispatcher.ts` already
 * dispatches `IWorker.doWork()` to `ConcreteWorker`/`MockWorker` via CHA).
 * This test adds a brand-new `NewWorker.ts` implementing `IWorker` — which
 * `Dispatcher.ts` never imports — via the exact `rebuildFile` function
 * `codegraph watch` calls per file-change event, and asserts `Dispatcher.ts`
 * gains a `dispatch -> NewWorker.doWork` edge despite never being re-parsed
 * by this rebuild.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNodeId as getNodeIdQuery, initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

const CHA_FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'cha-dispatch');

const NEW_WORKER_SOURCE = `import type { IWorker } from './IWorker.js';

export class NewWorker implements IWorker {
  doWork(): string {
    return 'new';
  }
}

// Self-contained RTA instantiation evidence — CHA/RTA only expands dispatch
// to implementors that are provably instantiated somewhere in the graph.
export function makeNewWorker(): NewWorker {
  return new NewWorker();
}
`;

// Square extends AbstractShape, which `implements IShape` (not `extends`) —
// Square's own direct heritage name is only "AbstractShape". A caller
// dispatching via the ancestral "IShape" interface directly (ShapeRunner.ts,
// via the pre-existing Circle) shares no immediate parent with Square, so
// finding it requires walking upward from "AbstractShape" to "IShape" and
// back down through every transitively reachable implementor — not just
// AbstractShape's direct children.
const NEW_SQUARE_SOURCE = `import { AbstractShape } from './AbstractShape.js';

export class Square extends AbstractShape {
  render(): string {
    return 'square';
  }
}

export function makeSquare(): Square {
  return new Square();
}
`;

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

interface CallEdgeRow {
  src: string;
  srcFile: string;
  tgt: string;
  tgtFile: string;
  technique: string | null;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.file AS srcFile, n2.name AS tgt, n2.file AS tgtFile, e.technique
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.file, n1.name, n2.file, n2.name`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

/** Build the prepared statements object that watcher.ts normally provides. */
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

async function rebuildOneFile(dir: string, relFile: string, engine: EngineMode): Promise<void> {
  const dbPath = path.join(dir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  try {
    initSchema(db);
    const stmts = makeStmts(db);
    await rebuildFile(db, dir, path.join(dir, relFile), stmts, { engine } as never, null);
  } finally {
    db.close();
  }
}

function runSiblingCallerScenario(engine: EngineMode): void {
  describe(`codegraph watch (rebuildFile): CHA post-pass revisits sibling callers on new implementor (#2078) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2078-cha-sibling-${engine}-`));
      copyDirSync(CHA_FIXTURE_DIR, tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });

      // Sanity precondition: Dispatcher.ts's existing baseline CHA dispatch
      // targets are present before the incremental add below.
      const before = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
      const hasConcrete = before.some(
        (e) => e.src === 'dispatch' && e.tgt === 'ConcreteWorker.doWork',
      );
      if (!hasConcrete) {
        throw new Error('fixture precondition failed: dispatch -> ConcreteWorker.doWork missing');
      }

      // Add a brand-new file implementing IWorker — Dispatcher.ts never
      // imports it, so it can only be reached via a direct edge or the
      // findChaSiblingCallerFiles path (#2078), never via findReverseDeps.
      fs.writeFileSync(path.join(tmpDir, 'NewWorker.ts'), NEW_WORKER_SOURCE);
      await rebuildOneFile(tmpDir, 'NewWorker.ts', engine);
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function edges(): CallEdgeRow[] {
      return readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    }

    it('revisits Dispatcher.ts and adds dispatch -> NewWorker.doWork despite no direct import', () => {
      const all = edges();
      const found = all.find(
        (e) => e.src === 'dispatch' && e.tgt === 'NewWorker.doWork' && e.tgtFile === 'NewWorker.ts',
      );
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(found?.technique).toBe('cha');
    });

    it('keeps the pre-existing dispatch -> ConcreteWorker.doWork edge intact', () => {
      const found = edges().find((e) => e.src === 'dispatch' && e.tgt === 'ConcreteWorker.doWork');
      expect(found).toBeDefined();
    });

    it('keeps the pre-existing dispatch -> MockWorker.doWork edge intact', () => {
      const found = edges().find((e) => e.src === 'dispatch' && e.tgt === 'MockWorker.doWork');
      expect(found).toBeDefined();
    });

    it('does not fabricate an edge to the never-instantiated GhostWorker', () => {
      const found = edges().find((e) => e.src === 'dispatch' && e.tgt === 'GhostWorker.doWork');
      expect(found).toBeUndefined();
    });

    it('adds no duplicate dispatch -> NewWorker.doWork edge on a second no-op rebuild', async () => {
      const beforeCount = edges().filter(
        (e) => e.src === 'dispatch' && e.tgt === 'NewWorker.doWork',
      ).length;
      await rebuildOneFile(tmpDir, 'NewWorker.ts', engine);
      const afterCount = edges().filter(
        (e) => e.src === 'dispatch' && e.tgt === 'NewWorker.doWork',
      ).length;
      expect(afterCount).toBe(beforeCount);
      expect(afterCount).toBe(1);
    });
  });
}

runSiblingCallerScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runSiblingCallerScenario('native');
});

function runTransitiveAncestryScenario(engine: EngineMode): void {
  describe(`codegraph watch (rebuildFile): CHA post-pass walks transitive interface ancestry (#2078) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2078-cha-transitive-${engine}-`));
      copyDirSync(CHA_FIXTURE_DIR, tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });

      // Sanity precondition: ShapeRunner.ts dispatches via the top-level
      // IShape interface to Circle (a direct implementor, unrelated to
      // AbstractShape) before the incremental add below.
      const before = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
      const hasCircle = before.some((e) => e.src === 'process' && e.tgt === 'Circle.render');
      if (!hasCircle) {
        throw new Error('fixture precondition failed: process -> Circle.render missing');
      }

      // Add Square, extending AbstractShape (which `implements IShape`, not
      // `extends`) — Square's own direct heritage is only "AbstractShape",
      // which shares no immediate parent with Circle. Finding ShapeRunner.ts
      // requires walking UP from "AbstractShape" to the ancestral "IShape",
      // then back DOWN through every transitively reachable implementor
      // (reaching Circle) to find its existing dispatch edge.
      fs.writeFileSync(path.join(tmpDir, 'Square.ts'), NEW_SQUARE_SOURCE);
      await rebuildOneFile(tmpDir, 'Square.ts', engine);
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function edges(): CallEdgeRow[] {
      return readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    }

    it('revisits ShapeRunner.ts and adds process -> Square.render via the ancestral interface', () => {
      const all = edges();
      const found = all.find(
        (e) => e.src === 'process' && e.tgt === 'Square.render' && e.tgtFile === 'Square.ts',
      );
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(found?.technique).toBe('cha');
    });

    it('keeps the pre-existing process -> Circle.render edge intact', () => {
      const found = edges().find((e) => e.src === 'process' && e.tgt === 'Circle.render');
      expect(found).toBeDefined();
    });
  });
}

runTransitiveAncestryScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runTransitiveAncestryScenario('native');
});
