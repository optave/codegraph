#!/usr/bin/env bash
# gc-worktrees.sh — collect finished agent worktrees so they stop pinning branch names.
#
# WHY THIS EXISTS (the failure it prevents):
# A branch can be checked out in exactly ONE worktree. Every dispatched agent gets its
# own worktree (`isolation: 'worktree'`), and nothing removed them when the run ended,
# so they accumulate. Each one holds its branch hostage:
#   $ git checkout feat/some-task
#   fatal: 'feat/some-task' is already checked out at '.claude/worktrees/wf_40037…-1'
# The visible symptoms are (a) `gh pr checkout <pr>` aborting outright in a sweep/resolve
# agent, and (b) agents improvising a local branch name of their own and pushing from it.
# The other half of the fix is checking out DETACHED — see the sweep/resolve skills.
#
# Usage:  gc-worktrees.sh [--dry-run] [--prune-branches]
#   --dry-run         report what would be removed; change nothing. Exit 0 either way.
#   --prune-branches  also `git branch -d` each freed branch (safe delete — git itself
#                     refuses if it is not merged; we only ever offer merged ones).
#
# REMOVAL RULE (all four must hold — fail-closed, never force):
#   1. SCOPE     — the worktree path is under <repo-root>/.claude/worktrees/. The primary
#                  checkout and any worktree a human made elsewhere are silently skipped.
#                  (Without this the repo root itself matches "merged" trivially and git
#                  rejects `worktree remove <root>` with a confusing error every run.)
#   2. SETTLED   — its branch belongs to a PR GitHub reports as MERGED or CLOSED.
#                  NOT `git merge-base --is-ancestor <branch> origin/<default>`: a repo that
#                  SQUASH-merges never makes a landed branch's tip an ancestor of the default
#                  branch, so that test looks right, passes review, and silently collects
#                  NOTHING forever. It is kept only as the fallback for a detached HEAD (no
#                  branch to look up) and for when `gh` is unavailable.
#   3. CLEAN     — `git status --porcelain` is empty. Uncommitted work (tracked OR
#                  untracked) is never discarded; the worktree is reported and skipped.
#   4. UNLOCKED  — `git worktree lock` is the explicit "do not collect this" marker.
#
# ORPHANS: a worktree whose branch has NO pull request at all is kept (we cannot prove the
# work landed), but it is counted and LISTED separately rather than folded into the
# "still in flight" total. Those are usually the improvised local branch names that the
# detached-checkout fix exists to stop creating, and they pin their names indefinitely —
# a silent count is what lets them accumulate unnoticed.
#
# Safe to run concurrently with live agents: a worktree an agent is actively using has an
# open PR (rule 2) or a dirty tree (rule 3), so it fails the rule set. This is also why the
# script never takes a lock of its own — `git worktree remove` is atomic enough for the
# narrow set that survives all four rules.

set -euo pipefail

dry_run=0
prune_branches=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --prune-branches) prune_branches=1 ;;
    *) echo "usage: gc-worktrees.sh [--dry-run] [--prune-branches]" >&2; exit 2 ;;
  esac
done

git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "ABORT: not inside a git repository" >&2; exit 1; }
# Resolve the MAIN checkout, not the caller's worktree: this script may be invoked from
# inside a linked worktree, where --show-toplevel is that worktree. Worktrees live under
# the main checkout, so scope must be anchored there.
#
# Take it from `worktree list` (git always lists the main worktree first) rather than from
# `dirname $(git rev-parse --git-common-dir)` + `pwd`. On Git Bash `pwd` yields an MSYS path
# (/h/Vscode/repo) while `worktree list` yields a Windows one (H:/Vscode/repo), so the two
# never string-match and the SCOPE guard silently rejects every worktree — the whole script
# becomes a no-op that reports "0 collected". Reading both from the same git command keeps
# the path format consistent by construction.
main_root="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
[ -n "$main_root" ] || { echo "ABORT: could not resolve the main worktree path" >&2; exit 1; }
scope="$main_root/.claude/worktrees/"

# Refresh origin once — rule 2's fallback compares against it, and a stale ref would make
# landed work look unmerged (the conservative direction: we collect nothing).
git -C "$main_root" fetch origin --quiet 2>/dev/null || \
  echo "note: could not fetch origin — judging merged-ness against the local remote refs" >&2

# Do NOT hardcode `main`: this script ships to repos whose default branch differs.
default_branch="$(git -C "$main_root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
if [ -z "$default_branch" ]; then
  default_branch="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)"
fi
[ -n "$default_branch" ] || default_branch="main"

if ! git -C "$main_root" rev-parse --verify --quiet "origin/$default_branch" >/dev/null; then
  echo "ABORT: origin/$default_branch is not resolvable — cannot judge which worktrees have landed" >&2
  exit 1
fi

# Rule 2's primary source: head-branch names whose PR GitHub reports SETTLED — MERGED or
# CLOSED. Closed counts because removing a CLEAN worktree destroys nothing (the branch and
# every commit survive; only the checkout directory goes).
# One paginated call, not one per worktree. If `gh` is missing or unauthenticated we fall
# back to the ancestor test per worktree — which under a squash-merge workflow collects
# almost nothing, so say so out loud rather than reporting a clean "0 collected".
# `gh --jq` uses gh's BUILT-IN jq, so this needs no external jq on PATH.
settled_heads=""; open_heads=""
gh_ok=0
if command -v gh >/dev/null 2>&1 \
  && all_prs="$(gh pr list --state all --limit 1000 --json headRefName,state \
       --jq '.[] | "\(.state)\t\(.headRefName)"' 2>/dev/null)"; then
  open_heads="$(printf '%s\n' "$all_prs" | sed -n 's/^OPEN\t//p')"
  settled_heads="$(printf '%s\n' "$all_prs" | sed -n '/^OPEN\t/!s/^[A-Z]*\t//p')"
  gh_ok=1
