/**
 * Integration test for #2285: WASM complexity/CFG visitors never run for a
 * file where every function/method definition happens to have its entire
 * body on a single line (a common style for simple getters, one-line guard
 * returns, or C# expression-bodied members `=> expr;`).
 *
 * The file-level "does this file need a WASM complexity/CFG pass" gate
 * (`hasFuncBody(d) && !d.complexity`, `ast-analysis/engine.ts` and its
 * duplicates in `features/complexity.ts`, `features/cfg.ts`, and
 * `domain/wasm-worker-entry.ts`) used `hasFuncBody()`, which required
 * `endLine > line` in addition to `!bodyless`. When *every* definition in a
 * file was single-line, every one failed that requirement, the gate never
 * fired for the whole file, and the file got zero complexity/CFG data even
 * though every function in it has a real, bodied, computable implementation.
 *
 * The fix removes the `endLine > line` requirement from `hasFuncBody()`
 * entirely — `bodyless` (issue #1922) is now the sole, reliable signal for
 * "has a real body" — fixing every one of that predicate's callers at once.
 *
 * This is a pre-existing, independent bug from #2055 (confirmed present
 * before that issue's own fix — the file-level gate was not touched by that
 * PR); it is a distinct latent bug in the file-level gate, not introduced by
 * it. The gate fix itself is purely a WASM/native-orchestration (TS-side)
 * gating decision — the native engine's own inline complexity/CFG
 * computation has no such gate and is unaffected (verified manually: a
 * fresh native build of the C# fixture below already computes complexity
 * for both single-line methods correctly), so that part needed no
 * native/Rust-side change.
 *
 * Greptile review, PR #2452, round 1, surfaced a related but distinct gap:
 * removing `endLine > line` means `hasFuncBody()` now trusts `bodyless`
 * alone, so any extractor that omits the field entirely (rather than
 * explicitly setting it `false`) would have every one of its definitions
 * treated as bodied. Swift's own extractor (both TS and Rust) turned out to
 * do exactly that for protocol method signatures — but not because it
 * merely forgot the flag: it was matching the wrong tree-sitter node type
 * (`function_declaration` instead of the grammar's distinct
 * `protocol_function_declaration`), so protocol methods were silently
 * dropped from the graph *entirely*, on both engines. Fixed alongside the
 * gate itself: both extractors now recognize the correct node type and set
 * `bodyless: true` unconditionally for it (the grammar guarantees that node
 * type never has a body).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// The exact repro from the issue: every real definition (interface stubs
// aside) has its entire body on one line.
const FIXTURE = {
  'Repo2.cs': `
interface IRepo2 {
    bool Save(string id, int value);
    bool SaveOneLine(string id, int value) => value >= 0;
}
class Repo2 : IRepo2 {
    public bool Save(string id, int value) { return true; }
    public bool SaveOneLine(string id, int value) => value >= 0;
}
`,
};

let tmpDir: string;
let dbPath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2285-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(tmpDir, rel), content);
  }
  await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function complexityRows(): Array<{ name: string; cyclomatic: number }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n.name AS name, fc.cyclomatic AS cyclomatic
         FROM function_complexity fc
         JOIN nodes n ON n.id = fc.node_id
         WHERE n.file = 'Repo2.cs'
         ORDER BY n.name`,
      )
      .all() as Array<{ name: string; cyclomatic: number }>;
  } finally {
    db.close();
  }
}

function cfgBlockCount(nodeName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM cfg_blocks b
         JOIN nodes n ON n.id = b.function_node_id
         WHERE n.file = 'Repo2.cs' AND n.name = ?`,
      )
      .get(nodeName) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

describe('issue #2285: WASM complexity/CFG file-level gate with all-single-line-function files', () => {
  it('computes complexity for both genuinely bodied single-line methods, not zero', () => {
    const rows = complexityRows();
    const names = rows.map((r) => r.name);
    // The two real, bodied methods (a class method with a braced one-line
    // body, and a default-interface-method expression body) must both get
    // real complexity data — not an empty result for the whole file.
    expect(names).toContain('Repo2.Save');
    expect(names).toContain('Repo2.SaveOneLine');
    for (const r of rows) {
      expect(r.cyclomatic).toBeGreaterThanOrEqual(1);
    }
  });

  it('does not give the bodyless interface stub a spurious complexity entry', () => {
    const rows = complexityRows();
    expect(rows.map((r) => r.name)).not.toContain('IRepo2.Save');
  });

  it('computes CFG blocks for both genuinely bodied single-line methods', () => {
    expect(cfgBlockCount('Repo2.Save')).toBeGreaterThan(0);
    expect(cfgBlockCount('Repo2.SaveOneLine')).toBeGreaterThan(0);
  });
});

const SWIFT_FIXTURE = {
  'Repo3.swift': `
protocol IRepo3 {
    func save(id: String, value: Int) -> Bool
}
class Repo3: IRepo3 {
    func save(id: String, value: Int) -> Bool { return true }
}
`,
};

function swiftSymbolRows(
  swiftDbPath: string,
): Array<{ name: string; kind: string; hasComplexity: number }> {
  const db = new Database(swiftDbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n.name AS name, n.kind AS kind,
                (SELECT COUNT(*) FROM function_complexity fc WHERE fc.node_id = n.id) AS hasComplexity
         FROM nodes n
         WHERE n.file = 'Repo3.swift'
         ORDER BY n.name`,
      )
      .all() as Array<{ name: string; kind: string; hasComplexity: number }>;
  } finally {
    db.close();
  }
}

function runSwiftShared(getDbPath: () => string) {
  it('extracts the protocol method signature instead of silently dropping it', () => {
    const rows = swiftSymbolRows(getDbPath());
    const proto = rows.find((r) => r.name === 'IRepo3.save');
    expect(proto).toBeDefined();
    expect(proto?.kind).toBe('method');
  });

  it('does not give the bodyless protocol method signature a spurious complexity entry', () => {
    const rows = swiftSymbolRows(getDbPath());
    const proto = rows.find((r) => r.name === 'IRepo3.save');
    expect(proto?.hasComplexity).toBe(0);
  });

  it('still computes complexity for the real, bodied class method', () => {
    const rows = swiftSymbolRows(getDbPath());
    const real = rows.find((r) => r.name === 'Repo3.save');
    expect(real?.hasComplexity).toBe(1);
  });
}

describe('issue #2285 (Greptile review, PR #2452): Swift protocol method extraction — WASM', () => {
  let swiftTmpDir: string;

  beforeAll(async () => {
    swiftTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2285-swift-'));
    for (const [rel, content] of Object.entries(SWIFT_FIXTURE)) {
      fs.writeFileSync(path.join(swiftTmpDir, rel), content);
    }
    await buildGraph(swiftTmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(swiftTmpDir, { recursive: true, force: true });
  });

  runSwiftShared(() => path.join(swiftTmpDir, '.codegraph', 'graph.db'));
});

describe.skipIf(!isNativeAvailable())(
  'issue #2285 (Greptile review, PR #2452): Swift protocol method extraction — native',
  () => {
    let swiftNativeTmpDir: string;

    beforeAll(async () => {
      swiftNativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2285-swift-native-'));
      for (const [rel, content] of Object.entries(SWIFT_FIXTURE)) {
        fs.writeFileSync(path.join(swiftNativeTmpDir, rel), content);
      }
      await buildGraph(swiftNativeTmpDir, {
        engine: 'native',
        incremental: false,
        skipRegistry: true,
      });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(swiftNativeTmpDir, { recursive: true, force: true });
    });

    runSwiftShared(() => path.join(swiftNativeTmpDir, '.codegraph', 'graph.db'));
  },
);
