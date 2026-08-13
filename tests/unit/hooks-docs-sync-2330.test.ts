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
 * post-git-ops.sh and update-graph.sh each have a small number of
 * genuinely necessary, intentional differences, all stemming from the same
 * root cause: this repo's own copy prefers its local `dist/cli.js` build
 * over `npx`, since this repo IS codegraph's own source and a stale
 * npm-published fallback would silently downgrade dogfooding, whereas the
 * docs template's copy has no local build to prefer and correctly falls
 * back to `npx` for an external consumer. update-graph.sh additionally
 * keeps its own static extension allowlist (docs has no
 * dist/hook-extensions.txt build artifact to read) and a failure message
 * that doesn't reference this repo's own `npm run doctor` script. Both
 * sides carry a comment explaining each split. These files are compared
 * with the known-different regions excluded rather than skipped outright,
 * so any OTHER drift still fails the test.
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
    const live = fs.readFileSync(path.join(LIVE_DIR, 'update-graph.sh'), 'utf8').split('\n');
    const docs = fs.readFileSync(path.join(DOCS_DIR, 'update-graph.sh'), 'utf8').split('\n');

    // Removes everything strictly between two anchor lines that are
    // required (via the expects below) to be identical text on both sides
    // — keeping both anchors themselves, so the two calls compose without
    // needing to track shifted offsets between them.
    const stripBetween = (lines: string[], startAnchor: string, endAnchor: string): string[] => {
      const startIdx = lines.findIndex((l) => l.trim() === startAnchor);
      const endIdx = lines.findIndex((l) => l.trim() === endAnchor);
      expect(startIdx).toBeGreaterThan(-1);
      expect(endIdx).toBeGreaterThan(startIdx);
      return [...lines.slice(0, startIdx + 1), ...lines.slice(endIdx)];
    };

    // Section 1: the extension-allowlist source (generated snapshot + grep
    // vs. a static case statement) — genuinely can't be identical, since the
    // generated snapshot is this repo's own build artifact the docs template
    // has no equivalent of.
    const EXT_SECTION_START = '# Skip docs, configs, test fixtures, and non-code files.';
    const EXT_SECTION_END = "# Skip test fixtures — they're copied to tmp dirs anyway";

    const afterExt = {
      live: stripBetween(live, EXT_SECTION_START, EXT_SECTION_END),
      docs: stripBetween(docs, EXT_SECTION_START, EXT_SECTION_END),
    };

    // Section 2: the build invocation — this repo prefers its local
    // dist/cli.js; the docs template falls back to npx (see file header).
    // Also swallows the failure-diagnostic message right after: live's
    // points at `npm run doctor`, this repo's own script — meaningless (and
    // absent) in a copied project, so docs keeps the plain message instead.
    const BUILD_SECTION_START =
      '# Run the build. Stderr is captured (not discarded) so a failure has a';
    const BUILD_SECTION_END = '# Update marker only if we did a full rebuild AND it succeeded';

    const afterBuild = {
      live: stripBetween(afterExt.live, BUILD_SECTION_START, BUILD_SECTION_END),
      docs: stripBetween(afterExt.docs, BUILD_SECTION_START, BUILD_SECTION_END),
    };

    // Everything else — the shebang/header, JSON parsing, the file-path
    // guard, PROJECT_DIR derivation, the fixture skip, the staleness-marker
    // logic, and the final exit — must be byte-identical.
    expect(afterBuild.docs).toEqual(afterBuild.live);
  });
});
