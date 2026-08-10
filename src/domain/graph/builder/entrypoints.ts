/**
 * Python program-entrypoint attribution (#2392), stored as persisted evidence
 * plus a projection — shared by the batch pipeline (`stages/build-edges.ts`)
 * and `codegraph watch`'s single-file rebuild (`incremental.ts`), which are
 * otherwise separate implementations of node/edge persistence.
 *
 * ## Why evidence + projection, and not a directly-written flag
 *
 * The extractor flags a *call* (`Call.entrypoint`) rather than a declaration,
 * because the convention is a property of the call site: a guard routinely
 * invokes a `main` imported from another module, so nothing about the
 * declaration marks it. That makes the resulting `nodes.entrypoint` flag
 * cross-file derived state — and the two ends have different lifecycles:
 *
 *   - the evidence belongs to the *guard's* file, and dies when that file is
 *     reparsed or removed; but
 *   - the flag sits on the *target's* node row, which is deleted and
 *     re-inserted (with a brand-new id) whenever the *target's* file is
 *     rebuilt — a file the guard's rebuild never touches, and vice versa.
 *
 * #2411 wrote the flag straight from the reparsed files' symbols, so any
 * rebuild that reparsed only the target dropped it: `codegraph build
 * --incremental` after editing the callee, or the same edit under `codegraph
 * watch`. Nothing re-marked it, even though the guard's `calls` edge was
 * still in the graph, because the guard's file was not in that build's
 * symbol set. Conversely `codegraph watch` never wrote the column at all.
 *
 * Persisting the evidence per file (`entrypoint_calls`) and re-projecting it
 * onto `nodes` at the end of every build makes both directions fall out for
 * free, whichever file changed:
 *
 *   - guard edited or deleted  → its evidence rows are purged with it, the
 *     projection finds nothing, the target clears;
 *   - target rebuilt           → the guard's evidence is untouched, so the
 *     projection re-marks the target's new node row;
 *   - guard added              → evidence appears, the projection marks.
 *
 * This is the same shape as `invoked_property_names` (#2087) and
 * `return_types` (#2138), which persist per-file evidence for exactly the
 * same reason: a rebuild must be able to see facts contributed by files it
 * did not itself parse.
 *
 * Mirrored in `crates/codegraph-core/src/domain/graph/builder/entrypoints.rs`.
 */

import type { BetterSqlite3Database } from '../../../types.js';

/** The subset of an extracted call this module needs. */
interface EntrypointCall {
  name: string;
  entrypoint?: boolean;
}

/**
 * Replace `file`'s persisted entrypoint-call evidence with the calls the
 * extractor just flagged.
 *
 * Deletes first so a file that lost its guard (or whose guard moved to a
 * different callee) leaves nothing stale behind. The purge paths delete the
 * same rows when a file is removed outright, which is what makes deletion
 * work without a dedicated pre-purge step — see `preparePurgeStmts` in
 * `db/repository/build-stmts.ts`.
 *
 * Callers may skip this entirely for non-Python files: `call.entrypoint` is
 * only ever set by the Python extractor, so any other file's evidence set is
 * empty in this build and was empty in every earlier one.
 */
export function persistEntrypointCallsForFile(
  db: BetterSqlite3Database,
  file: string,
  calls: ReadonlyArray<EntrypointCall>,
): void {
  const names = new Set<string>();
  for (const call of calls) {
    if (call.entrypoint) names.add(call.name);
  }
  db.prepare('DELETE FROM entrypoint_calls WHERE file = ?').run(file);
  if (names.size === 0) return;
  const insert = db.prepare('INSERT OR IGNORE INTO entrypoint_calls (file, name) VALUES (?, ?)');
  for (const name of names) {
    insert.run(file, name);
  }
}

/** A node row the projection wants flagged, keyed by node id. */
interface DesiredRow {
  id: number;
  file: string;
  sourceFile: string;
}

