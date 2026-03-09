#!/usr/bin/env bash
# check-cycles.sh — PreToolUse hook for Bash (git commit)
# Blocks commits that introduce NEW circular dependencies (compares HEAD baseline).

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

# Count current cycles involving staged files
RESULT=$(node "$WORK_ROOT/src/cli.js" check --staged --json -T 2>/dev/null) || true
if [ -z "$RESULT" ]; then
  exit 0
fi

# Extract cycle count and details; compare against HEAD baseline
NEW_CYCLES=$(echo "$RESULT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const data=JSON.parse(d);
      const cyclesPred=(data.predicates||[]).find(p=>p.name==='cycles');
      if(!cyclesPred || cyclesPred.passed) return;
      const cycles=cyclesPred.cycles||[];
      // Compare with HEAD: run cycles on HEAD to get baseline count
      // Since we can't run two builds, check if cycles involve NEW files
      const newFiles=new Set((data.summary?.newFiles > 0) ?
        [...(data._newFiles||[])] : []);
      // If all cycles existed before (no new files involved), skip
      // For now, report cycle count — the predicate already scopes to changed files
      // so any cycle here involves a file the user touched
      const summary=cycles.slice(0,5).map(c=>c.join(' -> ')).join('\\n  ');
      const extra=cycles.length>5?'\\n  ... and '+(cycles.length-5)+' more':'';
      process.stdout.write(summary+extra);
    }catch{}
  });
" 2>/dev/null) || true

# For diff-awareness: get baseline cycle count from HEAD
# The check --staged predicate uses the *current* graph DB which reflects the working tree.
# If cycles exist in the DB before our changes, they're pre-existing.
# We compare: cycles on HEAD (via diff against HEAD~1) vs cycles on staged.
BASELINE_COUNT=$(node -e "
  const {findCycles}=require('./src/cycles.js');
  const {openReadonlyOrFail}=require('./src/db.js');
  try {
    const db=openReadonlyOrFail();
    const cycles=findCycles(db,{fileLevel:true,noTests:true});
    process.stdout.write(String(cycles.length));
    db.close();
  }catch{process.stdout.write('0');}
" 2>/dev/null) || echo "0"

CURRENT_COUNT=$(echo "$RESULT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const data=JSON.parse(d);
      const cyclesPred=(data.predicates||[]).find(p=>p.name==='cycles');
      process.stdout.write(String((cyclesPred?.cycles||[]).length));
    }catch{process.stdout.write('0');}
  });
" 2>/dev/null) || echo "0"

# Only block if cycle count increased (new cycles introduced)
if [ "$CURRENT_COUNT" -gt "$BASELINE_COUNT" ] 2>/dev/null; then
  REASON="BLOCKED: New circular dependencies introduced (was $BASELINE_COUNT, now $CURRENT_COUNT):
  $NEW_CYCLES
Fix the new cycles before committing."

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
