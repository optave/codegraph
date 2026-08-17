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
// exactly the same token boundary as the whole-variable form.
//
// Both OFFSET and LENGTH are constrained to the exact values that are
// PROVABLY non-empty against IFS's 3-character default value
// (space/tab/newline), rather than accepting any digit sequence:
//
// - OFFSET is restricted to `0`/`1`/`2` (from the start) or `-1`/`-2`/`-3`
//   (from the end) — the only positions that exist within a 3-character
//   string. `${IFS:3}` (Greptile review) starts extraction AT the end of
//   the string — bash's substring expansion returns EMPTY once offset is
//   at or past the string's length, the same "empty, not whitespace"
//   problem as an explicit zero length below — `echo git${IFS:3}reset`
//   really expands to the single harmless token `gitreset`, not
//   `git reset`. This also protects the WITH-length form the same way:
//   `${IFS:5:1}` is empty too (bash returns nothing once offset alone is
//   out of range, regardless of the requested length).
// - LENGTH, when present, must be a digit sequence that isn't all zeros
//   (Greptile review): `${IFS:0:0}` extracts zero characters — an EMPTY
//   string, which an unquoted expansion contributes NOTHING from (not
//   even a separator) — `echo git${IFS:0:0}reset` really expands to the
//   single harmless token `gitreset`. Once OFFSET is validated as
//   in-range, ANY non-zero LENGTH is safe to accept without also bounding
//   its upper value: bash clamps a length that exceeds what's actually
//   available from OFFSET to the end of the string, rather than erroring
//   or producing something unexpected, so a too-large length still yields
//   a non-empty (if shorter than requested) whitespace-only result.
//
// OFFSET and LENGTH both tolerate leading zeros (Greptile review):
// bash evaluates both as arithmetic expressions, so `${IFS:00}` and
// `${IFS:0:01}` are exactly as valid as `${IFS:0}` and `${IFS:0:1}` — an
// earlier version's exact single-digit patterns (`[0-2]`, `[1-9]\d*`)
// missed these zero-padded spellings entirely, leaving them unnormalized
// even though bash evaluates them identically. `0*[0-2]`/`-0*[1-3]` for
// OFFSET and `0*[1-9]\d*` for LENGTH accept any number of leading zeros
// (including none) ahead of the same significant digit(s) validated
// above. This does not attempt full arithmetic-expression support (hex,
// operators, nested expansions, `$((...))`) — a genuinely open-ended
// problem, the same class already tracked in #2558, not a bounded,
// concretely-named gap like leading zeros.
//
// `${IFS:+ }`/`${IFS+ }` (alternate-value expansion, restricted to
// ALL-whitespace content — Greptile review): unlike substring, this
// operator does NOT extract from IFS's own value at all — it substitutes
// an entirely separate, attacker-chosen string `word` whenever IFS IS set
// and non-null (`:+`) or merely set (`+`), which normally means `word` is
// what actually comes out, not IFS's value. Because of that, this is
// matched ONLY when `word` consists of one or more spaces/tabs and
// NOTHING else — `${IFS:+ }` really does expand to a literal space
// (`word` itself, not derived from IFS), so it's exactly as safe to
// normalize as the whole-variable form; `${IFS:+x}` is not touched, since
// `x` is not whitespace and substituting a space for it would fabricate a
// token boundary bash never produces (an earlier version of this
// normalizer treated the operator as unconditionally unsafe and missed
// this whitespace-content special case — Greptile review).
//
// Deliberately does NOT generalize to "any `${IFS<operator>...}`": an
// earlier version tried that and was wrong (Greptile review) —
// `${IFS/pattern/replacement}` (substitutes `replacement` wherever
// `pattern` matches within IFS's value) and the bash 4.4+ `${IFS@Q}`-style
// transformation operators (e.g. `@Q` shell-quotes the value, producing
// `$' \t\n'`-shaped text) can ALSO produce arbitrary non-whitespace text,
// the same class of problem `:+`/`+` have — and unlike `:+`/`+`, there is
// no simple "restrict to all-whitespace content" fix for them, since
// `pattern`/`replacement ` are two separate, differently-shaped fields.
// Left unhandled rather than risk another incorrect generalization; a
// determined obfuscator using one of these is a known, accepted gap in
// this heuristic guard (see #2558 for tracking the closely related,
// broader problem that `:+`/`+` with all-whitespace content isn't even
// unique to the `IFS` name — `${HOME:+ }`/`${PWD:+ }`/any other normally-set
// variable works identically, which a per-variable-name normalizer like
// this one can never fully close).
//
// The bare `$IFS` form must not swallow the start of a longer variable
// name — `$IFSOMETHING` references a completely different (and almost
// certainly unset, hence empty-expanding) variable, not `$IFS` followed by
// literal text. Bash variable-name continuation characters are
// `[A-Za-z0-9_]`; the braced forms have no such ambiguity, since a
// non-identifier operator character or `}` unambiguously ends the name.
//
// Assumes IFS still holds its default value (space/tab/newline) at
// expansion time — a prior `IFS=...` reassignment earlier in the same
// command line is a materially harder problem (tracking shell state across
// the whole line) that this regex-based heuristic guard does not attempt,
// matching the tolerance for edge cases already accepted by
// mask-quoted-text.mjs and guard-git.sh's other checks.

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const normalized = input
    .replace(/\$\{IFS\}/g, ' ')
    .replace(/\$\{IFS: *(?:0*[0-2]|-0*[1-3])(?::0*[1-9]\d*)?\}/g, ' ')
    .replace(/\$\{IFS:?\+[ \t]+\}/g, ' ')
    .replace(/\$IFS(?![A-Za-z0-9_])/g, ' ');
  process.stdout.write(normalized);
});
