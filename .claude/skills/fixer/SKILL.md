---
name: fixer
description: Solve the N lowest-numbered open issues end-to-end — one fresh branch per issue, PR, review convergence, and merge — then drain any stragglers in a final sweep phase
argument-hint: "[count] [--author <login>] [--start-from <issue>] [--dry-run]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Monitor, Agent
---

# /fixer — Solve, Ship, and Merge a Batch of Issues

Work the lowest-numbered open issues in this repository from open issue to merged PR, one at a time, until `count` issues (default 10) are done. Each issue gets its own branch cut from a freshly fetched `origin/main`, its own PR, its own review-convergence loop, and its own merge. Any PR that cannot be brought to a mergeable state inline is **parked** so the loop keeps moving, and Phase 4 drains all parked PRs with `/sweep` and `/resolve` until every one is merged or provably blocked.

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
| first bare integer | `COUNT` | `10` | How many issues to take to merged state |
| `--author <login>` | `AUTHOR` | `carlos-alm` | Only consider issues opened by this login |
| `--start-from <issue>` | `START_FROM` | none | Skip queue entries below this issue number (resume) |
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

printf '%s\n' "$COUNT"      > .codegraph/fixer/count
printf '%s\n' "$AUTHOR"     > .codegraph/fixer/author
printf '%s\n' "$START_FROM" > .codegraph/fixer/start-from
printf '%s\n' "$DRY_RUN"    > .codegraph/fixer/dry-run
echo "fixer: count=$COUNT author=$AUTHOR start-from=$START_FROM dry-run=$DRY_RUN"
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

**Resume handling.** If `.codegraph/fixer/state.json` already exists, this is a resumed run: report the previous outcome and continue from the first issue not marked `merged`. Otherwise initialise it.

```bash
mkdir -p .codegraph/fixer
if [ -f .codegraph/fixer/state.json ]; then
  echo "fixer: resuming — previous state:"
  jq -r '.issues[] | "  #\(.issue)  \(.status)  \(if .pr then "PR #\(.pr)" else "no PR" end)"' .codegraph/fixer/state.json
else
  printf '%s\n' '{"issues":[]}' > .codegraph/fixer/state.json
  echo "fixer: fresh run — state initialised"
fi
```

**Exit condition:** `git`, `gh`, `jq`, `mktemp` present; inside a git repo; `gh` authenticated; no in-progress merge; repo slug, test command, and lint command persisted to `.codegraph/fixer/`; arguments parsed and persisted; worktree isolation confirmed or requested; `state.json` exists.

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
  gh issue list --state open --limit 400 \
    --json number,title,labels,author \
    --jq "[.[] | select(.author.login==\"$AUTHOR\")
             | select([.labels[].name] | index(\"blocked\") | not)
             | {issue: .number, title: .title}]
          | sort_by(.issue)
          | map(select(.issue >= ($START_FROM|tonumber)))
          | .[0:($COUNT|tonumber)]" > .codegraph/fixer/queue.json || {
    echo "ERROR: failed to fetch issues from GitHub"; exit 1; }
fi

QUEUED=$(jq 'length' .codegraph/fixer/queue.json)
if [ "$QUEUED" -eq 0 ]; then
  echo "ERROR: no open issues by '$AUTHOR' at or above #$START_FROM — nothing to do"
  exit 1
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
  TERMINAL=$(jq --argjson issue "$HEAD_ISSUE" \
    '[.issues[] | select(.issue == $issue) | select(.status=="merged" or .status=="parked" or .status=="abandoned")] | length' \
    .codegraph/fixer/state.json)
  [ "$TERMINAL" -eq 0 ] && break
  echo "fixer: issue #$HEAD_ISSUE already resolved in state.json — dropping stale queue head (resume safety)"
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

If the issue turns out to be already fixed, invalid, or a duplicate, do not invent work. Close it with an explanatory comment, record status `abandoned`, and move to the next queue entry.

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

A PR merges only when **all five** gate conditions hold. Evaluate them together; if any is false, fix that specific condition and re-evaluate. Cap at **3 convergence rounds** — beyond that, park the PR and move on (I6).

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

