/**
 * Regression test for #2079: the incremental single-file rebuild path
 * (`buildCallEdges`/`emitIncrementalCallEdges`/`emitIncrementalPtsNoReceiverEdges`
 * in `src/domain/graph/builder/incremental.ts`) used to share `seenCallEdges`
 * between points-to-resolved edges and direct-call edges. If a points-to
 * edge claimed a `(caller, target)` pair first (e.g. `const alias = handler;
 * alias(x)`), a later direct call to the same target in the same file
 * (`handler(y)`) was silently skipped instead of upgrading the row to the
 * higher direct-call confidence/technique — leaving a lower-confidence
 * `points-to` edge where a full rebuild of the identical source would
 * produce the direct-resolution edge instead.
 *
 * The full-build path (`stages/build-edges.ts`) already gets this right via
 * its own `ptsEdgeRows` map; this test proves the incremental path now
 * matches it exactly.
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

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'handler.js'),
    'export function handler(x) {\n  return x * 2;\n}\n',
  );
  // The alias call (pts-resolved) appears BEFORE the direct call to the same
  // target in source order, so buildCallEdges's per-call loop processes the
  // pts-resolved edge first — exactly the ordering #2079 depends on.
  fs.writeFileSync(
    path.join(dir, 'consumer.js'),
    [
      "import { handler } from './handler.js';",
      '',
      'export function processItems(items) {',
      '  const alias = handler;',
      '  alias(items[0]);',
      '  return handler(items[1]);',
      '}',
      '',
    ].join('\n'),
  );
}

interface CallEdgeRow {
  src: string;
  tgt: string;
  confidence: number;
  technique: string | null;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, e.confidence, e.technique
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
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

function runScenario(engine: EngineMode): void {
  describe(`codegraph watch (rebuildFile): pts edge upgrades to direct confidence (#2079) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2079-pts-upgrade-${engine}-`));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
      // Re-run the exact same source through the incremental single-file
      // rebuild path (mirrors what codegraph watch calls on a save event) so
      // the pts-then-direct ordering inside one buildCallEdges call is
      // exercised the same way a full build already exercises it.
      await rebuildOneFile(tmpDir, 'consumer.js', engine);
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function edges(): CallEdgeRow[] {
      return readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    }

    it('upgrades the pts-resolved edge to direct-call confidence and technique', () => {
      const all = edges();
      const callsToHandler = all.filter((e) => e.src === 'processItems' && e.tgt === 'handler');
      expect(callsToHandler, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toHaveLength(1);
      expect(callsToHandler[0].technique).toBe('ts-native');
      expect(callsToHandler[0].confidence).toBe(1.0);
    });

    it('matches a full rebuild of the identical source state', async () => {
      const refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2079-pts-upgrade-ref-${engine}-`));
      try {
        writeFixture(refDir);
        await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
        const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db')).filter(
          (e) => e.src === 'processItems',
        );
        const incremental = edges().filter((e) => e.src === 'processItems');
        expect(incremental).toEqual(reference);
      } finally {
        fs.rmSync(refDir, { recursive: true, force: true });
      }
    });
  });
}

runScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
