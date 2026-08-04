/**
 * Integration test for #2033: calls inside object-literal-property closures
 * returned from a factory function were misattributed to the enclosing
 * factory, not the property.
 *
 * Root cause: `extractObjectLiteralFunctions` (the mechanism that creates
 * qualified `varName.propName` definitions so calls inside a property
 * closure attribute to the property, not the enclosing scope) only fired
 * for object literals assigned via a variable declarator (`const x = {...}`)
 * — never for object literals appearing in a `return` statement inside a
 * function body. Calls inside those closures fell through to the generic
 * "nearest enclosing named function" caller-attribution, which resolved to
 * the factory itself — even though the factory's own body never executes
 * that call; only invoking the returned object's property does.
 *
 * Fix: qualify a `return { ... }` statement's object-literal properties
 * against the enclosing named function too (`makePartition.deltaCPM`), and
 * seed the matching typeMap/return-type entries so `const p =
 * makePartition(42); p.deltaModularity(1)` resolves through the qualified
 * definition — closing the loop with #2032's transitive-unreachable
 * dead-code downgrade: `deltaCPM` is never invoked anywhere, so its
 * `computeDeltaCPM` callee is now correctly flagged dead, while
 * `deltaModularity` (invoked via `useIt`) correctly is not.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// `computeDeltaCPM` is wired under `deltaCPM` but `.deltaCPM(...)` never
// appears anywhere in the fixture — genuinely dead. `computeDeltaModularity`
// is wired under `deltaModularity` and IS invoked via `p.deltaModularity(1)`
// in `useIt` — genuinely live.
const FIXTURE = {
  'partition.ts': `
function computeDeltaCPM(s: number, v: number): number {
  return s + v;
}

function computeDeltaModularity(s: number, v: number): number {
  return s * v;
}

export function makePartition(seed: number) {
  const s = seed;
  return {
    deltaCPM: (v: number) => computeDeltaCPM(s, v),
    deltaModularity: (v: number) => computeDeltaModularity(s, v),
  };
}

export function useIt(): number {
  const p = makePartition(42);
  return p.deltaModularity(1); // p.deltaCPM(...) is never called anywhere
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

function findCallerNames(dbPath: string, targetName: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT s.name AS name
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND t.name = ?`,
        )
        .all(targetName) as Array<{ name: string }>
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

describe('object literal returned from a factory qualifies against the factory name (#2033) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2033-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('attributes the call inside the deltaCPM closure to makePartition.deltaCPM, not makePartition', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    expect(findCallerNames(dbPath, 'computeDeltaCPM')).toEqual(['makePartition.deltaCPM']);
  });

  it('attributes the call inside the deltaModularity closure to makePartition.deltaModularity', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    expect(findCallerNames(dbPath, 'computeDeltaModularity')).toEqual([
      'makePartition.deltaModularity',
    ]);
  });

  it('resolves p.deltaModularity(1) in useIt through the qualified definition', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    expect(findCallerNames(dbPath, 'makePartition.deltaModularity')).toEqual(['useIt']);
  });

  it('flags computeDeltaCPM as dead — its only caller (makePartition.deltaCPM) is itself unreachable (#2032)', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    const node = nodes.find((n) => n.name === 'computeDeltaCPM' && n.kind === 'function');
    expect(node, 'computeDeltaCPM node not found').toBeDefined();
    expect(DEAD_ROLES.has(node!.role ?? '')).toBe(true);
  });

  it('does not flag computeDeltaModularity as dead — reachable via useIt', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    const node = nodes.find((n) => n.name === 'computeDeltaModularity' && n.kind === 'function');
    expect(node, 'computeDeltaModularity node not found').toBeDefined();
    expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
  });
});

// ── Native engine parity ────────────────────────────────────────────────────
// Skipped when the native addon is not installed.

describe.skipIf(!isNativeAvailable())(
  'object literal returned from a factory qualifies against the factory name (#2033) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2033-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    it('attributes the call inside the deltaCPM closure to makePartition.deltaCPM, not makePartition', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      expect(findCallerNames(dbPath, 'computeDeltaCPM')).toEqual(['makePartition.deltaCPM']);
    });

    it('attributes the call inside the deltaModularity closure to makePartition.deltaModularity', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      expect(findCallerNames(dbPath, 'computeDeltaModularity')).toEqual([
        'makePartition.deltaModularity',
      ]);
    });

    it('resolves p.deltaModularity(1) in useIt through the qualified definition', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      expect(findCallerNames(dbPath, 'makePartition.deltaModularity')).toEqual(['useIt']);
    });

    it('flags computeDeltaCPM as dead — its only caller (makePartition.deltaCPM) is itself unreachable (#2032)', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      const node = nodes.find((n) => n.name === 'computeDeltaCPM' && n.kind === 'function');
      expect(node, 'computeDeltaCPM node not found (native)').toBeDefined();
      expect(DEAD_ROLES.has(node!.role ?? '')).toBe(true);
    });

    it('does not flag computeDeltaModularity as dead — reachable via useIt', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      const node = nodes.find((n) => n.name === 'computeDeltaModularity' && n.kind === 'function');
      expect(node, 'computeDeltaModularity node not found (native)').toBeDefined();
      expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
    });
  },
);
