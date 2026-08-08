/**
 * Regression test for issue #2140: `forkWorker()` unconditionally set
 * `CODEGRAPH_ENGINE` to whatever `workerName` it was given. That's correct
 * for `forkEngines()`'s own two calls (`workerName` is `'wasm'`/`'native'`,
 * a valid engine value), but `embedding-benchmark.ts` reuses `forkWorker()`
 * directly with `workerName` set to a *model* name (`'minilm'`,
 * `'jina-small'`, ...) — an invalid `CODEGRAPH_ENGINE` value that tripped a
 * "not a valid engine value" warning on every embed call inside that
 * worker.
 *
 * The fix: only set `CODEGRAPH_ENGINE` when the caller's `envKey` is the
 * same `WORKER_ENV_KEY` `forkEngines()` itself uses — true for an actual
 * engine-comparison fork, never true for `embedding-benchmark.ts`'s own
 * distinct model-worker env key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forkWorker, WORKER_ENV_KEY } from '../../scripts/lib/fork-engine.js';

const CHILD_SCRIPT = `
process.stdout.write(JSON.stringify({ codegraphEngine: process.env.CODEGRAPH_ENGINE ?? null }));
process.exit(0);
`;

describe('forkWorker CODEGRAPH_ENGINE gating (#2140)', () => {
  let scriptPath: string;

  it('sets CODEGRAPH_ENGINE when envKey is the real engine-comparison key', async () => {
    scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2140-')), 'child.mjs');
    fs.writeFileSync(scriptPath, CHILD_SCRIPT);

    const result = await forkWorker(scriptPath, WORKER_ENV_KEY, 'wasm', []);
    expect(result).toEqual({ codegraphEngine: 'wasm' });
  });

  it('does not set CODEGRAPH_ENGINE for a different envKey (e.g. a model-name worker)', async () => {
    scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2140-')), 'child.mjs');
    fs.writeFileSync(scriptPath, CHILD_SCRIPT);

    const result = await forkWorker(scriptPath, '__BENCH_MODEL__', 'minilm', []);
    // Compares against whatever this test process's own CODEGRAPH_ENGINE
    // happens to be (undefined normally, but forkWorker() still inherits
    // the parent env otherwise) rather than hardcoding null — a shell/CI
    // environment with CODEGRAPH_ENGINE ambiently set would otherwise fail
    // this assertion despite the worker name correctly not being applied.
    expect(result).toEqual({ codegraphEngine: process.env.CODEGRAPH_ENGINE ?? null });
  });
});
