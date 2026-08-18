/**
 * Integration test for #2483: the native engine's full-build dataflow-vertex
 * pass (`runDataflowVertexPass` in `native-orchestrator.ts`, P6) scoped
 * itself to files that already had `dataflow` EDGE rows (flows_to/returns/
 * mutates) from the Rust orchestrator, skipping vertex extraction entirely
 * for every other native-language file.
 *
 * That scoping conflated "has inter-procedural dataflow edges" with "needs
 * vertex rows at all" — a plain leaf function with params and a return, but
 * no calls to or from any other function, legitimately has NO dataflow
 * edges yet still has vertex-worthy params/returns
 * (`extractDataflowAnalysis`'s vertex output isn't gated on argFlows/
 * assignments/mutations being non-empty). The WASM engine has always
 * recorded these vertices unconditionally; the native engine silently
 * dropped them for every file with zero inter-procedural edges — in
 * practice, most files in a typical codebase.
 *
 * Fix: the full-build file-selection filter now includes any native-
 * language file with at least one function/method definition (checked via
 * the `nodes` table, kind IN CALLABLE_SYMBOL_KINDS), not just files that
 * happen to already have `dataflow` edge rows.
 *
 * Follow-up: broadening that filter also broadened how many files a
 * literal no-op incremental rebuild (zero files changed) re-scans, since
 * `changedFiles === []` fell into the same "full build" branch as
 * `changedFiles === undefined` — caught by the perf-canary "No-op rebuild"
 * benchmark. Fixed by adding the same "quiet incremental: nothing changed"
 * early return `backfillEdgeTechniquesAfterNativeOrchestrator` already had
 * for the identical `isFullBuild=false, changedFiles=[]` case. The second
 * describe block below locks in that a no-op rebuild doesn't lose the
 * vertices a prior build already inserted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'leaf.js': `
function greet(name) {
  return name + '!';
}

function shout(word) {
  return word.toUpperCase();
}
`,
};

function writeFixture(rootDir: string) {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(rootDir, rel), content);
  }
}

function readDataflowVertices(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n.name AS func_name, dv.kind, dv.name
         FROM dataflow_vertices dv
         JOIN nodes n ON n.id = dv.func_id
         ORDER BY n.name, dv.kind, dv.name`,
      )
      .all() as Array<{ func_name: string; kind: string; name: string | null }>;
  } finally {
    db.close();
  }
}

describe.skipIf(!isNativeAvailable())(
  'native full-build dataflow vertices for leaf functions (#2483)',
  () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2483-native-dfv-'));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, {
        engine: 'native',
        incremental: false,
        dataflow: true,
        skipRegistry: true,
      });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('records param and return vertices for a leaf function with no inter-procedural dataflow', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const vertices = readDataflowVertices(dbPath);
      expect(
        vertices.some((v) => v.func_name === 'greet' && v.kind === 'param' && v.name === 'name'),
        `missing greet param vertex; got: ${JSON.stringify(vertices)}`,
      ).toBe(true);
      expect(
        vertices.some((v) => v.func_name === 'greet' && v.kind === 'return'),
        `missing greet return vertex; got: ${JSON.stringify(vertices)}`,
      ).toBe(true);
    });

    it('records vertices for every leaf function in the file, not just the first', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const vertices = readDataflowVertices(dbPath);
      expect(
        vertices.some((v) => v.func_name === 'shout' && v.kind === 'param' && v.name === 'word'),
        `missing shout param vertex; got: ${JSON.stringify(vertices)}`,
      ).toBe(true);
      expect(
        vertices.some((v) => v.func_name === 'shout' && v.kind === 'return'),
        `missing shout return vertex; got: ${JSON.stringify(vertices)}`,
      ).toBe(true);
    });
  },
);

describe.skipIf(!isNativeAvailable())(
  'native no-op incremental rebuild preserves dataflow vertices (#2483 follow-up)',
  () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2483-native-noop-'));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, {
        engine: 'native',
        incremental: false,
        dataflow: true,
        skipRegistry: true,
      });
      // Second build with zero source changes — an incremental no-op.
      await buildGraph(tmpDir, {
        engine: 'native',
        incremental: true,
        dataflow: true,
        skipRegistry: true,
      });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("still has both leaf functions' vertices after a no-op incremental rebuild", () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const vertices = readDataflowVertices(dbPath);
      expect(
        vertices.some((v) => v.func_name === 'greet' && v.kind === 'param' && v.name === 'name'),
        `missing greet param vertex after no-op rebuild; got: ${JSON.stringify(vertices)}`,
      ).toBe(true);
      expect(
        vertices.some((v) => v.func_name === 'shout' && v.kind === 'param' && v.name === 'word'),
        `missing shout param vertex after no-op rebuild; got: ${JSON.stringify(vertices)}`,
      ).toBe(true);
    });
  },
);
