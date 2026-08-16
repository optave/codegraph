/**
 * Integration tests for node role classification.
 *
 * Uses the same fixture DB pattern as queries.test.js — a hand-crafted
 * in-file DB with known nodes and edges — then exercises rolesData,
 * statsData, whereData, explainData, and listFunctionsData to verify
 * roles appear in all expected outputs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import {
  explainData,
  listFunctionsData,
  rolesData,
  statsData,
  whereData,
} from '../../src/domain/queries.js';
import { classifyNodeRoles } from '../../src/features/structure.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, 0)',
  ).run(sourceId, targetId, kind, confidence);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir: string, dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-roles-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  const fApp = insertNode(db, 'app.js', 'file', 'app.js', 0);
  const fLib = insertNode(db, 'lib.js', 'file', 'lib.js', 0);
  const fTest = insertNode(db, 'app.test.js', 'file', 'app.test.js', 0);

  // Function nodes
  const main = insertNode(db, 'main', 'function', 'app.js', 1);
  const process_ = insertNode(db, 'processData', 'function', 'app.js', 10);
  const helper = insertNode(db, 'helper', 'function', 'lib.js', 1);
  const format = insertNode(db, 'format', 'function', 'lib.js', 10);
  insertNode(db, 'unused', 'function', 'lib.js', 20);
  const testFn = insertNode(db, 'testMain', 'function', 'app.test.js', 1);

  // Import edges
  insertEdge(db, fApp, fLib, 'imports');
  insertEdge(db, fTest, fApp, 'imports');

  // Call edges:
  // main → processData (same file)
  // main → helper (cross-file) → makes helper exported
  // processData → format (cross-file) → makes format exported
  // helper → format (same file)
  // testFn → main (cross-file) → makes main exported
  insertEdge(db, main, process_, 'calls');
  insertEdge(db, main, helper, 'calls');
  insertEdge(db, process_, format, 'calls');
  insertEdge(db, helper, format, 'calls');
  insertEdge(db, testFn, main, 'calls');

  // unused has no callers and no cross-file callers → dead

  // Classify roles
  classifyNodeRoles(db);

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Barrel re-export role classification (#837) ──────────────────────

describe('barrel re-export role classification', () => {
  let barrelTmpDir: string, barrelDbPath: string;

  beforeAll(() => {
    barrelTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-barrel-roles-'));
    fs.mkdirSync(path.join(barrelTmpDir, '.codegraph'));
    barrelDbPath = path.join(barrelTmpDir, '.codegraph', 'graph.db');

    const db = new Database(barrelDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // File nodes
    const fInspect = insertNode(db, 'src/inspect.ts', 'file', 'src/inspect.ts', 0);
    const fBarrel = insertNode(db, 'src/index.ts', 'file', 'src/index.ts', 0);
    const fConsumer = insertNode(db, 'src/app.ts', 'file', 'src/app.ts', 0);
    const fTest = insertNode(db, 'tests/inspect.test.ts', 'file', 'tests/inspect.test.ts', 0);

    // Symbol nodes
    const queryName = insertNode(db, 'queryName', 'function', 'src/inspect.ts', 10);
    const _helperFn = insertNode(db, 'helperFn', 'function', 'src/inspect.ts', 30);
    const _appMain = insertNode(db, 'appMain', 'function', 'src/app.ts', 1);
    const testFn = insertNode(db, 'testQueryName', 'function', 'tests/inspect.test.ts', 1);
    // A class-method-kind member (e.g. an abstract base-class method) in the same
    // re-exported file, with no callers and no outgoing calls (#1780).
    const _abstractHelper = insertNode(db, 'abstractHelper', 'method', 'src/inspect.ts', 50);

    // Barrel re-exports inspect.ts. This fixture models a genuine wildcard
    // reexport (`export * from './inspect'`) — the extractor emits BOTH the
    // generic file-to-file 'reexports' edge AND a 'reexports-wildcard'
    // marker edge for that shape (unlike a named `export { queryName } from`,
    // which gets a symbol-level 'reexports' edge instead — see #2032's
    // publicSurfaceIds fix). The wildcard marker is what justifies treating
    // every top-level symbol in inspect.ts, not just queryName, as part of
    // the exported surface (matching this describe block's other assertion
    // that helperFn is also 'entry' despite having zero callers of its own).
    insertEdge(db, fBarrel, fInspect, 'reexports');
    insertEdge(db, fBarrel, fInspect, 'reexports-wildcard');
    // Consumer imports from barrel
    insertEdge(db, fConsumer, fBarrel, 'imports');
    // Test file imports from inspect directly
    insertEdge(db, fTest, fInspect, 'imports');

    // Only test code calls queryName — no production calls edges
    insertEdge(db, testFn, queryName, 'calls');

    // helperFn has no callers at all — truly dead
    // appMain has no callers — but is in a production file

    classifyNodeRoles(db);
    db.close();
  });

  afterAll(() => {
    if (barrelTmpDir) fs.rmSync(barrelTmpDir, { recursive: true, force: true });
  });

  test('symbol consumed via barrel re-export is classified as entry, not dead', () => {
    const data = rolesData(barrelDbPath);
    const queryNameResult = data.symbols.find((s) => s.name === 'queryName');
    expect(queryNameResult).toBeDefined();
    // queryName is in a file re-exported by a barrel with production importers
    // → isExported = true, fanIn > 0 from test → falls through to median-based
    //   classification (core/utility/leaf), NOT test-only or dead
    expect(queryNameResult!.role).not.toMatch(/^dead/);
    expect(queryNameResult!.role).not.toBe('test-only');
  });

  test('symbol in re-exported file with no callers is classified as entry (part of exported API)', () => {
    const data = rolesData(barrelDbPath);
    const helperResult = data.symbols.find((s) => s.name === 'helperFn');
    expect(helperResult).toBeDefined();
    // helperFn has 0 callers — but it's in a re-exported file, so isExported = true
    // With fanIn=0 and isExported=true → entry (exported but uncalled)
    expect(helperResult!.role).toBe('entry');
  });

  test('method-kind member in a re-exported file does not inherit exported status (#1780)', () => {
    // A `reexports` edge only ever concerns top-level module bindings — a class
    // method can never be an independently re-exportable binding on its own, so
    // it must not inherit "exported" status merely because a sibling top-level
    // symbol (helperFn/queryName) in the same file is re-exported through the
    // barrel. Before the fix, this method landed on `entry` the same way
    // `helperFn` incorrectly did; it must now fall through to normal dead-code
    // classification instead (no callers, no outgoing calls → dead-unresolved).
    const data = rolesData(barrelDbPath);
    const methodResult = data.symbols.find((s) => s.name === 'abstractHelper');
    expect(methodResult).toBeDefined();
    expect(methodResult!.role).toBe('dead-unresolved');
  });
});

// ─── Multi-level barrel re-export chain (#837) ───────────────────────

describe('multi-level barrel re-export chain', () => {
  let chainTmpDir: string, chainDbPath: string;

  beforeAll(() => {
    chainTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-chain-roles-'));
    fs.mkdirSync(path.join(chainTmpDir, '.codegraph'));
    chainDbPath = path.join(chainTmpDir, '.codegraph', 'graph.db');

    const db = new Database(chainDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // Chain: inspect.ts → index.ts (barrel) → queries-cli.ts (barrel) → query.ts (consumer)
    const fInspect = insertNode(
      db,
      'src/queries-cli/inspect.ts',
      'file',
      'src/queries-cli/inspect.ts',
      0,
    );
    const fIndex = insertNode(
      db,
      'src/queries-cli/index.ts',
      'file',
      'src/queries-cli/index.ts',
      0,
    );
    const fQueriesCli = insertNode(db, 'src/queries-cli.ts', 'file', 'src/queries-cli.ts', 0);
    const fQuery = insertNode(db, 'src/query.ts', 'file', 'src/query.ts', 0);

    const _queryName = insertNode(db, 'queryName', 'function', 'src/queries-cli/inspect.ts', 10);
    insertNode(db, 'queryCmd', 'function', 'src/query.ts', 1);

    // Barrel chain: each barrel re-exports from the one below
    insertEdge(db, fIndex, fInspect, 'reexports');
    insertEdge(db, fQueriesCli, fIndex, 'reexports');
    // Consumer imports from the top-level barrel
    insertEdge(db, fQuery, fQueriesCli, 'imports');

    // No calls edges to queryName at all
    classifyNodeRoles(db);
    db.close();
  });

  afterAll(() => {
    if (chainTmpDir) fs.rmSync(chainTmpDir, { recursive: true, force: true });
  });

  test('symbol at bottom of multi-level barrel chain is classified as entry', () => {
    const data = rolesData(chainDbPath);
    const queryNameResult = data.symbols.find((s) => s.name === 'queryName');
    expect(queryNameResult).toBeDefined();
    // 3-level deep re-export chain: inspect → index → queries-cli → query (consumer)
    // Should still be recognized as exported
    expect(queryNameResult!.role).toBe('entry');
  });
});

// ─── Named reexport does not leak public-surface status to siblings (#2032) ──

describe('named barrel reexport scoped to the actual symbol', () => {
  let namedTmpDir: string, namedDbPath: string;

  beforeAll(() => {
    namedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-named-reexport-'));
    fs.mkdirSync(path.join(namedTmpDir, '.codegraph'));
    namedDbPath = path.join(namedTmpDir, '.codegraph', 'graph.db');

    const db = new Database(namedDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    const fLib = insertNode(db, 'src/lib.ts', 'file', 'src/lib.ts', 0);
    const fBarrel = insertNode(db, 'src/index.ts', 'file', 'src/index.ts', 0);
    const fConsumer = insertNode(db, 'src/app.ts', 'file', 'src/app.ts', 0);

    const publicThing = insertNode(db, 'publicThing', 'function', 'src/lib.ts', 1);
    // Two functions private to lib.ts, unrelated to publicThing: deadIntermediate
    // is never called by anything, and deadHelper's only caller is
    // deadIntermediate — the #2032 transitive-unreachability shape.
    const deadIntermediate = insertNode(db, 'deadIntermediate', 'function', 'src/lib.ts', 10);
    const deadHelper = insertNode(db, 'deadHelper', 'function', 'src/lib.ts', 20);

    // `export { publicThing } from './lib'` — a NAMED reexport: the extractor
    // emits the generic file-to-file 'reexports' edge (mirroring real
    // extraction, which always emits this regardless of named/wildcard) PLUS
    // a symbol-level 'reexports' edge targeting publicThing specifically —
    // NOT a 'reexports-wildcard' marker, since only that one symbol is
    // actually re-exported.
    insertEdge(db, fBarrel, fLib, 'reexports');
    insertEdge(db, fBarrel, publicThing, 'reexports');
    insertEdge(db, fConsumer, fBarrel, 'imports');

    insertEdge(db, deadIntermediate, deadHelper, 'calls');

    classifyNodeRoles(db);
    db.close();
  });

  afterAll(() => {
    if (namedTmpDir) fs.rmSync(namedTmpDir, { recursive: true, force: true });
  });

  test('the actually-named symbol is on the public surface', () => {
    const data = rolesData(namedDbPath);
    const result = data.symbols.find((s) => s.name === 'publicThing');
    expect(result).toBeDefined();
    expect(result!.role).toBe('entry');
  });

  test('a private sibling reachable only through an unreachable caller stays dead, despite sharing a file with the re-exported symbol', () => {
    // Regression for a Greptile-flagged gap: marking the WHOLE target file
    // "exported" merely because it contains one named-reexported symbol would
    // let deadHelper evade #2032's reachability check entirely, since
    // deadIntermediate (its only caller) would wrongly count as a root too.
    const data = rolesData(namedDbPath);
    const result = data.symbols.find((s) => s.name === 'deadHelper');
    expect(result).toBeDefined();
    expect(result!.role).toBe('dead-unresolved');
  });
});

// ─── Incremental classification also runs the #2032 downgrade (issue #2255) ──

describe('incremental classification applies the #2032 reachability downgrade', () => {
  let incTmpDir: string, incDbPath: string;

  beforeAll(() => {
    incTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-incremental-reachability-'));
    fs.mkdirSync(path.join(incTmpDir, '.codegraph'));
    incDbPath = path.join(incTmpDir, '.codegraph', 'graph.db');

    const db = new Database(incDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    insertNode(db, 'src/lib.ts', 'file', 'src/lib.ts', 0);
    // Same #2032 shape as the full-classification test above (deadIntermediate
    // is never called; deadHelper's only caller is deadIntermediate) — but
    // classified via classifyNodeRoles(db, changedFiles), the INCREMENTAL
    // path, which never ran this downgrade at all before issue #2255's fix.
    const deadIntermediate = insertNode(db, 'deadIntermediate', 'function', 'src/lib.ts', 10);
    const deadHelper = insertNode(db, 'deadHelper', 'function', 'src/lib.ts', 20);
    insertEdge(db, deadIntermediate, deadHelper, 'calls');

    classifyNodeRoles(db, ['src/lib.ts']);
    db.close();
  });

  afterAll(() => {
    if (incTmpDir) fs.rmSync(incTmpDir, { recursive: true, force: true });
  });

  test('deadHelper is downgraded to dead on the incremental path, not left at its fan-shape role', () => {
    const data = rolesData(incDbPath);
    const result = data.symbols.find((s) => s.name === 'deadHelper');
    expect(result).toBeDefined();
    expect(result!.role).toBe('dead-unresolved');
  });
});

describe('incremental reachability downgrade is safe across the affected-files window boundary (issue #2255)', () => {
  let boundaryTmpDir: string, boundaryDbPath: string;

  beforeAll(() => {
    boundaryTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-incremental-boundary-'));
    fs.mkdirSync(path.join(boundaryTmpDir, '.codegraph'));
    boundaryDbPath = path.join(boundaryTmpDir, '.codegraph', 'graph.db');

    const db = new Database(boundaryDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    insertNode(db, 'src/entry.ts', 'file', 'src/entry.ts', 0);
    insertNode(db, 'src/helpers.ts', 'file', 'src/helpers.ts', 0);
    insertNode(db, 'src/deep.ts', 'file', 'src/deep.ts', 0);

    // publicEntry (exported) -> helperA -> helperB. helperA's ONLY caller is
    // publicEntry, two hops away from the changed file (src/deep.ts) — outside
    // the incrementally-scoped "changed files + one-hop neighbours" window,
    // which only pulls in src/helpers.ts (a direct neighbour of deep.ts via
    // the helperA->helperB edge), not src/entry.ts.
    const publicEntry = insertNode(db, 'publicEntry', 'function', 'src/entry.ts', 1);
    const helperA = insertNode(db, 'helperA', 'function', 'src/helpers.ts', 1);
    const helperB = insertNode(db, 'helperB', 'function', 'src/deep.ts', 1);
    db.prepare('UPDATE nodes SET exported = 1 WHERE id = ?').run(publicEntry);
    insertEdge(db, publicEntry, helperA, 'calls');
    insertEdge(db, helperA, helperB, 'calls');

    // Simulate src/deep.ts being the only changed file — src/entry.ts is
    // never in `allAffectedFiles`.
    classifyNodeRoles(db, ['src/deep.ts']);
    db.close();
  });

  afterAll(() => {
    if (boundaryTmpDir) fs.rmSync(boundaryTmpDir, { recursive: true, force: true });
  });

  test('helperA is NOT wrongly downgraded to dead merely because its only caller is outside the window', () => {
    // Without considering outside-window nodes as potential roots, helperA's
    // only caller (publicEntry) would be invisible to the reachability BFS,
    // and helperA (fanIn=1, a genuine downgrade candidate) would be wrongly
    // marked dead — exactly the false positive this fix must never produce.
    const data = rolesData(boundaryDbPath);
    const result = data.symbols.find((s) => s.name === 'helperA');
    expect(result).toBeDefined();
    expect(result!.role).not.toMatch(/^dead/);
  });

  test('helperB stays live too, transitively through helperA', () => {
    const data = rolesData(boundaryDbPath);
    const result = data.symbols.find((s) => s.name === 'helperB');
    expect(result).toBeDefined();
    expect(result!.role).not.toMatch(/^dead/);
  });
});

// ─── rolesData ──────────────────────────────────────────────────────────

describe('rolesData', () => {
  test('returns all classified symbols with correct counts', () => {
    const data = rolesData(dbPath);
    expect(data.count).toBeGreaterThan(0);
    expect(data.summary).toBeDefined();
    expect(Object.keys(data.summary).length).toBeGreaterThan(0);
    // Every symbol should have a role
    for (const s of data.symbols) {
      expect(s.role).toBeTruthy();
    }
  });

  test('dead role includes unused function', () => {
    const data = rolesData(dbPath, { role: 'dead' });
    const names = data.symbols.map((s) => s.name);
    expect(names).toContain('unused');
  });

  test('filters by role (dead matches all sub-roles)', () => {
    const data = rolesData(dbPath, { role: 'dead' });
    for (const s of data.symbols) {
      expect(s.role).toMatch(/^dead/);
    }
  });

  test('filters by file', () => {
    const data = rolesData(dbPath, { file: 'lib.js' });
    for (const s of data.symbols) {
      expect(s.file).toContain('lib.js');
    }
  });

  test('filters by noTests', () => {
    const withTests = rolesData(dbPath);
    const withoutTests = rolesData(dbPath, { noTests: true });
    expect(withoutTests.count).toBeLessThan(withTests.count);
    for (const s of withoutTests.symbols) {
      expect(s.file).not.toMatch(/\.test\./);
    }
  });

  // Regression guard for #2390: `--role <X>` with zero matches must be able to
  // tell "this role has no matches" apart from "the graph has no classified
  // symbols at all" — both cases return count:0, but only totalClassified
  // distinguishes them.
  test('totalClassified reflects the full graph, unaffected by an unmatched role filter', () => {
    const unfiltered = rolesData(dbPath);
    const noMatches = rolesData(dbPath, { role: 'entry-fixture-nonexistent-role' });
    expect(noMatches.count).toBe(0);
    expect(noMatches.totalClassified).toBe(unfiltered.count);
    expect(noMatches.totalClassified).toBeGreaterThan(0);
  });

  test('totalClassified equals count when no role filter is applied', () => {
    const data = rolesData(dbPath);
    expect(data.totalClassified).toBe(data.count);
  });

  test('totalClassified respects the file filter (matches the same-file unfiltered count)', () => {
    const unfilteredForFile = rolesData(dbPath, { file: 'lib.js' });
    const noMatchesForFile = rolesData(dbPath, {
      file: 'lib.js',
      role: 'entry-fixture-nonexistent-role',
    });
    expect(noMatchesForFile.count).toBe(0);
    expect(noMatchesForFile.totalClassified).toBe(unfilteredForFile.count);
    expect(noMatchesForFile.totalClassified).toBeGreaterThan(0);
  });

  // Regression guard for Greptile's #2531 review finding: a --file/--no-tests
  // scope that excludes every classified symbol must not be conflated with a
  // genuinely unbuilt graph either — totalClassified (scoped) is 0 in this
  // case too, so totalClassifiedUnscoped (ignoring every filter) is needed to
  // show the graph is fine outside the requested scope.
  test('totalClassifiedUnscoped reports the graph-wide count when a --file scope excludes everything', () => {
    const unfiltered = rolesData(dbPath);
    const emptyFileScope = rolesData(dbPath, { file: 'nonexistent-file.js' });
    expect(emptyFileScope.count).toBe(0);
    expect(emptyFileScope.totalClassified).toBe(0);
    expect(emptyFileScope.totalClassifiedUnscoped).toBe(unfiltered.count);
    expect(emptyFileScope.totalClassifiedUnscoped).toBeGreaterThan(0);
  });

  test('totalClassifiedUnscoped reports the graph-wide count when file+noTests excludes everything', () => {
    const unfiltered = rolesData(dbPath);
    // app.test.js is the only file matching this filter, and noTests removes it too.
    const emptyScope = rolesData(dbPath, { file: 'app.test.js', noTests: true });
    expect(emptyScope.count).toBe(0);
    expect(emptyScope.totalClassified).toBe(0);
    expect(emptyScope.totalClassifiedUnscoped).toBe(unfiltered.count);
    expect(emptyScope.totalClassifiedUnscoped).toBeGreaterThan(0);
  });

  test('totalClassifiedUnscoped is not computed when the graph genuinely has no classified symbols', () => {
    const emptyDb = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-roles-empty-'));
    fs.mkdirSync(path.join(emptyDb, '.codegraph'));
    const emptyDbPath = path.join(emptyDb, '.codegraph', 'graph.db');
    const db = new Database(emptyDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.close();

    const data = rolesData(emptyDbPath);
    expect(data.count).toBe(0);
    expect(data.totalClassified).toBe(0);
    expect(data.totalClassifiedUnscoped).toBeUndefined();

    fs.rmSync(emptyDb, { recursive: true, force: true });
  });
});

// ─── statsData includes roles ───────────────────────────────────────────

describe('statsData with roles', () => {
  test('includes roles distribution', () => {
    const data = statsData(dbPath);
    expect(data.roles).toBeDefined();
    expect(Object.keys(data.roles).length).toBeGreaterThan(0);
    // Should have a dead sub-role for the unused function
    expect(data.deadTotal).toBeGreaterThanOrEqual(1);
  });

  test('roles distribution respects noTests filter', () => {
    const withTests = statsData(dbPath);
    const withoutTests = statsData(dbPath, { noTests: true });
    const totalWith = Object.values(withTests.roles).reduce((a, b) => a + b, 0);
    const totalWithout = Object.values(withoutTests.roles).reduce((a, b) => a + b, 0);
    expect(totalWithout).toBeLessThanOrEqual(totalWith);
  });

  test('roles map does not carry an aggregate "dead" peer key', () => {
    // Regression test for #2383: `dead` used to be injected into the flat
    // roles map as the sum of its own dead-* sub-roles, double-counting
    // every dead symbol in any total over the map.
    const data = statsData(dbPath);
    expect(data.roles.dead).toBeUndefined();
    const deadSubRoleTotal = Object.entries(data.roles)
      .filter(([role]) => role.startsWith('dead-'))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(data.deadTotal).toBe(deadSubRoleTotal);
  });
});

// ─── whereData includes role ────────────────────────────────────────────

describe('whereData with roles', () => {
  test('includes role field in symbol results', () => {
    const data = whereData('main', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    const mainResult = data.results.find((r) => r.name === 'main');
    expect(mainResult).toBeDefined();
    expect(mainResult).toHaveProperty('role');
    expect(mainResult.role).toBeTruthy();
  });

  test('dead function has dead role', () => {
    const data = whereData('unused', dbPath);
    const unusedResult = data.results.find((r) => r.name === 'unused');
    expect(unusedResult).toBeDefined();
    expect(unusedResult.role).toMatch(/^dead/);
  });
});

// ─── explainData includes role ──────────────────────────────────────────

describe('explainData with roles', () => {
  test('function explain includes role field', () => {
    const data = explainData('main', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    const mainResult = data.results.find((r) => r.name === 'main');
    expect(mainResult).toBeDefined();
    expect(mainResult).toHaveProperty('role');
  });

  test('file explain includes role in symbols', () => {
    const data = explainData('lib.js', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    const fileResult = data.results[0];
    // Check publicApi and internal arrays for role field
    const allSymbols = [...(fileResult.publicApi || []), ...(fileResult.internal || [])];
    expect(allSymbols.length).toBeGreaterThan(0);
    for (const s of allSymbols) {
      expect(s).toHaveProperty('role');
    }
  });
});

// ─── listFunctionsData includes role ────────────────────────────────────

describe('listFunctionsData with roles', () => {
  test('includes role field in function listings', () => {
    const data = listFunctionsData(dbPath);
    expect(data.count).toBeGreaterThan(0);
    // At least some should have roles
    const withRoles = data.functions.filter((f) => f.role);
    expect(withRoles.length).toBeGreaterThan(0);
  });
});
