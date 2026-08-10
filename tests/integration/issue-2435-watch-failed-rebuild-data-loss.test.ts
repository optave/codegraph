/**
 * Regression test for #2435: a failed watch rebuild must not purge the file
 * from the graph.
 *
 * Root cause: `rebuildFile` (`domain/graph/builder/incremental.ts`, the
 * function `codegraph watch` calls per changed file) purged the file's nodes,
 * edges and ancillary rows *before* reading and parsing it — so every bail-out
 * path returned without re-inserting anything, leaving the file with zero
 * nodes and zero edges. Its `file_hashes` row was deliberately preserved
 * (`purgeHashes: false`) and still matched the on-disk content, so the next
 * `codegraph build --incremental` classified the file as unchanged and skipped
 * it: the file stayed missing from the graph until someone ran
 * `--no-incremental`.
 *
 * That made a routine, transient failure permanent. Editors save via
 * write-to-temp-then-rename and some briefly change permissions, so the
 * watcher can easily fire while the path is momentarily unreadable.
 *
 * The fix reads and parses first, purging only once a full replacement is in
 * hand. Each test below therefore drives `rebuildFile` through one bail-out
 * path and asserts the file's whole contribution to the graph survives — its
 * symbols AND the `calls` edge it owns into another file — then runs an
 * incremental build to confirm the state is genuinely durable and not merely
 * awaiting a rebuild that will never be triggered.
 *
 * The fixture file is deliberately left byte-identical on disk across the
 * failed rebuild. That is the case the surviving hash makes permanent: with
 * the content unchanged, change detection fast-skips the file forever. (Had
 * the content changed, the hash mismatch would eventually self-heal it.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { createIncrementalStmts } from '../helpers/incremental-stmts.js';

// ── Fixture ───────────────────────────────────────────────────────────────

/**
 * `caller.js` imports and calls `target()` from `target.js` — the JS analogue
 * of the issue's `run.py`/`lib.py` repro. `caller.js` is the file whose
 * rebuild fails; `target.js` supplies the cross-file `calls` edge that a purge
 * of `caller.js` silently takes with it.
 */
function writeProject(dir: string, { callsTarget = true }: { callsTarget?: boolean } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'target.js'), 'export function target() { return 1; }\n');
  fs.writeFileSync(
    path.join(dir, 'caller.js'),
    callsTarget
      ? "import { target } from './target.js';\nexport function run() { return target(); }\n"
      : 'export function run() { return 0; }\n',
  );
}

// ── DB read helpers ───────────────────────────────────────────────────────

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Non-file symbol names declared in `file`. */
function readSymbolNames(dbPath: string, file: string): string[] {
  return withDb(dbPath, (db) =>
    (
      db
        .prepare("SELECT name FROM nodes WHERE file = ? AND kind != 'file' ORDER BY name")
        .all(file) as Array<{ name: string }>
    ).map((r) => r.name),
  );
}

/** `"<sourceFile>:<sourceName>"` for every `calls` edge into `targetName` in `targetFile`. */
function readIncomingCalls(dbPath: string, targetFile: string, targetName: string): string[] {
  return withDb(dbPath, (db) =>
    (
      db
        .prepare(
          `SELECT n_src.file AS file, n_src.name AS name FROM edges e
           JOIN nodes n_src ON e.source_id = n_src.id
           JOIN nodes n_tgt ON e.target_id = n_tgt.id
           WHERE e.kind = 'calls' AND n_tgt.file = ? AND n_tgt.name = ?
           ORDER BY n_src.file, n_src.name`,
        )
        .all(targetFile, targetName) as Array<{ file: string; name: string }>
    ).map((r) => `${r.file}:${r.name}`),
  );
}

function hasFileHashRow(dbPath: string, file: string): boolean {
  return withDb(
    dbPath,
    (db) => db.prepare('SELECT 1 FROM file_hashes WHERE file = ?').get(file) !== undefined,
  );
}

