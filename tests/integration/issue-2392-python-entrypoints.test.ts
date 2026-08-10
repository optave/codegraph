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
});
