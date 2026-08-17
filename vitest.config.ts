import { defineConfig } from 'vitest/config';

const [major, minor] = process.versions.node.split('.').map(Number);
const existing = process.env.NODE_OPTIONS || '';
// Node 24+ has type stripping on by default and removed --strip-types from the
// NODE_OPTIONS allowlist, so injecting the flag is both unnecessary and fatal
// (workers refuse to start). Only inject for the Node 22.6+ / Node 23 window
// where the flag is required and accepted.
const needsStripFlag = (major === 22 && minor >= 6) || major === 23;
const stripFlag = major === 23 ? '--strip-types' : '--experimental-strip-types';

export default defineConfig({
  resolve: {
    conditions: ['@codegraph/source'],
  },
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: ['**/node_modules/**', '**/.git/**', '**/.claude/**'],
    // Issue #2439: rebuild dist/ once before the whole run (regardless of
    // `npm test` vs. a direct `npx vitest run <file>`), so the WASM engine's
    // worker — which always loads compiled dist/, even when tests import
    // src/*.ts directly — never silently runs stale extraction logic. See
    // scripts/vitest-global-setup.ts for why this isn't a hand-rolled
    // staleness check.
    globalSetup: './scripts/vitest-global-setup.ts',
    // Ensure child processes spawned by tests (e.g. CLI integration tests)
    // can load .ts files via Node's built-in type stripping.
    env: {
      NODE_OPTIONS: [
        existing,
        needsStripFlag && !existing.includes('--experimental-strip-types') && !existing.includes('--strip-types')
          ? stripFlag
          : '',
      ].filter(Boolean).join(' '),
    },
  },
});
