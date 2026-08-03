/**
 * Regression test for #1967: `codegraph watch` does not resolve barrel
 * re-export renames (`export { X as Y } from '...'`) on incremental rebuild
 * when only a *consumer* of the barrel changes and the barrel itself is not
 * part of the same watch batch.
 *
 * `codegraph build` (both full and hash-based incremental) already resolves
 * this correctly (#1823) via `resolveBarrelExport` in resolve-imports.ts,
 * which works from a freshly-parsed, in-memory `reexportMap`. `codegraph
 * watch` uses a separate, DB-only single-file rebuild path
 * (`rebuildFile`/`resolveBarrelTarget` in `domain/graph/builder/incremental.ts`)
 * that, before this fix, had no way to recover the barrel's rename table
 * when the barrel itself wasn't reparsed in the same watch cycle.
 *
 * The fix persists barrel rename pairs to a `reexport_renames` table
 * whenever a barrel file is parsed (full build, incremental build, or a
 * watch rebuild that happens to touch the barrel directly), so a later
 * watch cycle that only touches a *consumer* can still translate the
 * requested external alias back to the name actually declared in the
 * reexport source.
 *
 * Fixture (mirrors #1823's):
 *   underlying.ts — `export function realName() {}`
 *   barrel.ts     — `export { realName as friendlyName } from './underlying.js';`
 *   consumer.ts   — `import { friendlyName } from './barrel.js';` calls
 *                   `friendlyName()` inside an exported function.
 *
 * Parametrized on the *initial full build's* engine to exercise both
 * population paths: the JS pipeline (`persistReexportRenames` in
 * resolve-imports.ts) and the native orchestrator
 * (`import_edges::persist_reexport_renames` in Rust). The watch-mode
 * `rebuildFile` call itself is always JS — `codegraph watch` has no native
 * single-file rebuild path.
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
  'underlying.ts': `
export function realName(): string {
  return 'real';
}
`,
  'barrel.ts': `
// Barrel re-export with rename — the external name (friendlyName) differs
// from the underlying declaration (realName).
export { realName as friendlyName } from './underlying.js';
`,
  'consumer.ts': `
import { friendlyName } from './barrel.js';

export function useIt(): string {
  return friendlyName();
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

function readCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.file AS src_file, n2.name AS tgt, n2.file AS tgt_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; src_file: string; tgt: string; tgt_file: string }>;
  } finally {
    db.close();
  }
}

function readReexportRenames(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT barrel_file, local_name, imported_name, source_file
         FROM reexport_renames ORDER BY barrel_file, local_name`,
      )
      .all() as Array<{
      barrel_file: string;
      local_name: string;
      imported_name: string;
      source_file: string;
    }>;
  } finally {
    db.close();
  }
}

function makeStmts(db: ReturnType<typeof openDb>) {
  return {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
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
  'codegraph watch resolves barrel rename on consumer-only rebuild (#1967) — initial build: %s',
  (engine) => {
    let watchDir: string;
    let dbPath: string;

    beforeAll(async () => {
      watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1967-${engine}-`));
      writeFixture(watchDir);

      // Initial full build — populates `reexport_renames` for barrel.ts via
      // either the JS pipeline or the native orchestrator, depending on `engine`.
      await buildGraph(watchDir, { incremental: false, skipRegistry: true, engine });
      dbPath = path.join(watchDir, '.codegraph', 'graph.db');

      // Sanity check: the initial full build actually persisted the rename.
      const renamesAfterFullBuild = readReexportRenames(dbPath);
      expect(renamesAfterFullBuild).toEqual([
        {
          barrel_file: 'barrel.ts',
          local_name: 'friendlyName',
          imported_name: 'realName',
          source_file: 'underlying.ts',
        },
      ]);

      // Touch ONLY consumer.ts — the barrel itself is untouched, matching the
      // issue's exact reproduction ("a consumer of that barrel is edited in a
      // watch cycle where the barrel itself isn't reparsed").
      const consumerFile = path.join(watchDir, 'consumer.ts');
      fs.appendFileSync(consumerFile, '\n// touch\n');

      // Run the watch-mode single-file rebuild path directly.
      const db = openDb(dbPath);
      initSchema(db);
      await rebuildFile(db, watchDir, consumerFile, makeStmts(db), { engine }, null);
      db.close();
    }, 60_000);

    afterAll(() => {
      try {
        if (watchDir) fs.rmSync(watchDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('useIt -> realName calls edge survives the consumer-only watch rebuild', () => {
      const edges = readCallEdges(dbPath);
      const edge = edges.find((e) => e.src === 'useIt' && e.tgt === 'realName');
      expect(
        edge,
        `Expected useIt -> realName call edge, resolved through barrel.ts's rename table\nActual call edges:\n${JSON.stringify(edges, null, 2)}`,
      ).toBeDefined();
      expect(edge?.tgt_file).toBe('underlying.ts');
    });

    it('no spurious edge is created against a nonexistent "friendlyName" symbol', () => {
      const edges = readCallEdges(dbPath);
      expect(edges.find((e) => e.tgt === 'friendlyName')).toBeUndefined();
    });

    it("barrel.ts's rename row survives the consumer-only rebuild unchanged", () => {
      // The barrel itself was never touched, so its own persisted rename row
      // must still be exactly what the initial full build wrote.
      expect(readReexportRenames(dbPath)).toEqual([
        {
          barrel_file: 'barrel.ts',
          local_name: 'friendlyName',
          imported_name: 'realName',
          source_file: 'underlying.ts',
        },
      ]);
    });
  },
);
