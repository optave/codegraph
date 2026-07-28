/**
 * Integration test: Swift typed-property typeMap seeding → receiver edges (WASM engine).
 *
 * Verifies that WASM engine generates receiver edges from UserService methods to
 * UserRepository (the class type of `private let repo: UserRepository`), matching
 * the native engine's output.
 *
 * Root cause: collectSwiftProperties in src/extractors/swift.ts previously skipped
 * typeMap seeding for class-body properties. The Rust engine has match_swift_type_map
 * which seeds typeMap["repo"] = "UserRepository" from every typed property_declaration.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FILES: Record<string, string> = {
  'Repository.swift': `import Foundation

class UserRepository {
    private var store: [String: String] = [:]

    func save(_ user: String) { store[user] = user }
    func findById(_ id: String) -> String? { return store[id] }
    func delete(_ id: String) -> Bool { return store.removeValue(forKey: id) != nil }
}
`,
  'Service.swift': `import Foundation

class UserService {
    private let repo: UserRepository

    init(repo: UserRepository) { self.repo = repo }

    func createUser(id: String) { repo.save(id) }
    func getUser(id: String) -> String? { return repo.findById(id) }
    func removeUser(id: String) -> Bool { return repo.delete(id) }
}
`,
};

describe('Swift typed-property typeMap → receiver edges (#issue-swift-receiver)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof Database>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-recv-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
    db = new Database(path.join(tmpDir, '.codegraph', 'graph.db'), { readonly: true });
  }, 60_000);

  afterAll(() => {
    db?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits receiver edges from UserService methods to UserRepository class', () => {
    const rows = db
      .prepare(`
      SELECT n1.name AS src, n2.name AS tgt
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.kind = 'receiver' AND n2.name = 'UserRepository'
      ORDER BY n1.name
    `)
      .all() as Array<{ src: string; tgt: string }>;

    const srcNames = rows.map((r) => r.src);
    expect(srcNames).toContain('UserService.createUser');
    expect(srcNames).toContain('UserService.getUser');
    expect(srcNames).toContain('UserService.removeUser');
  });
});
