#!/usr/bin/env bash
# guard-git.sh — PreToolUse hook for Bash tool calls
# Blocks dangerous git commands that interfere with parallel sessions
# and validates commits against the session edit log.

set -euo pipefail

INPUT=$(cat)

# Extract the command from tool_input JSON
COMMAND=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=JSON.parse(d).tool_input?.command||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

if [ -z "$COMMAND" ]; then
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"

# The actual directory the Bash tool will run this command in — a top-level
# field on every PreToolUse payload, independent of whatever cd/-C text
# happens to appear in $COMMAND. This is what a bare `git push` (relying on
# the Bash tool's persistent cwd from an earlier, separate tool call) must
# resolve against; the hook's own process cwd is unrelated to it (#2386).
HOOK_CWD=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=JSON.parse(d).cwd||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

# Replace every $IFS/${IFS} reference with a literal space (#2451) BEFORE
# even the fast-path filter below runs. `$IFS`/`${IFS}` (bash's own
# whitespace field-separator variable) supplies a token boundary bash
# expands at execution time that the command TEXT itself has no literal
# whitespace for — `git${IFS}checkout` looks like a single token to every
# regex in this file, including the fast-path filter's own
# `(git|gh)[[:space:]]+` check, but bash expands the unquoted `${IFS}` to
# whitespace before Git ever runs, so Git actually receives `checkout` as a
# separate argument. Without this, the fast-path filter doesn't recognize
# such a command as git/gh at all and exits 0 immediately, skipping EVERY
# check below, not just whichever one the attacker was targeting. See
# normalize-ifs.mjs for why this can run without any quote-awareness of its
# own. Extraction logic below (detect_work_dir, MSG_FILE, the AI-attribution
# scan) deliberately keeps reading the raw, unnormalized $COMMAND.
IFS_NORM_COMMAND=$(echo "$COMMAND" | node "$HOOK_DIR/normalize-ifs.mjs" 2>/dev/null) || true
if [ -z "$IFS_NORM_COMMAND" ]; then
  IFS_NORM_COMMAND="$COMMAND"
fi

# Act on git and gh commands (may appear after cd "..." &&, inside a quoted
# nested-shell invocation like `bash -c "git clean -fd"`, or inside a command
# substitution like `"message $(git clean -fd)"` — #2099 Greptile review).
# This is only a cheap fast-path skip, so it's deliberately permissive
# (["'`(] as extra allowed prefix boundaries alongside start/whitespace/&&)
# rather than exact: a false "yes" here just means the rest of the script
# runs its checks anyway, while a false "no" would exit before ever reaching
# them.
if ! echo "$IFS_NORM_COMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*|["'"'"'`(])(git|gh)[[:space:]]+'; then
  exit 0
fi

# Mask the *contents* of quoted strings (single or double) before any of the
# "does this command invoke a dangerous verb" checks below run (#2099). Every
# such check is a plain substring/regex scan over the command text, with no
# awareness of shell quoting — so text that merely APPEARS inside a quoted
# argument (e.g. `gh issue create --body "...git clean -fd..."`) matched the
# same pattern as a real invocation and got blocked. See mask-quoted-text.mjs
# for the masking rules. Fed from $IFS_NORM_COMMAND (not raw $COMMAND) so
# every downstream verb-detection check also benefits from IFS normalization
# (#2451) without needing its own IFS-awareness — a $IFS/${IFS} that landed
# inside a quoted span gets replaced with a space here, then blanked out
# (along with everything else in that span) by masking anyway. Extraction
# logic below (detect_work_dir, MSG_FILE, the AI-attribution scan)
# deliberately keeps reading the raw, unmasked $COMMAND — masking only feeds
# the verb-detection checks that use $NCOMMAND.
MASKED_COMMAND=$(echo "$IFS_NORM_COMMAND" | node "$HOOK_DIR/mask-quoted-text.mjs" 2>/dev/null) || true
if [ -z "$MASKED_COMMAND" ]; then
  MASKED_COMMAND="$IFS_NORM_COMMAND"
fi

