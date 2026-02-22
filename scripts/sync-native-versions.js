#!/usr/bin/env node
/**
 * Syncs @optave/codegraph-* optionalDependencies versions to match the root version.
 * Runs automatically via the npm "version" lifecycle hook.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const v = pkg.version;

for (const key of Object.keys(pkg.optionalDependencies)) {
  if (key.startsWith('@optave/codegraph-')) {
    pkg.optionalDependencies[key] = v;
  }
}

writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
