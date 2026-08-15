/**
 * Regression test for #2348: `resolveChaTargets` (`cha.ts`) /
 * `resolve_cha_dispatch` (`build_edges.rs`) BFS-walk only ever considered the
 * receiver's SUBCLASSES as dispatch targets — it never checked whether the
 * receiver's own declared type is itself instantiated and should resolve to
 * its OWN method. When a base class is instantiated directly AND some
 * completely unrelated file also declares a local subclass overriding the
 * same method name, the base class's own (correct) method was silently
 * dropped from the resolved edge set while the unrelated subclass's
 * override leaked in as the (wrong) target instead.
 *
 * This mirrors the real-world repro exactly (`tests/unit/in-memory-
 * repository.test.ts` calling `repo.findNodesForTriage()` on an
 * `InMemoryRepository`, while `tests/integration/triage.test.ts` separately
 * declares two unrelated local test-double subclasses — `BrokenRepo` and
 * `InvalidOptsRepo` — each overriding `findNodesForTriage` inside their own
 * `it()` callback) with a minimal synthetic fixture:
 *
 *  - `src/domain/base.ts` declares `Base.run()` and is instantiated directly
 *    (`new Base()`).
 *  - `tests/unit/caller.ts` (deliberately far from `src/domain/` — mirrors
 *    the real repro's cross-directory distance, which pushes the
 *    proximity-gated direct qualified lookup below its confidence threshold
 *    and forces reliance on the CHA/RTA fallback) calls `b.run()` on a
 *    parameter typed `b: Base`.
 *  - `other/rogue-a.ts` and `other/rogue-b.ts` each declare their own LOCAL,
 *    lexically unrelated `RogueA`/`RogueB` class extending `Base` and
 *    overriding `run()`, instantiated inside their own local function scope
 *    — unrelated to the caller and to each other, matching
 *    `BrokenRepo`/`InvalidOptsRepo`'s shape.
 *
 * Both engines must resolve `caller.ts`'s `b.run()` call to `Base.run`
 * (previously missing entirely) without that resolution being crowded out
 * by the unrelated `RogueA.run`/`RogueB.run` overrides.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE: Record<string, string> = {
  'src/domain/base.ts': `
export class Base {
  run(): string {
    return 'base';
  }
}
`,
  'tests/unit/caller.ts': `
import { Base } from '../../src/domain/base.js';

function useBase(b: Base): string {
  return b.run();
}

const liveBase = new Base();
useBase(liveBase);
`,
  'other/rogue-a.ts': `
import { Base } from '../src/domain/base.js';

function runRogueA(): string {
  class RogueA extends Base {
    override run(): string {
      return 'rogue-a';
    }
  }
  return new RogueA().run();
}
runRogueA();
`,
  'other/rogue-b.ts': `
import { Base } from '../src/domain/base.js';

function runRogueB(): string {
  class RogueB extends Base {
    override run(): string {
      return 'rogue-b';
    }
  }
  return new RogueB().run();
}
runRogueB();
`,
};

function writeFixture(rootDir: string) {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

interface CallEdgeRow {
  caller: string;
  callee: string;
  calleeFile: string;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS caller, n2.name AS callee, n2.file AS calleeFile
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

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  "CHA dispatch includes the receiver's own instantiated type (%s, #2348)",
  (engine) => {
    let tmpDir: string;
    let edges: CallEdgeRow[];

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-2348-${engine}-`));
      writeFixture(tmpDir);
      await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
      edges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    }, 60_000);

    afterAll(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("useBase's b.run() resolves to Base.run (the receiver's own instantiated type)", () => {
      const toBase = edges.some((e) => e.caller === 'useBase' && e.callee === 'Base.run');
      expect(
        toBase,
        `Expected useBase -> Base.run.\nActual edges from useBase:\n${JSON.stringify(
          edges.filter((e) => e.caller === 'useBase'),
          null,
          2,
        )}`,
      ).toBe(true);
    });

    it('the unrelated local subclass overrides are not the ONLY resolved targets', () => {
      const fromUseBase = edges.filter((e) => e.caller === 'useBase');
      const onlyRogue =
        fromUseBase.length > 0 &&
        fromUseBase.every((e) => e.callee === 'RogueA.run' || e.callee === 'RogueB.run');
      expect(
        onlyRogue,
        `Expected Base.run among useBase's targets, not just the unrelated Rogue overrides.\nActual edges from useBase:\n${JSON.stringify(
          fromUseBase,
          null,
          2,
        )}`,
      ).toBe(false);
    });
  },
);
