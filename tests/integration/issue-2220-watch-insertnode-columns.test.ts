/**
 * Regression test for #2220: `codegraph watch`'s single-file rebuild path
 * (`insertFileNodes` in `src/domain/graph/builder/incremental.ts`, via
 * `rebuildFile`) never populated `qualified_name`/`scope`/`visibility`/
 * `parent_id`/`content_hash` on `nodes`, nor set `exported = 1` — unlike the
 * full-build path (`insertDefinitionsAndExports`/`collectChildRowsAndFileEdges`
 * in `stages/insert-nodes.ts`). A symbol touched only by a watch-mode
 * rebuild would silently diverge from one touched by a full or regular
 * incremental `codegraph build`, breaking any downstream query that
 * filters/joins on those columns.
 *
 * Fixture: a top-level exported function (`topLevel`), and a class
 * (`Greeter`) with a method (`greet`) that takes a parameter (`name`). The
 * JS extractor represents a method as its own top-level, dotted-name
 * definition (`Greeter.greet`, scoped via that dot) rather than nesting it
 * under the class's `children` — `def.children` is where a definition's
 * *parameters* live, which is what actually exercises the `parent_id`/
 * per-child `qualified_name` path here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { createIncrementalStmts } from '../helpers/incremental-stmts.js';

const SOURCE = `
export function topLevel() {
  return 42;
}

class Greeter {
  greet(name) {
    return 'hi ' + name;
  }
}
`;

interface NodeRow {
  id: number;
  name: string;
  kind: string;
  parent_id: number | null;
  qualified_name: string | null;
  scope: string | null;
  content_hash: string | null;
  exported: number;
}

function readNodes(dbPath: string): NodeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT id, name, kind, parent_id, qualified_name, scope, content_hash, exported FROM nodes WHERE kind != 'file' ORDER BY name, kind",
      )
      .all() as NodeRow[];
  } finally {
    db.close();
  }
}

describe('watch-mode rebuild populates qualified_name/scope/visibility/parent_id/content_hash/exported (#2220)', () => {
  let dir: string;
  let dbPath: string;
  let nodes: NodeRow[];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2220-'));
    fs.writeFileSync(path.join(dir, 'greeter.js'), SOURCE);

    await buildGraph(dir, { incremental: false, skipRegistry: true, engine: 'wasm' });
    dbPath = path.join(dir, '.codegraph', 'graph.db');

    // Touch the file and rebuild via the watch-mode path (rebuildFile) —
    // the code path #2220 is about, not the initial full build above.
    const filePath = path.join(dir, 'greeter.js');
    fs.appendFileSync(filePath, '\n// touch\n');

    const db = openDb(dbPath);
    initSchema(db);
    await rebuildFile(db, dir, filePath, createIncrementalStmts(db), { engine: 'wasm' }, null);
    db.close();

    nodes = readNodes(dbPath);
  }, 30_000);

  afterAll(() => {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('gives a top-level definition its own name as qualified_name and exported = 1', () => {
    const topLevel = nodes.find((n) => n.name === 'topLevel');
    expect(
      topLevel,
      `Expected a topLevel node\nActual: ${JSON.stringify(nodes, null, 2)}`,
    ).toBeDefined();
    expect(topLevel?.qualified_name).toBe('topLevel');
    expect(topLevel?.parent_id).toBeNull();
    expect(topLevel?.content_hash).toBeTruthy();
    expect(topLevel?.exported).toBe(1);
  });

  it('gives a dotted method definition a scope derived from its class prefix', () => {
    const greet = nodes.find((n) => n.name === 'Greeter.greet');
    expect(
      greet,
      `Expected a Greeter.greet node\nActual: ${JSON.stringify(nodes, null, 2)}`,
    ).toBeDefined();
    expect(greet?.qualified_name).toBe('Greeter.greet');
    expect(greet?.scope).toBe('Greeter');
    expect(greet?.content_hash).toBeTruthy();
    expect(greet?.exported).toBe(0);
  });

  it('gives a parameter child its defining method as parent_id and a dotted qualified_name', () => {
    const greet = nodes.find((n) => n.name === 'Greeter.greet');
    const param = nodes.find((n) => n.name === 'name' && n.kind === 'parameter');
    expect(
      greet,
      `Expected a Greeter.greet node\nActual: ${JSON.stringify(nodes, null, 2)}`,
    ).toBeDefined();
    expect(
      param,
      `Expected a 'name' parameter node\nActual: ${JSON.stringify(nodes, null, 2)}`,
    ).toBeDefined();
    expect(param?.parent_id).toBe(greet?.id);
    expect(param?.qualified_name).toBe('Greeter.greet.name');
    expect(param?.scope).toBe('Greeter.greet');
  });
});
