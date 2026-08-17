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
import { resolvePyprojectScriptEntrypoints } from '../resolve.js';

/** The subset of an extracted call this module needs. */
interface EntrypointCall {
  name: string;
  entrypoint?: boolean;
  entrypointWrappedBy?: string;
}

/**
 * Replace each reparsed file's persisted entrypoint-call evidence with the
 * calls the extractor just flagged.
 *
 * Deletes first so a file that lost its guard (or whose guard moved to a
 * different callee) leaves nothing stale behind. The purge paths delete the
 * same rows when a file is removed outright, which is what makes deletion
 * work without a dedicated pre-purge step — see `preparePurgeStmts` in
 * `db/repository/build-stmts.ts`.
 *
 * Non-Python files are skipped: `call.entrypoint` is only ever set by the
 * Python extractor, so their evidence set is empty in this build and was
 * empty in every earlier one. Filtering here rather than at each call site
 * keeps that rule in one place.
 *
 * Statements are hoisted out of the loop and the whole sweep runs in one
 * transaction, mirroring `persistInvokedPropertyNames` (build-edges.ts) —
 * a full build of a large Python tree would otherwise pay a compile and an
 * autocommit per file.
 */
export function persistEntrypointCalls(
  db: BetterSqlite3Database,
  entries: Iterable<readonly [string, ReadonlyArray<EntrypointCall>]>,
): void {
  const deleteStmt = db.prepare('DELETE FROM entrypoint_calls WHERE file = ?');
  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO entrypoint_calls (file, name, wrapped_by) VALUES (?, ?, ?)',
  );

  const tx = db.transaction(() => {
    for (const [file, calls] of entries) {
      if (!file.endsWith('.py')) continue;
      deleteStmt.run(file);
      // First occurrence per name wins (matches the existing "seen" dedup
      // behavior) — the rare case of the same name appearing both wrapped
      // and unwrapped as separate entrypoint calls within one file isn't
      // otherwise representable by this (file, name) primary key.
      const names = new Map<string, string | null>();
      for (const call of calls) {
        if (call.entrypoint && !names.has(call.name)) {
          names.set(call.name, call.entrypointWrappedBy ?? null);
        }
      }
      for (const [name, wrappedBy] of names) {
        insertStmt.run(file, name, wrappedBy);
      }
    }
  });
  tx();
}

/** A node row the projection wants flagged, keyed by node id. */
interface DesiredRow {
  id: number;
  file: string;
  sourceFile: string;
  name: string;
  wrappedBy: string | null;
}

