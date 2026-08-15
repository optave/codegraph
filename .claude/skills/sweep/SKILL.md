---
name: sweep
description: Check all open PRs, resolve conflicts, update branches, address Claude and Greptile review concerns, fix CI failures, and retrigger reviewers until clean
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# PR Review Sweep

You are performing a full review sweep across all open PRs in this repository. Your goal is to bring every PR to a clean, mergeable state: no conflicts, CI passing, all reviewer comments addressed, and reviewers re-triggered until satisfied.

---

## Step 0: Worktree Isolation

Before doing anything else, run `/worktree` to get an isolated copy of the repo. CLAUDE.md mandates that every session starts with `/worktree` to prevent cross-session interference. All subsequent steps run inside the worktree.

---

## Step 1: Discover Open PRs

Detect the repo slug dynamically so this skill works in any fork or renamed org — never hardcode it:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null \
  || git remote get-url origin 2>/dev/null \
     | sed -nE 's#^(git@github\.com:|https://github\.com/)([^/]+/[^/]+)/?$#\2#p' \
     | sed -E 's/\.git$//')
if [ -z "$REPO" ]; then
  echo "ERROR: could not detect GitHub repo slug — ensure 'gh' is authenticated or 'origin' points to GitHub"
  exit 1
fi
echo "Detected repo: $REPO"

