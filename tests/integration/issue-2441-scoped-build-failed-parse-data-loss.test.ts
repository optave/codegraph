/**
 * Regression test for #2441: a scoped incremental build (`codegraph build
 * --incremental` with an explicit `scope`) that fails to PARSE a changed
 * file still committed a `file_hashes` row matching that file's new on-disk
 * content — permanently hiding the data loss from every later incremental
 * build. Same failure mode as #2435 (a `file_hashes` row that outlives the
 * data it describes), but pre-existing and independent of that fix, which
 * only protects `rebuildFile` (the `codegraph watch` path).
 *
 * Root cause: `handleScopedBuild` purges a changed file's nodes/edges
 * BEFORE parsing runs — but deliberately leaves its OLD `file_hashes` row
 * alone (deferred-commit design from #1731: a hash only ever advances once
 * the data it describes has been rebuilt to match). `parseFiles`
 * (`domain/graph/builder/stages/parse-files.ts`) then parses the changed
 * set; a file whose extraction fails outright (worker crash, unreadable,
 * unsupported/missing grammar) simply gets no entry in
 * `ctx.allSymbols`/`ctx.fileSymbols` — but `commitFileHashes`
 * (`domain/graph/builder/stages/insert-nodes.ts`) built its hash list from
 * `ctx.filesToParse` directly, with no check that the file actually
 * produced data, so the file's hash still got overwritten with a value
 * matching its NEW on-disk content, even though the (missing) new state was
 * never written.
 *
 * Unlike #2435, the purge itself is NOT deferred here (a much larger change
 * given the purge and the parse live in different pipeline stages) — the
 * fix only withholds the file_hashes commit, so the OLD (pre-edit) hash
 * survives the failed build. Since it no longer matches the file's actual
 * current content, the next incremental build correctly detects the file as
 * still changed and reprocesses it, recovering the data. The read-failure
 * half of this bug class doesn't apply on the scoped-build path: change
 * detection reads each candidate up front and drops unreadable files from
 * the changed set before the purge ever runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { getWasmWorkerPool } from '../../src/domain/wasm-worker-pool.js';

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

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readSymbolNames(dbPath: string, file: string): string[] {
  return withDb(dbPath, (db) =>
    (
      db
        .prepare("SELECT name FROM nodes WHERE file = ? AND kind != 'file' ORDER BY name")
        .all(file) as Array<{ name: string }>
    ).map((r) => r.name),
  );
}

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

function readFileHash(dbPath: string, file: string): string | undefined {
  return withDb(
    dbPath,
    (db) =>
      (
        db.prepare('SELECT hash FROM file_hashes WHERE file = ?').get(file) as
          | { hash: string }
          | undefined
      )?.hash,
  );
}

describe('Issue #2441: a scoped build that fails to parse a changed file', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2441-'));
    writeProject(tmpDir);
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine: 'wasm' });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

    expect(readSymbolNames(dbPath, 'caller.js')).toContain('run');
    expect(readIncomingCalls(dbPath, 'target.js', 'target')).toEqual(['caller.js:run']);
    expect(hasFileHashRow(dbPath, 'caller.js')).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not commit a hash for the file, so a later scoped build recovers it', async () => {
    const originalHash = readFileHash(dbPath, 'caller.js');
    expect(originalHash).toBeDefined();

    const callerAbs = path.join(tmpDir, 'caller.js');
    // Change the file's on-disk content so change detection classifies it as
    // changed, then force ITS parse specifically to fail (worker crash /
    // soft error) — `WasmWorkerPool.parse` returning null is exactly what
    // `parseFilesWasm` treats as "this file produced no output", the same
    // signal a real crash or unsupported grammar would produce.
    fs.writeFileSync(
      callerAbs,
      "import { target } from './target.js';\nexport function run() { return target() + 1; }\n",
    );

    const pool = getWasmWorkerPool();
    const actualParse = pool.parse.bind(pool);
    vi.spyOn(pool, 'parse').mockImplementation(async (filePath, code, opts) => {
      if (filePath === callerAbs) return null;
      return actualParse(filePath, code, opts);
    });

    await buildGraph(tmpDir, {
      incremental: true,
      skipRegistry: true,
      engine: 'wasm',
      scope: ['caller.js'],
    });

    vi.restoreAllMocks();

    // The purge already ran before the failed parse — caller.js's old data
    // is gone. That half of the current behavior is unchanged by this fix
    // (the issue's own "stronger" lazy-purge option is a separate, larger
    // change) — what matters is that the file is NOT silently marked up to
    // date with nothing to show for it: the row survives unchanged (#1731's
    // deferred-commit design left it alone before the purge ever ran), so it
    // no longer matches the file's actual current content.
    expect(readSymbolNames(dbPath, 'caller.js')).toEqual([]);
    expect(readFileHash(dbPath, 'caller.js')).toBe(originalHash);

    // A subsequent scoped build, with parsing succeeding normally this
    // time, must actually reprocess the file rather than fast-skipping it
    // as "unchanged" — proving the data loss is recoverable, not permanent.
    await buildGraph(tmpDir, {
      incremental: true,
      skipRegistry: true,
      engine: 'wasm',
      scope: ['caller.js'],
    });

    expect(readSymbolNames(dbPath, 'caller.js')).toContain('run');
    expect(readIncomingCalls(dbPath, 'target.js', 'target')).toEqual(['caller.js:run']);
    expect(readFileHash(dbPath, 'caller.js')).not.toBe(originalHash);
  });

  it('still commits the hash on a successful scoped build', async () => {
    // Counterpart sanity check: the fix must not withhold the hash from a
    // file that parsed fine — only from one that genuinely produced nothing.
    writeProject(tmpDir, { callsTarget: false });

    await buildGraph(tmpDir, {
      incremental: true,
      skipRegistry: true,
      engine: 'wasm',
      scope: ['caller.js'],
    });

    expect(readSymbolNames(dbPath, 'caller.js')).toContain('run');
    expect(readIncomingCalls(dbPath, 'target.js', 'target')).toEqual([]);
    expect(hasFileHashRow(dbPath, 'caller.js')).toBe(true);
  });
});