# Normalize: strip `git -C "<path>"` / `git -C <path>` so downstream subcommand
# patterns (git[[:space:]]+push, git[[:space:]]+commit, …) match regardless of whether `-C` is
# present. detect_work_dir still inspects the raw $COMMAND to find the target.
# The unquoted pattern requires a non-quote first char so it does not mis-match
# the opening `"` of a quoted path (which would leave a trailing `path"` in
# NCOMMAND). The pattern re-anchors on `git`, so multi-`-C` chains (e.g.
# `git -C /a -C /b push`) need a second pass to collapse the residual `-C`.
NCOMMAND=$(echo "$MASKED_COMMAND" | sed -E 's/(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+-C[[:space:]]+"[^"]+"/\1git/g; s/(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+-C[[:space:]]+[^"[:space:]][^[:space:]]*/\1git/g')
NCOMMAND=$(echo "$NCOMMAND" | sed -E 's/(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+-C[[:space:]]+"[^"]+"/\1git/g; s/(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+-C[[:space:]]+[^"[:space:]][^[:space:]]*/\1git/g')

# Strip any remaining literal quote/substitution-delimiter characters from
# NCOMMAND (#2099 Greptile review): an exec-triggered quote
# (`bash -c "git clean -fd"`) or a command substitution
# (`"message $(git clean -fd)"`, which executes even inside an otherwise
# masked double-quoted string) is left unmasked by mask-quoted-text.mjs, but
# its delimiters survive — e.g. `"git` or `$(git` — sitting directly adjacent
# to the verb, defeating every `(^|[[:space:]])`-anchored check below.
# NCOMMAND is used exclusively for verb detection (never for value
# extraction — detect_work_dir/MSG_FILE read the raw $COMMAND instead), so
# these characters carry no meaning here once masking has already run.
NCOMMAND=$(echo "$NCOMMAND" | sed -E "s/[\"'\`()]/ /g")

deny() {
  local reason="$1"
  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: process.argv[1]
      }
    }));
  " "$reason"
  exit 0
}

# --- Block dangerous commands ---

# git add . / git add -A / git add --all (broad staging)
if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+add[[:space:]]+(\.[[:space:]]*$|-A|--all)'; then
  deny "BLOCKED: 'git add .' / 'git add -A' stages ALL changes including other sessions' work. Stage specific files instead: git add <file1> <file2>"
fi

# git reset (unstaging / hard reset)
if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+reset'; then
  deny "BLOCKED: 'git reset' can unstage or destroy other sessions' work. To unstage your own files, use: git restore --staged <file>"
fi

# git checkout -- <file> (reverting files). Requires "--" to be its own
# token, not a longer flag that merely starts with "--" (#2280) —
# otherwise this also denied legitimate flags sharing the same
# "checkout --" prefix, like --detach, --track, --orphan, --no-track,
# --guess, none of which revert working-tree changes the way a bare
# "--" pathspec separator does.
#
# Deliberately NOT anchored on literal whitespace-or-end-of-line after
# "--" (i.e. NOT `--([[:space:]]|$)`): every one of those legitimate
# flag names starts with a plain letter right after "--", so "anything
# that isn't a letter" is the correct, safe boundary — and it must
# reject unquoted shell expansions too, not just literal whitespace.
# `git checkout --${IFS}file.txt` has no literal space in the command
# TEXT between "--" and "file.txt" (so a whitespace-anchored version of
# this check misses it), but bash expands the unquoted `${IFS}` to
# whitespace at actual execution time — Git still receives the exact
# dangerous `checkout -- file.txt` (Greptile review, PR #2450). `$` is
# not a letter, so the negated-letter-class form below still denies it.
#
# --ours/--theirs are explicitly re-included in the denial (NOT covered
# by "starts with a letter, so it's safe"): despite also sharing the
# "checkout --" prefix, on an unmerged path they check the selected
# merge-conflict stage into the WORKING TREE, overwriting that file's
# on-disk content -- the same destructive-to-uncommitted-work class
# this whole check exists to catch, just from a different source (a
# merge stage instead of HEAD/the index). #2280's own suggested
# exclusion list named these as safe; that premise was wrong (Greptile
# review, PR #2450, round 2). Their own trailing boundary is a negated
# letter class too, not literal whitespace-or-end-of-line, for the same
# ${IFS}-expansion reason as the outer "--" boundary above:
# `git checkout --ours${IFS}file.txt` has no literal space in the
# command TEXT right after "ours" either (Greptile review, PR #2450,
# round 3).
if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+checkout[[:space:]]+--([^A-Za-z]|$|ours([^A-Za-z]|$)|theirs([^A-Za-z]|$))'; then
  deny "BLOCKED: 'git checkout -- <file>' reverts working tree changes and may destroy other sessions' edits. If you need to discard your own changes, be explicit about which files."
