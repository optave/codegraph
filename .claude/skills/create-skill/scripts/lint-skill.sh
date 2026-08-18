#!/usr/bin/env bash
# lint-skill.sh — Static analysis for SKILL.md files
# Catches the most common issues found in 250+ Greptile review comments.
# Exit 0 = warnings only, Exit 1 = errors found.
#
# Performance note: all inner-loop checks use bash builtins ([[ =~ ]], case,
# parameter expansion) instead of echo|grep subshells. This keeps runtime
# under 5 s even on Windows, where process creation is ~100x slower than Linux.

set -euo pipefail

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "lint-skill.sh requires bash 4+ (for associative arrays). On macOS: brew install bash" >&2
  exit 1
fi

SKILL_FILE="${1:?Usage: lint-skill.sh <path-to-SKILL.md>}"

if [ ! -f "$SKILL_FILE" ]; then
  echo "ERROR: File not found: $SKILL_FILE"
  exit 1
fi

ERRORS=0
WARNINGS=0

error() { echo "ERROR: $1"; ERRORS=$((ERRORS + 1)); }
warn()  { echo "WARN:  $1"; WARNINGS=$((WARNINGS + 1)); }

# ── Check 1: Cross-fence variable usage ──────────────────────────────
# Extract bash blocks (skip quadruple-backtick example regions) and check
# if UPPER_CASE variables assigned in one block are referenced in a later
# block without file-based persistence.
# Trailing X's only (no suffix) — BSD mktemp (macOS) only randomizes a
# trailing X run; a suffix after it (e.g. ".blocks") returns the template
# literally instead of a unique path (issue #2157). The extension isn't
# load-bearing here (this file is only ever grepped/awked, never dispatched
# by codegraph's extension-based language detection).
BLOCKS_FILE=$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXXXX")
trap 'rm -f "$BLOCKS_FILE"' EXIT

# Extract bash blocks with block index, skipping those inside ```` regions.
# Patterns use ^[[:space:]]* to match indented blocks (e.g. inside Markdown list items).
awk '
  /^[[:space:]]*````/       { quad = !quad; next }
  quad                       { next }
  /^[[:space:]]*```bash/    { inblock = 1; blocknum++; next }
  /^[[:space:]]*```/ && inblock { inblock = 0; next }
  inblock                   { print blocknum "\t" $0 }
' "$SKILL_FILE" > "$BLOCKS_FILE"

