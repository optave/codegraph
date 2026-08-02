/**
 * Regression test for issue #2009: `docs/examples/claude-code-skills/<skill>/SKILL.md`
 * files are meant to be exact, install-ready copies of their `.claude/skills/<skill>/SKILL.md`
 * sources (the README's own install instructions do `cp -r .../titan-*
 * .claude/skills/`), but nothing enforced that and several drifted out of
 * sync between when #1879 fixed one gap and when #2009 found five more.
 *
 * Discovers the expected skill set from `.claude/skills/` (the source of
 * truth), not from the mirror directory — discovering from the mirror side
 * would silently pass if a new titan-* skill were added to `.claude/skills/`
 * without ever getting a mirror at all, since there'd be nothing on the
 * mirror side to iterate (Greptile review on PR #2218).
 *
 * Compares file content directly rather than re-deriving any drift logic —
 * a byte-for-byte mismatch is exactly the bug this test exists to catch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const MIRROR_DIR = path.join(REPO_ROOT, 'docs/examples/claude-code-skills');
const SOURCE_DIR = path.join(REPO_ROOT, '.claude/skills');

/**
 * Every `titan-*` skill in `.claude/skills/` — the README's own install
 * instructions (`cp -r .../titan-* .claude/skills/`) establish this prefix
 * as exactly the set meant to be publicly mirrored; other skills (fixer,
 * sweep, dogfood, etc.) are internal-only and intentionally have no mirror.
 */
function titanSourceSkillNames(): string[] {
  return readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('titan-'))
    .map((entry) => entry.name);
}

describe('docs/examples/claude-code-skills mirrors match .claude/skills sources (#2009)', () => {
  const skills = titanSourceSkillNames();

  it('finds a non-trivial number of titan-* source skills (discovery sanity check)', () => {
    expect(skills.length).toBeGreaterThan(5);
  });

  for (const skill of skills) {
    it(`${skill}/SKILL.md has a mirror that is byte-identical to its .claude/skills source`, () => {
      const sourcePath = path.join(SOURCE_DIR, skill, 'SKILL.md');
      const mirrorPath = path.join(MIRROR_DIR, skill, 'SKILL.md');
      const source = readFileSync(sourcePath, 'utf-8');
      const mirror = readFileSync(mirrorPath, 'utf-8');
      expect(mirror).toBe(source);
    });
  }
});