gh pr list --repo "$REPO" --state open --json number,title,headRefName,baseRefName,mergeable,statusCheckRollup,reviewDecision --limit 50
```

Record each PR's number, branch, base, merge status, and CI state.

---

## Step 2: Launch Parallel Subagents

Each PR is independent work — **launch one Agent subagent per PR, all in parallel.** Use `isolation: "worktree"` so each agent gets its own copy of the repo with no cross-PR contamination.

Pass each agent the full PR processing instructions (Steps 2a–2i below) along with the PR number, branch, base, current state from Step 1, and the **`$REPO` slug detected in Step 1**. Every `<repo>` placeholder in the instructions below and in every `gh`/`gh api` command must be substituted with that literal detected value before handing the prompt to the agent — never let a subagent fall back to a hardcoded or guessed repo name. The agent prompt must include **all** the rules from the Rules section at the bottom of this skill — copy them **verbatim**, do not paraphrase or summarize.

```
For each PR, launch an Agent with:
- description: "Review PR #<number>"
- isolation: "worktree"
- prompt: <the full PR processing instructions below, with PR details filled in>
```

Launch **all** PR agents in a single message (one tool call per PR) so they run concurrently. Do NOT wait for one to finish before starting the next.

Each agent will return a result summary. Collect all results for the final summary table in Step 3.

### If a subagent pauses instead of finishing

A subagent may end its turn with text like "I'll wait for X to finish" or "pausing until Y completes" instead of actually finishing. (The "Before you start: how to wait" instruction given to every subagent exists to prevent exactly this, but it can still happen, especially across long sessions.) A common variant is the agent claiming it started a "background poller," "monitor," or "scheduled job" that "will notify me" or "remains armed" — this is never true; treat it exactly like any other stall. If it does:

- Resume it with `SendMessage`, explicitly instructing it to poll to a real terminal result in a continuous sequence of tool calls rather than end its turn again.
- **Do not substitute your own point-in-time `gh` check for the subagent's job and tell it "you're done, report ready."** PR state under active review changes in minutes — a check you ran even a few minutes ago can already be stale by the time you relay it, and a stale "confirmed done" from you is how a real reviewer finding gets missed. If you check state directly to unblock a stalled agent, pass it along only as a data point ("as of my check just now, X") and instruct the agent to do its own final live re-verification (Step 2h.1) before reporting — never hand it a final verdict to just relay verbatim.
- **A stall can recur 2–3 times on the same subagent before it sticks.** Each time, the agent may invent a different flavor of "something external will resume me" (a background CI poll, a Monitor task, a scheduled re-check). Don't be surprised if the first or second resume doesn't fix it — resume again with the same correction, stated more explicitly, rather than assuming one nudge is enough or escalating to giving up on the PR.
- **If the agent reports a GitHub API rate-limit exhaustion**, that part can be genuinely true (all subagents in a sweep share one authenticated identity's quota) even when the "something will notify me" framing around it is not. Verify it yourself with `gh api rate_limit --jq '.resources.core'` (this check is free — it does not count against the quota), pass along the live `remaining`/`reset` numbers as a data point, and instruct the agent to bridge the wait itself with bounded sleep-then-recheck cycles (see "Mind the GitHub API rate limit" below) rather than any open-ended "wait for notification."

---

## PR Processing Instructions (for each subagent)

The following steps are executed by each subagent for its assigned PR.

### Before you start: how to wait (read this first)

Several steps below require waiting on something external — CI runs, `npm test`, or a reviewer's response. **You are a background subagent: nothing wakes you up automatically when a shell job, CI run, or reviewer response finishes on its own.** If you end your turn with text like "I'll wait for X to finish" or "pausing until Y completes" and make no further tool call, you simply stop — no process resumes you, and the sweep stalls silently, sometimes for hours, until a human notices and manually re-prompts you.

**Rule: never end your turn to wait. Poll instead, in a continuous sequence of tool calls, until you have a concrete terminal result (pass/fail, complete/incomplete) in hand.** Concretely:

- For a long-running command (`npm test`, `npm install`), either run it in the foreground with a long timeout (up to 600000ms), or start it in the background and poll for completion (`ps`, checking for its output, or a bash `while` loop with `sleep`) across multiple Bash calls without ending your turn in between.
- For CI (`gh pr checks <number>`), poll on an interval (e.g. every 60–120s) inside a bash loop or a sequence of Bash calls — native builds and full test matrices can take 15–20+ minutes, so don't give up early, but also don't stop after one check and declare victory.
- For a reviewer response (Greptile/Claude), a real review typically posts within minutes but can take 15–30+ minutes. Poll for new comments on an interval rather than checking once and assuming silence means "satisfied."
- Only stop polling once you have an actual terminal state: a check conclusion, a test exit code, or (for reviews) either a new comment/reaction or enough elapsed real time that you're confident nothing more is coming.

**Do not invent a mechanism that will "notify" you.** Starting a background shell command (`run_in_background`), a watcher, or a "monitor" of your own does not resume your turn when it fires — nothing does that except your own next tool call. Do not write, or act on the belief that, a background job/poller/monitor "is running and will notify me," "remains armed," or "I'll pick this back up when re-prompted" — every one of those beliefs is false for you specifically, no matter which tool produced it. If you catch yourself about to write words like that, make another tool call instead (even a no-op status check), and keep the polling loop going yourself.

### Mind the GitHub API rate limit

All subagents in this sweep — and any other concurrent session — share one authenticated `gh` identity's rate limit (5000 REST requests/hour). Polling too tightly, or re-fetching every endpoint on every cycle, can exhaust it and stall the whole sweep, not just your PR.

- `gh api rate_limit --jq '.resources.core'` does **not** count against the quota — check it freely, including proactively if you notice you're polling a lot.
- Don't poll CI or comments tighter than the 60–120s interval above, even under pressure to finish. Batch each check (one `gh pr checks` call covers every check name; one pass over the three comment endpoints covers every reviewer) rather than looping per-item.
- If a `gh` call fails with `API rate limit exceeded` (or `remaining` reads `0`), there is no way around the wait — you must bridge it, not skip it or assume someone else will. Do this with your own tool calls, never by ending your turn:
  1. Note the `reset` value (a unix epoch) from `gh api rate_limit`.
  2. Sleep a bounded chunk safely under your per-call timeout (e.g. `sleep 300`), then re-check `gh api rate_limit` (free) for `remaining`/`reset`.
  3. Repeat step 2 across consecutive tool calls — not one giant sleep — until `remaining > 0` or the current time has passed `reset`.
  4. Once capacity returns, treat anything you gathered right before the exhaustion as stale — re-run Step 2c and Step 2d/2d.1 fresh before continuing, per the usual "never declare ready from a stale check" rule.

### 2a. Check out the PR head (detached)

A full sweep runs one subagent per PR in parallel, so **never** run a bare `gh pr checkout <number>`: it claims the head branch *name*, and a branch can be checked out in exactly **one** worktree. If a concurrent agent — or a leftover worktree that was never collected — already holds it, the checkout aborts outright:

```text
fatal: 'fix/some-branch' is already checked out at '.claude/worktrees/wf_40037ee4-070-1'
```

Check out **detached** instead. A detached HEAD claims no branch name, so it can never collide; push by refspec at the end. Do **not** work around a collision by inventing a local branch name of your own.

```bash
oid=$(gh pr view <number> --json headRefOid -q .headRefOid)
gh pr checkout <number> --detach
# Fail closed if HEAD is not the PR head (stale fetch, or the head moved as you started).
[ "$(git rev-parse HEAD)" = "$oid" ] || { echo "ABORT: HEAD is not PR <number>'s head"; exit 1; }
```

**Do not carry the branch name in a shell variable across steps.** Each Bash tool call may run in a fresh shell — variables set in one call do not survive into the next. A `head=...` captured here is gone by the time a later step pushes, silently expanding `git push origin "HEAD:$head"` into the invalid refspec `HEAD:` and leaving your fixes unpushed with no error surfaced until you check the PR. Instead, **re-derive the branch name in the same Bash call as every push**:

```bash
git push origin "HEAD:$(gh pr view <number> --json headRefName -q .headRefName)"
```

This applies to every push in this skill, including the commitlint-amend exception:

```bash
git push --force-with-lease origin "HEAD:$(gh pr view <number> --json headRefName -q .headRefName)"
```

> Stale worktrees are the usual reason a name is taken. `bash .claude/scripts/gc-worktrees.sh` collects the finished ones; it never touches a worktree with uncommitted work.

### 2b. Resolve merge conflicts

Check if the PR has conflicts with its base branch:

```bash
gh pr view <number> --json mergeable --jq '.mergeable'
```

If `CONFLICTING`:

1. Merge the base branch into the head branch (never rebase):
   ```bash
   git merge origin/<base-branch>
   ```
2. **Do not assume which side to keep.** You must fully understand the context of both sides before resolving. If you don't know why a line was added — what feature it supports, what bug it fixes, what reviewer requested it — you cannot resolve the conflict correctly. Before touching any conflict:
   - Read the PR description and any linked issues (`gh pr view <number>`) to understand the PR's purpose and scope.
   - Check the PR's commit history (`git log --oneline origin/<base-branch>..HEAD -- <file>`) to understand *why* the conflicting line was changed on the PR side. Also check the base branch history (`git log --oneline HEAD..origin/<base-branch> -- <file>`) to understand *why* the base version exists.
   - Read Greptile and Claude review comments on the PR (`gh api repos/<repo>/pulls/<number>/comments`, `gh api repos/<repo>/pulls/<number>/reviews`, `gh api repos/<repo>/issues/<number>/comments`) — a reviewer may have requested the change that caused the conflict.
   - Check what landed on main that introduced the other side (`git log --oneline HEAD..origin/<base-branch> -- <file>`) and read those PR descriptions too if needed.
   - Compare the PR's diff against its merge base (`git diff $(git merge-base origin/<base-branch> HEAD) HEAD -- <file>`) to see which side introduced an intentional change vs. which side carried stale code.
   - Only then choose the correct resolution. If the PR deliberately changed a line and main still has the old version, keep the PR's version. If main introduced a fix or new feature the PR doesn't have, keep main's version. If both sides made intentional changes, merge them together manually.
3. After resolving, stage the resolved files by name (not `git add .`), commit with: `fix: resolve merge conflicts with <base-branch>`
4. **Verify nothing was lost from either side.** For every file that had conflicts, diff the merge result against both parent commits:
   ```bash
   # Check nothing was lost from the base branch (main)
   git diff origin/<base-branch> -- <file>
   # Check nothing was lost from the PR branch (ORIG_HEAD = pre-merge HEAD, set by git automatically)
   git diff ORIG_HEAD -- <file>
   ```
   Review each diff to confirm that intentional changes from both sides survived the merge. If content was dropped, amend the resolution before pushing.
5. Push the updated branch.

### 2c. Check CI status

```bash
gh pr checks <number>
```

If any checks are failing:

1. Read the failing check logs:
   ```bash
   gh run view <run-id> --log-failed
   ```
2. Diagnose the failure — read the relevant source files, understand the error.
3. Fix the issue in code.
4. Run tests locally to verify: `npm test`
5. Run lint locally: `npm run lint`
6. Commit the fix with a descriptive message: `fix: <what was broken and why>`
7. Push, then poll `gh pr checks <number>` on an interval until every check is COMPLETED — see "Before you start: how to wait" above. Do not end your turn between polls.
8. Repeat until CI is green.

### 2d. Gather all review comments

Fetch **all** review comments from both Claude and Greptile. You MUST check all three endpoints — Claude's feedback often appears in the `/reviews` and `/comments` endpoints, not just issue comments:

```bash
# PR review comments (inline code comments — Claude and Greptile both use these)
gh api repos/<repo>/pulls/<number>/comments --paginate --jq '.[] | {id: .id, user: .user.login, body: .body, path: .path, line: .line, created_at: .created_at}'

# PR reviews (top-level review bodies — Claude typically posts CHANGES_REQUESTED or COMMENT reviews here)
gh api repos/<repo>/pulls/<number>/reviews --paginate --jq '.[] | {id: .id, user: .user.login, body: .body, state: .state}'

