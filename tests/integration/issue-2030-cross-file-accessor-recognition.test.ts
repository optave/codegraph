/**
 * Regression test for #2030 (follow-up to #1893): a bare (non-call) property
 * read/write on an ES6 `get`/`set` class accessor never produced a `calls`
 * edge when the accessor's declaring class lives in a *different* file than
 * the read site — #1893 only covered the same-file case.
 *
 * Fixture mirrors the issue's own real-world repro:
 *   `SqliteRepository.db` read from `src/features/sequence.ts` after
 *   `instanceof SqliteRepository` narrowing (see `annotateDataflow` in
 *   src/features/sequence.ts). Verifies:
 *   - the cross-file getter-read edge appears in a full build, tagged with
 *     the correct `accessor_kind` on the target node
 *   - both engines (wasm/native) produce identical edges
 *   - full build and an incremental single-file rebuild agree
 *   - a same-file accessor (#1893) still resolves correctly alongside the
 *     cross-file one — no regression
 *   - a plain (non-accessor) cross-file method sharing the property name is
 *     never matched (false-positive guard)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  // The accessor's class lives in its own file...
  fs.writeFileSync(
    path.join(dir, 'sqlite-repository.ts'),
    `export class Repository {
  hasDataflowTable(): boolean {
    return false;
  }
}

export class SqliteRepository extends Repository {
  #db: unknown;

  constructor(db: unknown) {
    super();
    this.#db = db;
  }

  get db(): unknown {
    return this.#db;
  }
}

export class OtherRepo {
  // A plain (non-accessor) method sharing the property name "db" — must
  // never be matched by the cross-file accessor-read call below.
  db(): unknown {
    return null;
  }
}
`,
  );
  // ...and the bare property read happens in a completely different file,
  // after an \`instanceof\` narrowing check — mirroring the real repro in
  // src/features/sequence.ts's annotateDataflow.
  fs.writeFileSync(
    path.join(dir, 'sequence.ts'),
    `import { Repository, SqliteRepository } from './sqlite-repository.js';

export function annotateDataflow(repo: Repository): unknown {
  if (repo instanceof SqliteRepository) {
    return repo.db;
  }
  return null;
}
`,
  );
}

interface CallEdgeRow {
  src: string;
  srcKind: string;
  tgt: string;
  tgtKind: string;
  kind: string;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.kind AS srcKind, n2.name AS tgt, n2.kind AS tgtKind, e.kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name, n1.kind`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

function readAccessorKind(dbPath: string, name: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT accessor_kind FROM nodes WHERE name = ?`).get(name) as
      | { accessor_kind: string | null }
      | undefined;
    return row?.accessor_kind ?? null;
  } finally {
    db.close();
  }
}

function runScenario(engine: EngineMode): void {
  describe(`ES6 getter/setter cross-file property-read attribution (#2030) — ${engine}`, () => {
    let projDir: string;

    beforeAll(async () => {
      projDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2030-${engine}-`));
      writeFixture(projDir);
      await buildGraph(projDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(projDir, { recursive: true, force: true });
    });

    it('attributes the cross-file `repo.db` read (after instanceof narrowing) to SqliteRepository.db', () => {
      const dbPath = path.join(projDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(edges).toContainEqual({
        src: 'annotateDataflow',
        srcKind: 'function',
        tgt: 'SqliteRepository.db',
        tgtKind: 'method',
        kind: 'calls',
      });
    });

    it('persists accessor_kind = "get" on the SqliteRepository.db node', () => {
      const dbPath = path.join(projDir, '.codegraph', 'graph.db');
      expect(readAccessorKind(dbPath, 'SqliteRepository.db')).toBe('get');
    });

    it('never attributes the read to the plain (non-accessor) OtherRepo.db method', () => {
      const dbPath = path.join(projDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(edges).not.toContainEqual(
        expect.objectContaining({ src: 'annotateDataflow', tgt: 'OtherRepo.db' }),
      );
      expect(readAccessorKind(dbPath, 'OtherRepo.db')).toBeNull();
    });
  });
}

runScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});

function makeStmts(db: ReturnType<typeof openDb>) {
  return {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line, accessor_kind) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    getNodeId: {
      get: (name: string, kind: string, file: string, line: number) => {
        const row = db
          .prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?')
          .get(name, kind, file, line) as { id: number } | undefined;
        return row ? { id: row.id } : undefined;
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
      "SELECT id, kind, file, line, accessor_kind AS accessorKind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file, kind, line, accessor_kind AS accessorKind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
    upsertFileHash: db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    ),
    deleteFileHash: db.prepare('DELETE FROM file_hashes WHERE file = ?'),
  };
}

function runIncrementalParityScenario(engine: EngineMode): void {
  describe(`incremental rebuild matches full build for cross-file accessor reads (#2030) — ${engine}`, () => {
    let incDir: string;
    let refDir: string;

    beforeAll(async () => {
      incDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2030-inc-${engine}-`));
      writeFixture(incDir);
      await buildGraph(incDir, { engine, incremental: false, skipRegistry: true });

      // Touch the reading file and rebuild it through the single-file
      // incremental path — the accessor's own file (sqlite-repository.ts) is
      // untouched, so its accessor_kind must already be visible to the
      // incremental rebuild's global-by-name lookup.
      const filePath = path.join(incDir, 'sequence.ts');
      fs.appendFileSync(filePath, '\n// touched\n');
      const dbPath = path.join(incDir, '.codegraph', 'graph.db');
      const db = openDb(dbPath);
      try {
        initSchema(db);
        const stmts = makeStmts(db);
        await rebuildFile(db, incDir, filePath, stmts, { engine }, null);
      } finally {
        db.close();
      }

      refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2030-ref-${engine}-`));
      writeFixture(refDir);
      fs.appendFileSync(path.join(refDir, 'sequence.ts'), '\n// touched\n');
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(incDir, { recursive: true, force: true });
      fs.rmSync(refDir, { recursive: true, force: true });
    });

    it('produces the same cross-file accessor-read call edges as a full rebuild', () => {
      const incremental = readCallEdges(path.join(incDir, '.codegraph', 'graph.db'));
      const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));
      expect(incremental).toEqual(reference);
      expect(incremental).toContainEqual({
        src: 'annotateDataflow',
        srcKind: 'function',
        tgt: 'SqliteRepository.db',
        tgtKind: 'method',
        kind: 'calls',
      });
    });
  });
}

runIncrementalParityScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine incremental parity coverage', () => {
  runIncrementalParityScenario('native');
});