/**
 * Recompute `nodes.entrypoint` / `nodes.entrypoint_source_file` /
 * `nodes.entrypoint_role` from the persisted evidence and the committed
 * `calls` edges, and return the files whose flag set actually changed, so the
 * caller can seed incremental role reclassification for them.
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
 * removing one no longer clears it (#2419).
 *
 * ## `entrypoint_role`: which of several calls sharing a line gets `role: 'entry'`
 *
 * `entrypoint` alone answers "is the runtime the caller" — set on EVERY call
 * inside a qualifying guard, including one nested inside another
 * (`main(configure())` flags both `main` and `configure`, and correctly so:
 * `configure` really does run at module load and needs the same
 * dead-code-downgrade protection `main` does). But only one of them should be
 * the *label* role classification promotes to `'entry'` — a helper like
 * `configure` should keep whatever role its own fan-in/fan-out shape implies,
 * not misleadingly appear in `codegraph roles --role entry` next to the real
 * entrypoint (#2420).
 *
 * The rule: a call that is not nested inside another call on the same
 * qualifying line is always the label winner. A nested call
 * (`entrypointWrappedBy` set at extraction time, see `Call`'s doc comment)
 * only wins the label if its wrapper does NOT resolve to an in-repo target
 * from the same source file — e.g. `sys.exit(main())`, where `sys.exit` is
 * an unresolvable stdlib passthrough, so `main` — the call that actually
 * matters — gets the label instead of being silently skipped. This can only
 * be decided here, once resolution is known: extraction (which only sees
 * syntax) cannot tell `main(configure())` (wrapper resolves in-repo) from
 * `sys.exit(main())` (wrapper does not) without knowing the graph's `calls`
 * edges — the same reason `desired` itself waits until here.
 *
 * A `entrypoint_role` value change is a role-classification-visible change
 * even when `entrypoint`/`entrypoint_source_file` stay the same — e.g. a
 * wrapper that used to resolve stops resolving on a later rebuild that
 * doesn't touch the wrapped target's own file at all — so it is checked and
 * `touchedFiles`-seeded independently of the existing sourceFile-change check.
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
      `SELECT e.target_id AS id, tgt.file AS file, ec.file AS sourceFile,
              ec.name AS name, ec.wrapped_by AS wrappedBy
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

  // Which (sourceFile, name) pairs resolved to SOME in-repo target — used
  // below to test whether a wrapped call's own wrapper resolved. Built from
  // `desired` rather than a separate query since it needs exactly the same
  // "did ec.name resolve via a calls edge from ec.file" answer `desired`
  // itself already computed.
  const resolvedNames = new Set<string>();
  for (const row of desired.values()) {
    resolvedNames.add(`${row.sourceFile} ${row.name}`);
  }
  const isRoleEligible = (row: DesiredRow): boolean =>
    row.wrappedBy === null || !resolvedNames.has(`${row.sourceFile} ${row.wrappedBy}`);

  const current = db
    .prepare(
      `SELECT id, file, entrypoint_source_file AS sourceFile, entrypoint_role AS role
       FROM nodes WHERE entrypoint = 1`,
    )
    .all() as Array<{ id: number; file: string; sourceFile: string | null; role: number }>;

  const clearStmt = db.prepare(
    'UPDATE nodes SET entrypoint = 0, entrypoint_source_file = NULL, entrypoint_role = 0 WHERE id = ?',
  );
  const markStmt = db.prepare(
    'UPDATE nodes SET entrypoint = 1, entrypoint_source_file = ?, entrypoint_role = ? WHERE id = ?',
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
        continue;
      }
      const wantRole = isRoleEligible(want) ? 1 : 0;
      if (want.sourceFile === row.sourceFile && wantRole === row.role) continue;
      markStmt.run(want.sourceFile, wantRole, row.id);
      // A sourceFile-only change needs no reclassification (the role is
      // `entry` either way), but an entrypoint_role VALUE change does — it
      // is exactly what role classification's `'entry'` early-return reads.
      if (wantRole !== row.role) touchedFiles.add(row.file);
    }
    for (const [id, want] of desired) {
      if (currentIds.has(id)) continue;
      markStmt.run(want.sourceFile, isRoleEligible(want) ? 1 : 0, id);
      touchedFiles.add(want.file);
    }
  });
  tx();

  return [...touchedFiles];
}

/**
 * Flag pyproject.toml-declared console/GUI/Poetry script entrypoints (#2408)
 * directly on their target nodes — `nodes.entrypoint = 1`,
 * `entrypoint_source_file = 'pyproject.toml'`.
 *
 * Unlike the guard-call evidence above, this has no cross-file lifecycle
 * problem to solve with a persisted evidence table: `pyproject.toml` is a
 * single, cheap-to-reread file, so it is re-parsed fresh on every build
 * (regardless of incremental scope) via `resolvePyprojectScriptEntrypoints`
 * rather than diffed from a prior parse. The target side still needs the
 * same "clear stale, then re-mark" treatment as the guard mechanism, since a
 * target's node row is deleted and re-inserted with a new id whenever ITS
 * file rebuilds.
 *
 * Must run after `projectEntrypointAttribution` and takes precedence over
 * it: an explicit packaging declaration is a stronger signal than an
 * inferred guard call, so a node flagged by both ends up attributed to
 * `pyproject.toml`. The "clear stale" step is scoped to
 * `entrypoint_source_file = 'pyproject.toml'`, so it can only ever touch
 * rows this function itself previously set — it never clobbers a
 * guard-attributed node that happens not to (or no longer) be a script
 * target.
 *
 * Mirrored in `crates/codegraph-core/src/domain/graph/builder/entrypoints.rs`.
 */
export function applyPyprojectScriptAttribution(
  db: BetterSqlite3Database,
  rootDir: string,
  knownFiles?: readonly string[] | null,
): string[] {
  const desired = resolvePyprojectScriptEntrypoints(rootDir, knownFiles);

  const current = db
    .prepare(`SELECT id, file FROM nodes WHERE entrypoint_source_file = 'pyproject.toml'`)
    .all() as Array<{ id: number; file: string }>;

  if (desired.length === 0 && current.length === 0) return [];

  const clearStmt = db.prepare(
    'UPDATE nodes SET entrypoint = 0, entrypoint_source_file = NULL, entrypoint_role = 0 WHERE id = ?',
  );
  // entrypoint_role is unconditionally 1 here (#2420): an explicit
  // `[project.scripts]`-style declaration has no "nested call" ambiguity to
  // resolve — there is exactly one target per script name, always the
  // label-worthy one.
  const markStmt = db.prepare(
    "UPDATE nodes SET entrypoint = 1, entrypoint_source_file = 'pyproject.toml', entrypoint_role = 1 WHERE id = ?",
  );
  const findCandidates = db.prepare(
    `SELECT id, name FROM nodes WHERE file = ? AND kind IN ('function', 'method')`,
  );

  const touchedFiles = new Set<string>();
  const currentIds = new Map(current.map((r) => [r.id, r.file]));
  const desiredIds = new Set<number>();

  const tx = db.transaction(() => {
    for (const { file, attr } of desired) {
      const candidates = findCandidates.all(file) as Array<{ id: number; name: string }>;
      const target =
        candidates.find((c) => c.name === attr) ??
        candidates.find((c) => c.name.length > attr.length && c.name.endsWith(`.${attr}`));
      if (!target) continue;
      desiredIds.add(target.id);
      markStmt.run(target.id);
      if (!currentIds.has(target.id)) touchedFiles.add(file);
    }
    for (const [id, file] of currentIds) {
      if (!desiredIds.has(id)) {
        clearStmt.run(id);
        touchedFiles.add(file);
      }
    }
  });
  tx();

  return [...touchedFiles];
}
