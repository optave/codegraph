/**
 * Regression guard for issue #2302: docs/examples/claude-code-hooks/
 * update-graph.sh — the template this repo ships for external consumers to
 * copy into their own `.claude/hooks/` — had the same silent-swallow
 * pattern issue #2074 fixed in this repo's own copy of the hook: both the
 * `codegraph`-on-PATH branch and the `npx` fallback branch redirected
 * stderr to /dev/null and swallowed the exit code with `|| true`, giving a
 * consumer no signal at all when a build genuinely failed (e.g. no
 * network, wrong/missing package, or any other npx/registry failure).
 *
 * The fix surfaces the captured stderr in a one-line, non-blocking
 * diagnostic on failure — mirroring the pattern #2074 applied to
 * .claude/hooks/update-graph.sh (see hook-update-graph-diagnostics.test.ts)
 * — while still always exiting 0 (informational only, never blocks).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'docs', 'examples', 'claude-code-hooks', 'update-graph.sh');

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

/** Write an executable shell script named `name` into `binDir` that prints `stderrMsg` to stderr and exits 1. */
function writeFailingScript(binDir: string, name: string, stderrMsg: string): void {
  const scriptPath = path.join(binDir, name);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\necho "${stderrMsg}" >&2\nexit 1\n`);
  fs.chmodSync(scriptPath, 0o755);
}

/**
 * A minimal PATH that provides node/git/bash (plus core POSIX utilities via
 * /usr/bin and /bin), plus whatever fake scripts the test has placed
 * directly in `binDir` (e.g. a fake `codegraph` or `npx`) — deliberately
 * excludes any directory that might contain a real globally installed
 * `codegraph` binary or a real `npx`, so the hook is forced down exactly
 * the branch under test.
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

// Mirrors hook-update-graph-diagnostics.test.ts's own platform guard: this
// suite fakes binaries via executable shell scripts on a POSIX-style PATH,
// which is not reliably available on win32 CI runners.
describe.skipIf(process.platform === 'win32')(
  'docs template update-graph.sh surfaces a diagnostic instead of silently no-oping (#2302)',
  () => {
    let tmpRoot: string;
    let binDir: string;

    beforeEach(() => {
      tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-graph-docs-test-')));
      binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-graph-docs-bin-'));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    });

    it('surfaces the captured build error when `codegraph` is on PATH but fails', () => {
      const repo = path.join(tmpRoot, 'codegraph-on-path');
      initRepo(repo);
      writeFailingScript(binDir, 'codegraph', 'simulated codegraph build failure');
      const targetFile = path.join(repo, 'src', 'thing.ts');
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, '// content\n');

      const { stderr, status } = runHook(targetFile, repo, binDir);

      expect(status).toBe(0);
      expect(stderr).toMatch(/graph rebuild failed/);
      expect(stderr).toContain('simulated codegraph build failure');
    });

    it('surfaces the captured build error via the npx fallback when `codegraph` is not on PATH', () => {
      const repo = path.join(tmpRoot, 'npx-fallback');
      initRepo(repo);
      // No `codegraph` script in binDir — forces the hook's `else` branch.
      writeFailingScript(binDir, 'npx', 'simulated npx registry failure');
      const targetFile = path.join(repo, 'src', 'thing.ts');
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, '// content\n');

      const { stderr, status } = runHook(targetFile, repo, binDir);

      expect(status).toBe(0);
      expect(stderr).toMatch(/graph rebuild failed/);
      expect(stderr).toContain('simulated npx registry failure');
    });
  },
);
