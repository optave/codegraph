/**
 * Regression test for #2015: the residual gap in #1865's fix for
 * `reconnectReverseDepEdges` (`build-edges.ts`, WASM/JS engine).
 *
 * #1865 correctly handles a sibling group whose SIZE changes (a same-named
 * sibling added or removed) by falling back to the dominant-line-shift
 * alignment instead of naive nearest-line matching. But when a same-named/
 * same-kind sibling is BOTH removed (renamed away) AND a different one
 * added in the SAME edit, the group's size stays unchanged (e.g. 4 -> 4),
 * so #1865's own "count unchanged -> match by rank" fast path takes over —
 * and rank alone cannot distinguish "this is genuinely the same
 * declaration, just shifted" from "a different declaration happens to now
 * occupy this rank."
 *
 * Fixed by giving reconnection a true identity signal beyond line
 * position: a SHA-256 hash of each declaration's own source text
 * (`nodes.content_hash`, migration v24), computed centrally after
 * extraction and threaded through node insertion on both engines.
 * `pickReconnectTarget` now tries an exact hash match first — if the saved
 * target's hash matches none of the current candidates, the edge is
 * confidently dropped instead of falling through to the rank-based guess
 * (see `build-edges.ts`; mirrored in Rust as `pick_reconnect_target` in
 * `detect_changes.rs`, covered by dedicated Rust unit + end-to-end tests
 * there — `pick_reconnect_target_drops_when_hash_matches_nothing_even_with_unchanged_count`,
 * `reconnect_drops_edge_on_compound_rename_and_add_leaving_group_size_unchanged`).
 *
 * Reuses the exact fixture/seeding strategy from
 * `issue-1865-reverse-dep-sibling-count-change.test.ts` (see that file's
 * module doc comment for why a real source pattern can no longer naturally
 * produce the ambiguous same-file/same-name/same-kind call topology this
 * test needs — #1863 changed such resolution to no-edge instead of
 * fanning out).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const REL_CONN_FILE = 'src/db/conn.ts';

/** Four distinct functions, each returning an object with its own `close()` method. */
function connSource(): string {
  return `export function openA() {
  return {
    close() {
      return 'A';
    },
  };
}

export function openB() {
  return {
    close() {
      return 'B';
    },
  };
}

export function openC() {
  return {
    close() {
      return 'C';
    },
  };
}

export function openD() {
  return {
    close() {
      return 'D';
    },
  };
}
`;
}

/**
 * Compound edit in one pass: `openB`'s `close` is renamed to `shutdown`
 * (removing it from the "close"/"method" sibling group) AND a brand-new
 * `openE` function with its OWN `close()` is inserted in `openB`'s old
 * position — landing the new sibling at the same rank `openB`'s `close`
 * used to hold. The group's size for (name="close", kind="method") stays
 * unchanged at 4 (A, E, C, D) even though the actual membership changed —
 * exactly the net-zero-count compound edit #1865's rank-based fast path
 * cannot see through, but a content hash can.
 */
function editedConnSourceCompound(): string {
  return `export function openA() {
  return {
    close() {
      return 'A';
    },
  };
}

export function openB() {
  return {
    shutdown() {
      return 'B';
    },
  };
}

export function openE() {
  return {
    close() {
      return 'E';
    },
  };
}

export function openC() {
  return {
    close() {
      return 'C';
    },
  };
}

export function openD() {
  return {
    close() {
      return 'D';
    },
  };
}
`;
}

function callerSource(name: string, openFn: string): string {
  return `import { ${openFn} } from '../db/conn.js';

export function ${name}(): void {
  ${openFn}();
}
`;
}

function writeFixture(root: string, conn: string): void {
  fs.mkdirSync(path.join(root, 'src', 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'features'), { recursive: true });
  fs.writeFileSync(path.join(root, REL_CONN_FILE), conn);
  fs.writeFileSync(path.join(root, 'src/features/useA.ts'), callerSource('useA', 'openA'));
  fs.writeFileSync(path.join(root, 'src/features/useB.ts'), callerSource('useB', 'openB'));
  fs.writeFileSync(path.join(root, 'src/features/useC.ts'), callerSource('useC', 'openC'));
  fs.writeFileSync(path.join(root, 'src/features/useD.ts'), callerSource('useD', 'openD'));
}

