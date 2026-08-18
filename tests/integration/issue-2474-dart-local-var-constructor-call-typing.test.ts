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
  });
}

runSuite('wasm');

describe.skipIf(!isNativeAvailable())('native engine parity', () => {
  runSuite('native');
});
