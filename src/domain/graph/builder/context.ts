/**
 * PipelineContext — shared mutable state threaded through all build stages.
 *
 * Each stage reads what it needs and writes what it produces.
 * This replaces the closure-captured locals in the old monolithic buildGraph().
 */
import type {
  BetterSqlite3Database,
  BuildGraphOpts,
  CodegraphConfig,
  EngineOpts,
  ExtractorOutput,
  FileToParse,
  MetadataUpdate,
  NativeDatabase,
  NodeRow,
  ParseChange,
  PathAliases,
} from '../../../types.js';
import type { BarrelExportResolution } from './stages/resolve-imports.js';

export class PipelineContext {
  // ── Inputs (set during setup) ──────────────────────────────────────
  rootDir!: string;
  db!: BetterSqlite3Database;
  dbPath!: string;
  config!: CodegraphConfig;
  opts!: BuildGraphOpts;
  engineOpts!: EngineOpts;
  engineName!: 'native' | 'wasm';
  engineVersion!: string | null;
  /**
   * The version reported by the native binary itself (CARGO_PKG_VERSION at
   * build time), as opposed to `engineVersion` which prefers the platform
   * package.json. The Rust orchestrator's check_version_mismatch compares
   * `build_meta.engine_version` against CARGO_PKG_VERSION, so build_meta
   * writes must use this value to avoid a perpetual full-rebuild loop when
   * the binary and platform package.json drift apart (e.g., CI hot-swap
   * via ci-install-native.mjs — #1066).
   */
  nativeBinaryVersion!: string | null;
  aliases!: PathAliases;
  incremental!: boolean;
  forceFullRebuild: boolean = false;
  schemaVersion!: number;
  nativeDb?: NativeDatabase;
  /** Whether native engine is available (deferred — DB opened only when needed). */
  nativeAvailable: boolean = false;
  /** True when ctx.db is a NativeDbProxy — single rusqlite connection for the entire pipeline. */
  nativeFirstProxy: boolean = false;

  // ── File collection (set by collectFiles stage) ────────────────────
  allFiles!: string[];
  discoveredDirs!: Set<string>;

  // ── Change detection (set by detectChanges stage) ──────────────────
  isFullBuild!: boolean;
  parseChanges!: ParseChange[];
  metadataUpdates!: MetadataUpdate[];
  removed!: string[];
  /**
   * Forward+reverse import-neighbor files of `removed`, captured before
   * `purgeFilesFromGraph`/`purgeFilesData` deletes those files' edges. Lets
   * `refreshAffectedDirectoryMetrics` still discover a removed file's
   * cross-directory neighbor even though the live edge evidence for it is
   * gone by the time the structure stage runs (#1839).
   */
  removedFileNeighbors: string[] = [];
  earlyExit: boolean = false;
  /**
   * Relative file paths whose `nodes.entrypoint`/`entrypoint_source_file`
   * columns were touched by `markEntrypointTargets` this build (#2392,
   * review fix on #2411) — set by the `buildEdges` stage, consumed by
   * `classifyRoles` in the `buildStructure` stage.
   *
   * A touched target's own file is frequently *not* the file that was
   * reparsed (that is the whole cross-file case this exists for), and
   * `classifyNodeRolesIncremental`'s own neighbour-expansion join can't
   * discover it either, for the identical reason `markEntrypointTargets`'s
   * clear query couldn't find a removed guard's old target: the connecting
   * `calls` edge may have just been deleted. Without seeding this
   * explicitly, `nodes.entrypoint` clears correctly but the cached
   * `nodes.role` for the same row is left stale at `"entry"` — same class of
   * bug as `removedFileNeighbors` above (#1839) patches for directory
   * metrics. Mirrors `entrypoint_touched_files` in
   * `crates/codegraph-core/src/domain/graph/builder/pipeline.rs`.
   */
  entrypointTouchedFiles: string[] = [];

  // ── Parsing (set by parseFiles stage) ──────────────────────────────
  allSymbols!: Map<string, ExtractorOutput>;
  fileSymbols!: Map<string, ExtractorOutput>;
  filesToParse!: FileToParse[];

  // ── Import resolution (set by resolveImports stage) ────────────────
  batchResolved!: Map<string, string> | null;
  reexportMap!: Map<string, unknown[]>;
  barrelOnlyFiles!: Set<string>;
  /** Phase 8.4: cache for resolveBarrelExport results keyed as "barrelPath|symbolName". */
  barrelExportCache: Map<string, BarrelExportResolution | null> = new Map();

  // ── Node lookup (set by insertNodes / buildEdges stages) ───────────
  nodesByName!: Map<string, NodeRow[]>;
  nodesByNameAndFile!: Map<string, NodeRow[]>;
  /**
   * Function/method-kind nodes grouped by file, for the "is this node nested
   * inside another callable" containment check `resolveThisDispatch` (cha.ts)
   * needs via `CallNodeLookup.hasEnclosingCallable` (issue #2238 follow-up,
   * Greptile finding on PR #2400).
   */
  callablesByFile!: Map<string, Array<{ id: number; line: number; endLine: number | null }>>;

  // ── Reverse-dep edge reconnection (set by detectChanges) ───────────
  /**
   * Edges from reverse-dep files to changed files, saved before purge so they
   * can be reconnected to new node IDs after insertNodes (#932, #933).
   * Eliminates the need to reparse reverse-dep files entirely.
   */
  savedReverseDepEdges: Array<{
    sourceId: number;
    tgtName: string;
    tgtKind: string;
    tgtFile: string;
    tgtLine: number;
    edgeKind: string;
    confidence: number;
    dynamic: number;
    technique: string | null;
    dynamicKind: string | null;
    /**
     * The target declaration's `content_hash` at save time, or `null` when
     * unavailable (rows from before the content_hash migration). Lets
     * `pickReconnectTarget` try an exact-hash match before falling back to
     * line-position alignment — a true identity signal that line position
     * alone cannot provide when a sibling group's size stays unchanged
     * because one member was renamed away and a different one added in the
     * same edit (issue #2015).
     */
    tgtHash: string | null;
  }> = [];

  /**
   * Pre-purge snapshot of the sorted line list for every (name, kind)
   * sibling group referenced by `savedReverseDepEdges`, keyed by
   * `name|kind|file`. A file can contain multiple distinct symbols sharing
   * the identical name and kind — e.g. several object-literal `close() {}`
   * methods — so `(name, kind, file)` alone is not a unique identity.
   * `reconnectReverseDepEdges` aligns this old line list against the
   * post-purge candidate lines (order-preserving, minimum line-shift) to
   * map each saved edge to its correct new target even when the sibling
   * group itself was shifted, and even when the group's size changed
   * because a same-named sibling was added or removed in the same edit
   * (#1752, #1865).
   */
  savedSiblingGroups: Map<string, number[]> = new Map();

  // ── Misc state ─────────────────────────────────────────────────────
  hasEmbeddings: boolean = false;
  lineCountMap!: Map<string, number>;

  // ── Phase timing ───────────────────────────────────────────────────
  timing: {
    setupMs?: number;
    collectMs?: number;
    detectMs?: number;
    parseMs?: number;
    insertMs?: number;
    resolveMs?: number;
    edgesMs?: number;
    structureMs?: number;
    rolesMs?: number;
    astMs?: number;
    complexityMs?: number;
    cfgMs?: number;
    dataflowMs?: number;
    finalizeMs?: number;
    [key: string]: number | undefined;
  } = {};
  buildStart!: number;
}
