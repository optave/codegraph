/**
 * Regression guard for issue #2099: `.claude/hooks/guard-git.sh`'s `git
 * clean` check had two bugs.
 *
 * 1. It blocked every invocation unconditionally, including `-n`/`--dry-run`
 *    — a pure listing operation that never deletes anything, and exactly the
 *    discovery mechanism `/housekeep`'s Phase 2 recommends for finding
 *    gitignored dirt files.
 * 2. Every "does this command invoke a dangerous verb" check in the file
 *    (not just `git clean`) scanned the raw command TEXT with no awareness
 *    of shell quoting, so a command like
 *    `gh issue create --body "...git clean -fd..."` matched the same regex
 *    as a real invocation, even though the match was inside a quoted
 *    argument to an unrelated command.
 *
 * The fix: mask quoted-string contents before the verb-detection checks run
 * (`mask-quoted-text.mjs`), and only block `git clean` when it carries
 * `-f`/`--force` and lacks `-n`/`--dry-run` (which git itself treats as
 * always overriding `-f`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'guard-git.sh');

interface HookDecision {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

function runHook(command: string): HookDecision {
  const toolInput = JSON.stringify({ tool_input: { command } });
  const stdout = execFileSync('bash', [HOOK_PATH], { input: toolInput, encoding: 'utf8' });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function isDenied(command: string): boolean {
  return runHook(command).hookSpecificOutput?.permissionDecision === 'deny';
}

describe('guard-git.sh git clean dry-run/force distinction (#2099)', () => {
  it('blocks a force-deleting invocation', () => {
    expect(isDenied('git clean -fd')).toBe(true);
    expect(isDenied('git clean --force')).toBe(true);
  });

  it('allows -n/--dry-run through (pure listing, never deletes)', () => {
    expect(isDenied('git clean -n')).toBe(false);
    expect(isDenied('git clean --dry-run')).toBe(false);
  });

  it('allows -f combined with --dry-run (git always treats dry-run as overriding force)', () => {
    expect(isDenied('git clean -fdX --dry-run')).toBe(false);
  });

  it('allows a bare git clean with neither flag (git itself refuses to run it)', () => {
    expect(isDenied('git clean')).toBe(false);
  });

  it('still blocks a force-clean chained after another command', () => {
    expect(isDenied('git push -f && git clean -fd')).toBe(true);
  });

  it('recognizes a dry-run flag bundled with other short options', () => {
    // Greptile review on this PR: -ndf/-fnd bundle -n (dry-run) with -d/-f —
    // git's own arg parser treats every letter in a bundled short-opt group
    // independently, so this must NOT block despite -f being present.
    expect(isDenied('git clean -ndf')).toBe(false);
    expect(isDenied('git clean -fnd')).toBe(false);
  });

  it('recognizes a force flag bundled with other short options (no dry-run present)', () => {
    expect(isDenied('git clean -fd')).toBe(true);
    expect(isDenied('git clean -df')).toBe(true);
  });

  it('does not let a flag on a different, non-&&-separated command suppress the block', () => {
    // Greptile review: an earlier version split segments only on `&&`, so a
    // `;`/`|`/newline-separated command's own -n could be misread as
    // belonging to the git clean invocation.
    expect(isDenied('git clean -fd; ls -n')).toBe(true);
    expect(isDenied('git clean -fd | cat -n')).toBe(true);
    expect(isDenied('git clean -fd\nls -n')).toBe(true);
  });

  it('does not let a standalone & (background) separator leak a flag across commands', () => {
    // Greptile review (round 2): the segment splitter initially only
    // recognized && as a separator, not a lone &.
    expect(isDenied('git clean -fd & ls -n')).toBe(true);
  });

  it('does not treat a pathspec after -- as a dry-run flag', () => {
    // Greptile review (round 2): `-n` after `--` names a literal path, not
    // an option — git's own convention for disambiguating dash-prefixed
    // pathspecs from flags.
    expect(isDenied('git clean -f -- -n')).toBe(true);
  });

  it('still recognizes a real -n option before the -- pathspec boundary', () => {
    expect(isDenied('git clean -fn -- -weird-file')).toBe(false);
  });
});

describe('guard-git.sh does not false-positive on quoted text (#2099)', () => {
  it('does not block a gh command whose quoted body merely mentions git clean', () => {
    expect(isDenied('gh issue create --body "please dont run git clean -fd"')).toBe(false);
  });

  it('does not block when the quoted text contains escaped double quotes', () => {
    expect(isDenied('gh issue create --body "he said \\"git clean -fd\\" was risky"')).toBe(false);
  });

  it('still blocks a real git add -A after a cd into a path that merely contains "git clean" text', () => {
    expect(isDenied('cd "/tmp/git clean demo" && git add -A')).toBe(true);
  });

  it('still blocks real, unquoted dangerous invocations for every existing check', () => {
    expect(isDenied('git add -A')).toBe(true);
    expect(isDenied('git add .')).toBe(true);
    expect(isDenied('git reset --hard')).toBe(true);
    expect(isDenied('git checkout -- .')).toBe(true);
    expect(isDenied('git restore .')).toBe(true);
    expect(isDenied('git stash')).toBe(true);
  });

  it('still allows the safe forms of those same commands', () => {
    expect(isDenied('git add foo.txt')).toBe(false);
    expect(isDenied('git restore --staged foo.txt')).toBe(false);
  });

  it('still blocks a real invocation nested inside bash -c / sh -c / eval (Greptile review)', () => {
    // A quote immediately after -c/-e/eval is executable code, not inert
    // data — masking it would hide a real destructive invocation.
    expect(isDenied('bash -c "git clean -fd"')).toBe(true);
    expect(isDenied("sh -c 'git add -A'")).toBe(true);
    expect(isDenied('eval "git reset --hard"')).toBe(true);
  });

  it('still allows inert quoted text passed to -c-like flags when it names no dangerous verb', () => {
    expect(isDenied('bash -c "echo hello"')).toBe(false);
  });

  it('still blocks a dangerous command after an escaped quote inside an executable -c payload (Greptile review)', () => {
    // An escaped \" inside `bash -c "..."` is not the closing quote — ending
    // the exec-trigger exemption there would let the real remainder of the
    // payload (a genuine git clean -fd here) fall through to normal
    // masking and get hidden.
    expect(isDenied('bash -c "echo \\"x\\" && git clean -fd"')).toBe(true);
  });

  it('still blocks a command substitution inside an ordinary double-quoted argument (Greptile review)', () => {
    // $(...) and `...` execute even inside an otherwise-inert double-quoted
    // string — real bash actually runs `git clean -fd` here when expanding
    // the -m argument, regardless of it being "just a commit message".
    expect(isDenied('git commit -m "message $(git clean -fd)"')).toBe(true);
    expect(isDenied('git commit -m "message `git add -A`"')).toBe(true);
  });

  it('does not treat command substitution inside a SINGLE-quoted argument as executable', () => {
    // Single quotes suppress all expansion in real bash — $(...) there is
    // genuinely inert literal text.
    expect(isDenied("git commit -m 'message $(git clean -fd)'")).toBe(false);
  });

  it('still blocks command substitution inside an unquoted-delimiter heredoc body', () => {
    // <<EOF (unlike <<'EOF') still expands $(...) inside the body.
    const command = [`cat <<EOF`, `text $(git clean -fd) more text`, `EOF`].join('\n');
    expect(isDenied(command)).toBe(true);
  });

  it('does not block command substitution-shaped text inside a quoted-delimiter heredoc body', () => {
    const command = [`cat <<'EOF'`, `text $(git clean -fd) more text`, `EOF`].join('\n');
    expect(isDenied(command)).toBe(false);
  });

  it('does not block a commit whose heredoc-authored message body mentions git clean', () => {
    // CLAUDE.md mandates exactly this heredoc form for commit messages —
    // a real commit whose message discusses (or fixes) git clean, like this
    // very commit, must not be self-blocked.
    const command = [
      `git commit -m "$(cat <<'EOF'`,
      `fix(hooks): example commit message`,
      ``,
      `git clean was blocked unconditionally, including -n/--dry-run.`,
      `EOF`,
      `)" some-file.txt`,
    ].join('\n');
    expect(isDenied(command)).toBe(false);
  });
});

describe('guard-git.sh mask-quoted-text.mjs', () => {
  const MASK_SCRIPT = path.join(REPO_ROOT, '.claude', 'hooks', 'mask-quoted-text.mjs');

  function mask(input: string): string {
    return execFileSync('node', [MASK_SCRIPT], { input, encoding: 'utf8' });
  }

  it('masks quoted content while preserving unquoted text verbatim', () => {
    expect(mask('gh issue create --body "git clean -fd"')).toBe(
      `gh issue create --body "${'#'.repeat('git clean -fd'.length)}"`,
    );
  });

  it('leaves an unquoted real invocation completely untouched', () => {
    const cmd = 'git clean -fd';
    expect(mask(cmd)).toBe(cmd);
  });

  it('treats an escaped double quote inside a double-quoted string as non-terminating', () => {
    const input = 'gh issue create --body "he said \\"git clean\\" was risky"';
    const output = mask(input);
    expect(output).not.toContain('git clean');
    expect(output.startsWith('gh issue create --body "')).toBe(true);
    expect(output.endsWith('"')).toBe(true);
  });

  it('masks single-quoted content the same way as double-quoted', () => {
    expect(mask("echo 'git clean -fd'")).toBe(`echo '${'#'.repeat('git clean -fd'.length)}'`);
  });

  it('masks a heredoc body between its <<DELIM start and the terminator line', () => {
    const input = ["cat <<'EOF'", 'git clean -fd', 'EOF'].join('\n');
    const output = mask(input);
    const lines = output.split('\n');
    expect(lines[0]).toBe(`cat <<'${'#'.repeat(3)}'`);
    expect(lines[1]).toBe('#'.repeat('git clean -fd'.length));
    expect(lines[2]).toBe('EOF');
  });

  it('does not treat text past the terminator line as still inside the heredoc', () => {
    const input = ["cat <<'EOF'", 'masked body', 'EOF', 'git clean -fd'].join('\n');
    const output = mask(input);
    expect(output.split('\n').at(-1)).toBe('git clean -fd');
  });
});

describe('guard-git.sh checkout -- boundary requires a bare "--" token (#2280)', () => {
  it('still blocks the real file-reverting form', () => {
    expect(isDenied('git checkout -- file.txt')).toBe(true);
    expect(isDenied('git checkout -- file1.txt file2.txt')).toBe(true);
  });

  it('still blocks a bare trailing -- with no pathspec (ambiguous, same as before)', () => {
    expect(isDenied('git checkout --')).toBe(true);
  });

  it('allows --detach, which shares the "checkout --" prefix but does not revert working-tree changes', () => {
    expect(isDenied('git checkout --detach origin/main')).toBe(false);
    expect(isDenied('git checkout --detach')).toBe(false);
  });

  it('allows --track, --orphan, --no-track, and --guess for the same reason', () => {
    expect(isDenied('git checkout --track origin/feature')).toBe(false);
    expect(isDenied('git checkout --orphan new-branch')).toBe(false);
    expect(isDenied('git checkout --no-track feature')).toBe(false);
    expect(isDenied('git checkout --guess')).toBe(false);
  });

  it('still blocks --ours/--theirs (Greptile review, PR #2450, round 2): on an unmerged path these overwrite the working-tree file from a merge-conflict stage, the same destructive class this check exists to catch', () => {
    expect(isDenied('git checkout --ours file.txt')).toBe(true);
    expect(isDenied('git checkout --theirs file.txt')).toBe(true);
    expect(isDenied('git checkout --ours')).toBe(true);
    expect(isDenied('git checkout --theirs')).toBe(true);
  });

  it('does not over-match a hypothetical flag that merely starts with "ours"/"theirs"', () => {
    expect(isDenied('git checkout --oursight')).toBe(false);
  });

  it('still blocks a real revert chained after an allowed --detach invocation', () => {
    expect(isDenied('git checkout --detach && git checkout -- file.txt')).toBe(true);
  });

  it('still blocks an IFS-expansion bypass with no literal whitespace between -- and the path (Greptile review, PR #2450)', () => {
    // `${IFS}` (unquoted) is bash's own whitespace-field-separator variable
    // — the command TEXT has no literal space between "--" and "file.txt",
    // but bash expands `${IFS}` to whitespace before git ever sees it, so
    // git actually receives `checkout -- file.txt`. A check anchored on
    // literal `[[:space:]]` after "--" misses this; the negated-letter-class
    // form does not, since "$" is not a letter.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git checkout --${IFS}file.txt')).toBe(true);
    expect(isDenied('git checkout --$IFS')).toBe(true);
  });
});

describe('guard-git.sh docs example stays in sync (#2105)', () => {
  // docs/examples/claude-code-hooks/guard-git.sh is meant to be a working
  // copy of the live hook for users setting up their own repo — it had
  // drifted far enough out of sync (missing worktree detection, branch
  // validation, AI-attribution blocking, and more) that it no longer
  // reflected the real hook's behavior at all. Kept as an exact copy and
  // enforced here instead of documented-and-hoped-for, since a prose note
  // alone already failed to prevent the original drift.
  const HOOKS = ['guard-git.sh', 'mask-quoted-text.mjs', 'check-git-clean-force.mjs'];
  const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'examples', 'claude-code-hooks');

  it.each(HOOKS)('%s is byte-identical to its docs/examples copy', (name) => {
    const live = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'hooks', name), 'utf8');
    const docs = fs.readFileSync(path.join(DOCS_DIR, name), 'utf8');
    expect(docs).toBe(live);
  });
});
