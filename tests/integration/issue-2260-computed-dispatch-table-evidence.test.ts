/**
 * Integration test for #2260: #1771/#1895 gave dot-property dispatch-table
 * references (`{ resolve: someFn }` accessed via `x.resolve(...)`) a real
 * `calls` edge once invocation evidence is confirmed, but never covered the
 * computed/bracket-access idiom: `const handler = TABLE[node.type]; ...;
 * handler(...)`. `handleGroovyInterfaceDecl` (and every other handler in
 * `src/extractors/groovy.ts`'s `GROOVY_NODE_HANDLERS`) had `fanIn === 0` —
 * nothing pointed to it at all — so once #2032's reachability downgrade
 * landed, it and its own callees were wrongly flagged dead, even though
 * they're genuinely reachable via the dispatch table.
 *
 * Fix: `collectComputedDispatchTableEvidence` (mirrored in the Rust engine)
 * recognizes `const handler = TABLE[computedExpr]` followed by `handler(...)`
 * later in the same enclosing block (reusing #2257's local, position-scoped
 * liveness machinery, restricted to call-shape evidence specifically) and
 * credits the WHOLE table with computed-invocation evidence — a computed key
 * can't name one specific property statically the way a dot access can, so
 * evidence is credited per-table rather than per-key.
 *
 * The "credit the whole table" aggregation (both engines) was originally
 * keyed on the table's bare variable name across the whole build pass, not
 * scoped per-file — so a second, unrelated file declaring its own same-named
 * table with no computed-access evidence of its own would wrongly inherit
 * the first file's evidence (Greptile review, PR #2445). `unrelated.js`
 * below regression-tests that: it declares its own `GROOVY_NODE_HANDLERS`
 * with a handler that is never independently invoked and whose table is
 * never accessed computedly — that handler must stay dead even once
 * `dispatch.js`'s same-named table earns evidence.
 *
 * File-scoping alone still left one gap Greptile caught on the next review
 * round: two different FUNCTIONS in the SAME file, each declaring their own
 * same-named local table. `sameFileScopes.js` below regression-tests that —
 * `scopeA`'s locally-scoped `HANDLERS` earns computed-access evidence,
 * `scopeB`'s unrelated, separately-scoped `HANDLERS` must not inherit it.
 *
 * Scoping by enclosing FUNCTION alone still wasn't fine-grained enough for a
 * third review round: two SIBLING BLOCKS inside the SAME function (an
 * `if`/`else`), each declaring their own same-named table, reduced to the
 * identical function-qualified key. `siblingBlocks.js` below regression-tests
 * that — the `if` branch's locally-scoped `TABLE` earns computed-access
 * evidence, the `else` branch's separately-scoped, same-named `TABLE` must
 * not inherit it, even though both live in the same enclosing function.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'dispatch.js': `
const GROOVY_NODE_HANDLERS = {
  interface_definition: handleGroovyInterfaceDecl,
  interface_declaration: handleGroovyInterfaceDecl,
};

function walkGroovyNode(node, ctx) {
  const handler = GROOVY_NODE_HANDLERS[node.type];
  if (handler) handler(node, ctx);
}

function handleGroovyInterfaceDecl(node, ctx) {
  return collectGroovyParentInterfaces(node);
}

function collectGroovyParentInterfaces(node) {
  return node;
}

export function start(node, ctx) {
  walkGroovyNode(node, ctx);
}
`,
  'unrelated.js': `
function unrelatedHandler(node) {
  return node;
}

const GROOVY_NODE_HANDLERS = {
  some_other_kind: unrelatedHandler,
};
`,
  'sameFileScopes.js': `
function scopeAHandler(node) {
  return node;
}

function scopeBHandler(node) {
  return node;
}

function scopeA(node) {
  const HANDLERS = { compute: scopeAHandler };
  const handler = HANDLERS[node.type];
  if (handler) handler(node);
}

function scopeB() {
  const HANDLERS = { other: scopeBHandler };
}
`,
  'siblingBlocks.js': `
function ifBranchHandler(node) {
  return node;
}

function elseBranchHandler(node) {
  return node;
}

function dispatch(node) {
  if (node.useIfBranch) {
    const TABLE = { compute: ifBranchHandler };
    const handler = TABLE[node.type];
    if (handler) handler(node);
  } else {
    const TABLE = { other: elseBranchHandler };
  }
}
`,
};

const DEAD_ROLES = new Set(['dead-unresolved', 'dead-leaf', 'dead-entry', 'dead-ffi']);

function readNodesWithRoles(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, kind, role FROM nodes ORDER BY name').all() as Array<{
      name: string;
      kind: string;
      role: string | null;
    }>;
  } finally {
    db.close();
  }
}

function countCallEdges(dbPath: string, sourceName: string, targetName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND s.name = ? AND t.name = ?`,
      )
      .get(sourceName, targetName) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function countIncomingCallEdges(dbPath: string, targetName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM edges e
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND t.name = ?`,
      )
      .get(targetName) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function runShared(getDbPath: () => string) {
  it('creates a calls edge from the dispatch table to the handler reached via a computed lookup', () => {
    expect(
      countCallEdges(getDbPath(), 'GROOVY_NODE_HANDLERS', 'handleGroovyInterfaceDecl'),
    ).toBeGreaterThan(0);
  });

  it('keeps the handler and its own callees reachable, not dead', () => {
    const nodes = readNodesWithRoles(getDbPath());
    const handler = nodes.find((n) => n.name === 'handleGroovyInterfaceDecl');
    const callee = nodes.find((n) => n.name === 'collectGroovyParentInterfaces');
    expect(handler, 'handleGroovyInterfaceDecl node not found').toBeDefined();
    expect(callee, 'collectGroovyParentInterfaces node not found').toBeDefined();
    expect(DEAD_ROLES.has(handler!.role ?? '')).toBe(false);
    expect(DEAD_ROLES.has(callee!.role ?? '')).toBe(false);
  });

  it("does not credit an unrelated file's same-named table with borrowed evidence (Greptile review, PR #2445)", () => {
    // unrelated.js declares its own `GROOVY_NODE_HANDLERS` — same bare name
    // as dispatch.js's table, but never accessed computedly and never
    // independently invoked. Its own handler must get no calls edge even
    // though dispatch.js's same-named table has confirmed evidence.
    expect(countCallEdges(getDbPath(), 'GROOVY_NODE_HANDLERS', 'unrelatedHandler')).toBe(0);
  });

  it("does not credit a same-named table in a different function's scope, same file (Greptile review, PR #2445)", () => {
    // sameFileScopes.js: scopeA's locally-scoped HANDLERS earns computed-
    // access evidence (attributed to scopeA, the enclosing function, since
    // the table itself is function-local) and its own handler gets an edge.
    // scopeB's separately-scoped, same-named HANDLERS never earns any
    // evidence of its own and must not inherit scopeA's.
    expect(countCallEdges(getDbPath(), 'scopeA', 'scopeAHandler')).toBeGreaterThan(0);
    expect(countIncomingCallEdges(getDbPath(), 'scopeBHandler')).toBe(0);
  });

  it('does not credit a same-named table in a sibling block, same function (Greptile review, PR #2445)', () => {
    // siblingBlocks.js: the `if` branch's locally-scoped TABLE earns
    // computed-access evidence (attributed to `dispatch`, the enclosing
    // function, since the table is block-local) and its own handler gets an
    // edge. The `else` branch's separately-scoped, same-named TABLE never
    // earns any evidence of its own and must not inherit the if-branch's,
    // even though both live in the same enclosing function.
    expect(countCallEdges(getDbPath(), 'dispatch', 'ifBranchHandler')).toBeGreaterThan(0);
    expect(countIncomingCallEdges(getDbPath(), 'elseBranchHandler')).toBe(0);
  });
}

describe('computed dispatch-table access gets invocation evidence (#2260) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2260-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  runShared(() => path.join(tmpDir, '.codegraph', 'graph.db'));
});

describe.skipIf(!isNativeAvailable())(
  'computed dispatch-table access gets invocation evidence (#2260) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2260-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    runShared(() => path.join(nativeTmpDir, '.codegraph', 'graph.db'));
  },
);
