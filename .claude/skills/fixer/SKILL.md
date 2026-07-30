---
name: fixer
description: Solve open issues end-to-end in batches of N — one fresh branch per issue, PR, review convergence, and merge — looping across batches until the whole backlog for --author is drained (or a safety cap is hit), then draining any stragglers in a final sweep phase. Never operates outside the current repo; if there is nothing to do, does nothing.
argument-hint: "[count] [--author <login>] [--start-from <issue>] [--once] [--dry-run]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Monitor, Agent
---

# /fixer — Solve, Ship, and Merge Until the Backlog Is Actually Done

Work the lowest-numbered open issues in **this repository only** from open issue to merged PR, one at a time, in batches of `count` (default 10). Each issue gets its own branch cut from a freshly fetched `origin/main`, its own PR, its own review-convergence loop, and its own merge. Any PR that cannot be brought to a mergeable state inline is **parked** so the batch keeps moving, and Phase: Drain Parked PRs drains all parked PRs with `/sweep` and `/resolve` until every one is merged or provably blocked.

**The objective is the whole qualifying backlog, not one arbitrary batch.** Once a batch's issues are all merged/parked/abandoned and Phase: Drain Parked PRs has run, Phase: Continue the Batch Loop, or Proceed to Drain checks whether more open issues by `AUTHOR` still qualify. If they do, the next batch starts automatically. Pass `--once` to process a single batch and stop instead, regardless of what remains.

**Repo scope.** /fixer only ever acts on the repo it is invoked in (detected dynamically in Phase 0 — on this checkout, `optave/ops-codegraph-tool`). It never searches, opens issues on, or opens PRs against any other repository, even when this repo currently has nothing to do. **An empty queue is a successful outcome, not a failure**: if there is nothing to do, Phase 1 reports that and stops — it does not look elsewhere, does not lower the `--author`/`blocked`-label bar to manufacture a queue, and does not invent unrelated work (stale files, refactors, drive-by fixes) to fill a batch.

---

## Why this skill is built the way it is

A previous batch run on this repo collapsed under compounding merge conflicts — hours were spent re-fixing work that had already been solved. That was not bad luck; it was mechanical, and it had two causes:

1. **Issues were solved on a shared branch**, so every PR's diff grew to contain all prior fixes. Each new conflict had to be re-resolved against an ever-larger diff.
2. **The `Main` ruleset enforces `strict: true`** on its required status checks — a PR must be up to date with `main` to merge. With 10 PRs open at once, merging each one leaves every remaining branch stale, so the batch pays ~45 catch-up merges, and each one is a fresh chance to silently drop already-solved work.

/fixer eliminates both by construction. These are **invariants**, not preferences — every phase below is written to preserve them, and violating one re-introduces the exact failure this skill exists to prevent.

- **I1 — One branch per issue, always cut from a freshly fetched `origin/main`.** Never reuse a branch across issues. Never stack a branch on another issue's branch. Stacking is especially unsafe here: this repo has `deleteBranchOnMerge: true`, so merging a base PR **closes** its stacked PRs instead of retargeting them.
- **I2 — Merge the current PR before cutting the next issue's branch.** The next branch is therefore cut from a `main` that already contains every prior fix. It cannot conflict with earlier work in the batch, and it satisfies `strict: true` the moment it is created.
- **I3 — At most one PR open at a time on the happy path.** Zero catch-up merges means zero compounding. Open-PR count only rises when a PR is parked.
- **I4 — Never re-solve solved work.** Only parked PRs ever need a catch-up merge. Every such merge must pass the diff-integrity check in Phase: Drain Parked PRs, which mechanically verifies that every line the PR authored still survives.
- **I5 — Never rebase; always `git merge origin/main`.** The ruleset forbids non-fast-forward pushes to `main` and the repo disables rebase-merge.
- **I6 — A parked PR never blocks the next issue.** Parking is the escape hatch that keeps the batch moving; Phase: Drain Parked PRs cleans up.

---

## Arguments

Parse `$ARGUMENTS` into these state variables, persisted to `.codegraph/fixer/` (Pattern 1 — bash blocks do not share variables):

| Token | Variable | Default | Meaning |
|-------|----------|---------|---------|
| first bare integer | `COUNT` | `10` | How many issues to process per batch. The run loops across batches (Phase: Continue the Batch Loop, or Proceed to Drain) until the backlog is drained, unless `--once` is set |
| `--author <login>` | `AUTHOR` | `carlos-alm` | Only consider issues opened by this login |
| `--start-from <issue>` | `START_FROM` | none | Skip queue entries below this issue number (resume, or manual batch offset) |
| `--once` | `ONCE` | `false` | Process a single batch of `COUNT` issues and stop, even if more qualifying open issues remain |
| `--dry-run` | `DRY_RUN` | `false` | Plan and analyse only — create no branch, commit, PR, or merge |

```bash
mkdir -p .codegraph/fixer
ARGS="${ARGUMENTS:-}"

# Strip flag/value pairs before scanning for the bare count, otherwise a value like
# '--start-from 1900' is mistaken for the count and the run aborts on the range check.
BARE=$(printf '%s\n' "$ARGS" | sed -E 's/--author[= ]+[A-Za-z0-9_-]+//g; s/--start-from[= ]+[0-9]+//g')
COUNT=$(printf '%s\n' "$BARE" | tr ' ' '\n' | grep -E '^[0-9]+$' | head -1)
[ -z "$COUNT" ] && COUNT=10
if [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 25 ]; then
  echo "ERROR: count must be between 1 and 25 (got '$COUNT'). A batch larger than 25 is an epic, not a /fixer run."
  exit 1
fi

AUTHOR=$(printf '%s\n' "$ARGS" | grep -oE '\-\-author[= ]+[A-Za-z0-9_-]+' | head -1 | sed -E 's/.*[= ]//')
[ -z "$AUTHOR" ] && AUTHOR="carlos-alm"

START_FROM=$(printf '%s\n' "$ARGS" | grep -oE '\-\-start-from[= ]+[0-9]+' | head -1 | grep -oE '[0-9]+$')
[ -z "$START_FROM" ] && START_FROM=0

case "$ARGS" in *--dry-run*) DRY_RUN=true ;; *) DRY_RUN=false ;; esac
case "$ARGS" in *--once*) ONCE=true ;; *) ONCE=false ;; esac

printf '%s\n' "$COUNT"      > .codegraph/fixer/count
printf '%s\n' "$AUTHOR"     > .codegraph/fixer/author
printf '%s\n' "$START_FROM" > .codegraph/fixer/start-from
printf '%s\n' "$DRY_RUN"    > .codegraph/fixer/dry-run
printf '%s\n' "$ONCE"       > .codegraph/fixer/once
echo "fixer: count=$COUNT author=$AUTHOR start-from=$START_FROM once=$ONCE dry-run=$DRY_RUN"
```

---

## Phase 0 — Pre-flight

Validate the environment before touching anything. Every failure here exits non-zero with an actionable message.

```bash
for tool in git gh jq mktemp; do
  # > /dev/null 2>&1: suppress the resolved path on success and the shell's "not found" text on failure — the || clause provides the actionable message
  command -v "$tool" > /dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found in PATH"; exit 1; }
done

# > /dev/null 2>&1: suppress git's own "fatal: not a git repository" — our message is more actionable
git rev-parse --show-toplevel > /dev/null 2>&1 || { echo "ERROR: not in a git repository — run /fixer from the repo root"; exit 1; }

# > /dev/null 2>&1: suppress gh's auth-status banner on success and its error body on failure — the || clause explains the fix
gh auth status > /dev/null 2>&1 || { echo "ERROR: gh is not authenticated — run 'gh auth login'"; exit 1; }

# A leftover merge from a crashed run would make the first 'git merge' fail with a confusing message.
# > /dev/null 2>&1: suppress rev-parse's SHA on success and its "unknown revision" text on failure — no MERGE_HEAD is the expected case
if git rev-parse --verify MERGE_HEAD > /dev/null 2>&1; then
  echo "ERROR: an in-progress merge (MERGE_HEAD) already exists."
  echo "Run: git merge --abort   then re-run /fixer"
  exit 1
fi

mkdir -p .codegraph/fixer
# Detect the repo slug dynamically so the skill works in a fork or after a rename
gh repo view --json nameWithOwner --jq '.nameWithOwner' > .codegraph/fixer/repo || {
  echo "ERROR: could not determine the repo slug — is this a GitHub remote?"; exit 1; }
echo "fixer: operating on $(cat .codegraph/fixer/repo)"
```

**This is the only repo /fixer touches for the rest of this run.** Every `gh` command in every phase below targets `$(cat .codegraph/fixer/repo)` exclusively. Do not `cd` into another repo, do not pass `--repo` with a different slug, and do not fall back to a different repository's issue queue for any reason — including an empty queue in Phase 1. Hardcoding the slug instead of reading it from this file is exactly the bug this skill avoids (see issue #2164 — the `sweep` skill hardcoded `optave/codegraph` while the real repo is `optave/ops-codegraph-tool` — for what that looks like when it goes wrong).

Detect the package manager once and persist the commands (Pattern 6 — never assume `npm`):

```bash
mkdir -p .codegraph/fixer
if [ -f "pnpm-lock.yaml" ]; then
  printf '%s\n' "pnpm test" > .codegraph/fixer/test-cmd
  printf '%s\n' "pnpm run lint" > .codegraph/fixer/lint-cmd
elif [ -f "yarn.lock" ]; then
  printf '%s\n' "yarn test" > .codegraph/fixer/test-cmd
  printf '%s\n' "yarn run lint" > .codegraph/fixer/lint-cmd
elif [ -f "package.json" ]; then
  printf '%s\n' "npm test" > .codegraph/fixer/test-cmd
  printf '%s\n' "npm run lint" > .codegraph/fixer/lint-cmd
else
  echo "WARN: no recognised package manager — verification will be skipped for every issue in this batch"
  printf '%s\n' "true" > .codegraph/fixer/test-cmd
  printf '%s\n' "true" > .codegraph/fixer/lint-cmd
fi
echo "fixer: test='$(cat .codegraph/fixer/test-cmd)' lint='$(cat .codegraph/fixer/lint-cmd)'"
```

**Worktree isolation.** CLAUDE.md requires an isolated worktree before making changes. If this session is not already inside one (check whether the current path contains `.claude/worktrees/`), run `/worktree` and continue there. One worktree serves the whole batch — I1 is preserved by cutting a new branch inside it per issue, not by using a new worktree per issue.

```bash
case "$(git rev-parse --show-toplevel)" in
  *.claude/worktrees/*) echo "fixer: already inside an isolated worktree — proceeding" ;;
  *) echo "fixer: NOT in a worktree — run /worktree before Phase: Solve and Merge Loop makes any change" ;;
esac
```

