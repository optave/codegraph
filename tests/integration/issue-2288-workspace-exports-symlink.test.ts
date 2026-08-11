/**
 * Integration test for #2288: workspace root-import resolution via the
 * `exports` field returned a `node_modules`-symlink path that never
 * matched the tracked file node for that file.
 *
 * `resolveViaWorkspace()`'s root-import branch (`src/domain/graph/resolve.ts`)
 * tried the package's `exports` field first via `resolveViaExports()`,
 * which locates the package directory through `findPackageDir()` — a
 * `node_modules` walk. For a real monorepo where workspace tools (npm/yarn/
 * pnpm workspaces) symlink workspace packages into `node_modules`, this
 * returns a path like `node_modules/@myorg/core/lib/index.js`. But
 * `detectWorkspaces()` registers each package's real directory from the
 * glob-matched path (`packages/core`), which is also where the file
 * collector finds and tracks the source file (`node_modules` is excluded
 * from collection). So the `imports`/`calls` edges were silently dropped
 * entirely for a workspace package whose `package.json` has only an
 * `exports` field (no `main`).
 *
 * The fix resolves `exports` against the workspace-detected real directory
 * directly, bypassing the `node_modules` walk for workspace packages.
 * Mirrored identically in both engines.
 *
 * Fixture matches the issue's own repro: a real `node_modules` symlink
 * (created via `fs.symlinkSync(..., 'junction')`, the cross-platform-safe
 * form already used elsewhere in this test suite — see `builder.test.ts`)
 * pointing at the real workspace package directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'issue-2288-fixture',
    private: true,
    workspaces: ['packages/*'],
  }),
  'packages/core/package.json': JSON.stringify({
    name: '@myorg/core',
    version: '1.0.0',
    exports: './lib/index.js',
  }),
  'packages/core/lib/index.js': 'export function greet() { return "hi"; }\n',
  'packages/app/src/main.js':
    'import { greet } from "@myorg/core";\nexport function run() { return greet(); }\n',
};

function writeFixture(tmpDir: string): void {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Returns false (and the test should skip) if symlinks aren't permitted here. */
function createWorkspaceSymlink(tmpDir: string): boolean {
  const nmScopeDir = path.join(tmpDir, 'node_modules', '@myorg');
  fs.mkdirSync(nmScopeDir, { recursive: true });
  try {
    fs.symlinkSync(
      path.join(tmpDir, 'packages', 'core'),
      path.join(nmScopeDir, 'core'),
      'junction',
    );
    return true;
  } catch {
    // Symlinks may require elevated privileges on Windows — skip gracefully.
    return false;
  }
}

function importEdgeRows(
  dbPath: string,
): Array<{ sourceFile: string; targetFile: string; kind: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT s.file AS sourceFile, t.file AS targetFile, e.kind AS kind
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind IN ('imports', 'calls')`,
      )
      .all() as Array<{ sourceFile: string; targetFile: string; kind: string }>;
  } finally {
    db.close();
  }
}

// `skipped` is decided inside beforeAll (creating the symlink is itself the
// first thing that can fail), so each assertion checks it at run time and
// bails out early rather than trying to use vitest's skipIf (evaluated at
// collection time, before beforeAll has run) — mirrors the try/catch-return
// convention `builder.test.ts` already uses for the same platform concern.
function runShared(getDbPath: () => string, isSkipped: () => boolean) {
  it('resolves the imports edge to the real packages/ path, not a node_modules-shaped path', () => {
    if (isSkipped()) return;
    const rows = importEdgeRows(getDbPath());
    const importsEdge = rows.find(
      (r) => r.kind === 'imports' && r.sourceFile.includes('packages/app'),
    );
    expect(importsEdge, 'expected an imports edge from packages/app/src/main.js').toBeDefined();
    expect(importsEdge?.targetFile).toBe('packages/core/lib/index.js');
    expect(importsEdge?.targetFile).not.toContain('node_modules');
  });

  it('resolves the calls edge from run() to greet() (cross-file call attribution)', () => {
    if (isSkipped()) return;
    const rows = importEdgeRows(getDbPath());
    const callsEdge = rows.find((r) => r.kind === 'calls' && r.sourceFile.includes('packages/app'));
    expect(callsEdge, 'expected a calls edge from run() to greet()').toBeDefined();
    expect(callsEdge?.targetFile).toBe('packages/core/lib/index.js');
  });
}

describe('issue #2288: workspace exports-field resolution through a node_modules symlink — WASM', () => {
  let tmpDir: string;
  let skipped = false;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2288-'));
    writeFixture(tmpDir);
    if (!createWorkspaceSymlink(tmpDir)) {
      skipped = true;
      return;
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  runShared(
    () => path.join(tmpDir, '.codegraph', 'graph.db'),
    () => skipped,
  );
});

describe.skipIf(!isNativeAvailable())(
  'issue #2288: workspace exports-field resolution through a node_modules symlink — native',
  () => {
    let nativeTmpDir: string;
    let skipped = false;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2288-native-'));
      writeFixture(nativeTmpDir);
      if (!createWorkspaceSymlink(nativeTmpDir)) {
        skipped = true;
        return;
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      if (nativeTmpDir) fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    runShared(
      () => path.join(nativeTmpDir, '.codegraph', 'graph.db'),
      () => skipped,
    );
  },
);
