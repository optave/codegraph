/**
 * Regression test for issue #1842 (recommended-practices.md) and #1984
 * (README.md and several docs/ guides): these referenced `codegraph check`
 * predicate flags (`--no-new-cycles`, `--max-blast-radius`,
 * `--no-boundary-violations`, and the fully fabricated `--max-complexity`,
 * which never existed as a check predicate at all) that were renamed to
 * `--cycles`, `--blast-radius`, `--boundaries` (plus `--signatures`, which
 * was never documented at all) and never updated.
 *
 * Rather than pin each doc to today's flag names, this derives the valid
 * flag set from `command.options` in src/cli/commands/check.ts — the single
 * source of truth — so a future rename that isn't reflected in a doc fails
 * here instead of silently drifting again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { command as checkCommand } from '../../src/cli/commands/check.js';

const REPO_ROOT = path.join(__dirname, '../..');

/** Every doc that references `codegraph check` predicate flags, checked for known-stale names. */
const ALL_DOC_PATHS = [
  'docs/guides/recommended-practices.md',
  'README.md',
  'docs/contributing/harness-engineering.md',
  'docs/use-cases/harness-engineering.md',
  'docs/use-cases/titan-paradigm.md',
  'docs/guides/ai-agent-guide.md',
  'docs/examples/CLI.md',
  'docs/examples/MCP.md',
].map((p) => path.join(REPO_ROOT, p));

/**
 * Docs whose only `codegraph check`-flag content is real, current examples —
 * safe for the stricter "every flag used must currently exist" check.
 *
 * Excluded: `docs/use-cases/harness-engineering.md`, `docs/use-cases/titan-paradigm.md`,
 * and `docs/guides/ai-agent-guide.md` legitimately illustrate *proposed*,
 * not-yet-built predicates (e.g. `--floating-promises`, `--no-duplicates`) in
 * feature-wishlist tables, and reference other commands' own "Key flags"
 * rows — a strict scan of those would false-positive on intentional,
 * clearly-labeled hypothetical/unrelated syntax. `docs/examples/MCP.md`'s
 * check examples are MCP tool JSON (snake_case `arguments` fields), not
 * `--flag`-shaped CLI tokens, so the CLI flag extractor doesn't apply.
 */
const STRICT_DOC_PATHS = [
  'docs/guides/recommended-practices.md',
  'README.md',
  'docs/contributing/harness-engineering.md',
  'docs/examples/CLI.md',
].map((p) => path.join(REPO_ROOT, p));

const STALE_FLAGS = [
  '--no-new-cycles',
  '--max-blast-radius',
  '--no-boundary-violations',
  '--max-complexity',
];

/** Extract long-form flag names (e.g. "--blast-radius") from a commander option tuple's flags string. */
function longFlagNames(flags: string): string[] {
  return flags
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('--'))
    .map((part) => part.split(/\s/)[0]);
}

function validCheckFlags(): Set<string> {
  const valid = new Set<string>();
  for (const option of checkCommand.options) {
    const flags = option[0];
    for (const name of longFlagNames(flags)) {
      valid.add(name);
    }
  }
  return valid;
}

/**
 * Pull every `--flag`-shaped token out of `codegraph check ...` example
 * lines, plus any "Available predicates:" prose line — that list is plain
 * English, not a command example, so it wouldn't otherwise be scanned and
 * could drift silently after a future rename.
 */
function flagsUsedInCheckExamples(doc: string): string[] {
  const flags: string[] = [];
  for (const line of doc.split('\n')) {
    if (!/codegraph check\b|Available predicates:/.test(line)) continue;
    for (const match of line.matchAll(/--[a-zA-Z][a-zA-Z-]*/g)) {
      flags.push(match[0]);
    }
  }
  return flags;
}

describe('codegraph check flag references in docs (#1842, #1984)', () => {
  const valid = validCheckFlags();

  for (const docPath of ALL_DOC_PATHS) {
    const relPath = path.relative(REPO_ROOT, docPath);
    const doc = readFileSync(docPath, 'utf-8');

    it(`${relPath} does not reference known-stale codegraph check flag names`, () => {
      for (const flag of STALE_FLAGS) {
        expect(doc).not.toContain(flag);
      }
    });
  }

  for (const docPath of STRICT_DOC_PATHS) {
    const relPath = path.relative(REPO_ROOT, docPath);
    const doc = readFileSync(docPath, 'utf-8');

    it(`${relPath} only references check flags that exist on the check command`, () => {
      const used = flagsUsedInCheckExamples(doc);
      expect(used.length).toBeGreaterThan(0);
      for (const flag of used) {
        expect(valid.has(flag)).toBe(true);
      }
    });
  }
});
