#!/usr/bin/env node
// normalize-ifs.mjs — reads a shell command line from stdin and writes it
// back with every $IFS/${IFS} reference (plus, for the `:+`/`+`
// alternate-value form only, the equivalent reference to any other
// normally-set variable — #2558) replaced by a single literal space
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
// `-0`/`-00`/etc. (negative zero — Greptile review): integers have no
// signed zero, so bash evaluates `-0` to the same value as `0` — offset
// `-0` is offset `0` FROM THE START (valid, non-empty), NOT "0 characters
// before the end" the way `-1`/`-2`/`-3` are. `-0*[1-3]` requires a
// non-zero digit after the leading zeros, so it correctly does not match
// a run of ALL zeros after the minus sign — matched separately here via
// `-0+` (a literal minus followed by one or more zeros and nothing else).
//
// `${VAR:+ }`/`${VAR+ }` (alternate-value expansion, restricted to
// ALL-whitespace content — Greptile review): unlike substring, this
// operator does NOT extract from the variable's own value at all — it
// substitutes an entirely separate, attacker-chosen string `word` whenever
// VAR IS set and non-null (`:+`) or merely set (`+`), which normally means
// `word` is what actually comes out, not VAR's value. Because of that,
// this is matched ONLY when `word` consists of one or more spaces/tabs and
// NOTHING else — `${VAR:+ }` really does expand to a literal space
// (`word` itself, not derived from VAR), so it's exactly as safe to
// normalize as the whole-variable form; `${VAR:+x}` is not touched, since
// `x` is not whitespace and substituting a space for it would fabricate a
// token boundary bash never produces (an earlier version of this
// normalizer treated the operator as unconditionally unsafe and missed
// this whitespace-content special case — Greptile review).
//
// Unlike the other three replacements below, this one is NOT restricted to
// the literal name `IFS`: the operator's behavior has nothing to do with
// what VAR's own value actually is, only with whether VAR is normally set
// and non-null — true for almost any commonly-set variable (`HOME`, `PWD`,
// `PATH`, ...), not just `IFS`. A per-variable-name check could never fully
// close this class, since the variable name in the bypass isn't fixed
// (#2558) — so this one matches any bash identifier shape
// (`[A-Za-z_][A-Za-z0-9_]*`) in that position, erring toward normalizing
// (the safe direction for a guard) even for a variable that happens not to
// be set in a given shell, rather than trying to track which variables are
// actually set.
//
// Also matches bash's SPECIAL parameters in that position — `?` (exit
// status), `$` (PID), `#` (positional-parameter count), `-` (current shell
// option flags), `!` (last background PID), and a bare digit sequence
// (positional parameters, `${10:+ }` etc.) — verified directly against real
// bash (Greptile review): `${?:+ }`/`${$:+ }`/`${#:+ }`/`${-:+ }` all
// substitute the whitespace word exactly like an ordinary variable would,
// and `?`/`$`/`#`/`-` are always set in any shell (unlike `!`/digit
// parameters, which depend on whether a job has been backgrounded or
// positional arguments are present — matched anyway, erring toward
// normalizing). None of these characters overlap with the identifier
// alternative above, so a single alternation covers both without ambiguity.
//
// Deliberately does NOT generalize the other three replacements below to
// "any `${VAR<operator>...}`" — only `:+`/`+` generalizes across variable
// names, because only its substituted text is entirely independent of the
// variable's own value. `${IFS/pattern/replacement}` (substitutes
// `replacement` wherever `pattern` matches within IFS's value) and the
// bash 4.4+ `${IFS@Q}`-style transformation operators (e.g. `@Q`
// shell-quotes the value, producing `$' \t\n'`-shaped text) can ALSO
// produce arbitrary non-whitespace text, the same class of problem `:+`/`+`
// have — but unlike `:+`/`+`, there is no simple "restrict to all-whitespace
// content" fix for them (`pattern`/`replacement` are two separate,
// differently-shaped fields), AND they only produce a whitespace-only
// result by relying on IFS's own specific default value in the first
// place, so generalizing them to other variable names wouldn't even be
// meaningful the way it is for `:+`/`+`. Left unhandled rather than risk
// another incorrect generalization; a determined obfuscator using one of
// these remains a known, accepted gap in this heuristic guard.
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
    .replace(/\$\{IFS: *(?:0*[0-2]|-0*[1-3]|-0+)(?::0*[1-9]\d*)?\}/g, ' ')
    .replace(/\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$!#@*-]):?\+[ \t]+\}/g, ' ')
    .replace(/\$IFS(?![A-Za-z0-9_])/g, ' ');
  process.stdout.write(normalized);
});
