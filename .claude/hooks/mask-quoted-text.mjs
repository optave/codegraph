#!/usr/bin/env node
// mask-quoted-text.mjs — reads a shell command line from stdin and writes it
// back with the *contents* of every quoted string (single or double) and
// every heredoc body replaced by `#`/masked placeholders, preserving quote
// delimiters and overall length/line structure.
//
// Used by guard-git.sh (#2099) so its "does this command invoke a dangerous
// verb" checks scan text that can never accidentally match inside data that
// isn't a real command invocation — e.g.
// `gh issue create --body "...git clean -fd..."` previously tripped the
// same regex as a real `git clean` invocation, since those checks are plain
// substring/regex scans with no awareness of shell quoting. Heredoc bodies
// (`git commit -m "$(cat <<'EOF' ... EOF)"`, the form this repo's own
// CLAUDE.md mandates for commit messages) are the same class of problem:
// the message text is data, not commands, but sits outside any single-line
// quote pair.
//
// EXEC_TRIGGER_TOKENS (Greptile review on #2099's own PR): a quote or
// heredoc immediately following `-c`/`--command`/`-e`/`--eval`/`eval` is not
// inert data — shells and interpreters (`bash -c "..."`, `sh -c '...'`,
// `node -e "..."`, `eval "..."`) execute that string as real code. Masking
// it would hide a genuine `git clean -fd` payload from every verb-detection
// check below. Such quotes/heredocs are left completely unmasked instead.
// This is a token-adjacency heuristic, not full shell-grammar parsing — it
// does not resolve indirection (e.g. a variable holding `-c`), matching the
// tolerance for edge cases already accepted by guard-git.sh's other
// regex-based checks.
//
// This is a heuristic, not a full shell-grammar parser: `\"` inside a
// double-quoted string is treated as an escaped quote (consumed as two
// masked characters, not a string terminator); single-quoted strings in real
// shells never support backslash escapes at all, so none are attempted here.
// Heredoc detection looks for `<<[-~]?['"]?WORD['"]?` anywhere on a line and
// masks every line up to (not including) a line whose trimmed content is
// exactly WORD — real shells only allow the plain form (no `<<`, redirects,
// or trailing text) on a terminator line, which this mirrors.

const HEREDOC_START = /<<-?~?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
const EXEC_TRIGGER_TOKENS = new Set(['-c', '--command', '-e', '--eval', 'eval']);

/** The whitespace-delimited token immediately before `pos` in `str`, or ''. */
function precedingToken(str, pos) {
  let end = pos;
  while (end > 0 && /\s/.test(str[end - 1])) end--;
  let start = end;
  while (start > 0 && !/\s/.test(str[start - 1])) start--;
  return str.slice(start, end);
}

function maskHeredocBodies(text) {
  const lines = text.split('\n');
  const out = [];
  let delimiter = null;
  let execTriggered = false;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) {
        delimiter = null;
        out.push(line);
      } else if (execTriggered) {
        out.push(line);
      } else {
        out.push('#'.repeat(line.length));
      }
      continue;
    }
    out.push(line);
    const match = line.match(HEREDOC_START);
    if (match) {
      delimiter = match[2];
      // Coarse, line-level check: does this heredoc's own start line carry
      // an exec-trigger token anywhere on it (e.g. `bash -c "$(cat <<'EOF'`)?
      // A false "yes" here only means a heredoc that didn't need the
      // exemption stays unmasked — a missed mask, not a hidden invocation —
      // which is the safe direction to err in.
      const tokens = line.trim().split(/\s+/);
      execTriggered = tokens.some((t) => EXEC_TRIGGER_TOKENS.has(t));
    }
  }
  return out.join('\n');
}

function maskQuotedStrings(input) {
  let out = '';
  let quote = null;
  let quoteExecTriggered = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (quoteExecTriggered) {
        out += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        out += '##';
        i++;
        continue;
      }
      if (ch === quote) {
        out += ch;
        quote = null;
        continue;
      }
      out += ch === '\n' ? '\n' : '#';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoteExecTriggered = EXEC_TRIGGER_TOKENS.has(precedingToken(input, i));
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  process.stdout.write(maskQuotedStrings(maskHeredocBodies(input)));
});
