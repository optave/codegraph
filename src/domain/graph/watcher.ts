import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getNodeId as getNodeIdQuery, initSchema, openDb } from '../../db/index.js';
import { detectWorkspaces, loadConfig } from '../../infrastructure/config.js';
import { debug, info, warn } from '../../infrastructure/logger.js';
import { buildIgnoreSet, isSupportedFile, normalizePath } from '../../shared/constants.js';
import { DbError } from '../../shared/errors.js';
import { createParseTreeCache, getActiveEngine } from '../parser.js';
import { type IncrementalStmts, rebuildFile } from './builder/incremental.js';
import { appendChangeEvents, buildChangeEvent, diffSymbols } from './change-journal.js';
import { appendJournalEntriesAndStampHeader } from './journal.js';
import { clearExportsCache, setWorkspaces } from './resolve.js';

function shouldIgnorePath(filePath: string, ignoreSet: ReadonlySet<string>): boolean {
  const parts = filePath.split(path.sep);
  return parts.some((p) => ignoreSet.has(p) || p.startsWith('.'));
}

/** Prepare all SQL statements needed by the watcher's incremental rebuild. */
function prepareWatcherStatements(db: ReturnType<typeof openDb>): IncrementalStmts {
  return {
    // Column set and order mirror the full-build path's getNodeStmt
    // (src/domain/graph/builder/helpers.ts) — issue #2220: a symbol touched
    // only by a watch-mode rebuild must get the same qualified_name/scope/
    // visibility/parent_id/content_hash a full or regular incremental build
    // would have given it.
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name,kind,file,line,end_line,parent_id,qualified_name,scope,visibility,content_hash,accessor_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ),
    // Mirrors the full-build path's getExportStmt (issue #2220).
    markExported: db.prepare(
      'UPDATE nodes SET exported = 1 WHERE name = ? AND kind = ? AND file = ? AND line = ?',
    ),
    getNodeId: {
      get: (...params: unknown[]) => {
        const [name, kind, file, line] = params as [string, string, string, number];
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    // OR IGNORE: mirrors every other edge-insert statement (native's
    // insert_edge_chunk, build-edges.ts's getEdgeStmt) now that
    // idx_edges_content_unique (#2072) actually backs it. Without this, a
    // duplicate content row — e.g. two import statements in the same file
    // resolving to the same target+kind, see emitEdgesForImport below —
    // throws a hard UNIQUE-constraint SqliteError instead of being silently
    // deduplicated like every other insert path already tolerates.
    insertEdge: db.prepare(
      'INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdges: db.prepare(
      'SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    findNodeInFile: db.prepare(
      // `accessor_kind` (aliased to `accessorKind`) is included so
      // resolveCallTargets can filter a #2030 accessorRead-tagged call to a
      // matching accessor node.
      "SELECT id, kind, file, line, accessor_kind AS accessorKind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      // `kind` is included so resolveByMethodOrGlobal can filter to 'method' for
      // type-aware receiver resolution (mirrors the full-build resolver). `line`
      // is included so resolveCallTargets can tell whether a type-aware match
      // and an already-found bare match are the same physical declaration
      // (#2025). `accessor_kind` (aliased to `accessorKind`) is included for
      // the same #2030 reason as findNodeInFile above.
      "SELECT id, file, kind, line, accessor_kind AS accessorKind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
    // Mirrors native-orchestrator.ts's makePostNativeCallLookup containment
    // query (issue #2238 follow-up, Greptile finding on PR #2400).
    hasEnclosingCallable: db.prepare(`
      SELECT 1 FROM nodes
      WHERE file = ? AND kind IN ('method', 'function') AND id != ?
      AND line <= ? AND (end_line IS NULL OR end_line >= ?)
      LIMIT 1
    `),
    upsertFileHash: db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    ),
    deleteFileHash: db.prepare('DELETE FROM file_hashes WHERE file = ?'),
  };
}

/** Rebuild result shape from rebuildFile. */
interface RebuildResult {
  file: string;
  deleted?: boolean;
  event: string;
  symbolDiff: unknown;
  nodesBefore: number;
  nodesAfter: number;
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesBefore: number;
}

/** Process a batch of pending file changes: rebuild, journal, and log. */
async function processPendingFiles(
  files: string[],
  db: ReturnType<typeof openDb>,
  rootDir: string,
  stmts: IncrementalStmts,
  engineOpts: import('../../types.js').EngineOpts,
  cache: ReturnType<typeof createParseTreeCache>,
): Promise<void> {
  const results: RebuildResult[] = [];
  for (const filePath of files) {
    // Per-file try/catch so one bad rebuild doesn't crash the watcher loop.
    // The watcher is a long-running session — any SQLite error, parse failure,
    // or filesystem race must be reported and skipped, not propagated. Issue #1176.
    try {
      const result = (await rebuildFile(db, rootDir, filePath, stmts, engineOpts, cache, {
        diffSymbols: diffSymbols as (old: unknown[], new_: unknown[]) => unknown,
      })) as RebuildResult | null;
      if (result) results.push(result);
    } catch (err: unknown) {
      const relPath = normalizePath(path.relative(rootDir, filePath));
      // Narrow with `instanceof` instead of casting: a non-Error throw (a plain
      // string, `null`, or any value a third-party dependency throws) would log
      // `(err as Error).message` as `undefined`. See Greptile review on #1182.
      const message = err instanceof Error ? err.message : String(err);
      warn(`Failed to rebuild ${relPath}: ${message} — skipping`);
      debug(err instanceof Error ? (err.stack ?? message) : String(err));
    }
  }

  if (results.length > 0) {
    writeJournalAndChangeEvents(rootDir, results);
  }

  logRebuildResults(results);
}

/** Write journal entries and change events for processed files. */
function writeJournalAndChangeEvents(rootDir: string, updates: RebuildResult[]): void {
  const entries = updates.map((r) => ({
    file: r.file,
    deleted: r.deleted || false,
  }));
  try {
    appendJournalEntriesAndStampHeader(rootDir, entries, Date.now());
  } catch (e: unknown) {
    debug(`Journal write failed (non-fatal): ${(e as Error).message}`);
  }

  const changeEvents = updates.map((r) =>
    buildChangeEvent(r.file, r.event, r.symbolDiff, {
      nodesBefore: r.nodesBefore,
      nodesAfter: r.nodesAfter,
      edgesAdded: r.edgesAdded - r.edgesBefore,
    }),
  );
  try {
    appendChangeEvents(rootDir, changeEvents);
  } catch (e: unknown) {
    debug(`Change event write failed (non-fatal): ${(e as Error).message}`);
  }
}

/** Log rebuild results to the user. */
function logRebuildResults(updates: RebuildResult[]): void {
  for (const r of updates) {
    const nodeDelta = r.nodesAdded - r.nodesRemoved;
    const nodeStr = nodeDelta >= 0 ? `+${nodeDelta}` : `${nodeDelta}`;
    if (r.deleted) {
      info(`Removed: ${r.file} (-${r.nodesRemoved} nodes)`);
    } else {
      const edgeDelta = r.edgesAdded - r.edgesBefore;
      const edgeStr = edgeDelta >= 0 ? `+${edgeDelta}` : `${edgeDelta}`;
      info(`Updated: ${r.file} (${nodeStr} nodes, ${edgeStr} edges)`);
    }
  }
}

/**
 * Recursively collect tracked source files for stat-based polling. Also
 * collects `package.json` paths into `packageJsonResult` when provided —
 * they're not a "supported" source file (so never added to `result`), but
 * still need mtime-diff detection to trigger a workspace/exports cache
 * refresh (issue #2290).
 */
function collectTrackedFiles(
  dir: string,
  result: string[],
  ignoreSet: ReadonlySet<string>,
  packageJsonResult?: string[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e: unknown) {
    debug(`collectTrackedFiles: cannot read ${dir}: ${(e as Error).message}`);
    return;
  }
  for (const entry of entries) {
    if (ignoreSet.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTrackedFiles(full, result, ignoreSet, packageJsonResult);
    } else if (isSupportedFile(entry.name)) {
      result.push(full);
    } else if (packageJsonResult && entry.name === 'package.json') {
      packageJsonResult.push(full);
    }
  }
}

/** Shared watcher state passed between setup and watcher sub-functions. */
interface WatcherContext {
  rootDir: string;
  db: ReturnType<typeof openDb>;
  stmts: IncrementalStmts;
  engineOpts: import('../../types.js').EngineOpts;
  cache: ReturnType<typeof createParseTreeCache>;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  /** Merged ignore set from IGNORE_DIRS + config.ignoreDirs + config.ignoreAdditionalDirs. */
  ignoreSet: ReadonlySet<string>;
  /**
   * Set when a `package.json` inside the watched tree has changed since the
   * last debounced flush — consumed (and reset) by `scheduleDebouncedProcess`
   * to re-detect workspace packages before the next rebuild (issue #2290).
   * Kept separate from `pending`: `package.json` is never itself rebuildable
   * via `rebuildFile` (it's not a supported source-language extension).
   */
  workspaceRefreshPending: boolean;
}

/**
 * Re-detect workspace packages and clear the exports cache (both engines) —
 * called once a `package.json` inside the watched tree is known to have
 * changed, so a long-running watch session doesn't keep resolving imports
 * against stale exports/workspace data for its whole lifetime (issue #2290).
 *
 * `detectWorkspaces()` re-globs and re-reads every workspace package's
 * manifest, so — unlike the cheap, unconditional `clearExportsCache()` call
 * in `rebuildFile` (a plain cache clear, no filesystem re-scan) — this is
 * gated on actually observing a `package.json` change rather than run on
 * every rebuild, to avoid a per-keystroke re-scan cost in a large monorepo.
 *
 * `setWorkspaces()` is called unconditionally, even when `workspaces` comes
 * back empty — unlike the full-build pipeline's own `size > 0` gate before
 * calling it, which never has a real staleness consequence there (a full
 * build starts from an empty `_workspaceCache` each process). This function
 * instead runs repeatedly within one long-lived watch session: if the last
 * workspace package is removed mid-session, an empty map must still REPLACE
 * whatever non-empty map is currently cached, or every subsequent rebuild
 * keeps resolving against removed workspace entries (Greptile review, PR
 * #2458).
 *
 * Exported for unit-testing; prefer letting the watcher call this
 * automatically in production paths.
 */
export function refreshWorkspaceAndExportsCaches(rootDir: string): void {
  const workspaces = detectWorkspaces(rootDir);
  // Also clears the exports cache as a side effect, but only on this
  // (TypeScript) side — the explicit clearExportsCache() below covers the
  // native side too.
  setWorkspaces(rootDir, workspaces);
  if (workspaces.size > 0) {
    info(`Refreshed ${workspaces.size} workspace packages (package.json changed)`);
  }
  clearExportsCache();
}

/** Initialize DB, engine, cache, and statements for watch mode. */
function setupWatcher(rootDir: string, opts: { engine?: string; dbPath?: string }): WatcherContext {
  const dbPath = opts.dbPath ?? path.join(rootDir, '.codegraph', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    throw new DbError('No graph.db found. Run `codegraph build` first.', { file: dbPath });
  }

  // Load repo config so ignoreDirs and ignoreAdditionalDirs are respected by
  // the watcher the same way they are by collectFiles in the batch build path.
  const config = loadConfig(rootDir);
  const extraDirs = [...(config.ignoreDirs ?? []), ...(config.ignoreAdditionalDirs ?? [])];
  const ignoreSet = buildIgnoreSet(extraDirs.length ? extraDirs : undefined);

  const db = openDb(dbPath, config.db.busyTimeoutMs);
  initSchema(db);
  const engineOpts: import('../../types.js').EngineOpts = {
    engine: (opts.engine || 'auto') as import('../../types.js').EngineMode,
    dataflow: false,
    ast: false,
    // #2077: without this, incremental rebuilds fell back to
    // buildPointsToMapForFile's own default parameter instead of honoring a
    // .codegraphrc.json override, diverging from the full-build path below.
    pointsToMaxIterations: config.analysis.pointsToMaxIterations,
    // #2242: without this, rebuildFile only resolved tsconfig/jsconfig
    // aliases, silently excluding aliases configured via .codegraphrc.json's
    // own `aliases` field that a full build does honor.
    aliases: config.aliases,
  };
  const { name: engineName, version: engineVersion } = getActiveEngine(engineOpts);
  info(`Watch mode using ${engineName} engine${engineVersion ? ` (v${engineVersion})` : ''}`);

  const cache = createParseTreeCache();
  info(
    cache
      ? 'Incremental parsing enabled (native tree cache)'
      : 'Incremental parsing unavailable (full re-parse)',
  );

  const stmts = prepareWatcherStatements(db);

  return {
    rootDir,
    db,
    stmts,
    engineOpts,
    cache,
    pending: new Set<string>(),
    timer: null,
    debounceMs: 300,
    ignoreSet,
    workspaceRefreshPending: false,
  };
}

/** Schedule debounced processing of pending files. */
function scheduleDebouncedProcess(ctx: WatcherContext): void {
  if (ctx.timer) clearTimeout(ctx.timer);
  ctx.timer = setTimeout(async () => {
    const files = [...ctx.pending];
    ctx.pending.clear();
    // Refresh before rebuilding so any source file in this same debounced
    // batch that imports from the changed package sees fresh data (#2290).
    if (ctx.workspaceRefreshPending) {
      ctx.workspaceRefreshPending = false;
      refreshWorkspaceAndExportsCaches(ctx.rootDir);
    }
    await processPendingFiles(files, ctx.db, ctx.rootDir, ctx.stmts, ctx.engineOpts, ctx.cache);
  }, ctx.debounceMs);
}

/**
 * Diff `current` file paths against `mtimeMap`'s cached mtimes (added,
 * changed, or removed since the last check), updating the map in place and
 * invoking `onChanged` for each one. Shared by the source-file and
 * `package.json` polling loops below — the two need different actions
 * (queue for rebuild vs. flag a cache refresh) but the same diff mechanics.
 *
 * Exported for unit-testing; prefer letting the polling watcher call this
 * automatically in production paths.
 */
export function diffMtimes(
  current: string[],
  mtimeMap: Map<string, number>,
  onChanged: (file: string) => void,
): void {
  const currentSet = new Set(current);
  for (const f of current) {
    try {
      const mtime = fs.statSync(f).mtimeMs;
      const prev = mtimeMap.get(f);
      if (prev === undefined || mtime !== prev) {
        mtimeMap.set(f, mtime);
        onChanged(f);
      }
    } catch {
      /* deleted between collect and stat */
    }
  }
  for (const f of mtimeMap.keys()) {
    if (!currentSet.has(f)) {
      mtimeMap.delete(f);
      onChanged(f);
    }
  }
}

/** Start polling-based file watcher. Returns cleanup function. */
function startPollingWatcher(ctx: WatcherContext, pollIntervalMs: number): () => void {
  const mtimeMap = new Map<string, number>();
  const packageJsonMtimeMap = new Map<string, number>();

  const initial: string[] = [];
  const initialPackageJson: string[] = [];
  collectTrackedFiles(ctx.rootDir, initial, ctx.ignoreSet, initialPackageJson);
  for (const f of initial) {
    try {
      mtimeMap.set(f, fs.statSync(f).mtimeMs);
    } catch {
      /* deleted between collect and stat */
    }
  }
  for (const f of initialPackageJson) {
    try {
      packageJsonMtimeMap.set(f, fs.statSync(f).mtimeMs);
    } catch {
      /* deleted between collect and stat */
    }
  }
  info(`Polling ${initial.length} tracked files every ${pollIntervalMs}ms`);

  const pollTimer = setInterval(() => {
    const current: string[] = [];
    const currentPackageJson: string[] = [];
    collectTrackedFiles(ctx.rootDir, current, ctx.ignoreSet, currentPackageJson);

    diffMtimes(current, mtimeMap, (f) => ctx.pending.add(f));
    // package.json changes (#2290): flag a cache refresh rather than queue
    // for rebuild — package.json is never itself rebuildable via rebuildFile.
    diffMtimes(currentPackageJson, packageJsonMtimeMap, () => {
      ctx.workspaceRefreshPending = true;
    });

    if (ctx.pending.size > 0 || ctx.workspaceRefreshPending) {
      scheduleDebouncedProcess(ctx);
    }
  }, pollIntervalMs);

  return () => clearInterval(pollTimer);
}

/** Start native OS file watcher. Returns cleanup function. */
function startNativeWatcher(ctx: WatcherContext): () => void {
  const watcher = fs.watch(ctx.rootDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    if (shouldIgnorePath(filename, ctx.ignoreSet)) return;

    // package.json changes (#2290): flag a cache refresh rather than queue
    // for rebuild — it's never itself rebuildable via rebuildFile. Checked
    // before isSupportedFile since package.json isn't a supported source
    // extension. shouldIgnorePath above already scopes this to the watched
    // tree, so a node_modules dependency's own package.json (unwatched by
    // design) is excluded the same way source files there are.
    if (path.basename(filename) === 'package.json') {
      ctx.workspaceRefreshPending = true;
      scheduleDebouncedProcess(ctx);
      return;
    }

    if (!isSupportedFile(filename)) return;

    ctx.pending.add(path.join(ctx.rootDir, filename));
    scheduleDebouncedProcess(ctx);
  });

  return () => watcher.close();
}

