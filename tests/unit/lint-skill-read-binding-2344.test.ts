/**
 * Regression test for issue #2344: `lint-skill.sh`'s cross-fence variable
 * check (Pattern 1) only recognised `VAR=value` as a variable assignment.
 * `read`/`read -r VAR1 VAR2 ...` binds variables just as validly, but with
 * no `=` after the name — e.g. `while IFS=$'\t' read -r F COUNT LINE; do`.
 *
 * `fixer/SKILL.md`'s own I4 integrity check does exactly this: a loop-local
 * `$COUNT` (the per-line expected occurrence count, bound via `read`) that
 * collides in name only with the unrelated batch-size `$COUNT` set up in
 * Phase 0. Since each ```bash fence is a separate bash invocation, there is
 * no real collision at runtime — but the linter didn't know the later block
 * had its own fresh `$COUNT` via `read`, so it flagged the block's own local
 * variable as if it were a stale reference leaking from Phase 0.
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

// Unlike the mktemp test's single-block helper, this bug is inherently
// cross-block: it only reproduces across two or more separate \`\`\`bash
// fences (each its own bash invocation), so the fixture builder takes a
// list of blocks rather than one.
function runLint(bashBlocks: string[]): { stdout: string; ranSuccessfully: boolean } {
  const blocksMarkdown = bashBlocks.map((b) => `\`\`\`bash\n${b}\n\`\`\`\n`).join('\n');
  const content = `${FRONTMATTER}\n${blocksMarkdown}\n## Rules\n\nrules here\n\n## Examples\n\nexample here\n\n**Exit condition:** done\n`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-skill-read-'));
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
  'lint-skill.sh recognises `read` as a variable binding, not just VAR= (#2344)',
  () => {
    it('does not flag a var re-bound via `read` and referenced in the same later block', () => {
      const { stdout, ranSuccessfully } = runLint([
        'COUNT=5\nprintf \'%s\\n\' "$COUNT" > .codegraph/count',
        [
          "while IFS=$'\\t' read -r F COUNT LINE; do",
          '  if [ "$LINE" != "" ] && [ 0 -lt "$COUNT" ]; then',
          '    echo "seen $COUNT for $F"',
          '  fi',
          'done < .codegraph/data.tsv',
        ].join('\n'),
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).not.toContain('Cross-fence variable: $COUNT');
    });

    it('still flags a genuine cross-fence leak (no read-rebinding in the referencing block)', () => {
      const { stdout, ranSuccessfully } = runLint(['FOO=hello', 'echo "leak: $FOO"']);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $FOO assigned in bash block 1, referenced in block 2',
      );
    });

    it('still flags a reference in a block whose own `read` binds a different variable', () => {
      const { stdout, ranSuccessfully } = runLint([
        'FOO=hello',
        'read -r OTHER < .codegraph/other\necho "leak: $FOO"',
      ]);
      expect(ranSuccessfully).toBe(true);
      expect(stdout).toContain(
        'Cross-fence variable: $FOO assigned in bash block 1, referenced in block 2',
      );
    });
  },
);

describe.skipIf(BASH4 === null)('.claude/skills/fixer/SKILL.md itself (#2344 repro)', () => {
  it('passes lint-skill.sh with no Cross-fence $COUNT error', () => {
    const realSkillPath = path.join(REPO_ROOT, '.claude', 'skills', 'fixer', 'SKILL.md');
    const stdout = execFileSync(BASH4!, [LINT_SCRIPT, realSkillPath], { encoding: 'utf8' });
    expect(stdout).not.toContain('Cross-fence variable: $COUNT');
  });
});