/** Run one watch-mode rebuild of `relFile` exactly as `processPendingFiles` does. */
async function watchRebuild(
  dbPath: string,
  rootDir: string,
  relFile: string,
  cache: unknown = null,
): Promise<unknown> {
  const db = openDb(dbPath);
  try {
    initSchema(db);
    return await rebuildFile(
      db,
      rootDir,
      path.join(rootDir, relFile),
      createIncrementalStmts(db),
      { engine: 'wasm' },
      cache,
    );
  } finally {
    db.close();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Issue #2435: a failed watch rebuild leaves the graph intact', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2435-'));
    writeProject(tmpDir);
    // engine: 'wasm' pins parsing to the JS path for determinism; `rebuildFile`
    // itself is JS-only either way (`codegraph watch` has no native rebuild).
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine: 'wasm' });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

    // Baseline: the state a failed rebuild must not destroy.
    expect(readSymbolNames(dbPath, 'caller.js')).toContain('run');
    expect(readIncomingCalls(dbPath, 'target.js', 'target')).toEqual(['caller.js:run']);
    expect(hasFileHashRow(dbPath, 'caller.js')).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Assert caller.js's full contribution to the graph is present. */
  function expectGraphIntact() {
    expect(readSymbolNames(dbPath, 'caller.js')).toContain('run');
    expect(readIncomingCalls(dbPath, 'target.js', 'target')).toEqual(['caller.js:run']);
  }

  it('keeps the file in the graph when it cannot be read, and an incremental build agrees', async () => {
    const callerAbs = path.join(tmpDir, 'caller.js');
    // Fail only this one read (EACCES — what the issue's `chmod 000` repro
    // produces; readFileSafe retries transient codes, then throws), passing
    // every other read through so the rest of the rebuild behaves normally.
    const actualReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((
      p: Parameters<typeof fs.readFileSync>[0],
      opts: Parameters<typeof fs.readFileSync>[1],
    ) => {
      if (p === callerAbs) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return actualReadFileSync(p, opts);
    }) as typeof fs.readFileSync);

    // The rebuild reports failure by returning null — the watcher skips the
    // file (no journal entry, no change event) and moves on.
    expect(await watchRebuild(dbPath, tmpDir, 'caller.js')).toBeNull();

    vi.restoreAllMocks();
    expectGraphIntact();

    // The surviving hash row is only correct if the graph data it describes
    // survived too: an incremental build fast-skips this unchanged file, so
    // whatever state the failed rebuild left is the state that persists.
    expect(hasFileHashRow(dbPath, 'caller.js')).toBe(true);
    await buildGraph(tmpDir, { incremental: true, skipRegistry: true, engine: 'wasm' });
    expectGraphIntact();
  });

  it('keeps the file in the graph when it cannot be parsed, and an incremental build agrees', async () => {
    // A cache whose parseFile yields nothing drives `parseFileIncremental` to
    // return null — the second bail-out path, reached after a successful read.
    const emptyCache = { parseFile: () => null, remove: () => {} };

    expect(await watchRebuild(dbPath, tmpDir, 'caller.js', emptyCache)).toBeNull();

    expectGraphIntact();
    expect(hasFileHashRow(dbPath, 'caller.js')).toBe(true);
    await buildGraph(tmpDir, { incremental: true, skipRegistry: true, engine: 'wasm' });
    expectGraphIntact();
  });

  it('still purges stale data on a successful rebuild', async () => {
    // The counterpart risk of deferring the purge: it must still happen when a
    // replacement does arrive. Drop the call and rebuild for real.
    writeProject(tmpDir, { callsTarget: false });

    const result = await watchRebuild(dbPath, tmpDir, 'caller.js');

    expect(result).not.toBeNull();
    expect(readSymbolNames(dbPath, 'caller.js')).toContain('run');
    expect(readIncomingCalls(dbPath, 'target.js', 'target')).toEqual([]);
  });
});
