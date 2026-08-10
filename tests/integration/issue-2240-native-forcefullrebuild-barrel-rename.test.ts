/**
 * Regression test for #2240: `buildNativeReexports`
 * (`src/domain/graph/builder/stages/build-edges.ts`) flattened
 * `ctx.reexportMap` into the native FFI's `ReexportEntryInput` shape but
 * dropped the `renames` field (`{ local, imported }` pairs from
 * `export { X as Y } from './foo'`). The Rust side fully supports
 * `ReexportEntryInput.renames`, but since JS never populated it, a
 * renamed-barrel edge silently failed to resolve.
 *
 * This only reproduces on the native engine's *fallback* path
 * (`buildImportEdgesNative`, still using the native FFI for edge
 * resolution but orchestrated from JS) — reached when the full Rust
 * orchestrator (`tryNativeOrchestrator`) is skipped because
 * `ctx.forceFullRebuild` is set (engine/schema/version/config-hash
 * mismatch). A fresh full native build always uses the Rust orchestrator,
 * which threads `renames` correctly, so the bug is invisible on first
 * build — only a subsequent forced-full-rebuild-via-fallback loses it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, openDb, setBuildMeta } from '../../src/db/index.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

function hasImportEdge(dbPath: string, fromFile: string, toFile: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE n1.kind = 'file' AND n1.file = ? AND n2.kind = 'file' AND n2.file = ?
         AND e.kind IN ('imports', 'imports-type')`,
      )
      .get(fromFile, toFile);
    return row !== undefined;
  } finally {
    db.close();
  }
}

describe.skipIf(!isNativeAvailable())(
  'native forceFullRebuild fallback preserves renamed barrel edges (#2240)',
  () => {
    let tmpDir: string;
    let dbPath: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2240-'));
      fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'export function realName() { return 1; }\n');
      fs.writeFileSync(
        path.join(tmpDir, 'barrel.js'),
        "export { realName as aliasName } from './foo.js';\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, 'consumer.js'),
        "import { aliasName } from './barrel.js';\naliasName();\n",
      );

      // Fresh full build — uses the full Rust orchestrator, which threads
      // `renames` correctly, so the barrel-through edge is present.
      await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine: 'native' });
      dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    }, 60_000);

    afterAll(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves the renamed barrel-through import edge on the initial full build', () => {
      expect(hasImportEdge(dbPath, 'consumer.js', 'foo.js')).toBe(true);
    });

    it('still resolves the renamed barrel-through import edge after a forced full rebuild via the fallback path', async () => {
      // Simulate a schema-version mismatch (e.g. right after an upgrade) —
      // forces forceFullRebuild=true, which skips tryNativeOrchestrator and
      // routes edge resolution through buildImportEdgesNative instead.
      const db = openDb(dbPath);
      setBuildMeta(db, { schema_version: '0' });
      closeDb(db);

      const stderrSpy: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        stderrSpy.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        await buildGraph(tmpDir, { incremental: true, skipRegistry: true, engine: 'native' });
      } finally {
        process.stderr.write = origWrite;
      }
      const output = stderrSpy.join('');
      expect(output).toContain('promoting to full rebuild');

      expect(hasImportEdge(dbPath, 'consumer.js', 'foo.js')).toBe(true);
    }, 60_000);
  },
);
