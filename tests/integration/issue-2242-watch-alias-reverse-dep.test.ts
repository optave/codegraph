/**
 * Regression test for #2242: `codegraph watch`'s single-file rebuild path
 * (`rebuildFile` in `domain/graph/builder/incremental.ts`) hardcoded an
 * *empty* `PathAliases` object (`{ baseUrl: null, paths: {} }`) at every one
 * of its import-resolution call sites, instead of loading the project's real
 * tsconfig/jsconfig aliases — unlike the full-build pipeline, which threads
 * `ctx.aliases` (loaded once via `loadPathAliases`) throughout.
 *
 * This test covers the *reverse-dep cascade* call site specifically
 * (`rebuildReverseDepEdges`) — distinct from `rebuildEdgesForTargetFile`
 * (the primary touched-file path, covered by the extended assertion in
 * `issue-1967-watch-barrel-rename.test.ts`). When a file is touched under
 * watch, every file that imports it (a "reverse dep") is also reparsed and
 * its own edges rebuilt — if that reverse dep's own imports use a
 * tsconfig/jsconfig alias, the hardcoded-empty-aliases bug dropped its
 * `imports`/`reexports` edges too, not just renamed reexports.
 *
 * Fixture: `utils/foo.ts` exports `realName`; `barrel.ts` re-exports it via
 * an alias-based specifier (`@utils/foo`, no rename); `consumer.ts` imports
 * from `barrel.ts` and calls it. Touching `utils/foo.ts` under watch makes
 * `barrel.ts` a reverse dep (it imports from `utils/foo.ts`) and exercises
 * `rebuildReverseDepEdges`'s alias resolution.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import type { EngineMode } from '../../src/types.js';
import { createIncrementalStmts } from '../helpers/incremental-stmts.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: { baseUrl: '.', paths: { '@utils/*': ['utils/*'] } },
});

const FILES: Record<string, string> = {
  'tsconfig.json': TSCONFIG,
  'utils/foo.ts': `
export function realName(): string {
  return 'real';
}
`,
  'barrel.ts': `
export { realName } from '@utils/foo';
`,
  'consumer.ts': `
import { realName } from './barrel.js';

export function useIt(): string {
  return realName();
}
`,
};

function writeFixture(dir: string) {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function hasReexportsEdge(dbPath: string, fromFile: string, toFile: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE n1.kind = 'file' AND n1.file = ? AND n2.kind = 'file' AND n2.file = ?
         AND e.kind = 'reexports'`,
      )
      .get(fromFile, toFile);
    return row !== undefined;
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'codegraph watch preserves an alias-based reverse-dep edge (#2242) — initial build: %s',
  (engine) => {
    let watchDir: string;
    let dbPath: string;

    beforeAll(async () => {
      watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2242-${engine}-`));
      writeFixture(watchDir);

      await buildGraph(watchDir, { incremental: false, skipRegistry: true, engine });
      dbPath = path.join(watchDir, '.codegraph', 'graph.db');

      // Sanity check: the full build resolved the alias-based reexport.
      expect(hasReexportsEdge(dbPath, 'barrel.ts', 'utils/foo.ts')).toBe(true);

      // Touch the DEEPEST file — barrel.ts (which imports it via alias) is
      // a reverse dep and gets reparsed via rebuildReverseDepEdges.
      const targetFile = path.join(watchDir, 'utils/foo.ts');
      fs.appendFileSync(targetFile, '\n// touch\n');

      const db = openDb(dbPath);
      initSchema(db);
      await rebuildFile(db, watchDir, targetFile, createIncrementalStmts(db), { engine }, null);
      db.close();
    }, 60_000);

    afterAll(() => {
      if (watchDir) fs.rmSync(watchDir, { recursive: true, force: true });
    });

    it("barrel.ts's alias-resolved reexports edge survives the reverse-dep cascade", () => {
      expect(hasReexportsEdge(dbPath, 'barrel.ts', 'utils/foo.ts')).toBe(true);
    });
  },
);

/**
 * Regression coverage for a Greptile finding on this same PR: `rebuildFile`
 * resolved tsconfig/jsconfig aliases correctly but silently excluded
 * aliases configured via `.codegraphrc.json`'s own `aliases` field — which
 * `pipeline.ts`'s full-build `loadAliases` stage merges on top of
 * tsconfig/jsconfig via `mergeConfigAliases`. Fixed by threading
 * `config.aliases` through `EngineOpts.aliases` (set once in
 * `setupWatcher`, mirroring the existing `pointsToMaxIterations` pattern)
 * so `rebuildFile` applies the exact same merge.
 *
 * Fixture deliberately has NO tsconfig.json/jsconfig.json at all — the
 * alias is defined ONLY via `.codegraphrc.json`, isolating this from the
 * tsconfig/jsconfig path already covered above.
 */
const CODEGRAPHRC = JSON.stringify({ aliases: { '@utils/': './utils/' } });

const CONFIG_ALIAS_FILES: Record<string, string> = {
  '.codegraphrc.json': CODEGRAPHRC,
  'utils/foo.ts': `
export function realName(): string {
  return 'real';
}
`,
  'barrel.ts': `
export { realName } from '@utils/foo';
`,
};

function writeConfigAliasFixture(dir: string) {
  for (const [rel, content] of Object.entries(CONFIG_ALIAS_FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

describe.each(ENGINES)(
  'codegraph watch preserves a .codegraphrc.json-configured alias edge (#2242 review) — initial build: %s',
  (engine) => {
    let watchDir: string;
    let dbPath: string;

    beforeAll(async () => {
      watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2242-config-alias-${engine}-`));
      writeConfigAliasFixture(watchDir);

      await buildGraph(watchDir, { incremental: false, skipRegistry: true, engine });
      dbPath = path.join(watchDir, '.codegraph', 'graph.db');

      // Sanity check: the full build resolved the .codegraphrc.json alias.
      expect(hasReexportsEdge(dbPath, 'barrel.ts', 'utils/foo.ts')).toBe(true);

      // Touch barrel.ts directly — exercises rebuildEdgesForTargetFile.
      const barrelFile = path.join(watchDir, 'barrel.ts');
      fs.appendFileSync(barrelFile, '\n// touch\n');

      const db = openDb(dbPath);
      initSchema(db);
      // Mirrors setupWatcher's engineOpts construction (watcher.ts): the
      // real config.aliases threaded through, not a hand-picked value.
      const config = loadConfig(watchDir);
      await rebuildFile(
        db,
        watchDir,
        barrelFile,
        createIncrementalStmts(db),
        { engine, aliases: config.aliases },
        null,
      );
      db.close();
    }, 60_000);

    afterAll(() => {
      if (watchDir) fs.rmSync(watchDir, { recursive: true, force: true });
    });

    it("barrel.ts's .codegraphrc.json-alias-resolved reexports edge survives being reparsed under watch", () => {
      expect(hasReexportsEdge(dbPath, 'barrel.ts', 'utils/foo.ts')).toBe(true);
    });
  },
);
