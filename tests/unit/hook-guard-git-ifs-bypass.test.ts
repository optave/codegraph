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

  it('still blocks git add -A via IFS substring expansion (Greptile review)', () => {
    // ${IFS:0:1} extracts a single whitespace character from IFS's default
    // value via bash's substring-expansion syntax, not the whole-variable
    // form — but the RESULT still undergoes the same unquoted field
    // splitting, so it creates the identical token boundary.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS:0:1}add${IFS:0:1}-A')).toBe(true);
  });

  it('still blocks the fast-path bypass via IFS substring expansion (Greptile review)', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS:1:1}checkout${IFS:1:1}--${IFS:1:1}some-file.txt')).toBe(true);
  });

  it('does not mistake a differently-named variable for an IFS substring expansion', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo ${IFSOMETHING:0:1}')).toBe(false);
  });

  it('does not invent a token boundary from an alternate-value IFS expansion (Greptile review)', () => {
    // ${IFS:+x} substitutes the literal "x" when IFS IS set and non-null —
    // the normally-true case — so this expands to the single harmless
    // token "gitxreset" in real bash, never "git reset". An earlier,
    // over-broad version of the normalizer treated ANY `${IFS<operator>}`
    // form as whitespace and wrongly rewrote this into "echo git reset",
    // fabricating a git invocation out of a plain echo argument.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo git${IFS:+x}reset')).toBe(false);
  });

  it('does not invent a token boundary from an IFS pattern-substitution expansion', () => {
    // ${IFS/ /X} replaces spaces in IFS's value with the literal "X" —
    // arbitrary attacker-chosen replacement text, not a value drawn from
    // IFS's own characters.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo git${IFS/ /X}reset')).toBe(false);
  });

  it('does not invent a token boundary from an empty IFS substring (Greptile review)', () => {
    // ${IFS:0:0} extracts zero characters — an empty string, which an
    // unquoted expansion contributes NOTHING from (not even a separator).
    // "echo git${IFS:0:0}reset" really expands to the single harmless
    // token "gitreset" in real bash, never "git reset".
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo git${IFS:0:0}reset')).toBe(false);
  });

  it('does not invent a token boundary from an out-of-range IFS substring offset (Greptile review)', () => {
    // ${IFS:3} starts extraction AT the end of IFS's 3-character default
    // value (indices 0, 1, 2) — bash's substring expansion returns EMPTY
    // once offset is at or past the string's length, the same "empty, not
    // whitespace" problem as an explicit zero length.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo git${IFS:3}reset')).toBe(false);
  });

  it('does not invent a token boundary from an out-of-range offset even with an explicit length', () => {
    // ${IFS:5:1} is ALSO empty: bash returns nothing once offset alone is
    // out of range, regardless of the requested length.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo git${IFS:5:1}reset')).toBe(false);
  });

  it('still blocks git reset via a leading-zero-padded IFS substring offset (Greptile review)', () => {
    // ${IFS:00} evaluates identically to ${IFS:0} in bash's arithmetic
    // context — an exact single-digit-only pattern misses this zero-padded
    // spelling entirely.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS:00}reset')).toBe(true);
  });

  it('still blocks git reset via a leading-zero-padded IFS substring length (Greptile review)', () => {
    // ${IFS:0:01} evaluates identically to ${IFS:0:1}.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS:0:01}reset')).toBe(true);
  });

  it('does not invent a token boundary from a leading-zero-padded but still zero length', () => {
    // ${IFS:0:00} is still an empty substring (length zero, however spelled).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo git${IFS:0:00}reset')).toBe(false);
  });

  it('still blocks git reset via a leading-zero-padded IFS substring in a later part of the command', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS:002}reset')).toBe(true);
  });

  it('still blocks git reset via a negative-zero IFS substring offset (Greptile review)', () => {
    // Integers have no signed zero, so bash evaluates "-0" to the same
    // value as "0" — offset -0 is offset 0 FROM THE START (valid,
    // non-empty), not "0 characters before the end" the way -1/-2/-3 are.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS: -0}reset')).toBe(true);
  });

  it('still blocks git reset via a zero-padded negative-zero IFS substring offset', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS: -00}reset')).toBe(true);
  });

  it('still blocks git reset via a whitespace-only IFS alternate-value expansion (Greptile review)', () => {
    // ${IFS:+ } substitutes the literal single space "word" itself
    // whenever IFS is set and non-null (the normally-true case) — the
    // substituted text IS whitespace this time, so it produces exactly
    // the same token boundary as the whole-variable form.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS:+ }reset')).toBe(true);
  });

  it('still blocks git reset via the bare (colon-less) whitespace-only IFS alternate-value form', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${IFS+ }reset')).toBe(true);
  });

  it('still blocks git reset via a whitespace-only alternate-value expansion on a non-IFS, normally-set variable (#2558)', () => {
    // ${HOME:+ } works identically to ${IFS:+ } — the operator substitutes
    // the literal "word" whenever the named variable is set and non-null,
    // regardless of what that variable's own value actually is. HOME is
    // normally set in any real shell, so this produces the same token
    // boundary as the IFS-specific form; a per-variable-name check could
    // never fully close this class, since the variable name isn't fixed.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${HOME:+ }reset')).toBe(true);
  });

  it('still blocks git reset via the bare (colon-less) whitespace-only alternate-value form on a non-IFS variable', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('git${PWD+ }reset')).toBe(true);
  });

  it('does not invent a token boundary from a non-whitespace alternate-value expansion on a non-IFS variable', () => {
    // ${SOME_VAR:+x} substitutes the literal "x", not whitespace — the
    // all-whitespace-content restriction applies regardless of which
    // variable is named.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo git${SOME_VAR:+x}reset')).toBe(false);
  });

  it('does not invent a token boundary from an empty IFS alternate-value expansion', () => {
    // ${IFS:+} (nothing between + and }) substitutes an EMPTY string when
    // IFS is set and non-null — an unquoted empty expansion contributes
    // nothing, not even a separator, so this must not be treated the same
    // as the non-empty, all-whitespace form above.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('echo git${IFS:+}reset')).toBe(false);
  });

  it('does not treat an IFS reference appearing inside a quoted, inert string as a token boundary', () => {
    // Quoted text is data, not a command invocation — mask-quoted-text.mjs
    // already blanks it out downstream of the IFS-normalization pass, so
    // this must not falsely block on text that merely mentions IFS.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash syntax under test, not a missed template literal
    expect(isDenied('gh issue create --body "explains ${IFS} bash quirk"')).toBe(false);
  });
});