# Issue-style comments (includes @greptileai trigger responses and general discussion)
gh api repos/<repo>/issues/<number>/comments --paginate --jq '.[] | {id: .id, user: .user.login, body: .body, created_at: .created_at}'
```

**Important:** Go through the results from ALL three endpoints. Build a complete list of actionable items from every reviewer before starting fixes. Do not skip any reviewer's comments.

### 2d.1 Mine the Greptile **summary** body — findings often have no inline comment

Greptile posts a top-level **summary** (a `### Greptile Summary` issue comment carrying a **`Confidence Score: N/5`** and a prose review; occasionally posted as a review body instead). That summary routinely raises **actionable findings that are NOT mirrored as inline review comments** — e.g. a "Safe to merge after addressing two gaps: First… Second…" paragraph, a per-row concern in the **Important Files Changed** table ("Two logic gaps: …"), or a "Note on …" caveat. A sweep that only iterates the inline comments from the gather step **silently misses these** — it is the single most common way a Greptile concern survives a sweep unaddressed.

So treat the summary as a **source of findings, not a single comment to reply to**. Pull it in full (never truncate — findings hide in the prose):

```bash
# Greptile summary as an issue comment (the usual location):
gh api repos/<repo>/issues/<number>/comments --paginate \
  --jq '.[] | select(.user.login|test("greptile";"i")) | .body'
# …and as a review body (Greptile sometimes posts the summary here instead):
gh api repos/<repo>/pulls/<number>/reviews --paginate \
  --jq '.[] | select(.user.login|test("greptile";"i")) | .body'
```

From that body, extract **every distinct finding** as its own actionable item:
- the **Confidence Score** and the sentence(s) that justify it — a score `< 5` always names at least one gap;
- every numbered / "First… Second…" gap in a "Safe to merge after…" paragraph;
- every concern in the **Important Files Changed** table;
- every "Note on…" / "Caveat…" / "mismatch" line (e.g. a PR-description-vs-implementation discrepancy).

For each finding, **check whether a matching inline comment exists**. If it does, you'll handle it in the address-comments step. **If it does NOT, it is still a real finding — add it to your actionable list and fix it** (or, if genuinely out of scope, file a tracked `follow-up` issue and reply). **Never assume the inline comments are the complete set** — reconcile your fixes against the summary before declaring the PR ready.

### 2e. Address every comment from EVERY reviewer

You must address comments from **all** reviewers — Claude (claude-code-review bot), Greptile, and any humans. Do not only address one reviewer's comments and skip another's. Process each reviewer's feedback systematically.

For **each** review comment — including minor suggestions, nits, style feedback, and optional improvements:

