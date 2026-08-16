/**
 * Regression test for #2420: entrypoint-call detection (#2392) is keyed on
 * source line, not AST-node identity, so when a qualifying statement
 * contains more than one call on the same line — `main(configure())` — every
 * call sharing that line was flagged `role: 'entry'`, not just the real
 * target. `configure` genuinely does run at module load and must keep
 * `entrypoint = 1` (reachability seeding has no bug here — see
 * `isLiveRoot`), but it should not carry the `'entry'` role label alongside
 * `main`.
 *
 * The opposite idiom — `sys.exit(main())` — must keep working: there the
 * *outer* call (`sys.exit`) is an unresolvable stdlib passthrough and the
 * *inner* call (`main`) is the one that matters, so `main` must still get
 * the `'entry'` label despite being nested.
 *
 * The rule (`isRoleEligible` in `projectEntrypointAttribution` /
 * `is_role_eligible` in `project_entrypoint_attribution`): a call not nested
 * inside another call on the same line always wins the label; a nested call
 * only wins it if its wrapper does not itself resolve to an in-repo target
 * from the same source file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

function writeFixture(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

interface NodeRow {
  name: string;
  file: string;
  entrypoint: number;
  role: string | null;
}

function readFunctionNodes(dbPath: string): NodeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT name, file, COALESCE(entrypoint, 0) AS entrypoint, role
         FROM nodes WHERE kind IN ('function', 'method') ORDER BY file, name`,
      )
      .all() as NodeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)(
  'entrypoint wrapper vs. target role classification (#2420) — engine: %s',
  (engine) => {
    describe('main(configure()) — a call wrapping another that resolves in-repo', () => {
      let dir: string;
      let nodes: NodeRow[];

      const byName = (name: string): NodeRow => {
        const row = nodes.find((n) => n.name === name);
        if (!row)
          throw new Error(`no node named ${name} (have: ${nodes.map((n) => n.name).join(', ')})`);
        return row;
      };

      beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2420-nested-${engine}-`));
        writeFixture(dir, {
          'run.py': `
def configure():
    return {}

def main(settings):
    return settings

if __name__ == "__main__":
    main(configure())
`,
        });
        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        nodes = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db'));
      });

      afterAll(() => {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      });

      it('gives the unwrapped outer call the entry role', () => {
        expect(byName('main').entrypoint).toBe(1);
        expect(byName('main').role).toBe('entry');
      });

      it('still flags the nested call as reachable, but not as the entry label', () => {
        expect(byName('configure').entrypoint).toBe(1);
        expect(byName('configure').role).not.toBe('entry');
      });
    });

    describe('sys.exit(main()) — a wrapper that does not resolve in-repo', () => {
      let dir: string;
      let nodes: NodeRow[];

      beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2420-passthrough-${engine}-`));
        writeFixture(dir, {
          'run.py': `
import sys

def main():
    return 0

if __name__ == "__main__":
    sys.exit(main())
`,
        });
        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        nodes = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db'));
      });

      afterAll(() => {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      });

      it('still gives the nested call the entry role, since its wrapper never resolves', () => {
        const row = nodes.find((n) => n.name === 'main');
        expect(row?.entrypoint).toBe(1);
        expect(row?.role).toBe('entry');
      });
    });

    it('sys.exit(main()) keeps the entry role even when an unrelated local "exit" resolves in the same file (Greptile review)', async () => {
      // A same-file namesake collision: `sys.exit` is an attribute call, so
      // its bare attribute name ("exit") is stripped of the "sys" qualifier
      // before any resolution is attempted. Without the dotted-wrapper
      // exclusion, a file-wide bare-name lookup for "exit" would find this
      // unrelated local `exit` function (called here entirely independently
      // of the guard) and wrongly conclude the sys.exit wrapper "resolved
      // in-repo," suppressing main's entry role.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2420-collision-${engine}-`));
      try {
        writeFixture(dir, {
          'run.py': `
import sys

def exit(status):
    print(status)

exit(0)

def main():
    return 0

if __name__ == "__main__":
    sys.exit(main())
`,
        });
        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        const row = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db')).find(
          (n) => n.name === 'main',
        );
        expect(row?.entrypoint).toBe(1);
        expect(row?.role).toBe('entry');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('an entrypoint with no wrapping ambiguity is unaffected', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2420-plain-${engine}-`));
      try {
        writeFixture(dir, {
          'run.py': `
def main():
    return 0

if __name__ == "__main__":
    main()
`,
        });
        await buildGraph(dir, { incremental: false, skipRegistry: true, engine });
        const row = readFunctionNodes(path.join(dir, '.codegraph', 'graph.db')).find(
          (n) => n.name === 'main',
        );
        expect(row?.entrypoint).toBe(1);
        expect(row?.role).toBe('entry');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
