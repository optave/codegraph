#!/usr/bin/env node
// check-git-clean-force.mjs — reads the (masked, -C-normalized) NCOMMAND
// from stdin and prints `BLOCK` if it contains a `git clean` invocation that
// would actually delete (carries -f/--force and lacks -n/--dry-run),
// otherwise prints nothing. Used by guard-git.sh (#2099).
//
// Splits into logical command segments on every real shell command
// separator (&&, ||, ;, |, newline) — not just `&&` — so a flag on one
// command can never be misread as belonging to an unrelated `git clean` on
// a different segment (Greptile review: `git clean -fd; ls -n` must still
// block, since the `-n` belongs to `ls`, not the clean invocation).
//
// Within a segment, flags are matched against whole whitespace-separated
// tokens (not a substring/boundary regex against the raw segment text), so
// bundled short options are recognized correctly: `-ndf` and `-fnd` both
// carry both `-n` and `-f`, matching git's own bundled short-flag parsing.

const SEGMENT_SEPARATOR = /&&|\|\||[;|\n]/;
const CLEAN_INVOCATION = /(^|\s)git\s+clean(\s|$)/;
const FORCE_TOKEN = /^(--force|-[a-zA-Z]*f[a-zA-Z]*)$/;
const DRY_RUN_TOKEN = /^(--dry-run|-[a-zA-Z]*n[a-zA-Z]*)$/;

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const segments = input.split(SEGMENT_SEPARATOR);
  for (const segment of segments) {
    if (!CLEAN_INVOCATION.test(segment)) continue;
    const tokens = segment.trim().split(/\s+/);
    const hasForce = tokens.some((t) => FORCE_TOKEN.test(t));
    const hasDryRun = tokens.some((t) => DRY_RUN_TOKEN.test(t));
    if (hasForce && !hasDryRun) {
      process.stdout.write('BLOCK');
      return;
    }
  }
});
