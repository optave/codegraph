/**
 * Integration test for #2268: CJS `require()` import-artifact classification
 * (`cjsRequireBindings` in TS, `Import.cjs_require` in Rust — see #1661) only
 * ever recognized an object-pattern destructure of the require() result.
 * `const [a, b] = require('./mod')` never got recorded as import-sourced by
 * either engine — the bound names were extracted as plain `constant`
 * Definitions but never classified as import artifacts.
 *
 * Observable consequence, per `resolveReceiverEdge`'s own #1539 rule (a local
 * same-file symbol always wins over a same-named cross-file one *unless* it's
 * classified as an import artifact, in which case resolution correctly falls
 * back to the global/cross-file candidate): `consumer.js` below destructures
 * `Logger` via an array-pattern require, then does `new Logger()` — before
 * the fix, `Logger` was wrongly treated as a *locally-owned* symbol (a
 * `constant`-kind Definition, which fails the `RECEIVER_KINDS` filter), so
 * the receiver edge to `loggerMod.js`'s real `class Logger` was silently
 * dropped instead of falling back to it.
 *
 * Fix: `extractCjsRequireBinding`/`record_cjs_require_import` now handle
 * array-pattern destructures too, in the WASM query path
 * (`extractDestructuredDeclarators`), the WASM walk path
 * (`handleConstArrayPatternAssignment`), and the Rust extractor
 * (`handle_var_decl`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'loggerMod.js': `
class Logger {
  log() { return 1; }
}
module.exports = { Logger };
`,
  'consumer.js': `
const [Logger] = require('./loggerMod');
function run() {
  const l = new Logger();
  l.log();
}
`,
};

function countReceiverEdges(
  dbPath: string,
  sourceName: string,
  targetName: string,
  targetFile: string,
): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'receiver' AND s.name = ? AND t.name = ? AND t.file = ?`,
      )
      .get(sourceName, targetName, targetFile) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function runShared(getDbPath: () => string) {
  it('resolves the array-pattern-required name to the cross-file class, not the local constant', () => {
    expect(countReceiverEdges(getDbPath(), 'run', 'Logger', 'loggerMod.js')).toBeGreaterThan(0);
  });
}

describe('CJS require() array-pattern destructure gets import-artifact classification (#2268) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2268-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  runShared(() => path.join(tmpDir, '.codegraph', 'graph.db'));
});

describe.skipIf(!isNativeAvailable())(
  'CJS require() array-pattern destructure gets import-artifact classification (#2268) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2268-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    runShared(() => path.join(nativeTmpDir, '.codegraph', 'graph.db'));
  },
);
