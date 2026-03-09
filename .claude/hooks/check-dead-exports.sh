#!/usr/bin/env bash
# check-dead-exports.sh — PreToolUse hook for Bash (git commit)
# Blocks commits that introduce NEW unused exports in staged files.
# Compares against the pre-change state so pre-existing dead exports are ignored.

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

# Only trigger on git commit commands
if ! echo "$COMMAND" | grep -qE '(^|\s|&&\s*)git\s+commit\b'; then
  exit 0
fi

# Guard: codegraph DB must exist
WORK_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || WORK_ROOT="${CLAUDE_PROJECT_DIR:-.}"
if [ ! -f "$WORK_ROOT/.codegraph/graph.db" ]; then
  exit 0
fi

# Guard: must have staged changes
STAGED=$(git diff --cached --name-only 2>/dev/null) || true
if [ -z "$STAGED" ]; then
  exit 0
fi

# For each staged src/ file, compare current unused count against the
# count from the staged diff's added lines. Only flag truly new dead exports.
NEW_DEAD=""

while IFS= read -r file; do
  # Only check source files
  case "$file" in
    src/*.js|src/*.ts|src/*.tsx) ;;
    *) continue ;;
  esac

  # Get current unused exports for this file
  RESULT=$(node "$WORK_ROOT/src/cli.js" exports "$file" --json -T 2>/dev/null) || true
  if [ -z "$RESULT" ]; then
    continue
  fi

  # Get names of new functions added in the staged diff for this file
  ADDED_NAMES=$(git diff --cached -U0 "$file" 2>/dev/null | grep -E '^\+.*(export\s+(function|const|class|async\s+function)|module\.exports)' | grep -oP '(?:function|const|class)\s+\K\w+' 2>/dev/null) || true

  # If no new exports were added in the diff, skip this file
  if [ -z "$ADDED_NAMES" ]; then
    continue
  fi

  # Check if any of the newly added exports have zero consumers
  NEWLY_DEAD=$(echo "$RESULT" | node -e "
    const added=new Set(process.argv.slice(2));
    let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try {
        const data=JSON.parse(d);
        const dead=(data.results||[])
          .filter(r=>r.consumerCount===0 && added.has(r.name));
        if(dead.length>0){
          process.stdout.write(dead.map(u=>u.name+' ('+data.file+':'+u.line+')').join(', '));
        }
      }catch{}
    });
  " -- $ADDED_NAMES 2>/dev/null) || true

  if [ -n "$NEWLY_DEAD" ]; then
    NEW_DEAD="${NEW_DEAD:+$NEW_DEAD; }$NEWLY_DEAD"
  fi
done <<< "$STAGED"

if [ -n "$NEW_DEAD" ]; then
  REASON="BLOCKED: Newly added exports with zero consumers detected: $NEW_DEAD. Either add consumers, remove the exports, or verify these are intentionally public API."

  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: process.argv[1]
      }
    }));
  " "$REASON"
  exit 0
fi

exit 0
