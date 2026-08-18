/**
 * Integration test for #2478: Dart LOCAL VARIABLE shadowing a same-named
 * class field — the counterpart to #2319's second follow-up (PR #2477),
 * which only handled a shadowing PARAMETER.
 *
 * Dart also legally allows a local variable declaration to shadow a
 * same-named class field of a DIFFERENT type for the rest of its enclosing
 * block:
 *
 *   class Service {
 *     final Repository _repo;
 *     Service(this._repo);
 *     void run() {
 *       var _repo = MockRepository();
 *       _repo.mockOnlyMethod();   // means the LOCAL, not the field
 *     }
 *   }
 *
 * Fix: `findDartSelectorReceiver` / `find_dart_selector_receiver` /
 * `handle_dart_call_expression`'s receiver extraction now also checks
 * `findEnclosingDartShadowingLocalName` / `find_enclosing_dart_shadowing_
 * local_name`, which walks up the call site's enclosing `block`s (stopping
 * at the function body boundary) checking each block's own preceding
 * siblings for a matching `local_variable_declaration` — correctly bounded
 * by both block scope (a local declared in a sibling `if`/`for` block never
 * matches) and declaration order (a local declared later in the same block
 * never retroactively shadows an earlier call).
 *
 * This fixture defines a same-named `save()` method on both the field's
 * type and the shadowing local's type specifically so a WRONG (field-typed)
 * resolution would produce a real, distinguishable edge rather than
 * silently resolving to nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'services.dart': `
class Repository {
  void save() {}
}

class MockRepository {
  void save() {}
}

class Service {
  final Repository _repo;

  Service(this._repo);

  void run() {
    var _repo = MockRepository();
    _repo.save();
  }
}
`,
};

function writeFixture(rootDir: string) {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(rootDir, rel), content);
  }
}

function readCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string }>;
  } finally {
    db.close();
  }
}

function runSuite(engine: 'wasm' | 'native') {
  describe(`Dart local variable shadows field (#2478) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2478-dart-shadow-${engine}-`));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('never resolves the shadowed call against the FIELD type (Repository.save)', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'Service.run' && e.tgt === 'Repository.save'),
        `Service.run must NOT resolve to Repository.save (the field's type); got: ${JSON.stringify(edges)}`,
      ).toBe(false);
    });

    it('resolves the shadowed call against the LOCAL VARIABLE type (MockRepository.save)', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'Service.run' && e.tgt === 'MockRepository.save'),
        `Service.run -> MockRepository.save edge missing; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });
  });
}

runSuite('wasm');

describe.skipIf(!isNativeAvailable())('native engine parity', () => {
  runSuite('native');
});
