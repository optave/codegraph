/**
 * Integration test for #2319 (second follow-up): Dart parameter shadowing a
 * same-named class field — a Greptile review finding on PR #2477.
 *
 * The FIRST follow-up fix (see `issue-2319-dart-cross-class-field-collision.
 * test.ts`) made `findDartSelectorReceiver` / `find_dart_selector_receiver` /
 * `handle_dart_call_expression` emit a bare-identifier receiver as
 * `this.<name>` unconditionally, so the resolver's class-scoped-key-first
 * lookup (`resolveReceiverTypeName` in `src/domain/graph/resolver/
 * strategy.ts`, `resolve_call_targets_core` in `build_edges.rs`) applies to
 * Dart's implicit-`this` field access. That fixed a real cross-class
 * field-name collision, but Dart also legally allows a method PARAMETER to
 * shadow a same-named class field of a DIFFERENT type for the rest of its
 * scope — the unconditional prefix broke that by activating the
 * class-scoped FIELD lookup even when the identifier was actually the
 * parameter.
 *
 * Fix: the receiver extraction now checks the enclosing function/method's
 * own parameter list and emits the BARE name (skipping the class-scoped
 * lookup entirely) when the receiver is shadowed, AND seeds a
 * function-scoped typeMap entry for the parameter's own type so the
 * resolver's existing function-scoped lookup
 * (`${callerName}::${effectiveReceiver}`, already used by JS/TS's #2235
 * mechanism) finds the PARAMETER's type instead of falling through to the
 * field's bare fallback key.
 *
 * This fixture defines a same-named `save()` method on both the field's
 * type and the shadowing parameter's type specifically so a WRONG (field-
 * typed) resolution would produce a real, distinguishable edge rather than
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

  void run(MockRepository _repo) {
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
  describe(`Dart parameter shadows field (#2319 second follow-up) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2319-dart-shadow-${engine}-`));
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

    it('resolves the shadowed call against the PARAMETER type (MockRepository.save)', () => {
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