fi

# git restore (reverting) — EXCEPT git restore --staged (safe unstaging)
if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+restore'; then
  if ! echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+restore[[:space:]]+--staged'; then
    deny "BLOCKED: 'git restore <file>' reverts working tree changes and may destroy other sessions' edits. To unstage files safely, use: git restore --staged <file>"
  fi
fi

# git clean (delete untracked files) — #2099: `-n`/`--dry-run` is a pure
# listing operation (git itself treats --dry-run as always overriding -f, so
# it never deletes regardless of what else is on the line) and is exactly the
# discovery mechanism /housekeep's Phase 2 recommends; only block an
# invocation that would actually delete (carries -f/--force, and no
# -n/--dry-run). A bare `git clean` with neither flag already refuses to run
# without config changes this hook has no visibility into, so it's left
# unblocked rather than flagging something git itself won't execute.
# Delegates to check-git-clean-force.mjs (not an inline awk/grep pair) so the
# per-segment split and bundled-short-flag matching (`-ndf`, `-fnd`, …) are
# correct — an earlier version here split only on `&&`, so a flag on an
# unrelated `;`/`|`/newline-separated command could suppress the block, and
# missed bundled `-n` (Greptile review on #2099's own PR).
if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+clean'; then
  if [ "$(echo "$NCOMMAND" | node "$HOOK_DIR/check-git-clean-force.mjs" 2>/dev/null)" = "BLOCK" ]; then
    deny "BLOCKED: 'git clean -f'/'--force' deletes untracked files that may belong to other sessions. Preview first with 'git clean -n'/'--dry-run'."
  fi
fi

# git stash (hides all changes)
if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+stash'; then
  deny "BLOCKED: 'git stash' hides all working tree changes including other sessions' work. In worktree mode, commit your changes directly instead."
fi

# --- Working directory detection ---

