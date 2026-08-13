/**
 * Regression test for #2315: a follow-up to #2078/#2314 flagged by Greptile.
 *
 * `findChaSiblingCallerFiles` (`applyChaDispatchPostPass`,
 * `src/domain/graph/builder/incremental.ts`) discovers callers to revisit
 * during an INCREMENTAL rebuild by following EXISTING `cha`/`super-dispatch`
 * edges pointing at some other implementor of a touched interface. If an
 * interface had ZERO instantiated implementors when a caller's file was
 * last parsed, that caller has no such edge anywhere in the DB — so when a
 * later incremental rebuild gives the interface its FIRST instantiated
 * implementor, there is nothing for the post-pass to search from, and the
 * caller is never revisited. Its dispatch edge to the new implementor stays
 * silently missing until a full (non-incremental) rebuild.
 *
 * The issue explicitly scopes the fix to a cheap, honest diagnostic instead
 * of the two expensive correctness fixes (a new DB schema, or an
 * O(all-files) rescan) — see the issue body for why. This test exercises
 * that diagnostic end-to-end:
 *
 *   1. Full build a fixture where `IUncalled` has exactly one implementor
 *      (`GhostImpl`) that is never instantiated — `codegraph info`'s
 *      `cha_zero_implementor_interfaces` build_meta snapshot must capture it.
 *   2. Add `RealImpl` — a NEW, self-instantiating `IUncalled` implementor —
 *      via an INCREMENTAL single-file rebuild (`rebuildFile`, the exact
 *      function `codegraph watch` calls per file-change event).
 *   3. Call `printBuildMetadata` (the function behind `codegraph info`) and
 *      assert it nudges the user to run `codegraph build --no-incremental`
 *      because `IUncalled` gained its first instantiated implementor since
 *      the last full build.
 *
 * This does NOT assert on (and does not fix) the underlying missing-edge
 * gap itself — that remains out of scope per the issue. See
 * `tests/integration/issue-2078-cha-sibling-caller.test.ts` for the sibling
 * -caller-discovery mechanism this gap falls outside of.
 *
 * Console-spy note: `vi.spyOn(console, 'log')` must be set up in
 * `beforeEach`/torn down in `afterEach` here, not inline inside an `it()`
 * body — mirroring `tests/presentation/result-formatter.test.ts`'s established
 * pattern. Vitest's own per-test console capture interacts with an inline
 * spy+restore in a way that silently drops every call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../../src/cli/types.js';
import { getBuildMeta, initSchema, openDb } from '../../src/db/index.js';
import { buildChaContextFromDb } from '../../src/domain/graph/builder/cha.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import { CODEGRAPH_VERSION } from '../../src/shared/version.js';
import type { EngineMode } from '../../src/types.js';
import { createIncrementalStmts } from '../helpers/incremental-stmts.js';

const IUNCALLED_SOURCE = `export interface IUncalled {
  doThing(): string;
}
`;

// Sole implementor at full-build time — declared but never instantiated
// anywhere, so RTA excludes it from CHA dispatch targets and IUncalled ends
// up with zero *instantiated* implementors despite having one implementor.
const GHOST_IMPL_SOURCE = `import type { IUncalled } from './IUncalled.js';

export class GhostImpl implements IUncalled {
  doThing(): string {
    return 'ghost';
  }
}
`;

// Typed parameter — typeMap will record x: IUncalled (confidence 0.9). CHA
// would expand x.doThing() to every instantiated IUncalled implementor, but
// at full-build time there are none, so this call site produces zero
// cha/super-dispatch edges to seed later sibling-caller discovery from.
const CALLER_SOURCE = `import type { IUncalled } from './IUncalled.js';

export function callIt(x: IUncalled): string {
  return x.doThing();
}
`;

// Added mid-incremental-session: a brand-new, SELF-instantiating IUncalled
// implementor — gives IUncalled its first instantiated implementor.
const REAL_IMPL_SOURCE = `import type { IUncalled } from './IUncalled.js';

export class RealImpl implements IUncalled {
  doThing(): string {
    return 'real';
  }
}

// Self-contained RTA instantiation evidence.
export function makeRealImpl(): RealImpl {
  return new RealImpl();
}
`;

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'IUncalled.ts'), IUNCALLED_SOURCE);
  fs.writeFileSync(path.join(dir, 'GhostImpl.ts'), GHOST_IMPL_SOURCE);
  fs.writeFileSync(path.join(dir, 'Caller.ts'), CALLER_SOURCE);
}

async function rebuildOneFile(dir: string, relFile: string, engine: EngineMode): Promise<void> {
  const dbPath = path.join(dir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  try {
    initSchema(db);
    const stmts = createIncrementalStmts(db);
    await rebuildFile(db, dir, path.join(dir, relFile), stmts, { engine } as never, null);
  } finally {
    db.close();
  }
}

function runScenario(engine: EngineMode): void {
  describe(`codegraph info: CHA-zero-implementor nudge on first instantiated implementor (#2315) — ${engine}`, () => {
    let tmpDir: string;
    let dbPath: string;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2315-cha-zero-impl-${engine}-`));
      dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      writeFixture(tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    async function printBuildMetadataOutput(): Promise<string> {
      const { printBuildMetadata } = await import('../../src/cli/commands/info.js');
      const ctx = { program: { version: () => CODEGRAPH_VERSION } } as unknown as CliContext;
      await printBuildMetadata(ctx, { db: dbPath }, engine === 'native' ? 'native' : 'wasm');
      return logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    }

    it('snapshots IUncalled as zero-implementor in build_meta after the full build', () => {
      const db = openDb(dbPath);
      try {
        const raw = getBuildMeta(db, 'cha_zero_implementor_interfaces');
        expect(raw, 'cha_zero_implementor_interfaces build_meta key was not written').toBeTruthy();
        const snapshot = JSON.parse(raw as string) as string[];
        expect(snapshot).toContain('IUncalled');
      } finally {
        db.close();
      }
    });

    it('codegraph info prints the build metadata header, but no CHA nudge yet', async () => {
      const output = await printBuildMetadataOutput();
      expect(output).toContain('Build metadata');
      expect(output).not.toContain('gained');
    });

    describe('after RealImpl is added via an INCREMENTAL rebuild', () => {
      beforeAll(async () => {
        fs.writeFileSync(path.join(tmpDir, 'RealImpl.ts'), REAL_IMPL_SOURCE);
        await rebuildOneFile(tmpDir, 'RealImpl.ts', engine);
      }, 60_000);

      it('IUncalled now has an instantiated implementor per a fresh buildChaContextFromDb', () => {
        const db = openDb(dbPath);
        try {
          const chaCtx = buildChaContextFromDb(db);
          const implementors = chaCtx.implementors.get('IUncalled') ?? [];
          expect(implementors).toContain('RealImpl');
          expect(implementors.some((cls) => chaCtx.instantiatedTypes.has(cls))).toBe(true);
        } finally {
          db.close();
        }
      });

      it('the build_meta snapshot itself is untouched by the incremental rebuild (still lists IUncalled as of the last full build)', () => {
        const db = openDb(dbPath);
        try {
          const raw = getBuildMeta(db, 'cha_zero_implementor_interfaces');
          const snapshot = JSON.parse(raw as string) as string[];
          expect(snapshot).toContain('IUncalled');
        } finally {
          db.close();
        }
      });

      it('codegraph info now nudges that IUncalled gained its first instantiated implementor', async () => {
        const output = await printBuildMetadataOutput();
        expect(output).toContain('IUncalled');
        expect(output).toContain('gained');
        expect(output).toContain('codegraph build --no-incremental');
      });
    });
  });
}

runScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
