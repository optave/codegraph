/**
 * Regression test for issue #2304: `.claude/skills/fixer/SKILL.md` step 2g's
 * state-recording bash block read `queue.json[0]` fresh at write time with no
 * check that it was still the issue this dispatch was actually working on. If
 * some other writer shifted `queue.json` past this issue while 2a-2g was
 * still running for it (e.g. during 2f-bis's I8 post-merge-CI polling), 2g
 * would silently record its outcome under whatever issue now sat at the
 * queue's head — marking an untouched issue as done and dropping it from the
 * queue with no trace of the mistake.
 *
 * The fix compares `queue.json[0]` against `.codegraph/fixer/dispatching-issue`
 * (captured before this issue was ever dispatched, per "Dispatching each
 * issue to a sub-agent") and refuses to write when they disagree.
 *
 * Extracts the actual 2g bash block from the real SKILL.md (not a
 * reimplementation of its logic) and executes it against a sandboxed
 * `.codegraph/fixer/` directory, mirroring fixer-skill-2g-queue-guard-2229.test.ts.
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

function setupSandbox(dispatchingIssue: string | null): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-2g-sandbox-2304-'));
  fs.mkdirSync(path.join(sandbox, '.codegraph/fixer'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, '.codegraph/fixer/state.json'), '{"issues":[]}');
  fs.writeFileSync(
    path.join(sandbox, '.codegraph/fixer/queue.json'),
    JSON.stringify([
      { issue: 100, title: 'first' },
      { issue: 200, title: 'second' },
    ]),
  );
  fs.writeFileSync(path.join(sandbox, '.codegraph/fixer/outcome'), 'merged');
  fs.writeFileSync(path.join(sandbox, '.codegraph/fixer/current-pr'), '999');
  if (dispatchingIssue !== null) {
    fs.writeFileSync(path.join(sandbox, '.codegraph/fixer/dispatching-issue'), dispatchingIssue);
  }
  return sandbox;
}

describe('fixer skill 2g moved-queue-head guard (#2304)', () => {
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf-8');
  const block = extractBashBlockAfterHeading(
    skillContent,
    '### 2g. Record the outcome and advance',
  );

  it('extracted a block that checks dispatching-issue', () => {
    expect(block).toContain('dispatching-issue');
  });

  it("refuses to record when dispatching-issue disagrees with queue.json's head", () => {
    // Simulates the exact race from #2304: this dispatch was for issue #100,
    // but something else shifted queue.json's head to #200 before 2g ran.
    const sandbox = setupSandbox('100');
    try {
      const queuePath = path.join(sandbox, '.codegraph/fixer/queue.json');
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      // Simulate the shift: #100 already got dispatched, and something else
      // moved the head past it while this dispatch was still in progress.
      fs.writeFileSync(queuePath, JSON.stringify(queue.slice(1)));

      const result = runBlock(block, sandbox);
      expect(result.exitCode).not.toBe(0);

      // state.json must NOT have gained a bogus record for #200.
      const state = JSON.parse(
        fs.readFileSync(path.join(sandbox, '.codegraph/fixer/state.json'), 'utf-8'),
      );
      expect(state.issues).toEqual([]);

      // queue.json must still have #200 at its head — not shifted again.
      const finalQueue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      expect(finalQueue).toEqual([{ issue: 200, title: 'second' }]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("records normally when dispatching-issue matches queue.json's head", () => {
    const sandbox = setupSandbox('100');
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

  it('records normally when dispatching-issue is absent (defensive: guard is opt-in, not required)', () => {
    const sandbox = setupSandbox(null);
    try {
      const result = runBlock(block, sandbox);
      expect(result.exitCode).toBe(0);

      const state = JSON.parse(
        fs.readFileSync(path.join(sandbox, '.codegraph/fixer/state.json'), 'utf-8'),
      );
      expect(state.issues).toEqual([{ issue: 100, status: 'merged', pr: 999 }]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
