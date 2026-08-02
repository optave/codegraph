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

A subagent may end its turn with text like "I'll wait for X to finish" or "pausing until Y completes" instead of actually finishing. (The "Before you start: how to wait" instruction given to every subagent exists to prevent exactly this, but it can still happen, especially across long sessions.) If it does:

- Resume it with `SendMessage`, explicitly instructing it to poll to a real terminal result in a continuous sequence of tool calls rather than end its turn again.
- **Do not substitute your own point-in-time `gh` check for the subagent's job and tell it "you're done, report ready."** PR state under active review changes in minutes — a check you ran even a few minutes ago can already be stale by the time you relay it, and a stale "confirmed done" from you is how a real reviewer finding gets missed. If you check state directly to unblock a stalled agent, pass it along only as a data point ("as of my check just now, X") and instruct the agent to do its own final live re-verification (Step 2h.1) before reporting — never hand it a final verdict to just relay verbatim.

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

### 2a. Check out the PR branch

```bash
gh pr checkout <number>
```

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
4. Push to the PR branch.
5. **If the push is rejected** (e.g., by a hook or commitlint), diagnose the error before retrying:
   - **Commitlint failure** (bad commit message format): This is the ONE case where amend + force-push is allowed. Fix the message with `git commit --amend -m "correct message"` then `git push --force-with-lease`.
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

If `trigger_count` is already **50 or more**: do NOT trigger again, no matter how many real findings you just fixed. Reply to any outstanding comment (per Step 2e) so nothing is left unacknowledged, then run the mandatory final live re-check (Step 2h.1) — hitting the cap does not exempt you from it, and comments can still have arrived since your last check — reply to anything that check turns up, and only then proceed to Step 2i and report `Status: needs-human-review`, noting in Notes how many rounds occurred and what the last item was. Fixing a real bug on round 51+ does not extend the cap — it's a budget on wall-clock and review noise, not a correctness gate; a human reviews the rest.

If `trigger_count` is under 50, proceed:

**Greptile:** Always re-trigger after replying to Greptile comments — whether the comment was actionable or not. First, run the verification script below to confirm all Greptile comments have replies. Then, skip the actual trigger only if Greptile already reacted to your most recent reply with a positive emoji (thumbs up, check, etc.), which means it is already satisfied.

**CRITICAL — verify all Greptile comments have replies BEFORE triggering.** Posting `@greptileai` without replying to every comment is worse than not triggering at all — it starts a new review cycle while the old one still has unanswered feedback. Run this check first:

```bash
# Step 0: Verify every Greptile inline comment has at least one reply from us
all_comments=$(gh api repos/<repo>/pulls/<number>/comments --paginate)

greptile_comment_ids=$(echo "$all_comments" \
  | jq -r '[.[] | select(.user.login == "greptile-apps[bot]" and .in_reply_to_id == null)] | .[].id')

unanswered=()
for cid in $greptile_comment_ids; do
  reply_count=$(echo "$all_comments" \
    | jq -s "[.[][] | select(.in_reply_to_id == $cid and .user.login != \"greptile-apps[bot]\")] | length")
  if [ "$reply_count" -eq 0 ]; then
    unanswered+=("$cid")
  fi
done

if [ ${#unanswered[@]} -gt 0 ]; then
  echo "BLOCKED — ${#unanswered[@]} Greptile comments have no reply: ${unanswered[*]}"
  echo "Go back to Step 2e and reply to each one before re-triggering."
  exit 1
fi
echo "All Greptile comments have replies — safe to re-trigger."
```

**Do NOT proceed to the re-trigger step below until the check above passes.** If any comments are unanswered, go back to Step 2e, reply to each one, then re-run this check.