# Resolve the working directory a git command targets:
# - `git -C "<dir>" ...`   → the -C target (takes precedence — explicit git-level override)
# - `cd "<dir>" && git ...` → the cd target
# Falls back to empty string when neither appears in the command text —
# callers then fall back further to the hook's own $HOOK_CWD (#2386).
#
# Optional arg: target subcommand hint (e.g. `push`, `commit`). When given,
# narrows the search to the `&&`-separated segment whose git invocation runs
# that subcommand, so chained commands like
#   `git -C /a push && git -C /b commit -m ...`
# resolve each caller to its own worktree instead of always picking the last
# `git` token. Within the chosen segment the LAST `-C` wins (git's `-C` is
# cumulative, so the final `-C` is the effective CWD) — this closes the
# multi-`-C` bypass (`git -C /ok -C /bad push` resolves to `/bad`).
detect_work_dir() {
  local target_subcmd="${1:-}"
  local work_dir=""
  local search_str="$COMMAND"

  if [ -n "$target_subcmd" ]; then
    local segment
    segment=$(echo "$COMMAND" | awk -v tgt="$target_subcmd" 'BEGIN{RS="&&"}{
      if ($0 ~ "git[[:space:]]+([^|;&]*[[:space:]])?" tgt "([[:space:]]|$)") { print; exit }
    }')
    if [ -n "$segment" ]; then
      search_str="$segment"
    fi
  fi

  # `git -C` is the explicit git-level override and wins over any ambient cd prefix,
  # so check it first (e.g. `cd /tmp && git -C /worktree push` targets /worktree).
  # Greedy `.*-C` anchors on the LAST `-C` in the chosen segment.
  # Two separate sed invocations (quoted path first, then unquoted fallback) instead
  # of a single `;t;s` chain — BSD sed parses chained s/// after `t` as a label.
  if echo "$search_str" | grep -qE 'git[[:space:]]+([^&|;]*[[:space:]])?-C[[:space:]]+'; then
    work_dir=$(echo "$search_str" | sed -nE 's/.*-C[[:space:]]+"([^"]+)".*/\1/p')
    if [ -z "$work_dir" ]; then
      work_dir=$(echo "$search_str" | sed -nE 's/.*-C[[:space:]]+([^[:space:]]+).*/\1/p')
    fi
  fi
  if [ -z "$work_dir" ] && echo "$COMMAND" | grep -qE '^[[:space:]]*cd[[:space:]]+'; then
    work_dir=$(echo "$COMMAND" | sed -nE 's/^[[:space:]]*cd[[:space:]]+"?([^"&]+)"?[[:space:]]*&&.*/\1/p')
  fi
  # Trim trailing whitespace
  work_dir="${work_dir%"${work_dir##*[![:space:]]}"}"
  echo "$work_dir"
}

# --- Branch name validation helper ---

validate_branch_name() {
  local subcmd="${1:-}"
  local work_dir
  work_dir=$(detect_work_dir "$subcmd")

  # No explicit -C/cd in the command text — fall back to the Bash tool's
  # actual cwd for this call (reported by the harness on every PreToolUse
  # payload), NOT the hook process's own ambient cwd. A bare `git push`
  # relying on a `cd` from an earlier, separate tool call has no directory
  # hint in $COMMAND at all; substituting the hook's own cwd there validates
  # a completely unrelated repo's branch (#2386).
  if [ -z "$work_dir" ] && [ -n "$HOOK_CWD" ] && [ -d "$HOOK_CWD" ]; then
    work_dir="$HOOK_CWD"
  fi

  local BRANCH=""
  if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then
    BRANCH=$(git -C "$work_dir" rev-parse --abbrev-ref HEAD 2>/dev/null) || true
  fi

  # Still unresolved — we genuinely don't know which repo this command
  # targets. A false deny on valid work (validating an unrelated repo's
  # branch, as happened in #2386) is worse than a missed check here: decline
  # to validate rather than guessing.
  if [ -z "$BRANCH" ]; then
    return 0
  fi

  if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "HEAD" ]; then
    local PATTERN="^(feat|fix|docs|refactor|test|chore|ci|perf|build|release|dependabot|revert)/"
    if [[ ! "$BRANCH" =~ $PATTERN ]]; then
      deny "BLOCKED: Branch '$BRANCH' (resolved from $work_dir) does not match required pattern. Branch names must start with: feat/, fix/, docs/, refactor/, test/, chore/, ci/, perf/, build/, release/, dependabot/, revert/"
    fi
  fi
}

# --- Branch name validation on push ---

if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+push'; then
  validate_branch_name push
fi

# --- Branch name validation on gh pr create ---

if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)gh[[:space:]]+pr[[:space:]]+create'; then
  # `gh pr create` does not use `git -C`; detect_work_dir falls through to the
  # `cd` path or cwd. No subcommand hint to pass.
  validate_branch_name
fi

# --- Block AI attribution in commit messages ---

if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+commit'; then
  if echo "$COMMAND" | grep -qiE 'co-authored-by:.*claude|co-authored-by:.*anthropic|generated with claude|generated with \[claude|built with claude|claude\.ai'; then
    deny "BLOCKED: Remove AI attribution lines (Co-Authored-By with Claude/Anthropic, 'Generated with Claude', 'Built with Claude', claude.ai URLs) from the commit message."
  fi
  # Extract -F <file> or --file=<file> or --file <file> (all equivalent git commit forms)
  MSG_FILE=$(echo "$COMMAND" | grep -oE '\-F[[:space:]]+[^[:space:]]+' | awk '{print $2}' || true)
  if [ -z "$MSG_FILE" ]; then
    MSG_FILE=$(echo "$COMMAND" | grep -oE '\-\-file=[^[:space:]]+' | sed 's/--file=//' || true)
  fi
  if [ -z "$MSG_FILE" ]; then
    MSG_FILE=$(echo "$COMMAND" | grep -oE '\-\-file[[:space:]]+[^[:space:]]+' | awk '{print $2}' || true)
  fi
  if [ -n "$MSG_FILE" ] && [ -f "$MSG_FILE" ]; then
    if grep -qiE 'co-authored-by:.*claude|co-authored-by:.*anthropic|generated with claude|generated with \[claude|built with claude|claude\.ai' "$MSG_FILE"; then
      deny "BLOCKED: Remove AI attribution lines from the commit message file '$MSG_FILE'."
    fi
  fi
