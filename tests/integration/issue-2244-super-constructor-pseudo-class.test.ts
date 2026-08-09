/**
 * Regression test for #2244: `class D extends A { constructor(y) {
 * super(y); } }` where `A` is an ES5-style function-based pseudo-class
 * (`function A(x) { ... }`, not an ES6 `class`) caused `resolveCallTargets`
 * (`call-resolver.ts`, mirrored by `resolve_call_targets_core` in
 * `build_edges.rs`) to fabricate a `calls` edge from `D.constructor` to any
 * unrelated same-named `constructor` declaration reachable via the bare
 * same-file lookup or the project-wide "exact global match" fallback tier —
 * because `A` has no qualified `A.constructor` node for `resolveThisDispatch`
 * (cha.ts's CHA ancestor walk) to find, and neither engine's `super`
 * resolution excluded coincidental same-name matches the way `this`/`self`
 * dispatch legitimately can.
 *
 * The fix excludes `super` from those non-CHA-aware fallback tiers — but
 * ONLY when the caller is inside a REAL class (RECEIVER_KINDS-kind
 * declaration), where `super` is syntactically guaranteed to have a real
 * `extends` target CHA can verify. An object-literal method using dynamic
 * prototype linkage (`Object.setPrototypeOf`, `obj.__proto__ = ...`) has no
 * static `extends` clause for CHA to check at all, so the bare/global
 * fallback must still apply there (jelly-micro's `super`/`super3` fixtures
 * — `resolveThisDispatch` has zero information about the runtime-only
 * prototype link `q2 → q1`, so this is the ONLY way `super.m1()` inside
 * `q2.m2` ever resolves to `q1.m1`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_SOURCE = `
function A(x) {
  this.f = x;
}
A.prototype.speak = function () {
  return 'A';
};

class D extends A {
  constructor(y) {
    super(y);
  }
}

// Unrelated anonymous class with its own bare (unqualified) constructor —
// the exact repro shape that let D.constructor's super(y) fabricate an edge.
const _c3 = class {
  constructor() {}
  speak() {
    return 'anonymous';
  }
};

var q1 = {
  m1() {
    return 'q1.m1';
  },
};
var q2 = {
  m2() {
    super.m1();
  },
};
Object.setPrototypeOf(q2, q1);
q2.m2();
`;

interface CallEdgeRow {
  caller: string;
  callee: string;
  calleeFile: string;
  technique: string | null;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS caller, n2.name AS callee, n2.file AS calleeFile, e.technique
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

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'super() dispatch with a function-style pseudo-class (%s, #2244)',
  (engine) => {
    let tmpDir: string;
    let edges: CallEdgeRow[];

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-2244-${engine}-`));
      fs.writeFileSync(path.join(tmpDir, 'main.js'), FIXTURE_SOURCE);
      await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
      edges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    }, 60_000);

    afterAll(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('D.constructor -> super(y) does not fabricate an edge to an unrelated same-named constructor', () => {
      const wrong = edges.filter((e) => e.caller === 'D.constructor');
      expect(
        wrong,
        `Expected no calls edges from D.constructor.\nActual edges:\n${JSON.stringify(wrong, null, 2)}`,
      ).toEqual([]);
    });

    it('q2.m2 -> super.m1() still resolves to q1.m1 via the dynamic-prototype fallback', () => {
      // Object-literal methods extract as bare (unqualified) names — m2/m1,
      // not q2.m2/q1.m1 — unlike class methods.
      const edge = edges.find((e) => e.caller === 'm2' && e.callee === 'm1');
      expect(
        edge,
        `Expected m2 -> m1 edge (dynamic Object.setPrototypeOf linkage).\nActual edges:\n${JSON.stringify(edges, null, 2)}`,
      ).toBeDefined();
    });
  },
);
