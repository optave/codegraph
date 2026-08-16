/**
 * Regression test for #2417: README.md's runtime-dependency claims are
 * hand-maintained numbers/table rows that silently drift out of sync with
 * `package.json` — this has happened twice already (backlog #96, and again
 * when `smol-toml` was added in c50a9919/#2376). Nothing catches it except a
 * human reading the README closely.
 *
 * Guards the two places `package.json`'s `dependencies` are echoed in
 * README.md: the "Lightweight Footprint" section's prose count + dependency
 * table, and the competitive-comparison table's own-column count. Both must
 * track `Object.keys(pkg.dependencies)` exactly — an added, removed, or
 * renamed dependency breaks this test until the README is updated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(__dirname, '../..');
const README_PATH = path.join(REPO_ROOT, 'README.md');

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const actualDeps: string[] = Object.keys(pkg.dependencies ?? {}).sort();

const readme = fs.readFileSync(README_PATH, 'utf-8');

describe('README.md runtime-dependency claims track package.json (#2417)', () => {
  it('finds the "Only N runtime dependencies" prose claim', () => {
    const match = readme.match(/Only \*\*(\d+) runtime dependencies\*\*/);
    expect(
      match,
      'expected README.md to contain the "Only **N** runtime dependencies" line',
    ).not.toBeNull();
  });

  it('the prose count matches package.json dependencies', () => {
    const match = readme.match(/Only \*\*(\d+) runtime dependencies\*\*/);
    const claimed = Number(match?.[1]);
    expect(claimed).toBe(actualDeps.length);
  });

  it('the Lightweight Footprint dependency table lists exactly package.json dependencies', () => {
    // The table's own rows: `| [name](url) | ... |`, found anywhere after the
    // "Only **N** runtime dependencies" line and before the next blank line
    // that follows the table (a blank line can separate the prose sentence
    // from the table itself, so this can't stop at the FIRST blank line).
    const afterClaim = readme.split(/Only \*\*\d+ runtime dependencies\*\*/)[1];
    expect(afterClaim, 'could not locate text after the prose claim').toBeTruthy();

    const tableStart = afterClaim!.indexOf('| Dependency ');
    expect(tableStart, 'could not locate the dependency table header').toBeGreaterThanOrEqual(0);

    const afterHeader = afterClaim!.slice(tableStart);
    const tableBlock = afterHeader.split(/\n\n/)[0];
    const rowNames = [...tableBlock.matchAll(/^\|\s*\[([^\]]+)\]\(/gm)].map((m) => m[1]).sort();

    expect(rowNames).toEqual(actualDeps);
  });

  it('the competitive-comparison table row matches package.json dependencies', () => {
    const match = readme.match(
      /\|\s*Runtime dependencies \(direct packages\)[^|]*\|\s*\*\*(\d+)\*\*\s*\|/,
    );
    expect(
      match,
      'expected a "Runtime dependencies (direct packages)" row with our own bolded count',
    ).not.toBeNull();
    expect(Number(match?.[1])).toBe(actualDeps.length);
  });
});
