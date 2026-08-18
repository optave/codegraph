/**
 * Unit tests for collectFiles pipeline stage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initSchema, openDb } from '../../src/db/index.js';
import { PipelineContext } from '../../src/domain/graph/builder/context.js';
import { readGitignorePatterns } from '../../src/domain/graph/builder/helpers.js';
import { collectFiles } from '../../src/domain/graph/builder/stages/collect-files.js';
import { appendJournalEntries, writeJournalHeader } from '../../src/domain/graph/journal.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-collect-'));
  fs.mkdirSync(path.join(tmpDir, 'src'));
  fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'b.ts'), 'export const b = 2;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'c.mts'), 'export const c = 3;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'd.cts'), 'export const d = 4;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'style.css'), 'body {}');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectFiles stage', () => {
  it('populates ctx.allFiles and ctx.discoveredDirs', async () => {
    const ctx = new PipelineContext();
    ctx.rootDir = tmpDir;
    ctx.config = {};
    ctx.opts = {};

    await collectFiles(ctx);

    expect(ctx.allFiles.length).toBe(4); // a.js + b.ts + c.mts + d.cts, not style.css
    const basenames = ctx.allFiles.map((f) => path.basename(f));
    expect(basenames).toContain('a.js');
    expect(basenames).toContain('b.ts');
    // .mts/.cts are TypeScript's ESM/CJS module extensions — must be walked
    // like any other TypeScript file, not silently skipped (#2073).
    expect(basenames).toContain('c.mts');
    expect(basenames).toContain('d.cts');
    expect(basenames).not.toContain('style.css');
    expect(ctx.discoveredDirs).toBeInstanceOf(Set);
    expect(ctx.discoveredDirs.size).toBeGreaterThan(0);
  });

  it('handles scoped rebuild', async () => {
    const ctx = new PipelineContext();
    ctx.rootDir = tmpDir;
    ctx.config = {};
    ctx.opts = { scope: ['src/a.js'] };

    await collectFiles(ctx);

    expect(ctx.allFiles).toHaveLength(1);
    expect(ctx.isFullBuild).toBe(false);
    expect(ctx.parseChanges).toHaveLength(1);
    expect(ctx.parseChanges[0].relPath).toBe('src/a.js');
    expect(ctx.removed).toHaveLength(0);
  });

  it('scoped rebuild with missing file marks it as removed', async () => {
    const ctx = new PipelineContext();
    ctx.rootDir = tmpDir;
    ctx.config = {};
    ctx.opts = { scope: ['nonexistent.js'] };

    await collectFiles(ctx);

    expect(ctx.allFiles).toHaveLength(0);
    expect(ctx.parseChanges).toHaveLength(0);
    expect(ctx.removed).toContain('nonexistent.js');
  });

  // Regression test for issue #2512: the incremental fast path
  // (tryFastCollect) reconstructs allFiles purely from file_hashes + journal
  // deltas, never re-applying IGNORE_DIRS — so a file that was indexed
  // before its directory joined the ignore list (e.g. `vendor`) survives
  // every subsequent incremental rebuild, unlike the full filesystem walk.
  it('fast path re-applies IGNORE_DIRS to file_hashes rows from before a dir was ignored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-collect-fastpath-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(dir, 'vendor', 'stale.go'), 'package vendor');

    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    // Simulate a file_hashes row that predates `vendor` joining IGNORE_DIRS
    // (or that slipped in through any other means) — the exact scenario
    // #2512 describes.
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      'vendor/stale.go',
      'deadbeef',
      1,
      1,
    );
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      'src/a.ts',
      'cafebabe',
      1,
      1,
    );

    // A journal with entries proves the watcher was active — required for
    // tryFastCollect to apply at all (an empty-but-valid journal falls
    // through to the full walk, which would mask this bug).
    writeJournalHeader(dbDir, Date.now());
    appendJournalEntries(dbDir, [{ file: 'src/a.ts' }]);

    const ctx = new PipelineContext();
    ctx.rootDir = dir;
    ctx.dbPath = path.join(dbDir, 'graph.db');
    ctx.db = db;
    ctx.opts = {};
    ctx.incremental = true;
    ctx.forceFullRebuild = false;
    ctx.config = {};

    await collectFiles(ctx);

    const relFiles = ctx.allFiles.map((f) => path.relative(dir, f).replace(/\\/g, '/'));
    expect(relFiles).toContain('src/a.ts');
    expect(relFiles).not.toContain('vendor/stale.go');

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('readGitignorePatterns', () => {
  let gitignoreDir: string;

  afterEach(() => {
    if (gitignoreDir) fs.rmSync(gitignoreDir, { recursive: true, force: true });
  });

  it('returns empty array when no .gitignore exists', () => {
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
    const regexes = readGitignorePatterns(gitignoreDir);
    expect(regexes).toHaveLength(0);
  });

  it('compiles path-specific patterns (e.g. crates/codegraph-core/index.js)', () => {
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
    fs.writeFileSync(
      path.join(gitignoreDir, '.gitignore'),
      'crates/codegraph-core/index.js\ncrates/codegraph-core/index.d.ts\n',
    );
    const regexes = readGitignorePatterns(gitignoreDir);
    expect(regexes.length).toBeGreaterThan(0);
    // These specific paths should be excluded
    expect(regexes.some((r) => r.test('crates/codegraph-core/index.js'))).toBe(true);
    expect(regexes.some((r) => r.test('crates/codegraph-core/index.d.ts'))).toBe(true);
    // But sibling source files should NOT be excluded
    expect(regexes.some((r) => r.test('crates/codegraph-core/src/lib.rs'))).toBe(false);
  });

  it('skips comments, empty lines, and negation patterns', () => {
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
    fs.writeFileSync(
      path.join(gitignoreDir, '.gitignore'),
      '# comment\n\n!negated.js\ngenerated.js\n',
    );
    const regexes = readGitignorePatterns(gitignoreDir);
    // Only generated.js should produce a regex; comments, blank lines, and negations are skipped
    expect(regexes.some((r) => r.test('src/generated.js'))).toBe(true);
  });

  it('expands bare filename patterns to match at any depth', () => {
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
    fs.writeFileSync(path.join(gitignoreDir, '.gitignore'), '*.db\n');
    const regexes = readGitignorePatterns(gitignoreDir);
    expect(regexes.some((r) => r.test('data.db'))).toBe(true);
    expect(regexes.some((r) => r.test('nested/deep/data.db'))).toBe(true);
  });

  it('collectFiles respects .gitignore when walking the filesystem', async () => {
    // Reproduce the original issue: NAPI-RS generated files in crates/ are gitignored
    // and must be excluded from WASM analysis without adding 'crates' to IGNORE_DIRS.
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-crates-'));
    // Create a tracked source file in a 'crates/' subdirectory
    fs.mkdirSync(path.join(gitignoreDir, 'crates', 'my-lib', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(gitignoreDir, 'crates', 'my-lib', 'src', 'index.ts'),
      'export const x = 1;',
    );
    // Create a gitignored generated file (the artifact that caused the false complexity)
    fs.mkdirSync(path.join(gitignoreDir, 'crates', 'codegraph-core'), { recursive: true });
    fs.writeFileSync(
      path.join(gitignoreDir, 'crates', 'codegraph-core', 'index.js'),
      '// generated',
    );
    // Write .gitignore that excludes only the generated file
    fs.writeFileSync(path.join(gitignoreDir, '.gitignore'), 'crates/codegraph-core/index.js\n');

    const ctx = new PipelineContext();
    ctx.rootDir = gitignoreDir;
    ctx.config = {};
    ctx.opts = {};

    await collectFiles(ctx);

    const basenames = ctx.allFiles.map((f) => path.basename(f));
    // Tracked source in crates/ MUST be included
    expect(basenames).toContain('index.ts');
    // Gitignored generated artifact MUST be excluded
    expect(
      ctx.allFiles.some((f) => f.includes('codegraph-core') && path.basename(f) === 'index.js'),
    ).toBe(false);
  });
});
