/**
 * Regression test for #2408: role classification recognized neither of a
 * Python project's packaging-declared entrypoints — a `[project.scripts]`
 * (or `[project.gui-scripts]` / `[tool.poetry.scripts]`) console-script
 * target — so a repo whose only entrypoints are declared this way (no
 * `if __name__ == "__main__":` guard, no `__main__.py`) still reported zero
 * `entry` symbols even after #2392 taught role classification the guard
 * conventions.
 *
 * `pyproject.toml` is re-parsed fresh on every build rather than cached as
 * per-file evidence like a guard call (#2392's `entrypoint_calls` table) —
 * it is a single, cheap-to-reread file, so attribution runs unconditionally
 * every build and self-corrects when the declared scripts change.
 *
 * Attribution is scoped to `entrypoint_source_file = 'pyproject.toml'`, so it
 * takes precedence over — but never clobbers — a guard-attributed target
 * declared by a different mechanism.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const PYPROJECT = `
[project.scripts]
ingest = "pipeline.cli:main"

[project.gui-scripts]
ingest-gui = "pipeline.gui:launch"

[tool.poetry.scripts]
ingest-poetry = "pipeline.other:run"

[tool.setuptools.package-dir]
"" = "src"
`;

const FILES: Record<string, string> = {
  'pyproject.toml': PYPROJECT,
  'src/pipeline/__init__.py': '',
  'src/pipeline/cli.py': `
def helper():
    return 1

def main():
    return helper()
`,
  'src/pipeline/gui.py': `
def launch():
    return 2
`,
  'src/pipeline/other.py': `
def run():
    return 3
`,
};

function writeFixture(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

interface NodeRow {
  name: string;
  file: string;
  entrypoint: number;
  entrypointSourceFile: string | null;
  role: string | null;
}

function readFunctionNodes(dbPath: string): NodeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT name, file, COALESCE(entrypoint, 0) AS entrypoint,
                entrypoint_source_file AS entrypointSourceFile, role
         FROM nodes WHERE kind IN ('function', 'method') ORDER BY file, name`,
      )
      .all() as NodeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'pyproject.toml script entrypoint classification (#2408) — engine: %s',
  (engine) => {
    let dir: string;
    let nodes: NodeRow[];

    const byName = (name: string): NodeRow => {
      const row = nodes.find((n) => n.name === name);
      if (!row)
        throw new Error(`no node named ${name} (have: ${nodes.map((n) => n.name).join(', ')})`);
      return row;
    };

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2408-${engine}-`));
      writeFixture(dir, FILES);
      await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
      nodes = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db'));
    });

    afterAll(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('classifies a [project.scripts] target as entry', () => {
      expect(byName('main').entrypoint).toBe(1);
      expect(byName('main').role).toBe('entry');
      expect(byName('main').entrypointSourceFile).toBe('pyproject.toml');
    });

    it('classifies a [project.gui-scripts] target as entry', () => {
      expect(byName('launch').entrypoint).toBe(1);
      expect(byName('launch').role).toBe('entry');
    });

    it('classifies a [tool.poetry.scripts] target as entry', () => {
      expect(byName('run').entrypoint).toBe(1);
      expect(byName('run').role).toBe('entry');
    });

    it('does not mark a function the script target merely calls', () => {
      expect(byName('helper').entrypoint).toBe(0);
      expect(byName('helper').role).not.toBe('entry');
    });
  },
);

describe.each(ENGINES)(
  'pyproject.toml script entrypoint precedence and staleness (#2408) — engine: %s',
  (engine) => {
    it('does not clobber a guard-attributed entrypoint when pyproject.toml declares no scripts', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2408-noclobber-${engine}-`));
      try {
        writeFixture(dir, {
          'pyproject.toml': '[project]\nname = "pipeline"\n',
          'run.py': `
from lib import shared_main

if __name__ == "__main__":
    shared_main()
`,
          'lib.py': 'def shared_main():\n    return 1\n',
        });

        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        const nodes = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db'));
        const row = nodes.find((n) => n.name === 'shared_main');

        expect(row?.entrypoint).toBe(1);
        expect(row?.role).toBe('entry');
        expect(row?.entrypointSourceFile).toBe('run.py');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('takes precedence over an existing guard attribution on the same target', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2408-precedence-${engine}-`));
      try {
        writeFixture(dir, {
          'pyproject.toml':
            '[project.scripts]\ningest = "pipeline.cli:main"\n\n[tool.setuptools.package-dir]\n"" = "src"\n',
          'src/pipeline/__init__.py': '',
          'src/pipeline/cli.py': `
def main():
    return 1

if __name__ == "__main__":
    main()
`,
        });

        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        const row = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db')).find(
          (n) => n.name === 'main',
        );

        expect(row?.entrypoint).toBe(1);
        expect(row?.role).toBe('entry');
        expect(row?.entrypointSourceFile).toBe('pyproject.toml');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('clears a script attribution on incremental rebuild once the script entry is removed', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2408-stale-${engine}-`));
      try {
        writeFixture(dir, {
          'pyproject.toml':
            '[project.scripts]\ningest = "pipeline.cli:main"\n\n[tool.setuptools.package-dir]\n"" = "src"\n',
          'src/pipeline/__init__.py': '',
          'src/pipeline/cli.py': 'def main():\n    return 1\n',
        });

        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        const before = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db')).find(
          (n) => n.name === 'main',
        );
        expect(before?.entrypoint).toBe(1);
        expect(before?.role).toBe('entry');

        // Remove the script declaration, and touch the target file itself so
        // the incremental build sees a real change and does not fast-skip —
        // pyproject.toml re-checks unconditionally on every build that
        // actually runs, but a build with zero changed files never runs at
        // all (pyproject.toml is not itself a watched/hashed source file).
        fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "pipeline"\n');
        fs.writeFileSync(path.join(dir, 'src/pipeline/cli.py'), 'def main():\n    return 2\n');
        await buildGraph(dir, { incremental: true, skipRegistry: true, engine });
        const after = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db')).find(
          (n) => n.name === 'main',
        );

        expect(after?.entrypoint).toBe(0);
        expect(after?.role).not.toBe('entry');
        expect(after?.entrypointSourceFile).toBeNull();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
