/**
 * Integration test for #2036: Lua anonymous function expressions
 * (`local M = {}; M.foo = function(...) end`, `local f = function() end`)
 * were not tracked in complexity/Halstead metrics in either engine.
 *
 * Root cause: `function_nodes`/`functionNodes` for Lua only listed
 * `function_declaration` (the named-declaration node type covering
 * `function f() end`, `local function f() end`, `function M.foo() end`).
 * The anonymous `function_definition` expression node — the RHS of the
 * common module-table idiom `M.foo = function(...) end` and of
 * `local f = function() end` — was never recognized as a function scope,
 * and (more fundamentally) the extractor never created a `Definition` for
 * it at all, so the function silently got zero complexity/Halstead data.
 *
 * Fix: both engines now (1) create a `Definition` for these
 * identifier/dotted anonymous-function assignments (mirroring the
 * `function M.foo() end` named-declaration handling), and (2) list
 * `function_definition` alongside `function_declaration` in the
 * complexity rules' function-node set, so nested anonymous functions get
 * correct nesting-depth attribution too.
 *
 * This test builds the issue's own repro with both engines and asserts
 * identical, real (non-zero-signal) complexity for both functions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const LUA_SRC = `local M = {}

M.foo = function(x)
  if x then
    return 1
  else
    return 2
  end
end

local f = function(x)
  return x + 1
end
`;

const hasNative = isNativeAvailable();
const requireParity = !!process.env.CODEGRAPH_PARITY;
const describeNativeOrSkip = requireParity || hasNative ? describe : describe.skip;

interface ComplexityRow {
  name: string;
  kind: string;
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
}

function complexityRows(dbPath: string): ComplexityRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n.name AS name, n.kind AS kind, fc.cognitive AS cognitive,
                fc.cyclomatic AS cyclomatic, fc.max_nesting AS maxNesting
         FROM function_complexity fc
         JOIN nodes n ON n.id = fc.node_id
         WHERE n.file = 'repo.lua'
         ORDER BY n.name`,
      )
      .all() as ComplexityRow[];
  } finally {
    db.close();
  }
}

async function buildAndQuery(engine: 'wasm' | 'native'): Promise<ComplexityRow[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2036-${engine}-`));
  try {
    fs.writeFileSync(path.join(tmpDir, 'repo.lua'), LUA_SRC);
    await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    return complexityRows(path.join(tmpDir, '.codegraph', 'graph.db'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('issue #2036: Lua anonymous function-expression complexity (WASM)', () => {
  let rows: ComplexityRow[];

  beforeAll(async () => {
    rows = await buildAndQuery('wasm');
  });

  it('creates a method Definition with real complexity for the module-table idiom (M.foo = function() end)', () => {
    const foo = rows.find((r) => r.name === 'M.foo');
    expect(foo).toBeDefined();
    expect(foo?.kind).toBe('method');
    expect(foo?.cyclomatic).toBe(2);
    expect(foo?.cognitive).toBe(2);
    expect(foo?.maxNesting).toBe(1);
  });

  it('creates a function Definition with real complexity for a local anonymous function (local f = function() end)', () => {
    const f = rows.find((r) => r.name === 'f');
    expect(f).toBeDefined();
    expect(f?.kind).toBe('function');
    expect(f?.cyclomatic).toBe(1);
    expect(f?.cognitive).toBe(0);
  });
});

describeNativeOrSkip('issue #2036: Lua anonymous function-expression complexity (native)', () => {
  let wasmRows: ComplexityRow[];
  let nativeRows: ComplexityRow[];

  beforeAll(async () => {
    [wasmRows, nativeRows] = await Promise.all([buildAndQuery('wasm'), buildAndQuery('native')]);
  });

  it('produces identical complexity metrics to the WASM engine', () => {
    expect(nativeRows).toEqual(wasmRows);
  });

  it('computes real (non-zero-signal) complexity for both functions natively', () => {
    const foo = nativeRows.find((r) => r.name === 'M.foo');
    const f = nativeRows.find((r) => r.name === 'f');
    expect(foo?.cyclomatic).toBe(2);
    expect(f?.cyclomatic).toBe(1);
  });
});
