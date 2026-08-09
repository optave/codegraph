/**
 * Regression test for #2216: `codegraph watch`'s single-file rebuild path
 * (`rebuildFile` in `domain/graph/builder/incremental.ts`) never threaded a
 * project-wide known-files list into `resolveImportPath`, so a Rust
 * `crate::`/`self::`/`super::` import (#2007) in a file processed via watch
 * mode silently failed to resolve — even though the same file resolves
 * correctly in a full or hash-based-incremental `codegraph build`, both of
 * which already have the project's file list in memory as `ctx.allFiles`
 * before import resolution runs.
 *
 * `resolveImportPathJS`/the native resolver only attempt Rust crate-path
 * resolution when a non-null/non-empty known-files set is passed in —
 * without it, `use crate::greeter::greet;` falls straight through to the
 * generic fallback and returns the import specifier string unchanged, which
 * never matches any real file node.
 *
 * The fixture deliberately has *two* same-named `greet` functions in
 * different modules — with only one candidate in the graph, the call
 * resolver's global same-name fallback would still find the right target
 * even with import resolution completely broken, masking this exact bug.
 * With two candidates, only a correctly-resolved `crate::greeter::greet`
 * import can disambiguate which `greet` `main` actually calls; before this
 * fix, the call edge was dropped entirely rather than risk resolving to the
 * wrong one.
 *
 * Fixture:
 *   main.rs    — `mod greeter; mod other; use crate::greeter::greet; fn main() { greet(); }`
 *   greeter.rs — `pub fn greet() -> String { "hi from greeter".to_string() }`
 *   other.rs   — `pub fn greet() -> String { "hi from other".to_string() }`
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
  'main.rs': `
mod greeter;
mod other;
use crate::greeter::greet;

fn main() {
    greet();
}
`,
  'other.rs': `
pub fn greet() -> String {
    "hi from other".to_string()
}
`,
  'greeter.rs': `
pub fn greet() -> String {
    "hi from greeter".to_string()
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

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'codegraph watch resolves Rust crate:: import on rebuild (#2216) — initial build: %s',
  (engine) => {
    let watchDir: string;
    let dbPath: string;

    beforeAll(async () => {
      watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2216-${engine}-`));
      writeFixture(watchDir);

      // Initial full build — crate:: resolution already works here (#2007).
      await buildGraph(watchDir, { incremental: false, skipRegistry: true, engine });
      dbPath = path.join(watchDir, '.codegraph', 'graph.db');

      // Sanity check: the initial full build actually resolved the edge.
      const edgesAfterFullBuild = readCallEdges(dbPath);
      expect(edgesAfterFullBuild.find((e) => e.src === 'main' && e.tgt === 'greet')).toBeDefined();

      // Touch main.rs — the file containing the crate:: import — and run the
      // watch-mode single-file rebuild path directly.
      const mainFile = path.join(watchDir, 'main.rs');
      fs.appendFileSync(mainFile, '\n// touch\n');

      const db = openDb(dbPath);
      initSchema(db);
      await rebuildFile(db, watchDir, mainFile, createIncrementalStmts(db), { engine }, null);
      db.close();
    }, 60_000);

    afterAll(() => {
      try {
        if (watchDir) fs.rmSync(watchDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('main -> greet call edge survives the watch rebuild via crate:: resolution', () => {
      const edges = readCallEdges(dbPath);
      const edge = edges.find((e) => e.src === 'main' && e.tgt === 'greet');
      expect(
        edge,
        `Expected main -> greet call edge, resolved via crate::greeter::greet\nActual call edges:\n${JSON.stringify(edges, null, 2)}`,
      ).toBeDefined();
      expect(edge?.tgt_file).toBe('greeter.rs');
    });
  },
);
