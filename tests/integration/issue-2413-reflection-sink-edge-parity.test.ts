/**
 * Regression test for #2413: a full build of this repo's own `src/` produced
 * a handful of `calls` edges on WASM that native never emitted, all sharing
 * one shape — a `.call()`/`.apply()`/`.bind()` invocation whose wrapped
 * function doesn't resolve to any project definition (e.g.
 * `Object.prototype.toString.call(x)`, or `obj.method.bind(x)` where `method`
 * matches nothing in scope).
 *
 * Both extractors correctly tag this as a `Call` with `dynamicKind:
 * 'reflection'` (`extractMemberExprCallInfo` / `extract_member_expr_call_info`
 * — verified identical). The divergence was purely downstream: WASM's sink-edge
 * step consults the shared `FLAG_ONLY_DYNAMIC_KINDS` set (`shared/kinds.ts`,
 * which includes `'reflection'`) to decide whether an unresolved dynamic call
 * gets a `(caller -> file)` sink edge instead of being silently dropped;
 * native's mirror of that step (`build_edges.rs`) hardcoded a 3-member list
 * that omitted `'reflection'`, so the same call was extracted identically but
 * its sink edge was dropped.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE = `
class Repository {}

function wrapInjectedRepo(repo: Repository): { repo: Repository; close(): void } {
  if (!(repo instanceof Repository)) {
    throw new TypeError(
      \`got \${Object.prototype.toString.call(repo)}\`,
    );
  }
  return { repo, close() {} };
}
`;

interface SinkEdgeRow {
  callerName: string;
  targetFile: string;
  targetKind: string;
  dynamic: number;
  dynamicKind: string | null;
}

function readReflectionSinkEdges(dbPath: string): SinkEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT s.name AS callerName, t.file AS targetFile, t.kind AS targetKind,
                e.dynamic AS dynamic, e.dynamic_kind AS dynamicKind
         FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.kind = 'calls' AND e.dynamic_kind = 'reflection'`,
      )
      .all() as SinkEdgeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'reflection-kind dynamic sink edge parity (#2413) — engine: %s',
  (engine) => {
    it('emits a (caller -> file) sink edge for an unresolved .call() reflection invocation', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2413-${engine}-`));
      try {
        fs.writeFileSync(path.join(dir, 'sample.ts'), FIXTURE);
        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });

        const sinkEdges = readReflectionSinkEdges(path.join(dir, '.codegraph', 'graph.db'));
        const edge = sinkEdges.find((e) => e.callerName === 'wrapInjectedRepo');

        expect(edge).toBeDefined();
        expect(edge?.targetKind).toBe('file');
        expect(edge?.targetFile).toBe('sample.ts');
        expect(edge?.dynamic).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
