/**
 * Phase 8.5: Class Hierarchy Analysis (CHA) + Rapid Type Analysis (RTA)
 *
 * CHA resolves virtual/interface method dispatch to all known concrete
 * implementations.  RTA refines the CHA set by filtering out types that are
 * never instantiated in the program (no `new X()` anywhere in the codebase).
 *
 * Used by:
 *   - buildFileCallEdges (WASM/JS path)  — inline during per-file edge building,
 *     context built in-memory from all parsed fileSymbols (buildChaContext)
 *   - buildChaPostPass (native path)     — JS post-pass on top of native edges,
 *     context built in-memory from all parsed fileSymbols (buildChaContext)
 *   - incremental rebuild (watch mode)   — post-pass on top of a single-file
 *     rebuild's edges, context built from already-persisted DB state
 *     (buildChaContextFromDb) since only the rebuilt file + its reverse deps
 *     are held in memory, not the whole project (#1852)
 */

import type { BetterSqlite3Database, ClassRelation, ExtractorOutput } from '../../../types.js';
import type { ResolvedCandidate } from '../resolver/strategy.js';
import type { CallNodeLookup } from './call-resolver.js';
import { RECEIVER_KINDS } from './call-resolver.js';

// ── CHA context ──────────────────────────────────────────────────────────────

export interface ChaContext {
  /** interface/class name → concrete classes that implement or extend it.
   * Ambiguous when two unrelated files each declare their own class/interface
   * of the same bare name — prefer `implementorsByFile` whenever the caller's
   * own file locally declares a matching root type (issue #2237). */
  readonly implementors: ReadonlyMap<string, readonly string[]>;
  /** `${parentName}|${parentDeclaringFile}` → concrete classes recorded while
   * that same file ALSO locally declares a class/interface named `parentName`
   * — i.e. the child's `implements`/`extends` reference most plausibly means
   * THIS file's own declaration, not an unrelated same-named one elsewhere.
   * Disambiguates two independent files each declaring their own same-named
   * interface/base class (issue #2237); mirrors `parentsByFile`'s composite
   * key, applied to the inverse (parent → children) direction. Empty/missing
   * for a given `${parentName}|${file}` pair means no local anchor was found
   * for that file — callers fall back to the bare `implementors` map. */
  readonly implementorsByFile: ReadonlyMap<string, readonly string[]>;
  /**
   * class name → direct parent class name (from `extends`), first-write-wins
   * across the whole project. Ambiguous when the same bare class name is
   * declared in multiple files with different parents — prefer
   * `parentsByFile` whenever a declaration's home file is known.
   */
  readonly parents: ReadonlyMap<string, string>;
  /** `${className}|${file}` → direct parent class name (from `extends`), scoped
   * to the file that declared `className` — disambiguates same-named classes
   * declared in different files (issue #2062). */
  readonly parentsByFile: ReadonlyMap<string, string>;
  /** RTA: class names that appear in `new X()` anywhere in the project */
  readonly instantiatedTypes: ReadonlySet<string>;
}

export const EMPTY_CHA_CONTEXT: ChaContext = {
  implementors: new Map(),
  implementorsByFile: new Map(),
  parents: new Map(),
  parentsByFile: new Map(),
  instantiatedTypes: new Set(),
};

/**
 * Record a class's `implements` relationship into the implementors map
 * (interface/class name → concrete classes that implement it), plus the
 * file-scoped map when `file` also locally declares a same-named parent.
 */
function recordImplements(
  cls: ClassRelation,
  implementors: Map<string, string[]>,
  implementorsByFile: Map<string, string[]>,
  file: string,
  localClassNames: ReadonlySet<string>,
): void {
  if (!cls.implements) return;
  let list = implementors.get(cls.implements);
  if (!list) {
    list = [];
    implementors.set(cls.implements, list);
  }
  if (!list.includes(cls.name)) list.push(cls.name);

  // File-scoped: only when this file ALSO locally declares a class/interface
  // named `cls.implements` — the child's reference most plausibly means that
  // co-located declaration, not an unrelated same-named one elsewhere (#2237).
  if (localClassNames.has(cls.implements)) {
    addToFileScoped(implementorsByFile, cls.implements, file, cls.name);
  }
}

