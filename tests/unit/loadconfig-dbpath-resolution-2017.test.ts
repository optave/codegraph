/**
 * Regression tests for issue #2017: a further grep for `loadConfig(` (the
 * audit that fixed issue #1881) turned up more functions with the exact same
 * bug — they take a `customDbPath` (or equivalent) parameter but still called
 * bare `loadConfig()` / `loadConfig(process.cwd())`, so `--db
 * /other/repo/.codegraph/graph.db` invoked from a different directory read
 * the *invoking* directory's `.codegraphrc.json` instead of the target
 * repo's:
 *
 *   - resolveRiskConfig() (used by triageData()) — src/features/triage.ts
 *   - sequenceData() — src/features/sequence.ts
 *   - communitiesData() — src/features/communities.ts
 *   - statsData() — src/domain/analysis/module-map.ts
 *   - searchData() / multiSearchData() — src/domain/search/search/semantic.ts
 *   - resolveAnalysisOpts() — src/domain/analysis/query-helpers.ts (shared by
 *     fn-impact.ts, exports.ts, context.ts)
 *
 * Fixed the same way as #1881: replaced `opts.config || loadConfig()` with
 * `opts.config || resolveDbConfig(customDbPath)`, threading `customDbPath`
 * through wherever it wasn't already a local variable.
 *
 * Each test below spies on the real `loadConfig()` (the function
 * `resolveDbConfig()` ultimately calls) and asserts it was invoked with the
 * `--db` path's derived rootDir while `process.cwd()` is spoofed to an
 * unrelated, differently-configured directory — proving resolution came from
 * `--db`, not cwd.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigSpy = vi.hoisted(() => vi.fn());

// Delegate to the real loadConfig by default; this only records invocations.
vi.mock('../../src/infrastructure/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/infrastructure/config.js')>();
  loadConfigSpy.mockImplementation(mod.loadConfig);
  return { ...mod, loadConfig: loadConfigSpy };
});

import { initSchema } from '../../src/db/index.js';
import { contextData, explainData } from '../../src/domain/analysis/context.js';
import { exportsData } from '../../src/domain/analysis/exports.js';
import { fnImpactData } from '../../src/domain/analysis/fn-impact.js';
import { statsData } from '../../src/domain/analysis/module-map.js';
import { resolveAnalysisOpts } from '../../src/domain/analysis/query-helpers.js';
import { multiSearchData, searchData } from '../../src/domain/search/search/semantic.js';
import { communitiesData } from '../../src/features/communities.js';
import { sequenceData } from '../../src/features/sequence.js';
import { triageData } from '../../src/features/triage.js';

let repoDir: string;
let dbPath: string;
let unrelatedCwd: string;

function insertNode(db: Database.Database, name: string, kind: string, file: string, line: number) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(
  db: Database.Database,
  sourceId: number | bigint,
  targetId: number | bigint,
  kind: string,
) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2017-repo-'));
  fs.mkdirSync(path.join(repoDir, '.git'));
  fs.mkdirSync(path.join(repoDir, '.codegraph'));
  dbPath = path.join(repoDir, '.codegraph', 'graph.db');

  // Project config lives next to the DB, not at cwd.
  fs.writeFileSync(path.join(repoDir, '.codegraphrc.json'), JSON.stringify({}));

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File-level nodes + an import edge so communitiesData's fileLevel
  // dependency graph is non-empty (it early-returns, before ever resolving
  // config, when nodeCount or edgeCount is 0).
  const fBase = insertNode(db, 'lib/base.js', 'file', 'lib/base.js', 0);
  const fCaller = insertNode(db, 'lib/caller.js', 'file', 'lib/caller.js', 0);
  insertEdge(db, fCaller, fBase, 'imports');

  const target = insertNode(db, 'target', 'function', 'lib/base.js', 5);
  const caller = insertNode(db, 'caller', 'function', 'lib/caller.js', 5);
  insertEdge(db, caller, target, 'calls');

  db.close();

  // A separate directory with no .codegraphrc.json, used as process.cwd() to
  // prove config resolution ignores it in favor of the --db path.
  unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2017-unrelated-'));
});

afterAll(() => {
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  if (unrelatedCwd) fs.rmSync(unrelatedCwd, { recursive: true, force: true });
});

beforeEach(() => {
  loadConfigSpy.mockClear();
});

/** Every loadConfig() rootDir argument this call spied on. */
function resolvedRootDirs(): Array<string | undefined> {
  return loadConfigSpy.mock.calls.map((call) => call[0] as string | undefined);
}

describe('resolveRiskConfig / triageData (issue #2017)', () => {
  it('resolves config from the --db path rootDir, not process.cwd()', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      triageData(dbPath);
    } finally {
      cwdSpy.mockRestore();
    }
    // openRepo() ALREADY resolves config correctly (independent of this fix) for
    // engine/busy-timeout selection, so asserting resolvedRootDirs() merely
    // *contains* repoDir would pass even with the bug reverted. The bug's
    // signature is a SEPARATE, additional bare loadConfig() call with no rootDir
    // (falling back to cwd internally) — so the real assertion is that no call
    // was ever made with `undefined` once a customDbPath was actually supplied.
    expect(resolvedRootDirs()).toContain(repoDir);
    expect(resolvedRootDirs()).not.toContain(undefined);
  });
});

