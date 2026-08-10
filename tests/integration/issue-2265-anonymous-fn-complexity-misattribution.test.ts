/**
 * Integration test for #2265: `handleVarFnAssignment`/`handleVarFnCapture`
 * (extractors/javascript.ts) set a var/const-assigned function's
 * `Definition.line` from the ENCLOSING declaration statement, not the
 * function value's own node — so `const a = fn1, b = fn2;` gave every
 * declarator but the first the wrong `line`. `storeComplexityResults`/
 * `storeCfgResults` (ast-analysis/apply-results.ts) index visitor results by
 * each function node's own (correct) real line, then disambiguate same-line
 * ties via `name` — always null for an anonymous arrow/function-expression
 * value, so the mismatched `Definition.line` silently misattributed one
 * sibling's complexity/CFG onto another.
 *
 * Fix: `Definition.line`/`column` now come from the function value's own
 * node (mirrored in Rust's `handle_var_decl`), and `matchResultToDef`/
 * `matchNativeResult` prefer an exact column match before falling back to
 * name/first-candidate — closing the residual gap for two genuinely
 * same-line anonymous functions the line fix alone can't resolve.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'multiDeclarator.js': `
const a = (x) => {
  if (x) { return 1; }
  return 0;
}, b = (x) => {
  return 2;
};
a(1); b(2);
`,
  'sameLine.js': `
function outer(x) { if (x) { return 1; } return 0; }

const same1 = (y) => { return y; }, same2 = (y) => { if (y) {
  return 3;
}
return 4; };
same1(1); same2(2); outer(3);
`,
};

function readComplexity(dbPath: string, name: string): { cyclomatic: number; cognitive: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT fc.cyclomatic AS cyclomatic, fc.cognitive AS cognitive
         FROM function_complexity fc
         JOIN nodes n ON fc.node_id = n.id
         WHERE n.name = ?`,
      )
      .get(name) as { cyclomatic: number; cognitive: number } | undefined;
    expect(row, `no function_complexity row found for ${name}`).toBeDefined();
    return row!;
  } finally {
    db.close();
  }
}

function runShared(getDbPath: () => string) {
  it('gives each declarator in a multi-declarator statement its own, correctly-attributed complexity', () => {
    // `a` branches (cyclomatic 2); `b` does not (cyclomatic 1). Before the
    // fix, both got Definition.line=1 (the statement start) while only
    // `a`'s real complexity result was ever indexed there — `b` silently
    // inherited `a`'s metrics.
    const a = readComplexity(getDbPath(), 'a');
    const b = readComplexity(getDbPath(), 'b');
    expect(a.cyclomatic).toBe(2);
    expect(a.cognitive).toBe(1);
    expect(b.cyclomatic).toBe(1);
    expect(b.cognitive).toBe(0);
  });

  it('disambiguates two genuinely same-line anonymous functions by column', () => {
    // same1 and same2's arrow functions start on the identical physical
    // line (only their columns differ) — same1 has no branch, same2 does.
    const same1 = readComplexity(getDbPath(), 'same1');
    const same2 = readComplexity(getDbPath(), 'same2');
    expect(same1.cyclomatic).toBe(1);
    expect(same1.cognitive).toBe(0);
    expect(same2.cyclomatic).toBe(2);
    expect(same2.cognitive).toBe(1);
  });
}

describe('var/const-assigned anonymous function complexity misattribution (#2265) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2265-'));
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
  'var/const-assigned anonymous function complexity misattribution (#2265) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2265-native-'));
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
