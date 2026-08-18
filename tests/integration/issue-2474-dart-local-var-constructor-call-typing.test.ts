/**
 * Integration test for #2474: a Dart local variable initialized from a bare
 * constructor call (`var svc = UserService(repo);`) never seeded a typeMap
 * entry, unlike every other language extractor's identical "assign a
 * constructor call to a local variable" convention (e.g. JS/TS's
 * `handleVarDeclaratorTypeMap`) — so a later call through that local
 * (`svc.createUser()`) could never resolve via the typeMap and the call edge
 * was silently dropped.
 *
 * Fix: `handleDartLocalVarTypeMap` / `handle_dart_local_var_type_map` now
 * seed a function-scoped typeMap entry (`${enclosingQualifier}::${name}`,
 * confidence 1.0) for an `initialized_variable_definition` whose initializer
 * is a bare constructor call, mirroring `handleDartFormalParamTypeMap`'s
 * identical scoping convention for parameters (#2235/#2319).
 *
 * `UserService` and `UserRepository` are named distinctly (rather than
 * reusing a generic name already declared elsewhere in the fixture) so a
 * resolved edge is unambiguous, and `createUser` is a name unique to
 * `UserService` so a wrong or missing resolution is easy to tell apart from
 * a coincidental match.
 *
 * Greptile review findings on this PR: since Dart lets a constructor call
 * omit `new`, an ordinary function call (`MakeService()`) is syntactically
 * identical to a genuine constructor call at this position — capitalization
 * (this fix's gate) narrows but does not eliminate the ambiguity, since a
 * legally-named uppercase ordinary function is possible too. Verified via
 * the `factory_function.dart` fixture below: wrongly seeding `order`'s type
 * as the non-existent `MakeOrderService` currently causes
 * `order.placeOrder()`'s edge to be dropped, NOT misrouted to a fabricated
 * target — both `resolveByReceiver` (resolver/strategy.ts) and
 * `resolve_call_targets_core` (build_edges.rs) skip the untyped
 * direct-qualified fallback whenever any typeMap entry exists for the
 * receiver, a pre-existing, language-agnostic resolver property this PR
 * doesn't change. Closing this residual gap is tracked separately in #2568
 * (needs either a shared-resolver change spanning every language on this
 * cascade, or a same-file cross-check that requires refactoring this file's
 * single-pass walker into a two-pass design first) — out of scope here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'user_service.dart': `
class UserRepository {
  void findById() {}
}

class UserService {
  final UserRepository _repo;

  UserService(this._repo);

  void createUser() {}
}

void main() {
  var repo = UserRepository();
  var svc = UserService(repo);
  svc.createUser();
}

class Controller {
  void run() {
    var svc = UserService(UserRepository());
    svc.createUser();
  }
}
`,
  'factory_function.dart': `
class OrderService {
  void placeOrder() {}
}

// Capitalized but NOT a class — an ordinary top-level function. The
// capitalization gate can't tell this apart from a real constructor call at
// its call site below, so \`order\`'s type is wrongly seeded as the
// non-existent type "MakeOrderService".
OrderService MakeOrderService() {
  return OrderService();
}

void placeAnOrder() {
  var order = MakeOrderService();
  order.placeOrder();
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
  describe(`Dart local-variable constructor-call typing (#2474) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2474-dart-localvar-${engine}-`));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves a call through a top-level function local seeded from a bare constructor call', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'main' && e.tgt === 'UserService.createUser'),
        `main -> UserService.createUser edge missing; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    it('resolves a call through a class-method local seeded from a bare constructor call', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'Controller.run' && e.tgt === 'UserService.createUser'),
        `Controller.run -> UserService.createUser edge missing; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    // Known limitation (#2568), NOT something this fix claims to solve: a
    // capitalized ORDINARY function used as an initializer still gets
    // wrongly typed, since Dart has no syntactic way to tell it apart from a
    // genuine constructor call. This test locks in the safe half of that
    // outcome — the wrong guess must never fabricate an edge to some
    // unrelated node that happens to share the guessed (nonexistent) type
    // name — while documenting, not hiding, that the real edge is currently
    // dropped rather than resolved.
    it('never fabricates an edge when the capitalized callee is an ordinary function, not a class', () => {
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const edges = readCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'placeAnOrder' && e.tgt === 'MakeOrderService.placeOrder'),
        `must never fabricate an edge to the nonexistent MakeOrderService.placeOrder; got: ${JSON.stringify(edges)}`,
      ).toBe(false);
      expect(
        edges.some((e) => e.src === 'placeAnOrder' && e.tgt === 'OrderService.placeOrder'),
        `placeAnOrder -> OrderService.placeOrder is currently dropped, not resolved (#2568) — \
if this now passes, the resolver gap has been closed: update this test and the doc comments in \
handleDartLocalVarTypeMap/handle_dart_local_var_type_map that describe it as a known limitation.`,
      ).toBe(false);
    });
  });
}

runSuite('wasm');

describe.skipIf(!isNativeAvailable())('native engine parity', () => {
  runSuite('native');
});
