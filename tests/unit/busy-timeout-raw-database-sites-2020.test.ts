/**
 * Regression tests for issue #2020: several call sites opened better-sqlite3
 * directly via `new Database(dbPath, { readonly: true })`, bypassing
 * `openReadonlyOrFail()`/`resolveBusyTimeoutMs()` entirely — so they never
 * set `PRAGMA busy_timeout` at all (not even the hardcoded default), unlike
 * every other read-only call site fixed by #1763/#1881.
 *
 * Mirrors the `captureBusyTimeoutPragmas()` technique from
 * `busy-timeout-query-sites.test.ts` (#1763): each test opens a real
 * temp project with a configured `db.busyTimeoutMs`, exercises the fixed
 * call site, and asserts the configured value actually reached
 * `PRAGMA busy_timeout`.
 *
 * `src/features/branch-compare.ts`'s two fixed call sites
 * (`loadSymbolsFromDb`/`loadCallersFromDb`) are exported specifically for
 * this direct testing, mirroring the same file's existing
 * `openNativeDbForFanMetrics` export (added for the same reason during
 * #1882). Testing them only through `branchCompareData()`'s full
 * git-worktree flow would be a decoy: `buildGraph()` and other already-fixed
 * call sites in that flow already call `busy_timeout` correctly, so a bare
 * "was busy_timeout called at all" assertion would pass even with these two
 * functions' own fix reverted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, initSchema, openDb } from '../../src/db/index.js';
import { NativeRepository } from '../../src/db/repository/native-repository.js';
import { loadCallersFromDb, loadSymbolsFromDb } from '../../src/features/branch-compare.js';
import { snapshotSave } from '../../src/features/snapshot.js';
import type { McpToolContext, NativeDatabase } from '../../src/types.js';

const CUSTOM_BUSY_TIMEOUT_MS = 42424;

let tmpDir: string;
let dbPath: string;

/** Capture every `busy_timeout = N` pragma issued against a real Database instance. */
function captureBusyTimeoutPragmas(): { calls: string[]; restore: () => void } {
  const original = Database.prototype.pragma;
  const calls: string[] = [];
  const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
    this: unknown,
    sql: string,
    ...rest: unknown[]
  ) {
    if (typeof sql === 'string' && sql.startsWith('busy_timeout')) calls.push(sql);
    return original.apply(this, [sql, ...rest] as Parameters<typeof original>);
  });
  return { calls, restore: () => spy.mockRestore() };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2020-raw-db-'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);
  closeDb(db);
  fs.writeFileSync(
    path.join(tmpDir, '.codegraphrc.json'),
    JSON.stringify({ db: { busyTimeoutMs: CUSTOM_BUSY_TIMEOUT_MS } }),
  );
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('configured busyTimeoutMs reaches the remaining raw new Database() call sites (issue #2020)', () => {
  it('snapshotSave applies the configured busy_timeout', () => {
    const capture = captureBusyTimeoutPragmas();
    try {
      snapshotSave('snap1', { dbPath });
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it('find_cycles MCP tool handler applies the configured busy_timeout', async () => {
    const { handler } = await import('../../src/mcp/tools/find-cycles.js');
    const ctx: McpToolContext = {
      dbPath,
      getQueries: async () => ({}),
      getDatabase: () => Database,
      findDbPath: (await import('../../src/db/index.js')).findDbPath,
      allowedRepos: undefined,
      MCP_MAX_LIMIT: 500,
    };
    const capture = captureBusyTimeoutPragmas();
    try {
      await handler({}, ctx);
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it('export_graph MCP tool handler applies the configured busy_timeout', async () => {
    const { handler } = await import('../../src/mcp/tools/export-graph.js');
    const ctx: McpToolContext = {
      dbPath,
      getQueries: async () => ({}),
      getDatabase: () => Database,
      findDbPath: (await import('../../src/db/index.js')).findDbPath,
      allowedRepos: undefined,
      MCP_MAX_LIMIT: 500,
    };
    const capture = captureBusyTimeoutPragmas();
    try {
      await handler({ format: 'json' }, ctx);
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it("NativeRepository's lazy fallback DB applies the configured busy_timeout", () => {
    // A native handle missing getFileHash forces the better-sqlite3 fallback
    // path (#getFallbackDb) — an empty stub is enough since getFileHash()
    // only checks `typeof this.#ndb.getFileHash === 'function'` before
    // falling back.
    const repo = new NativeRepository({} as unknown as NativeDatabase, dbPath);
    const capture = captureBusyTimeoutPragmas();
    try {
      repo.getFileHash('src/whatever.ts');
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it('branch-compare loadSymbolsFromDb applies the configured busy_timeout', () => {
    const capture = captureBusyTimeoutPragmas();
    try {
      loadSymbolsFromDb(dbPath, [], false);
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it('branch-compare loadCallersFromDb applies the configured busy_timeout', () => {
    const capture = captureBusyTimeoutPragmas();
    try {
      loadCallersFromDb(dbPath, [1], 5, false);
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });
});