else
  echo "note: gh unavailable/unauthenticated — falling back to the ancestor test, which under" >&2
  echo "      a squash-merge workflow will collect almost nothing. Re-run with gh." >&2
fi

# Classify this worktree's work. $1 = branch name ("" when detached), $2 = HEAD sha.
#   0 = settled  -> collect
#   1 = open PR  -> live work, keep quietly
#   2 = no PR    -> orphan, keep but REPORT
classify() {
  local branch="$1" head="$2"
  if [ "$gh_ok" -eq 1 ] && [ -n "$branch" ]; then
    # An OPEN PR anywhere on this branch vetoes collection, even if an older PR on the
    # same branch settled (a re-dispatch reuses the name) — the open one is live work.
    # Exact whole-line match — "plan/FU-46" must not match "plan/FU-460".
    # HERE-STRINGS, not `printf … | grep -q`: with `set -o pipefail`, grep -q exits on the
    # first match, the producer takes SIGPIPE, and the pipeline reports 141 — so a settled
    # branch would read as unsettled. A here-string has no pipe and no such failure mode.
    grep -qxF "$branch" <<<"$open_heads" && return 1
    grep -qxF "$branch" <<<"$settled_heads" && return 0
    return 2
  fi
  # Detached HEAD, or no gh: fall back to the ancestor test. A detached worktree has no
  # name to pin, so keeping it costs nothing when the test is inconclusive.
  if git -C "$main_root" merge-base --is-ancestor "$head" "origin/$default_branch" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Directories that no longer exist on disk: git's own bookkeeping handles these.
[ "$dry_run" -eq 1 ] || git -C "$main_root" worktree prune

# These are newline-delimited STRINGS, not arrays: `${#arr[@]}` on an empty array trips
# `set -u` on bash 3.2, which this script still targets for portability.
removed=0; skipped_dirty=0; skipped_open=0; skipped_orphan=0; skipped_locked=0
freed_branches=""; orphan_branches=""

# `git worktree list --porcelain` emits stanzas: worktree <path> / HEAD <sha> /
# branch <ref>|detached / locked. Parse the stanza rather than the human format, whose
# columns are ambiguous once a path contains spaces.
current_path=""; current_head=""; current_branch=""; current_locked=0

flush() {
  [ -n "$current_path" ] || return 0
  local path="$current_path" head="$current_head" branch="$current_branch" locked="$current_locked"
  current_path=""; current_head=""; current_branch=""; current_locked=0

  # Rule 1 — SCOPE.
  case "$path/" in "$scope"*) ;; *) return 0 ;; esac
  # Defence in depth: never touch the main checkout even if it somehow matched.
  [ "$path" != "$main_root" ] || return 0

  local label="${branch:-detached@${head:0:8}}"

  # Rule 4 — UNLOCKED.
  if [ "$locked" -eq 1 ]; then
    skipped_locked=$((skipped_locked + 1))
    echo "  skip (locked)    $label"
    return 0
  fi

  # Rule 2 — SETTLED.
  local verdict=0
  classify "$branch" "$head" || verdict=$?
  case "$verdict" in
    1) skipped_open=$((skipped_open + 1)); return 0 ;;
    2) skipped_orphan=$((skipped_orphan + 1))
       orphan_branches="${orphan_branches}${label}
"
       return 0 ;;
  esac

  # Rule 3 — CLEAN.
  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    skipped_dirty=$((skipped_dirty + 1))
    echo "  skip (uncommitted work)  $label — $path"
    return 0
  fi

  if [ "$dry_run" -eq 1 ]; then
    echo "  would remove     $label"
  else
    if git -C "$main_root" worktree remove "$path" 2>/dev/null; then
      echo "  removed          $label"
    else
      echo "  skip (git refused the remove)  $label — $path"
      return 0
    fi
  fi
  removed=$((removed + 1))
  if [ -n "$branch" ]; then
    freed_branches="${freed_branches}${branch}
"
  fi
  return 0
}

while IFS= read -r line; do
  case "$line" in
    "worktree "*) flush; current_path="${line#worktree }" ;;
    "HEAD "*)     current_head="${line#HEAD }" ;;
    "branch "*)   current_branch="${line#branch refs/heads/}" ;;
    "locked"|"locked "*) current_locked=1 ;;
  esac
done < <(git -C "$main_root" worktree list --porcelain)
flush

if [ "$prune_branches" -eq 1 ] && [ "$dry_run" -eq 0 ] && [ -n "$freed_branches" ]; then
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    # -d (not -D): git refuses if the branch is somehow not merged after all.
    if git -C "$main_root" branch -d "$b" >/dev/null 2>&1; then echo "  branch deleted   $b"; fi
  done <<EOF
$freed_branches
EOF
fi

# Orphans get named, not just counted. Folding them into the in-flight total is what lets
# a repo report itself healthy while dozens of dead worktrees pin their branch names.
if [ "$skipped_orphan" -gt 0 ]; then
  echo
  echo "  ${skipped_orphan} worktree(s) kept because no PR exists for the branch — these pin their"
  echo "  names indefinitely. Check whether the work is abandoned, then remove by hand:"
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    echo "    - $b"
  done <<EOF
$orphan_branches
EOF
fi

echo "gc-worktrees: ${removed} collected$([ "$dry_run" -eq 1 ] && echo ' (dry-run)'), ${skipped_open} in flight (open PR), ${skipped_orphan} orphaned (no PR), ${skipped_dirty} with uncommitted work, ${skipped_locked} locked."
exit 0
