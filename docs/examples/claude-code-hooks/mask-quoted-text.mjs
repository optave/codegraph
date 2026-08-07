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
// EXEC_TRIGGER_TOKENS (Greptile review): a quote or heredoc immediately
// following `-c`/`--command`/`-e`/`--eval`/`eval` is not inert data — shells
// and interpreters (`bash -c "..."`, `sh -c '...'`, `node -e "..."`,
// `eval "..."`) execute that string as real code. Masking it would hide a
// genuine `git clean -fd` payload from every verb-detection check below.
// Such quotes/heredocs are left completely unmasked instead.
//
// COMMAND SUBSTITUTION (Greptile review): `$(...)` and `` `...` `` execute
// their contents even inside an ORDINARY double-quoted string that is
// otherwise inert data (`git commit -m "message $(git clean -fd)"` really
// does run `git clean -fd` when bash expands it) — single quotes are the
// only quoting that suppresses this. The same applies inside a heredoc body
// whose delimiter is UNQUOTED (`<<EOF`, as opposed to `<<'EOF'`/`<<"EOF"`,
// which suppress all expansion, matching the form CLAUDE.md mandates for
// commit messages). Such spans are left unmasked (with correctly nested
// paren/backtick matching) regardless of exec-trigger context, since they
// execute unconditionally.
//
// This is a heuristic, not a full shell-grammar parser: `\"` inside a
// double-quoted string is treated as an escaped quote (consumed as two
// masked characters, not a string terminator); single-quoted strings in real
// shells never support backslash escapes at all, so none are attempted here;
// nested `$(...)`/backtick detection does not itself account for quotes
// *inside* the substitution. Proportionate to a PreToolUse guard, matching
// the tolerance for edge cases already accepted by guard-git.sh's other
// regex-based checks.

const HEREDOC_START = /<<-?~?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1?/;
const EXEC_TRIGGER_TOKENS = new Set(['-c', '--command', '-e', '--eval', 'eval']);

/** The whitespace-delimited token immediately before `pos` in `str`, or ''. */
function precedingToken(str, pos) {
  let end = pos;
  while (end > 0 && /\s/.test(str[end - 1])) end--;
  let start = end;
  while (start > 0 && !/\s/.test(str[start - 1])) start--;
  return str.slice(start, end);
}

/**
 * If `text[i]` starts a `$(...)` (balanced nested parens) or `` `...` ``
 * command-substitution span, returns `{ span, nextIndex }` — the full
 * verbatim span text and the index of the character right after it.
 * Returns `null` when `i` doesn't start such a span.
 */
function scanCommandSubstitution(text, i) {
  if (text[i] === '$' && text[i + 1] === '(') {
    let depth = 1;
    let j = i + 2;
    let span = '$(';
    for (; j < text.length && depth > 0; j++) {
      span += text[j];
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
    }
    return { span, nextIndex: j };
  }
  if (text[i] === '`') {
    let j = i + 1;
    let span = '`';
    for (; j < text.length; j++) {
      span += text[j];
      if (text[j] === '`') {
        j++;
        break;
      }
    }
    return { span, nextIndex: j };
  }
  return null;
}

/**
 * Mask every character in `text` to `#` (preserving newlines), except for
 * `$(...)`/`` `...` `` spans (see `scanCommandSubstitution`), which are
 * copied verbatim — those execute unconditionally in real bash wherever
 * expansion is active at all, regardless of surrounding masking context.
 */
function maskExceptCommandSubstitution(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const sub = scanCommandSubstitution(text, i);
    if (sub) {
      out += sub.span;
      i = sub.nextIndex - 1;
      continue;
    }
    out += text[i] === '\n' ? '\n' : '#';
  }
  return out;
}

function maskHeredocBodies(text) {
  const lines = text.split('\n');
  const out = [];
  let delimiter = null;
  let execTriggered = false;
  let delimiterQuoted = false;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) {
        delimiter = null;
        out.push(line);
      } else if (execTriggered) {
        out.push(line);
      } else if (delimiterQuoted) {
        out.push('#'.repeat(line.length));
      } else {
        // Unquoted heredoc delimiter (`<<EOF`) — the shell still expands
        // $(...)/backticks inside the body, so those spans must stay visible.
        out.push(maskExceptCommandSubstitution(line));
      }
      continue;
    }
    out.push(line);
    const match = line.match(HEREDOC_START);
    if (match) {
      delimiter = match[2];
      delimiterQuoted = match[1] === "'" || match[1] === '"';
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
      // Command substitution executes even inside an otherwise-inert
      // double-quoted string (single quotes suppress it entirely, so this
      // only applies when quote === '"').
      if (quote === '"') {
        const sub = scanCommandSubstitution(input, i);
        if (sub) {
          out += sub.span;
          i = sub.nextIndex - 1;
          continue;
        }
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