**Resume handling.** A non-empty `queue.json` means a previous invocation stopped mid-batch (crash, interruption) with unresolved work. A non-empty `parked.txt` *can* mean a previous invocation stopped mid-drain (Phase: Drain Parked PRs runs *after* `queue.json` is legitimately already empty, so `queue.json` alone cannot distinguish "batch loop finished, draining in progress" from "run genuinely complete") — but only if Phase: Final Report never actually ran for it. Phase: Drain Parked PRs' own exit condition is "every PR merged, or reported as needing human review," and that reporting happens in Phase: Final Report, not the moment a stall/cap counter crosses its threshold — a counter-based check (e.g. "`drain-stall` reached 3") is racy: the process can stop in the narrow window after Phase: Drain Parked PRs persists that threshold but before Phase: Final Report ever produces the report the human is supposed to see, and a counter-only check would misclassify that as "already reported" and delete the evidence before it was ever shown to anyone.

**`.codegraph/fixer/run-complete`** closes that race: Phase: Final Report touches it as its last action, strictly after the report has been fully produced. Its presence is the only authoritative signal that a run's outcome — including any blocked PRs left in `parked.txt` — was actually reported, not merely that some internal counter reached a threshold. So the fresh-vs-resume decision is: a previous run is resumable if `queue.json` is non-empty (mid-batch), OR `parked.txt` is non-empty **and** `run-complete` is absent (mid-drain — whether merely interrupted, or already past its stall/cap threshold but never actually reported). Only when neither holds — i.e. `parked.txt` is non-empty only alongside a present `run-complete`, or `parked.txt` is empty entirely — did the last invocation run all the way to a reported completion, so only then is every run-scoped artifact — including `batches-done`, `queue.json`, `parked.txt`, `drain-pass`, `drain-stall`, and `run-complete` itself — reset. Conflating these cases is exactly how a stale `batches-done` count or a stale empty `queue.json` leaks into a brand-new invocation and silently skips newly opened issues or hits the batch safety cap prematurely; how an interruption mid-drain (e.g. between `parked.txt`'s removal of a just-merged PR and the separate `state.json` update reconciling it) gets read as "nothing left to do," deleting `parked.txt` and wiping `state.json` before Phase: Drain Parked PRs' own self-heal step ever gets a chance to run; and, in the opposite direction, how a drain that merely *crossed* its stall/cap threshold — without Phase: Final Report ever having run — gets misread as already reported, permanently locking out new work while never having actually told anyone about the blocked PRs.

Resuming into a mid-drain state that had already crossed its stall/cap threshold (but was never reported) is safe even though it means running one more drain pass before Phase: Drain Parked PRs' own bookkeeping stops it again: that extra pass is cheap, and it is what finally lets Phase: Final Report run and write `run-complete`, closing the loop for every invocation after this one.

```bash
mkdir -p .codegraph/fixer
# 2>/dev/null || echo 0: a missing or corrupt queue.json is treated as empty, which
# correctly routes to the "fresh run" branch rather than erroring
QUEUE_LEN=$(jq 'length' .codegraph/fixer/queue.json 2>/dev/null || echo 0)
# -s (non-empty file): parked.txt is only ever emptied, never deleted, once draining
# finishes (Phase: Drain Parked PRs), so this is safe evidence that a drain is still
# in progress rather than long since complete.
PARKED_LEN=0
[ -s .codegraph/fixer/parked.txt ] && PARKED_LEN=$(wc -l < .codegraph/fixer/parked.txt)
# run-complete is written ONLY by Phase: Final Report, as its last action, strictly after
# the report has been produced. Its presence — not a stall/cap counter, which gets written
# mid-Phase-4 and races against Phase: Final Report actually running — is the sole
# authoritative signal that a run (and any blocked PRs left in parked.txt) was truly
# reported and finished, rather than merely having crossed an internal threshold.
RUN_COMPLETE=0
[ -f .codegraph/fixer/run-complete ] && RUN_COMPLETE=1
if { [ -f .codegraph/fixer/queue.json ] && [ "$QUEUE_LEN" -gt 0 ]; } || { [ "$PARKED_LEN" -gt 0 ] && [ "$RUN_COMPLETE" -eq 0 ]; }; then
  echo "fixer: resuming an interrupted run — previous state:"
  jq -r '.issues[] | "  #\(.issue)  \(.status)  \(if .pr then "PR #\(.pr)" else "no PR" end)"' .codegraph/fixer/state.json 2>/dev/null
  if [ "$QUEUE_LEN" -eq 0 ] && [ "$PARKED_LEN" -gt 0 ]; then
    echo "fixer: queue.json is empty but parked.txt has $PARKED_LEN PR(s) and no run-complete marker — the batch loop had already finished and this run was mid-drain (interrupted, or stalled/capped but never reported). Skip Phase 1-3 entirely and go straight to Phase: Drain Parked PRs."
  fi
else
  if [ "$PARKED_LEN" -gt 0 ]; then
    echo "fixer: previous run's drain already finished and its $PARKED_LEN blocked PR(s) were reported in Phase: Final Report (run-complete present) — that run is done. Starting a genuinely fresh run, not resuming it."
  elif [ -f .codegraph/fixer/state.json ]; then
    echo "fixer: previous run's artifacts are still on disk but its last batch already completed — that run is done. Starting a genuinely fresh run, not resuming it."
  else
    echo "fixer: fresh run — state initialised"
  fi
  printf '%s\n' '{"issues":[]}' > .codegraph/fixer/state.json
  rm -f .codegraph/fixer/queue.json .codegraph/fixer/parked.txt .codegraph/fixer/batches-done .codegraph/fixer/loop-decision \
        .codegraph/fixer/outcome .codegraph/fixer/round .codegraph/fixer/current-pr .codegraph/fixer/gate-fail \
        .codegraph/fixer/stall-count .codegraph/fixer/gate-signature .codegraph/fixer/prev-gate-signature \
        .codegraph/fixer/drain-pass .codegraph/fixer/drain-stall .codegraph/fixer/drain-parked-count \
        .codegraph/fixer/run-complete
fi
```

**Exit condition:** `git`, `gh`, `jq`, `mktemp` present; inside a git repo; `gh` authenticated; no in-progress merge; repo slug, test command, and lint command persisted to `.codegraph/fixer/`; arguments parsed and persisted; worktree isolation confirmed or requested; `state.json` exists. If resuming with an empty `queue.json` but a non-empty `parked.txt` and no `run-complete` marker, proceed directly to Phase: Drain Parked PRs — do not rebuild or reuse a queue for a batch loop that already finished. If `run-complete` is present alongside a non-empty `parked.txt`, this is a fresh run: those specific PRs were already reported and remain open on GitHub for a human (or a future `/fixer`/`/sweep`/`/resolve` invocation) to pick up — they are not silently lost, only no longer tracked in this run's local state.

---

## Phase 1 — Build the Issue Queue

Select the `COUNT` lowest-numbered **open** issues authored by `AUTHOR`, in ascending order. No size filtering and no reordering — the queue is exactly the lowest-numbered issues. Because I2 guarantees each branch is cut from a `main` containing all prior fixes, file overlap between queued issues is harmless, so filtering buys nothing.

Pull requests are issues in the GitHub API; `gh issue list` already excludes them. Exclude anything already assigned a `blocked` label, since those cannot be worked.

```bash
mkdir -p .codegraph/fixer
COUNT=$(cat .codegraph/fixer/count)
AUTHOR=$(cat .codegraph/fixer/author)
START_FROM=$(cat .codegraph/fixer/start-from)

if [ -f .codegraph/fixer/queue.json ]; then
  echo "fixer: reusing existing queue (Pattern 12 — artifact reuse). Delete .codegraph/fixer/queue.json to rebuild."
else
  # --author filters server-side so the --limit ceiling bounds this author's own backlog,
  # not the repo's entire open-issue count (gh issue list defaults to --limit 30 with no
  # server-side author filter, which previously meant issues by other authors could crowd
  # this author's own low-numbered issues out of the fetched window).
  #
  # ISSUE_FETCH_LIMIT is NOT "a generous number" — any fixed number, however large, is a
  # silent truncation point some author's backlog can eventually exceed (this skill already
  # went 400 -> 1000 once and Greptile correctly flagged 1000 as the same class of bug, not
  # a fix). Set it astronomically high instead, and treat hitting it as a hard error rather
  # than something to guess a bigger constant for: if RAW_COUNT below ever equals this limit,
  # the fetch was truncated and completeness genuinely cannot be trusted, so fail loudly
  # instead of silently reporting an incomplete queue or a falsely-drained backlog.
  ISSUE_FETCH_LIMIT=100000
  RAW_ISSUES=$(gh issue list --state open --author "$AUTHOR" --limit "$ISSUE_FETCH_LIMIT" \
    --json number,title,labels,author) || { echo "ERROR: failed to fetch issues from GitHub"; exit 1; }
  RAW_COUNT=$(printf '%s' "$RAW_ISSUES" | jq 'length')
  if [ "$RAW_COUNT" -eq "$ISSUE_FETCH_LIMIT" ]; then
    echo "ERROR: gh issue list returned exactly the $ISSUE_FETCH_LIMIT-issue fetch limit for author '$AUTHOR' — the result is truncated and queue completeness cannot be trusted. This should never happen in practice; investigate '$AUTHOR' before continuing."
    exit 1
  fi
  printf '%s' "$RAW_ISSUES" | jq "[.[] | select([.labels[].name] | index(\"blocked\") | not)
             | {issue: .number, title: .title}]
          | sort_by(.issue)
          | map(select(.issue >= ($START_FROM|tonumber)))
          | .[0:($COUNT|tonumber)]" > .codegraph/fixer/queue.json
fi

QUEUED=$(jq 'length' .codegraph/fixer/queue.json)
if [ "$QUEUED" -eq 0 ]; then
  echo "fixer: no open issues by '$AUTHOR' at or above #$START_FROM in $(cat .codegraph/fixer/repo) — nothing to do."
  echo "fixer: this is the correct terminal state, not a failure. Do NOT search other repositories, do NOT lower the '$AUTHOR'/blocked-label bar to manufacture a queue, and do NOT invent unrelated work (stale files, refactors, drive-by fixes) to fill a batch. Stop here."
  exit 0
fi
if [ "$QUEUED" -lt "$COUNT" ]; then
  echo "WARN: only $QUEUED open issues available (requested $COUNT) — the batch will be short"
fi
echo "fixer: queue of $QUEUED issue(s):"
jq -r '.[] | "  #\(.issue)  \(.title)"' .codegraph/fixer/queue.json
```

**Exit condition:** `.codegraph/fixer/queue.json` holds a non-empty, ascending array of `{issue, title}` objects with at most `COUNT` entries. The queue is printed so the user can see exactly what the run will attempt.

---

## Phase 2 — Solve and Merge Loop

Process queue entries **strictly in ascending issue order, one at a time**. Do not start the next issue until the current one is either merged or parked — that serialisation is what enforces I2 and I3.

Emit progress at the top of every iteration so a long batch is never silent (Pattern 11):

