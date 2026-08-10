/**
 * Unit tests for detectChanges pipeline stage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initSchema, openDb } from '../../src/db/index.js';
import { PipelineContext } from '../../src/domain/graph/builder/context.js';
import {
  detectChanges,
  detectNoChanges,
  isUnreadableBuildStateError,
} from '../../src/domain/graph/builder/stages/detect-changes.js';
import { writeJournalHeader } from '../../src/domain/graph/journal.js';
import { DbError } from '../../src/shared/errors.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-detect-'));
  fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const a = 1;');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectChanges stage', () => {
  it('treats an empty file_hashes table as a full build (#2261)', async () => {
    const dbDir = path.join(tmpDir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    const ctx = new PipelineContext();
    ctx.rootDir = tmpDir;
    ctx.db = db;
    ctx.allFiles = [path.join(tmpDir, 'a.js')];
    ctx.opts = {};
    ctx.incremental = true;
    ctx.forceFullRebuild = false;
    ctx.config = {};

    await detectChanges(ctx);

    // `initSchema` always creates `file_hashes`, so a first-ever build reaches
    // here with the table present and empty. That is zero prior state to diff
    // against — a from-scratch build, not an incremental one. Labelling it
    // incremental routed role classification through the incremental
    // classifier, which skips #2032's whole-graph reachability downgrade, so
    // a project's first build disagreed with both a later `--no-incremental`
    // rebuild and the native engine (#2407) about which symbols are dead.
    expect(ctx.isFullBuild).toBe(true);
    expect(ctx.earlyExit).toBe(false);
    expect(ctx.parseChanges.length).toBe(1);
    closeDb(db);
  });

  it('throws instead of wiping the graph when file_hashes exists but is unreadable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-unreadable-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;');

    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    // Real prior build state that a from-scratch build would destroy.
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      'a.js',
      'deadbeef',
      1,
      1,
    );

    // Drop `size` so the loader's SELECT fails while the table itself still
    // exists. `initSchema` always runs migrations, so a genuinely old DB gets
    // this column backfilled rather than reaching here — this is a
    // deterministic stand-in for the corruption, lock and I/O failures that hit
    // the same catch and cannot be provoked reliably in a test. What matters is
    // the shape: table present, read fails. It must not be read as "no prior
    // build".
    db.exec('ALTER TABLE file_hashes DROP COLUMN size');

    const ctx = new PipelineContext();
    ctx.rootDir = dir;
    ctx.db = db;
    ctx.allFiles = [path.join(dir, 'a.js')];
    ctx.opts = {};
    ctx.incremental = true;
    ctx.forceFullRebuild = false;
    ctx.config = {};

    await expect(detectChanges(ctx)).rejects.toThrow(DbError);

    // The decisive assertion: `handleFullBuild` never ran, so the stored state
    // survives. Returning null here instead would have DELETEd every graph
    // table — nodes, edges, file_hashes, embeddings — over a transient fault.
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM file_hashes').get() as { c: number };
    expect(remaining.c).toBe(1);
    expect(ctx.isFullBuild).not.toBe(true);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects early exit when no changes after initial build', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-nochange-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;');

    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    // Seed file_hashes so incremental thinks file is unchanged
    const content = fs.readFileSync(path.join(dir, 'a.js'), 'utf-8');
    const { createHash } = await import('node:crypto');
    const hash = createHash('md5').update(content).digest('hex');
    const stat = fs.statSync(path.join(dir, 'a.js'));
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      'a.js',
      hash,
      Math.floor(stat.mtimeMs),
      stat.size,
    );

    // Write journal header so journal check doesn't confuse things
    writeJournalHeader(dir, Date.now());

    const ctx = new PipelineContext();
    ctx.rootDir = dir;
    ctx.db = db;
    ctx.allFiles = [path.join(dir, 'a.js')];
    ctx.opts = {};
    ctx.incremental = true;
    ctx.forceFullRebuild = false;
    ctx.config = {};

    await detectChanges(ctx);

    expect(ctx.earlyExit).toBe(true);
    // DB should be closed by detectChanges on early exit
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips change detection for scoped builds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-scope-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;');

    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    const ctx = new PipelineContext();
    ctx.rootDir = dir;
    ctx.db = db;
    ctx.allFiles = [path.join(dir, 'a.js')];
    ctx.opts = { scope: ['a.js'] };
    ctx.incremental = true;
    ctx.forceFullRebuild = false;
    ctx.config = {};
    ctx.parseChanges = [{ file: path.join(dir, 'a.js'), relPath: 'a.js' }];
    ctx.removed = [];
    ctx.isFullBuild = false;

    await detectChanges(ctx);

    // Should return without modifying isFullBuild
    expect(ctx.isFullBuild).toBe(false);
    expect(ctx.earlyExit).toBe(false);
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('forces full rebuild when forceFullRebuild is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-force-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;');

    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    const ctx = new PipelineContext();
    ctx.rootDir = dir;
    ctx.db = db;
    ctx.allFiles = [path.join(dir, 'a.js')];
    ctx.opts = {};
    ctx.incremental = true;
    ctx.forceFullRebuild = true;
    ctx.config = {};

    await detectChanges(ctx);

    expect(ctx.isFullBuild).toBe(true);
    expect(ctx.parseChanges.length).toBe(1);
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('detectNoChanges fast-skip', () => {
  function seedFile(dir: string, name: string, content: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function seedHashRow(
    db: ReturnType<typeof openDb>,
    relPath: string,
    filePath: string,
  ): { mtime: number; size: number } {
    const stat = fs.statSync(filePath);
    const mtime = Math.floor(stat.mtimeMs);
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      relPath,
      'deadbeef',
      mtime,
      stat.size,
    );
    return { mtime, size: stat.size };
  }

  it('throws rather than falling through when file_hashes is unreadable', () => {
    // This pre-flight must not answer "false" (fall through) for an unreadable
    // table. pipeline.ts treats pre-flight failures as best-effort, so falling
    // through hands the build to the Rust orchestrator, whose loader still
    // reads a failed row query as "no prior state" and rebuilds from scratch —
    // the exact wipe this guards against on the JS path.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-unreadable-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);
    db.exec('ALTER TABLE file_hashes DROP COLUMN size');

    let thrown: unknown;
    try {
      detectNoChanges(db, [file], dir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DbError);
    // The code is what pipeline.ts keys on to re-throw instead of falling through.
    expect(isUnreadableBuildStateError(thrown)).toBe(true);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tags a failure of the table-existence probe itself as unreadable state', () => {
    // The `sqlite_master` probe can fail too (lock, corruption, I/O). If that
    // error escapes untagged, pipeline.ts does not recognise it, treats the
    // pre-flight as best-effort, and falls through to the native loader — which
    // reads it as absent state and wipes. Being unable to determine whether
    // prior state exists is not evidence that it doesn't.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-probe-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);

    // Force the existence probe to fail while leaving the handle usable enough
    // to reach it, by stubbing `prepare` for the sqlite_master query only.
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes('sqlite_master')) throw new Error('database disk image is malformed');
      return realPrepare(sql);
    };

    let thrown: unknown;
    try {
      detectNoChanges(db, [file], dir);
    } catch (e) {
      thrown = e;
    }
    expect(isUnreadableBuildStateError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('database disk image is malformed');

    (db as unknown as { prepare: unknown }).prepare = realPrepare;
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when file_hashes is empty (first build)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-empty-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');

    expect(detectNoChanges(db, [file], dir)).toBe(false);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns true when mtime+size match seeded file_hashes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-match-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);

    expect(detectNoChanges(db, [file], dir)).toBe(true);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when a tracked file has been deleted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-deleted-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);
    seedHashRow(db, 'gone.js', file); // tracked but no longer on disk

    expect(detectNoChanges(db, [file], dir)).toBe(false);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when mtime differs from seeded value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-mtime-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    const stat = fs.statSync(file);
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      'a.js',
      'deadbeef',
      Math.floor(stat.mtimeMs) + 1000, // skewed mtime
      stat.size,
    );

    expect(detectNoChanges(db, [file], dir)).toBe(false);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when CFG analysis is enabled but cfg_blocks is empty (#1064)', () => {
    // Pending-analysis guard: even though mtime+size match, if cfg_blocks
    // is empty (analysis newly enabled), the caller must fall through so
    // runPendingAnalysis can populate the table.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-pendingCfg-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);
    // cfg_blocks table is created empty by initSchema — that's the trigger.

    // Without opts: legacy behaviour — fast-skip returns true.
    expect(detectNoChanges(db, [file], dir)).toBe(true);
    // With cfg enabled (cfg !== false) and cfg_blocks empty: must return false.
    expect(detectNoChanges(db, [file], dir, { cfg: true, dataflow: false })).toBe(false);
    // When cfg explicitly disabled (and dataflow disabled too so its guard
    // doesn't fire), the empty cfg table is irrelevant.
    expect(detectNoChanges(db, [file], dir, { cfg: false, dataflow: false })).toBe(true);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when dataflow is enabled but dataflow table is empty (#1064)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-pendingDf-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);

    // Disable cfg so only the dataflow guard is exercised.
    expect(detectNoChanges(db, [file], dir, { cfg: false, dataflow: true })).toBe(false);
    expect(detectNoChanges(db, [file], dir, { cfg: false, dataflow: false })).toBe(true);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