/**
 * Build journal entries for a pending-path set, detecting deletions by
 * existence check.
 *
 * `ctx.pending` is an untyped `Set<string>` — it carries no event-type
 * metadata. Without this check, a file deleted during the watch session
 * would be journaled as "changed", causing the next incremental build to
 * try to re-parse a non-existent file instead of removing it from the graph.
 * Mirrors the deletion detection in `rebuildFile` (see builder/incremental.ts).
 *
 * Exported for unit-testing; prefer `setupShutdownHandler` in production paths.
 */
export function buildFlushEntriesFromPending(
  rootDir: string,
  pending: Iterable<string>,
): Array<{ file: string; deleted: boolean }> {
  return [...pending].map((filePath) => ({
    file: normalizePath(path.relative(rootDir, filePath)),
    deleted: !fs.existsSync(filePath),
  }));
}

/** Register SIGINT handler to flush journal and clean up. */
function setupShutdownHandler(ctx: WatcherContext, cleanup: () => void): void {
  process.once('SIGINT', () => {
    info('Stopping watcher...');
    cleanup();
    if (ctx.pending.size > 0) {
      const entries = buildFlushEntriesFromPending(ctx.rootDir, ctx.pending);
      try {
        appendJournalEntriesAndStampHeader(ctx.rootDir, entries, Date.now());
      } catch (e: unknown) {
        debug(`Journal flush on exit failed (non-fatal): ${(e as Error).message}`);
      }
    }
    if (ctx.cache) ctx.cache.clear();
    closeDb(ctx.db);
    process.exit(0);
  });
}

export async function watchProject(
  rootDir: string,
  opts: { engine?: string; poll?: boolean; pollInterval?: number; dbPath?: string } = {},
): Promise<void> {
  const ctx = setupWatcher(rootDir, opts);

  const usePoll = opts.poll ?? process.platform === 'win32';
  const pollIntervalMs = opts.pollInterval ?? 2000;

  info(`Watching ${rootDir} for changes${usePoll ? ' (polling mode)' : ''}...`);
  info('Press Ctrl+C to stop.');

  const cleanup = usePoll ? startPollingWatcher(ctx, pollIntervalMs) : startNativeWatcher(ctx);

  setupShutdownHandler(ctx, cleanup);
}
