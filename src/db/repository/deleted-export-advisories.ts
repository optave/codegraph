/**
 * Deleted-export advisories — a durable, purge-order-independent record of
 * exported function/method/class definitions lost when a file is deleted in
 * its entirety, for deletions whose exports still have an external
 * consumer at the moment the file is removed.
 *
 * `checkNoDeletedExportsInUse` (features/check.ts) can only see this via a
 * live query while the deleted file's `nodes`/`edges` rows still exist in
 * the DB. Those rows are purged by the very next `codegraph build`
 * (`detectChanges` stage) regardless of whether `codegraph check` has run
 * yet — `check` never triggers a rebuild itself, so whether it can still see
 * a deleted file's exports depends entirely on external orchestration
 * ordering. This module lets the build pipeline snapshot the pre-purge
 * state into a durable table, at the exact point `detectChanges` computes
 * the removed-file set, so `check` can fall back to it once the live rows
 * are gone. See issue #1938.
 */
import type { BetterSqlite3Database, ExternalConsumerRow, StmtCache } from '../../types.js';
import { cachedStmt } from './cached-stmt.js';
import { findExternalConsumers } from './edges.js';
import { findExportedDefinitions } from './nodes.js';

// ── Statement/schema-probe caches (one per db instance) ────────────────────
// `clearDeletedExportAdvisories` runs unconditionally on every incremental
// build (see detect-changes.ts) — re-preparing statements and re-probing the
// schema on every call was measurably regressing the WASM engine's detectMs
// (issue #1948). Cached the same way as `_hasExportedColCache`/`cachedStmt`
// elsewhere in this package (nodes.ts, dataflow.ts).
const _hasAdvisoryTableCache: WeakMap<BetterSqlite3Database, boolean> = new WeakMap();
const _hasConsumerKindColCache: WeakMap<BetterSqlite3Database, boolean> = new WeakMap();
const _existsForFileStmt: StmtCache<{ 1: number }> = new WeakMap();
const _deleteByFileStmt: StmtCache = new WeakMap();
const _insertAdvisoryStmt: StmtCache = new WeakMap();

export interface DeletedExportAdvisoryEntry {
  file: string;
  name: string;
  kind: string;
  line: number;
  consumers: ExternalConsumerRow[];
}

interface DeletedExportAdvisoryRow {
  file: string;
  name: string;
  kind: string;
  line: number;
  consumer_name: string;
  consumer_file: string;
  consumer_line: number;
  consumer_kind: string | null;
}

/**
 * `deleted_export_advisories` was only added in migration v21 — probe for it
 * rather than assuming it exists, matching the try/catch pattern used
 * throughout `build-stmts.ts` for other optional tables. A DB opened
 * read-only via `openReadonlyOrFail` (as `check` does) never runs
 * migrations, so an older DB genuinely may not have this table yet.
 *
 * The result is cached per db handle (`_hasAdvisoryTableCache`) — schema
 * shape cannot change over the lifetime of an open handle, so re-probing on
 * every call (as this did before #1948's fix) is pure waste. Mirrors the
 * `_hasExportedColCache` pattern in `nodes.ts`.
 */
function hasAdvisoryTable(db: BetterSqlite3Database): boolean {
  const cached = _hasAdvisoryTableCache.get(db);
  if (cached !== undefined) return cached;
  let has = false;
  try {
    db.prepare('SELECT 1 FROM deleted_export_advisories LIMIT 1').get();
    has = true;
  } catch {
    /* older DB predates migration v21 */
  }
  _hasAdvisoryTableCache.set(db, has);
  return has;
}

/**
 * `consumer_kind` was only added in migration v22 (#1973) — a read-only
 * `check` invocation can still hit a DB whose `deleted_export_advisories`
 * table exists (v21) but hasn't run v22 yet, if the last write-mode
 * `codegraph build` predates this column. Same try/catch probe pattern as
 * `hasAdvisoryTable` above, for the same reason, and cached the same way.
 */
function hasConsumerKindColumn(db: BetterSqlite3Database): boolean {
  const cached = _hasConsumerKindColCache.get(db);
  if (cached !== undefined) return cached;
  let has = false;
  try {
    db.prepare('SELECT consumer_kind FROM deleted_export_advisories LIMIT 1').get();
    has = true;
  } catch {
    /* older DB predates migration v22 */
  }
  _hasConsumerKindColCache.set(db, has);
  return has;
}

/**
 * Snapshots, for each deleted export that still has an external consumer,
 * one row per consumer — captured by `detectChanges` BEFORE the build
 * pipeline purges the deleted file's `nodes`/`edges` rows.
 *
 * Replaces any pre-existing advisory rows for a file only when that file's
 * `nodes` are still live — i.e. only on the one build that actually purges
 * them, when `findExportedDefinitions` can still derive an authoritative
 * snapshot. The `file_hashes` row for a removed file is intentionally never
 * purged on the incremental path (`purgeHashes: false` — see
 * `purgeAndAddReverseDeps`), so a subsequent build keeps re-detecting the
 * same file as "removed" and calls this again with nothing left to derive a
 * snapshot from. Deleting-then-not-reinserting on that later call would
 * silently erase the one durable record this table exists to preserve, so
 * a file with no live defs left is skipped entirely — its existing snapshot
 * (if any) is left untouched.
 */
