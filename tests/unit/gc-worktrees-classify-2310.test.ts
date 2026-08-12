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
import os from 'node:os';
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

/**
 * Regression test for Greptile's findings across two rounds of review on PR #2469:
 *
 * Round 1: the original fix collected confirmed-`-D`-safe branch names into a list during
 * the worktree walk, then deleted them all in a SEPARATE loop after the walk finished. That
 * gap — the time the rest of the walk took — let a concurrent process recreate or advance a
 * freed branch name before the deferred loop reached it; `-D` would then delete that NEW ref
 * by name alone, with no re-verification. Fixed by moving deletion into `prune_branch()`,
 * called immediately after each branch's own worktree removal.
 *
 * Round 2: that fix still re-read the branch's tip via a separate `rev-parse`, THEN called
 * `git branch -D` in a second, distinct git invocation — leaving a narrower but still-real
 * gap between the two commands. Fixed by replacing both with a single
 * `git update-ref -d refs/heads/<branch> <expected-sha>` call, which git performs as one
 * atomic compare-and-delete: it deletes the ref only if it still points at the given SHA,
 * with no window in between for a concurrent process to exploit.
 */
const pruneBranchFn = extractFunction(script, 'prune_branch');

interface PruneBranchOpts {
  pruneBranches?: 0 | 1;
  /** Whether the stubbed `git branch -d` should succeed (verdict-3 path only). */
  deleteOk?: boolean;
  /** What the branch's ref is stubbed to ACTUALLY point at, simulating concurrent mutation. Defaults to `head` (no drift). */
  actualRefSha?: string;
}

/** Run the real prune_branch() against controlled inputs; reports output text and every `git branch`/`git update-ref` invocation it made. */
function runPruneBranch(
  branch: string,
  head: string,
  verdict: number,
  opts: PruneBranchOpts = {},
): { output: string; gitCalls: string[] } {
  const pruneBranches = opts.pruneBranches ?? 1;
  const deleteOk = opts.deleteOk ?? true;
  const actualRefSha = opts.actualRefSha ?? head;
  const logFile = path.join(
    os.tmpdir(),
    `gc-worktrees-prune-branch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  );
  // Stub `git` so both call shapes prune_branch() makes are controllable without a real
  // repo: `git -C "$main_root" branch -d "$branch"` (arg $3 = "branch", verdict-3 path) and
  // `git -C "$main_root" update-ref -d "refs/heads/$branch" "$head"` (arg $3 = "update-ref",
  // verdict-0 path). update-ref is simulated with the same atomic compare-and-delete
  // semantics the real command has: it succeeds only if the given old value ($6) matches
  // this branch's stubbed actual ref value, mirroring how a concurrent mutation would make
  // the real `git update-ref -d` fail closed rather than delete the wrong ref.
  const gitStub = `
    git() {
      if [ "$3" = "branch" ]; then
        echo "branch $4" >> "${logFile}"
        [ "${deleteOk ? 1 : 0}" = "1" ] && return 0 || return 1
      elif [ "$3" = "update-ref" ]; then
        echo "update-ref $6" >> "${logFile}"
        [ "$6" = "${actualRefSha}" ] && return 0 || return 1
      fi
    }
  `;
  const runner = `
    ${gitStub}
    main_root="/tmp"
    prune_branches=${pruneBranches}
    ${pruneBranchFn}
    prune_branch "${branch}" "${head}" "${verdict}"
  `;
  const output = execFileSync('bash', ['-c', runner], { encoding: 'utf8' });
  let gitCalls: string[] = [];
  if (fs.existsSync(logFile)) {
    gitCalls = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    fs.unlinkSync(logFile);
  }
  return { output, gitCalls };
}

describe('gc-worktrees.sh prune_branch() (#2310, Greptile rounds 1-2 on PR #2469)', () => {
  it('extracted a non-trivial prune_branch() containing the atomic update-ref delete', () => {
    expect(pruneBranchFn).toContain('update-ref');
    expect(pruneBranchFn).toContain('branch ref changed since classification');
  });

  it('uses -d (not update-ref) for verdict 3 (settled, not name+SHA-confirmed)', () => {
    const { output, gitCalls } = runPruneBranch('feat/x', 'abc123', 3);
    expect(gitCalls).toEqual(['branch -d']);
    expect(output).toContain('branch deleted');
  });

  it('reports nothing (not an error) when -d refuses an unmerged verdict-3 branch', () => {
    const { output, gitCalls } = runPruneBranch('feat/x', 'abc123', 3, { deleteOk: false });
    expect(gitCalls).toEqual(['branch -d']);
    expect(output).not.toContain('branch deleted');
  });

  it('deletes via update-ref for verdict 0 when the ref still matches the confirmed-merged SHA', () => {
    const { output, gitCalls } = runPruneBranch('feat/x', 'abc123', 0, { actualRefSha: 'abc123' });
    expect(gitCalls).toEqual(['update-ref abc123']);
    expect(output).toContain('branch deleted');
  });

  it('atomically refuses the update-ref delete when the branch ref changed since classification', () => {
    // This is the round-2 TOCTOU fix: classify() confirmed SHA abc123 merged, but by the
    // time prune_branch() runs, refs/heads/feat/x actually points at def456 — a concurrent
    // process recreated or advanced this exact branch name. The single update-ref call still
    // fires (there is no separate pre-check to skip), but git's own atomic compare-and-delete
    // refuses it in the same operation — never a two-step check-then-delete that a race could
    // slip between.
    const { output, gitCalls } = runPruneBranch('feat/x', 'abc123', 0, { actualRefSha: 'def456' });
    expect(gitCalls).toEqual(['update-ref abc123']);
    expect(output).toContain('skip (branch ref changed since classification)  feat/x');
  });

  it('is a no-op when --prune-branches was not passed', () => {
    const { output, gitCalls } = runPruneBranch('feat/x', 'abc123', 0, {
      pruneBranches: 0,
      actualRefSha: 'abc123',
    });
    expect(gitCalls).toEqual([]);
    expect(output).toBe('');
  });

  it('is a no-op for a detached worktree (no branch name to delete)', () => {
    const { output, gitCalls } = runPruneBranch('', 'abc123', 3);
    expect(gitCalls).toEqual([]);
    expect(output).toBe('');
  });
});
