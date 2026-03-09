#!/usr/bin/env bash
# Block PR creation if the body contains "generated with" (case-insensitive)

input="$CLAUDE_TOOL_INPUT"

# Only check gh pr create commands — extract just the command field to avoid
# false positives on the description field (greptile review feedback)
cmd=$(echo "$input" | jq -r '.command // ""')
echo "$cmd" | grep -qi 'gh pr create' || exit 0

# Block if body contains "generated with"
if echo "$cmd" | grep -qi 'generated with'; then
  echo "BLOCK: Remove any 'Generated with ...' line from the PR body." >&2
  exit 2
fi
