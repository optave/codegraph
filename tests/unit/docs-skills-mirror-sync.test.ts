/**
 * Regression test for issue #2009: `docs/examples/claude-code-skills/<skill>/SKILL.md`
 * files are meant to be exact, install-ready copies of their `.claude/skills/<skill>/SKILL.md`
 * sources (the README's own install instructions do `cp -r .../titan-*
 * .claude/skills/`), but nothing enforced that and several drifted out of
 * sync between when #1879 fixed one gap and when #2009 found five more.
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

/** Every skill mirrored under docs/examples/claude-code-skills/ (subdirectories only, skips README.md). */
function mirroredSkillNames(): string[] {
  return readdirSync(MIRROR_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('docs/examples/claude-code-skills mirrors match .claude/skills sources (#2009)', () => {
  const skills = mirroredSkillNames();

  it('finds a non-trivial number of mirrored skills (discovery sanity check)', () => {
    expect(skills.length).toBeGreaterThan(5);
  });

  for (const skill of skills) {
    it(`${skill}/SKILL.md mirror is byte-identical to its .claude/skills source`, () => {
      const sourcePath = path.join(SOURCE_DIR, skill, 'SKILL.md');
      const mirrorPath = path.join(MIRROR_DIR, skill, 'SKILL.md');
      const source = readFileSync(sourcePath, 'utf-8');
      const mirror = readFileSync(mirrorPath, 'utf-8');
      expect(mirror).toBe(source);
    });
  }
});
