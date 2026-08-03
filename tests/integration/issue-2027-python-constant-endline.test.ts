/**
 * Regression test for #2027: calls after the first module-level SCREAMING_CASE
 * constant mis-attribute to that first constant.
 *
 * Root cause: `handlePyExpressionStmt` (src/extractors/python.ts) pushed a
 * `constant` definition for a module-level `NAME = expr` assignment without
 * setting `endLine`. `findEnclosingBinding` (call-resolver.ts) picks the
 * *widest* enclosing `variable`/`constant` binding as a fallback caller when
 * no function/method encloses the call site; with `endLine` missing, every
 * constant's span defaulted to `Infinity`, and the strict `>` tie-break in
 * the widest-span search meant the *first* constant encountered always won
 * — even for calls on lines far below a *later* constant's own line.
 *
 * Fix: `handlePyExpressionStmt` now sets `endLine: nodeEndLine(node)`,
 * mirroring how `handlePyFunctionDef`/`handlePyClassDef` already compute
 * `endLine`. The native Rust extractor (`handle_expr_stmt` in
 * crates/codegraph-core/src/extractors/python.rs) already set `end_line`
 * correctly — this was a WASM/TS-only gap.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

// Exact repro from #2027.
const PY_FIXTURE = `
class Baz:
    def __init__(self):
        self.value = 1

class Qux:
    pass

BAZ = Baz()
QUX = Qux()
`;

interface CallEdgeRow {
  src: string;
  srcKind: string;
  tgt: string;
  tgtKind: string;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.kind AS srcKind, n2.name AS tgt, n2.kind AS tgtKind
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

function runScenario(engine: EngineMode): void {
  describe(`Python module-level constant endLine attribution (#2027) — ${engine}`, () => {
    let dir: string;
    let edges: CallEdgeRow[];

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2027-${engine}-`));
      fs.writeFileSync(path.join(dir, 'repro.py'), PY_FIXTURE);
      await buildGraph(dir, { engine, incremental: false, skipRegistry: true });
      edges = readCallEdges(path.join(dir, '.codegraph', 'graph.db'));
    }, 30_000);

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('QUX() call site does NOT attribute to BAZ (the first constant)', () => {
      expect(edges.some((e) => e.src === 'BAZ' && e.tgt === 'Qux')).toBe(false);
    });

    it('Qux() attributes to QUX (its own enclosing constant binding)', () => {
      expect(edges).toContainEqual({
        src: 'QUX',
        srcKind: 'constant',
        tgt: 'Qux',
        tgtKind: 'class',
      });
    });

    it('Baz() still attributes to BAZ (unaffected by the fix)', () => {
      expect(edges).toContainEqual({
        src: 'BAZ',
        srcKind: 'constant',
        tgt: 'Baz',
        tgtKind: 'class',
      });
    });
  });
}

runScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
