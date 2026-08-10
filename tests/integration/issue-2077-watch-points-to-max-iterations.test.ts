/**
 * Regression test for issue #2077 — thread the configured
 * `pointsToMaxIterations` through watch-mode's points-to map construction.
 *
 * `buildCallEdges` in `src/domain/graph/builder/incremental.ts` used to call
 * `buildPointsToMapForFile(symbols, importedNames)` with only 2 arguments, so
 * the points-to solver's fixed-point iteration cap silently fell back to
 * `buildPointsToMapForFile`'s own default parameter
 * (`DEFAULTS.analysis.pointsToMaxIterations`) instead of the resolved
 * `config.analysis.pointsToMaxIterations` that the full-build path
 * (`stages/build-edges.ts`) passes explicitly. A `.codegraphrc.json` override
 * therefore had no effect on `codegraph watch`'s incremental rebuilds.
 *
 * This reuses the 8-hop function-alias chain fixture from
 * `issue-1753-points-to-max-iterations.test.ts` (that issue fixed full-build
 * threading; this one covers the incremental/watch-mode path) and calls
 * `rebuildFile` directly with an explicit `EngineOpts.pointsToMaxIterations`
 * override, exercising both call paths that feed `buildPointsToMapForFile`:
 *   - `rebuildEdgesForTargetFile` — the file that changed itself
 *   - `rebuildReverseDepEdges` — files that depend on the one that changed
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { createIncrementalStmts } from '../helpers/incremental-stmts.js';

// 8-hop alias chain: a0 requires exactly 8 fixed-point iterations to resolve
// to `handler` (one hop propagates per solver iteration).
const CHAIN_LENGTH = 8;

const HANDLER_JS = `
export function handler(item) {
  return item * 2;
}
`.trimStart();

function buildConsumerSource(): string {
  const lines = [
    "import { handler } from './handler.js';",
    '',
    'export function processItems(items) {',
  ];
  for (let i = 0; i < CHAIN_LENGTH - 1; i++) {
    lines.push(`  const a${i} = a${i + 1};`);
  }
  lines.push(`  const a${CHAIN_LENGTH - 1} = handler;`);
  lines.push('  return items.map(a0);');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

const CONSUMER_JS = buildConsumerSource();

const dirsToClean: string[] = [];

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handler.js'), HANDLER_JS);
  fs.writeFileSync(path.join(dir, 'consumer.js'), CONSUMER_JS);
}

function hasAliasChainEdge(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'`,
      )
      .all() as Array<{ src: string; tgt: string }>;
    return rows.some((r) => r.src === 'processItems' && r.tgt === 'handler');
  } finally {
    db.close();
  }
}

afterAll(() => {
  for (const dir of dirsToClean) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('Incremental buildCallEdges honors EngineOpts.pointsToMaxIterations (#2077)', () => {
  it('suppresses the alias-chain edge on an incremental rebuild of the changed file itself', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2077-target-'));
    dirsToClean.push(dir);
    writeFixture(dir);

    await buildGraph(dir, { engine: 'wasm', incremental: false, skipRegistry: true });
    const dbPath = path.join(dir, '.codegraph', 'graph.db');
    // Sanity check: the default cap (50) resolves the 8-hop chain.
    expect(hasAliasChainEdge(dbPath)).toBe(true);

    const consumerFile = path.join(dir, 'consumer.js');
    fs.appendFileSync(consumerFile, '\n// touch\n');

    const db = openDb(dbPath);
    initSchema(db);
    await rebuildFile(
      db,
      dir,
      consumerFile,
      createIncrementalStmts(db),
      { engine: 'wasm', pointsToMaxIterations: 3 },
      null,
    );
    db.close();

    expect(
      hasAliasChainEdge(dbPath),
      'rebuildEdgesForTargetFile must forward pointsToMaxIterations to buildPointsToMapForFile',
    ).toBe(false);
  }, 60_000);

  it('suppresses the alias-chain edge via the reverse-dep cascade when a dependency changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2077-revdep-'));
    dirsToClean.push(dir);
    writeFixture(dir);

    await buildGraph(dir, { engine: 'wasm', incremental: false, skipRegistry: true });
    const dbPath = path.join(dir, '.codegraph', 'graph.db');
    expect(hasAliasChainEdge(dbPath)).toBe(true);

    // Touch handler.js (the dependency), NOT consumer.js — consumer.js is
    // rebuilt as a reverse dep, exercising rebuildReverseDepEdges rather than
    // rebuildEdgesForTargetFile.
    const handlerFile = path.join(dir, 'handler.js');
    fs.appendFileSync(handlerFile, '\n// touch\n');

    const db = openDb(dbPath);
    initSchema(db);
    await rebuildFile(
      db,
      dir,
      handlerFile,
      createIncrementalStmts(db),
      { engine: 'wasm', pointsToMaxIterations: 3 },
      null,
    );
    db.close();

    expect(
      hasAliasChainEdge(dbPath),
      'rebuildReverseDepEdges must forward pointsToMaxIterations to buildPointsToMapForFile',
    ).toBe(false);
  }, 60_000);

  it('still resolves the alias-chain edge when the override cap is high enough', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2077-cap-ok-'));
    dirsToClean.push(dir);
    writeFixture(dir);

    await buildGraph(dir, { engine: 'wasm', incremental: false, skipRegistry: true });
    const dbPath = path.join(dir, '.codegraph', 'graph.db');

    const consumerFile = path.join(dir, 'consumer.js');
    fs.appendFileSync(consumerFile, '\n// touch\n');

    const db = openDb(dbPath);
    initSchema(db);
    await rebuildFile(
      db,
      dir,
      consumerFile,
      createIncrementalStmts(db),
      { engine: 'wasm', pointsToMaxIterations: CHAIN_LENGTH },
      null,
    );
    db.close();

    expect(hasAliasChainEdge(dbPath)).toBe(true);
  }, 60_000);
});