export function recordDeletedExportAdvisories(
  db: BetterSqlite3Database,
  removedFiles: string[],
): void {
  if (removedFiles.length === 0 || !hasAdvisoryTable(db)) return;

  const deleteStmt = cachedStmt(
    _deleteByFileStmt,
    db,
    'DELETE FROM deleted_export_advisories WHERE file = ?',
  );
  const insertStmt = cachedStmt(
    _insertAdvisoryStmt,
    db,
    `INSERT INTO deleted_export_advisories
       (file, name, kind, line, consumer_name, consumer_file, consumer_line, consumer_kind, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    const now = Date.now();
    for (const file of removedFiles) {
      const defs = findExportedDefinitions(db, file);
      // No live nodes left for this file — an earlier build already purged
      // them and captured the snapshot. Nothing new to derive; preserve
      // whatever is already persisted instead of wiping it (#1938).
      if (defs.length === 0) continue;
      deleteStmt.run(file);
      for (const def of defs) {
        const consumers = findExternalConsumers(db, def.id, file);
        for (const consumer of consumers) {
          insertStmt.run(
            file,
            def.name,
            def.kind,
            def.line,
            consumer.name,
            consumer.file,
            consumer.line,
            consumer.consumerKind ?? null,
            now,
          );
        }
      }
    }
  });
  tx();
}

/**
 * Clears advisory rows for files that are no longer deleted — e.g. a
 * previously-removed file reappearing under the same path (a revert, or an
 * unrelated new file created at the same location). Called for every file
 * about to be (re)inserted by the build pipeline, so a resolved deletion
 * never lingers to misattribute a stale violation to whatever now lives at
 * that path (#1938).
 *
 * Runs unconditionally on every incremental build (see detect-changes.ts),
 * including the overwhelmingly common case where `files` never had an
 * advisory row to begin with. Opening a write transaction (BEGIN/COMMIT) for
 * that no-op case was the dominant cost behind #1948's WASM `detectMs`
 * regression, so this checks — via the indexed `file` column, no transaction
 * needed for a plain read — whether any row actually needs clearing before
 * paying for one. Statements are cached module-scope (`cachedStmt`) rather
 * than re-prepared per call.
 */
export function clearDeletedExportAdvisories(db: BetterSqlite3Database, files: string[]): void {
  if (files.length === 0 || !hasAdvisoryTable(db)) return;
  const existsStmt = cachedStmt(
    _existsForFileStmt,
    db,
    'SELECT 1 FROM deleted_export_advisories WHERE file = ? LIMIT 1',
  );
  const toClear = files.filter((file) => existsStmt.get(file) !== undefined);
  if (toClear.length === 0) return;
  const stmt = cachedStmt(
    _deleteByFileStmt,
    db,
    'DELETE FROM deleted_export_advisories WHERE file = ?',
  );
  const tx = db.transaction(() => {
    for (const file of toClear) stmt.run(file);
  });
  tx();
}

/**
 * Reads persisted deleted-export advisories for `files`, grouped back into
 * one entry per (file, name, kind, line) with its consumer list — the
 * inverse of `recordDeletedExportAdvisories`'s one-row-per-consumer layout.
 *
 * `excludeConsumerFiles` mirrors the live-DB path's identical filter
 * (`checkNoDeletedExportsInUse`): a consumer that is itself part of the same
 * deletion batch being checked right now isn't a caller left dangling by the
 * diff. This is applied here (against the *current* check invocation's
 * deleted-file set) rather than baked in at capture time, since the set of
 * files being deleted "together" from `check`'s point of view can differ
 * from the build-time removed-file batch that originally captured the
 * advisory.
 */
export function getDeletedExportAdvisories(
  db: BetterSqlite3Database,
  files: string[],
  excludeConsumerFiles: Set<string>,
): DeletedExportAdvisoryEntry[] {
  if (files.length === 0 || !hasAdvisoryTable(db)) return [];

  const placeholders = files.map(() => '?').join(',');
  const consumerKindSelect = hasConsumerKindColumn(db)
    ? ', consumer_kind'
    : ', NULL AS consumer_kind';
  const rows = db
    .prepare(
      `SELECT file, name, kind, line, consumer_name, consumer_file, consumer_line${consumerKindSelect}
       FROM deleted_export_advisories
       WHERE file IN (${placeholders})
       ORDER BY file, line`,
    )
    .all(...files) as DeletedExportAdvisoryRow[];

  const grouped = new Map<string, DeletedExportAdvisoryEntry>();
  for (const row of rows) {
    if (excludeConsumerFiles.has(row.consumer_file)) continue;
    const key = `${row.file}|${row.name}|${row.kind}|${row.line}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { file: row.file, name: row.name, kind: row.kind, line: row.line, consumers: [] };
      grouped.set(key, entry);
    }
    entry.consumers.push({
      name: row.consumer_name,
      file: row.consumer_file,
      line: row.consumer_line,
      // Rows persisted before migration v22 have consumer_kind = NULL — leave
      // consumerKind undefined for those rather than guessing, same as any
      // other pre-#1973 advisory row (#1973). 'topLevelCall' added by #2365.
      ...(row.consumer_kind === 'file' ||
      row.consumer_kind === 'symbol' ||
      row.consumer_kind === 'topLevelCall'
        ? { consumerKind: row.consumer_kind }
        : {}),
    });
  }
  return [...grouped.values()].filter((e) => e.consumers.length > 0);
}
