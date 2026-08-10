/**
 * Integration test for #2259: a method-kind EventEmitter callback
 * registration (`emitter.on('event', (msg) => this.handler(msg))`) produced
 * no `calls` edge to the handler, even though the extractor already emits a
 * `{ name: 'handler', receiver: 'this' }` Call for it. The handler's own
 * callees were then wrongly flagged dead once #2032's reachability
 * downgrade landed, since nothing reached the handler at all.
 *
 * Root cause: `extractCallbackDefinition` creates a synthetic
 * `event:${eventName}` definition spanning just the callback's own
 * (typically one-line) body, so `.on()`'s callback registrations get their
 * own entry-point node for root classification and remain the call's
 * ATTRIBUTED CALLER — but a synthetic `event:`/`route:`/`command:`-prefixed
 * definition has no class/`this` context of its own, so a `this.handler()`
 * call attributed to it could never resolve through any strategy in the
 * this/self/super cascade.
 *
 * Fix: when the attributed caller is a synthetic placeholder, supply the
 * nearest REAL enclosing method's class as a resolution-only hint (used
 * ONLY to resolve `this`/`self` — see `findEnclosingClassHint` in
 * call-resolver.ts). The call's edge still sources from the synthetic
 * placeholder unchanged, so flow/sequence traversal starting from that
 * entry point still sees the callback's own calls (Greptile review, PR
 * #2444, on an earlier version of this fix that instead switched caller
 * attribution to the real method and broke that traversal).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'pool.ts': `
type WorkerResponse = { id: number };

class WasmWorkerPool {
  private worker: any;

  ensureWorker(): any {
    const w = new Worker(resolveWorkerEntry());
    this.worker = w;
    w.on('message', (msg: WorkerResponse) => this.onMessage(msg));
    return w;
  }

  onMessage(msg: WorkerResponse): void {
    return deserializeResult(msg);
  }
}

function resolveWorkerEntry(): string {
  return '';
}
function deserializeResult(msg: any): any {
  return msg;
}
export function start(): void {
  new WasmWorkerPool().ensureWorker();
}
`,
};

const DEAD_ROLES = new Set(['dead-unresolved', 'dead-leaf', 'dead-entry', 'dead-ffi']);

function readNodesWithRoles(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, kind, role FROM nodes ORDER BY name').all() as Array<{
      name: string;
      kind: string;
      role: string | null;
    }>;
  } finally {
    db.close();
  }
}

function countCallEdges(dbPath: string, sourceName: string, targetName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND s.name = ? AND t.name = ?`,
      )
      .get(sourceName, targetName) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function runShared(getDbPath: () => string) {
  it('creates a calls edge from the synthetic event: entry to the this-bound handler, resolving via the enclosing class hint', () => {
    expect(
      countCallEdges(getDbPath(), 'event:message', 'WasmWorkerPool.onMessage'),
    ).toBeGreaterThan(0);
  });

  it('does not misattribute the call to the enclosing real method instead (Greptile review, PR #2444)', () => {
    // The call must stay sourced from the synthetic entry point, not the
    // enclosing `ensureWorker` — otherwise flow/sequence traversal starting
    // from `event:message` would see no outgoing edges at all.
    expect(
      countCallEdges(getDbPath(), 'WasmWorkerPool.ensureWorker', 'WasmWorkerPool.onMessage'),
    ).toBe(0);
  });

  it('keeps the handler and its own callees reachable, not dead', () => {
    const nodes = readNodesWithRoles(getDbPath());
    const onMessage = nodes.find((n) => n.name === 'WasmWorkerPool.onMessage');
    const callee = nodes.find((n) => n.name === 'deserializeResult');
    expect(onMessage, 'onMessage node not found').toBeDefined();
    expect(callee, 'deserializeResult node not found').toBeDefined();
    expect(DEAD_ROLES.has(onMessage!.role ?? '')).toBe(false);
    expect(DEAD_ROLES.has(callee!.role ?? '')).toBe(false);
  });
}

describe('EventEmitter this-bound callback registration resolves via enclosing-class hint (#2259) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2259-'));
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
  'EventEmitter this-bound callback registration resolves via enclosing-class hint (#2259) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2259-native-'));
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
