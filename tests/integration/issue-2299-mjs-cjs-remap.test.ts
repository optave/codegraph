/**
 * Regression test for #2299: import resolution never remapped a `.mjs`/
 * `.cjs` specifier to an actual `.mts`/`.cts` source file, unlike the
 * existing `.js` → `.ts`/`.tsx` remap.
 *
 * TypeScript's NodeNext/Node16 module resolution requires the *emitted*
 * extension in relative import specifiers, not the source extension: a
 * `.mts` file is imported via `import './foo.mjs'` (not `'./foo.mts'`), and
 * a `.cts` file's CJS output is `.cjs`. Before the fix, `remapJsToTs`
 * (`src/domain/graph/resolve.ts`) and its native mirror
 * `probe_js_to_ts_remap` (`crates/codegraph-core/src/domain/graph/resolve.rs`)
 * only checked for a trailing `.js`, so `.mjs`/`.cjs` specifiers never got
 * remapped — the resulting `calls` edge fell back to same-directory
 * proximity scoring (confidence 0.7) instead of the 1.0 an import-aware
 * match gets.
 *
 * Fixture mirrors the issue's own repro: `util.mts` exporting `greet`,
 * imported by `index.mts` via `./util.mjs` (the `.mjs`/`.mts` pair), plus an
 * analogous `.cjs`/`.cts` pair (`legacyUtil.cts` imported by `legacy.cts` via
 * `./legacyUtil.cjs`) to cover both remaps independently.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE: Record<string, string> = {
  'util.mts': `export function greet(): string {
  return "hi";
}
`,
  'index.mts': `import { greet } from './util.mjs';

export function main(): string {
  return greet();
}
`,
  'legacyUtil.cts': `export function shout(): string {
  return "HI";
}
`,
  'legacy.cts': `import { shout } from './legacyUtil.cjs';

export function legacyMain(): string {
  return shout();
}
`,
};

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('.mjs/.cjs → .mts/.cts import resolution (#2299, %s)', (engine) => {
  let tmpDir: string;
  let callEdges: Array<{ src: string; tgt: string; tgt_file: string; confidence: number }>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2299-${engine}-`));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });

    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      callEdges = db
        .prepare(
          `SELECT n1.name AS src, n2.name AS tgt, n2.file AS tgt_file, e.confidence AS confidence
           FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind = 'calls' AND n1.name IN ('main', 'legacyMain')
           ORDER BY n1.name`,
        )
        .all() as Array<{ src: string; tgt: string; tgt_file: string; confidence: number }>;
    } finally {
      db.close();
    }
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves .mjs → .mts at import-aware confidence, not proximity fallback', () => {
    expect(
      callEdges,
      `Expected a calls edge main -> greet at confidence 1.0.\nEdges: ${JSON.stringify(callEdges, null, 2)}`,
    ).toContainEqual(
      expect.objectContaining({
        src: 'main',
        tgt: 'greet',
        tgt_file: 'util.mts',
        confidence: 1.0,
      }),
    );
  });

  it('resolves .cjs → .cts at import-aware confidence, not proximity fallback', () => {
    expect(
      callEdges,
      `Expected a calls edge legacyMain -> shout at confidence 1.0.\nEdges: ${JSON.stringify(callEdges, null, 2)}`,
    ).toContainEqual(
      expect.objectContaining({
        src: 'legacyMain',
        tgt: 'shout',
        tgt_file: 'legacyUtil.cts',
        confidence: 1.0,
      }),
    );
  });
});
