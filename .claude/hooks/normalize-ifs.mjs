#!/usr/bin/env node
// normalize-ifs.mjs — reads a shell command line from stdin and writes it
// back with every $IFS/${IFS} reference replaced by a single literal space
// (#2451). Bash's own field-splitting on an unquoted $IFS/${IFS} expansion
// produces exactly this effect at execution time — `git${IFS}checkout`
// looks like one token as command TEXT, but Git actually receives
// `checkout` as a separate argument once bash expands it. Every
// verb-detection regex in guard-git.sh (including its own top-level "is
// this even a git/gh command" fast-path filter, which the unnormalized
// form bypasses entirely, exiting 0 before any check runs) assumes a
// literal space between a command verb and its arguments — this
// normalization runs upstream of all of them so none needs its own
// IFS-awareness.
//
// Deliberately not quote-aware: this runs BEFORE mask-quoted-text.mjs in
// guard-git.sh's pipeline, so a $IFS/${IFS} that happens to sit inside a
// quoted, inert string gets replaced with a space here but is then blanked
// out (along with everything else in that quoted span) by masking anyway —
// the two passes compose correctly without this script needing its own
// quote-tracking. A $IFS/${IFS} inside a command-substitution span
// (`$(...)`/backticks) is left exactly as normalized here, since masking
// deliberately copies those spans through verbatim — they execute
// unconditionally in real bash, so IFS-driven splitting genuinely applies
// there too.
//
// The bare `$IFS` form must not swallow the start of a longer variable
// name — `$IFSOMETHING` references a completely different (and almost
// certainly unset, hence empty-expanding) variable, not `$IFS` followed by
// literal text. Bash variable-name continuation characters are
// `[A-Za-z0-9_]`; the braced form (`${IFS}`) has no such ambiguity, since
// `}` unambiguously ends it.
//
// `${IFS:0:1}`/`${IFS:1:1}`/etc. (substring expansion — Greptile review):
// bash's field-splitting applies to the RESULT of any unquoted parameter
// expansion, not just a bare variable reference, so `${IFS:0:1}` (which
// extracts a single whitespace character from IFS's default value) creates
// exactly the same token boundary as the whole-variable form. Matched
// generically as "any `${IFS` followed by a parameter-expansion operator up
// to the closing `}`" — `[^}]*` — rather than enumerating every specific
// bash operator (substring `:`, pattern-trim `#`/`%`, substitution `/`,
// case-conversion `^`/`,`, …), so this also covers forms not spelled out
// here. Assumes IFS still holds its default value (space/tab/newline) at
// expansion time, the same implicit assumption the whole-variable form
// already makes — a prior `IFS=...` reassignment earlier in the same
// command line is a materially harder problem (tracking shell state across
// the whole line) that this regex-based heuristic guard does not attempt,
// matching the tolerance for edge cases already accepted by
// mask-quoted-text.mjs and guard-git.sh's other checks. Does not handle a
// nested `${...}` inside the offset/length (`${IFS:0:${N}}`) — `[^}]*`
// stops at the first `}` — an exotic construction with no known real-world
// motivation for this specific bypass.

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const normalized = input
    .replace(/\$\{IFS\}/g, ' ')
    .replace(/\$\{IFS[^A-Za-z0-9_}][^}]*\}/g, ' ')
    .replace(/\$IFS(?![A-Za-z0-9_])/g, ' ');
  process.stdout.write(normalized);
});