```bash
mkdir -p .codegraph/fixer
TOTAL=$(jq 'length' .codegraph/fixer/queue.json)
DONE=$(jq '[.issues[] | select(.status=="merged" or .status=="parked" or .status=="abandoned")] | length' .codegraph/fixer/state.json)
echo "fixer: progress $DONE/$TOTAL issues resolved"
jq -r '.[] | "  #\(.issue)  \(.title)"' .codegraph/fixer/queue.json | head -"$TOTAL"
```

For each issue `ISSUE` in the queue whose recorded status is not `merged`, `parked`, or `abandoned`, run steps 2a–2g.

`state.json` and `queue.json` are updated by two separate writes in step 2g (Pattern 1 — bash blocks do not share variables, so the outcome is appended in one `jq`/`mv` and the queue is shifted in another). If a run stops between those two writes, `queue.json[0]` is still the issue that `state.json` already recorded as resolved. Filter it out before ever reading the queue head, so a resumed run never re-branches or re-PRs completed work:

```bash
mkdir -p .codegraph/fixer
while true; do
  HEAD_ISSUE=$(jq -r '.[0].issue // empty' .codegraph/fixer/queue.json)
  [ -z "$HEAD_ISSUE" ] && break
  STATUS=$(jq -r --argjson issue "$HEAD_ISSUE" \
    '[.issues[] | select(.issue == $issue)] | if length > 0 then .[0].status else empty end' \
    .codegraph/fixer/state.json)
  case "$STATUS" in merged | parked | abandoned) ;; *) break ;; esac
  echo "fixer: issue #$HEAD_ISSUE already resolved in state.json ($STATUS) — dropping stale queue head (resume safety)"

  # 2g writes state.json's terminal record and parked.txt's append as two separate
  # writes. A stop between them leaves a parked PR's state.json entry in place but its
  # parked.txt entry missing — this queue head still gets dropped as resolved above, so
  # without this, that PR would silently never enter Phase: Drain Parked PRs. Reconstruct
  # the missing parked.txt entry from state.json's own record of the PR before moving on.
  if [ "$STATUS" = "parked" ]; then
    PR=$(jq -r --argjson issue "$HEAD_ISSUE" '[.issues[] | select(.issue == $issue)][0].pr' .codegraph/fixer/state.json)
    if [ -n "$PR" ] && [ "$PR" != "null" ] && ! grep -qxF "$PR" .codegraph/fixer/parked.txt 2>/dev/null; then
      printf '%s\n' "$PR" >> .codegraph/fixer/parked.txt
      echo "fixer: reconstructed missing parked.txt entry for PR #$PR (issue #$HEAD_ISSUE) — resume safety"
    fi
  fi

  TMP_QUEUE=$(mktemp "${TMPDIR:-/tmp}/fixer-queue.XXXXXXXXXX")
  trap 'rm -f "$TMP_QUEUE"' EXIT
  jq '.[1:]' .codegraph/fixer/queue.json > "$TMP_QUEUE" && mv "$TMP_QUEUE" .codegraph/fixer/queue.json
  trap - EXIT
done
```

### 2a. Cut a fresh branch from `origin/main` (invariant I1)

This is the single most important step in the skill. The branch **must** come from a just-fetched `origin/main`, never from the current HEAD and never from another issue's branch.

Branch names must match the repo's `Validate branch name` check, whose pattern is `^(feat|fix|docs|refactor|test|chore|ci|perf|build|release|dependabot|revert)/`. Choose the prefix from the issue's nature — `fix/` for a bug, `feat/` for a new capability, `docs/`, `perf/`, `refactor/`, `test/`, `chore:`-style prefixes as appropriate — and append a short slug plus the issue number.

Do **not** use `git stash` anywhere in this skill: the stash stack is shared with the main checkout and every other worktree, so a concurrent session could pop your entry. If the tree carries unexpected dirty files they belong to another session — leave them alone (CLAUDE.md) and only ever commit explicitly named paths.

```bash
mkdir -p .codegraph/fixer
DRY_RUN=$(cat .codegraph/fixer/dry-run)
# ISSUE and BRANCH are set for the current loop iteration: ISSUE is the queue entry's
# number and BRANCH is the name you chose above, e.g. ISSUE=1763 BRANCH=fix/issue-1763-busy-timeout
ISSUE=$(jq -r '.[0].issue' .codegraph/fixer/queue.json)
BRANCH="fix/issue-$ISSUE"

# A fresh branch means a fresh PR lifecycle. Clear any outcome/round/current-pr/gate-fail/
# stall state left behind by an interrupted earlier attempt on this same issue — e.g. a
# crash after convergence hit the park threshold and wrote outcome=parked, but before 2g
# recorded it in state.json and cleared these files (the dedup loop above only filters on
# state.json, so that crash window still lands here). Without this, the new attempt would
# inherit a stale "parked" verdict, an inflated round count, or a stall counter/signature
# from the previous issue's PR before it has even opened its own.
rm -f .codegraph/fixer/outcome .codegraph/fixer/round .codegraph/fixer/current-pr .codegraph/fixer/gate-fail \
      .codegraph/fixer/stall-count .codegraph/fixer/gate-signature .codegraph/fixer/prev-gate-signature

if ! printf '%s\n' "$BRANCH" | grep -qE '^(feat|fix|docs|refactor|test|chore|ci|perf|build|release|dependabot|revert)/'; then
  echo "ERROR: branch '$BRANCH' fails the repo's Validate branch name check"; exit 1
fi

git fetch origin main || { echo "ERROR: git fetch failed — cannot guarantee a fresh base (I1)"; exit 1; }

if [ "$DRY_RUN" = "true" ]; then
  echo "[DRY RUN] Would create branch '$BRANCH' from origin/main ($(git rev-parse --short origin/main))"
else
  # Delete any stale local branch of the same name from an aborted earlier run so the
  # new branch is genuinely cut from origin/main rather than resurrecting old work (I1).
  # > /dev/null 2>&1: the branch usually does not exist; its absence is the expected case
  if git rev-parse --verify "refs/heads/$BRANCH" > /dev/null 2>&1; then
    echo "WARN: local branch '$BRANCH' already exists — recreating it from origin/main to preserve I1"
    git checkout --detach origin/main || { echo "ERROR: could not detach onto origin/main"; exit 1; }
    git branch -D "$BRANCH" || { echo "ERROR: could not delete stale branch '$BRANCH'"; exit 1; }
  fi
  git checkout -b "$BRANCH" origin/main || { echo "ERROR: could not create '$BRANCH' from origin/main"; exit 1; }
  echo "fixer: $BRANCH cut from origin/main $(git rev-parse --short origin/main)"
fi
```

Confirm the base is genuinely current — this assertion is what makes `strict: true` a non-event later:

```bash
git fetch origin main || { echo "ERROR: git fetch failed"; exit 1; }
if git merge-base --is-ancestor origin/main HEAD; then
  echo "fixer: HEAD contains origin/main — strict:true satisfied at branch creation (I2)"
else
  echo "ERROR: HEAD does not contain origin/main — invariant I1/I2 violated, stop and investigate"
  exit 1
fi
```

### 2b. Understand the issue

Read the issue in full, including its comments and any linked issues or PRs:

```bash
mkdir -p .codegraph/fixer
REPO=$(cat .codegraph/fixer/repo)
ISSUE=$(jq -r '.[0].issue' .codegraph/fixer/queue.json)
gh issue view "$ISSUE" --repo "$REPO" --comments
```

Then build real context with codegraph, per CLAUDE.md — pick the commands that fit, do not run all of them mechanically:

- `codegraph where <symbol>` — locate the symbols the issue names
- `codegraph context <symbol> -T` — source, dependencies, and callers
- `codegraph fn-impact <symbol> -T` — blast radius before editing
- `codegraph audit --quick <target>` — structural overview

Use the global `codegraph` binary or `node dist/cli.js`. Never `npx codegraph` inside this repo — it hangs.

If the issue turns out to be already fixed, invalid, or a duplicate, do not invent work. Close it with an explanatory comment, record status `abandoned`, and move to the next queue entry:

```bash
mkdir -p .codegraph/fixer
REPO=$(cat .codegraph/fixer/repo)
ISSUE=$(jq -r '.[0].issue' .codegraph/fixer/queue.json)
gh issue close "$ISSUE" --repo "$REPO" --comment "<why this is already fixed, invalid, or a duplicate>" || {
  echo "ERROR: could not close issue #$ISSUE"; exit 1; }
printf '%s\n' "abandoned" > .codegraph/fixer/outcome
echo "fixer: issue #$ISSUE abandoned — no PR opened"
```

Then skip directly to step 2g to record the outcome and advance.

If the issue is genuinely too large for one PR, still attempt it — the queue is unfiltered by explicit choice. Split the work into a coherent first PR that fully solves a self-contained part, and open a tracked follow-up issue for the remainder rather than leaving the original half-done. State this clearly in the PR body and the final report.

### 2c. Implement the fix

Make the change. Non-negotiables from CLAUDE.md:

- **Fix root causes, never document a bug as expected behaviour.** If the native and WASM engines disagree, the less accurate engine has a bug — fix it.
- **Mirror engine changes.** A change in `src/` that alters engine behaviour needs the equivalent change in the mirrored module under `crates/codegraph-core/src/`, and vice versa.
- **Prefer the right architecture over the smallest diff.** Restructure when that leaves the design healthier, and surface the reasoning.
- **Add new behavioural constants to `DEFAULTS`** in `src/infrastructure/config.ts` — never a new hardcoded magic number.
- **Stay in scope.** Any finding that does not directly affect this issue's correctness becomes a GitHub issue via `gh issue create` **immediately**, not a note held in memory.
- **Add or update tests** covering the fix.

### 2d. Verify locally

Run the detected test and lint commands. If verification cannot run at all — compilation failure, missing grammars, platform problem — **stop and report to the user**. Never push unverified work and never decide on the user's behalf to proceed (CLAUDE.md).

```bash
mkdir -p .codegraph/fixer
TEST_CMD=$(cat .codegraph/fixer/test-cmd)
LINT_CMD=$(cat .codegraph/fixer/lint-cmd)

if ! sh -c "$LINT_CMD"; then
  echo "ERROR: lint failed — fix the findings before committing"
  exit 1
fi
if ! sh -c "$TEST_CMD"; then
  echo "ERROR: tests failed — fix them before committing, or report to the user if they cannot run"
  exit 1
fi
echo "fixer: lint and tests pass locally"
```

Then check the structural impact of what you changed:

```bash
codegraph diff-impact --staged -T || echo "WARN: diff-impact unavailable — continuing, but review the change manually"
```

### 2e. Commit, push, open the PR

Commits must pass the repo's `Validate commits` check: Conventional Commits, one of the allowed types (`feat fix docs refactor test chore ci perf build style revert release merge`), header ≤ 100 characters.

Stage only files you changed, by explicit path — never `git add .`, never `git add -A`. Group unrelated fixes into separate commits.