/**
 * Record a class's `extends` relationship into the parents map (child →
 * direct parent, for this/super hierarchy walking), the file-scoped parents
 * map (same, but disambiguated by the declaring file), and the implementors
 * map (parent → children, for CHA dispatch expansion via extends) — plus its
 * own file-scoped map, mirroring `recordImplements`.
 */
function recordExtends(
  cls: ClassRelation,
  implementors: Map<string, string[]>,
  implementorsByFile: Map<string, string[]>,
  parents: Map<string, string>,
  parentsByFile: Map<string, string>,
  file: string,
  localClassNames: ReadonlySet<string>,
): void {
  if (!cls.extends) return;
  // child → parent (for this/super hierarchy walking)
  if (!parents.has(cls.name)) parents.set(cls.name, cls.extends);
  parentsByFile.set(`${cls.name}|${file}`, cls.extends);
  // parent → children (for CHA dispatch expansion via extends)
  let list = implementors.get(cls.extends);
  if (!list) {
    list = [];
    implementors.set(cls.extends, list);
  }
  if (!list.includes(cls.name)) list.push(cls.name);

  if (localClassNames.has(cls.extends)) {
    addToFileScoped(implementorsByFile, cls.extends, file, cls.name);
  }
}

function addToFileScoped(
  implementorsByFile: Map<string, string[]>,
  parentName: string,
  file: string,
  childName: string,
): void {
  const key = `${parentName}|${file}`;
  let scoped = implementorsByFile.get(key);
  if (!scoped) {
    scoped = [];
    implementorsByFile.set(key, scoped);
  }
  if (!scoped.includes(childName)) scoped.push(childName);
}

/**
 * RTA: collect instantiated class names for one file's symbols — the Phase
 * 8.5 dedicated `newExpressions` list (all `new X()` in the file), plus the
 * constructor-confidence typeMap fallback (confidence >= 0.9) that covers
 * codebases that haven't been re-parsed since Phase 8.5 was added.
 */
function collectInstantiatedTypes(symbols: ExtractorOutput, instantiatedTypes: Set<string>): void {
  if (symbols.newExpressions) {
    for (const typeName of symbols.newExpressions) {
      instantiatedTypes.add(typeName);
    }
  }
  if (symbols.typeMap instanceof Map) {
    for (const entry of symbols.typeMap.values()) {
      if (typeof entry !== 'string' && entry.confidence >= 0.9) {
        instantiatedTypes.add(entry.type);
      }
    }
  }
}

/**
 * Build the CHA context from all parsed file symbols.
 *
 * Must be called AFTER cross-file return-type propagation so that typeMap
 * confidence values reflect propagated types (used for RTA seeding).
 */
export function buildChaContext(fileSymbols: ReadonlyMap<string, ExtractorOutput>): ChaContext {
  const implementors = new Map<string, string[]>();
  const implementorsByFile = new Map<string, string[]>();
  const parents = new Map<string, string>();
  const parentsByFile = new Map<string, string>();
  const instantiatedTypes = new Set<string>();

  for (const [file, symbols] of fileSymbols) {
    // `symbols.classes` only lists class RELATIONS (entries with an extends/
    // implements clause) — a bare `interface Handler {}` with no heritage
    // never appears there, so a same-file-anchor check against it alone
    // would miss the exact "plain interface, no relation" shape that's the
    // whole point of the collision this map protects against (#2237).
    // `symbols.definitions` covers every declared symbol regardless of
    // heritage; RECEIVER_KINDS narrows it to class/interface/struct/etc.
    const localClassNames = new Set(
      symbols.definitions.filter((d) => RECEIVER_KINDS.has(d.kind)).map((d) => d.name),
    );
    for (const cls of symbols.classes) {
      recordImplements(cls, implementors, implementorsByFile, file, localClassNames);
      recordExtends(
        cls,
        implementors,
        implementorsByFile,
        parents,
        parentsByFile,
        file,
        localClassNames,
      );
    }
    collectInstantiatedTypes(symbols, instantiatedTypes);
  }

  return { implementors, implementorsByFile, parents, parentsByFile, instantiatedTypes };
}

