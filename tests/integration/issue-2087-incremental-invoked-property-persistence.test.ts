/**
 * Regression test for #2087: the #1895 object-literal-property value-ref
 * liveness check (`collectInvokedPropertyNames`) only sees property/method
 * names invoked via member-call syntax across the files actually being
 * processed. On a full build that's the whole codebase, so it's exact. On
 * `codegraph watch`'s single-file rebuild (`rebuildFile`/`buildCallEdges` in
 * `domain/graph/builder/incremental.ts`), it was scoped to only the file
 * being rebuilt — a consumer's `table.resolve(...)` call living in an
 * untouched file was invisible, so a same-named object-literal property in
 * the rebuilt producer file could be misclassified as dead.
 *
 * The fix persists per-file invoked-property-name evidence into a durable
 * `invoked_property_names` table (both engines) whenever a file is parsed —
 * full build, scoped incremental `codegraph build`, or a `codegraph watch`
 * rebuild — so a later watch cycle that only touches the *producer* can
 * still see evidence contributed by an untouched *consumer*.
 *
 * Fixture (mirrors #1895's):
 *   factory.js  — declares `isRead` and wires it under `resolve` in an
 *                 object-literal dispatch table.
 *   consumer.js — the ONLY call site: `table.resolve(1)`.
 *
 * Parametrized on the initial full build's engine to exercise both
 * population paths: the JS pipeline (`persistInvokedPropertyNames` in
 * build-edges.ts) and the native orchestrator
 * (`import_edges::persist_invoked_property_names` in Rust). The watch-mode
 * `rebuildFile` call itself is always JS — `codegraph watch` has no native
 * single-file rebuild path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';
import { createIncrementalStmts } from '../helpers/incremental-stmts.js';

const FILES: Record<string, string> = {
  'factory.js': `
function isRead(x) { return x + 1; }

export function makeTable() {
  return {
    resolve: isRead,
  };
}
`,
  'consumer.js': `
import { makeTable } from './factory.js';

export function run() {
  const table = makeTable();
  return table.resolve(1);
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

function readInvokedPropertyNames(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT file, name FROM invoked_property_names ORDER BY file, name')
      .all() as Array<{ file: string; name: string }>;
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'codegraph watch keeps object-literal value-ref evidence on producer-only rebuild (#2087) — initial build: %s',
  (engine) => {
    let watchDir: string;
    let dbPath: string;

    beforeAll(async () => {
      watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2087-${engine}-`));
      writeFixture(watchDir);

      // Initial full build — populates `invoked_property_names` for both
      // files via either the JS pipeline or the native orchestrator,
      // depending on `engine`, and confirms the value-ref edge exists.
      await buildGraph(watchDir, { incremental: false, skipRegistry: true, engine });
      dbPath = path.join(watchDir, '.codegraph', 'graph.db');

      const namesAfterFullBuild = readInvokedPropertyNames(dbPath);
      expect(namesAfterFullBuild).toEqual([{ file: 'consumer.js', name: 'resolve' }]);

      const edgesAfterFullBuild = readCallEdges(dbPath);
      expect(edgesAfterFullBuild.find((e) => e.tgt === 'isRead')).toBeDefined();

      // Touch ONLY factory.js — the consumer (the only `.resolve(...)` call
      // site) is untouched, matching the issue's exact reproduction: an
      // incremental rebuild triggered solely on the producer file.
      const factoryFile = path.join(watchDir, 'factory.js');
      fs.appendFileSync(factoryFile, '\n// touch\n');

      // Run the watch-mode single-file rebuild path directly.
      const db = openDb(dbPath);
      initSchema(db);
      await rebuildFile(db, watchDir, factoryFile, createIncrementalStmts(db), { engine }, null);
      db.close();
    }, 60_000);

    afterAll(() => {
      try {
        if (watchDir) fs.rmSync(watchDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('the isRead value-ref calls edge survives the producer-only watch rebuild', () => {
      const edges = readCallEdges(dbPath);
      const edge = edges.find((e) => e.tgt === 'isRead');
      expect(
        edge,
        `Expected a value-ref calls edge to isRead, confirmed via consumer.js's\n` +
          `persisted invoked-property-name evidence\nActual call edges:\n${JSON.stringify(edges, null, 2)}`,
      ).toBeDefined();
    });

    it("consumer.js's invoked-property-name evidence survives the producer-only rebuild unchanged", () => {
      // consumer.js was never touched, so its own persisted row must still
      // be exactly what the initial full build wrote.
      expect(readInvokedPropertyNames(dbPath)).toContainEqual({
        file: 'consumer.js',
        name: 'resolve',
      });
    });
  },
);

/**
 * `codegraph build`'s own scoped-incremental pipeline (buildGraph with
 * incremental: true — distinct from `codegraph watch`'s rebuildFile path
 * exercised above) has the identical gap: `buildCallEdgesPhase`
 * (stages/build-edges.ts) narrows `ctx.fileSymbols` to just the changed
 * file(s) + reverse-deps on a non-full build, so a purely in-memory
 * `collectInvokedPropertyNames` computation loses the same cross-file
 * evidence. Fixed by reading back `invoked_property_names` (persisted by
 * `persistInvokedPropertyNames`) for both the JS-fallback sub-path
 * (`buildCallEdgesJS`) and the native-fast-path sub-path
 * (`buildCallEdgesNative`, threaded through `build_call_edges`'s new
 * `extraInvokedPropertyNames` parameter). At least 6 filler files are added
 * so the native-engine variant exceeds `smallFilesThreshold` (5) and
 * exercises `buildCallEdgesNative` specifically, not just the JS fallback.
 */
const FILLER_COUNT = 6;

function writeScopedFixture(dir: string) {
  writeFixture(dir);
  for (let i = 0; i < FILLER_COUNT; i++) {
    fs.writeFileSync(
      path.join(dir, `filler${i}.js`),
      `export function filler${i}() { return ${i}; }\n`,
    );
  }
}

describe.each(ENGINES)(
  'codegraph build scoped-incremental rebuild keeps object-literal value-ref evidence (#2087) — engine: %s',
  (engine) => {
    let buildDir: string;
    let scopedDbPath: string;

    beforeAll(async () => {
      buildDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2087-build-${engine}-`));
      writeScopedFixture(buildDir);
      scopedDbPath = path.join(buildDir, '.codegraph', 'graph.db');

      // Initial build establishes file_hashes so the second build below is a
      // genuinely scoped incremental rebuild, not another full one.
      await buildGraph(buildDir, { incremental: true, skipRegistry: true, engine });
      expect(readCallEdges(scopedDbPath).find((e) => e.tgt === 'isRead')).toBeDefined();

      // Touch ONLY factory.js — consumer.js (the only `.resolve(...)` call
      // site) is untouched, so this incremental rebuild's own ctx.fileSymbols
      // never includes it.
      fs.appendFileSync(path.join(buildDir, 'factory.js'), '\n// touch\n');
      await buildGraph(buildDir, { incremental: true, skipRegistry: true, engine });
    }, 60_000);

    afterAll(() => {
      try {
        if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('the isRead value-ref calls edge survives the scoped incremental rebuild', () => {
      const edges = readCallEdges(scopedDbPath);
      const edge = edges.find((e) => e.tgt === 'isRead');
      expect(
        edge,
        `Expected a value-ref calls edge to isRead after a producer-only scoped\n` +
          `incremental rebuild\nActual call edges:\n${JSON.stringify(edges, null, 2)}`,
      ).toBeDefined();
    });
  },
);