For Greptile's review to arrive, use the `Monitor` tool to poll the comments endpoint until a `Confidence Score` appears (load it with `ToolSearch` if its schema is not present). Do not use foreground `sleep`.

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

# --- G2: every Greptile inline comment has a reply from us ---
ALL_COMMENTS=$(gh api "repos/$REPO/pulls/$PR/comments" --paginate)
UNANSWERED=0
for CID in $(printf '%s\n' "$ALL_COMMENTS" | jq -r '[.[] | select(.user.login|test("greptile";"i")) | select(.in_reply_to_id == null)] | .[].id'); do
  REPLIES=$(printf '%s\n' "$ALL_COMMENTS" | jq -s "[.[][] | select(.in_reply_to_id == $CID) | select(.user.login|test(\"greptile\";\"i\") | not)] | length")
  [ "$REPLIES" -eq 0 ] && UNANSWERED=$((UNANSWERED + 1))
done
if [ "$UNANSWERED" -eq 0 ]; then
  echo "G2 PASS: no unanswered reviewer comments"
else
  echo "G2 FAIL: $UNANSWERED unanswered Greptile comment(s)"; GATE_FAIL=1
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

printf '%s\n' "$GATE_FAIL" > .codegraph/fixer/gate-fail
[ "$GATE_FAIL" -eq 0 ] && echo "fixer: PR #$PR passes all five gate conditions" || echo "fixer: PR #$PR is not mergeable yet"
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

if [ "$GATE_FAIL" -ne 0 ]; then
  echo "fixer: gate not satisfied — fix the failing condition or park PR #$PR. Not merging."
elif [ "$DRY_RUN" = "true" ]; then
  echo "[DRY RUN] Would merge PR #$PR with --squash --admin"
else
  gh pr merge "$PR" --repo "$REPO" --squash --admin --delete-branch || {
    echo "ERROR: merge of PR #$PR failed — read the error above; do not retry blindly"; exit 1; }
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
# Set STATUS to merged | parked | abandoned, and PR to the PR number (or "null" when none was opened)
STATUS="merged"
PR=$(cat .codegraph/fixer/current-pr)
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
rm -f .codegraph/fixer/current-pr .codegraph/fixer/gate-fail

echo "fixer: issue #$ISSUE recorded as $STATUS; $(jq 'length' .codegraph/fixer/queue.json) remaining"
```

Loop back to step 2a for the next queue entry. **Only after the current PR is merged or parked** — that ordering is I2.

**Exit condition:** Every queue entry has a `state.json` record with status `merged`, `parked`, or `abandoned`; `queue.json` is an empty array. Every merged PR satisfied all five gate conditions. No branch was reused and no branch was stacked on another issue's branch.

---

## Phase 3 — Drain Parked PRs

Skip this phase entirely if `.codegraph/fixer/parked.txt` is absent or empty — on a clean run, Phase: Solve and Merge Loop merges everything inline and there is nothing to drain.

This is the mode switch: stop solving new issues, and work the parked PRs as a set until each is merged or provably blocked. Run at most **3 passes**; report anything still unmerged afterwards as needing human review rather than looping forever.

```bash
mkdir -p .codegraph/fixer
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
3. **Merge the lowest-numbered ready PR first**, then re-evaluate. Merging lowest-first matches the requested order and keeps the catch-up cost predictable.

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

# Capture every line this PR authored, relative to its own merge base, BEFORE touching main
BASE=$(git merge-base origin/main HEAD)
git diff "$BASE" HEAD | grep -E '^\+[^+]' | sed -E 's/^\+//' | sed -E 's/^[[:space:]]+//' \
  | grep -vE '^$' | sort -u > .codegraph/fixer/authored-lines.txt
echo "fixer: PR #$PR authored $(wc -l < .codegraph/fixer/authored-lines.txt) distinct line(s) — recorded for the integrity check"

git diff "$BASE" HEAD --name-only > .codegraph/fixer/authored-files.txt
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

