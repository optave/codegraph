#!/usr/bin/env node

/**
 * Run the dynamic call tracer against a fixture's driver.mjs.
 *
 * Usage:
 *   node tests/benchmarks/resolution/tracer/run-tracer.mjs <fixture-dir>
 *
 * Outputs dynamic-edges.json to stdout.
 * The fixture directory must contain a driver.mjs that:
 *   1. Imports modules via __tracer.instrumentExports()
 *   2. Calls all exported functions/methods
 *   3. Calls globalThis.__tracer.dump() and returns the result
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loaderHook = path.join(__dirname, 'loader-hook.mjs');

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error('Usage: run-tracer.mjs <fixture-dir>');
  process.exit(1);
}

const driverPath = path.join(fixtureDir, 'driver.mjs');
if (!fs.existsSync(driverPath)) {
  console.error(`No driver.mjs found in ${fixtureDir}`);
  process.exit(1);
}

try {
  const result = execFileSync(process.execPath, ['--import', loaderHook, driverPath], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  // The driver should output JSON edges to stdout
  process.stdout.write(result);
} catch (e) {
  console.error(`Tracer failed for ${fixtureDir}: ${e.message}`);
  if (e.stderr) console.error(e.stderr);
  process.exit(1);
}