/**
 * Build the CHA context by querying already-persisted DB state instead of
 * scanning in-memory fileSymbols.
 *
 * Used by the incremental single-file rebuild path (`buildCallEdges` in
 * `builder/incremental.ts`), where only the rebuilt file + its reverse deps
 * are held in memory — the class hierarchy (`extends`/`implements` edges)
 * and RTA instantiation evidence needed for correct CHA/RTA dispatch,
 * however, span the whole project and must come from the DB (#1852).
 *
 * RTA evidence is read from `calls` edges targeting `class`-kind nodes:
 * `new X()` is extracted as an ordinary call to `X` (see extractors'
 * `handleNewExpr`/equivalent), so a resolved constructor call already leaves
 * this evidence in the DB regardless of which engine or build (full or
 * incremental) wrote it — no separate `newExpressions` bookkeeping needed.
 *
 * Unlike `runPostNativeCha`'s DB-driven CHA post-pass (`stages/native-orchestrator.ts`),
 * this does not fall back to treating every class as instantiated when no RTA
 * evidence exists anywhere — it stays consistent with `resolveChaTargets`'
 * always-strict filtering, matching the semantics `buildChaContext` (in-memory)
 * already gives the WASM/JS full-build path.
 */
export function buildChaContextFromDb(db: BetterSqlite3Database): ChaContext {
  const hierarchyRows = db
    .prepare(`
      SELECT src.name AS child_name, src.file AS child_file, tgt.name AS parent_name, e.kind AS edge_kind
      FROM edges e
      JOIN nodes src ON e.source_id = src.id
      JOIN nodes tgt ON e.target_id = tgt.id
      WHERE e.kind IN ('extends', 'implements')
    `)
    .all() as Array<{
    child_name: string;
    child_file: string;
    parent_name: string;
    edge_kind: string;
  }>;
  if (hierarchyRows.length === 0) return EMPTY_CHA_CONTEXT;

  // Per-file locally-declared class/interface/struct/etc. names — used to
  // build implementorsByFile below: a child's implements/extends reference
  // most plausibly means a same-file declaration when one exists, rather
  // than an unrelated same-named declaration elsewhere (#2237).
  const receiverKindsList = [...RECEIVER_KINDS];
  const localNameRows = db
    .prepare(`
      SELECT file, name
      FROM nodes
      WHERE kind IN (${receiverKindsList.map(() => '?').join(',')})
    `)
    .all(...receiverKindsList) as Array<{ file: string; name: string }>;
  const localNamesByFile = new Map<string, Set<string>>();
  for (const row of localNameRows) {
    let names = localNamesByFile.get(row.file);
    if (!names) {
      names = new Set();
      localNamesByFile.set(row.file, names);
    }
    names.add(row.name);
  }

  const implementors = new Map<string, string[]>();
  const implementorsByFile = new Map<string, string[]>();
  const parents = new Map<string, string>();
  const parentsByFile = new Map<string, string>();
  for (const row of hierarchyRows) {
    let list = implementors.get(row.parent_name);
    if (!list) {
      list = [];
      implementors.set(row.parent_name, list);
    }
    if (!list.includes(row.child_name)) list.push(row.child_name);
    if (localNamesByFile.get(row.child_file)?.has(row.parent_name)) {
      addToFileScoped(implementorsByFile, row.parent_name, row.child_file, row.child_name);
    }
    if (row.edge_kind === 'extends') {
      if (!parents.has(row.child_name)) parents.set(row.child_name, row.parent_name);
      parentsByFile.set(`${row.child_name}|${row.child_file}`, row.parent_name);
    }
  }

  const rtaRows = db
    .prepare(`
      SELECT DISTINCT tgt.name
      FROM edges e
      JOIN nodes tgt ON e.target_id = tgt.id
      WHERE e.kind = 'calls' AND tgt.kind = 'class'
    `)
    .all() as Array<{ name: string }>;
  const instantiatedTypes = new Set(rtaRows.map((r) => r.name));

  return { implementors, implementorsByFile, parents, parentsByFile, instantiatedTypes };
}

