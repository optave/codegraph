/**
 * Regression test for #2428: `codegraph watch`'s single-file rebuild path
 * (`rebuildFile` in `domain/graph/builder/incremental.ts`) never touched
 * `nodes.entrypoint`/`nodes.entrypoint_source_file` at all.
 *
 * #2392/#2411 taught both extractors to flag a Python `__main__`-guard call
 * and the batch pipeline to propagate that onto whatever the call resolves
 * to. But `incremental.ts` is a standalone reimplementation of node/edge
 * persistence that shares no code with the pipeline's `markEntrypointTargets`
 * / `clearEntrypointAttributionForRemovedFiles`, so during a watch session:
 *
 *   - adding a guard never marked its target as an entrypoint;
 *   - removing a guard never cleared a previously-marked target; and
 *   - deleting the guard's file entirely left a cross-file target stuck at
 *     `entrypoint = 1` / `role = "entry"` — still seeding live-code
 *     reachability — until the next full build (the specific symptom the
 *     Greptile review on #2411 named).
 *
 * The cross-file case is what makes this more than bookkeeping: the target
 * lives in a file the watcher never rebuilt, so nothing else in the rebuild
 * touches its row.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';
import { createIncrementalStmts } from '../helpers/incremental-stmts.js';

const GUARD_SOURCE =
  'from lib import shared_main\n\nif __name__ == "__main__":\n    shared_main()\n';
const NO_GUARD_SOURCE = 'from lib import shared_main\n';

interface EntrypointRow {
  name: string;
  file: string;
  entrypoint: number;
  entrypointSourceFile: string | null;
  role: string | null;
}

function readSymbol(dir: string, name: string): EntrypointRow | undefined {
  const db = new Database(path.join(dir, '.codegraph', 'graph.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT name, file, COALESCE(entrypoint, 0) AS entrypoint,
                entrypoint_source_file AS entrypointSourceFile, role
         FROM nodes WHERE name = ? AND kind IN ('function', 'method')`,
      )
      .get(name) as EntrypointRow | undefined;
  } finally {
    db.close();
  }
}

/** Run exactly what `codegraph watch` runs for one changed file. */
async function watchRebuild(dir: string, relFile: string, engine: EngineMode): Promise<void> {
  const db = openDb(path.join(dir, '.codegraph', 'graph.db'));
  try {
    initSchema(db);
    await rebuildFile(
      db,
      dir,
      path.join(dir, relFile),
      createIncrementalStmts(db),
      { engine },
      null,
    );
  } finally {
    db.close();
  }
}

async function withFixture(
  engine: EngineMode,
  slug: string,
  guarded: boolean,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2428-${slug}-${engine}-`));
  try {
    fs.writeFileSync(path.join(dir, 'lib.py'), 'def shared_main():\n    return 1\n');
    fs.writeFileSync(path.join(dir, 'run.py'), guarded ? GUARD_SOURCE : NO_GUARD_SOURCE);
    await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
    await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'codegraph watch (rebuildFile): Python entrypoint attribution (#2428) — engine: %s',
  (engine) => {
    it('clears a cross-file entrypoint target when the guard file is deleted', async () => {
      await withFixture(engine, 'delete', true, async (dir) => {
        const before = readSymbol(dir, 'shared_main');
        expect(before?.entrypoint).toBe(1);
        expect(before?.role).toBe('entry');

        fs.rmSync(path.join(dir, 'run.py'));
        await watchRebuild(dir, 'run.py', engine);

        const after = readSymbol(dir, 'shared_main');
        expect(after?.entrypoint).toBe(0);
        expect(after?.entrypointSourceFile).toBeNull();
        expect(after?.role).not.toBe('entry');
      });
    });

    it('clears a cross-file entrypoint target when the guard is edited away', async () => {
      await withFixture(engine, 'edit-clear', true, async (dir) => {
        expect(readSymbol(dir, 'shared_main')?.entrypoint).toBe(1);

        fs.writeFileSync(path.join(dir, 'run.py'), NO_GUARD_SOURCE);
        await watchRebuild(dir, 'run.py', engine);

        const after = readSymbol(dir, 'shared_main');
        expect(after?.entrypoint).toBe(0);
        expect(after?.entrypointSourceFile).toBeNull();
        expect(after?.role).not.toBe('entry');
      });
    });

    it('marks a cross-file entrypoint target when a guard is newly added', async () => {
      // The mark half. Without it watch mode could only ever clear a flag some
      // earlier full build set, never legitimately set one.
      await withFixture(engine, 'edit-mark', false, async (dir) => {
        const before = readSymbol(dir, 'shared_main');
        expect(before?.entrypoint).toBe(0);
        expect(before?.role).not.toBe('entry');

        fs.writeFileSync(path.join(dir, 'run.py'), GUARD_SOURCE);
        await watchRebuild(dir, 'run.py', engine);

        const after = readSymbol(dir, 'shared_main');
        expect(after?.entrypoint).toBe(1);
        expect(after?.entrypointSourceFile).toBe('run.py');
        expect(after?.role).toBe('entry');
      });
    });

    it('marks a same-file entrypoint target when a guard is newly added', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2428-samefile-${engine}-`));
      try {
        const appFile = path.join(dir, 'app.py');
        fs.writeFileSync(appFile, 'def main():\n    return 1\n');
        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        expect(readSymbol(dir, 'main')?.entrypoint).toBe(0);

        fs.writeFileSync(
          appFile,
          'def main():\n    return 1\n\nif __name__ == "__main__":\n    main()\n',
        );
        await watchRebuild(dir, 'app.py', engine);

        const after = readSymbol(dir, 'main');
        expect(after?.entrypoint).toBe(1);
        expect(after?.entrypointSourceFile).toBe('app.py');
        expect(after?.role).toBe('entry');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps attribution when the target’s own file is rebuilt', async () => {
      // The target's node row is purged and re-inserted with a fresh id by its
      // own rebuild, taking the flag with it — while the guard's file, which
      // holds the only evidence for it, is never reparsed. Nothing but
      // persisted evidence can put it back.
      await withFixture(engine, 'target-rebuild', true, async (dir) => {
        expect(readSymbol(dir, 'shared_main')?.entrypoint).toBe(1);

        fs.writeFileSync(path.join(dir, 'lib.py'), 'def shared_main():\n    return 2\n');
        await watchRebuild(dir, 'lib.py', engine);

        const after = readSymbol(dir, 'shared_main');
        expect(after?.entrypoint).toBe(1);
        expect(after?.entrypointSourceFile).toBe('run.py');
        expect(after?.role).toBe('entry');
      });
    });
  },
);

