/**
 * Integration test for #2237: CHA (Class Hierarchy Analysis) dispatch had
 * two bugs, present identically in both engines:
 *
 * 1. The implementors map (interface/base-class name → concrete classes)
 *    was keyed by bare simple name, scanning every file in the build with no
 *    file/module scoping. Two unrelated files each declaring their own
 *    same-named interface would have their implementor sets merged,
 *    producing a false call edge into the wrong file's method.
 *
 * 2. CHA dispatch did a direct qualified lookup (`${concreteClass}.${method}`)
 *    for every RTA-instantiated concrete class — when that class INHERITS
 *    the dispatched method from an ancestor without overriding it, no node
 *    exists under the concrete class's own qualified name, so the lookup
 *    missed and the edge was never emitted.
 *
 * Fix: `ChaContext` gained `implementorsByFile` (a `${parentName}|${file}`
 * scoped map, populated only when the child's own file also locally
 * declares a same-named parent) which `resolveChaTargets`/
 * `resolve_cha_dispatch` prefer at the BFS root when the caller's file has a
 * matching local declaration; and a `resolveMethodViaAncestors`/
 * `resolve_method_via_ancestors` walk that follows `parents` up to the
 * declaring ancestor when a direct qualified lookup misses.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'mod1/caller.ts': `
export interface Handler {
  run(): void;
}
export class HandlerA implements Handler {
  run() {}
}
export function main(h: Handler) {
  h.run();
}
export function makeHandlerA(): Handler {
  return new HandlerA();
}
`,
  'mod2/other.ts': `
export interface Handler {
  run(): void;
}
export class HandlerB implements Handler {
  run() {}
}
export function makeHandlerB(): Handler {
  return new HandlerB();
}
`,
  'inherited.ts': `
export interface IHandler {
  run(): void;
}
export abstract class AbstractHandler implements IHandler {
  run() {}
}
export class ConcreteHandler extends AbstractHandler {}
export function dispatch(h: IHandler) {
  h.run();
}
export function makeConcrete(): IHandler {
  return new ConcreteHandler();
}
`,
};

function writeFixture(rootDir: string) {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function getCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, e.technique AS technique
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string; technique: string | null }>;
  } finally {
    db.close();
  }
}

function runSuite(engine: 'wasm' | 'native') {
  describe(`CHA implementor scoping + inherited-method walk (#2237) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2237-${engine}-`));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves main.h.run() to HandlerA.run only, not the unrelated HandlerB.run', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = getCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'main' && e.tgt === 'HandlerA.run'),
        `Expected main -> HandlerA.run; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
      expect(edges.some((e) => e.src === 'main' && e.tgt === 'HandlerB.run')).toBe(false);
    });

    it('resolves dispatch.h.run() to AbstractHandler.run via the inherited-method walk', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = getCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'dispatch' && e.tgt === 'AbstractHandler.run'),
        `Expected dispatch -> AbstractHandler.run; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });
  });
}

runSuite('wasm');

describe.skipIf(!isNativeAvailable())('native engine parity', () => {
  runSuite('native');
});
