#!/usr/bin/env bash
# Block PR creation if the body contains "generated with" (case-insensitive)

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

# Only check gh pr create commands
echo "$COMMAND" | grep -qi 'gh pr create' || exit 0

# Check inline --body for "generated with"
if echo "$COMMAND" | grep -qi 'generated with'; then
  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: \"Remove any 'Generated with ...' line from the PR body.\"
      }
    }));
  "
  exit 0
fi

# Check --body-file content for "generated with"
BODY_FILE=$(echo "$COMMAND" | grep -oP '(?<=--body-file\s)[^\s]+' 2>/dev/null) || true
if [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ]; then
  if grep -qi 'generated with' "$BODY_FILE"; then
    node -e "
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: \"Remove any 'Generated with ...' line from the PR body.\"
        }
      }));
    "
    exit 0
  fi
fi