/** Seeds one synthetic `calls` edge from each `use*` caller to its corresponding `close()` method node. */
function seedReverseDepEdges(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const closeNodes = db
      .prepare(
        "SELECT id, line FROM nodes WHERE name = 'close' AND kind = 'method' AND file = ? ORDER BY line",
      )
      .all(REL_CONN_FILE) as Array<{ id: number; line: number }>;
    expect(closeNodes).toHaveLength(4);
    const callerIds: Record<string, number> = {};
    for (const name of ['useA', 'useB', 'useC', 'useD']) {
      const row = db
        .prepare("SELECT id FROM nodes WHERE name = ? AND kind = 'function'")
        .get(name) as { id: number } | undefined;
      expect(row, `caller node ${name} must exist`).toBeDefined();
      callerIds[name] = row!.id;
    }
    const insert = db.prepare(
      "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, 'calls', 0.9, 0)",
    );
    insert.run(callerIds.useA, closeNodes[0]!.id);
    insert.run(callerIds.useB, closeNodes[1]!.id);
    insert.run(callerIds.useC, closeNodes[2]!.id);
    insert.run(callerIds.useD, closeNodes[3]!.id);
  } finally {
    db.close();
  }
}

/** Sorted list of target lines every `close()` reverse-dep edge points to, keyed by caller. */
function findCloseTargetLines(dbPath: string): Record<string, number | null> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const result: Record<string, number | null> = {};
    for (const caller of ['useA', 'useB', 'useC', 'useD']) {
      const row = db
        .prepare(
          `SELECT t.line AS line
           FROM edges e
           JOIN nodes s ON e.source_id = s.id
           JOIN nodes t ON e.target_id = t.id
           WHERE s.name = ? AND e.kind = 'calls' AND t.file = ? AND t.kind = 'method'`,
        )
        .get(caller, REL_CONN_FILE) as { line: number } | undefined;
      result[caller] = row?.line ?? null;
    }
    return result;
  } finally {
    db.close();
  }
}

describe.each(['wasm', 'native'] as const)(
  'Issue #2015: reverse-dep edges survive a compound rename+add leaving sibling count unchanged (%s)',
  (engine) => {
    let projDir: string;
    const tmpDirs: string[] = [];
    const dbPath = () => path.join(projDir, '.codegraph', 'graph.db');

    function mkTmp(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tmpDirs.push(dir);
      return dir;
    }

    beforeAll(async () => {
      projDir = mkTmp(`cg-2015-${engine}-`);
      writeFixture(projDir, connSource());
      await buildGraph(projDir, { engine, incremental: false, skipRegistry: true });
      seedReverseDepEdges(dbPath());
    }, 60_000);

    afterAll(() => {
      for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('baseline: each seeded caller points to its own close() line', () => {
      expect(findCloseTargetLines(dbPath())).toEqual({ useA: 3, useB: 11, useC: 19, useD: 27 });
    });

    it('incremental rebuild that renames one sibling away AND adds a different one in the ' +
      'same edit (sibling count unchanged, 4 -> 4) reconnects the untouched siblings ' +
      "correctly, drops the renamed-away sibling's edge, and never reconnects anything " +
      'to the new sibling', async () => {
      fs.writeFileSync(path.join(projDir, REL_CONN_FILE), editedConnSourceCompound());
      await buildGraph(projDir, { engine, skipRegistry: true }); // incremental (default)

      const afterIncremental = findCloseTargetLines(dbPath());

      // Ground truth: A/C/D's own close() lines in the edited file — each
      // is byte-identical to its pre-edit body, just at a new position.
      const newConnLines = fs
        .readFileSync(path.join(projDir, REL_CONN_FILE), 'utf8')
        .split('\n')
        .reduce<number[]>((acc, line, idx) => {
          if (line.trim() === 'close() {') acc.push(idx + 1);
          return acc;
        }, []);
      // A, E (new), C, D — 4 close() methods total, count unchanged from
      // the original 4 (A, B, C, D) despite B being renamed away.
      expect(newConnLines).toHaveLength(4);
      const [aLine, eLine, cLine, dLine] = newConnLines;

      expect(
        afterIncremental,
        `incremental reconnection result: ${JSON.stringify(afterIncremental)}`,
      ).toEqual({
        useA: aLine,
        useB: null, // openB's close() no longer exists — must be dropped, never reattached to E
        useC: cLine,
        useD: dLine,
      });

      // Nothing at all points at the new sibling's close() line.
      const db = new Database(dbPath(), { readonly: true });
      try {
        const reconnectedToE = db
          .prepare(
            `SELECT COUNT(*) AS n FROM edges e
               JOIN nodes t ON e.target_id = t.id
               WHERE t.file = ? AND t.kind = 'method' AND t.line = ? AND e.kind = 'calls'`,
          )
          .get(REL_CONN_FILE, eLine) as { n: number };
        expect(reconnectedToE.n).toBe(0);
      } finally {
        db.close();
      }
    }, 60_000);
  },
);
