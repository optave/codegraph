#!/usr/bin/env bash
# update-graph.sh — PostToolUse hook for Edit and Write tools
# Incrementally updates the codegraph after source file edits.
# On the first edit of a stale session (no full rebuild in >24h), upgrades
# to a full rebuild so complexity/dataflow/cohesion data stays fresh.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

INPUT=$(cat)

# Extract file path and normalize backslashes — all in node to avoid
# bash backslash issues on Windows/Git Bash
FILE_PATH=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=(JSON.parse(d).tool_input?.file_path||'').replace(/\\\\/g,'/');
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only rebuild for source files codegraph tracks
# Skip docs, configs, test fixtures, and non-code files
case "$FILE_PATH" in
  *.js|*.ts|*.tsx|*.jsx|*.py|*.go|*.rs|*.java|*.cs|*.php|*.rb|*.tf|*.hcl)
    ;;
  *)
    exit 0
    ;;
esac

# Skip test fixtures — they're copied to tmp dirs anyway
if echo "$FILE_PATH" | grep -qE '(fixtures|__fixtures__|testdata)/'; then
  exit 0
fi

# Guard: codegraph DB must exist (project has been built at least once)
PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
DB_PATH="$PROJECT_DIR/.codegraph/graph.db"
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# --- Staleness check ---
# If no full rebuild has happened in >24h, upgrade this one build to
# --no-incremental so complexity/dataflow/cohesion are recomputed for
# all files. Subsequent edits in the same session stay incremental.
# See docs/guides/incremental-builds.md for what incremental skips.
MARKER="$PROJECT_DIR/.codegraph/last-full-build"
BUILD_FLAGS=""
STALE_SECONDS=86400  # 24 hours

if [ ! -f "$MARKER" ]; then
  # No marker = never had a tracked full rebuild — do one now
  BUILD_FLAGS="--no-incremental"
else
  # Check marker age (cross-platform: use node for reliable epoch math)
  MARKER_AGE=$(node -e "
    const fs = require('fs');
    try {
      const mtime = fs.statSync('${MARKER//\\/\\\\}').mtimeMs;
      console.log(Math.floor((Date.now() - mtime) / 1000));
    } catch { console.log('999999'); }
  " 2>/dev/null) || MARKER_AGE=999999

  if [ "$MARKER_AGE" -gt "$STALE_SECONDS" ]; then
    BUILD_FLAGS="--no-incremental"
  fi
fi

# Run the build. Stderr is captured (not discarded) so a failure has a
# diagnosable trail instead of silently no-oping — npx can fail for reasons
# outside your project (no network, registry down, wrong/missing package),
# and a bare 2>/dev/null + `|| true` used to give no signal at all that
# graph auto-rebuild wasn't active (issue #2302, same pattern #2074 applied
# to this repo's own copy of this hook).
BUILD_OK=0
BUILD_ERR=""
if command -v codegraph &>/dev/null; then
  BUILD_ERR=$(codegraph build "$PROJECT_DIR" -d "$DB_PATH" $BUILD_FLAGS 2>&1 1>/dev/null) && BUILD_OK=1 || true
else
  BUILD_ERR=$(npx --yes @optave/codegraph build "$PROJECT_DIR" -d "$DB_PATH" $BUILD_FLAGS 2>&1 1>/dev/null) && BUILD_OK=1 || true
fi

if [ "$BUILD_OK" -eq 0 ]; then
  echo "[codegraph] graph rebuild failed (first line: $(printf '%s\n' "$BUILD_ERR" | head -1))" >&2
fi

# Update marker only if we did a full rebuild AND it succeeded
if [ -n "$BUILD_FLAGS" ] && [ "$BUILD_OK" -eq 1 ]; then
  mkdir -p "$(dirname "$MARKER")"
  touch "$MARKER"
fi

exit 0