/**
 * build_meta key for the CHA-zero-implementor snapshot (issue #2315).
 * JSON-encoded array of interface/base-class names. Written by
 * `persistChaZeroImplementorSnapshot` in both `builder/stages/finalize.ts`
 * (WASM/JS full-build path, and any native full build that reaches
 * `finalize()`) and `builder/stages/native-orchestrator.ts`'s
 * `tryNativeOrchestrator` (the all-Rust fast path that otherwise bypasses
 * `finalize()` entirely) — shared here as the single source of truth so
 * both writers and `codegraph info`'s reader (`cli/commands/info.ts`) never
 * drift out of sync on the literal key name.
 */
export const CHA_ZERO_IMPLEMENTOR_META_KEY = 'cha_zero_implementor_interfaces';

/**
 * Given a `ChaContext`, return the interface/base-class names that currently
 * have ZERO instantiated implementors — i.e. every entry in
 * `implementors.get(name)` is absent from `instantiatedTypes`.
 *
 * Pure: takes a plain `ChaContext` and returns plain data, independent of
 * where that context came from (in-memory full build or `buildChaContextFromDb`)
 * — trivial to unit test with hand-built fixtures.
 *
 * Used for the CHA-zero-implementor health check (issue #2315):
 * `findChaSiblingCallerFiles` (`builder/incremental.ts`) discovers callers to
 * revisit during an INCREMENTAL rebuild by following EXISTING `cha`/
 * `super-dispatch` edges from some *other* implementor of a touched
 * interface. If an interface had zero instantiated implementors when a
 * caller's file was last parsed, that caller has no such edge anywhere in
 * the DB — so when a later incremental rebuild gives the interface its
 * FIRST instantiated implementor, there is nothing for
 * `findChaSiblingCallerFiles` to search from, and the caller is never
 * revisited. The caller's dispatch edge to the new implementor then stays
 * silently missing until a full (non-incremental) rebuild.
 *
 * This function only *detects* the zero-implementor set for snapshotting —
 * it does not close that gap (see the issue for why: a real fix needs either
 * a schema change to persist unresolved-but-typed call sites, or an
 * O(all-files) rescan per touched interface, both explicitly deferred
 * pending a proven workload need). `persistChaZeroImplementorSnapshot`
 * (`builder/stages/finalize.ts`) snapshots this set into `build_meta` at the
 * end of every FULL build; `codegraph info` (`cli/commands/info.ts`) compares
 * that snapshot against a fresh call to detect the transition and nudge a
 * full rebuild.
 */
export function deriveZeroImplementorInterfaces(ctx: ChaContext): string[] {
  const result: string[] = [];
  for (const [name, implementorNames] of ctx.implementors) {
    const hasInstantiatedImplementor = implementorNames.some((cls) =>
      ctx.instantiatedTypes.has(cls),
    );
    if (!hasInstantiatedImplementor) result.push(name);
  }
  return result;
}

// ── this / self / super resolution ──────────────────────────────────────────

/**
 * Resolve `this.method()`, `self.method()`, or `super.method()` through the
 * class hierarchy of the calling method.
 *
 * callerName must be a qualified method name ("ClassName.callerFn") for the
 * class context to be determinable.  Returns [] for plain functions.
 *
 * For `super`, resolution starts from the parent of the caller's class.
 * For `this`/`self`, resolution starts from the caller's own class and walks
 * up the inheritance chain (supporting inherited method lookup).
 *
 * When `callerFile` is provided, same-file method nodes are preferred: if the
 * hierarchy walk finds a qualified method that exists in both the caller's own
 * file AND in unrelated files (e.g. a class named `A` that appears in multiple
 * fixture files), only the same-file nodes are returned.  This prevents
 * cross-fixture false edges caused by accidental name collisions across
 * unrelated files in the same project build.  When no same-file nodes exist,
 * all found nodes are returned as before.
 */
