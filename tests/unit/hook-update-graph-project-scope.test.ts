/**
 * Regression guard for issue #2134: .claude/hooks/update-graph.sh had two
 * compounding bugs.
 *
 * 1. `PROJECT_DIR` was derived from `git rev-parse --show-toplevel` run in
 *    the *session's cwd*, not from the edited file's own location. Editing
 *    a file entirely outside the current project (a different repo, or a
 *    path with no repo at all) still rebuilt whatever repo the session
 *    happened to be cd'ed into.
 * 2. The build binary was resolved via `command -v codegraph` (any global
 *    binary on PATH) before ever checking for the project's own local
 *    `dist/cli.js` build — a stale/mismatched global binary could silently
 *    rebuild the graph with different parsing logic than the checked-out
 *    version.
 *
 * The fix derives `PROJECT_DIR` from `dirname "$FILE_PATH"`'s own git
 * toplevel (exiting early if the file isn't inside any git repo at all),
 * and prefers the project-local `dist/cli.js` over a global `codegraph`,
 * falling back to the global binary only when no local build exists.
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
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codegraph', 'graph.db'), '');
}

/** A fake dist/cli.js that records it was invoked (with which project dir) and exits 0. */
function installFakeCli(repo: string, sentinel: string): void {
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'dist', 'cli.js'),
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, process.argv.slice(2).join(' '));\n`,
  );
}

function buildRestrictedPath(binDir: string, extra: string[] = []): string {
  for (const bin of ['node', 'git', 'bash']) {
    const link = path.join(binDir, bin);
    if (!fs.existsSync(link)) {
      const real = execFileSync('which', [bin]).toString().trim();
      fs.symlinkSync(real, link);
    }
  }
  return [binDir, ...extra, '/usr/bin', '/bin'].join(':');
}

function runHook(
  filePath: string,
  cwd: string,
  pathValue: string,
): { stderr: string; status: number | null } {
  const toolInput = JSON.stringify({ tool_input: { file_path: filePath } });
  const result = spawnSync('bash', [HOOK_PATH], {
    cwd,
    input: toolInput,
    env: { PATH: pathValue },
    encoding: 'utf8',
  });
  return { stderr: result.stderr ?? '', status: result.status };
}

describe.skipIf(process.platform === 'win32')(
  "update-graph.sh scopes rebuilds to the edited file's own project (#2134)",
  () => {
    let tmpRoot: string;
    let binDir: string;

    beforeEach(() => {
      tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-graph-scope-')));
      binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-graph-scope-bin-'));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    });

    it('does not rebuild the session-cwd project when the edited file is outside any git repo', () => {
      const sessionRepo = path.join(tmpRoot, 'session-repo');
      initRepo(sessionRepo);
      const sentinel = path.join(tmpRoot, 'session-repo-was-built');
      installFakeCli(sessionRepo, sentinel);

      // File lives entirely outside any git repo.
      const outsideDir = path.join(tmpRoot, 'no-repo-scratch');
      fs.mkdirSync(outsideDir, { recursive: true });
      const targetFile = path.join(outsideDir, 'scratch.ts');
      fs.writeFileSync(targetFile, '// scratch\n');

      const { status } = runHook(targetFile, sessionRepo, buildRestrictedPath(binDir));

      expect(status).toBe(0);
      expect(fs.existsSync(sentinel)).toBe(false);
    });

    it("rebuilds the edited file's own project, not the session-cwd project, when they differ", () => {
      const sessionRepo = path.join(tmpRoot, 'session-repo');
      initRepo(sessionRepo);
      const sessionSentinel = path.join(tmpRoot, 'session-repo-was-built');
      installFakeCli(sessionRepo, sessionSentinel);

      const otherRepo = path.join(tmpRoot, 'other-repo');
      initRepo(otherRepo);
      const otherSentinel = path.join(tmpRoot, 'other-repo-was-built');
      installFakeCli(otherRepo, otherSentinel);

      const targetFile = path.join(otherRepo, 'src', 'thing.ts');
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, '// content\n');

      const { status } = runHook(targetFile, sessionRepo, buildRestrictedPath(binDir));

      expect(status).toBe(0);
      expect(fs.existsSync(otherSentinel)).toBe(true);
      expect(fs.existsSync(sessionSentinel)).toBe(false);
    });

    it('prefers the project-local dist/cli.js over a global codegraph on PATH', () => {
      const repo = path.join(tmpRoot, 'repo-with-local-build');
      initRepo(repo);
      const localSentinel = path.join(tmpRoot, 'local-cli-was-called');
      installFakeCli(repo, localSentinel);

      // A fake global `codegraph` that would prove the bug if it ran.
      const globalSentinel = path.join(tmpRoot, 'global-codegraph-was-called');
      const globalBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-graph-scope-globalbin-'));
      fs.writeFileSync(
        path.join(globalBinDir, 'codegraph'),
        `#!/usr/bin/env bash\ntouch ${JSON.stringify(globalSentinel)}\nexit 0\n`,
      );
      fs.chmodSync(path.join(globalBinDir, 'codegraph'), 0o755);

      const targetFile = path.join(repo, 'src', 'thing.ts');
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, '// content\n');

      const { status } = runHook(targetFile, repo, buildRestrictedPath(binDir, [globalBinDir]));

      expect(status).toBe(0);
      expect(fs.existsSync(localSentinel)).toBe(true);
      expect(fs.existsSync(globalSentinel)).toBe(false);

      fs.rmSync(globalBinDir, { recursive: true, force: true });
    });
  },
);