# Collect variable assignments per block and build reassignment lookup (O(1) per check)
declare -A VAR_BLOCK
declare -A REASSIGNED
register_var() {
  local var="$1" bnum="$2"
  if [ -z "${VAR_BLOCK[$var]+x}" ]; then
    VAR_BLOCK["$var"]="$bnum"
  else
    # Track re-assignments in later blocks for O(1) lookup
    REASSIGNED["${var}:${bnum}"]=1
  fi
}
# Finds every UPPER_CASE_VAR=/VAR+= assignment on a line using pure bash
# builtins ([[ =~ ]] + parameter expansion) rather than forking echo|grep|sed
# per line. This loop runs once per non-comment bash-block line — for a large
# SKILL.md (fixer/SKILL.md is ~850 such lines) a per-line subprocess pipeline
# is a few seconds on macOS/Linux but can blow well past CI's default test
# timeout on Windows, where process creation is ~100x slower (see this
# file's own performance note above; discovered via PR #2490/#2344 once a
# test exercised lint-skill.sh against this specific large file directly).
collect_assignments() {
  local s="$1" bnum="$2"
  while [[ "$s" =~ (^|[^A-Za-z0-9_])([A-Z][A-Z0-9_]+)\+?= ]]; do
    register_var "${BASH_REMATCH[2]}" "$bnum"
    s="${s#*"${BASH_REMATCH[0]}"}"
  done
}
# Strips a trailing, unquoted `# comment` from a read command's argument
# text. A `#` is only a genuine shell comment when it isn't inside an open
# double-quoted string, so this walks the string quote-span by quote-span
# (checking for `#` only in the text BETWEEN quotes) rather than scanning
# for the first `#` outright (#2491 Greptile round 3: `read -r NUM < f
# # MAX_LIMIT` left `# MAX_LIMIT` for the destination grep to pick up
# `MAX_LIMIT` as a spurious destination).
strip_trailing_comment() {
  local s="$1" out="" seg
  while [[ "$s" == *'"'* ]]; do
    seg="${s%%\"*}"
    if [[ "$seg" == *'#'* ]]; then
      printf '%s' "${out}${seg%%#*}"
      return
    fi
    out+="${seg}\""
    s="${s#*\"}"
    seg="${s%%\"*}"
    out+="${seg}\""
    s="${s#*\"}"
  done
  if [[ "$s" == *'#'* ]]; then
    printf '%s' "${out}${s%%#*}"
  else
    printf '%s' "${out}${s}"
  fi
}
# Consumes EVERY redirection clause (operator + target) from read_args,
# regardless of how many there are or where they fall among read's other
# arguments, populating two caller-local outputs via dynamic scoping (the
# caller must `local` these two names before calling):
#   READ_DEST_ARGS    — read_args with every redirection clause removed,
#                        leaving only flags and genuine destinations
#   READ_INPUT_TARGETS — every redirection's target, space-joined
# A quoted target (double OR single) is consumed in full regardless of
# embedded whitespace, so a multiword single-quoted operand like
# `<<< 'FOO BAZ'` doesn't leave `BAZ'` dangling for the destination grep
# (#2491 Greptile round 3), and EVERY redirect on the line participates —
# not just the first — since `read` permits more than one input
# redirection syntactically and each target could independently reference
# a stale variable (#2491 Greptile round 3: `read -r FOO < "$CONFIG" <<<
# "$FOO"` — the later here-string must still be checked for self-reference).
split_read_redirects() {
  local args="$1" op op_core after target inner remaining
  READ_DEST_ARGS="$args"
  READ_INPUT_TARGETS=""
  READ_HERE_TARGETS=""
  while [[ "$READ_DEST_ARGS" =~ (\<{1,3}[[:space:]]*) ]]; do
    op="${BASH_REMATCH[1]}"
    op_core="${op%%[[:space:]]*}"
    after="${READ_DEST_ARGS#*"$op"}"
    case "$after" in
      \"*)
        inner="${after#\"}"
        inner="${inner%%\"*}"
        target="\"${inner}\""
        remaining="${after#*\"}"
        remaining="${remaining#*\"}"
        ;;
      \'*)
        inner="${after#\'}"
        inner="${inner%%\'*}"
        target="'${inner}'"
        remaining="${after#*\'}"
        remaining="${remaining#*\'}"
        ;;
      *)
        target="${after%%[[:space:]]*}"
        if [[ "$after" == *[[:space:]]* ]]; then
          remaining="${after#*[[:space:]]}"
        else
          remaining=""
        fi
        ;;
    esac
    READ_INPUT_TARGETS+="${target} "
    # `<<`/`<<<` (heredoc/here-string) feed an IN-MEMORY value, never a
    # file — tracked separately so has_file_redirect_in's file-persistence
    # exemption can require $var's reference to come from a genuine
    # single-`<` target, not from a same-line `<<<` sitting alongside an
    # unrelated file redirect (#2491 Greptile round 3: `read -r FOO <
    # "$CONFIG" <<< "$FOO"` — the file redirect on $CONFIG must not exempt
    # the separate, genuine here-string leak of $FOO).
    if [ "${#op_core}" -ge 2 ]; then
      READ_HERE_TARGETS+="${target} "
    fi
    READ_DEST_ARGS="${READ_DEST_ARGS%%"$op"*}${remaining}"
  done
}
# Extracts the destination variable name(s) actually bound by a `read ...`
# command on a line (e.g. `read -r VAR1 VAR2`) — one per output line via
# stdout — stripping everything that ISN'T a real destination first:
#   - a trailing command on the same line (`; do`)
#   - a trailing unquoted comment (`# ...`)
#   - every input source (`< file`, `<<< "$X"` here-strings), from
#     anywhere in the argument list, not just a trailing truncation
#   - quoted option arguments (`-p "prompt text"`, which may contain
#     arbitrary uppercase words that aren't destinations at all)
#   - a value-taking flag's own argument (`-t 5`, `-u FD`, `-d ':'`,
#     `-i "initial text"`, and combined short forms like `-ei FOO`, where
#     `-e` takes no argument but the trailing `-i` does — every read flag
#     EXCEPT `-a` (whose argument is itself a genuine destination: the
#     array read into), so the strip only fires when the cluster's LAST
#     letter is one of the other value-taking flags
#   - a `$`-prefixed token, which REFERENCES a var rather than binding it
# Shared by collect_assignments's registration pass and the cross-fence
# reference check's read-exemption (#2491) so both agree on what a `read`
# line actually binds.
extract_read_dest_vars() {
  local line="$1"
  [[ "$line" =~ (^|[^A-Za-z0-9_])read([[:space:]].*)?$ ]] || return 0
  local read_args="${BASH_REMATCH[2]}"
  read_args="${read_args%%;*}"
  read_args=$(strip_trailing_comment "$read_args")
  local READ_DEST_ARGS READ_INPUT_TARGETS
  split_read_redirects "$read_args"
  read_args="$READ_DEST_ARGS"
  read_args=$(printf '%s' "$read_args" | sed -E 's/"[^"]*"//g' | sed -E "s/'[^']*'//g")
  read_args=$(printf '%s' "$read_args" | sed -E 's/-[a-zA-Z]*[ptnNdui][[:space:]]+[^[:space:]]+//g')
  printf '%s' "$read_args" | grep -oE '(^|[^A-Za-z0-9_$])[A-Z][A-Z0-9_]+' | sed -E 's/^[^A-Za-z0-9_]//'
}
# Whether $var is one of the destination variables a `read` on this line
# actually binds — as opposed to merely appearing somewhere else on the
# line (e.g. as a here-string/redirection INPUT to that same read, which is
# a genuine cross-fence reference, not a rebinding).
is_read_dest_of_line() {
  local var="$1" line="$2" dest
  while IFS= read -r dest; do
    [ "$dest" = "$var" ] && return 0
  done < <(extract_read_dest_vars "$line")
  return 1
}
# Extracts every TARGET of a `read` line's input redirections, space-joined
# (e.g. `"$FOO"` for `read -r BAR <<< "$FOO"`), via the same
# split_read_redirects used by extract_read_dest_vars so both agree on
# where the redirections are. Empty output if the line has none at all
# (e.g. `read -p "..." VAR`).
extract_read_input() {
  local line="$1"
  [[ "$line" =~ (^|[^A-Za-z0-9_])read([[:space:]].*)?$ ]] || return 0
  local read_args="${BASH_REMATCH[2]}"
  read_args="${read_args%%;*}"
  local READ_DEST_ARGS READ_INPUT_TARGETS READ_HERE_TARGETS
  split_read_redirects "$read_args"
  printf '%s' "$READ_INPUT_TARGETS"
}
# Extracts only the HERE-string/heredoc (`<<`, `<<<`) targets of a `read`
# line, excluding genuine single-`<` file targets — the in-memory subset of
# extract_read_input, used where a mix of a real file redirect and an
# in-memory here-string on the SAME line must be told apart (#2491 Greptile
# round 3).
extract_read_here_input() {
  local line="$1"
  [[ "$line" =~ (^|[^A-Za-z0-9_])read([[:space:]].*)?$ ]] || return 0
  local read_args="${BASH_REMATCH[2]}"
  read_args="${read_args%%;*}"
  local READ_DEST_ARGS READ_INPUT_TARGETS READ_HERE_TARGETS
  split_read_redirects "$read_args"
  printf '%s' "$READ_HERE_TARGETS"
}
# Whether $var (as $var, not the bare destination name) appears in this
# line's own `read` input clause — the here-string/redirect operand, not
# the destination it binds.
is_read_input_of_line() {
  local var="$1" line="$2" input
  input=$(extract_read_input "$line")
  [ -n "$input" ] && [[ "$input" =~ \$\{?${var}\}?([^A-Za-z0-9_]|$) ]]
}
# Whether $var appears specifically within a here-string/heredoc target on
# this `read` line, as opposed to a genuine single-`<` file target — used
# to tell apart `read -r FOO < "$CONFIG" <<< "$FOO"`'s two redirects: the
# first is a real (if itself possibly stale) file path, the second is an
# in-memory leak of $FOO that a blanket "this line has a file redirect"
# check must not paper over.
is_read_here_input_of_line() {
  local var="$1" line="$2" input
  input=$(extract_read_here_input "$line")
  [ -n "$input" ] && [[ "$input" =~ \$\{?${var}\}?([^A-Za-z0-9_]|$) ]]
}
# Whether this line both binds $var as a `read` destination AND feeds $var
# into that same read's own input — a same-line self-reference like
# `read -r FOO <<< "$FOO"` genuinely leaks the stale $FOO into itself even
# though FOO is also this line's destination, because the here-string's
# input is evaluated before the destination is rebound. Every OTHER line in
# the block that references $var after this one is still legitimately safe
# (this line does bind a fresh, in-process value) — only this exact line's
# own reference is a leak (Greptile round 1 on PR #2574 for #2491:
# is_read_dest_of_line alone only checks whether $var is *a* destination
# somewhere on the line, not whether the specific $var occurrence that
# triggered the outer reference check is safe, and the block-wide
# REASSIGNED exemption doesn't distinguish this line from later ones).
is_self_referential_read() {
  is_read_dest_of_line "$1" "$2" && is_read_input_of_line "$1" "$2"
}
# Whether $var is a destination this line's `read` binds, WITHOUT also
# being a same-line self-reference (see is_self_referential_read above).
is_read_rebind_exempt() {
  is_read_dest_of_line "$1" "$2" && ! is_self_referential_read "$1" "$2"
}
# Whether $line has a genuine single-`<` file-redirection ("< file",
# "<\"file\"") — as opposed to a `<<<` here-string, which feeds an
# IN-MEMORY value as input (the opposite of reading from a file) but
# contains the same `< `/`<"` substrings a blanket check would wrongly
# treat as file persistence (#2491: `read -r BAR <<< "$FOO"` — $FOO is a
# genuine cross-fence leak, not a file re-derivation, even though the `<<<`
# operator's own text contains a trailing `< `).
has_file_redirect_in() {
  local line="$1"
  [[ "$line" =~ (^|[^\<])\<[[:space:]] ]] || [[ "$line" =~ (^|[^\<])\<\" ]]
}
while IFS=$'\t' read -r bnum line; do
  # Skip comment lines — they document context but don't register variable assignments
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  # Match UPPER_CASE_VAR= assignments (skip lowercase/mixed to reduce false positives)
  collect_assignments "$line" "$bnum"
  # `read`/`read -r VAR1 VAR2` binds variables just like VAR=, but with no '='
  # after the name — e.g. `while IFS=$'\t' read -r F COUNT LINE; do`. Without
  # this, a var re-derived via `read` in a later block (a legitimate, fresh,
  # block-local binding) looks identical to a stale reference to an
  # earlier block's same-named variable, producing a false Pattern-1 error
  # (issue #2344 — fixer/SKILL.md's own I4 integrity check does exactly this
  # with a loop-local $COUNT that collides in name only with the unrelated
  # batch-size $COUNT set up in Phase 0).
  while IFS= read -r var; do
    [ -z "$var" ] && continue
    register_var "$var" "$bnum"
  done < <(extract_read_dest_vars "$line")
done < "$BLOCKS_FILE"

# Check for references in later blocks without file persistence
while IFS=$'\t' read -r bnum line; do
  # Skip comment lines — they document context but don't execute variables at runtime
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  for var in "${!VAR_BLOCK[@]}"; do
    assigned_in="${VAR_BLOCK[$var]}"
    if [ "$bnum" -gt "$assigned_in" ]; then
      # Check if this line references the variable ($VAR or ${VAR}) using bash builtins
      if [[ "$line" == *'$'"${var}"* ]] || [[ "$line" == *'${'"${var}"'}'* ]]; then
        # Narrow check: ensure the $VAR reference isn't followed by [A-Za-z0-9_]
        # (which would mean it's a different, longer variable name)
        if [[ "$line" =~ \$${var}([^A-Za-z0-9_]|$) ]] || [[ "$line" == *'${'"${var}"'}'* ]]; then
          # Check if the same block also assigns it (re-assignment is fine) — O(1) lookup.
          # A same-line self-referential read (`read -r FOO <<< "$FOO"`) still forces
          # the deeper check below even though REASSIGNED is set for this block: that
          # flag correctly protects LATER lines referencing the freshly-bound $var, but
          # this exact line's own reference predates the rebind and is still a leak.
          if [ -z "${REASSIGNED[${var}:${bnum}]+x}" ] || is_self_referential_read "$var" "$line"; then
            # Check it's not read from a file (cat, $(...) with cat/read).
            # The `read` case checks that $var is actually THIS line's read
            # destination AND isn't also that same read's own input (a
            # same-line self-reference like `read -r FOO <<< "$FOO"` still
            # leaks the stale value into itself), and the redirection case
            # excludes here-strings (`<<<`) UNLESS $var's own reference is
            # itself the here-string's target — a line can have a genuine
            # single-`<` file redirect ALONGSIDE an unrelated `<<<` leak
            # (`read -r FOO < "$CONFIG" <<< "$FOO"`: the file redirect must
            # not paper over the separate, genuine leak of $FOO) — all were
            # blanket substring/whole-line matches that wrongly exempted a
            # genuine cross-fence leak used as that same line's `read`
            # INPUT (e.g. `read -r BAR <<< "$FOO"`: $FOO is a stale
            # in-memory reference, not a file re-derivation, even though
            # the line contains `read ` and the `<<<` operator's own text
            # contains a trailing `< `) (#2491).
            if [[ "$line" != *'cat '* ]] && ! is_read_rebind_exempt "$var" "$line" && \
               { ! has_file_redirect_in "$line" || is_read_here_input_of_line "$var" "$line"; } && \
               [[ "$line" != *'$(<'* ]]; then
              error "Cross-fence variable: \$$var assigned in bash block $assigned_in, referenced in block $bnum without file persistence (Pattern 1)"
            fi
          fi
        fi
      fi
    fi
  done
done < "$BLOCKS_FILE"

# ── Check 2: Bare 2>/dev/null without justification ─────────────────
line_num=0
in_quad=false
in_block=false
prev_line=""
while IFS= read -r line; do
  line_num=$((line_num + 1))
  stripped="${line#"${line%%[! ]*}"}"
  case "$stripped" in
    '````'*) if $in_quad; then in_quad=false; else in_quad=true; fi; prev_line="$line"; continue ;;
  esac
  $in_quad && { prev_line="$line"; continue; }
  case "$stripped" in
    '```bash'*) in_block=true; prev_line="$line"; continue ;;
    '```'*) in_block=false; prev_line="$line"; continue ;;
  esac
  if $in_block; then
    if [[ "$line" =~ 2\>[[:space:]]*/dev/null ]] || [[ "$line" =~ \>[[:space:]]*/dev/null[[:space:]]+2\>\&1 ]] || [[ "$line" == *'&>/dev/null'* ]]; then
      # Check same line or previous line for justification comment (case-insensitive via ,, lowercasing)
      combined="${prev_line}${line}"
      combined_lower="${combined,,}"
      if [[ "$combined_lower" != *'# '* ]] || {
        [[ "$combined_lower" != *'#'*'intentional'* ]] &&
        [[ "$combined_lower" != *'#'*'tolera'* ]] &&
        [[ "$combined_lower" != *'#'*'acceptable'* ]] &&
        [[ "$combined_lower" != *'#'*'expected'* ]] &&
        [[ "$combined_lower" != *'#'*'safe to ignore'* ]] &&
        [[ "$combined_lower" != *'#'*'may fail'* ]] &&
        [[ "$combined_lower" != *'#'*'optional'* ]] &&
        [[ "$combined_lower" != *'#'*'fallback'* ]] &&
        [[ "$combined_lower" != *'#'*'portable'* ]] &&
        [[ "$combined_lower" != *'#'*'suppress'* ]] &&
        [[ "$combined_lower" != *'#'*'provid'* ]]; }; then
        warn "Line $line_num: '2>/dev/null' without justification comment (Pattern 2)"
      fi
    fi
  fi
  prev_line="$line"
