/**
 * Regression test for #2418 (Greptile review on PR #2541): a scoped
 * incremental native build that hits an unreadable `file_hashes` table must
 * fail loudly, not silently complete with partial writes.
 *
 * `tryNativeOrchestrator`'s catch in `pipeline.ts` swallows *any* error from
 * the Rust orchestrator and falls back to the JS pipeline. For an ordinary
 * (non-scoped) incremental build, that fallback happens to independently
 * re-read `file_hashes` via `getChangedFiles`/`loadFileHashes` (fixed by
 * #2414) and throws correctly anyway. But a scoped build's JS fallback goes
 * straight to `handleScopedBuild`, which trusts the caller-provided scope
 * list and purges/rewrites those files without ever re-reading `file_hashes`
 * itself — so before this fix, the corruption this whole issue is about
 * would go completely unnoticed for a scoped native build, silently leaving
 * `file_hashes` (and potentially the rest of the graph) in a partially
 * updated, inconsistent state instead of throwing.
 *
 * Fixed by extending `isUnreadableBuildStateError` (`detect-changes.ts`) to
 * also recognize the `DB_STATE_UNREADABLE` marker embedded in a native-thrown
 * error's message (a plain `Error` crossing the napi boundary, never a
 * `DbError` instance), and checking it in `tryNativeOrchestrator`'s own catch
 * before falling through.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

describe('scoped native incremental build with unreadable file_hashes (#2418)', () => {
  it('throws instead of silently completing a partial scoped rebuild', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2418-scoped-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export function a() { return 1; }');
      await buildGraph(dir, { incremental: false, skipRegistry: true, engine: 'native' });

      const dbPath = path.join(dir, '.codegraph', 'graph.db');
      const readDb = new Database(dbPath, { readonly: true });
      const before = readDb.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number };
      readDb.close();
      expect(before.c).toBeGreaterThan(0);

      // Corrupt file_hashes: drop and recreate with an incompatible schema —
      // simulates corruption/a schema fault without needing a real lock.
      const raw = new Database(dbPath);
      raw.exec('DROP TABLE file_hashes; CREATE TABLE file_hashes (file TEXT);');
      raw.close();

      fs.writeFileSync(path.join(dir, 'a.ts'), 'export function a() { return 2; }');

      await expect(
        buildGraph(dir, {
          skipRegistry: true,
          engine: 'native',
          scope: ['a.ts'],
        }),
      ).rejects.toThrow(/DB_STATE_UNREADABLE|file_hashes/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
