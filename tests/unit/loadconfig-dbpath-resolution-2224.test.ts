/**
 * Regression tests for issue #2224: `deriveRootDirFromDbPath()` (used by
 * `resolveDbConfig()`/`resolveBusyTimeoutMs()`) unconditionally stripped
 * exactly two path components from the resolved `--db` path, assuming the
 * `<rootDir>/.codegraph/graph.db` convention. `resolveCustomDbPath()`
 * returns an explicit *file* path as-is when it already exists, so
 * `--db /repo/custom.db` (a real file, just not named/located per
 * convention) resolved to rootDir `/repo/..` — the repo's parent, not the
 * repo itself — silently reading the wrong (or no) `.codegraphrc.json`.
 *
 * Mirrors loadconfig-dbpath-resolution.test.ts's style: mock
 * `process.cwd()` to an unrelated, unconfigured directory to prove
 * resolution comes from the `--db` path, not cwd (and not the `--db`
 * path's grandparent either).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDbConfig } from '../../src/db/index.js';

const REPO_BUSY_TIMEOUT_MS = 24680;
const PARENT_BUSY_TIMEOUT_MS = 99999;

let repoDir: string;
let parentDir: string;
let customDbFile: string;
let unrelatedCwd: string;

beforeAll(() => {
  // repoDir's OWN parent also has a .codegraphrc.json, with a DIFFERENT
  // busyTimeoutMs — if the bug's "grandparent" derivation were still active,
  // resolution would silently pick this one up instead of repoDir's.
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2224-parent-'));
  repoDir = fs.mkdtempSync(path.join(parentDir, 'repo-'));
  customDbFile = path.join(repoDir, 'custom.db'); // NOT inside .codegraph/
  fs.writeFileSync(customDbFile, ''); // resolveCustomDbPath requires it to exist as a file

  fs.writeFileSync(
    path.join(parentDir, '.codegraphrc.json'),
    JSON.stringify({ db: { busyTimeoutMs: PARENT_BUSY_TIMEOUT_MS } }),
  );
  fs.writeFileSync(
    path.join(repoDir, '.codegraphrc.json'),
    JSON.stringify({ db: { busyTimeoutMs: REPO_BUSY_TIMEOUT_MS } }),
  );

  unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2224-unrelated-'));
});

afterAll(() => {
  fs.rmSync(parentDir, { recursive: true, force: true });
  fs.rmSync(unrelatedCwd, { recursive: true, force: true });
});

describe('resolveDbConfig / deriveRootDirFromDbPath (#2224)', () => {
  it('derives rootDir from a non-conventional --db file (not inside .codegraph/), not its grandparent', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      const config = resolveDbConfig(customDbFile);
      expect(config.db?.busyTimeoutMs).toBe(REPO_BUSY_TIMEOUT_MS);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('still derives the correct rootDir for the conventional <rootDir>/.codegraph/graph.db layout', () => {
    const conventionalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2224-conventional-'));
    try {
      fs.mkdirSync(path.join(conventionalDir, '.codegraph'), { recursive: true });
      const dbPath = path.join(conventionalDir, '.codegraph', 'graph.db');
      fs.writeFileSync(dbPath, '');
      fs.writeFileSync(
        path.join(conventionalDir, '.codegraphrc.json'),
        JSON.stringify({ db: { busyTimeoutMs: REPO_BUSY_TIMEOUT_MS } }),
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
      try {
        expect(resolveDbConfig(dbPath).db?.busyTimeoutMs).toBe(REPO_BUSY_TIMEOUT_MS);
      } finally {
        cwdSpy.mockRestore();
      }
    } finally {
      fs.rmSync(conventionalDir, { recursive: true, force: true });
    }
  });

  it('walks up past a --db file nested several levels deep in a non-git project', () => {
    // os.tmpdir() is not itself inside a git repository, so findRepoRoot
    // returns null here — the walk-up must not stop after just one
    // directory in that case (Greptile review: a null git ceiling
    // previously made the search give up immediately).
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2224-nogit-'));
    try {
      fs.writeFileSync(
        path.join(nonGitRoot, '.codegraphrc.json'),
        JSON.stringify({ db: { busyTimeoutMs: REPO_BUSY_TIMEOUT_MS } }),
      );
      const nestedDir = path.join(nonGitRoot, 'nested', 'deep');
      fs.mkdirSync(nestedDir, { recursive: true });
      const nestedDbFile = path.join(nestedDir, 'custom.db');
      fs.writeFileSync(nestedDbFile, '');

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
      try {
        expect(resolveDbConfig(nestedDbFile).db?.busyTimeoutMs).toBe(REPO_BUSY_TIMEOUT_MS);
      } finally {
        cwdSpy.mockRestore();
      }
    } finally {
      fs.rmSync(nonGitRoot, { recursive: true, force: true });
    }
  });
});
