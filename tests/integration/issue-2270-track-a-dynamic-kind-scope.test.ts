/**
 * Regression/contract test for #2270.
 *
 * Found while implementing #2042: ADR-002 and issue #2042's own framing
 * implied that an extractor-level `dynamicKind` tag (e.g. `computed-literal`
 * on `obj["foo"]()`) makes a call site visible via `codegraph roles
 * --dynamic`. Empirically, that's never been true for ANY language,
 * including JavaScript's own reference implementation — the tag exists on
 * the extractor's `Call`, but `emitDirectCallEdgesForCall` (and every other
 * resolved-edge emission path, both engines) hardcodes the persisted edge
 * row's `dynamic_kind` column to NULL. Only the flag-only sink-edge path
 * (`FLAG_ONLY_DYNAMIC_KINDS`: unresolved `eval`/`computed-key`/
 * `unresolved-dynamic`/`reflection`) ever writes a non-NULL `dynamic_kind`.
 *
 * Resolution (not a code change): per ADR-002's own text, `codegraph roles
 * --dynamic`'s whole purpose is surfacing calls that would otherwise be
 * silently dropped ("never silently dropped" guarantee) — a Track A call
 * that resolves successfully was never at risk of that, so nothing here was
 * ever silently dropped for it to surface. Confirmed this is intentional,
 * not an oversight, and NOT safe to "fix" by threading `dynamicKind` through
 * resolved edges too: `incremental.ts`/`native-orchestrator.ts` already use
 * `dynamic_kind IS NULL` (alongside `technique IS NULL`) to find edges due a
 * `technique` backfill — repurposing the column for Track A would silently
 * exclude those edges from it. See the `DynamicKind` doc comment in
 * `src/types.ts` for the full rationale.
 *
 * This test locks in the current (correct, intentional) behavior as an
 * explicit, tested contract on both engines, so it can't silently regress
 * — or silently "fix itself" into the unsafe direction — without a test
 * failure forcing a conscious decision.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'repro.js': `
function handler() { return 1; }
const obj = { handler };
function run() {
  return obj["handler"]();
}
`,
};

function readCallEdge(
  dbPath: string,
  sourceName: string,
  targetName: string,
): { dynamic: number; dynamic_kind: string | null; confidence: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT e.dynamic AS dynamic, e.dynamic_kind AS dynamic_kind, e.confidence AS confidence
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND s.name = ? AND t.name = ?`,
      )
      .get(sourceName, targetName) as
      | { dynamic: number; dynamic_kind: string | null; confidence: number }
      | undefined;
    expect(row, `no calls edge found from ${sourceName} to ${targetName}`).toBeDefined();
    return row!;
  } finally {
    db.close();
  }
}

function countDynamicKindRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS cnt FROM edges WHERE dynamic_kind IS NOT NULL`)
      .get() as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function runShared(getDbPath: () => string) {
  it('resolves the computed-literal call to a real, high-confidence edge', () => {
    const edge = readCallEdge(getDbPath(), 'run', 'handler');
    expect(edge.dynamic).toBe(1);
    expect(edge.confidence).toBeGreaterThan(0);
  });

  it('does not persist dynamic_kind on the resolved Track A edge (intentional, #2270)', () => {
    const edge = readCallEdge(getDbPath(), 'run', 'handler');
    expect(edge.dynamic_kind).toBeNull();
  });

  it('is not surfaced by the dynamic_kind IS NOT NULL query codegraph roles --dynamic uses', () => {
    // dynamicCallsData (src/domain/analysis/roles.ts) — the query backing
    // `codegraph roles --dynamic` — is exactly `WHERE dynamic_kind IS NOT
    // NULL`. Nothing in this single-call fixture should ever match it.
    expect(countDynamicKindRows(getDbPath())).toBe(0);
  });
}

describe('Track A resolved dynamic calls do not persist dynamic_kind (#2270) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2270-'));
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
  'Track A resolved dynamic calls do not persist dynamic_kind (#2270) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2270-native-'));
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
