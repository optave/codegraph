/**
 * Integration test for #2235: typeMap collisions across same-named locals in
 * different functions cause native/wasm divergence.
 *
 * The typeMap is a flat, per-file, name-only structure (`Map<string,
 * TypeMapEntry>` in TS / `HashMap<&str, (&str, f64)>` in Rust). Two different
 * functions in the same file each declaring their own differently-typed
 * local/parameter of the same name collide under the bare key — whichever one
 * is written first (or has higher confidence) wins, and the *other*
 * function's receiver-type resolution silently uses the wrong type.
 *
 * Fix: both engines now additionally seed a function-scoped key
 * (`${enclosingFunctionQualifier}::${name}`) alongside the bare key
 * (`setScopedTypeMapEntry` / `push_scoped_type_map_entry`), and the
 * consumption side (`resolveReceiverTypeName` in resolver/strategy.ts,
 * `resolveReceiverEdge` in call-resolver.ts, and their Rust mirrors in
 * build_edges.rs) checks that scoped key *before* the bare fallback keys —
 * mirroring the existing `ClassName.field` class-scoped precedent (#1458).
 *
 * Also covers the issue's second repro: `ReturnType<typeof fn>` (and the
 * other opaque generic-wrapper utility types) was extracted as if its own
 * name (`"ReturnType"`) were a real receiver type, seeding a bogus bare-key
 * entry that could win the collision over a legitimate same-named parameter
 * elsewhere in the file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'db.ts': `
export class OrderDb {
  commit() {}
}
export class UserDb {
  commit() {}
}
export function processOrder(db: OrderDb) {
  db.commit();
}
export function processUser(db: UserDb) {
  db.commit();
}
export function makeUserConn(): UserDb {
  return new UserDb();
}
export function processOpaque(db: ReturnType<typeof makeUserConn>) {
  db.commit();
}
`,
};

function writeFixture(rootDir: string) {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function getReceiverLikeEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, e.kind AS kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind IN ('calls', 'receiver') AND n2.name LIKE '%.commit'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string; kind: string }>;
  } finally {
    db.close();
  }
}

function runSuite(engine: 'wasm' | 'native') {
  describe(`typeMap scoping collision (#2235) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2235-${engine}-`));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves processOrder.db.commit() to OrderDb.commit', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = getReceiverLikeEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'processOrder' && e.tgt === 'OrderDb.commit'),
        `Expected processOrder -> OrderDb.commit; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    it('resolves processUser.db.commit() to UserDb.commit despite the colliding param name', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = getReceiverLikeEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'processUser' && e.tgt === 'UserDb.commit'),
        `Expected processUser -> UserDb.commit; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    it('does not cross-resolve processOrder to UserDb.commit or processUser to OrderDb.commit', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = getReceiverLikeEdges(dbPath);
      expect(edges.some((e) => e.src === 'processOrder' && e.tgt === 'UserDb.commit')).toBe(false);
      expect(edges.some((e) => e.src === 'processUser' && e.tgt === 'OrderDb.commit')).toBe(false);
    });

    it('does not let a ReturnType<typeof fn>-typed param poison a same-named param elsewhere', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = getReceiverLikeEdges(dbPath);
      // processOpaque's own `db: ReturnType<typeof makeUserConn>` annotation is
      // unresolvable by design (actually inferring through ReturnType<typeof fn>
      // is a separate, still-open gap — see the issue's scope note) — it may
      // legitimately fall back to whatever bare "db" happens to hold elsewhere
      // in the file. What #2235 guarantees is that processUser's OWN resolution
      // stays correct despite that unresolvable annotation existing in the same
      // file: it must not silently start losing to it.
      expect(edges.some((e) => e.src === 'processUser' && e.tgt === 'UserDb.commit')).toBe(true);
      expect(edges.some((e) => e.src === 'processUser' && e.tgt === 'OrderDb.commit')).toBe(false);
    });
  });
}

runSuite('wasm');

describe.skipIf(!isNativeAvailable())('native engine parity', () => {
  runSuite('native');
});