/**
 * Recompute `nodes.entrypoint` / `nodes.entrypoint_source_file` from the
 * persisted evidence and the committed `calls` edges, and return the files
 * whose flag set actually changed, so the caller can seed incremental role
 * reclassification for them.
 *
 * Must run after every edge-insert path for the build has completed — it
 * identifies targets from committed edges, not by re-resolving. An entrypoint
 * call is module-level by construction (see the extractors' guard/`__main__`
 * scope handling), so its `calls` edge is always sourced from the file node,
 * and matching that edge's target by the called name identifies it. Doing the
 * matching here rather than inside either resolver keeps the two engines on
 * one implementation: both arrive with their edges already written.
 *
 * The returned files matter because a target frequently lives in a file this
 * build never rebuilt, and `classifyNodeRolesIncremental`'s own
 * neighbour-expansion join cannot discover it either — the connecting edge may
 * have just been deleted. Without seeding it explicitly, `nodes.entrypoint`
 * updates correctly but the cached `nodes.role` on the same row is left stale
 * at `"entry"`.
 *
 * Attribution is single-owner: one `entrypoint_source_file` per target. If two
 * files both call the same target as their entrypoint, the one that sorts
 * first wins deterministically (rather than "whichever marked last", as in
 * #2411) and the target stays correctly flagged while either survives —
 * removing one no longer clears it. Tracked as #2419.
 */
export function projectEntrypointAttribution(db: BetterSqlite3Database): string[] {
  // Cheap exit for the overwhelmingly common case — no Python entrypoint
  // evidence anywhere and nothing currently flagged. Both probes are O(1):
  // `entrypoint_calls` is keyed on (file, name), and `nodes.entrypoint` has a
  // partial index covering exactly `entrypoint = 1`. Running the real work
  // unconditionally is what caused the 66% full-build regression measured on
  // a 954-file, effectively-Python-free tree during #2411's review.
  const hasEvidence = db.prepare('SELECT 1 FROM entrypoint_calls LIMIT 1').get() !== undefined;
  const hasFlags =
    db.prepare('SELECT 1 FROM nodes WHERE entrypoint = 1 LIMIT 1').get() !== undefined;
  if (!hasEvidence && !hasFlags) return [];

  // Suffix matching is an exact `.`-qualified comparison rather than a
  // `LIKE '%.' || name`: a Python identifier may contain `_`, which LIKE
  // treats as a single-character wildcard, so `main_run` would also match
  // `Owner.mainXrun`. A method entrypoint (`Runner().start()`) is declared as
  // `Owner.start`, hence the qualified form at all.
  const desiredRows = db
    .prepare(
      `SELECT e.target_id AS id, tgt.file AS file, ec.file AS sourceFile
       FROM entrypoint_calls ec
       JOIN nodes src ON src.kind = 'file' AND src.file = ec.file
       JOIN edges e ON e.source_id = src.id AND e.kind = 'calls'
       JOIN nodes tgt ON tgt.id = e.target_id
       WHERE tgt.name = ec.name
          OR (length(tgt.name) > length(ec.name)
              AND substr(tgt.name, length(tgt.name) - length(ec.name)) = '.' || ec.name)
       ORDER BY ec.file`,
    )
    .all() as DesiredRow[];

  // First writer wins, and the ORDER BY above makes "first" the
  // lexicographically smallest source file — stable across rebuilds, unlike
  // iteration order over a changed-file set.
  const desired = new Map<number, DesiredRow>();
  for (const row of desiredRows) {
    if (!desired.has(row.id)) desired.set(row.id, row);
  }

  const current = db
    .prepare(
      `SELECT id, file, entrypoint_source_file AS sourceFile
       FROM nodes WHERE entrypoint = 1`,
    )
    .all() as Array<{ id: number; file: string; sourceFile: string | null }>;

  const clearStmt = db.prepare(
    'UPDATE nodes SET entrypoint = 0, entrypoint_source_file = NULL WHERE id = ?',
  );
  const markStmt = db.prepare(
    'UPDATE nodes SET entrypoint = 1, entrypoint_source_file = ? WHERE id = ?',
  );

  const touchedFiles = new Set<string>();
  const tx = db.transaction(() => {
    const currentIds = new Set<number>();
    for (const row of current) {
      currentIds.add(row.id);
      const want = desired.get(row.id);
      if (!want) {
        clearStmt.run(row.id);
        touchedFiles.add(row.file);
      } else if (want.sourceFile !== row.sourceFile) {
        // Still an entrypoint, only the attributing file changed. The role is
        // `entry` either way, so this needs no role reclassification.
        markStmt.run(want.sourceFile, row.id);
      }
    }
    for (const [id, want] of desired) {
      if (currentIds.has(id)) continue;
      markStmt.run(want.sourceFile, id);
      touchedFiles.add(want.file);
    }
  });
  tx();

  return [...touchedFiles];
}
