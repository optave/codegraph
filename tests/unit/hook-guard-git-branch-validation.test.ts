/**
 * Regression guard for issue #2386: `.claude/hooks/guard-git.sh`'s branch
 * validation fell back to the hook process's own ambient cwd whenever it
 * couldn't parse a `-C <dir>` / `cd <dir> &&` prefix out of the command
 * text — which is exactly what happens for a bare `git push` relying on
 * the Bash tool's persistent cwd from an EARLIER, separate tool call. For a
 * subagent pushing to a different repository, that validated the wrong
 * repo's branch entirely and denied a perfectly valid push.
 *
 * The fix: read the hook's own top-level `cwd` field (the Bash tool's
 * actual cwd for this call, reported on every PreToolUse payload) as the
 * fallback instead, and decline to validate at all (allow) rather than
 * guess when even that isn't available.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'guard-git.sh');

interface HookDecision {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

function runHook(command: string, opts: { cwd?: string; hookCwd?: string } = {}): HookDecision {
  const payload: Record<string, unknown> = { tool_input: { command } };
  if (opts.hookCwd) payload.cwd = opts.hookCwd;
  const stdout = execFileSync('bash', [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: opts.cwd,
  });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function initRepo(dir: string, branch: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('guard-git.sh branch validation resolves the actual push target (#2386)', () => {
  let base: string;
  let sessionRepo: string;
  let otherRepo: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-git-branch-'));
    sessionRepo = path.join(base, 'session-repo');
    otherRepo = path.join(base, 'other-repo');
    // The orchestrator's own worktree branch — invalid pattern, matching the
    // repro in #2386 (a branch name that appears nowhere in the command the
    // subagent actually ran).
    initRepo(sessionRepo, 'claude/optave-project-rollout-420503');
    // The subagent's actual target repo, on a valid branch.
    initRepo(otherRepo, 'chore/codegraph-onboarding');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('uses the hook payload cwd for a bare git push with no -C/cd, not the hook process ambient cwd', () => {
    const result = runHook('git push -u origin chore/codegraph-onboarding', {
      cwd: sessionRepo, // hook process's own ambient cwd — the WRONG repo
      hookCwd: otherRepo, // reported cwd on the PreToolUse payload — the RIGHT repo
    });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('still denies when the payload cwd itself resolves to an invalid branch, and names it', () => {
    const result = runHook('git push -u origin claude/optave-project-rollout-420503', {
      cwd: otherRepo,
      hookCwd: sessionRepo,
    });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(sessionRepo);
  });

  it('still prefers an explicit git -C over the payload cwd', () => {
    const result = runHook(`git -C "${otherRepo}" push -u origin chore/codegraph-onboarding`, {
      cwd: sessionRepo,
      hookCwd: sessionRepo,
    });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('declines to validate (allows) rather than guess when no payload cwd is available either', () => {
    const result = runHook('git push -u origin chore/codegraph-onboarding', {
      cwd: sessionRepo, // ambient cwd is the wrong repo and must never be consulted
    });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('validates gh pr create the same way as git push', () => {
    const result = runHook('gh pr create --title "x" --body "y"', {
      cwd: sessionRepo,
      hookCwd: otherRepo,
    });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });
});