```bash
# Step 1: Check if greptileai left a positive reaction on your most recent reply
last_reply_id=$(gh api repos/<repo>/issues/<number>/comments --paginate \
  --jq '[.[] | select(.user.login != "greptile-apps[bot]")] | last | .id')

positive_count=$(gh api repos/<repo>/issues/comments/$last_reply_id/reactions \
  --jq '[.[] | select(.user.login == "greptile-apps[bot]" and (.content == "+1" or .content == "hooray" or .content == "heart" or .content == "rocket"))] | length')

# Step 2: If positive reaction exists → skip. Otherwise → re-trigger.
if [ "$positive_count" -gt 0 ]; then
  echo "Greptile already reacted positively — skipping re-trigger."
else
  gh api repos/<repo>/issues/<number>/comments -f body="@greptileai"
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

1. Poll for new reviews on an interval — see "Before you start: how to wait." Do not end your turn to wait passively, and don't declare a round "done" from a single check taken right after triggering — Greptile can take 15–30 minutes to respond. **But also check the trigger comment's own reactions on each poll** — a positive reaction (`+1`/`hooray`/`heart`/`rocket`) from `greptile-apps[bot]` there, with no new review following it, means Greptile examined the fix and has nothing further to add: a terminal "done" signal for this round on its own, so don't keep polling the full 15–30 minutes waiting for a review object that isn't coming. Look up the trigger comment **by its content**, not "the most recent non-Greptile comment" — if anything else gets posted after your trigger (another user, another agent), that lookup would silently drift to the wrong comment:
   ```bash
   # --paginate with --jq applies the filter per-page, not to the merged result — fetch raw
   # and slurp instead, or a multi-page comment list silently misses the true global last.
   trigger_id=$(gh api repos/<repo>/issues/<number>/comments --paginate \
     | jq -s '[.[][] | select(.body | test("^@greptileai\\s*$"))] | last | .id')
   positive_count=$(gh api repos/<repo>/issues/comments/$trigger_id/reactions \
     --jq '[.[] | select(.user.login == "greptile-apps[bot]" and (.content == "+1" or .content == "hooray" or .content == "heart" or .content == "rocket"))] | length')
   ```
2. Fetch new comments again (repeat Step 2d + 2d.1 — re-mine the summary body too, not just inline comments).
3. If there are **new** comments from Greptile or Claude, go back to Step 2e and address them, then re-trigger per 2g **only if** the trigger-count cap in 2g hasn't already been hit.
4. **The 50-trigger cap in Step 2g is the actual stop condition — not a mental "round" count.** If you hit the cap mid-loop, stop re-triggering immediately (you may still reply to outstanding comments), run the mandatory Step 2h.1 final live check, and only then go to 2i with `Status: needs-human-review`.
5. Verify CI is still green after all changes.

### 2h.1. Final fresh check — do this immediately before reporting, every time

Right before you write your Step 2i result, re-run Step 2d + 2d.1 **one more time, live** — regardless of how confident you are that things are settled. Comments arrive asynchronously; a check from even 10–15 minutes ago can already be stale, and reporting `Status: ready` on stale data is worse than reporting late or as `needs-human-review`. If this final check turns up anything new, handle it (reply, and re-trigger only if the Step 2g cap allows it) before finalizing. Only write your Step 2i block once this last check is clean, or you've hit a hard stop (the 50-trigger cap, or 3 rounds of CI fixes).

### 2i. Return result

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
- **Never force-push** unless fixing a commit message that fails commitlint. Amend + force-push is the only way to fix a pushed commit title (messages are part of the SHA). This is safe on feature branches. For all other problems, fix with a new commit. **If a push or commit is denied by a hook**, read the denial reason — don't blindly retry or escalate to force-push. Common causes: (1) commitlint rejects the message format → amend + force-push (`git push --force-with-lease`), (2) guard-git blocks staged files not in session edit log → use `git commit <file1> <file2> -m "msg"` with explicit paths, (3) branch name validation fails → you're on the wrong branch.
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
- **The 50-Greptile-trigger cap is counted from live data (actual `@greptileai` comments posted), not from memory of "how many rounds I've done."** Check it mechanically (Step 2g) before every trigger. Once hit, stop triggering even if you just fixed a real bug — reply, don't trigger, and report `needs-human-review`.
- **Never declare `Status: ready` from a stale check.** Re-verify comments and CI live, immediately before writing your Step 2i result (Step 2h.1) — not from a check earlier in the session, and not just because you feel confident nothing more is coming. The orchestrator relaying a manual spot-check to you is not a substitute for this either — always do your own final live check.
