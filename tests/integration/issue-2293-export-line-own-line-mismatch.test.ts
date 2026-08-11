/**
 * Integration test for #2293: `collectExportedDeclarations`/
 * `collect_exported_var_declarations` (extractors/javascript.ts,
 * crates/codegraph-core/src/extractors/javascript.rs) computed a single
 * export line from the wrapping `export_statement` node and applied it to
 * every branch, while the matching `Definition` row for that same
 * declaration is created from the declaration's own node (or, for a
 * function-valued declarator, the function value's own node — #2265).
 *
 * Whenever `export` and its declaration start on different source lines —
 * syntactically valid JS, since ASI does not apply between `export` and its
 * declaration — the two lines diverged, and the `exported = 1` UPDATE
 * (matched by name/kind/file/line, see #1728) silently never fired: the
 * symbol was inserted as a genuine top-level definition but never marked
 * exported.
 *
 * Fix: the export line now comes from the same node each branch's
 * Definition already uses — the declaration node itself, or the function
 * value node for function-valued declarators — so the two rows always match.
 *
 * Note: a bare `export\nconst x = 5;` doesn't reach this code path at all —
 * tree-sitter-javascript fails to parse a newline-separated bare `export`
 * followed by a declaration keyword as a single `export_statement` (filed
 * separately as #2459). `export default` is parsed correctly across a
 * newline, so it's used below to exercise the line fix itself.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'defaultClass.js': `export default
class Widget {}
`,
  'defaultFunction.js': `export default
function greet() {}
`,
  'multiBinding.js': `export const first = () => 1,
  second = () => 2;
`,
};

function readNode(dbPath: string, name: string): { line: number; exported: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT line, exported FROM nodes WHERE name = ?`).get(name) as
      | { line: number; exported: number }
      | undefined;
    expect(row, `no node row found for ${name}`).toBeDefined();
    return row!;
  } finally {
    db.close();
  }
}

function runShared(getDbPath: () => string) {
  it("marks a default-exported class as exported at the class declaration's own line", () => {
    const row = readNode(getDbPath(), 'Widget');
    expect(row.line).toBe(2);
    expect(row.exported).toBe(1);
  });

  it("marks a default-exported function as exported at the function declaration's own line", () => {
    const row = readNode(getDbPath(), 'greet');
    expect(row.line).toBe(2);
    expect(row.exported).toBe(1);
  });

  it('marks each declarator in a multi-binding exported const as exported at its own function-value line', () => {
    const first = readNode(getDbPath(), 'first');
    const second = readNode(getDbPath(), 'second');
    expect(first.line).toBe(1);
    expect(first.exported).toBe(1);
    expect(second.line).toBe(2);
    expect(second.exported).toBe(1);
  });
}

describe('export line matches the declaration, not the `export` keyword (#2293) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2293-'));
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
  'export line matches the declaration, not the `export` keyword (#2293) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2293-native-'));
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
