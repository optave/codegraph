/**
 * Regression test for #2245: `buildCallEdgesNative` (`build-edges.ts`, the
 * TS wrapper around Rust's `build_call_edges` FFI, used for the "hybrid"
 * build path — JS pipeline + native `buildCallEdges`, reachable via an
 * engine switch mid-incremental-build) tagged every `calls`-kind edge
 * `technique = 'ts-native'` unconditionally, without checking
 * `dynamic_kind` first. A flag-only dynamic-call sink edge (`eval`,
 * confidence=0, dynamic=1, `dynamic_kind` set) got `technique='ts-native'`
 * on this path instead of `technique=NULL`, diverging from both the
 * WASM/JS inline path and the native orchestrator's own full-build intent
 * (#1995 — same root-cause class, a different code path).
 *
 * The hybrid path is reached by building once with one engine, then again
 * with the other — the engine change forces a full rebuild that skips the
 * fast native orchestrator and falls back to the JS pipeline using native
 * FFI for call-edge resolution (`buildCallEdgesNative`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// Written to a temp fixture file for codegraph's own static parser to scan
// for a dynamic-call sink — never executed by this test itself.
const FIXTURE_SOURCE = `
export function callDynamic(name) {
  eval(name + '()');
}
`;

interface SinkEdgeRow {
  dynamicKind: string;
  technique: string | null;
}

function readDynamicSinkEdges(dbPath: string): SinkEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT dynamic_kind AS dynamicKind, technique
         FROM edges
         WHERE dynamic_kind IS NOT NULL`,
      )
      .all() as SinkEdgeRow[];
  } finally {
    db.close();
  }
}

describe.skipIf(!isNativeAvailable())(
  'hybrid build path tags dynamic-sink edges technique=NULL (#2245)',
  () => {
    let tmpDir: string;
    let dbPath: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2245-'));
      fs.writeFileSync(path.join(tmpDir, 'main.js'), FIXTURE_SOURCE);

      // First build with wasm (incremental: false — a fresh incremental
      // build never persists build_meta's engine field, so a later engine
      // switch wouldn't be detected; unrelated to this issue, filed
      // separately), then rebuild with native — the engine change forces a
      // full rebuild that skips the fast native orchestrator and routes
      // call-edge resolution through the hybrid buildCallEdgesNative path
      // (JS pipeline + native buildCallEdges FFI).
      await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine: 'wasm' });
      await buildGraph(tmpDir, { incremental: true, skipRegistry: true, engine: 'native' });
      dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    }, 60_000);

    afterAll(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('the eval() sink edge has dynamic_kind set and technique NULL, not ts-native', () => {
      const sinkEdges = readDynamicSinkEdges(dbPath);
      const evalEdge = sinkEdges.find((e) => e.dynamicKind === 'eval');
      expect(
        evalEdge,
        `Expected an eval-tagged dynamic-sink edge.\nActual dynamic-kind edges:\n${JSON.stringify(sinkEdges, null, 2)}`,
      ).toBeDefined();
      expect(evalEdge?.technique).toBeNull();
    });
  },
);