fi

# --- Commit validation against edit log ---

if echo "$NCOMMAND" | grep -qE '(^|[[:space:]]|&&[[:space:]]*)git[[:space:]]+commit'; then
  # Resolve the target worktree so the edit log and staged-file listing come
  # from the same repo the commit targets (e.g. `git -C <pr-worktree> commit`).
  WORK_DIR=$(detect_work_dir commit)

  # No explicit -C/cd in the command text — fall back to the Bash tool's
  # actual cwd for this call (reported by the harness on every PreToolUse
  # payload), NOT the hook process's own ambient cwd. A bare
  # `git commit <files> -m "msg"` relying on a `cd` from an earlier, separate
  # tool call has no directory hint in $COMMAND at all; substituting the
  # hook's own cwd there resolves the edit-log check against a completely
  # unrelated repo (#2526, the same root cause #2386 fixed for
  # validate_branch_name).
  if [ -z "$WORK_DIR" ] && [ -n "$HOOK_CWD" ] && [ -d "$HOOK_CWD" ]; then
    WORK_DIR="$HOOK_CWD"
  fi

  MERGE_IN_PROGRESS=false
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    PROJECT_DIR=$(git -C "$WORK_DIR" rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
    STAGED_FILES=$(git -C "$WORK_DIR" diff --cached --name-only 2>/dev/null) || true
    git -C "$WORK_DIR" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1 && MERGE_IN_PROGRESS=true
  else
    PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
    STAGED_FILES=$(git diff --cached --name-only 2>/dev/null) || true
    git rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1 && MERGE_IN_PROGRESS=true
  fi

  # A merge in progress (MERGE_HEAD present) stages every auto-merged file from
  # the incoming branch alongside any manually resolved conflicts — not just
  # files this session edited via tools. git also structurally refuses a
  # partial-pathspec `git commit <files>` while MERGE_HEAD exists ("cannot do
  # a partial commit during a merge"), so the edit-log check's own suggested
  # workaround is impossible here. Skip only the edit-log validation for merge
  # commits — scoped to this `if`, not an early `exit 0`, so any commit-time
  # check added below in the future still runs for merge commits too.
  #
  # `rev-parse --verify` (not a bare file-existence test) requires MERGE_HEAD
  # to resolve to a real object in this repo's object database, so a stray or
  # hand-crafted file at that path can't be used to fake a merge and bypass
  # the check below.
  if [ "$MERGE_IN_PROGRESS" = false ]; then
    LOG_FILE="$PROJECT_DIR/.claude/session-edits.log"

    # If no edit log exists, allow (backward compat for sessions without tracking)
    if [ ! -f "$LOG_FILE" ] || [ ! -s "$LOG_FILE" ]; then
      exit 0
    fi

    # Get unique edited files from log
    EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)

    if [ -z "$STAGED_FILES" ]; then
      exit 0
    fi

    # Find staged files that weren't edited in this session
    UNEXPECTED=""
    while IFS= read -r staged_file; do
      if ! echo "$EDITED_FILES" | grep -qxF "$staged_file"; then
        UNEXPECTED="${UNEXPECTED:+$UNEXPECTED, }$staged_file"
      fi
    done <<< "$STAGED_FILES"

    if [ -n "$UNEXPECTED" ]; then
      deny "BLOCKED: These staged files were NOT edited in this session: $UNEXPECTED. They may belong to another session. Commit only your files: git commit <your-files> -m \"msg\""
    fi
  fi
fi

exit 0
