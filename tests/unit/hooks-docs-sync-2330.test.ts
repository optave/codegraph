/**
 * Regression guard for issue #2330: docs/examples/claude-code-hooks/
 * pre-commit.sh, post-git-ops.sh, enrich-context.sh, and update-graph.sh had
 * drifted from their live .claude/hooks/ counterparts — some cosmetically
 * (comment rewording), some substantively (enrich-context.sh's docs copy
 * still called the now-removed `codegraph deps` instead of `codegraph
 * brief`; update-graph.sh's docs copy was missing three tracked bug fixes:
 * #2134's project-dir-from-edited-file derivation, and #2074/#2302's
 * build-failure diagnostics).
 *
 * Mirrors the byte-identity enforcement `hook-guard-git-clean.test.ts` added
 * for guard-git.sh under #2105 — a prose note alone already failed to
 * prevent drift once before, so this asserts identity directly instead of
 * documenting-and-hoping.
 *
 * pre-commit.sh and enrich-context.sh are enforced as fully byte-identical.
 * post-git-ops.sh and update-graph.sh each have exactly one genuinely
 * necessary, intentional line-level difference — this repo's own copy
 * prefers its local `dist/cli.js` build over `npx`, since this repo IS
 * codegraph's own source and a stale npm-published fallback would silently
 * downgrade dogfooding; the docs template's copy has no local build to
 * prefer and falls back to `npx` instead, which is the only sensible choice
 * for an external consumer. Both sides carry a comment explaining this.
 * Those two files are compared with the known-different lines excluded
 * rather than skipped outright, so any OTHER drift still fails the test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIVE_DIR = path.join(REPO_ROOT, '.claude', 'hooks');
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'examples', 'claude-code-hooks');

const FULLY_IDENTICAL_HOOKS = ['pre-commit.sh', 'enrich-context.sh'];

describe('claude-code-hooks docs examples stay in sync (#2330)', () => {
  it.each(FULLY_IDENTICAL_HOOKS)('%s is byte-identical to its docs/examples copy', (name) => {
    const live = fs.readFileSync(path.join(LIVE_DIR, name), 'utf8');
    const docs = fs.readFileSync(path.join(DOCS_DIR, name), 'utf8');
    expect(docs).toBe(live);
  });

  it('post-git-ops.sh differs from its docs copy only on the one documented, intentional line', () => {
    const live = fs.readFileSync(path.join(LIVE_DIR, 'post-git-ops.sh'), 'utf8').split('\n');
    const docs = fs.readFileSync(path.join(DOCS_DIR, 'post-git-ops.sh'), 'utf8').split('\n');

    const liveBuildLine = live.findIndex((l) => l.includes('node "${CLAUDE_PROJECT_DIR'));
    const docsBuildLine = docs.findIndex((l) => l.includes('npx --yes @optave/codegraph build'));
    expect(liveBuildLine).toBeGreaterThan(-1);
    expect(docsBuildLine).toBeGreaterThan(-1);

    // Strip each side's own explanatory comment block (differs by design —
    // each explains why ITS OWN choice differs from the other file) plus the
    // one intentionally-different invocation line, then require everything
    // else to match exactly.
    const stripComment = (lines: string[], buildLineIdx: number) => {
      let start = buildLineIdx;
      while (start > 0 && lines[start - 1].trim().startsWith('#')) start--;
      return [...lines.slice(0, start), ...lines.slice(buildLineIdx + 1)];
    };
    expect(stripComment(docs, docsBuildLine)).toEqual(stripComment(live, liveBuildLine));
  });

  it('update-graph.sh differs from its docs copy only on the two documented, intentional sections', () => {
    const live = fs.readFileSync(path.join(LIVE_DIR, 'update-graph.sh'), 'utf8');
    const docs = fs.readFileSync(path.join(DOCS_DIR, 'update-graph.sh'), 'utf8');

    // Section 1: the extension-allowlist source (generated snapshot + grep
    // vs. a static case statement) — genuinely can't be identical, since the
    // generated snapshot is this repo's own build artifact.
    expect(live).toContain('GENERATED_EXT_LIST="$PROJECT_DIR/dist/hook-extensions.txt"');
    expect(docs).not.toContain('GENERATED_EXT_LIST');

    // Section 2: the build invocation — this repo prefers its local
    // dist/cli.js; the docs template falls back to npx (see file header).
    expect(live).toContain('CLI_ENTRY="$PROJECT_DIR/dist/cli.js"');
    expect(docs).toContain('npx --yes @optave/codegraph build');
    expect(docs).not.toContain('CLI_ENTRY');

    // Everything else — the shebang/header, JSON parsing, the fixture skip,
    // the staleness-marker logic, and the final exit — must still match.
    const SHARED_PREFIX = [
      '#!/usr/bin/env bash',
      '# update-graph.sh — PostToolUse hook for Edit and Write tools',
    ];
    for (const line of SHARED_PREFIX) {
      expect(live).toContain(line);
      expect(docs).toContain(line);
    }
    expect(live).toContain('# --- Staleness check ---');
    expect(docs).toContain('# --- Staleness check ---');
    expect(live.trimEnd().endsWith('exit 0')).toBe(true);
    expect(docs.trimEnd().endsWith('exit 0')).toBe(true);
  });
});