export function resolveThisDispatch(
  methodName: string,
  callerName: string | null,
  receiver: 'this' | 'self' | 'super',
  chaCtx: ChaContext,
  lookup: CallNodeLookup,
  callerFile?: string | null,
): ReadonlyArray<ResolvedCandidate> {
  if (!callerName) return [];
  const dotIdx = callerName.indexOf('.');
  if (dotIdx === -1) return [];

  const callerClass = callerName.slice(0, dotIdx);
  const startClass =
    receiver === 'super'
      ? (callerFile && chaCtx.parentsByFile.get(`${callerClass}|${callerFile}`)) ||
        chaCtx.parents.get(callerClass)
      : callerClass;
  if (!startClass) return [];

  // Walk up the hierarchy; the visited set guards against cycles in malformed data.
  let current: string | undefined = startClass;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const qualified = `${current}.${methodName}`;
    const found = lookup.byName(qualified).filter((n) => n.kind === 'method');
    if (found.length > 0) {
      // When the caller's file is known, prefer same-file nodes to avoid
      // emitting cross-file edges to identically-named methods in unrelated
      // files.  Only fall back to the full set when no same-file node exists.
      if (callerFile) {
        const sameFile = found.filter((n) => n.file === callerFile);
        if (sameFile.length > 0) return sameFile;
        // No same-file candidate. `chaCtx.parents` is keyed by bare class
        // name, so `current` may be an unrelated class that merely shares a
        // name with the caller's real ancestor (issue #2062) — e.g. two
        // independent files each defining their own `Shape` class. Before
        // accepting a cross-file match, check whether a HERITAGE-CAPABLE
        // declaration named `current` is ALSO declared in the caller's own
        // file: if so, that same-file declaration IS the caller's real
        // ancestor reference at this step, so a same-named method from a
        // different file is a false match, not a legitimate inherited
        // method. Keep walking instead of accepting it.
        //
        // "Heritage-capable" is RECEIVER_KINDS (class/struct/interface/etc.)
        // *plus* a MODULE/CLASS-SCOPE `function` — a plain constructor
        // FUNCTION (`function A() {}`) is exactly as legitimate an
        // `extends`/`super()` target as a class is (functions have no
        // `.constructor` method to find, by definition), and is just as
        // disqualifying as a same-named class would be (issue #2238; a
        // same-named plain function was wrongly treated as "not declared
        // here" and fell through to an unrelated file's same-named class).
        // It must NOT be widened further than that: an unrelated same-named
        // local variable/parameter (Greptile finding on PR #2400) — nor a
        // NESTED function declared inside some other, unrelated function or
        // method body (a nested function can never be an `extends`/prototype
        // target; second Greptile finding on the same PR) — has anything to
        // do with the class hierarchy, and must not block a genuine
        // cross-file heritage reference from resolving.
        const sameNameInCallerFile = lookup
          .byNameAndFile(current, callerFile)
          .some(
            (n) =>
              RECEIVER_KINDS.has(n.kind ?? '') ||
              (n.kind === 'function' && !lookup.hasEnclosingCallable(callerFile, n.line, n.id)),
          );
        if (!sameNameInCallerFile) return found;
        // `current` is a same-named collision: it's genuinely declared in
        // callerFile but a different, unrelated file's class of the same
        // name is what defines `methodName`. Advance via THAT same-file
        // declaration's own parent (file-scoped) rather than the ambiguous
        // bare-name `parents` entry, which may belong to the colliding file
        // and misdirect the walk into a wholly unrelated hierarchy.
        current = chaCtx.parentsByFile.get(`${current}|${callerFile}`);
        continue;
      }
      return found;
    }
    current = chaCtx.parents.get(current);
  }
  return [];
}

// ── CHA dispatch expansion ───────────────────────────────────────────────────

/**
 * Resolve `${methodName}` on `cls` or, if `cls` inherits it without
 * overriding, the nearest ancestor (via `chaCtx.parents`/`parentsByFile`)
 * that actually declares it. A direct qualified lookup alone
 * (`${cls}.${methodName}`) misses whenever `cls` is instantiated but doesn't
 * override the dispatched method — the method node is registered under the
 * declaring ANCESTOR's qualified name, not `cls`'s (issue #2237). Mirrors
 * the ancestor-walk in `resolveThisDispatch`'s own `while` loop.
 *
 * `clsFile`, when known (propagated from a file-scoped BFS hop in
 * `resolveChaTargets`), is used to prefer a same-file qualified-method
 * lookup and a same-file parent-edge lookup at each step — otherwise an
 * unrelated file's identically-named class (with its own identically-named
 * method, or its own different parent chain) can still leak in even after
 * `resolveChaTargets` has correctly scoped which concrete class to walk
 * from (Greptile review finding on PR #2399). Each step falls back to the
 * bare/global lookup when the scoped one finds nothing — never a regression
 * versus the pre-fix behavior, only a preference when file identity is
 * actually known. The ancestor's own file is not generally knowable (it may
 * be an unrelated imported base), so `clsFile` is carried forward as an
 * optimistic guess for the next hop only when a same-file parent edge was
 * actually found; otherwise it is cleared to `null`.
 */
