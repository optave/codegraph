/**
 * Regression test for #2426: the incremental-build journal
 * (`domain/graph/journal.ts`'s `changes.journal`) always wrote into
 * `rootDir/.codegraph`, ignoring `buildGraph`'s `dbPath` override — so a
 * build targeting a custom `dbPath` (e.g. a temp dir, to keep the DB out of
 * a tracked fixture tree) still left a stray `.codegraph/` directory
 * (containing `changes.journal` + its `.lock` file) inside `rootDir`,
 * regardless of where the actual database ended up. This is the exact
 * mechanism behind the stray fixture-directory `.codegraph/` dirs reported
 * in #2415.
 *
 * The journal must always travel with the database: `path.dirname(dbPath)`,
 * not unconditionally `rootDir/.codegraph`. Default behavior (no `dbPath`
 * override) is unchanged, since `dbPath` itself defaults to
 * `rootDir/.codegraph/graph.db`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const ENGINES: EngineMode[] = ['wasm', 'native'];

function writeFixture(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

describe.each(ENGINES)(
  'incremental-build journal follows dbPath (#2426) — engine: %s',
  (engine) => {
    let rootDir: string;
    let dbDir: string;

    beforeAll(() => {
      rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2426-root-${engine}-`));
      dbDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2426-dbdir-${engine}-`));
      writeFixture(rootDir, { 'a.ts': 'export function a() { return 1; }\n' });
    });

    afterAll(() => {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(dbDir, { recursive: true, force: true });
    });

    it('writes the journal alongside a custom dbPath, not into rootDir/.codegraph', async () => {
      const dbPath = path.join(dbDir, 'graph.db');
      await buildGraph(rootDir, { dbPath, incremental: true, skipRegistry: true, engine });

      expect(fs.existsSync(path.join(dbDir, 'changes.journal'))).toBe(true);
      expect(fs.existsSync(path.join(rootDir, '.codegraph'))).toBe(false);
    });

    it('an incremental no-change rebuild keeps writing the journal to the same custom directory', async () => {
      const dbPath = path.join(dbDir, 'graph.db');
      // Re-run with no source changes — exercises the early-exit path, which
      // also stamps the journal header.
      await buildGraph(rootDir, { dbPath, incremental: true, skipRegistry: true, engine });

      expect(fs.existsSync(path.join(dbDir, 'changes.journal'))).toBe(true);
      expect(fs.existsSync(path.join(rootDir, '.codegraph'))).toBe(false);
    });
  },
);

describe.each(ENGINES)(
  'incremental-build journal default location is unchanged (#2426) — engine: %s',
  (engine) => {
    it('writes the journal under rootDir/.codegraph when dbPath is not overridden', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2426-default-${engine}-`));
      try {
        writeFixture(dir, { 'a.ts': 'export function a() { return 1; }\n' });
        await buildGraph(dir, { incremental: true, skipRegistry: true, engine });

        expect(fs.existsSync(path.join(dir, '.codegraph', 'changes.journal'))).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
