/**
 * Regression test for issue #2491: `lint-skill.sh`'s cross-fence variable
 * check (Pattern 1) exempted ANY line containing the substring `read ` from
 * being flagged, on the theory that `read` re-derives a variable's value
 * fresh (e.g. from a file), so a same-named reference on that line can't be
 * a stale cross-fence leak.
 *
 * That blanket substring match didn't check that the variable in question
 * was actually the destination `read` bound on that line. A here-string
 * (`read -r BAR <<< "$FOO"`) puts the leaked variable on the INPUT side of
 * `read`, not its destination — `$FOO` here is a genuine stale reference to
 * an earlier block's variable, not a fresh binding, yet the line still
 * contains the literal substring `read `.
 *
 * A second, independent exemption (a blanket `< ` substring check meant to
 * detect genuine file redirection) made this worse: `<<<`'s own text
 * contains a trailing `< ` (its third `<` immediately followed by a space),
 * so even after narrowing the `read` exemption to genuine destinations, the
 * here-string line still slipped through via this second, unrelated
 * exemption clause.
 *
 * Fixed by `is_read_dest_of_line` (checks whether `$var` is actually a
 * destination `extract_read_dest_vars` finds for that line) and
 * `has_file_redirect_in` (a regex distinguishing a genuine single-`<` file
 * redirect from `<<`/`<<<`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LINT_SCRIPT = path.join(
  REPO_ROOT,
  '.claude',
  'skills',
  'create-skill',
  'scripts',
  'lint-skill.sh',
);

// lint-skill.sh requires bash 4+ (associative arrays). macOS ships bash 3.2
// as the `bash` on PATH, including on GitHub Actions' macos-latest runner —
// resolve a real bash 4+ explicitly rather than assuming plain "bash" works.
function resolveBash4(): string | null {
  const candidates = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', 'bash'];
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' });
      const match = version.match(/version (\d+)\./);
      if (match && Number(match[1]) >= 4) return candidate;
    } catch {
      // candidate not on PATH — try the next one
    }
  }
  return null;
}

const BASH4 = resolveBash4();

const FRONTMATTER = `---
name: lint-test-skill
description: test
argument-hint: none
allowed-tools: Bash
---

## Phase 0

pre-flight
`;

function runLint(bashBlocks: string[]): { stdout: string; ranSuccessfully: boolean } {
  const blocksMarkdown = bashBlocks.map((b) => `\`\`\`bash\n${b}\n\`\`\`\n`).join('\n');
  const content = `${FRONTMATTER}\n${blocksMarkdown}\n## Rules\n\nrules here\n\n## Examples\n\nexample here\n\n**Exit condition:** done\n`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-skill-herestring-'));
  const skillPath = path.join(dir, 'SKILL.md');
  fs.writeFileSync(skillPath, content);
  try {
    const result = execFileSync(BASH4!, [LINT_SCRIPT, skillPath], { encoding: 'utf8' });
    return { stdout: result, ranSuccessfully: true };
  } catch (err) {
    const e = err as { stdout?: string };
    const stdout = e.stdout ?? '';
    return { stdout, ranSuccessfully: /lint-skill: \d+ error/.test(stdout) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(BASH4 === null)(
  'lint-skill.sh catches a leak fed into a `read` here-string, not just a plain reference (#2491)',
  () => {
    it('flags the exact issue repro: a here-string feeding a stale variable into `read`', () => {
      const { stdout, ranSuccessfully } = runLint(['FOO=hello', 'read -r BAR <<< "$FOO"']);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $FOO assigned in bash block 1, referenced in block 2',
      );
    });

    it('still exempts a genuine read-destination rebinding on the same line (#2344 coverage)', () => {
      const { stdout, ranSuccessfully } = runLint([
        'COUNT=5',
        'read -r COUNT < .codegraph/count\necho "fresh: $COUNT"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).not.toContain('Cross-fence variable: $COUNT');
    });

    it('still exempts a genuine file redirection (single `<`) as file persistence', () => {
      const { stdout, ranSuccessfully } = runLint([
        'FOO=hello\nprintf \'%s\' "$FOO" > .codegraph/foo',
        'read -r FOO < .codegraph/foo\necho "reloaded: $FOO"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).not.toContain('Cross-fence variable: $FOO');
    });

    it('still flags a plain reference fed via a here-string with no `read` at all', () => {
      const { stdout, ranSuccessfully } = runLint(['FOO=hello', 'wc -l <<< "$FOO"']);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $FOO assigned in bash block 1, referenced in block 2',
      );
    });

    it('still flags a leak past an unrelated `read` whose destination is a different var', () => {
      const { stdout, ranSuccessfully } = runLint([
        'FOO=hello',
        'read -r OTHER < .codegraph/other\necho "leak: $FOO"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $FOO assigned in bash block 1, referenced in block 2',
      );
    });

    // Greptile round 1 on PR #2574: is_read_dest_of_line alone only checked
    // whether $var was *a* destination somewhere on the line, so a same-line
    // self-reference (destination and stale here-string input sharing the
    // same name) still slipped through undetected.
    it('flags a same-line self-referential read (destination and input share a name)', () => {
      const { stdout, ranSuccessfully } = runLint(['FOO=hello', 'read -r FOO <<< "$FOO"']);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $FOO assigned in bash block 1, referenced in block 2',
      );
    });

    it('does not flag a later line in the same block referencing the freshly self-bound value', () => {
      const { stdout, ranSuccessfully } = runLint([
        'FOO=hello',
        'read -r FOO <<< "$FOO"\necho "now local: $FOO"',
      ]);
      expect(ranSuccessfully).toBe(true);
      const crossFenceErrors = stdout
        .split('\n')
        .filter((l) => l.includes('Cross-fence variable: $FOO'));
      expect(crossFenceErrors).toHaveLength(1);
    });

    // Greptile round 2 on PR #2574: destination extraction truncated at the
    // FIRST `<`, so a destination placed AFTER the redirection (valid bash —
    // `read -r <<< "hello" FOO` really does bind FOO) was silently dropped,
    // and a later, legitimate reference to the freshly-bound value was
    // falsely reported as a stale cross-fence leak.
    it('does not false-flag a later reference when the destination follows the redirection', () => {
      const { stdout, ranSuccessfully } = runLint([
        'FOO=stale',
        'read -r <<< "hello" FOO\necho "now fresh: $FOO"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).not.toContain('Cross-fence variable: $FOO');
    });

    it('still flags a same-line self-reference when input precedes the destination', () => {
      const { stdout, ranSuccessfully } = runLint(['FOO=hello', 'read -r <<< "$FOO" FOO']);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $FOO assigned in bash block 1, referenced in block 2',
      );
    });

    // Greptile round 3 on PR #2574: three further gaps in the generalized
    // redirect handling, each verified to be a genuine bash construct
    // before fixing (`bash -c` reproductions, not just reasoning about it).
    it('does not register a trailing comment word as a destination', () => {
      const { stdout, ranSuccessfully } = runLint([
        'MAX_LIMIT=5',
        'read -r NUM < .codegraph/nums # MAX_LIMIT\necho "leak: $MAX_LIMIT"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $MAX_LIMIT assigned in bash block 1, referenced in block 2',
      );
    });

    it('does not register a trailing word from inside a multiword single-quoted target', () => {
      const { stdout, ranSuccessfully } = runLint([
        'BAZ=hello',
        'read -r BAR <<< \'FOO BAZ\'\necho "leak: $BAZ"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $BAZ assigned in bash block 1, referenced in block 2',
      );
    });

    it('checks every redirect on a line with more than one, not just the first', () => {
      const { stdout, ranSuccessfully } = runLint([
        'FOO=hello',
        'CONFIG=cfg.txt',
        'read -r FOO < "$CONFIG" <<< "$FOO"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $FOO assigned in bash block 1, referenced in block 3',
      );
    });

    it('still exempts a genuine single-redirect file read alongside an unrelated var', () => {
      const { stdout, ranSuccessfully } = runLint([
        'FOO=hello\nprintf \'%s\' "$FOO" > .codegraph/foo',
        'read -r FOO < .codegraph/foo\necho "reloaded: $FOO"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).not.toContain('Cross-fence variable: $FOO');
    });
  },
);
