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
// exactly the same token boundary as the whole-variable form. The LENGTH
// portion must be a non-zero digit sequence (Greptile review):
// `${IFS:0:0}` extracts zero characters — an EMPTY string, which an
// unquoted expansion contributes NOTHING from (not even a separator) —
// `echo git${IFS:0:0}reset` really expands to the single harmless token
// `gitreset`, not `git reset`.
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
// Also does not attempt to detect an out-of-range substring OFFSET with no
// explicit length (`${IFS:3}` — offset 3 is at the end of the 3-character
// default IFS value, so this is ALSO empty, the same problem as an
// explicit zero length) — narrower and easier to get precisely right than
// modeling every offset/length combination against IFS's exact default
// length, and not the concrete form named in review.
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
    .replace(/\$\{IFS: *-?\d+(: *-?[1-9]\d*)?\}/g, ' ')
    .replace(/\$\{IFS:?\+[ \t]+\}/g, ' ')
    .replace(/\$IFS(?![A-Za-z0-9_])/g, ' ');
  process.stdout.write(normalized);
});