function resolveMethodViaAncestors(
  cls: string,
  clsFile: string | null,
  methodName: string,
  chaCtx: ChaContext,
  lookup: CallNodeLookup,
): ReadonlyArray<ResolvedCandidate> {
  let current: string | undefined = cls;
  let currentFile = clsFile;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const qualified = `${current}.${methodName}`;
    const scopedFound = currentFile ? lookup.byNameAndFile(qualified, currentFile) : [];
    const found = (scopedFound.length > 0 ? scopedFound : lookup.byName(qualified)).filter(
      (n) => n.kind === 'method',
    );
    if (found.length > 0) return found;
    const scopedParent: string | undefined = currentFile
      ? chaCtx.parentsByFile.get(`${current}|${currentFile}`)
      : undefined;
    const nextFile = scopedParent ? currentFile : null;
    current = scopedParent ?? chaCtx.parents.get(current);
    currentFile = nextFile;
  }
  return [];
}

/**
 * CHA + RTA: given a receiver type (class or interface), return all concrete
 * method implementations reachable via the class hierarchy.
 *
 * Only returns methods on types that are actually instantiated somewhere in
 * the project (RTA filter).  Returns [] when no concrete instantiated type
 * overrides the given method.
 *
 * BFS over the implementors map handles multi-level hierarchies (e.g.
 * IFoo → AbstractFoo → ConcreteFoo) so that abstract intermediate classes
 * are transparently skipped while their concrete subclasses are still reached.
 * When an instantiated class inherits the dispatched method rather than
 * overriding it, `resolveMethodViaAncestors` walks up to find the declaring
 * ancestor instead of missing the edge entirely (#2237).
 *
 * At every BFS level (not just the root), when the current node's file is
 * known, this prefers `chaCtx.implementorsByFile` over the bare
 * (project-wide) `implementors` map — disambiguating two unrelated files
 * that each declare their own same-named interface/base class (#2237;
 * mirrors `resolveThisDispatch`'s same-file preference). The starting node's
 * file is `callerFile` (when provided); a discovered child's file is known
 * ONLY when its parent was found via the scoped bucket — `implementorsByFile`
 * is populated exactly when the child's own file also locally declares that
 * parent, so the child is *guaranteed* to live in that same file. A child
 * reached only through the bare map has an unknown file, and the walk keeps
 * resolving through the bare map for its own children (and their eventual
 * method resolution — see `resolveMethodViaAncestors`) exactly as before:
 * legitimate multi-file hierarchies (a shared interface's implementors
 * declared across many files, e.g. issue #2078) must keep working. Every
 * scoped lookup falls back to the bare one when it finds nothing, so this is
 * never a regression — only a precision gain when file identity happens to
 * be known.
 */
export function resolveChaTargets(
  typeName: string,
  methodName: string,
  chaCtx: ChaContext,
  lookup: CallNodeLookup,
  callerFile?: string | null,
): ReadonlyArray<ResolvedCandidate> {
  const results: Array<ResolvedCandidate> = [];

  const queue: Array<{ name: string; file: string | null }> = [
    { name: typeName, file: callerFile ?? null },
  ];
  const visited = new Set<string>();
  visited.add(typeName);

  while (queue.length > 0) {
    const { name: current, file: currentFile } = queue.shift()!;
    const scoped = currentFile
      ? chaCtx.implementorsByFile.get(`${current}|${currentFile}`)
      : undefined;
    const children = scoped ?? chaCtx.implementors.get(current);
    const childFile = scoped ? currentFile : null;
    if (!children?.length) continue;

    for (const cls of children) {
      if (visited.has(cls)) continue;
      visited.add(cls);

      if (chaCtx.instantiatedTypes.has(cls)) {
        results.push(...resolveMethodViaAncestors(cls, childFile, methodName, chaCtx, lookup));
      }

      // Traverse even non-instantiated classes — they may have instantiated subclasses.
      queue.push({ name: cls, file: childFile });
    }
  }

  return results;
}
