/**
 * Regression test for #2080: object-rest-param bindings never got a
 * type-annotation-based typeMap seed, and — discovered while investigating
 * that — TypeScript's `required_parameter`/`optional_parameter` wrapper node
 * was never unwrapped at all in `collectObjectRestParams`
 * (`src/extractors/javascript.ts`) / `collect_object_rest_params`
 * (`crates/codegraph-core/src/extractors/javascript.rs`), so object-rest-param
 * bindings were silently never recorded for ANY `.ts`/`.tsx` file — not just
 * ones using a type annotation. tree-sitter-typescript wraps every
 * parameter, typed or not, in that node; plain tree-sitter-javascript does
 * not, which is why the existing #1336 test (`.js` only) never caught this.
 *
 * Two scenarios, both engines:
 *   1. Untyped rest param in a `.ts` file — the value-chase mechanism
 *      (#1336) should resolve identically to the equivalent `.js` file.
 *   2. Type-annotated rest param (`{ ...rest }: IWorker`) — CHA/interface
 *      dispatch through `rest` should resolve exactly like a plain typed
 *      parameter (`worker: IWorker`) already does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

interface CallEdgeRow {
  src: string;
  tgt: string;
  tgtFile: string;
  technique: string | null;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, n2.file AS tgtFile, e.technique
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

// Scenario 1: untyped rest param in .ts — value-chase parity with .js (#1336).
// realHandler is reachable ONLY through obj.e4 (no bare function literally
// named "e4" exists), so a same-name global fallback cannot mask a broken
// rest-param chain the way it would if the function itself were named "e4".
const UNTYPED_FIXTURE = `
function realHandler() { return 'x'; }
var obj = { e4: realHandler };

function f3({ ...eerest }) {
  eerest.e4();
}
f3(obj);
`;

function runUntypedScenario(engine: EngineMode): void {
  describe(`object-rest-param value-chase resolves in .ts files (#2080) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2080-untyped-${engine}-`));
      fs.writeFileSync(path.join(tmpDir, 'rest.ts'), UNTYPED_FIXTURE);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves f3 -> realHandler via the rest binding', () => {
      const all = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
      const found = all.find((e) => e.src === 'f3' && e.tgt === 'realHandler');
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
    });
  });
}

runUntypedScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runUntypedScenario('native');
});

// Scenario 2: type-annotated rest param — CHA/interface dispatch parity with
// a plain typed parameter.
function writeTypedFixture(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'worker.ts'),
    [
      'export interface IWorker {',
      '  doWork(): string;',
      '}',
      '',
      'export class ConcreteWorker implements IWorker {',
      '  doWork(): string {',
      "    return 'concrete';",
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'dispatcher.ts'),
    [
      "import type { IWorker } from './worker.js';",
      "import { ConcreteWorker } from './worker.js';",
      '',
      'function dispatchPlain(worker: IWorker): string {',
      '  return worker.doWork();',
      '}',
      '',
      'function dispatchRest({ ...rest }: IWorker): string {',
      '  return rest.doWork();',
      '}',
      '',
      'export function run(): string {',
      '  const w = new ConcreteWorker();',
      '  return dispatchPlain(w) + dispatchRest(w);',
      '}',
      '',
    ].join('\n'),
  );
}

function runTypedScenario(engine: EngineMode): void {
  describe(`object-rest-param type annotation enables CHA dispatch (#2080) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2080-typed-${engine}-`));
      writeTypedFixture(tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function edges(): CallEdgeRow[] {
      return readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    }

    it('dispatchRest resolves to ConcreteWorker.doWork via CHA, same as dispatchPlain', () => {
      const all = edges();
      const plain = all.find((e) => e.src === 'dispatchPlain' && e.tgt === 'ConcreteWorker.doWork');
      const rest = all.find((e) => e.src === 'dispatchRest' && e.tgt === 'ConcreteWorker.doWork');
      expect(plain, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(rest, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(rest?.technique).toBe(plain?.technique);
    });

    it('dispatchRest also resolves the interface signature edge like dispatchPlain', () => {
      const all = edges();
      const plain = all.find((e) => e.src === 'dispatchPlain' && e.tgt === 'IWorker.doWork');
      const rest = all.find((e) => e.src === 'dispatchRest' && e.tgt === 'IWorker.doWork');
      expect(plain).toBeDefined();
      expect(rest, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
    });
  });
}

runTypedScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runTypedScenario('native');
});
