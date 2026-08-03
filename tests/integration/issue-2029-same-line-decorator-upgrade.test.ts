/**
 * Engine-parity tests for the same-line decorator upgrade gap in
 * `emitDirectCallEdgesForCall`'s dyn=0 → dyn=1 dedup (#2029).
 *
 * BACKGROUND
 * ──────────
 * #1778 fixed the dedup-collision upgrade path to compare source lines
 * (`callLine < dynZeroEntry.line`) rather than upgrading unconditionally —
 * see issue-1778-reflection-dynamic-kind-parity.test.ts. That comparison is
 * strict, so it only helps when the two calls land on DIFFERENT lines. When a
 * bare decorator and its call-expression sibling share the exact same line
 * (`@Log @Log() class Foo {}`), the query path's two-phase collection still
 * records `@Log()` (dyn=0) before the bare `@Log` (dyn=1) — `line < line` is
 * false, so the upgrade never fires and WASM keeps dyn=0 where native (a
 * single source-order pass) keeps dyn=1.
 *
 * FIX (#2029)
 * ───────────
 * The extractor now tags each bare-decorator Call with `outOfOrder` — computed
 * directly from AST sibling position (`decoratorPrecedesCallSibling` in
 * javascript.ts), not merely "collected by the walk pass" — so it is correct
 * for BOTH textual orderings of a stacked bare/call decorator pair.
 * `emitDirectCallEdgesForCall` only loosens its guard to `<=` when that flag
 * is set, leaving every other dynamicKind (`.call`/`.apply`/`.bind`) on the
 * strict `<` that #1687 depends on — including the same-line variant of that
 * bug, which must still collapse to dyn=0.
 *
 * REVIEW FOLLOW-UP: `decoratorPrecedesCallSibling` must compare a sibling's
 * FULL callee identity (name AND receiver), not just the tail property name —
 * otherwise an unrelated qualified decorator sharing only a tail name (e.g.
 * `@B.Log()` vs `@C.Log()`) could be mistaken for the same callee as a middle
 * bare decorator (`@A.Log`), wrongly marking it out of order. See the
 * `decoratorCallExprIdentity` unit tests below.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { createParsers, extractSymbols } from '../../src/domain/parser.js';

const ENGINES = ['wasm', 'native'] as const;

interface CallEdgeRow {
  source: string;
  target: string;
  confidence: number;
  dynamic: number;
}

function writeFixture(baseDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function readCallEdgesTo(dbPath: string, targetName: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS source, n2.name AS target, e.confidence, e.dynamic
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls' AND n2.name = ?
         ORDER BY n1.name`,
      )
      .all(targetName) as CallEdgeRow[];
  } finally {
    db.close();
  }
}

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore cleanup races */
    }
  }
  tmpDirs = [];
});

async function buildAndReadEdgesTo(
  files: Record<string, string>,
  engine: 'wasm' | 'native',
  targetName: string,
): Promise<CallEdgeRow[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2029-${engine}-`));
  tmpDirs.push(tmpDir);
  writeFixture(tmpDir, files);
  await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
  return readCallEdgesTo(path.join(tmpDir, '.codegraph', 'graph.db'), targetName);
}

describe('#2029: same-line decorator upgrade gap — engine parity', () => {
  it.each(ENGINES)(
    '%s: bare decorator immediately followed by its call-expression form on the SAME line upgrades to dyn=1',
    async (engine) => {
      // True source order: bare `@Log` (dyn=1) genuinely precedes `@Log()`
      // (dyn=0) — native keeps dyn=1 via first-recorded-wins. WASM's query
      // path collects `@Log()` first regardless (phase separation), so the
      // upgrade must fire even though both share line 3.
      const edges = await buildAndReadEdgesTo(
        {
          'index.ts': [
            'export function Log(target: unknown): void {}',
            '',
            '@Log @Log() class Foo {}',
            '',
          ].join('\n'),
        },
        engine,
        'Log',
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].dynamic).toBe(1);
    },
  );

  it.each(ENGINES)(
    '%s: call-expression decorator immediately followed by its bare form on the SAME line stays dyn=0',
    async (engine) => {
      // Mirror of the case above with the two decorators swapped: true source
      // order now has `@Log()` (dyn=0) genuinely FIRST and the bare `@Log`
      // (dyn=1) genuinely SECOND — native's first-recorded-wins keeps dyn=0,
      // and the fix's AST-sibling-position check must recognize this ordering
      // and NOT upgrade, even though both still share one line.
      const edges = await buildAndReadEdgesTo(
        {
          'index.ts': [
            'export function Log(target: unknown): void {}',
            '',
            '@Log() @Log class Foo {}',
            '',
          ].join('\n'),
        },
        engine,
        'Log',
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].dynamic).toBe(0);
    },
  );

  it.each(ENGINES)(
    '%s: direct f() followed by f.call({}) on the SAME line still dedups to a single dyn=0 edge (#1687 same-line variant)',
    async (engine) => {
      // The same-line variant of #1687's regression guard: f() and f.call({})
      // are ordinary call_expressions collected in the same query phase, so
      // true source order is already preserved — the later reflection-style
      // reference to the same target must not flip the edge to dyn=1.
      const edges = await buildAndReadEdgesTo(
        { 'index.js': ['function f() {}', 'f(); f.call({});', ''].join('\n') },
        engine,
        'f',
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].dynamic).toBe(0);
    },
  );
});

describe('#2029: decoratorPrecedesCallSibling — receiver-aware sibling matching', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseTS(code: string) {
    const parser = parsers.get('typescript');
    const tree = parser.parse(code);
    return extractSymbols(tree, 'test.ts');
  }

  it('does not mark a bare decorator out of order because of an unrelated later decorator sharing only its tail name', () => {
    // `@B.Log() @A.Log @C.Log() class Foo {}` — three qualified decorators
    // sharing the tail name "Log" but with three DIFFERENT receivers (A, B,
    // C). The middle bare `@A.Log`'s real callee is `{name: 'Log', receiver:
    // 'A'}` — neither `@B.Log()` (receiver B, precedes it) nor `@C.Log()`
    // (receiver C, follows it) targets that callee. Matching on the tail name
    // "Log" alone would wrongly treat the later `@C.Log()` as proof `@A.Log`
    // is out of order.
    const symbols = parseTS(['@B.Log() @A.Log @C.Log() class Foo {}', ''].join('\n'));
    const bareA = symbols.calls.find(
      (c) => c.name === 'Log' && c.receiver === 'A' && c.dynamicKind === 'reflection',
    );
    expect(bareA).toBeDefined();
    expect(bareA?.outOfOrder).toBe(false);
  });

  it('still marks a qualified bare decorator out of order when a later sibling targets the exact same callee (name AND receiver)', () => {
    // `@A.Log @A.Log() class Foo {}` — the genuine #2029 scenario through a
    // qualified (member-expression) decorator: same receiver AND name.
    const symbols = parseTS(['@A.Log @A.Log() class Foo {}', ''].join('\n'));
    const bareA = symbols.calls.find(
      (c) => c.name === 'Log' && c.receiver === 'A' && c.dynamicKind === 'reflection',
    );
    expect(bareA).toBeDefined();
    expect(bareA?.outOfOrder).toBe(true);
  });
});
