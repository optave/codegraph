/**
 * Regression test for issue #2310: `.claude/scripts/gc-worktrees.sh`'s
 * `--prune-branches` step used `git branch -d` unconditionally for every
 * branch `classify()` had already deemed "settled" via authoritative
 * GitHub PR state. `-d`'s own internal check is an ancestry test — under a
 * squash/rebase-merge workflow (this repo's own, confirmed live — #2309) a
 * genuinely-merged branch's tip is never an ancestor of the squash commit
 * on the default branch, so `-d` silently refused to delete it, and the
 * branch survived every future `--prune-branches` run indefinitely.
 *
 * Fixing this by switching to `-D` unconditionally would introduce a worse
 * bug: `classify()` originally matched a branch to a "settled" PR by name
 * only. A branch name can be reused after its earlier PR merged or closed
 * (a later run, or a human, creating a new branch of the same name for
 * unrelated work) — matching by name alone would then hand that new,
 * never-merged branch's real commits to `-D`. The fix requires an EXACT
 * name-and-current-tip-SHA match against a PR GitHub reports MERGED before
 * a branch is `-D`-eligible (mirroring housekeep's Phase 4a fix for the
 * identical gap, Greptile review PR #2311); every other "settled" case
 * (closed-without-merging, a reused name, or the ancestry-test fallback)
 * still only gets `-d`, preserving its refusal-if-unmerged safety net.
 *
 * Extracts the real `classify()` function from the actual script (not a
 * reimplementation) and exercises it with controlled inputs, mirroring
 * fixer-skill-2g-queue-guard-2304.test.ts's extraction approach.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const SCRIPT_PATH = path.join(REPO_ROOT, '.claude/scripts/gc-worktrees.sh');

/** Extract the body of a `name() { ... }` bash function, brace-matched (not regex-fragile). */
function extractFunction(script: string, name: string): string {
  const marker = `${name}() {`;
  const start = script.indexOf(marker);
  if (start === -1) {
    throw new Error(`Function not found in gc-worktrees.sh: ${name}`);
  }
  let depth = 0;
  let i = start + marker.length - 1; // position of the opening '{'
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced braces extracting function: ${name}`);
  }
  return script.slice(start, i + 1);
}

const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const classifyFn = extractFunction(script, 'classify');

interface ClassifyInputs {
  gh_ok: 0 | 1;
  open_heads?: string;
  settled_heads?: string;
  merged_heads_sha?: string;
  /** Only consulted when gh_ok=0: whether the ancestor test should report true. */
  ancestor: boolean;
}

/** Run the real classify() against controlled inputs and return its exit code. */
function runClassify(branch: string, head: string, inputs: ClassifyInputs): number {
  // Stub `git` so the ancestor-test fallback (merge-base --is-ancestor) is
  // controllable without a real repo — classify() only ever calls `git -C
  // "$main_root" merge-base --is-ancestor ...` in that branch.
  const gitStub = `git() { if [ "$3" = "merge-base" ]; then return ${inputs.ancestor ? 0 : 1}; fi; }`;
  const script = `
    ${gitStub}
    gh_ok=${inputs.gh_ok}
    main_root="/tmp"
    default_branch="main"
    open_heads='${inputs.open_heads ?? ''}'
    settled_heads='${inputs.settled_heads ?? ''}'
    merged_heads_sha='${(inputs.merged_heads_sha ?? '').replace(/\\t/g, '\t')}'
    ${classifyFn}
    classify "${branch}" "${head}"
    echo "EXIT:$?"
  `;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  const match = out.match(/EXIT:(\d+)/);
  if (!match) throw new Error(`Could not parse classify() exit code from: ${out}`);
  return Number(match[1]);
}

describe('gc-worktrees.sh classify() (#2310)', () => {
  it('extracted a non-trivial classify() containing the merged_heads_sha check', () => {
    expect(classifyFn).toContain('merged_heads_sha');
    expect(classifyFn).toContain('return 0');
    expect(classifyFn).toContain('return 3');
  });

  it('returns 1 (keep, live work) for a branch with an open PR', () => {
    const verdict = runClassify('feat/x', 'abc123', {
      gh_ok: 1,
      open_heads: 'feat/x',
      ancestor: false,
    });
    expect(verdict).toBe(1);
  });

  it('returns 0 (-D safe) when the branch name AND current tip SHA match a MERGED PR', () => {
    const verdict = runClassify('feat/x', 'abc123', {
      gh_ok: 1,
      settled_heads: 'feat/x',
      merged_heads_sha: 'feat/x\\tabc123',
      ancestor: false,
    });
    expect(verdict).toBe(0);
  });

  it('returns 3 (only -d safe), NOT 0, when the branch name matches a MERGED PR but the current tip SHA differs (reused branch name)', () => {
    // This is the core safety fix: the branch name "feat/x" once merged as
    // commit abc123, but the LOCAL branch's current tip is def456 — a
    // different, never-merged commit sitting on a reused name. Verdict 0
    // here would hand real, un-landed work to -D.
    const verdict = runClassify('feat/x', 'def456', {
      gh_ok: 1,
      settled_heads: 'feat/x',
      merged_heads_sha: 'feat/x\\tabc123',
      ancestor: false,
    });
    expect(verdict).toBe(3);
  });

  it('returns 3 (only -d safe), NOT 0, for a CLOSED-without-merging PR (no landed commit to pin against)', () => {
    const verdict = runClassify('feat/x', 'abc123', {
      gh_ok: 1,
      settled_heads: 'feat/x',
      merged_heads_sha: '',
      ancestor: false,
    });
    expect(verdict).toBe(3);
  });

  it('returns 2 (orphan, report) when no PR exists for the branch at all', () => {
    const verdict = runClassify('feat/x', 'abc123', {
      gh_ok: 1,
      ancestor: false,
    });
    expect(verdict).toBe(2);
  });

  it('returns 3 (only -d safe) via the ancestor-test fallback when gh is unavailable', () => {
    const verdict = runClassify('feat/x', 'abc123', {
      gh_ok: 0,
      ancestor: true,
    });
    expect(verdict).toBe(3);
  });

  it('returns 1 (keep, inconclusive) via the ancestor-test fallback when the ancestor test fails', () => {
    const verdict = runClassify('feat/x', 'abc123', {
      gh_ok: 0,
      ancestor: false,
    });
    expect(verdict).toBe(1);
  });
});
