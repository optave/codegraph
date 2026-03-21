#!/usr/bin/env node
/**
 * Test runner wrapper that registers the .js→.ts resolver hook
 * before spawning vitest. Works cross-platform (no NODE_OPTIONS needed).
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { pathToFileURL } from 'node:url';
const hook = pathToFileURL(resolve(__dirname, 'ts-resolver-hook.js')).href;

const args = process.argv.slice(2);
const vitest = resolve(__dirname, '..', 'node_modules', '.bin', 'vitest');

const result = spawnSync(vitest, args, {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    NODE_OPTIONS: [
      `--import ${hook}`,
      process.env.NODE_OPTIONS,
    ].filter(Boolean).join(' '),
  },
});

process.exit(result.status ?? 1);