```bash
mkdir -p .codegraph/fixer
DRY_RUN=$(cat .codegraph/fixer/dry-run)
REPO=$(cat .codegraph/fixer/repo)
ISSUE=$(jq -r '.[0].issue' .codegraph/fixer/queue.json)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "$DRY_RUN" = "true" ]; then
  echo "[DRY RUN] Would commit, push '$BRANCH', and open a PR closing #$ISSUE"
else
  # Commit with explicit paths so the guard-git hook does not block on staged files
  # missing from the session edit log. Replace the paths with the files you changed.
  git commit src/path/changed.ts tests/path/changed.test.ts -m "fix: <what changed and why> (#$ISSUE)" || {
    echo "ERROR: commit rejected — read the hook or commitlint output above before retrying"; exit 1; }

  if git diff --cached --quiet && git diff --quiet; then
    echo "fixer: working tree clean after commit"
  else
    echo "WARN: uncommitted changes remain — confirm they belong to another session before proceeding"
  fi

  git push -u origin "$BRANCH" || { echo "ERROR: push failed"; exit 1; }
fi
```

Open the PR with a body that uses a **closing keyword** — `Closes #N`, not a bare `(#N)` — so merging auto-closes the issue:

```bash
mkdir -p .codegraph/fixer
DRY_RUN=$(cat .codegraph/fixer/dry-run)
REPO=$(cat .codegraph/fixer/repo)
ISSUE=$(jq -r '.[0].issue' .codegraph/fixer/queue.json)

if [ "$DRY_RUN" = "true" ]; then
  echo "[DRY RUN] Would open a PR for #$ISSUE"
else
  gh pr create --repo "$REPO" --base main \
    --title "fix: <concise summary> (#$ISSUE)" \
    --body "$(printf '%s\n' \
      "## Summary" \
      "<what was broken, what changed, and why this approach>" \
      "" \
      "## Verification" \
      "- lint: pass" \
      "- tests: pass" \
      "" \
      "Closes #$ISSUE")" \
    > .codegraph/fixer/last-pr-url || { echo "ERROR: gh pr create failed"; exit 1; }
  grep -oE '[0-9]+$' .codegraph/fixer/last-pr-url > .codegraph/fixer/current-pr
  echo "fixer: opened PR #$(cat .codegraph/fixer/current-pr) for issue #$ISSUE"
fi
```

### 2f. Converge the PR and merge it (invariant I2)

A PR merges only when **all five** gate conditions hold. Evaluate them together; if any is false, fix that specific condition and re-evaluate. **Do not cap this on a fixed round count** — some PRs genuinely need many rounds of real back-and-forth with reviewers. Instead, park the PR only when it is **blocked** (I6): 3 consecutive rounds where the gate signature (below) did not change at all, meaning nothing about the PR's state moved between rounds despite your fixes. As long as each round changes something — a comment answered, a check turning green, the Greptile score moving — keep going. A 15-round absolute cap exists purely as a backstop against a genuinely runaway loop (e.g. a reviewer bot stuck in a reply loop); hitting it is itself worth flagging as unusual in the final report, not a normal outcome.

| # | Condition | Check |
|---|-----------|-------|
| G1 | Greptile confidence is 5/5 | `Confidence Score: 5/5` in the Greptile summary |
| G2 | Every reviewer comment addressed and replied to | zero unanswered Greptile/Claude comments |
| G3 | Branch is up to date with `main` | `git merge-base --is-ancestor origin/main HEAD` |
| G4 | No merge conflicts | `mergeable == MERGEABLE` |
| G5 | Every check green | the whole `statusCheckRollup`, not just the six required contexts |

G5 is deliberately stricter than the ruleset. The ruleset requires only `Lint`, `CI Testing Pipeline`, `Validate branch name`, `Validate commits`, `License Compliance Scan`, and `CLA signature check`, but the repo runs ~24 checks including engine parity across three platforms, native host builds, Rust compile, and the benchmark gate. A red non-required check is still a signal worth reading, so the gate treats any red check as a failure and forces a diagnosis rather than letting it pass unexamined.

Wait for CI rather than polling blindly — `gh pr checks --watch` blocks until the run settles:

```bash
mkdir -p .codegraph/fixer
REPO=$(cat .codegraph/fixer/repo)
PR=$(cat .codegraph/fixer/current-pr)
# --watch blocks until every check reports; it exits non-zero when any check fails,
# which is the expected signal that G5 needs work rather than an error in this skill.
gh pr checks "$PR" --repo "$REPO" --watch --interval 30 || echo "fixer: checks not all green — G5 needs work"
```

For Greptile's response to a re-trigger to arrive, use the `Monitor` tool to poll (load it with `ToolSearch` if its schema is not present). Do not use foreground `sleep`. **Do not poll only for a `Confidence Score` to appear** — Greptile typically posts that score once, in its *initial* summary, and it does not necessarily reappear on later reviews, so that condition can already be trivially satisfied from round 1 while giving no signal about whether a re-trigger has converged. The actual terminal signals after posting `@greptileai` are:

- a **new** review or comment from `greptile-apps[bot]` posted after the trigger's timestamp (new findings — go address them and re-trigger again), or
- a **positive reaction** (`+1`, `hooray`, `heart`, `rocket`) from `greptile-apps[bot]` **on the trigger comment itself**, with no follow-up review — this means Greptile examined the fix and has nothing further to flag. Treat it as convergence for this round, not a reason to keep waiting for a review object that isn't coming.

```bash
mkdir -p .codegraph/fixer
REPO=$(cat .codegraph/fixer/repo)
PR=$(cat .codegraph/fixer/current-pr)
TRIGGER_COMMENT_ID=$(gh api "repos/$REPO/issues/$PR/comments" --paginate --jq \
  '[.[] | select(.body | test("^@greptileai\\s*$"))] | last | .id')
gh api "repos/$REPO/issues/comments/$TRIGGER_COMMENT_ID/reactions" \
  --jq '[.[] | select(.user.login == "greptile-apps[bot]" and (.content == "+1" or .content == "hooray" or .content == "heart" or .content == "rocket"))] | length'
# > 0 with no new review after this comment's timestamp: converged, proceed to the gate evaluation below.
```

Evaluate the whole gate in one pass:

```bash
mkdir -p .codegraph/fixer
REPO=$(cat .codegraph/fixer/repo)
PR=$(cat .codegraph/fixer/current-pr)
GATE_FAIL=0

# --- G1: Greptile confidence score (summary lives in issue comments or a review body) ---
GREP_BODY=$(gh api "repos/$REPO/issues/$PR/comments" --paginate \
  --jq '.[] | select(.user.login|test("greptile";"i")) | .body')
if [ -z "$GREP_BODY" ]; then
  GREP_BODY=$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate \
    --jq '.[] | select(.user.login|test("greptile";"i")) | .body')
fi
SCORE=$(printf '%s\n' "$GREP_BODY" | grep -oE 'Confidence Score: [0-9]+/5' | tail -1 | sed -E 's#.*: ([0-9]+)/5#\1#')
if [ "${SCORE:-0}" = "5" ]; then
  echo "G1 PASS: Greptile 5/5"
else
  echo "G1 FAIL: Greptile score '${SCORE:-none yet}' — address the gaps its summary names"; GATE_FAIL=1
fi

# --- G2: every reviewer's feedback has been addressed — inline comments from ANY
# reviewer (not just Greptile), plus top-level review bodies (Claude, Greptile, or a
# human), since a PR can carry unresolved Claude/human/review-body feedback with zero
# unanswered Greptile inline comments. ---
ALL_COMMENTS=$(gh api "repos/$REPO/pulls/$PR/comments" --paginate)
UNANSWERED=0
# Identities of the currently-unanswered comments, not just their count — two rounds can
# both show "2 unanswered" while the actual pair differs (one answered, a new one landed),
# which a bare count would wrongly read as zero movement. Folded into the gate signature below.
UNANSWERED_IDS=""
for CID in $(printf '%s\n' "$ALL_COMMENTS" | jq -r '[.[] | select(.in_reply_to_id == null)] | .[].id'); do
  ORIGIN_USER=$(printf '%s\n' "$ALL_COMMENTS" | jq -r --argjson cid "$CID" '[.[] | select(.id == $cid)][0].user.login')
  REPLIES=$(printf '%s\n' "$ALL_COMMENTS" | jq -s --argjson cid "$CID" --arg origin "$ORIGIN_USER" \
    '[.[][] | select(.in_reply_to_id == $cid) | select(.user.login != $origin)] | length')
  if [ "$REPLIES" -eq 0 ]; then
    UNANSWERED=$((UNANSWERED + 1))
    UNANSWERED_IDS="$UNANSWERED_IDS,$CID"
  fi
done

# Top-level review bodies (Claude's CHANGES_REQUESTED/COMMENT summary, Greptile's
# summary, or a human's) have no `path`/`line` and therefore no inline reply mechanism —
# they must be answered on the issue-comment thread instead, after the review was posted.
ISSUE_COMMENTS=$(gh api "repos/$REPO/issues/$PR/comments" --paginate)
REVIEWS=$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate)
ME=$(gh api user --jq '.login')

# Give each review body its OWN acknowledgment window: [this review's submitted_at, the
# NEXT review's submitted_at) — or +infinity for the most recent one. A single ME-authored
# reply posted after every review would otherwise fall inside every earlier review's
# "after" range too and retroactively "answer" all of them by account+timestamp alone,
# which is temporal correlation, not evidence that specific review's content was read.
# Requiring the reply to land strictly before the NEXT review closes that gap.
REVIEW_TIMES=$(printf '%s\n' "$REVIEWS" | jq -r '[.[] | select(.body != "")] | sort_by(.submitted_at) | .[].submitted_at')
IDX=0
for SINCE in $REVIEW_TIMES; do
  IDX=$((IDX + 1))
  UNTIL=$(printf '%s\n' "$REVIEW_TIMES" | sed -n "$((IDX + 1))p")
  if [ -n "$UNTIL" ]; then
    REPLY_IN_WINDOW=$(printf '%s\n' "$ISSUE_COMMENTS" | jq --arg since "$SINCE" --arg until "$UNTIL" --arg me "$ME" \
      '[.[] | select(.created_at > $since) | select(.created_at < $until) | select(.user.login == $me) | select((.body | test("^@(greptileai|claude)\\s*$")) | not)] | length')
  else
    REPLY_IN_WINDOW=$(printf '%s\n' "$ISSUE_COMMENTS" | jq --arg since "$SINCE" --arg me "$ME" \
      '[.[] | select(.created_at > $since) | select(.user.login == $me) | select((.body | test("^@(greptileai|claude)\\s*$")) | not)] | length')
  fi
  [ "$REPLY_IN_WINDOW" -eq 0 ] && UNANSWERED=$((UNANSWERED + 1))
done

if [ "$UNANSWERED" -eq 0 ]; then
  echo "G2 PASS: no unanswered reviewer comments"
else
  echo "G2 FAIL: $UNANSWERED unanswered reviewer item(s) (inline comments and/or review bodies, any reviewer)"; GATE_FAIL=1
fi

# --- G3: branch contains origin/main (required by strict:true) ---
git fetch origin main || { echo "ERROR: git fetch failed"; exit 1; }
if git merge-base --is-ancestor origin/main HEAD; then
  echo "G3 PASS: up to date with main"
else
  echo "G3 FAIL: behind main — see Phase: Drain Parked PRs for the safe catch-up merge"; GATE_FAIL=1
fi

# --- G4 + G5: mergeability and required checks ---
MERGEABLE=$(gh pr view "$PR" --repo "$REPO" --json mergeable --jq '.mergeable')
if [ "$MERGEABLE" = "MERGEABLE" ]; then
  echo "G4 PASS: no conflicts"
else
  echo "G4 FAIL: mergeable=$MERGEABLE"; GATE_FAIL=1
fi

FAILED_CHECKS=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select((.conclusion // "PENDING") | test("SUCCESS|NEUTRAL|SKIPPED") | not)] | map(.name // .context) | join(", ")')
if [ -z "$FAILED_CHECKS" ]; then
  echo "G5 PASS: all checks green"
else
  echo "G5 FAIL: not green — $FAILED_CHECKS"; GATE_FAIL=1
fi

# Per-check completion timestamp (not just the name) of every currently non-green check.
# A manual "Re-run failed jobs" or a flaky-test retry on the SAME commit produces a NEW
# completedAt/startedAt for the SAME named check — real CI activity that a name-only list
# cannot see, since the check's name, the commit SHA, and every other gate field stay
# identical while it reruns. Folded into the gate signature below instead of the plain
# name list so a rerun that fails the same check for a different reason is never mistaken
# for zero measurable change.
CHECK_FINGERPRINT=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select((.conclusion // "PENDING") | test("SUCCESS|NEUTRAL|SKIPPED") | not)] | map("\(.name // .context)@\(.completedAt // .startedAt // .createdAt // "pending")") | sort | join(", ")')

printf '%s\n' "$GATE_FAIL" > .codegraph/fixer/gate-fail
[ "$GATE_FAIL" -eq 0 ] && echo "fixer: PR #$PR passes all five gate conditions" || echo "fixer: PR #$PR is not mergeable yet"

# A compact fingerprint of everything this round measured. Two consecutive rounds with an
# IDENTICAL signature mean nothing about the PR's state moved despite whatever was fixed
# in between — that is the actual definition of "blocked" this skill parks on, not an
# arbitrary round count. Order the fields consistently so an unrelated field re-ordering
# never masquerades as a change.
#
# The aggregate score, unanswered count, mergeability, and failing-check names alone are
# too coarse: a new commit, a fresh Greptile review, or a new CI run can all leave every
# one of those aggregates reading identical to the previous round (score lags a push,
# a re-review restates the same score for different reasons, a rerun on the SAME commit
# fails the same named check for a different cause) — which would misread real activity as
# a stall. `commit` (the pushed SHA), `greptile_hash` (a hash of every Greptile comment/
# review body, not just the extracted digit), and `checks` (each non-green check's name
# PLUS its completion timestamp, not just its name) all change the instant that activity
# happens, even before the aggregates catch up, so genuine progress — including a same-
# commit CI rerun — is never mistaken for zero measurable change. `unanswered_ids`
# likewise tracks which comments are outstanding, not just how many, so a reply that
# resolves one comment while a new one lands does not cancel out to "no change".
GREPTILE_HASH=$(printf '%s' "$GREP_BODY" | cksum | awk '{print $1}')
COMMIT=$(git rev-parse HEAD)
printf '%s\n' "score=${SCORE:-none};greptile_hash=$GREPTILE_HASH;unanswered=$UNANSWERED;unanswered_ids=${UNANSWERED_IDS:-none};g3=$(git merge-base --is-ancestor origin/main HEAD && echo ok || echo behind);mergeable=$MERGEABLE;checks=$CHECK_FINGERPRINT;commit=$COMMIT" \
  > .codegraph/fixer/gate-signature
```

