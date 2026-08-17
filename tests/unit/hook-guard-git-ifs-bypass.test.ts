/**
 * Regression guard for issue #2451: bash's own whitespace-field-separator
 * variable (IFS) supplies a token boundary that the command TEXT itself has
 * no literal whitespace for. Referencing it unquoted between two words
 * looks, as static text, like a single token — but bash expands the
 * unquoted reference to whitespace before Git ever runs, so Git actually
 * receives the two halves as separate arguments.
 *
 * This bypassed guard-git.sh at two levels:
 * 1. The hook's own top-level fast-path filter requires literal whitespace
 *    directly after `git`/`gh`. A command with an IFS reference in place of
 *    every literal space has no literal whitespace anywhere, so the filter
 *    didn't recognize it as a git command at all and exited 0 immediately —
 *    skipping EVERY check in the file, not just whichever one was targeted.
 * 2. Every individual subcommand check has the same literal-whitespace
 *    assumption between the verb and its own subcommand/flags — an IFS
 *    reference between `git` and `add` is recognized as *a* git command
 *    (the space after `git` is real), but slips past the add-A-specific
 *    check, which requires literal whitespace between `add` and `-A` too.
 *
 * The fix normalizes an IFS reference into a literal space
 * (normalize-ifs.mjs) upstream of both the fast-path filter and the
 * existing quote-masking pipeline, so no individual regex needs its own
 * IFS-awareness.
 */
import { execFileSync } from 'node:child_process';
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

describe('guard-git.sh IFS whitespace-expansion bypass (#2451)', () => {
  it('still blocks git checkout -- via the braced IFS form in place of every literal space', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS}checkout${IFS}--${IFS}some-file.txt')).toBe(true);
  });

  it('still blocks git add -A via the bare IFS form immediately before the flag', () => {
    // A bare $IFS only unambiguously references the IFS variable when the
    // next character is NOT part of a longer identifier — `$IFScheckout`
    // is bash's own distinct (and here undefined, empty-expanding) variable
    // "IFScheckout", not "$IFS" + literal "checkout". Right before a flag
    // (a non-identifier "-") is exactly where the bare form is realistic.
    expect(isDenied('git add$IFS-A')).toBe(true);
  });

  it('still blocks git add -A when the braced IFS form separates the verb from its flag', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git add${IFS}-A')).toBe(true);
  });

  it('still blocks git reset when the braced IFS form separates git from the subcommand', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS}reset')).toBe(true);
  });

  it('still blocks git stash when the braced IFS form separates git from the subcommand', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS}stash')).toBe(true);
  });

  it('does not mistake a longer variable name for the bare IFS form followed by literal text', () => {
    // $IFSOMETHING references a distinct (and here, undefined -> harmless)
    // variable, not "$IFS" + literal "OMETHING" — must not be normalized
    // into a space that would fabricate a token boundary bash never
    // produces for this form.
    expect(isDenied('echo hello$IFSOMETHINGworld')).toBe(false);
  });

  it('still allows a legitimate flag sharing the checkout -- prefix via the braced IFS form', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS}checkout${IFS}--detach')).toBe(false);
  });

  it('does not treat an IFS reference appearing inside a quoted, inert string as a token boundary', () => {
    // Quoted text is data, not a command invocation — mask-quoted-text.mjs
    // already blanks it out downstream of the IFS-normalization pass, so
    // this must not falsely block on text that merely mentions IFS.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('gh issue create --body "explains ${IFS} bash quirk"')).toBe(false);
  });
});
