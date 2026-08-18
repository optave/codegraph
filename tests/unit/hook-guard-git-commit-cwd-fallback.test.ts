/**
 * Regression guard for issue #2526: `.claude/hooks/guard-git.sh`'s
 * commit edit-log check has the same unresolved-cwd gap #2386 fixed for
 * branch validation. A bare `git commit <files> -m "msg"` relying on the
 * Bash tool's persistent cwd from an EARLIER, separate tool call leaves
 * `WORK_DIR` empty, and the check fell back to the hook process's own
 * ambient cwd instead of the payload's reported `cwd` — resolving the
 * edit-log check against a completely unrelated repo.
 *
 * Unlike #2386's branch-validation bug, this doesn't produce a false
 * *deny*: the wrong repo's `git diff --cached --name-only` comes back
 * empty (nothing staged there), hitting the existing
 * `if [ -z "$STAGED_FILES" ]; then exit 0` early-out and silently
 * *allowing* — so the symptom is "the edit-log check gets silently
 * skipped" rather than "a valid commit gets wrongly blocked."
 *
 * The fix: apply the same `$HOOK_CWD` fallback #2386 introduced for
 * `validate_branch_name` to this section too.
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

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('guard-git.sh commit edit-log check resolves the actual commit target (#2526)', () => {
  let base: string;
  let sessionRepo: string;
  let otherRepo: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-git-commit-'));
    sessionRepo = path.join(base, 'session-repo');
    otherRepo = path.join(base, 'other-repo');
    // The hook process's own ambient cwd — has nothing staged, so if the
    // check wrongly resolves here it silently allows via the "no staged
    // files" early-out instead of ever inspecting the real target repo.
    initRepo(sessionRepo);
    // The subagent's actual commit target, reported via the payload's cwd.
    initRepo(otherRepo);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('uses the hook payload cwd for a bare git commit with no -C/cd, catching an unedited staged file', () => {
    fs.mkdirSync(path.join(otherRepo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(otherRepo, '.claude', 'session-edits.log'), 'edit tracked.txt\n');
    fs.writeFileSync(path.join(otherRepo, 'sneaky.txt'), 'not edited by this session\n');
    execFileSync('git', ['add', 'sneaky.txt'], { cwd: otherRepo });

    const result = runHook('git commit -m "msg"', {
      cwd: sessionRepo, // ambient cwd — the WRONG repo, nothing staged there
      hookCwd: otherRepo, // payload cwd — the RIGHT repo, has the unauthorized file
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('sneaky.txt');
  });

  it('still allows via the payload cwd when every staged file was actually edited', () => {
    fs.mkdirSync(path.join(otherRepo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(otherRepo, '.claude', 'session-edits.log'), 'edit tracked.txt\n');
    fs.writeFileSync(path.join(otherRepo, 'tracked.txt'), 'edited by this session\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: otherRepo });

    const result = runHook('git commit -m "msg"', {
      cwd: sessionRepo,
      hookCwd: otherRepo,
    });

    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('still prefers an explicit git -C over the payload cwd', () => {
    fs.mkdirSync(path.join(otherRepo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(otherRepo, '.claude', 'session-edits.log'), 'edit tracked.txt\n');
    fs.writeFileSync(path.join(otherRepo, 'sneaky.txt'), 'not edited\n');
    execFileSync('git', ['add', 'sneaky.txt'], { cwd: otherRepo });

    const result = runHook(`git -C "${otherRepo}" commit -m "msg"`, {
      cwd: sessionRepo,
      hookCwd: sessionRepo, // payload cwd also wrong — explicit -C must win regardless
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('sneaky.txt');
  });

  it('falls back to silently allowing (not denying) when no payload cwd is available either', () => {
    // Documents the pre-existing, milder fallback behavior this fix doesn't
    // change: with no -C/cd AND no payload cwd, the check has no repo to
    // resolve against at all and must not guess — it allows, same as
    // validate_branch_name's equivalent last-resort case.
    const result = runHook('git commit -m "msg"', {
      cwd: sessionRepo,
    });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });
});
