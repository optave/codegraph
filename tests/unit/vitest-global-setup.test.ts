/**
 * Unit test for scripts/vitest-global-setup.ts (issue #2439).
 *
 * The WASM engine's worker always loads COMPILED dist/, even when a test
 * imports src/*.ts directly, so an edit to an extractor silently exercises
 * stale compiled code until dist/ is rebuilt. This globalSetup hook rebuilds
 * dist/ once before the whole vitest run (regardless of `npm test` vs. a
 * direct `npx vitest run <file>`) rather than reimplementing tsc's own
 * incremental staleness detection — see that file's doc comment for why a
 * hand-rolled mtime comparison was tried and reverted.
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

// Mirrors exactly how scripts/vitest-global-setup.ts derives its own cwd —
// fileURLToPath(new URL(...)) is not guaranteed trailing-slash-equivalent to
// path.resolve() across platforms, and this test only cares that setup()
// passes ITS OWN computed root through unchanged.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('vitest global setup (#2439)', () => {
  it('runs npm run build in the repo root before the test run starts', async () => {
    const { execFileSync } = await import('node:child_process');
    const setup = (await import('../../scripts/vitest-global-setup.js')).default;

    setup();

    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      expect.objectContaining({ cwd: repoRoot, stdio: 'inherit' }),
    );
  });
});
