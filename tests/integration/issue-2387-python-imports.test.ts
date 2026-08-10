/**
 * Regression test for #2387: Python produced no `imports` edges at all, and
 * an aliased module call (`import lib as L` … `L.strip_block()`) resolved to
 * nothing, leaving the callee reported as dead code.
 *
 * Two distinct defects sat behind that:
 *
 *  1. `resolveImportPathJS`/`resolve_import_path_inner` had no Python branch.
 *     A dotted module path (`pipeline.util`) is not a filesystem path, so it
 *     fell through to the bare-specifier fallback and was echoed back
 *     unchanged, matching no file node — hence zero `imports` edges, and
 *     `deps`/`impact`/`map` blind on every Python repo. Python's *relative*
 *     imports share JS's leading-dot spelling but mean "climb the package
 *     tree", so they were mis-resolved by the generic relative branch too.
 *
 *  2. The Python extractor put the *alias* in `Import.source` for
 *     `import lib as L` — an alias can never resolve to a file — and a
 *     multi-module `import a, b` collapsed into a single record naming only
 *     `a`. Module bindings are now recorded in `namespaceBindings`, which is
 *     what lets `L.strip_block()` be read as "strip_block, as declared in the
 *     module L refers to".
 *
 * The fixture uses the PyPA-endorsed "src layout" (package root `src/`,
 * imports written `from pipeline…`) because that is the layout on the Optave
 * Python services where this was found, and the one a repo-root-relative
 * resolver gets wrong even after dotted paths are handled at all.
 *
 * Two same-named `shared_helper` functions would not disambiguate anything
 * here — instead the assertions pin each edge to a specific target *file*, so
 * a resolver that fell back to a global same-name lookup could not pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FILES: Record<string, string> = {
  'pyproject.toml': `
[project]
name = "pipeline"

[tool.setuptools.package-dir]
"" = "src"
`,
  'src/pipeline/__init__.py': '',
  'src/pipeline/stages/__init__.py': '',
  'src/pipeline/util.py': `
def shared_helper():
    return 1
`,
  'src/pipeline/stages/extract.py': `
def run_extract(data):
    return data
`,
  'src/pipeline/stages/load.py': `
from .extract import run_extract
from ..util import shared_helper

def run_load(data):
    shared_helper()
    return run_extract(data)
`,
  'src/pipeline/main.py': `
import pipeline.util as U
from pipeline.stages import extract
from pipeline.stages.load import run_load

def main():
    U.shared_helper()
    extract.run_extract([])
    return run_load([])
`,
};

function writeFixture(dir: string) {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

interface EdgeRow {
  src: string;
  src_file: string;
  tgt: string;
  tgt_file: string;
}

function readEdges(dbPath: string, kind: string): EdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.file AS src_file, n2.name AS tgt, n2.file AS tgt_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = ?
         ORDER BY n1.file, n1.name, n2.file, n2.name`,
      )
      .all(kind) as EdgeRow[];
  } finally {
    db.close();
  }
}

const hasEdge = (edges: EdgeRow[], srcFile: string, tgtFile: string): boolean =>
  edges.some((e) => e.src_file === srcFile && e.tgt_file === tgtFile);

const hasCall = (edges: EdgeRow[], src: string, tgt: string, tgtFile: string): boolean =>
  edges.some((e) => e.src === src && e.tgt === tgt && e.tgt_file === tgtFile);

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('Python import resolution (#2387) — engine: %s', (engine) => {
  let dir: string;
  let dbPath: string;
  let importEdges: EdgeRow[];
  let callEdges: EdgeRow[];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2387-${engine}-`));
    writeFixture(dir);
    await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
    dbPath = path.join(dir, '.codegraph', 'graph.db');
    importEdges = readEdges(dbPath, 'imports');
    callEdges = readEdges(dbPath, 'calls');
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits imports edges for Python at all', () => {
    expect(importEdges.length).toBeGreaterThan(0);
  });

  it('resolves an absolute dotted import through the src-layout package root', () => {
    // `import pipeline.util as U` from src/pipeline/main.py
    expect(hasEdge(importEdges, 'src/pipeline/main.py', 'src/pipeline/util.py')).toBe(true);
  });

  it('resolves single- and double-dot relative imports', () => {
    // `from .extract import run_extract` and `from ..util import shared_helper`
    expect(
      hasEdge(importEdges, 'src/pipeline/stages/load.py', 'src/pipeline/stages/extract.py'),
    ).toBe(true);
    expect(hasEdge(importEdges, 'src/pipeline/stages/load.py', 'src/pipeline/util.py')).toBe(true);
  });

  it('points `from pkg import submod` at the submodule, not only at the package __init__', () => {
    // `from pipeline.stages import extract` — depending on stages/__init__.py
    // alone would leave the module that actually changed invisible to
    // deps/impact.
    expect(hasEdge(importEdges, 'src/pipeline/main.py', 'src/pipeline/stages/extract.py')).toBe(
      true,
    );
  });

  it('resolves a call through an aliased module binding (import x as y; y.f())', () => {
    // The headline defect: U.shared_helper() previously produced no edge and
    // left shared_helper classified dead.
    expect(hasCall(callEdges, 'main', 'shared_helper', 'src/pipeline/util.py')).toBe(true);
  });

  it('resolves a call through a submodule binding (from pkg import submod; submod.f())', () => {
    expect(hasCall(callEdges, 'main', 'run_extract', 'src/pipeline/stages/extract.py')).toBe(true);
  });

  it('still resolves the plain `from mod import name` form', () => {
    expect(hasCall(callEdges, 'main', 'run_load', 'src/pipeline/stages/load.py')).toBe(true);
    expect(hasCall(callEdges, 'run_load', 'shared_helper', 'src/pipeline/util.py')).toBe(true);
    expect(hasCall(callEdges, 'run_load', 'run_extract', 'src/pipeline/stages/extract.py')).toBe(
      true,
    );
  });

  it('does not invent import edges for stdlib or third-party modules', () => {
    // Nothing in the fixture imports os/numpy; every imports edge must land on
    // a real project file, never on an echoed bare specifier.
    const projectFiles = new Set(Object.keys(FILES).filter((f) => f.endsWith('.py')));
    for (const edge of importEdges) {
      expect(projectFiles.has(edge.tgt_file)).toBe(true);
    }
  });
});
