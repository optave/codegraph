/**
 * Regression guard for issue #2074: .claude/hooks/update-graph.sh's fallback
 * build path (used when the `codegraph` binary isn't on PATH) invoked
 * `node <project>/dist/cli.js build ...` with stderr redirected to
 * /dev/null and its exit code swallowed by `|| true`. On a genuinely fresh
 * checkout — before `npm run build` has ever produced dist/cli.js — the
 * hook silently no-oped with no visible error, identical in symptom to the
 * bug #1980 fixed (graph never rebuilds, contributor gets no feedback).
 *
 * The fix checks for dist/cli.js's existence up front (emitting a one-line
 * hint pointing at `npm install` / `npm run build`) and, for any other
 * build failure (e.g. the native better-sqlite3 binding not yet
 * installed), surfaces the captured stderr instead of discarding it —
 * while still always exiting 0 (informational only, never blocks).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'update-graph.sh');

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // The hook exits early unless the graph DB already exists (project has
  // been built/run at least once) — an empty file is enough to pass that guard.
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codegraph', 'graph.db'), '');
}

/**
 * A minimal PATH that provides node/git/bash (plus core POSIX utilities via
 * /usr/bin and /bin) but deliberately excludes any directory that might
 * also contain a globally installed `codegraph` binary, so the hook is
 * forced down its dist/cli.js fallback branch exactly like a contributor
 * who has never run `npm install -g @optave/codegraph`.
 */
function buildRestrictedPath(binDir: string): string {
  for (const bin of ['node', 'git', 'bash']) {
    const link = path.join(binDir, bin);
    if (!fs.existsSync(link)) {
      const real = execFileSync('which', [bin]).toString().trim();
      fs.symlinkSync(real, link);
    }
  }
  return `${binDir}:/usr/bin:/bin`;
}

function runHook(
  filePath: string,
  cwd: string,
  restrictedBinDir: string,
): { stdout: string; stderr: string; status: number | null } {
  const toolInput = JSON.stringify({ tool_input: { file_path: filePath } });
  const result = spawnSync('bash', [HOOK_PATH], {
    cwd,
    input: toolInput,
    env: { PATH: buildRestrictedPath(restrictedBinDir) },
    encoding: 'utf8',
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe('update-graph.sh surfaces a diagnostic instead of silently no-oping', () => {
  let tmpRoot: string;
  let binDir: string;

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-graph-test-')));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-graph-bin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('hints at npm install/build when dist/cli.js does not exist yet, and still exits 0', () => {
    const repo = path.join(tmpRoot, 'fresh-checkout');
    initRepo(repo);
    // No dist/ directory at all — the state of a genuinely fresh clone
    // before `npm run build` has ever produced dist/cli.js.
    const targetFile = path.join(repo, 'src', 'thing.ts');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, '// content\n');

    const { stderr, status } = runHook(targetFile, repo, binDir);

    expect(status).toBe(0);
    expect(stderr).toMatch(/dist\/cli\.js not found/);
    expect(stderr).toMatch(/npm install|npm run build/);
  });

  it('surfaces the captured build error (not /dev/null) when dist/cli.js exists but fails', () => {
    const repo = path.join(tmpRoot, 'broken-build');
    initRepo(repo);
    // dist/cli.js exists but is not a working CLI (simulates, e.g., a
    // missing native better-sqlite3 binding blowing up at require-time).
    fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'dist', 'cli.js'),
      "process.stderr.write('simulated native binding load failure\\n'); process.exit(1);\n",
    );
    const targetFile = path.join(repo, 'src', 'thing.ts');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, '// content\n');

    const { stderr, status } = runHook(targetFile, repo, binDir);

    expect(status).toBe(0);
    expect(stderr).toMatch(/graph rebuild failed/);
    expect(stderr).toMatch(/npm run doctor/);
    expect(stderr).toContain('simulated native binding load failure');
  });
});