1. **Read the comment carefully.** Understand what the reviewer is asking for.
2. **Read the relevant code** at the file and line referenced.
3. **Make the change.** Even if the comment is marked as "nit" or "suggestion" or "minor" — address it. The goal is zero outstanding comments.
4. **If you disagree** with a suggestion (e.g., it would introduce a bug or contradicts project conventions), do NOT silently ignore it. Reply to the comment explaining why you chose a different approach.
5. **If the fix is genuinely out of scope** for this PR, you MUST create a GitHub issue to track it before replying. Never reply with "acknowledged as follow-up" or "noted for later" without a tracked issue — untracked deferrals get lost and nobody will ever revisit them. "Genuinely out of scope" means the fix touches a different module not in the PR's diff, requires an architectural decision beyond the PR's mandate, or would introduce unrelated risk. Fixing a variable name, adding a null check, or adjusting a string in a file already in the diff is NOT out of scope — just do it.

   ```bash
   # Ensure the follow-up label exists (safe to re-run)
   gh label create "follow-up" --color "0e8a16" --description "Deferred from PR review" --repo <repo> 2>/dev/null || true

   # Create a tracking issue for the deferred item and capture the issue number
   issue_url=$(gh issue create \
     --repo <repo> \
     --title "follow-up: <concise description of what needs to be done>" \
     --body "$(cat <<-'EOF'
	Deferred from PR #<number> review.

	**Original reviewer comment:** <use the correct permalink format for the comment type: inline review comment → `https://github.com/optave/ops-codegraph-tool/pull/<number>#discussion_r<comment-id>`, top-level review body → `https://github.com/optave/ops-codegraph-tool/pull/<number>#pullrequestreview-<review-id>`, issue-style comment → `https://github.com/optave/ops-codegraph-tool/issues/<number>#issuecomment-<comment-id>`>

	**Context:** <why this is out of scope for the current PR and what the fix entails>
	EOF
   )" \
     --label "follow-up")
   issue_number=$(echo "$issue_url" | grep -oE '[0-9]+$')
   ```

   Then reply to the reviewer comment referencing the issue (using `$issue_number` captured above). Use the same reply mechanism as step 6 below — inline PR review comments use `/pulls/<number>/comments/<comment-id>/replies`, top-level review bodies and issue-style comments use `/issues/<number>/comments`:
   ```bash
   # For inline PR review comments:
   gh api repos/<repo>/pulls/<number>/comments/<comment-id>/replies \
     -f body="Out of scope for this PR — tracked in #$issue_number"
   # For top-level review bodies or issue-style comments:
   gh api repos/<repo>/issues/<number>/comments \
     -f body="Out of scope for this PR — tracked in #$issue_number"
   ```
6. **Reply to each comment** explaining what you did. The reply mechanism depends on where the comment lives:

   **For inline PR review comments** (from Claude, Greptile, or humans — these have a `path` and `line`):
   ```bash
   gh api repos/<repo>/pulls/<number>/comments/<comment-id>/replies \
     -f body="Fixed — <brief description of what was changed>"
   ```

   **For top-level PR review bodies** (Claude often leaves a summary review with `CHANGES_REQUESTED` or `COMMENT` state — these come from the `/reviews` endpoint and have no `path`):
   ```bash
   # Reply on the PR conversation thread so the reviewer sees it
   gh api repos/<repo>/issues/<number>/comments \
     -f body=$'Addressed Claude\'s review feedback:\n- <bullet per item addressed>'
   ```

   **For issue-style comments** (includes @greptileai trigger responses):
   ```bash
   gh api repos/<repo>/issues/<number>/comments \
     -f body="Addressed: <summary of changes made>"
   ```

**Checklist before moving on:** After addressing all comments, verify you haven't missed a reviewer:
```bash
# List all unique reviewers who left comments
gh api repos/<repo>/pulls/<number>/comments --paginate --jq '[.[].user.login] | unique | .[]'
gh api repos/<repo>/pulls/<number>/reviews --paginate --jq '[.[].user.login] | unique | .[]'
gh api repos/<repo>/issues/<number>/comments --paginate --jq '[.[].user.login] | unique | .[]'
# Confirm you addressed comments from EVERY reviewer listed
```

### 2f. Commit and push fixes

After addressing all comments for a PR:

1. Stage only the files you changed.
2. Group changes by concern — each logically distinct fix gets its own commit (e.g., one commit for a missing validation, another for a naming change). Do not lump all feedback into a single commit.
3. Use descriptive messages per commit: `fix: <what this specific change does> (#<number>)`
4. Push to the PR branch — re-derive the branch name in the same call, per Step 2a:
   ```bash
   git push origin "HEAD:$(gh pr view <number> --json headRefName -q .headRefName)"
   ```
5. **If the push is rejected** (e.g., by a hook or commitlint), diagnose the error before retrying:
   - **Commitlint failure** (bad commit message format): This is the ONE case where amend + force-push is allowed. Fix the message with `git commit --amend -m "correct message"` then `git push --force-with-lease origin "HEAD:$(gh pr view <number> --json headRefName -q .headRefName)"` (by refspec — you are on a detached HEAD from step 2a).
   - **Hook denial** (guard-git.sh blocking staged files not in session edit log): The worktree has no edit log — commit with explicit file paths (`git commit <file1> <file2> -m "msg"`) instead of staging first.
   - **Branch name validation failure**: You are on the wrong branch — check out the correct PR branch before retrying.
   - **Any other failure**: Fix with a new commit. Never amend + force-push for code changes.

### 2g. Re-trigger reviewers

**Hard cap: 50 total Greptile re-triggers per PR, counted from live data, not memory.** Long sessions span multiple turns and resumes — don't rely on remembering how many rounds you've done. Before anything else in this step, count the `@greptileai` comments **you** have actually posted — scope the query to the authenticated actor, not just "anyone other than Greptile," or pre-existing `@greptileai` comments from the PR author, a maintainer, or another workflow will count against your budget and stop you early:

```bash
me=$(gh api user --jq '.login')
trigger_count=$(gh api repos/<repo>/issues/<number>/comments --paginate \
  | jq -s --arg me "$me" '[.[][] | select(.user.login == $me and (.body | test("^@greptileai\\s*$")))] | length')
echo "Greptile has been re-triggered $trigger_count time(s) so far by this sweep."
```

If `trigger_count` is already **50 or more**: do NOT trigger again, no matter how many real findings you just fixed. Reply to any outstanding comment (per Step 2e) so nothing is left unacknowledged, then run the mandatory final live re-check (Step 2h.1) — hitting the cap does not exempt you from it, and comments can still have arrived since your last check — reply to anything that check turns up, and only then proceed to Step 2j and report `Status: needs-human-review`, noting in Notes how many rounds occurred and what the last item was. Fixing a real bug on round 51+ does not extend the cap — it's a budget on wall-clock and review noise, not a correctness gate; a human reviews the rest.

If `trigger_count` is under 50, proceed:

**Greptile:** Re-trigger after replying to Greptile comments — whether the comment was actionable or not — so Greptile re-reviews the *updated* PR. First, run the verification script below to confirm all Greptile comments have replies. Then run the **Greptile re-trigger gate** (defined just below and reused verbatim by Step 2i): it posts `@greptileai` unless Greptile is *verifiably satisfied with the current PR head*.

> A positive reaction on one of **your replies** is **not** satisfaction and never was — only a reaction on an `@greptileai` **trigger comment** counts. Skipping the trigger on a reply-reaction leaves your fix un-reviewed, and it is the specific mistake this gate replaced. Let the gate decide; do not second-guess it. (The 50-trigger cap above still applies — if it is spent, do not run the gate; follow the cap's instructions instead.)

**CRITICAL — verify all Greptile comments have replies BEFORE triggering.** Posting `@greptileai` without replying to every comment is worse than not triggering at all — it starts a new review cycle while the old one still has unanswered feedback. Run this check first:

```bash
# Step 0: Verify every Greptile inline comment has at least one reply from us
all_comments=$(gh api repos/<repo>/pulls/<number>/comments --paginate)

# while/read on a process substitution, not `for cid in $(...)`: an unquoted multi-line
# command substitution only word-splits on newlines under bash's default IFS. zsh does
# NOT split unquoted expansions unless SH_WORD_SPLIT is set, so under zsh `for cid in
# $greptile_comment_ids` collapses every id into a single iteration where $cid is the
# whole multi-line blob — the subsequent jq call then fails to parse, reply_count comes
# back empty, and the numeric comparison below silently fails open, reporting "all
# comments answered" even when none are. while/read is portable across both shells.
unanswered=()
while IFS= read -r cid; do
  [ -z "$cid" ] && continue
  reply_count=$(echo "$all_comments" \
    | jq -s "[.[][] | select(.in_reply_to_id == $cid and .user.login != \"greptile-apps[bot]\")] | length")
  if [ "$reply_count" -eq 0 ]; then
    unanswered+=("$cid")
  fi
done < <(echo "$all_comments" | jq -r '[.[] | select(.user.login == "greptile-apps[bot]" and .in_reply_to_id == null)] | .[].id')

if [ ${#unanswered[@]} -gt 0 ]; then
  echo "BLOCKED — ${#unanswered[@]} Greptile comments have no reply: ${unanswered[*]}"
  echo "Go back to Step 2e and reply to each one before re-triggering."
  exit 1
fi
echo "All Greptile comments have replies — safe to re-trigger."
```

**Do NOT proceed to the re-trigger step below until the check above passes.** If any comments are unanswered, go back to Step 2e, reply to each one, then re-run this check.

```bash
# === Greptile re-trigger gate (shared by Step 2g and Step 2i) ===
# Re-trigger Greptile UNLESS it is verifiably satisfied with the CURRENT PR head.
# "Satisfied" requires ALL of:
#   (1) an `@greptileai` TRIGGER comment exists — a non-Greptile comment that REALLY MENTIONS
#       @greptileai, i.e. GitHub linkified it. A body that merely CONTAINS the literal inside a
#       code span, a fenced block, an indented block, or an HTML comment notifies nobody and is
#       NOT a trigger (see the classifier's own header below, and #964),
#   (2) Greptile reacted to THAT TRIGGER with a positive emoji (+1/hooray/heart/rocket),
#   (3) Greptile posted no issue-style or inline comment after that trigger, AND
#   (4) Greptile has reviewed the CURRENT head — established from its own `Last reviewed commit`
#       marker, falling back to a commit-timestamp proxy only when that marker can't be parsed.
# A positive reaction on one of YOUR REPLIES is NOT a satisfied signal — only a reaction on a
# TRIGGER comment counts. If ANY condition fails, post `@greptileai`. Same idempotent gate is
# safe to re-run, so Step 2i calls it verbatim as the final mandatory check.

# Posts the mandatory `@greptileai` trigger and terminates the gate. EVERY branch below that
# needs to post — a fail-safe fetch-failure fallback, "no trigger has ever existed", or the
# ordinary "not satisfied" verdict — calls this instead of posting inline and falling through.
# A failed fetch can't prove a trigger already exists, so the gate must attempt to notify
# Greptile; but if THIS post also fails, silently letting the script end with its default exit 0
# would reproduce the exact bug it fixes at one remove (Greptile review, PR #2486): the sweep
# would believe the mandatory trigger landed when it never left this machine. That double
# failure is rare, but the caller (a human or the sweep session) needs a LOUD signal instead of
# false confidence, so a failed post here exits non-zero rather than swallowing the error.
post_trigger_or_die() {
  echo "$1"
  if gh api repos/<repo>/issues/<number>/comments -f body="@greptileai" > /dev/null; then
    exit 0
  fi
  echo "FATAL: the @greptileai POST itself failed — Greptile was NOT notified. Investigate (network/auth/rate-limit) and retrigger manually." >&2
  exit 1
}

# Candidate issue-stream comments, oldest first: `<id><TAB><created_at><TAB><body as a JSON string>`.
# The body rides through jq's `@json` so every record stays ONE line — a raw multi-line body would
# break the line-oriented classifier below. `@json` is core jq needing no regex, so this does not
# depend on which jq flavour gh embeds, and it uses gh's BUILT-IN --jq (never a standalone `jq`
# binary — same rationale as Step 0's guard).
trigger_candidates=$(gh api repos/<repo>/issues/<number>/comments --paginate \
  --jq '.[] | select(.user.login != "greptile-apps[bot]") | "\(.id)\t\(.created_at)\t\((.body // "") | @json)"') \
  || {
    # Fail safe (same reasoning as every guard below): a failed fetch can't prove a trigger
    # doesn't already exist, but it *also* can't prove one does — and aborting here used to
    # exit the gate outright without posting, which on Step 2i's mandatory final run meant
    # the sweep could stop having never sent the required last review trigger. Post instead.
    post_trigger_or_die "Could not fetch trigger comments — posting @greptileai (fail safe)."
  }

# <!-- greptile-trigger:decision:start -->
# ── Decision half: pure text, NO network. Reads ONLY $trigger_candidates (newline-separated,
# possibly empty) and sets $trigger_id / $trigger_ts (both empty ⇒ no real trigger exists).
# `scripts/greptile-trigger-guard-check.sh` extracts these exact lines between the two markers and
# runs them under bash AND zsh against frozen fixtures (CI job `greptile-trigger-guard`), so this
# block is tested, executable code — not prose. Keep it hermetic: no gh/curl/git in command
# position, and no input but that one variable.
#
# A TRIGGER is a comment that really MENTIONS @greptileai — one GitHub linkified, so Greptile was
# notified. A body that merely CONTAINS the literal is NOT a trigger: GitHub does not linkify a
# mention inside an inline code span, a fenced block, an indented block, or an HTML comment. The
# gate used to test the raw body with `test("@greptileai")`, which counted all of those — and that
# defeats the gate with its own detector. The warning above is explicit that a 👍 on one of OUR
# replies must never substitute for a reaction on a real trigger, yet a reply whose prose merely
# said `@greptileai` in backticks was classified AS the trigger, so conditions (1) and (2) were
# both satisfied by exactly that reply-reaction. A false trigger also moved $trigger_ts later,
# relaxing condition (3)'s baseline. Observed on PR #964: the `Digest` stage's "Concepts to know"
# comment reads "…blocking a re-trigger of `@greptileai` while feedback is unanswered", and being
# the newest match it won `| last` over the real bare trigger — the one actually carrying
# Greptile's 👍. No wrong SKIP was ever observed (that comment happened to carry no reaction, so
# condition (2) failed), but the detector demonstrably picked it, and the `Digest` stage emits
# comments of that shape systematically.
#
# The stripper below is deliberately OVER-aggressive (first-to-last backtick per line, greedy HTML
# comments, an unterminated fence swallowing to EOF). Every gap therefore DROPS a candidate, and a
# dropped candidate costs at most one redundant `@greptileai` — it can never invent a trigger and
# skip a review. Bias the direction; do not make the parser clever.
#
# NO positional variables ($0/$1/…) anywhere in this block. Skill argument substitution rewrites
# them before the text reaches the agent, so `/sweep 947` turned `awk 'NF{last=$0}'` into
# `awk 'NF{last=947}'` (#951) — inside this very gate. The awk program therefore reads records with
# `getline` into a NAMED variable and splits fields into an array. Do not reintroduce $0/$1 here;
# `scripts/greptile-trigger-guard-check.sh` lints for them.
trigger_pair=$(printf '%s\n' "$trigger_candidates" | awk '
  BEGIN {
    # Dynamic regex so the handle stays a single source of truth; tolower() on both sides makes the
    # match case-insensitive the way GitHub mentions are. Kept as a variable (not inlined) so every
    # fleet copy of this block is textually identical apart from the handle — the drift #962 exists
    # to stop.
    mention = tolower("@greptileai")
    # A fence opener, built rather than written: a literal triple-backtick INSIDE this fenced
    # block truncates any extractor that scans for the closing fence non-greedily — including
    # a harness that executes this gate end-to-end. CommonMark itself would not close the fence
    # on an 8-space-indented line, but "correct per spec" is no help when the tools that read
    # this file disagree. Do not inline it back.
    fence = sprintf("%c%c%c", 96, 96, 96)
    while ((getline rec) > 0) {
      if (rec == "") continue
      nf = split(rec, fld, "\t")
      if (nf < 3) continue                          # malformed record — drop (fail safe)
      body = fld[3]
      for (i = 4; i <= nf; i++) body = body "\t" fld[i]
      if (substr(body, 1, 1) != "\"") continue      # not a JSON string literal — drop
      if (substr(body, length(body), 1) != "\"") continue
      body = substr(body, 2, length(body) - 2)
      gsub(/<!--.*-->/, " ", body)                  # HTML comments never notify anyone
      sub(/<!--.*$/, " ", body)                     # …unterminated: swallow to the end
      gsub(/\\r/, " ", body)
      gsub(/\\t/, "    ", body)                     # a tab indents like four spaces
      gsub(/\\n/, "\n", body)                       # restore line structure
      n = split(body, line, "\n")
      kept = ""; fenced = 0
      for (i = 1; i <= n; i++) {
        probe = line[i]
        sub(/^[ ]*/, "", probe)
        if (substr(probe, 1, 3) == fence || substr(probe, 1, 3) == "~~~") { fenced = 1 - fenced; continue }
        if (fenced) continue                        # inside a fence (unterminated ⇒ to EOF)
        if (line[i] ~ /^    /) continue             # indented code block
        one = line[i]
        if (one ~ /`/) { sub(/`.*`/, " ", one); sub(/`.*$/, " ", one) }
        kept = kept " " one
      }
      low = tolower(kept)
      # A standalone mention: bracket boundaries, not \b (not portable across greps/awks). The
      # trailing class keeps `-` in, so @greptileai-bot is a DIFFERENT user and must not count;
      # the leading class keeps `@` in, so foo@greptileai (an address) must not count either.
      if (low ~ ("(^|[^a-z0-9_@-])" mention "([^a-z0-9_-]|$)")) print fld[1] "\t" fld[2]
    }
  }
' | grep -v '^[[:space:]]*$' | tail -1)

# Most recent real trigger wins (the stream is oldest-first, so: the last surviving record).
trigger_id=$(printf '%s' "$trigger_pair" | cut -f1)
trigger_ts=$(printf '%s' "$trigger_pair" | cut -f2)
# <!-- greptile-trigger:decision:end -->

if [ -z "$trigger_id" ]; then
  # (1) fails — no trigger has ever reflected this PR. This is the case the old reply-reaction
  # shortcut got wrong: a 👍 on a reply is not a trigger, so we MUST post one.
  post_trigger_or_die "No @greptileai trigger comment exists — posting trigger."
else
  # Trigger timestamp (ISO-8601 → lexicographically comparable as a string) came from the same
  # record as the id, so it needs no second fetch. Keep the guard anyway: an empty created_at
  # would leave conditions (3)/(4) unable to run.
  if [ -z "$trigger_ts" ]; then
    # Fail safe: we found a trigger id but could not resolve its timestamp, so the
    # after-trigger inline-comment check (3) and the push-staleness check (4) can't
    # run. Never assume the conditions they control are met — post the trigger.
    post_trigger_or_die "Could not resolve trigger timestamp — posting @greptileai (fail safe)."
  fi

  # (2) positive reaction ON THE TRIGGER (never on a reply).
  positive=$(gh api "repos/<repo>/issues/comments/$trigger_id/reactions" \
    --jq '[.[] | select(.user.login == "greptile-apps[bot]" and (.content == "+1" or .content == "hooray" or .content == "heart" or .content == "rocket"))] | length' 2>/dev/null || echo 0)

  # (3) any Greptile comment after the trigger: issue stream (id-ordered) + inline stream (time-ordered).
  # Capture the RAW per-page `length` lines (one per page under --paginate) so a failed fetch is
  # detectable: `--jq '... | length'` emits "0" on a successful fetch with no matches but NOTHING on
  # a failed one. Don't pipe straight into a summing awk (`print s+0` emits "0" on empty stdin, making
  # a failed fetch indistinguishable from zero comments and silently satisfying this condition).
  # trigger_ts is guaranteed non-empty here (guarded above).
  issue_raw=$(gh api repos/<repo>/issues/<number>/comments --paginate \
    --jq "[.[] | select(.user.login == \"greptile-apps[bot]\" and .id > $trigger_id)] | length" || echo "")
  inline_raw=$(gh api repos/<repo>/pulls/<number>/comments --paginate \
    --jq "[.[] | select(.user.login == \"greptile-apps[bot]\" and .created_at > \"$trigger_ts\")] | length" || echo "")
  if [ -z "$issue_raw" ] || [ -z "$inline_raw" ]; then
    # Fail safe (same reasoning as the trigger_ts/head_ts guards): a failed fetch can't prove
    # "no new comments" — post the trigger rather than assume condition (3) is met.
    post_trigger_or_die "Could not fetch after-trigger comments — posting @greptileai (fail safe)."
  fi
  # Sum the per-page counts from each stream. Shell arithmetic, NOT `awk '{s+=$1}'`: a positional
  # awk variable in skill text is rewritten by argument substitution before the agent ever sees it
  # (#951), so under `/sweep 947` that awk became `{s+=947}` — adding 947 per page and leaving this
  # condition unable to discriminate. A non-numeric count means the fetch returned something
  # unexpected, which cannot prove "no new comments" — post rather than assume.
  #
  # The loop is fed by process substitution, NOT a here-doc: a here-doc terminator must sit at
  # column 0, so the block breaks the moment a fleet copy INDENTS this gate — and one already does,
  # wrapping it in a function so its early-outs can `return` rather than `exit`. `< <(…)` also keeps
  # the loop in THIS shell, so the accumulator survives; `printf | while` would lose it to a
  # subshell. Both shells in the guard's matrix support it, as the `comm -23 <(…)` above does.
  comments_after=0
  while IFS= read -r page_count; do
    [ -n "$page_count" ] || continue
    case "$page_count" in
      *[!0-9]*)
        post_trigger_or_die "Non-numeric after-trigger count ('$page_count') — posting @greptileai (fail safe)."
        ;;
    esac
    comments_after=$((comments_after + page_count))
  done < <(printf '%s\n%s\n' "$issue_raw" "$inline_raw")

  # (4) has Greptile reviewed the CURRENT head? Prefer Greptile's OWN direct evidence over any
  # timestamp proxy: its sticky summary comment ends with a footer naming the exact commit it
  # reviewed —
  #   Reviews (N): Last reviewed commit: ["<subject>"](https://github.com/<owner>/<repo>/commit/<40-hex>)
  # — so when that SHA equals the PR head, Greptile HAS reviewed the head and (4) holds regardless
  # of commit/push timestamps. This is load-bearing because Greptile re-reviews by EDITING that
  # summary IN PLACE (same comment id, no new comment), so timestamps alone cannot observe a
  # completed re-review. Observed on PR #930: the marker named the exact head at Confidence
  # Score 5/5, yet the timestamp proxy read "commit newer than trigger" and posted `@greptileai`
  # twice more — review #9 of a commit already approved, and a converged sweep that looked
  # unconverged. Timestamps stay as the FALLBACK only (see the else branch).
  head_sha=$(gh pr view <number> --repo <repo> \
    --json headRefOid --jq '.headRefOid // empty' 2>/dev/null | tr -d '[:space:]' | tr 'A-Z' 'a-z')
  if [ -z "$head_sha" ]; then
    # Fail safe (same reasoning as the trigger_ts guard above): with no head SHA, neither the
    # marker comparison nor the timestamp fallback can prove the trigger reflects the current
    # head. Post rather than assume — a failed fetch must never count as satisfied.
    post_trigger_or_die "Could not resolve PR head SHA — posting @greptileai (fail safe)."
  fi

  # Every SHA Greptile has published as "last reviewed" (normally one — the sticky summary).
  # `--jq` only SELECTS the bodies; grep does the extraction, so this needs neither a standalone
  # `jq` binary nor jq-flavour named-capture regex. grep is line-oriented and the footer is a
  # single line, so `.*` cannot run past it into another comment's link.
  #
  # The fetch is captured SEPARATELY from the grep extraction below, and ITS OWN exit status
  # checked directly with `||` — piping straight into `grep -o` would erase the difference
  # between "the API call failed" and "the API call succeeded and legitimately found no marker
  # yet" (Greptile hasn't summarised, or the footer format changed): `grep` exits 1 on "no
  # match" either way, so a guard on the whole pipeline would misfire on that ordinary, non-error
  # case too and defeat itself. A genuine fetch failure must fail safe by posting — it must NOT
  # fall through to the timestamp-proxy branch below as if no marker existed, because the proxy
  # can read "nothing pushed since the trigger" and conclude satisfied, silently permitting a
  # skip of a head Greptile's marker was never actually checked against.
  reviewed_bodies=$(gh api repos/<repo>/issues/<number>/comments --paginate \
    --jq '.[] | select(.user.login == "greptile-apps[bot]") | .body' 2>/dev/null) \
    || post_trigger_or_die "Could not fetch Greptile comments for the reviewed-commit marker — posting @greptileai (fail safe)."
  # inline-sweep GREPTILE-LAST-REVIEWED extractor [#930]
  reviewed_shas=$(printf '%s\n' "$reviewed_bodies" \
    | grep -o 'Last reviewed commit:.*/commit/[0-9a-fA-F]\{40\}' \
    | grep -o '[0-9a-fA-F]\{40\}$' | tr 'A-Z' 'a-z')

  if [ -n "$reviewed_shas" ] && printf '%s\n' "$reviewed_shas" | grep -qx "$head_sha"; then
    # Direct evidence: a published Greptile review names the current head. Not stale.
    pushed_after=0; head_basis="marker"
  elif [ -n "$reviewed_shas" ]; then
    # Direct evidence the other way: every review Greptile published names some OTHER commit,
    # so it has not reviewed this head. Stale — post.
    pushed_after=1; head_basis="marker"
  else
    # FALLBACK ONLY — no parsable marker (Greptile has not summarised yet, the footer format
    # changed, or the fetch failed). Empty output cannot distinguish those three, and all of them
    # land on the pre-existing behaviour below, so this path is never weaker than it was.
    # Latest commit's committedDate is a proxy for push time — if it post-dates the trigger, the
    # trigger predates your fix and is stale.
    # Caveat: committedDate is the local commit/amend time, not the true push time, so a cherry-pick,
    # a timestamp-preserving rebase, or `git commit --date` can leave it BEFORE a later push and
    # yield a false "not stale" (pushed_after=0). This errs toward skipping, but Step 2i's mandatory
    # final run of this gate is the backstop. For an exact push time, use the GraphQL `pushedDate`.
    head_ts=$(gh pr view <number> --repo <repo> \
      --json commits --jq '.commits[-1].committedDate // empty' 2>/dev/null || echo "")
    if [ -z "$head_ts" ]; then
      # Fail safe (same reasoning as the trigger_ts guard above): if the head commit time
      # can't be fetched, the staleness check (4) can't run. Don't let it short-circuit to
      # "not stale" — post the trigger so a failed fetch never silently counts as satisfied.
      post_trigger_or_die "Could not resolve head commit time — posting @greptileai (fail safe)."
    fi
    # awk does the string compare (portable across bash/zsh; avoids `[ \> ]`, which zsh rejects).
    # ISO-8601 values are non-numeric, so awk compares them lexically = chronologically.
    # Both h and t are guaranteed non-empty here (the fail-safes above exit otherwise).
    pushed_after=$(awk -v h="$head_ts" -v t="$trigger_ts" 'BEGIN{print (h>t) ? 1 : 0}')
    head_basis="timestamp-proxy"
  fi

  if [ "$positive" -gt 0 ] && [ "$comments_after" -eq 0 ] && [ "$pushed_after" -eq 0 ]; then
    echo "Greptile satisfied with current head $head_sha (reacted to trigger $trigger_id; no new comments; head reviewed per $head_basis) — skipping re-trigger."
  else
    post_trigger_or_die "Not satisfied (positive=$positive comments_after=$comments_after pushed_after=$pushed_after basis=$head_basis) — posting @greptileai."
  fi
fi
```

**Claude (claude-code-review / claude bot):** Only re-trigger if you addressed something Claude specifically suggested. If you did:

```bash
gh api repos/<repo>/issues/<number>/comments \
  -f body="@claude"
```

If all changes were only in response to Greptile feedback, do NOT re-trigger Claude.

### 2h. Wait and re-check

After re-triggering:

1. Poll for new reviews on an interval — see "Before you start: how to wait." Do not end your turn to wait passively, and don't declare a round "done" from a single check taken right after triggering — Greptile can take 15–30 minutes to respond. **But also check the trigger comment's own reactions on each poll**, reusing the `$trigger_id` you captured in Step 2g when you posted it — a positive reaction (`+1`/`hooray`/`heart`/`rocket`) from `greptile-apps[bot]` there, with no new review following it, means Greptile examined the fix and has nothing further to add: a terminal "done" signal for this round on its own, so don't keep polling the full 15–30 minutes waiting for a review object that isn't coming:
   ```bash
   positive_count=$(gh api repos/<repo>/issues/comments/$trigger_id/reactions \
     --jq '[.[] | select(.user.login == "greptile-apps[bot]" and (.content == "+1" or .content == "hooray" or .content == "heart" or .content == "rocket"))] | length')
   ```
2. Fetch new comments again (repeat Step 2d + 2d.1 — re-mine the summary body too, not just inline comments).
3. If there are **new** comments from Greptile or Claude, go back to Step 2e and address them, then re-trigger per 2g **only if** the trigger-count cap in 2g hasn't already been hit.
4. **The 50-trigger cap in Step 2g is the actual stop condition — not a mental "round" count.** If you hit the cap mid-loop, stop re-triggering immediately (you may still reply to outstanding comments), run the mandatory Step 2h.1 final live check, and only then go to 2i with `Status: needs-human-review`.
5. Verify CI is still green after all changes.

### 2h.1. Final fresh check — do this immediately before reporting, every time

Right before you write your Step 2j result, re-run Step 2d + 2d.1 **one more time, live** — regardless of how confident you are that things are settled. Comments arrive asynchronously; a check from even 10–15 minutes ago can already be stale, and reporting `Status: ready` on stale data is worse than reporting late or as `needs-human-review`. If this final check turns up anything new, handle it (reply, and re-trigger only if the Step 2g cap allows it) before finalizing. Only write your Step 2i block once this last check is clean, or you've hit a hard stop (the 50-trigger cap, or 3 rounds of CI fixes).

### 2i. Final Greptile re-trigger (mandatory)

After all work on the PR is complete — CI green, every comment addressed, every reply posted — **run the Greptile re-trigger gate from Step 2g one final time** (verify reply coverage first, then run the gate). This step is **mandatory and must never be skipped**: the gate itself decides whether to post `@greptileai`, and it skips the post *only* when Greptile is verifiably satisfied with the current head.

Greptile is **satisfied** only when **all four** of the gate's conditions hold:
1. An `@greptileai` *trigger comment* exists (posted by a non-Greptile user) — and it **really
   mentions** Greptile. A comment that merely contains the literal `@greptileai` inside a code
   span, a fenced block, an indented block, or an HTML comment notifies nobody, so it is **not** a
   trigger; the gate strips those before testing. Left untested, the detector itself would hand
   conditions (1) and (2) to exactly the reply-reaction the warning above rejects.
2. Greptile reacted to **that trigger** with a positive emoji (👍, 🎉, ❤️, or 🚀).
3. Greptile posted **no** new comment (issue-style or inline) after that trigger.
4. **Greptile has reviewed the current head.** Take this from Greptile's own summary footer — `Reviews (N): Last reviewed commit: [...](.../commit/<sha>)` — and require that `<sha>` to equal `gh pr view <number> --json headRefOid`. Greptile re-reviews by editing that summary **in place**, so a "was anything pushed after the trigger?" timestamp check cannot see a re-review that already happened and will re-trigger a commit Greptile has already approved. The commit-timestamp comparison remains only as the fallback for when the marker can't be parsed.

Do **not** skip the trigger on any other basis. In particular, a positive reaction on one of *your replies* is **not** satisfaction — that mistake leaves your fix un-reviewed and the mandatory final trigger unsent. When in doubt, the gate errs toward posting; let it run rather than second-guessing it.

### 2j. Return result

At the end of processing, the subagent MUST return a structured result with these fields so the main agent can build the summary table:

```
PR: #<number>
Branch: <branch-name>
Conflicts: resolved | none
CI: green | red | pending
Comments Addressed: <count>
Issues: <comma-separated list of #<n> follow-up issues, or "none">
Reviewers Re-triggered: <list>
Status: ready | needs-work | needs-human-review | skipped
Notes: <any issues encountered>
```

---

## Step 3: Collect Results and Summarize

After **all** subagents complete, collect their results and output a summary table:

```
| PR | Branch | Conflicts | CI | Comments Addressed | Issues | Reviewers Re-triggered | Status |
|----|--------|-----------|----|--------------------|--------|----------------------|--------|
| #N | branch | resolved/none | green/red | N comments | #X, #Y or none | greptile, claude | ready/needs-work |
```

If any subagent failed or returned an error, note it in the Status column as `agent-error` with the failure reason.

---

## Rules

- **Never rebase.** Always `git merge <base>` to resolve conflicts.
- **Push by refspec — you are detached.** Step 2a checks the PR head out with `--detach` so the checkout cannot collide with another worktree holding that branch name. A bare `git push` therefore fails with *"You are not currently on a branch"*: every push is `git push origin "HEAD:$(gh pr view <number> --json headRefName -q .headRefName)"`, re-deriving the branch name in the same Bash call as the push — a shell variable captured in an earlier step does not survive into a later one.
- **Never force-push** unless fixing a commit message that fails commitlint. Amend + force-push is the only way to fix a pushed commit title (messages are part of the SHA). This is safe on feature branches. For all other problems, fix with a new commit. **If a push or commit is denied by a hook**, read the denial reason — don't blindly retry or escalate to force-push. Common causes: (1) commitlint rejects the message format → amend + force-push (`git push --force-with-lease origin "HEAD:$(gh pr view <number> --json headRefName -q .headRefName)"`), (2) guard-git blocks staged files not in session edit log → use `git commit <file1> <file2> -m "msg"` with explicit paths, (3) branch name validation fails → your detached HEAD is not on the PR's head commit.
- **Address ALL comments from ALL reviewers** (Claude, Greptile, and humans), even minor/nit/optional ones. Leave zero unaddressed. Do not only respond to one reviewer and skip another.
- **Always reply to comments** explaining what was done. Don't just fix silently. Every reviewer must see a reply on their feedback.
- **Mine the Greptile *summary* body, not just inline comments** (Step 2d.1). A `Confidence Score: N/5` with `N < 5` always names at least one gap in prose, and those gaps frequently have **no** inline comment. Extract every finding from the summary and fix it (or file a tracked `follow-up`). Missing a summary-only finding is the #1 way a Greptile concern survives a sweep — reconcile your fixes against the summary before declaring the PR ready.
- **Never trigger `@greptileai` without replying to every Greptile comment first.** Before posting the re-trigger, run the Step 2g verification script to confirm zero unanswered Greptile comments. Triggering a new review while old comments are unanswered is a blocking violation — it creates review noise and signals that feedback was ignored. Reply first, verify, then trigger.
- **Only re-trigger Claude** if you addressed Claude's feedback specifically.
- **No co-author lines** in commit messages.
- **No Claude Code references** in commit messages or comments.
- **Run tests and lint locally** before pushing any fix.
- **One concern per commit** — don't lump conflict resolution with code fixes.
- **Flag scope creep.** If a PR's diff contains files unrelated to its stated purpose (e.g., a docs PR carrying `src/` or test changes from a merged feature branch), flag it immediately. Split the unrelated changes into a separate branch and PR. Do not proceed with review until the PR is scoped correctly — scope creep is not acceptable.
- If a PR is fundamentally broken beyond what review feedback can fix, note it in the summary and skip to the next PR.
- **Never defer without tracking.** Do not reply "acknowledged as follow-up", "noted for later", or "tracking for follow-up" to a reviewer comment without creating a GitHub issue first. If you can't fix it now and it's genuinely out of scope, create an issue with the `follow-up` label and include the issue link in your reply. Untracked acknowledgements are the same as ignoring the comment — they will never be revisited.
- **Never end a turn to passively "wait."** You are a background subagent — nothing wakes you up when a shell job, CI run, or reviewer response completes on its own. Poll actively across a continuous sequence of tool calls (see "Before you start: how to wait") until you have a concrete result. Ending your turn with "I'll wait for X" and no further tool call stalls the sweep silently, sometimes for hours, until a human notices and manually re-prompts you.
- **No fake "something will notify me" framing.** A background job, watcher, or "monitor" you start yourself does not resume your turn when it fires — only your own next tool call does. Do not write or act on "is running and will notify me," "remains armed," or "I'll pick this back up when re-prompted." If you're about to write something like that, make another tool call instead.
- **Respect the shared GitHub API rate limit.** All subagents in a sweep (and any concurrent session) share one identity's quota. Poll no tighter than every 60–120s and batch checks rather than looping per-item. `gh api rate_limit` is free to check. If you hit `API rate limit exceeded`, bridge the wait yourself with bounded sleep-then-recheck cycles against the `reset` epoch (see "Mind the GitHub API rate limit") — never assume it will clear on its own without you checking, and never spam retries while it's still exhausted.
- **The 50-Greptile-trigger cap is counted from live data (actual `@greptileai` comments posted), not from memory of "how many rounds I've done."** Check it mechanically (Step 2g) before every trigger. Once hit, stop triggering even if you just fixed a real bug — reply, don't trigger, and report `needs-human-review`.
- **Never declare `Status: ready` from a stale check.** Re-verify comments and CI live, immediately before writing your Step 2j result (Step 2h.1) — not from a check earlier in the session, and not just because you feel confident nothing more is coming. The orchestrator relaying a manual spot-check to you is not a substitute for this either — always do your own final live check.
