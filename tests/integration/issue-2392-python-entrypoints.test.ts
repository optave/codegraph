/**
 * Regression test for #2392: role classification recognized neither of
 * Python's two canonical entrypoint conventions — the
 * `if __name__ == "__main__":` guard and a `__main__.py` module — so a repo
 * whose only entrypoints are Python reported zero `entry` symbols and
 * `codegraph roles --role entry` came back empty. That is precisely the
 * "where does this start?" question a new agent asks first.
 *
 * Neither the export surface nor the path patterns can see this: Python has no
 * `export` keyword, and a guard can appear in any file (`app/oio.py:1786` on
 * `data-ingestion-pipe`). The signal is a property of the *call site*, so the
 * extractor flags the call and the build sets `nodes.entrypoint` on whatever
 * it resolves to.
 *
 * Also pins the two ways the flag must NOT spread:
 *   - a call nested inside a function that a `__main__.py` happens to define
 *     is invoked by that function, not by `python -m pkg`; and
 *   - a function called only from ordinary module-level code (no guard) is
 *     not an entrypoint.
 *
 * And two review findings fixed after the original #2392 PR landed (#2411):
 *   - a guard syntactically nested inside a function or class is only run if
 *     and when that def is called, never automatically by the runtime, so it
 *     must not be treated as module level; and
 *   - clearing a stale flag on incremental rebuild must survive the guard's
 *     target living in a *different* file than the guard itself.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FILES: Record<string, string> = {
  // Guard convention, in an ordinary module.
  'app.py': `
def apphelper():
    return 1

def main():
    return apphelper()

if __name__ == "__main__":
    main()
`,
  // `python -m pkg` convention. `nested_only` is called from inside a
  // function defined here — the runtime never invokes it directly.
  'pkg/__main__.py': `
def run_pkg():
    return nested_only()

def nested_only():
    return 2

run_pkg()
`,
  // No guard anywhere: a module-level call is ordinary import-time work, not
  // a program entrypoint.
  'plain.py': `
def side_effect():
    return 3

side_effect()
`,
  // Review finding on #2411: a guard nested inside a function or class is
  // only run if and when that def is called, never automatically by the
  // runtime, so it must not be treated as module level.
  'nested_guards.py': `
def maybe_run():
    if __name__ == "__main__":
        guard_in_function()

def guard_in_function():
    return 4

class Config:
    if __name__ == "__main__":
        guard_in_class()

def guard_in_class():
    return 5
`,
};

function writeFixture(dir: string) {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

interface NodeRow {
  name: string;
  file: string;
  entrypoint: number;
  role: string | null;
}

function readFunctionNodes(dbPath: string): NodeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT name, file, COALESCE(entrypoint, 0) AS entrypoint, role
         FROM nodes WHERE kind IN ('function', 'method') ORDER BY file, name`,
      )
      .all() as NodeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('Python entrypoint classification (#2392) — engine: %s', (engine) => {
  let dir: string;
  let nodes: NodeRow[];

  const byName = (name: string): NodeRow => {
    const row = nodes.find((n) => n.name === name);
    if (!row)
      throw new Error(`no node named ${name} (have: ${nodes.map((n) => n.name).join(', ')})`);
    return row;
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2392-${engine}-`));
    writeFixture(dir);
    await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
    nodes = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db'));
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classifies a function invoked from an `if __name__ == "__main__":` guard as entry', () => {
    expect(byName('main').entrypoint).toBe(1);
    expect(byName('main').role).toBe('entry');
  });

  it('classifies a module-level call in a __main__.py as entry', () => {
    expect(byName('run_pkg').entrypoint).toBe(1);
    expect(byName('run_pkg').role).toBe('entry');
  });

  it('reports at least one entry symbol for a Python-only repo', () => {
    // The headline symptom: `roles --role entry` returned nothing at all.
    expect(nodes.filter((n) => n.role === 'entry').length).toBeGreaterThan(0);
  });

  it('does not mark a function that the entrypoint merely calls', () => {
    // apphelper is reached via main(), not started by the runtime.
    expect(byName('apphelper').entrypoint).toBe(0);
    expect(byName('apphelper').role).not.toBe('entry');
  });

  it('does not mark a call nested inside a function a __main__.py defines', () => {
    expect(byName('nested_only').entrypoint).toBe(0);
    expect(byName('nested_only').role).not.toBe('entry');
  });

  it('does not mark ordinary module-level calls in a file with no guard', () => {
    expect(byName('side_effect').entrypoint).toBe(0);
    expect(byName('side_effect').role).not.toBe('entry');
  });

  it('does not mark a guard nested inside a function as module level', () => {
    expect(byName('guard_in_function').entrypoint).toBe(0);
    expect(byName('guard_in_function').role).not.toBe('entry');
  });

  it('does not mark a guard nested inside a class as module level', () => {
    expect(byName('guard_in_class').entrypoint).toBe(0);
    expect(byName('guard_in_class').role).not.toBe('entry');
  });
});

describe.each(ENGINES)(
  'Python entrypoint incremental staleness (#2411 review fix) — engine: %s',
  (engine) => {
    it('clears a cross-file entrypoint target when its guard call is removed on incremental rebuild', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2411-stale-${engine}-`));
      try {
        const guardFile = path.join(dir, 'run.py');
        const libFile = path.join(dir, 'lib.py');
        fs.writeFileSync(libFile, 'def shared_main():\n    return 1\n');
        fs.writeFileSync(
          guardFile,
          'from lib import shared_main\n\nif __name__ == "__main__":\n    shared_main()\n',
        );

        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        const before = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db')).find(
          (n) => n.name === 'shared_main',
        );
        expect(before?.entrypoint).toBe(1);
        expect(before?.role).toBe('entry');

        // Remove the guard: shared_main, declared in a *different* file, is
        // no longer a program entrypoint. The old `run.py` -> `shared_main`
        // `calls` edge is purged as part of reprocessing `run.py`, before the
        // clear step for this build even runs — the exact scenario the
        // review finding on #2411 flagged as unable to clear.
        fs.writeFileSync(guardFile, 'from lib import shared_main\n');
        await buildGraph(dir, { incremental: true, skipRegistry: true, engine });
        const after = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db')).find(
          (n) => n.name === 'shared_main',
        );
        expect(after?.entrypoint).toBe(0);
        expect(after?.role).not.toBe('entry');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