describe('sequenceData (issue #2017)', () => {
  it('resolves config from the --db path rootDir, not process.cwd()', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      sequenceData('target', dbPath);
    } finally {
      cwdSpy.mockRestore();
    }
    // See the note on the triageData test above — openRepo()'s own config
    // resolution is a decoy signal here too.
    expect(resolvedRootDirs()).toContain(repoDir);
    expect(resolvedRootDirs()).not.toContain(undefined);
  });
});

describe('communitiesData (issue #2017)', () => {
  it('resolves config from the --db path rootDir, not process.cwd()', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      communitiesData(dbPath);
    } finally {
      cwdSpy.mockRestore();
    }
    // loadCommunityGraph() -> openRepo()'s own config resolution is a decoy
    // signal here too — see the note on the triageData test above.
    expect(resolvedRootDirs()).toContain(repoDir);
    expect(resolvedRootDirs()).not.toContain(undefined);
  });
});

describe('statsData (issue #2017)', () => {
  it('resolves config from the --db path rootDir, not process.cwd()', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      statsData(dbPath);
    } finally {
      cwdSpy.mockRestore();
    }
    // openReadonlyWithNative()'s own config resolution is a decoy signal here
    // too — see the note on the triageData test above.
    expect(resolvedRootDirs()).toContain(repoDir);
    expect(resolvedRootDirs()).not.toContain(undefined);
  });
});

describe('searchData / multiSearchData (issue #2017)', () => {
  it('searchData resolves config from the --db path rootDir, not process.cwd()', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      await searchData('nonexistent-query', dbPath);
    } finally {
      cwdSpy.mockRestore();
    }
    // prepareSearch() -> resolveBusyTimeoutMs()'s own config resolution is a
    // decoy signal here too — see the note on the triageData test above.
    expect(resolvedRootDirs()).toContain(repoDir);
    expect(resolvedRootDirs()).not.toContain(undefined);
  });

  it('multiSearchData resolves config from the --db path rootDir, not process.cwd()', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      await multiSearchData(['nonexistent-query'], dbPath);
    } finally {
      cwdSpy.mockRestore();
    }
    expect(resolvedRootDirs()).toContain(repoDir);
    expect(resolvedRootDirs()).not.toContain(undefined);
  });
});

describe('resolveAnalysisOpts (issue #2017)', () => {
  it('resolves config from the given customDbPath rootDir when opts.config is absent', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      resolveAnalysisOpts(dbPath, {});
    } finally {
      cwdSpy.mockRestore();
    }
    expect(resolvedRootDirs()).toContain(repoDir);
  });

  it('falls back to process.cwd() when no customDbPath is given', () => {
    // deriveRootDirFromDbPath(undefined) returns undefined, so loadConfig()
    // is called with no rootDir and falls back to process.cwd() internally —
    // this is the correct, pre-existing "no --db given" fallback, distinct
    // from the bug (which called loadConfig() with no rootDir EVEN WHEN a
    // customDbPath was available).
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repoDir);
    try {
      const { config } = resolveAnalysisOpts(undefined, {});
      expect(config.db).toBeDefined();
    } finally {
      cwdSpy.mockRestore();
    }
    expect(resolvedRootDirs()).toContain(undefined);
  });

  // These 4 callers already pass `config: opts.config ?? dbConfig` into
  // resolveAnalysisOpts, where `dbConfig` comes from withRepo()/withReadonlyDb()
  // (already correctly resolved per #1941) — so `opts.config` is always truthy
  // by the time resolveAnalysisOpts runs, and its own resolveDbConfig(customDbPath)
  // fallback is never actually reached through these call sites today. These are
  // therefore wiring checks (the new customDbPath parameter threads through
  // without throwing — a signature mismatch would otherwise only be caught by
  // the type checker) rather than regression tests for this specific bug; the
  // two `resolveAnalysisOpts` tests above cover the fallback itself directly.
  describe('threaded through its callers (wiring only — see note above)', () => {
    it('fnImpactData', () => {
      fnImpactData('target', dbPath, { config: undefined as never });
      expect(resolvedRootDirs()).toContain(repoDir);
    });

    it('exportsData', () => {
      exportsData('base.js', dbPath, { config: undefined as never });
      expect(resolvedRootDirs()).toContain(repoDir);
    });

    it('contextData', () => {
      contextData('target', dbPath, { config: undefined as never });
      expect(resolvedRootDirs()).toContain(repoDir);
    });

    it('explainData', () => {
      explainData('target', dbPath, { config: undefined as never });
      expect(resolvedRootDirs()).toContain(repoDir);
    });
  });
});