# I4 integrity check: every line the PR authored must still exist in the working tree.
# Build the haystack once instead of grepping per line, and skip authored paths that no
# longer exist — main may have legitimately renamed or deleted a file, which is expected
# and is reported as a lost line below rather than as a grep error.
# Trailing X's: see the note in Phase: Solve and Merge Loop — a suffix breaks BSD mktemp
HAYSTACK=$(mktemp "${TMPDIR:-/tmp}/fixer-haystack.XXXXXXXXXX")
trap 'rm -f "$HAYSTACK"' EXIT
while IFS= read -r F; do
  [ -f "$F" ] && cat "$F" >> "$HAYSTACK"
done < .codegraph/fixer/authored-files.txt

MISSING=0
while IFS= read -r LINE; do
  [ -z "$LINE" ] && continue
  if ! grep -qF -- "$LINE" "$HAYSTACK"; then
    echo "  LOST: $LINE"
    MISSING=$((MISSING + 1))
  fi
done < .codegraph/fixer/authored-lines.txt
rm -f "$HAYSTACK"
trap - EXIT

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

**Exit condition:** Every PR listed in `parked.txt` is merged, or is reported as needing human review with a specific reason. No catch-up merge was pushed without a passing I4 integrity check. At most 3 drain passes were run.

---

## Phase 4 — Final Report

Report honestly. If something was skipped, left unmerged, bypassed, or split into a follow-up, say so explicitly.

```bash
mkdir -p .codegraph/fixer
MERGED=$(jq '[.issues[] | select(.status=="merged")] | length' .codegraph/fixer/state.json)
TOTAL=$(jq '.issues | length' .codegraph/fixer/state.json)
if [ "$TOTAL" -gt 0 ]; then
  PCT=$(( MERGED * 100 / TOTAL ))
else
  PCT=0  # no issues attempted — avoid dividing by zero
fi
echo "fixer: $MERGED/$TOTAL issues merged (${PCT}%)"
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

**Cleanup.** State lives in `.codegraph/fixer/`. It is deliberately kept after a successful run so a later `/fixer` can report on it and so a crashed run can resume. Remove it with `rm -rf .codegraph/fixer` to force a completely fresh batch.

**Exit condition:** The user has a per-issue table, the merged count, every follow-up issue number, every bypass with its justification, and an explicit list of anything unfinished.

---

## Artifacts

All state is under `.codegraph/fixer/`:

| File | Format | Purpose |
|------|--------|---------|
| `repo` | text | `owner/name` slug |
| `count`, `author`, `start-from`, `dry-run` | text | parsed arguments |
| `test-cmd`, `lint-cmd` | text | detected package-manager commands |
| `queue.json` | JSON array of `{issue, title}` | remaining work, ascending; entries are shifted off as they complete |
| `state.json` | `{"issues":[{issue, status, pr}]}` | per-issue outcome; drives resume |
| `parked.txt` | newline-separated PR numbers | input to Phase: Drain Parked PRs |
| `current-pr`, `last-pr-url`, `gate-fail` | text | current iteration's scratch state |
| `authored-lines.txt`, `authored-files.txt` | text | I4 integrity-check baseline |

---

## Examples

- `/fixer` — take the 10 lowest-numbered open issues by `carlos-alm` to merged, one at a time.
- `/fixer 3` — same, but only the 3 lowest-numbered issues. Good for a first run to confirm the loop behaves.
- `/fixer --dry-run` — print the queue and the plan for all 10 without creating a branch, commit, PR, or merge.
- `/fixer 5 --start-from 1900` — the 5 lowest-numbered open issues at or above #1900.
- `/fixer --author someone-else` — run the batch against another author's issues.

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
- **Park, don't stall (I6).** After 3 convergence rounds, park the PR and move to the next issue. Phase: Drain Parked PRs handles it.
- **Bounded loops only.** 3 convergence rounds per PR, 3 drain passes. Then report for human review.
- **No co-author lines** in commit messages or PR bodies.
- **No Claude Code or Anthropic references** in commits, PR bodies, comments, or issues.
- **Never trigger `@greptileai` until every Greptile comment has a reply.** Do not trigger Greptile for feedback that came from Claude or the user.
- **Report faithfully.** State what merged, what parked, what was bypassed and why, what was split, and what needs a human.