describe.each(ENGINES)(
  'schema upgrade preserves existing entrypoint attribution (#2434 review) — engine: %s',
  (engine) => {
    it('backfills evidence from a pre-v31 graph instead of clearing its flags', async () => {
      // `nodes.entrypoint` is a projection of `entrypoint_calls`. A graph
      // built before that table existed has the flags but no evidence, and
      // creating the table empty would make the next partial rebuild project
      // it across the whole graph and clear every flag whose guard file it
      // did not happen to reparse.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2434-upgrade-${engine}-`));
      try {
        fs.writeFileSync(path.join(dir, 'lib.py'), 'def shared_main():\n    return 1\n');
        fs.writeFileSync(path.join(dir, 'run.py'), GUARD_SOURCE);
        fs.writeFileSync(path.join(dir, 'other.py'), 'def other():\n    return 9\n');
        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        expect(readSymbol(dir, 'shared_main')?.entrypoint).toBe(1);

        // Rewind to a v30 graph: the flags #2411 wrote, no evidence table.
        const raw = new Database(path.join(dir, '.codegraph', 'graph.db'));
        raw.exec('DROP TABLE entrypoint_calls');
        raw.prepare('UPDATE schema_version SET version = 30').run();
        raw.close();

        // Rebuild a file with nothing to do with the guard — the projection
        // still runs graph-wide.
        await watchRebuild(dir, 'other.py', engine);

        const after = readSymbol(dir, 'shared_main');
        expect(after?.entrypoint).toBe(1);
        expect(after?.entrypointSourceFile).toBe('run.py');
        expect(after?.role).toBe('entry');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('backfills on an incremental build that reparses only an unrelated file', async () => {
      // Same upgrade, reached through the batch pipeline — which on the
      // native engine opens the graph through the Rust `init_schema`, so this
      // is what exercises that engine's own copy of the backfill.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2434-upgrade-batch-${engine}-`));
      try {
        fs.writeFileSync(path.join(dir, 'lib.py'), 'def shared_main():\n    return 1\n');
        fs.writeFileSync(path.join(dir, 'run.py'), GUARD_SOURCE);
        fs.writeFileSync(path.join(dir, 'other.py'), 'def other():\n    return 9\n');
        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        expect(readSymbol(dir, 'shared_main')?.entrypoint).toBe(1);

        const raw = new Database(path.join(dir, '.codegraph', 'graph.db'));
        raw.exec('DROP TABLE entrypoint_calls');
        raw.prepare('UPDATE schema_version SET version = 30').run();
        raw.close();

        fs.writeFileSync(path.join(dir, 'other.py'), 'def other():\n    return 10\n');
        await buildGraph(dir, { incremental: true, skipRegistry: true, engine });

        const after = readSymbol(dir, 'shared_main');
        expect(after?.entrypoint).toBe(1);
        expect(after?.entrypointSourceFile).toBe('run.py');
        expect(after?.role).toBe('entry');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe.each(ENGINES)(
  'codegraph build --incremental: Python entrypoint attribution (#2428) — engine: %s',
  (engine) => {
    // The same defect, reached through the batch pipeline rather than the
    // watcher: #2411 wrote `nodes.entrypoint` straight from the reparsed
    // files' symbols, so a build that reparsed only the *target* had no
    // evidence to re-mark it from and silently dropped the flag. This is the
    // path `.claude/hooks/update-graph.sh` runs after every edit.
    it('keeps a cross-file entrypoint target when only the target file changes', async () => {
      await withFixture(engine, 'batch-target', true, async (dir) => {
        expect(readSymbol(dir, 'shared_main')?.entrypoint).toBe(1);

        fs.writeFileSync(path.join(dir, 'lib.py'), 'def shared_main():\n    return 2\n');
        await buildGraph(dir, { incremental: true, skipRegistry: true, engine });

        const after = readSymbol(dir, 'shared_main');
        expect(after?.entrypoint).toBe(1);
        expect(after?.entrypointSourceFile).toBe('run.py');
        expect(after?.role).toBe('entry');
      });
    });

    it('still clears the target when the guard itself is edited away', async () => {
      // The clear direction must survive the redesign: evidence is rewritten
      // for every reparsed Python file, so a file that lost its guard leaves
      // none behind.
      await withFixture(engine, 'batch-clear', true, async (dir) => {
        expect(readSymbol(dir, 'shared_main')?.entrypoint).toBe(1);

        fs.writeFileSync(path.join(dir, 'run.py'), NO_GUARD_SOURCE);
        await buildGraph(dir, { incremental: true, skipRegistry: true, engine });

        const after = readSymbol(dir, 'shared_main');
        expect(after?.entrypoint).toBe(0);
        expect(after?.entrypointSourceFile).toBeNull();
        expect(after?.role).not.toBe('entry');
      });
    });
  },
);