Track convergence rounds and park only when the PR is genuinely **blocked** (I6) — never on a fixed round count. This is the only place `outcome` is set to `parked`:

```bash
mkdir -p .codegraph/fixer
GATE_FAIL=$(cat .codegraph/fixer/gate-fail)
# 2>/dev/null: the round file is expected to be absent on the first convergence round — || supplies the starting count of 0
ROUND=$(( $(cat .codegraph/fixer/round 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$ROUND" > .codegraph/fixer/round

CURRENT_SIG=$(cat .codegraph/fixer/gate-signature)
# 2>/dev/null: prev-gate-signature is expected to be absent on round 1 — an empty PREV_SIG
# just means "no prior round to compare against", never treated as a false match below
PREV_SIG=$(cat .codegraph/fixer/prev-gate-signature 2>/dev/null || echo "")
printf '%s\n' "$CURRENT_SIG" > .codegraph/fixer/prev-gate-signature

if [ "$GATE_FAIL" -eq 0 ]; then
  rm -f .codegraph/fixer/round .codegraph/fixer/stall-count .codegraph/fixer/prev-gate-signature .codegraph/fixer/gate-signature
elif [ -n "$PREV_SIG" ] && [ "$CURRENT_SIG" = "$PREV_SIG" ]; then
  # 2>/dev/null: stall-count is expected to be absent before the first stalled round
  STALL=$(( $(cat .codegraph/fixer/stall-count 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$STALL" > .codegraph/fixer/stall-count
  echo "fixer: round $ROUND made no measurable progress vs. the previous round (stall $STALL/3)"
else
  printf '%s\n' 0 > .codegraph/fixer/stall-count
  echo "fixer: round $ROUND changed the PR's state vs. the previous round — real progress, resetting stall counter"
fi

STALL=$(cat .codegraph/fixer/stall-count 2>/dev/null || echo 0)
if [ "$GATE_FAIL" -ne 0 ] && { [ "$STALL" -ge 3 ] || [ "$ROUND" -ge 15 ]; }; then
  printf '%s\n' "parked" > .codegraph/fixer/outcome
  rm -f .codegraph/fixer/round .codegraph/fixer/stall-count .codegraph/fixer/prev-gate-signature .codegraph/fixer/gate-signature
  if [ "$STALL" -ge 3 ]; then
    echo "fixer: parking PR #$(cat .codegraph/fixer/current-pr) — blocked (3 consecutive rounds with zero measurable progress)"
  else
    echo "fixer: parking PR #$(cat .codegraph/fixer/current-pr) — 15-round safety cap reached despite ongoing progress; flag this as unusual in the final report"
  fi
elif [ "$GATE_FAIL" -ne 0 ]; then
  echo "fixer: round $ROUND — re-evaluate after fixing the failing condition(s)"
fi
```

**Fixing each failed condition:**

- **G1 / G2 — reviewer feedback.** Address every comment from every reviewer, including nits, and reply to each explaining what you did. Critically, **mine the Greptile summary body itself, not just the inline comments** — a score below 5/5 always names at least one gap in prose, and those gaps frequently have no inline comment. Any score below 5/5 with no inline comments means the finding is summary-only. If something is genuinely out of scope, file a tracked `follow-up` issue first and reference it in the reply — never defer untracked. Re-trigger Greptile with a `@greptileai` comment **only after** every Greptile comment has a reply. Re-trigger `@claude` only if you addressed Claude's own feedback. `/sweep` already encodes this whole procedure — delegating to it is the preferred route rather than re-deriving it here.
- **G3 — behind main.** On the happy path this cannot happen; I2 makes it structurally impossible. If it does, something merged to `main` mid-run. Use the safe catch-up merge from Phase: Drain Parked PRs, including its diff-integrity check.
- **G4 — conflicts.** Run `/resolve <pr>`. Never resolve by hand here and never rebase (I5).
- **G5 — red checks.** Read the logs (`gh run view <run-id> --log-failed`), diagnose, fix in code, re-verify locally, push. One known exception: the `Pre-publish benchmark gate` fails intermittently by a razor-thin margin on unrelated PRs — rerun that job once before treating it as a real regression.

