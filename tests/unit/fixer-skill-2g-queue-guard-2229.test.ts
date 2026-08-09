/**
 * Regression test for issue #2229: `.claude/skills/fixer/SKILL.md` step
 * 2g's state-recording bash block wrote `state.json` and then
 * unconditionally shifted `queue.json`, even when the `state.json` write
 * itself failed (e.g. a malformed/unreadable `state.json`). The queue-shift
 * line ran regardless, silently losing the issue from both files: never
 * recorded as resolved, and no longer queued to be retried.
 *
 * Extracts the actual 2g bash block from the real SKILL.md (not a
 * reimplementation of its logic) and executes it against a sandboxed
 * `.codegraph/fixer/` directory, so this test breaks the moment someone
 * reintroduces the unguarded `&&`/unconditional-shift pattern — not just
 * the moment someone changes prose around it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const SKILL_PATH = path.join(REPO_ROOT, '.claude/skills/fixer/SKILL.md');

/** Extract the first ```bash fenced block following a given section heading. */
function extractBashBlockAfterHeading(markdown: string, heading: string): string {
  const headingIdx = markdown.indexOf(heading);
  if (headingIdx === -1) {
    throw new Error(`Heading not found in SKILL.md: ${heading}`);
  }
  const rest = markdown.slice(headingIdx);
  const fenceStart = rest.indexOf('```bash');
  if (fenceStart === -1) {
    throw new Error(`No \`\`\`bash fence found after heading: ${heading}`);
  }
  const bodyStart = rest.indexOf('\n', fenceStart) + 1;
  const fenceEnd = rest.indexOf('```', bodyStart);
  if (fenceEnd === -1) {
    throw new Error(`Unterminated \`\`\`bash fence after heading: ${heading}`);
  }
  return rest.slice(bodyStart, fenceEnd);
}

function runBlock(
  block: string,
  sandbox: string,
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', ['-c', block], { cwd: sandbox, encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { exitCode: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function setupSandbox(stateJsonContent: string): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-2g-sandbox-'));
  fs.mkdirSync(path.join(sandbox, '.codegraph/fixer'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, '.codegraph/fixer/state.json'), stateJsonContent);
  fs.writeFileSync(
    path.join(sandbox, '.codegraph/fixer/queue.json'),
    JSON.stringify([
      { issue: 100, title: 'first' },
      { issue: 200, title: 'second' },
    ]),
  );
  fs.writeFileSync(path.join(sandbox, '.codegraph/fixer/outcome'), 'merged');
  fs.writeFileSync(path.join(sandbox, '.codegraph/fixer/current-pr'), '999');
  return sandbox;
}

describe('fixer skill 2g state/queue write guards (#2229)', () => {
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf-8');
  const block = extractBashBlockAfterHeading(
    skillContent,
    '### 2g. Record the outcome and advance',
  );

  it('extracted a non-trivial block containing the state.json and queue.json writes', () => {
    expect(block).toContain('.codegraph/fixer/state.json');
    expect(block).toContain('.codegraph/fixer/queue.json');
  });

  it('happy path: records the issue in state.json and shifts queue.json', () => {
    const sandbox = setupSandbox('{"issues":[]}');
    try {
      const result = runBlock(block, sandbox);
      expect(result.exitCode).toBe(0);

      const state = JSON.parse(
        fs.readFileSync(path.join(sandbox, '.codegraph/fixer/state.json'), 'utf-8'),
      );
      expect(state.issues).toEqual([{ issue: 100, status: 'merged', pr: 999 }]);

      const queue = JSON.parse(
        fs.readFileSync(path.join(sandbox, '.codegraph/fixer/queue.json'), 'utf-8'),
      );
      expect(queue).toEqual([{ issue: 200, title: 'second' }]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('does not shift queue.json when the state.json write fails', () => {
    const sandbox = setupSandbox('{invalid json here');
    try {
      const result = runBlock(block, sandbox);
      expect(result.exitCode).not.toBe(0);

      // state.json is left as whatever it was — still malformed, not silently
      // "fixed" by a failed write, and definitely not recording a fabricated
      // success.
      const stateRaw = fs.readFileSync(path.join(sandbox, '.codegraph/fixer/state.json'), 'utf-8');
      expect(stateRaw).toBe('{invalid json here');

      // The bug this test guards against: queue.json must still have issue
      // #100 at its head, not silently shifted to #200.
      const queue = JSON.parse(
        fs.readFileSync(path.join(sandbox, '.codegraph/fixer/queue.json'), 'utf-8'),
      );
      expect(queue).toEqual([
        { issue: 100, title: 'first' },
        { issue: 200, title: 'second' },
      ]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
