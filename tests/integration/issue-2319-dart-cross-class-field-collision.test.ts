/**
 * Integration test for #2319 (follow-up): Dart cross-class field-name
 * collision — a Greptile review finding on PR #2477.
 *
 * PR #2477 seeded typeMap entries for Dart's explicitly-typed field
 * declarations so receiver-typed calls (`_repo.findById(id)`) could
 * resolve. Its receiver extraction (`findDartSelectorReceiver` in
 * `src/extractors/dart.ts`, `find_dart_selector_receiver` /
 * `handle_dart_call_expression` in `crates/codegraph-core/src/extractors/
 * dart.rs`) originally emitted the bare identifier text (`_repo`) as the
 * call's receiver — unlike JS/TS, which always writes an explicit `this.`
 * prefix for a field access. Because the resolver's class-scoped-key-first
 * lookup (`resolveReceiverTypeName` in `src/domain/graph/resolver/
 * strategy.ts`, and its Rust mirror `resolve_call_targets_core` in
 * `build_edges.rs`) only activates when a `this.`/`self.` prefix was
 * present and stripped, a bare Dart receiver skipped straight to the bare
 * fallback typeMap key — which two different classes in the same file, each
 * with a same-named field of a different type, both write to at the SAME
 * confidence (0.6). Whichever write won (first-write-wins on a tie; see
 * `setTypeMapEntry` / `dedup_type_map`) silently corrupted the OTHER
 * class's call resolution.
 *
 * Fix: `findDartSelectorReceiver` / `find_dart_selector_receiver` /
 * `handle_dart_call_expression` now emit a bare-identifier receiver as
 * `this.<name>` — textually identical to JS/TS's own `this.field` shape —
 * so the EXISTING class-scoped-key-first mechanism (originally added for
 * #1323/#1458) applies to Dart with no resolver changes needed.
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
class OrderRepository {
  void save() {}
}

class UserRepository {
  void save() {}
}

class OrderService {
  final OrderRepository _repo;

  OrderService(this._repo);

  void run() {
    _repo.save();
  }
}

class UserService {
  final UserRepository _repo;

  UserService(this._repo);

  void run() {
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
  describe(`Dart cross-class field-name collision (#2319 follow-up) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2319-dart-${engine}-`));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves _repo.save() inside OrderService.run to OrderRepository.save', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'OrderService.run' && e.tgt === 'OrderRepository.save'),
        `OrderService.run -> OrderRepository.save edge missing; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    it('resolves _repo.save() inside UserService.run to UserRepository.save', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'UserService.run' && e.tgt === 'UserRepository.save'),
        `UserService.run -> UserRepository.save edge missing; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    it('does not cross-resolve OrderService.run to UserRepository.save', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'OrderService.run' && e.tgt === 'UserRepository.save'),
      ).toBe(false);
    });

    it('does not cross-resolve UserService.run to OrderRepository.save', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'UserService.run' && e.tgt === 'OrderRepository.save'),
      ).toBe(false);
    });
  });
}

runSuite('wasm');

describe.skipIf(!isNativeAvailable())('native engine parity', () => {
  runSuite('native');
});
