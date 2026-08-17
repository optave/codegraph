#!/usr/bin/env node
/**
 * Vitest `globalSetup` — runs once before the whole test run, regardless of
 * whether it was invoked via `npm test` or a direct `npx vitest run <file>`.
 *
 * Issue #2439: the WASM engine always parses through the COMPILED
 * `dist/domain/wasm-worker-entry.js`, even when a test imports `src/*.ts`
 * directly — so editing an extractor under `src/` silently exercises stale
 * compiled code until `dist/` is rebuilt. `pretest` only runs `npm run
 * doctor`, which doesn't rebuild, and `npm install`'s `prepare` script
 * builds `dist/` once, not on every subsequent edit. In PR #2432 this
 * manifested as "the native engine is correct and WASM reproduces the old
 * buggy behaviour" — indistinguishable from a genuine engine-parity bug.
 *
 * A hand-rolled staleness check (comparing dist/'s mtime against src/'s)
 * was tried and reverted: `tsconfig.json` sets `incremental: true`, so tsc
 * skips re-emitting an output file whose compiled content wouldn't change —
 * `dist/domain/wasm-worker-entry.js`'s own mtime reflects when THAT file
 * was last actually recompiled, not when the project was last built, and is
 * routinely older than unrelated src/ files even in a fully up-to-date
 * build. That produced false positives on every run. Just running the
 * build is simpler and correct, because it defers to tsc's own incremental
 * engine — the only thing that actually knows what's stale — instead of
 * reimplementing it.
 *
 * A no-op incremental rebuild costs about a second, dominated by process
 * startup rather than compilation, and runs ONCE per test invocation here
 * (not once per test file), so the added cost is negligible against a
 * multi-minute full suite run.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// npm on Windows is npm.cmd; Node refuses to spawn .cmd/.bat without a shell.
// Safe with shell: true here since the argv is a fixed literal, never
// user-controlled input (matches scripts/doctor.ts's NPM_SHELL convention).
const NPM_SHELL = os.platform() === 'win32';

export default function setup(): void {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit', shell: NPM_SHELL });
}