**Merging.** The `Main` ruleset requires 1 approval plus 6 green checks and is bypassable only by an OrganizationAdmin. An autonomous run has no human approver, and every recent PR in this repo (#2133, #2141, #2142, #2143) was merged with zero approvals — so `--admin` is the established merge mechanism here and /fixer uses it to satisfy the approval rule.

That authority is strictly limited to the approval requirement. **Never `--admin` past a check that is red because of this PR's own changes.** A check may be bypassed only when you have read its logs, established the failure is unrelated to the diff, and recorded that diagnosis in the final report.

```bash
mkdir -p .codegraph/fixer
DRY_RUN=$(cat .codegraph/fixer/dry-run)
REPO=$(cat .codegraph/fixer/repo)
PR=$(cat .codegraph/fixer/current-pr)
GATE_FAIL=$(cat .codegraph/fixer/gate-fail)

# 2>/dev/null: outcome is expected to be absent before a PR's first convergence round — an empty OUTCOME just skips the "already parked" branch below
OUTCOME=$(cat .codegraph/fixer/outcome 2>/dev/null)
if [ "$OUTCOME" = "parked" ]; then
  echo "fixer: PR #$PR already parked (blocked or safety cap reached) — not merging"
elif [ "$GATE_FAIL" -ne 0 ]; then
  echo "fixer: gate not satisfied — fix the failing condition or park PR #$PR. Not merging."
elif [ "$DRY_RUN" = "true" ]; then
  echo "[DRY RUN] Would merge PR #$PR with --squash --admin"
else
  gh pr merge "$PR" --repo "$REPO" --squash --admin --delete-branch || {
    echo "ERROR: merge of PR #$PR failed — read the error above; do not retry blindly"; exit 1; }
  printf '%s\n' "merged" > .codegraph/fixer/outcome
  echo "fixer: merged PR #$PR"
fi
```

`--delete-branch` is safe **only** because I1 forbids stacking: no other PR is ever based on this branch. If you ever violate I1, this flag will close the dependent PRs instead of retargeting them.

Squash-merge is used because the repo disables rebase-merge and squashing keeps one clean commit per issue on `main`.

### 2g. Record the outcome and advance

Append this issue's result to `state.json`, then remove it from the queue so the next iteration picks up the following entry. Status is one of `merged`, `parked`, or `abandoned`.

```bash
mkdir -p .codegraph/fixer
ISSUE=$(jq -r '.[0].issue' .codegraph/fixer/queue.json)
if [ -z "$ISSUE" ] || [ "$ISSUE" = "null" ]; then
  echo "ERROR: queue is empty — nothing to record. The loop should have exited already."
  exit 1
fi
# STATUS comes from .codegraph/fixer/outcome, written by whichever path this issue
# actually took: "abandoned" in 2b, "parked" once the convergence-round cap is hit in
# 2f, or "merged" right after a successful `gh pr merge`. Never hardcode it here — that
# previously recorded every issue as "merged" regardless of what actually happened.
# 2>/dev/null: an empty STATUS below is expected if an earlier step failed to write it, and is handled explicitly
STATUS=$(cat .codegraph/fixer/outcome 2>/dev/null)
if [ -z "$STATUS" ]; then
  echo "ERROR: .codegraph/fixer/outcome was not set — an earlier step should have written abandoned/merged/parked before reaching this point"
  exit 1
fi
# 2>/dev/null: expected when the issue was abandoned in 2b and no PR was ever opened
PR=$(cat .codegraph/fixer/current-pr 2>/dev/null)
# --argjson rejects an empty string, so an absent PR must become the JSON literal null
[ -z "$PR" ] && PR="null"

# Trailing X's are required: BSD mktemp (macOS) does not substitute X's followed by a
# suffix — it returns the template literally, producing a fixed path that collides
# across concurrent sessions and fails outright on re-run.
TMP_STATE=$(mktemp "${TMPDIR:-/tmp}/fixer-state.XXXXXXXXXX")
trap 'rm -f "$TMP_STATE"' EXIT
jq --argjson issue "$ISSUE" --arg status "$STATUS" --argjson pr "$PR" \
  '.issues += [{issue: $issue, status: $status, pr: $pr}]' \
  .codegraph/fixer/state.json > "$TMP_STATE" && mv "$TMP_STATE" .codegraph/fixer/state.json
trap - EXIT

if [ "$STATUS" = "parked" ] && [ "$PR" != "null" ]; then
  printf '%s\n' "$PR" >> .codegraph/fixer/parked.txt
  echo "fixer: parked PR #$PR — Phase: Drain Parked PRs will handle it"
fi

TMP_QUEUE=$(mktemp "${TMPDIR:-/tmp}/fixer-queue.XXXXXXXXXX")
trap 'rm -f "$TMP_QUEUE"' EXIT
jq '.[1:]' .codegraph/fixer/queue.json > "$TMP_QUEUE" && mv "$TMP_QUEUE" .codegraph/fixer/queue.json
trap - EXIT
rm -f .codegraph/fixer/current-pr .codegraph/fixer/gate-fail .codegraph/fixer/outcome .codegraph/fixer/round \
      .codegraph/fixer/stall-count .codegraph/fixer/gate-signature .codegraph/fixer/prev-gate-signature

echo "fixer: issue #$ISSUE recorded as $STATUS; $(jq 'length' .codegraph/fixer/queue.json) remaining"
```

Loop back to step 2a for the next queue entry. **Only after the current PR is merged or parked** — that ordering is I2.

**Exit condition:** Every queue entry has a `state.json` record with status `merged`, `parked`, or `abandoned`; `queue.json` is an empty array. Every merged PR satisfied all five gate conditions. No branch was reused and no branch was stacked on another issue's branch.

---

## Phase 3 — Continue the Batch Loop, or Proceed to Drain

Phase 1 and Phase 2 together process exactly one batch of up to `COUNT` issues. **The run's objective is the whole qualifying backlog, not one batch** — this phase decides whether more work remains before moving on to drain and report.

Stop looping and go straight to Phase: Drain Parked PRs if `ONCE` or `DRY_RUN` is `true` — a single batch is the entire run in either case:

```bash
mkdir -p .codegraph/fixer
# 2>/dev/null: once is expected to be absent on a fixer version predating this flag — || supplies the safe default
ONCE=$(cat .codegraph/fixer/once 2>/dev/null || echo false)
DRY_RUN=$(cat .codegraph/fixer/dry-run)
if [ "$ONCE" = "true" ] || [ "$DRY_RUN" = "true" ]; then
  echo "fixer: --once or --dry-run set — this batch is the whole run, proceeding to drain"
  printf '%s\n' "stop" > .codegraph/fixer/loop-decision
else
  REPO=$(cat .codegraph/fixer/repo)
  AUTHOR=$(cat .codegraph/fixer/author)
  # One past the highest issue number this run has recorded, so the next batch's queue
  # never re-examines an issue this run already marked merged/parked/abandoned.
  NEXT_START=$(( $(jq '[.issues[].issue] | max // 0' .codegraph/fixer/state.json) + 1 ))
  # --author filters server-side (see Phase 1) and reuses the same ISSUE_FETCH_LIMIT /
  # truncation-detection pattern: a hard 400-issue window once silently under-reported
  # REMAINING as 0 in a repo with more open issues than that, reporting the backlog as
  # drained while qualifying issues past the window went uncounted. Raising the number
  # (400 -> 1000) only moved the same silent-truncation risk further out rather than
  # removing it, so this fetches against an effectively-unbounded limit and fails loudly
  # if that limit is ever actually hit, instead of trusting a fixed-size guess.
  ISSUE_FETCH_LIMIT=100000
  RAW_ISSUES=$(gh issue list --repo "$REPO" --state open --author "$AUTHOR" --limit "$ISSUE_FETCH_LIMIT" \
    --json number,labels,author) || { echo "ERROR: failed to fetch issues from GitHub for the batch-completion check"; exit 1; }
  RAW_COUNT=$(printf '%s' "$RAW_ISSUES" | jq 'length')
  if [ "$RAW_COUNT" -eq "$ISSUE_FETCH_LIMIT" ]; then
    echo "ERROR: gh issue list returned exactly the $ISSUE_FETCH_LIMIT-issue fetch limit for author '$AUTHOR' — the result is truncated and the drained/remaining determination cannot be trusted. This should never happen in practice; investigate '$AUTHOR' before continuing."
    exit 1
  fi
  REMAINING=$(printf '%s' "$RAW_ISSUES" | jq "[.[] | select([.labels[].name]|index(\"blocked\")|not) | select(.number >= $NEXT_START)] | length")

  # 2>/dev/null: batches-done is expected to be absent before the first batch completes
  BATCHES_DONE=$(( $(cat .codegraph/fixer/batches-done 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$BATCHES_DONE" > .codegraph/fixer/batches-done

  if [ "$REMAINING" -eq 0 ]; then
    echo "fixer: no more qualifying open issues at or above #$NEXT_START — backlog drained after $BATCHES_DONE batch(es)"
    printf '%s\n' "stop" > .codegraph/fixer/loop-decision
  elif [ "$BATCHES_DONE" -ge 15 ]; then
    echo "fixer: safety cap of 15 batches reached with $REMAINING qualifying issue(s) still open at or above #$NEXT_START"
    echo "fixer: resume with: /fixer --author $AUTHOR --start-from $NEXT_START"
    printf '%s\n' "stop" > .codegraph/fixer/loop-decision
  else
    echo "fixer: $REMAINING more qualifying issue(s) open at or above #$NEXT_START — starting batch $((BATCHES_DONE + 1))"
    # Clear per-batch scratch state so Phase 1 builds a genuinely fresh queue. state.json
    # and parked.txt are deliberately NOT cleared here — they accumulate across every
    # batch in this run so Phase: Drain Parked PRs and the final report cover the whole
    # run, not just the most recent batch.
    rm -f .codegraph/fixer/queue.json .codegraph/fixer/current-pr .codegraph/fixer/gate-fail \
          .codegraph/fixer/outcome .codegraph/fixer/round
    printf '%s\n' "$NEXT_START" > .codegraph/fixer/start-from
    printf '%s\n' "loop" > .codegraph/fixer/loop-decision
  fi
fi
```

If `.codegraph/fixer/loop-decision` is `loop`, go back to Phase 1 and process another batch — do **not** re-run Phase 0 (the repo slug, test/lint commands, and `state.json` are already established for this run, and re-running Phase 0's resume-detection would misread the mid-run `state.json` as a crash to resume from). If it is `stop`, proceed to Phase: Drain Parked PRs.

**Exit condition:** `.codegraph/fixer/loop-decision` is `loop` (with a fresh `start-from` persisted and per-batch scratch state cleared) or `stop`. Every batch processed this run is recorded cumulatively in `state.json` — nothing from an earlier batch is lost or overwritten by a later one.

---

## Phase 4 — Drain Parked PRs

Skip this phase entirely if `.codegraph/fixer/parked.txt` is absent or empty — on a clean run, Phase: Solve and Merge Loop merges everything inline and there is nothing to drain.

This is the mode switch: stop solving new issues, and work the parked PRs as a set until each is merged or provably blocked. **Do not cap this at a fixed pass count** — keep running passes as long as each one makes progress. Stop only after 3 consecutive passes that merge nothing (blocked), or a 15-pass absolute safety cap; report anything still unmerged afterwards as needing human review.

```bash
mkdir -p .codegraph/fixer

# Self-heal a parked.txt / state.json split-brain left by an interruption landing between
# this phase's own two-write reconciliation below (parked.txt removal, then a SEPARATE
# state.json update) — if the process stopped exactly there, parked.txt already lost the
# PR (correctly, since it merged) but state.json still records it as "parked". Left
# uncorrected, that merge is invisible to Phase 5's final report, and since queue.json is
# already empty by the time draining starts, a later invocation would read this as a
# genuinely fresh run and silently wipe the stale-but-recoverable record instead of fixing
# it. Reconcile before anything else touches parked.txt or state.json this pass.
for STALE_PR in $(jq -r '[.issues[] | select(.status=="parked") | .pr // empty] | .[]' .codegraph/fixer/state.json 2>/dev/null); do
  if ! grep -qxF "$STALE_PR" .codegraph/fixer/parked.txt 2>/dev/null; then
    TMP_STATE=$(mktemp "${TMPDIR:-/tmp}/fixer-state.XXXXXXXXXX")
    jq --argjson pr "$STALE_PR" '(.issues[] | select(.pr == $pr and .status=="parked") | .status) = "merged"' \
      .codegraph/fixer/state.json > "$TMP_STATE" && mv "$TMP_STATE" .codegraph/fixer/state.json
    echo "fixer: reconciled state.json entry for PR #$STALE_PR from a prior interrupted drain — parked.txt no longer lists it, so it must have already merged; corrected parked -> merged before continuing"
  fi
done

if [ ! -s .codegraph/fixer/parked.txt ]; then
  echo "fixer: no parked PRs — skipping drain phase"
else
  echo "fixer: draining $(wc -l < .codegraph/fixer/parked.txt) parked PR(s):"
  cat .codegraph/fixer/parked.txt
fi
```

Each pass does three things, in order:

1. **Sweep.** Invoke `/sweep` once. It processes every open PR in parallel: resolves conflicts, fixes CI, mines the Greptile summary as well as inline comments, addresses and replies to all reviewer feedback, and re-triggers reviewers. Do not re-derive that procedure here.
2. **Resolve.** For any parked PR still reporting `mergeable != MERGEABLE`, invoke `/resolve <pr>` on it individually. `/resolve` reads both sides' intent before choosing, and stops rather than guessing on genuinely ambiguous conflicts.
3. **Merge the lowest-numbered ready PR first**, then re-evaluate. Merging lowest-first matches the requested order and keeps the catch-up cost predictable. **Immediately remove that PR's number from `parked.txt` AND flip its `state.json` entry from `parked` to `merged`** — the `parked.txt` removal is what makes the progress check below meaningful (without it, the file never shrinks and every pass looks stalled even when merges are happening); the `state.json` update is what keeps Phase 5's final report honest (without it, a PR merged here still reads as `parked` there, undercounting merged issues and reporting completed work as unfinished):
   ```bash
   mkdir -p .codegraph/fixer
   # MERGED_PR is the PR number just merged in this step
   # grep -v's exit status reports whether any line PASSED the inverted filter, not whether
   # the redirect succeeded — when $MERGED_PR is the ONLY entry in parked.txt, every line is
   # excluded, zero lines are written, and grep exits 1 even though parked.txt.tmp was
   # created correctly (empty, as desired). A chained `&& mv` would then never run on
   # exactly the case that matters most (draining the last parked PR), silently leaving the
   # just-merged PR's number in parked.txt forever. `|| true` decouples the mv from grep's
   # match-count exit code so the empty-result case moves the file same as any other.
   grep -vxF "$MERGED_PR" .codegraph/fixer/parked.txt > .codegraph/fixer/parked.txt.tmp || true
   mv .codegraph/fixer/parked.txt.tmp .codegraph/fixer/parked.txt
   echo "fixer: removed merged PR #$MERGED_PR from parked.txt — $(wc -l < .codegraph/fixer/parked.txt) remaining"

   # Reconcile state.json: the issue tied to this PR was recorded as "parked" back when it
   # first hit the convergence-round cap (2f/2g) — that record is now stale the moment this
   # merge succeeds. Match on .pr rather than .issue since that is the field this drain loop
   # actually has in hand.
   TMP_STATE=$(mktemp "${TMPDIR:-/tmp}/fixer-state.XXXXXXXXXX")
   trap 'rm -f "$TMP_STATE"' EXIT
   jq --argjson pr "$MERGED_PR" \
     '.issues |= map(if .pr == $pr then .status = "merged" else . end)' \
     .codegraph/fixer/state.json > "$TMP_STATE" && mv "$TMP_STATE" .codegraph/fixer/state.json
   trap - EXIT
   echo "fixer: state.json entry for PR #$MERGED_PR updated parked -> merged"
   ```

**After each pass**, record whether it made progress and decide whether to run another one:

```bash
mkdir -p .codegraph/fixer
# 2>/dev/null: expected to be absent before drain's first pass
PARKED_BEFORE=$(cat .codegraph/fixer/drain-parked-count 2>/dev/null || wc -l < .codegraph/fixer/parked.txt)
PARKED_AFTER=$(wc -l < .codegraph/fixer/parked.txt)
DRAIN_PASS=$(( $(cat .codegraph/fixer/drain-pass 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$DRAIN_PASS" > .codegraph/fixer/drain-pass

if [ "$PARKED_AFTER" -eq 0 ]; then
  echo "fixer: all parked PRs merged after $DRAIN_PASS pass(es)"
  rm -f .codegraph/fixer/drain-pass .codegraph/fixer/drain-stall .codegraph/fixer/drain-parked-count
elif [ "$PARKED_AFTER" -lt "$PARKED_BEFORE" ]; then
  echo "fixer: pass $DRAIN_PASS merged $((PARKED_BEFORE - PARKED_AFTER)) PR(s) — progress, resetting drain-stall"
  printf '%s\n' 0 > .codegraph/fixer/drain-stall
else
  # 2>/dev/null: expected to be absent before the first stalled pass
  DRAIN_STALL=$(( $(cat .codegraph/fixer/drain-stall 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$DRAIN_STALL" > .codegraph/fixer/drain-stall
  echo "fixer: pass $DRAIN_PASS merged nothing (drain-stall $DRAIN_STALL/3)"
fi
printf '%s\n' "$PARKED_AFTER" > .codegraph/fixer/drain-parked-count

DRAIN_STALL=$(cat .codegraph/fixer/drain-stall 2>/dev/null || echo 0)
if [ "$PARKED_AFTER" -gt 0 ] && { [ "$DRAIN_STALL" -ge 3 ] || [ "$DRAIN_PASS" -ge 15 ]; }; then
  echo "fixer: stopping drain — $([ "$DRAIN_STALL" -ge 3 ] && echo "3 consecutive passes with no merges (blocked)" || echo "15-pass safety cap reached"). $PARKED_AFTER PR(s) remain: report each as needing human review."
elif [ "$PARKED_AFTER" -gt 0 ]; then
  echo "fixer: running another pass ($((DRAIN_PASS + 1)))"
fi
```

### The catch-up merge, and the check that protects solved work (invariant I4)

Because `strict: true` requires every PR to contain `origin/main`, each merge in this phase leaves the remaining parked branches stale. This is the one place in /fixer where catch-up merges happen, and therefore the one place where already-solved work can be silently dropped. Git can keep the wrong side in a non-conflicting region of a file — even in a file with no conflict markers at all — so a clean-looking merge is not evidence that nothing was lost.

Record the PR's authored lines **before** merging `main` in, then assert they survived:

```bash
mkdir -p .codegraph/fixer
REPO=$(cat .codegraph/fixer/repo)
# PR is the parked PR being updated; set it from the current drain iteration
PR=$(head -1 .codegraph/fixer/parked.txt)

gh pr checkout "$PR" --repo "$REPO" || { echo "ERROR: could not check out PR #$PR"; exit 1; }
git fetch origin main || { echo "ERROR: git fetch failed"; exit 1; }

# Capture every line this PR authored, relative to its own merge base, BEFORE touching
# main. Each line is recorded together with the file it came from and how many times it
# was added in that file (tab-separated: file, count, line) — checking a line's exact
# occurrence count within that specific file, not just file-scoped presence, is what the
# later check needs to catch a line dropped from file A while identical or containing
# text happens to survive in file B (I4 must preserve line identity), AND to catch one
# dropped copy of a line the PR added twice in the SAME file (I4 must preserve
# multiplicity too — `sort -u` would otherwise collapse both copies to one baseline entry
# that the surviving copy alone would satisfy).
BASE=$(git merge-base origin/main HEAD)
git diff "$BASE" HEAD --name-only > .codegraph/fixer/authored-files.txt

> .codegraph/fixer/authored-lines.tsv
while IFS= read -r F; do
  [ -z "$F" ] && continue
  git diff "$BASE" HEAD -- "$F" | grep -E '^\+[^+]' | sed -E 's/^\+//' | sed -E 's/^[[:space:]]+//' \
    | grep -vE '^$' | sort | uniq -c | while read -r COUNT L; do printf '%s\t%s\t%s\n' "$F" "$COUNT" "$L"; done
done < .codegraph/fixer/authored-files.txt >> .codegraph/fixer/authored-lines.tsv
echo "fixer: PR #$PR authored $(wc -l < .codegraph/fixer/authored-lines.tsv) distinct (file, line) pair(s) — recorded for the integrity check"
```

Merge `main` in — never rebase (I5) — and resolve any conflicts via `/resolve`, then verify:

```bash
mkdir -p .codegraph/fixer
# Merge main into the parked branch. A non-zero exit means conflicts, which is a
# signal to run /resolve rather than a failure of this skill.
if git merge origin/main -m "merge: bring branch up to date with main"; then
  echo "fixer: clean catch-up merge"
else
  echo "fixer: conflicts — run /resolve on this PR, then re-run this integrity check"
fi

# I4 integrity check: every line the PR authored must still exist, as a whole line and at
# its full original occurrence count, in the SAME file it was authored in. Checking
# per-file (rather than against a combined haystack of every changed file) is what
# prevents a dropped line in file A from being masked by identical or containing text
# that happens to survive in file B. Whole-line match (-x) is what prevents a REMOVED
# line from being masked by some other, longer line in that same file that merely
# contains its text as a substring — `grep -F` without `-x` would wrongly report that as
# still present. Comparing occurrence COUNTS (not just existence) is what catches one
# dropped copy of a line the PR added twice in the same file — an existence-only check
# would be satisfied by the single surviving copy. Leading whitespace is stripped from
# the file's lines before comparison to match how $LINE was normalised when it was
# recorded above. A file that no longer exists (legitimately renamed or deleted by main)
# is reported as a lost line below rather than treated as a grep error.
MISSING=0
while IFS=$'\t' read -r F COUNT LINE; do
  [ -z "$LINE" ] && continue
  if [ ! -f "$F" ]; then
    ACTUAL=0
  else
    ACTUAL=$(sed -E 's/^[[:space:]]+//' "$F" | grep -xcF -- "$LINE")
  fi
  if [ "$ACTUAL" -lt "$COUNT" ]; then
    echo "  LOST: [$F] expected $COUNT occurrence(s), found $ACTUAL: $LINE"
    MISSING=$((MISSING + 1))
  fi
done < .codegraph/fixer/authored-lines.tsv

if [ "$MISSING" -eq 0 ]; then
  echo "fixer: I4 PASS — all authored lines survived the catch-up merge"
else
  echo "ERROR: I4 FAIL — $MISSING authored line(s) vanished in the merge."
  echo "Restore each one or document why main legitimately superseded it. Do NOT push until this is resolved."
  exit 1
fi
```

A reported line is not automatically a bug — `main` may have legitimately superseded it. But every one must be individually explained or restored. Silently accepting a lost line is precisely the failure this skill exists to prevent.

After the integrity check passes, re-run local verification and push, then re-evaluate the five gate conditions from Phase: Solve and Merge Loop before merging.

**Exit condition:** Every PR listed in `parked.txt` is merged, or is reported as needing human review with a specific reason. No catch-up merge was pushed without a passing I4 integrity check. Drain stopped only once a pass merged nothing 3 times in a row, or the 15-pass safety cap was hit — never on a fixed pass count while merges were still happening.

---

## Phase 5 — Final Report

Report honestly, across **every batch this run processed** (Phase 3 loops back to Phase 1 as long as qualifying issues remain, so `state.json` may cover several batches, not just the last one). If something was skipped, left unmerged, bypassed, or split into a follow-up, say so explicitly.

```bash
mkdir -p .codegraph/fixer
MERGED=$(jq '[.issues[] | select(.status=="merged")] | length' .codegraph/fixer/state.json)
TOTAL=$(jq '.issues | length' .codegraph/fixer/state.json)
if [ "$TOTAL" -gt 0 ]; then
  PCT=$(( MERGED * 100 / TOTAL ))
else
  PCT=0  # no issues attempted — avoid dividing by zero
fi
BATCHES_DONE=$(cat .codegraph/fixer/batches-done 2>/dev/null || echo 1)
echo "fixer: $MERGED/$TOTAL issues merged (${PCT}%) across $BATCHES_DONE batch(es)"
jq -r '.issues[] | "  #\(.issue)  \(.status)  \(if .pr then "PR #\(.pr)" else "no PR" end)"' .codegraph/fixer/state.json
```

Output a summary table:

| Issue | PR | Branch | Status | CI | Greptile | Notes |
|-------|----|--------|--------|----|----------|-------|
| #N | #M | fix/issue-N | merged / parked / needs-human-review / abandoned | green / red | 5/5 | conflicts resolved, follow-ups filed, any check bypassed and why |

Also list, explicitly:
- every follow-up issue created during the run, with its number
- every check bypassed with `--admin`, with the diagnosis that justified it
- every issue that was split, with the follow-up covering the remainder
- anything left for a human, with the specific blocker

**Mark the run as reported.** As the last action of this phase, after the table and lists above have actually been produced — not before:

```bash
mkdir -p .codegraph/fixer
: > .codegraph/fixer/run-complete
```

This is what Phase 0's resume handling checks on the next invocation. Writing it any earlier (e.g. alongside the stall/cap counters in Phase: Drain Parked PRs) would reintroduce the exact race this file exists to close: a process stopping after a counter crosses its threshold but before this report ever reaches the human would otherwise look identical to a genuinely-reported run.

**Cleanup.** State lives in `.codegraph/fixer/`. It is left on disk after this run finishes, but Phase 0's resume handling already treats a completed run's artifacts as stale on the *next* invocation — an empty `queue.json`, together with a `parked.txt` that is either empty or accompanied by `run-complete`, means the next `/fixer` call starts genuinely fresh, not "resuming" this run's results. The only thing left on disk that matters afterward is `state.json` as a historical record of what this run did; `rm -rf .codegraph/fixer` removes it entirely if you don't want even that.

**Exit condition:** The user has a per-issue table covering every batch this run processed, the merged count, the batch count, every follow-up issue number, every bypass with its justification, and an explicit list of anything unfinished (including a resume command if the 15-batch safety cap was hit); `run-complete` has been written after that report was produced.

---

## Artifacts

All state is under `.codegraph/fixer/`:

| File | Format | Purpose |
|------|--------|---------|
| `repo` | text | `owner/name` slug — the only repo this run ever touches |
| `count`, `author`, `start-from`, `once`, `dry-run` | text | parsed arguments |
| `test-cmd`, `lint-cmd` | text | detected package-manager commands |
| `queue.json` | JSON array of `{issue, title}` | current batch's remaining work, ascending; entries are shifted off as they complete. **A present-but-empty `queue.json` means the batch loop fully completed** — Phase 0 uses this, together with `parked.txt` and `run-complete`, to decide fresh-run vs. resume |
| `state.json` | `{"issues":[{issue, status, pr}]}` | per-issue outcome, accumulated across every batch this run has processed; reset to empty whenever Phase 0 detects a fresh run |
| `parked.txt` | newline-separated PR numbers | accumulated across every batch; input to Phase: Drain Parked PRs; a merged PR's number is removed from this file the moment it merges. **Only ever emptied, never deleted, by a fully-merged drain** — Phase 0 treats a non-empty `parked.txt` as evidence of a resumable (mid-drain) run only if `run-complete` is absent; once Phase: Final Report has actually run and written it, the remaining entries are a closed, already-reported matter, not a resume signal |
| `run-complete` | empty marker file | touched by Phase: Final Report as its last action, strictly after the report has been produced — the sole authoritative "this run's outcome was reported" signal Phase 0 checks, deliberately decoupled from `drain-stall`/`drain-pass` (which get written mid-Phase-4 and would otherwise race against the report actually happening); reset (removed) whenever Phase 0 starts a genuinely fresh run |
| `batches-done` | text | count of batches completed this run; read by Phase 3 and the final report; reset on a fresh run |
| `loop-decision` | text | `loop`/`stop` — Phase 3's verdict on whether to start another batch |
| `current-pr`, `last-pr-url`, `gate-fail` | text | current iteration's scratch state |
| `outcome` | text | `abandoned`/`merged`/`parked` for the issue in progress; read by 2g, cleared after recording |
| `round` | text | convergence-round counter for the current PR; cleared once it merges or parks |
| `gate-signature`, `prev-gate-signature` | text | fingerprint of this round's / the previous round's gate state (score, a hash of the full Greptile review text, which specific comments are unanswered, branch ancestry, mergeability, each non-green check's name plus its completion timestamp, and the current commit SHA), used to detect a stalled (blocked) PR rather than counting rounds |
| `stall-count` | text | consecutive convergence rounds with an unchanged gate signature; park threshold is 3 |
| `drain-pass`, `drain-stall`, `drain-parked-count` | text | drain-phase pass counter, consecutive no-merge passes, and `parked.txt` length as of the last pass — the same stall-detection pattern applied to draining. Purely internal to Phase: Drain Parked PRs' own loop control; Phase 0 does not read these to decide fresh-vs-resume (see `run-complete`) since they get written mid-phase and would race against Phase: Final Report actually running |
| `authored-lines.tsv`, `authored-files.txt` | text | I4 integrity-check baseline (tab-separated `file<TAB>count<TAB>line`) |

---

## Examples

- `/fixer` — work through every open issue by `carlos-alm`, 10 at a time, looping across batches until none remain (or the 15-batch safety cap is hit).
- `/fixer 3` — same, but 3 issues per batch. Good for a first run to confirm the loop behaves before letting it run unattended.
- `/fixer 3 --once` — process exactly 3 issues and stop, even if more are open. Use this to sanity-check a single batch.
- `/fixer --dry-run` — print the queue and the plan for one batch of 10 without creating a branch, commit, PR, or merge (dry runs never loop past one batch).
- `/fixer 5 --start-from 1900` — starting at #1900, work 5 issues per batch until the backlog above that point is drained.
- `/fixer --author someone-else` — run against another author's issues instead of the default.
- If there are no open issues matching `--author` (and not `blocked`), /fixer reports that plainly and exits — it does not search other repos or invent work.

---

## Rules

- **One branch per issue, always cut from a freshly fetched `origin/main` (I1).** Never reuse a branch across issues. Never stack a branch on another issue's branch — `deleteBranchOnMerge` is enabled, so merging a base PR closes its stacked PRs.
- **Merge the current PR before cutting the next branch (I2, I3).** Never open the next issue's PR while the previous one is still open and mergeable. Only a parked PR may remain open.
- **Never rebase (I5).** Always `git merge origin/main`. The ruleset forbids non-fast-forward pushes to `main` and the repo disables rebase-merge.
- **Never push a catch-up merge without a passing I4 integrity check.** Every line the PR authored must still exist, or its absence must be individually documented. A clean merge with no conflict markers is not evidence that nothing was lost.
- **Never `git stash`.** The stash stack is shared with the main checkout and every other worktree. Use commits.
- **Never `git add .` or `git add -A`.** Stage only files you changed, by explicit path.
- **Never force-push** except to fix a commit message rejected by commitlint, via `git commit --amend` + `git push --force-with-lease`. Everything else gets a new commit.
- **`--admin` covers the missing approval only.** Never merge past a check that is red because of this PR's own changes. A check may be bypassed only after reading its logs, establishing the failure is unrelated to the diff, and recording that diagnosis in the final report.
- **Rerun the `Pre-publish benchmark gate` once** before treating its failure as a real regression — it is known to fail intermittently by a thin margin on unrelated PRs.
- **All five gate conditions must hold before a merge:** Greptile 5/5, every comment addressed and replied to, up to date with `main`, no conflicts, all six required checks green.
- **Mine the Greptile summary, not just inline comments.** A score below 5/5 always names at least one gap in prose, and those gaps frequently have no inline comment.
- **Never defer without tracking.** Out-of-scope findings become GitHub issues via `gh issue create` immediately, and the issue number goes in the reply.
- **PR bodies use `Closes #N`**, never a bare `(#N)` — the closing keyword is what auto-closes the issue on merge.
- **Branch names must match** `^(feat|fix|docs|refactor|test|chore|ci|perf|build|release|dependabot|revert)/`; commits must be Conventional Commits with a header ≤ 100 characters.
- **Never silently skip verification.** If lint, tests, or a build cannot run or fail for any reason, stop and report to the user. Do not decide on their behalf to proceed.
- **Never document a bug as expected behaviour.** Engine divergence is a bug in the less accurate engine — fix the root cause.
- **Park when blocked, not on a fixed round count (I6).** Keep converging as long as each round changes the gate signature — a comment answered, a check going green, the Greptile score moving. Park only after 3 consecutive rounds with zero measurable change (genuinely blocked), or the 15-round absolute safety cap. Then move to the next issue; Phase: Drain Parked PRs handles it.
- **Bounded loops only, but bounded by progress, not by an arbitrary count where it matters.** Convergence rounds and drain passes are both capped by stall detection (3 consecutive rounds/passes with zero measurable progress) with a 15-round / 15-pass safety backstop; the whole run is capped at 15 batches. Then report for human review or resume.
- **The run's objective is the whole backlog, not one batch.** By default, keep starting new batches (Phase 3) until no qualifying open issues remain or the 15-batch cap is hit. Pass `--once` to process exactly one batch and stop.
- **Only ever act on the repo detected in Phase 0.** Never search, open issues on, or open PRs against any other repository — including when this repo's queue comes up empty. Read the slug from `.codegraph/fixer/repo`; never hardcode it (see issue #2164).
- **An empty queue is success, not failure.** If Phase 1 finds no qualifying open issues, report that plainly and exit 0 — never search other repos, never lower the `--author`/`blocked`-label bar to manufacture a queue, and never invent unrelated work (stale files, refactors, drive-by fixes) to fill a batch.
- **A completed run is not a resumable run — but neither is a drain that already gave up and reported.** Phase 0 resumes when `queue.json` is non-empty (a batch stopped mid-flight), OR `parked.txt` is non-empty AND `run-complete` is absent (draining stopped mid-flight — `queue.json` is legitimately already empty by the time Phase: Drain Parked PRs starts, so it alone cannot tell "draining in progress" apart from "run genuinely complete"). A `parked.txt` left behind by a drain that already reported — `run-complete` present — is a closed, already-reported matter, not a resume signal — treating it as one would make every future invocation skip Phase 1-3 forever and starve newly opened issues. Use `run-complete`, not `drain-stall`/`drain-pass`, for this check: those counters are written mid-Phase-4 and race against Phase: Final Report actually running, so a process stopping right after a counter crosses its threshold but before the report is produced would be misclassified as "already reported" by a counter-only check. Only when none of the resume conditions hold did the previous run finish, so only then is every run-scoped artifact (`batches-done`, `queue.json`, `parked.txt`, `drain-pass`, `drain-stall`, `run-complete`, `state.json`, per-issue scratch state) reset before starting — never let a finished run's counters leak into a new invocation and skip issues or hit the batch cap early, never let an interrupted drain be mistaken for a finished one and lose its still-parked PRs, and never let an already-reported blocked drain be mistaken for an interrupted one and lock out new work indefinitely.
- **No co-author lines** in commit messages or PR bodies.
- **No Claude Code or Anthropic references** in commits, PR bodies, comments, or issues.
- **Never trigger `@greptileai` until every Greptile comment has a reply.** Do not trigger Greptile for feedback that came from Claude or the user.
- **Report faithfully.** State what merged, what parked, what was bypassed and why, what was split, what needs a human, and how many batches the run took.