done < "$SKILL_FILE"

# ── Check 3: git add . or git add -A (inside bash blocks only) ───────
while IFS=$'\t' read -r bnum line; do
  if [[ "$line" =~ ^[[:space:]]*git[[:space:]]+add[[:space:]]+(--[[:space:]]+\.|\.|-A|--all)([[:space:]\;\#]|$) ]]; then
    error "bash block $bnum: 'git add .' or 'git add -A' — stage named files only"
  fi
done < "$BLOCKS_FILE"

# ── Check 4: Hardcoded npm test / npm run lint ───────────────────────
# Only flag if not inside an if/elif detection block
line_num=0
in_quad=false
in_block=false
in_detect=false
detect_depth=0
while IFS= read -r line; do
  line_num=$((line_num + 1))
  stripped="${line#"${line%%[! ]*}"}"
  case "$stripped" in
    '````'*) if $in_quad; then in_quad=false; else in_quad=true; fi; continue ;;
  esac
  $in_quad && continue
  case "$stripped" in
    '```bash'*) in_block=true; in_detect=false; detect_depth=0; continue ;;
    '```'*) in_block=false; in_detect=false; detect_depth=0; continue ;;
  esac
  if $in_block; then
    # Track if we're inside an if/elif chain (detection block) with depth.
    # Only `if` increments depth; `elif` is a sibling branch of the same if-statement,
    # not a new nesting level, so it sets in_detect but does NOT increment depth.
    # Save in_detect before fi-processing so inline commands on the same line
    # (e.g. "else npm test; fi") are evaluated in the correct detection context.
    was_in_detect=$in_detect
    if [[ "$line" =~ ^[[:space:]]*if[[:space:]] ]] && [[ "$line" =~ (-f[[:space:]]|-d[[:space:]]|lock|package|command\ -v|which[[:space:]]|find[[:space:]]) ]]; then
      in_detect=true
      was_in_detect=true
      # Only increment depth if fi does NOT also close on this line (one-liner guard)
      if [[ "$line" =~ (^|[^A-Za-z0-9_])fi([^A-Za-z0-9_]|$) ]]; then
        # One-liner: detection block is self-contained — reset so subsequent lines are checked normally
        in_detect=false
      else
        detect_depth=$((detect_depth + 1))
      fi
    elif [[ "$line" =~ ^[[:space:]]*elif[[:space:]] ]] && [[ "$line" =~ (-f[[:space:]]|-d[[:space:]]|lock|package|command\ -v|which[[:space:]]|find[[:space:]]) ]]; then
      # elif is a sibling branch — set in_detect but do NOT increment depth
      in_detect=true
      was_in_detect=true
      # Handle inline fi on this same elif line (e.g. "elif [ -f yarn.lock ]; then CMD=yarn; fi")
      if [[ "$line" =~ (^|[^A-Za-z0-9_])fi([^A-Za-z0-9_]|$) ]]; then
        if [ "$detect_depth" -gt 0 ]; then
          detect_depth=$((detect_depth - 1))
          [ "$detect_depth" -eq 0 ] && in_detect=false
        else
          in_detect=false
        fi
      fi
    elif [[ "$line" =~ ^[[:space:]]*if([^A-Za-z0-9_]|$) ]]; then
      # nested if (not a detection block) — track depth only when inside detection
      [ "$in_detect" = true ] && detect_depth=$((detect_depth + 1))
    elif [[ "$line" =~ ^[[:space:]]*fi([^A-Za-z0-9_]|$) ]]; then
      if [ "$detect_depth" -gt 0 ]; then
        detect_depth=$((detect_depth - 1))
        [ "$detect_depth" -eq 0 ] && in_detect=false
      else
        # Safety reset: in_detect was set by an elif without a preceding detection if
        in_detect=false
      fi
    elif $in_detect && [[ "$line" =~ (^|[^A-Za-z0-9_])fi([^A-Za-z0-9_]|$) ]]; then
      # fi appears inline (e.g. "else ...; fi") — still closes the outermost detection block
      if [ "$detect_depth" -gt 0 ]; then
        detect_depth=$((detect_depth - 1))
        [ "$detect_depth" -eq 0 ] && in_detect=false
      else
        in_detect=false
      fi
    fi
    # Use was_in_detect so commands on the same line as an inline fi
    # (e.g. "else npm test; fi") are not falsely flagged — the command
    # was part of the detection block, not after it.
    if ! $was_in_detect; then
      if [[ "$line" =~ ^[[:space:]]*((npm|yarn|pnpm)\ test|(npm|yarn|pnpm)\ run\ (test|lint))([^:A-Za-z0-9_-]|$) ]]; then
        trimmed="${line#"${line%%[! ]*}"}"
        warn "Line $line_num: Hardcoded '$trimmed' — detect package manager first (Pattern 6)"
      fi
    fi
  fi
done < "$SKILL_FILE"

# ── Check 5: sed -i without .bak (inside bash blocks only) ──────────
while IFS=$'\t' read -r bnum line; do
  if [[ "$line" =~ sed[[:space:]]+-i[[:space:]]*(\'\'|\"|[^.]) ]]; then
    warn "bash block $bnum: 'sed -i' without .bak extension — GNU/BSD incompatibility (Pattern 13)"
  fi
done < "$BLOCKS_FILE"

# ── Check 6: Missing frontmatter fields ─────────────────────────────
for field in name description argument-hint allowed-tools; do
  if ! head -20 "$SKILL_FILE" | grep -qE "^${field}:"; then
    error "Missing frontmatter field: '$field'"
  fi
done

# ── Check 7: Missing Phase 0 ────────────────────────────────────────
if ! grep -qE '^## Phase 0' "$SKILL_FILE"; then
  error "Missing '## Phase 0' heading — every skill needs pre-flight checks"
fi

# ── Check 8: Missing Rules section ───────────────────────────────────
if ! grep -qE '^## Rules' "$SKILL_FILE"; then
  error "Missing '## Rules' section"
fi

# ── Check 8b: Missing Examples section ──────────────────────────────
if ! grep -qE '^## Examples' "$SKILL_FILE"; then
  error "Missing '## Examples' section — every skill needs 2-3 usage examples"
fi

# ── Check 6b: name field matches directory name ─────────────────────
expected_name=$(basename "$(dirname "$SKILL_FILE")")
actual_name=$(head -20 "$SKILL_FILE" | grep -m1 '^name:' | sed 's/^name:[[:space:]]*//')
if [ -n "$actual_name" ] && [ "$actual_name" != "$expected_name" ]; then
  error "Frontmatter 'name: $actual_name' does not match directory name '$expected_name' (Phase 4 checklist item 2)"
fi

# ── Check 9: Missing exit conditions between phases ──────────────────
prev_phase=""
phase_has_exit=true
in_quad=false
in_block=false
while IFS= read -r line; do
  stripped="${line#"${line%%[! ]*}"}"
  # Skip content inside quadruple-backtick example regions
  case "$stripped" in
    '````'*) if $in_quad; then in_quad=false; else in_quad=true; fi; continue ;;
  esac
  $in_quad && continue
  # Skip content inside triple-backtick code blocks.
  # Limitation: nested fences inside ```markdown blocks (e.g. scaffold templates
  # containing ```bash examples) will toggle in_block incorrectly. Wrap such
  # regions in quadruple-backtick ```` fences to avoid false positives.
  case "$stripped" in
    '```'*) if $in_block; then in_block=false; else in_block=true; fi; continue ;;
  esac
  $in_block && continue

  if [[ "$line" =~ ^##\ Phase\ [0-9]+ ]]; then
    if [ -n "$prev_phase" ] && [ "$phase_has_exit" = false ]; then
      warn "Phase '$prev_phase' has no 'Exit condition' before the next phase"
    fi
    prev_phase="$line"
    phase_has_exit=false
  fi
  if [[ "${line,,}" == *'**exit condition'* ]]; then
    phase_has_exit=true
  fi
done < "$SKILL_FILE"
# Check last phase
if [ -n "$prev_phase" ] && [ "$phase_has_exit" = false ]; then
  warn "Phase '$prev_phase' has no 'Exit condition'"
fi

# ── Check 10: find with -quit (inside bash blocks only) ──────────────
while IFS=$'\t' read -r bnum line; do
  if [[ "$line" =~ find[[:space:]].*-quit ]]; then
    warn "bash block $bnum: 'find -quit' is GNU-only — use 'head -1' or 'grep -q' instead (Pattern 13)"
  fi
done < "$BLOCKS_FILE"

# ── Check 10b: mktemp template with a non-trailing X run (issue #2157) ──
# BSD mktemp (macOS) only randomizes a TRAILING run of X's — a suffix
# directly after it (tmp.XXXXXXXXXX.ext) returns the template literally
# instead of creating a unique path, causing silent collisions across
# concurrent runs and "File exists" failures on re-runs. Matches any X{6,}
# run immediately followed by something other than another X, a closing
# quote/paren, or whitespace.
while IFS=$'\t' read -r bnum line; do
  if [[ "$line" =~ mktemp ]] && [[ "$line" =~ X{6,}[^X\"\'\ \)] ]]; then
    warn "bash block $bnum: mktemp template's X run is not trailing — BSD mktemp (macOS) won't randomize it; use a trailing-X template, or mktemp -d a directory and place the named/extensioned file inside it (Pattern 3/13)"
  fi
done < "$BLOCKS_FILE"

# ── Check 11: Hardcoded /tmp/ paths ─────────────────────────────────
line_num=0
in_quad=false
in_block=false
while IFS= read -r line; do
  line_num=$((line_num + 1))
  lstripped="${line#"${line%%[! ]*}"}"
  case "$lstripped" in
    '````'*) if $in_quad; then in_quad=false; else in_quad=true; fi; continue ;;
  esac
  $in_quad && continue
  case "$lstripped" in
    '```bash'*) in_block=true; continue ;;
    '```'*) in_block=false; continue ;;
  esac
  if $in_block; then
    # Skip comment lines — they document context and don't represent runtime paths
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    # Strip shell comments (# preceded by whitespace) but not # inside strings
    stripped="${line%%[[:space:]]#*}"
    if [[ "$stripped" =~ (^|[^A-Za-z0-9_])/tmp/[a-zA-Z] ]]; then
      # Allow ${TMPDIR:-/tmp} pattern
      if [[ "$stripped" != *'${TMPDIR:-/tmp}'* ]]; then
        warn "Line $line_num: Hardcoded '/tmp/' path — use mktemp instead (Pattern 4)"
      fi
    fi
  fi
done < "$SKILL_FILE"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "lint-skill: $ERRORS error(s), $WARNINGS warning(s)"
if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi
exit 0
