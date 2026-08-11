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
 * it. It is also purely a WASM/native-orchestration (TS-side) gating
 * decision — the native engine's own inline complexity/CFG computation has
 * no such gate and is unaffected (verified manually: a fresh native build of
 * this exact fixture already computes complexity for both single-line
 * methods correctly), so no native/Rust-side change is needed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

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
