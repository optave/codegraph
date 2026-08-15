/**
 * Node role classification — pure logic, no DB.
 *
 * Roles: entry, core, utility, adapter, leaf, dead-*, test-only
 *
 * Dead sub-categories refine the coarse "dead" bucket:
 *   dead-leaf       — constants (leaf nodes by definition; parameters and
 *                     genuine class/struct properties are excluded from
 *                     classification entirely rather than landing here — see below)
 *   dead-entry      — framework dispatch: CLI commands, MCP tools, event handlers
 *   dead-ffi        — cross-language FFI boundaries (e.g. Rust napi-rs bindings)
 *   dead-unresolved — genuinely unreferenced callables (the real dead code)
 *
 * `parameter`-kind nodes never reach this module in production — callers
 * (`features/structure.ts`, native `graph/classifiers/roles.rs`) exclude them
 * entirely, leaving `role` unset, the same treatment as `file`/`directory`
 * nodes. A parameter's liveness is a local dataflow question (is it referenced
 * within its own function body), not a call-graph reachability question, so
 * "no incoming call edges" carries zero dead-code signal for it (#1723).
 *
 * `property`-kind nodes that are genuine (non-interface) class/struct/object
 * fields also never reach this module in production, for the same reason and
 * with the same treatment (role left unset) — a field's liveness is a question
 * of whether it's read/written anywhere in its owning class, which codegraph
 * has no property-access/write edge tracking to answer (#1810).
 *
 * `method`/`property`-kind members of an interface/type declaration (e.g.
 * `interface Foo { bar: string }`) DO reach this module, but are recognized by
 * `isTypeDeclarationMember` and classified `leaf` unconditionally — they can
 * never gain inbound call edges by construction, so call-graph reachability
 * doesn't apply to them either (#1723).
 *
 * Every node whose file belongs to a declarative-only language (currently
 * just Terraform/HCL) is likewise classified `leaf` unconditionally, via
 * `isDeclarativeLanguageNode` — see its doc comment (#2385).
 *
 * `entry` requires `kind IN ('function', 'method')` (plus the framework-prefix/
 * Commander-dispatch shortcuts, which are already kind-appropriate by
 * construction). An exported interface/type/constant/class with zero fan-in is
 * a data-shape declaration or config value — never invoked from outside the
 * codebase — so it can't be a real entry point; it's classified `leaf` instead
 * of inheriting `entry` merely from being exported (#1780).
 *
 * Direct fan-in > 0 is not, by itself, sufficient evidence that a
 * `function`/`method` is live: a node whose only caller is itself unreachable
 * from any confirmed-live root still has fan-in 1 despite being genuinely dead
 * (#2032 — e.g. a helper called only from an object-literal-property closure
 * that is never itself invoked). When `classifyRoles` is given the full
 * graph's `calls`-edge adjacency, `applyReachabilityDowngrade` runs a
 * worklist/BFS from confirmed-live roots (framework-dispatched entries,
 * exported `function`/`method`s, Commander dispatch methods — see
 * `isLiveRoot`) and downgrades any `function`/`method` outside the reachable
 * set from its fan-shape verdict (`core`/`utility`/`adapter`/`leaf`) to a
 * `dead-*` sub-role. This is deliberately a strictly-downgrading second pass,
 * not a replacement for the direct fan-in check — see `applyReachabilityDowngrade`'s
 * doc comment for why the other branches (`test-only`, interface members,
 * `hasActiveFileSiblings` rescues, exported zero-fan-in entries) must not be
 * revisited by it.
 */

import type { DeadSubRole, Role } from '../../types.js';

export const FRAMEWORK_ENTRY_PREFIXES: readonly string[] = ['route:', 'event:', 'command:'];

// ── Dead sub-classification helpers ────────────────────────────────

const LEAF_KINDS = new Set(['parameter', 'property', 'constant']);

/**
 * Type definition kinds that are consumed via type annotations rather than calls.
 * These have no inbound call edges by design — they are "used" by type references,
 * struct literals, and generic parameters, none of which produce call edges.
 * If the same file has active callables, type definitions are almost certainly live.
 */
const TYPE_DEF_KINDS = new Set(['struct', 'enum', 'trait', 'type', 'interface', 'record']);

const FFI_EXTENSIONS = new Set(['.rs', '.c', '.cpp', '.h', '.go', '.java', '.cs']);

/**
 * Extensions of declarative-only languages that have no functions, classes,
 * or call graph by design (e.g. Terraform/HCL — everything is a
 * resource/module/data/variable/output block; nothing is ever invoked or
 * invokes anything). A `fanIn === 0` reading for these carries zero
 * dead-code signal, unlike a language where call resolution is merely not
 * implemented yet (see the resolution-benchmark's 0.0/0.0 thresholds for
 * e.g. bash/ruby/lua, which DO have real dead code a future resolver could
 * find). Emitting `dead-*` anyway invited destructive action on live
 * infrastructure (#2385).
 */
const DECLARATIVE_EXTENSIONS = new Set(['.tf', '.hcl']);

/** True when `node.file`'s extension belongs to a declarative-only language (#2385). */
function isDeclarativeLanguageNode(node: { file?: string }): boolean {
  if (!node.file) return false;
  const dotIdx = node.file.lastIndexOf('.');
  return dotIdx !== -1 && DECLARATIVE_EXTENSIONS.has(node.file.slice(dotIdx));
}

/** Path patterns indicating framework-dispatched entry points. */
const ENTRY_PATH_PATTERNS: readonly RegExp[] = [
  /cli[/\\]commands[/\\]/,
  /mcp[/\\]/,
  /routes?[/\\]/,
  /handlers?[/\\]/,
  /middleware[/\\]/,
];

/**
 * Well-known Commander.js dispatch method names.
 * When a method with one of these names lives in a file that matches
 * ENTRY_PATH_PATTERNS, it is the actual framework entry point — not merely a
 * candidate — so it must be classified as `entry` rather than `dead-entry`.
 *
 * `execute` — the action callback invoked by Commander on `program.action()`.
 * `validate` — a pre-execution argument/option validator called before `execute`.
 */
const COMMANDER_DISPATCH_NAMES = new Set(['execute', 'validate']);

export interface ClassifiableNode {
  kind?: string;
  file?: string;
}

/**
 * Minimal node shape needed to determine interface/type ownership by name —
 * a structural subset of `RoleClassificationNode` so callers holding only
 * `{ id, name, file }` rows (e.g. a raw `kind = 'property'` DB query, #1809)
 * can reuse `computeTypeDefNamesByFile`/`isTypeDeclarationMember` without
 * constructing a full classifier-input object.
 */
export interface NamedClassifiableNode {
  name: string;
  kind?: string;
  file?: string;
}

/**
 * Compute, per file, the set of symbol names that are `TYPE_DEF_KINDS`-kind
 * declarations (interface/type/struct/enum/trait/record). Used by
 * `isTypeDeclarationMember` to recognize `Owner.member`-qualified nodes whose
 * owner is a type-level declaration rather than a class.
 */
export function computeTypeDefNamesByFile(
  nodes: readonly NamedClassifiableNode[],
): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (n.file && n.kind && TYPE_DEF_KINDS.has(n.kind)) {
      let names = byFile.get(n.file);
      if (!names) {
        names = new Set();
        byFile.set(n.file, names);
      }
      names.add(n.name);
    }
  }
  return byFile;
}

/**
 * True when `node` is a `method`/`property`-kind member of an interface/type
 * declared in the same file — e.g. TS `interface Foo { bar: string }` extracts
 * `bar` as a top-level `method`-kind definition named `Foo.bar` (#1723). Every
 * language extractor qualifies interface/type members as `Owner.member`
 * (mirroring class method qualification), so the owner name is recovered from
 * the prefix before the first `.` and looked up against same-file
 * `TYPE_DEF_KINDS` declarations. Class methods use the identical `Owner.member`
 * convention but are unaffected here because `class` is not in `TYPE_DEF_KINDS`
 * — they remain subject to normal dead-code detection.
 *
 * These members can never gain inbound call edges by construction — they are
 * consumed via type annotations and structural typing, never calls — so a
 * `fanIn === 0` reading carries zero dead-code signal for them, unlike a real
 * function/method where it does. Call-edge-based reachability just doesn't
 * apply to type-level declarations, so they must never be judged dead by it.
 */
export function isTypeDeclarationMember(
  node: NamedClassifiableNode,
  typeDefNamesByFile: Map<string, Set<string>>,
): boolean {
  if (node.kind !== 'method' && node.kind !== 'property') return false;
  if (!node.file) return false;
  const dotIdx = node.name.indexOf('.');
  if (dotIdx === -1) return false;
  const ownerName = node.name.slice(0, dotIdx);
  return typeDefNamesByFile.get(node.file)?.has(ownerName) ?? false;
}

/**
 * Refine a "dead" classification into a sub-category.
 */
function classifyDeadSubRole(node: ClassifiableNode): DeadSubRole {
  // Leaf kinds are dead by definition — they can't have callers
  if (node.kind && LEAF_KINDS.has(node.kind)) return 'dead-leaf';

  if (node.file) {
    // Cross-language FFI: compiled-language files in a JS/TS project
    // Priority: dead-ffi is checked before dead-entry deliberately — an FFI
    // boundary is a more fundamental classification than a path-based hint.
    // A .so/.dll in a routes/ directory is still FFI, not an entry point.
    const dotIdx = node.file.lastIndexOf('.');
    if (dotIdx !== -1 && FFI_EXTENSIONS.has(node.file.slice(dotIdx))) return 'dead-ffi';

    // Framework-dispatched entry points (CLI commands, MCP tools, routes)
    if (ENTRY_PATH_PATTERNS.some((p) => p.test(node.file!))) return 'dead-entry';
  }

  return 'dead-unresolved';
}

// ── Helpers ────────────────────────────────────────────────────────

export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface RoleClassificationNode {
  id: string;
  name: string;
  kind: string;
  file?: string;
  fanIn: number;
  fanOut: number;
  isExported: boolean;
  testOnlyFanIn?: number;
  productionFanIn?: number;
  /**
   * True when the file also contains at least one *other* connected,
   * non-annotation-only callable. Annotation-only kinds are `constant` and all
   * members of `TYPE_DEF_KINDS` (struct, enum, trait, type, interface, record)
   * — these are excluded from the "active" side of the check because they are
   * consumed via references/type-annotations rather than call edges, and
   * including them would make the active-file heuristic circular.
   *
   * Populated for two groups, each using a different source set (see
   * `buildActiveFilesSet`/`buildClassifierInput` in `features/structure.ts`) to
   * avoid a self-sibling false positive:
   *  - `constant` and `TYPE_DEF_KINDS` nodes: true if the file has a
   *    non-annotation-only callable with `fanIn > 0 || fanOut > 0`.
   *  - `method` and `function` nodes: true only if the file has a
   *    non-annotation-only callable with `fanIn > 0` (strictly called) —
   *    using `fanOut > 0` here would let a node with `fanIn === 0, fanOut > 0`
   *    count itself as its own "active sibling" and wrongly promote itself.
   *
   * `undefined` for all other kinds (e.g. `class`), which don't use this field.
   */
  hasActiveFileSiblings?: boolean;
  /**
   * Narrower than `isExported` — true only for the explicit `export` keyword
   * (the `exported` column) and confirmed production-reachable reexport
   * chains, deliberately EXCLUDING `isExported`'s "some caller in a different
   * file" component (`exportedIds`'s base cross-file-caller heuristic in
   * `features/structure.ts`). That component is only ever a proxy for "has a
   * cross-file caller" — exactly the kind of unverified-caller evidence
   * #2032's reachability check exists to see through. Used by `isLiveRoot`
   * instead of `isExported` so a symbol called only by an unreachable
   * cross-file caller doesn't become an automatic BFS root merely because the
   * call happens to cross a file boundary. Defaults to `false` when omitted
   * (safe: callers that don't supply `callEdges` never reach `isLiveRoot`).
   */
  isPublicSurface?: boolean;
  /**
   * True when a program-entrypoint call resolves to this node — the callee is
   * started by the runtime, not by other code in the repo (#2392). Sourced
   * from the `nodes.entrypoint` column, which the build sets from an
   * extractor-flagged call site (Python's `if __name__ == "__main__":` guard
   * and `__main__.py` module level).
   *
   * Checked before the `fanIn === 0` gate, unlike the export-based `entry`
   * rule: an entrypoint invoked from its own module's guard *does* have an
   * inbound call edge (the module-level call, attributed to the file node),
   * so a zero-fan-in requirement would never fire for the very convention
   * this exists to recognize.
   */
  isEntrypoint?: boolean;
}

/**
 * Compute median fan-in and fan-out across nodes with non-zero values.
 * Used as thresholds for "high" fan-in/out classification.
 */
function computeFanMedians(nodes: RoleClassificationNode[]): { fanIn: number; fanOut: number } {
  const nonZeroFanIn = nodes
    .filter((n) => n.fanIn > 0)
    .map((n) => n.fanIn)
    .sort((a, b) => a - b);
  const nonZeroFanOut = nodes
    .filter((n) => n.fanOut > 0)
    .map((n) => n.fanOut)
    .sort((a, b) => a - b);
  return { fanIn: median(nonZeroFanIn), fanOut: median(nonZeroFanOut) };
}

/**
 * Classify a node with `fanIn === 0` that is not exported.
 * Covers framework-active constants, test-only callables, and the dead-* family.
 */
function classifyUnreferencedNode(node: RoleClassificationNode): Role {
  if (node.hasActiveFileSiblings) {
    if (node.kind === 'constant') {
      // Constants consumed via identifier reference (not calls) have no
      // inbound call edges. If the same file has active callables, the
      // constant is almost certainly used locally — classify as leaf.
      return 'leaf';
    }
    if (node.kind && TYPE_DEF_KINDS.has(node.kind)) {
      // Type definitions (struct, enum, trait, type, interface, record) are
      // consumed via type annotations and struct literals — not calls — so they
      // never get inbound call edges. If the same file has active callables,
      // these types are almost certainly live — classify as leaf.
      return 'leaf';
    }
    if (node.kind === 'method' && node.fanOut > 0) {
      // Methods implementing interfaces are dispatched via conditional property
      // access e.g. `if (v.enterFunction) v.enterFunction(...)`. Codegraph
      // resolves the call to the property accessor rather than to the concrete
      // method implementation, so the method has no inbound call edge. We
      // require `fanOut > 0` as evidence of non-triviality, mirroring the
      // function case — trivially-inert dead helper methods remain visible.
      return 'leaf';
    }
    if (node.kind === 'function' && node.fanOut > 0) {
      // Functions referenced as logical-or fallback defaults — e.g.
      // `const fn = options._fetchLatest || fetchLatestVersion` — appear as
      // value references, not call sites, so no call edge is produced. We
      // require `fanOut > 0` as evidence that the function is non-trivial
      // (i.e. it calls something), ruling out truly inert dead helpers.
      //
      // NOTE (#1771): this used to also be the only thing rescuing functions
      // referenced as object-literal property values (dispatch tables, e.g.
      // `{ resolve: someFunction }`) — and only by coincidence, for whichever
      // of those functions happened to have fanOut > 0 themselves. That
      // pattern now gets a real `calls` edge (dynamicKind 'value-ref') at
      // extraction time, so it no longer depends on this heuristic. Kept
      // here as a fallback for value-reference shapes that still produce no
      // edge at all — the logical-or default above, and others (ternary
      // defaults, array-of-functions elements, default parameter values)
      // that aren't extracted as edges yet.
      return 'leaf';
    }
  }
  if (node.testOnlyFanIn != null && node.testOnlyFanIn > 0) return 'test-only';
  return classifyDeadSubRole(node);
}

/**
 * Pick a role from fan-in/fan-out shape: core/utility/adapter/leaf.
 * Called after entry/test-only/dead cases have been ruled out.
 */
function classifyByFanShape(highIn: boolean, highOut: boolean): Role {
  if (highIn && !highOut) return 'core';
  if (highIn && highOut) return 'utility';
  if (!highIn && highOut) return 'adapter';
  return 'leaf';
}

/**
 * Apply role-classification rules to a single node.
 * Order matters — type-level members are ruled out first (they can never be
 * judged by call-graph reachability at all), then framework entries, then
 * dead/test cases, then the fan-in/fan-out shape decides among the structural
 * roles.
 */
function classifyNodeRole(
  node: RoleClassificationNode,
  medFanIn: number,
  medFanOut: number,
  typeDefNamesByFile: Map<string, Set<string>>,
): Role {
  // Declarative-only language (#2385) — never subject to call-graph dead-code
  // detection; there is no call graph for it by design.
  if (isDeclarativeLanguageNode(node)) return 'leaf';

  // Interface/type members (#1723) — never subject to call-graph dead-code
  // detection, regardless of fan-in/fan-out/export status.
  if (isTypeDeclarationMember(node, typeDefNamesByFile)) return 'leaf';

  if (FRAMEWORK_ENTRY_PREFIXES.some((p) => node.name.startsWith(p))) return 'entry';

  // A confirmed program entrypoint (#2392) — the runtime invokes it, so its
  // in-repo fan-in shape says nothing about how it is reached.
  if (node.isEntrypoint) return 'entry';

  if (node.fanIn === 0) {
    if (!node.isExported) {
      // Well-known Commander.js dispatch methods (execute, validate) in framework
      // directories are confirmed entry points, not candidates. Promote them to
      // `entry` directly so they don't appear in `--role dead` output.
      if (
        node.file &&
        COMMANDER_DISPATCH_NAMES.has(node.name) &&
        ENTRY_PATH_PATTERNS.some((p) => p.test(node.file!))
      ) {
        return 'entry';
      }
      return classifyUnreferencedNode(node);
    }
    // Exported, zero fan-in. A genuine entry point (CLI command handler, exported
    // API function called from outside the codebase, ESM loader hook, MCP tool
    // handler, etc.) is always a function or method. Every other exported kind
    // (interface/type/constant/class) is a live, intentional part of the public
    // surface — but a data shape or config value, not something invoked from
    // outside the codebase — so it's `leaf`: never `dead-*` (#1583) and never
    // `entry` (#1780), regardless of whether the file has other active siblings.
    return node.kind === 'function' || node.kind === 'method' ? 'entry' : 'leaf';
  }

  const hasProdFanIn = typeof node.productionFanIn === 'number';
  if (hasProdFanIn && node.productionFanIn === 0 && !node.isExported) return 'test-only';

  const highIn = node.fanIn >= medFanIn;
  const highOut = node.fanOut >= medFanOut && node.fanOut > 0;
  return classifyByFanShape(highIn, highOut);
}

/**
 * Roles produced by `classifyByFanShape` — the only roles that can result
 * from the `fanIn > 0` branch of `classifyNodeRole`. Used by
 * `applyReachabilityDowngrade` to recognize which verdicts are eligible for
 * reconsideration (see its doc comment).
 */
const FAN_SHAPE_ROLES: ReadonlySet<Role> = new Set(['core', 'utility', 'adapter', 'leaf']);

/**
 * True when `node` is a confirmed-live reachability root for the transitive
 * dead-code pass (#2032) — i.e. something external code can invoke directly,
 * regardless of whether it currently has any inbound `calls` edges from
 * elsewhere in the codebase:
 *
 *  - a framework-dispatched entry point (`route:`/`event:`/`command:`-prefixed name)
 *  - a `function`/`method` on the genuinely public surface (`isPublicSurface`)
 *    — part of the public API surface, callable from outside the codebase by
 *    construction
 *  - a Commander.js dispatch method (`execute`/`validate`) in a framework directory
 *
 * This mirrors the `entry`-detection rules in `classifyNodeRole`, but
 * deliberately drops their `fanIn === 0` gate: a root's liveness comes from
 * *how* it can be invoked, not from whether it happens to currently have zero
 * in-repo callers. A publicly-surfaced function that is ALSO called
 * internally is still a live root, even though `classifyNodeRole` itself
 * classifies it via fan-in shape (`core`/`utility`/etc.) rather than `entry`
 * in that case.
 *
 * Deliberately checks `isPublicSurface`, NOT the broader `isExported` that
 * `classifyNodeRole`'s own `entry` branch uses — `isExported` also considers
 * a node "exported" merely because SOME caller in a different file calls it,
 * regardless of whether that caller is itself reachable. Using that signal
 * here would let a symbol called only by an unreachable cross-file caller
 * become an automatic root, defeating #2032's fix for exactly the
 * cross-file case it's meant to catch. `isPublicSurface` is narrower: only
 * the explicit `export` keyword and confirmed production-reachable reexport
 * chains — see its doc comment on `RoleClassificationNode`.
 *
 * This only covers roots that are themselves `function`/`method` nodes
 * present in `nodes`. `applyReachabilityDowngrade` separately seeds
 * additional roots directly from `callEdges` for non-function/method call
 * SOURCES (module-top-level `constant`/`class` initializers, bare top-level
 * assignments attributed to the enclosing `file`) — see its doc comment.
 */
function isLiveRoot(
  node: RoleClassificationNode,
  typeDefNamesByFile: Map<string, Set<string>>,
): boolean {
  if (isTypeDeclarationMember(node, typeDefNamesByFile)) return false;
  if (FRAMEWORK_ENTRY_PREFIXES.some((p) => node.name.startsWith(p))) return true;
  // A program entrypoint is live by definition, so everything it calls is
  // reachable — without this, a `main()` invoked only from its module's
  // `__main__` guard would seed no BFS root and its whole call tree would be
  // eligible for the transitive dead-code downgrade (#2392).
  if (node.isEntrypoint) return true;
  if (node.kind !== 'function' && node.kind !== 'method') return false;
  if (node.isPublicSurface) return true;
  return !!(
    node.file &&
    COMMANDER_DISPATCH_NAMES.has(node.name) &&
    ENTRY_PATH_PATTERNS.some((p) => p.test(node.file!))
  );
}

/**
 * Forward BFS over `calls` edges starting from `roots`, using a single
 * array-backed queue (no `Array#shift`, which is O(n) per call) so the whole
 * traversal is O(V+E) — safe to run on graphs with tens of thousands of nodes
 * and edges (this repo's own self-build).
 */
function computeReachableIds(
  roots: Iterable<string>,
  callEdges: ReadonlyArray<readonly [string, string]>,
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const [source, target] of callEdges) {
    let outs = adjacency.get(source);
    if (!outs) {
      outs = [];
      adjacency.set(source, outs);
    }
    outs.push(target);
  }

  const visited = new Set<string>(roots);
  const queue = Array.from(visited);
  for (let head = 0; head < queue.length; head++) {
    const outs = adjacency.get(queue[head]!);
    if (!outs) continue;
    for (const next of outs) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

/**
 * Compute the set of bare (owner-prefix-stripped) member names declared by
 * ANY interface/type-level declaration across `nodes` — e.g. TS `interface
 * Visitor { enterNode?(...): ...; exitNode?(...): ...; }` contributes
 * `'enterNode'`/`'exitNode'`. Used by `isInterfaceDispatchMethodRoot` to
 * require that a candidate dispatch method's name corresponds to an actual
 * declared interface contract SOMEWHERE in the codebase, rather than merely
 * "any method with fanOut > 0 in a file that also has other active code" —
 * the latter is indistinguishable from a genuinely-dead, ordinary class
 * method that happens to call a helper (a real false-positive risk: an
 * `interface`/`type`-less duck-typed dispatch method would fail this check
 * and correctly fall back to full reachability scrutiny — a safe failure
 * mode, unlike promoting an ordinary dead method to root status).
 */
function computeInterfaceMemberBareNames(
  nodes: RoleClassificationNode[],
  typeDefNamesByFile: Map<string, Set<string>>,
): Set<string> {
  const names = new Set<string>();
  for (const node of nodes) {
    if (!isTypeDeclarationMember(node, typeDefNamesByFile)) continue;
    const dotIdx = node.name.indexOf('.');
    names.add(dotIdx === -1 ? node.name : node.name.slice(dotIdx + 1));
  }
  return names;
}

/**
 * True when `node` is a `method`-kind interface-dispatch implementation
 * rescued by `classifyUnreferencedNode`'s Pattern-2 heuristic (fanIn === 0,
 * fanOut > 0, `hasActiveFileSiblings`) AND whose bare name corresponds to an
 * actual interface/type declaration member somewhere in the codebase (e.g.
 * TS `interface Visitor { enterNode?(...): ...; }`, matched via
 * `interfaceMemberBareNames`) — e.g. `enterNode`/`exitNode` on a
 * Visitor-shaped object, invoked only via generic property-access dispatch
 * (`if (v.enterNode) v.enterNode(...)`) that codegraph cannot trace to a
 * concrete implementation. Such a method can never be the TARGET of a
 * `calls` edge by construction — the same category as a constant/file-sourced
 * value-ref edge — so it must be an unconditional root: otherwise everything
 * it calls (other helpers in the same visitor file) would be wrongly treated
 * as unreachable merely because the dispatch mechanism itself leaves no edge.
 *
 * The `interfaceMemberBareNames` requirement exists specifically because the
 * fanIn/fanOut/hasActiveFileSiblings shape ALONE is too broad: an ordinary,
 * genuinely-dead class method that happens to call a helper and share its
 * file with another called symbol satisfies that shape too. Tying the rescue
 * to an actual declared contract elsewhere in the codebase makes an
 * "ordinary unused method" false positive require a coincidental name
 * collision with some unrelated interface's member, rather than being the
 * default outcome for any such method.
 *
 * Deliberately narrower than `classifyUnreferencedNode`'s sibling rescue for
 * `function`-kind logical-or-fallback values (`kind === 'function' &&
 * fanOut > 0`) just below it in that function — that heuristic is an
 * explicitly acknowledged, imprecise last-resort fallback for value-reference
 * shapes not yet given a real edge (ternary defaults, array-of-functions
 * elements, default parameter values — see its comment), not a structural
 * certainty like interface dispatch. Promoting it to root status here would
 * silently rescue genuinely-dead intermediate functions (the exact #2032
 * pattern) merely because they happen to call something in a file that also
 * has unrelated active code.
 */
function isInterfaceDispatchMethodRoot(
  node: RoleClassificationNode,
  typeDefNamesByFile: Map<string, Set<string>>,
  interfaceMemberBareNames: Set<string>,
): boolean {
  if (
    node.kind !== 'method' ||
    node.fanIn !== 0 ||
    node.fanOut <= 0 ||
    !node.hasActiveFileSiblings ||
    isTypeDeclarationMember(node, typeDefNamesByFile)
  ) {
    return false;
  }
  const dotIdx = node.name.indexOf('.');
  const bareName = dotIdx === -1 ? node.name : node.name.slice(dotIdx + 1);
  return interfaceMemberBareNames.has(bareName);
}

/**
 * Downgrade fan-in-based "not dead" verdicts to dead when the node is not
 * transitively reachable from any confirmed-live root via `calls` edges
 * (#2032) — "has at least one inbound `calls` edge" is not sufficient
 * evidence of liveness when that edge's source is itself unreachable. A
 * function whose only caller is itself dead code is still dead, regardless of
 * its direct fan-in count.
 *
 * Roots come from three sources:
 *
 *  1. `isLiveRoot` — `function`/`method` nodes that are themselves confirmed
 *     entry points (framework dispatch, on the genuinely public surface via
 *     `isPublicSurface`, Commander dispatch). Deliberately NOT the broader
 *     `isExported`, whose cross-file-caller component would let a symbol
 *     called only by an unreachable cross-file caller become a root.
 *
 *  2. `isInterfaceDispatchMethodRoot` — `method`-kind interface-dispatch
 *     implementations whose bare name matches an actual declared
 *     interface/type member somewhere in the codebase (Visitor-pattern-style),
 *     which can never be the TARGET of a `calls` edge by construction. See its
 *     doc comment for why the name-match requirement exists and why this is
 *     deliberately NOT extended to `function`-kind rescues.
 *
 *  3. Every `calls`-edge SOURCE that is not itself a `function`/`method` node
 *     in `nodes`. Only `function`/`method` bodies have a genuine "was this
 *     invoked" question — every other kind that can source a `calls` edge
 *     represents code that runs unconditionally once its containing scope is
 *     parsed, with no separate invocation to prove:
 *       - `constant`: module-top-level `const` declarations (every extractor
 *         excludes function-scope while walking for them) whose initializer
 *         runs at module-load time — e.g. dispatch-table/handler-array object
 *         literals (`const HANDLERS = [{ resolve: someFn }]`, #1771/#1895)
 *         get a `calls` edge from the `constant` to each referenced function
 *         once the extractor has validated invocation evidence for the
 *         dispatch pattern.
 *       - `file`: bare top-level assignments with no declared LHS binding
 *         (e.g. Lua's builtin-reassignment `require = tracedFn`, #1776) are
 *         attributed to the enclosing file/module scope, since there is no
 *         narrower definition to attach them to.
 *       - `class` and other structural kinds: static field/initializer-style
 *         `calls` edges attributed to the type itself rather than a method.
 *     `file`/`directory`/`parameter`/`property` nodes are excluded from
 *     `nodes` entirely (see the module doc comment), so any edge source
 *     absent from `nodes` is — by construction — one of these always-live
 *     non-function/method sources, not a dangling reference.
 *
 * This is a strictly-downgrading second pass over the already-computed role
 * map, not a replacement of the direct fan-in check — it never reconsiders
 * roles produced by the `fanIn === 0` branch of `classifyNodeRole`
 * (`entry`/`test-only`/`leaf`/`dead-*` via `classifyUnreferencedNode`,
 * interface/type members, exported zero-fan-in entries). Those categories
 * already correctly resolve liveness through signals reachability doesn't
 * apply to (framework dispatch, the export surface, hasActiveFileSiblings
 * rescues for call patterns that produce no edge at all) and must not be
 * revisited here. It only reconsiders `function`/`method` nodes that received
 * a `core`/`utility`/`adapter`/`leaf` verdict from `classifyByFanShape` — which
 * requires `fanIn > 0` by construction — the exact case the direct fan-in
 * check gets wrong. Nodes that are themselves confirmed-live roots are never
 * downgraded (a root is always in its own reachable set).
 */
export function applyReachabilityDowngrade(
  nodes: RoleClassificationNode[],
  result: Map<string, Role>,
  callEdges: ReadonlyArray<readonly [string, string]>,
  typeDefNamesByFile: Map<string, Set<string>>,
): void {
  const kindById = new Map<string, string>();
  for (const node of nodes) kindById.set(node.id, node.kind);
  const interfaceMemberBareNames = computeInterfaceMemberBareNames(nodes, typeDefNamesByFile);

  const roots = new Set<string>();
  for (const node of nodes) {
    if (
      isLiveRoot(node, typeDefNamesByFile) ||
      isInterfaceDispatchMethodRoot(node, typeDefNamesByFile, interfaceMemberBareNames)
    ) {
      roots.add(node.id);
    }
  }
  for (const [source] of callEdges) {
    const kind = kindById.get(source);
    if (kind !== 'function' && kind !== 'method') roots.add(source);
  }
  const reachable = computeReachableIds(roots, callEdges);

  for (const node of nodes) {
    if (node.kind !== 'function' && node.kind !== 'method') continue;
    if (node.fanIn <= 0) continue;
    // isTypeDeclarationMember returns 'leaf' unconditionally, independent of
    // fanIn — an interface/type method-signature member can have fanIn > 0
    // (real call sites resolve to it by name) and still land on 'leaf', which
    // is indistinguishable from classifyByFanShape's 'leaf' by role string
    // alone. Must be excluded explicitly, or a widely-referenced interface
    // method (e.g. a native-binding surface like `NativeDatabase` in
    // `types.ts`) gets wrongly reconsidered here.
    if (isTypeDeclarationMember(node, typeDefNamesByFile)) continue;
    const role = result.get(node.id);
    if (!role || !FAN_SHAPE_ROLES.has(role)) continue;
    if (reachable.has(node.id)) continue;
    result.set(node.id, classifyDeadSubRole(node));
  }
}

/**
 * Classify nodes into architectural roles based on fan-in/fan-out metrics.
 *
 * @param callEdges - Optional `calls`-edge adjacency (`[sourceId, targetId]`
 *   pairs) spanning the FULL graph (not just `nodes`), used to run the
 *   transitive-reachability dead-code downgrade (#2032). Omit (or pass an
 *   empty array) to skip this pass entirely and preserve pre-#2032 behavior —
 *   this is intentional for callers that only have a locally-scoped subgraph
 *   available (see `classifyNodeRolesIncremental` in `features/structure.ts`
 *   for why a partial edge set cannot safely feed a global reachability
 *   check).
 */
export function classifyRoles(
  nodes: RoleClassificationNode[],
  medianOverrides?: { fanIn: number; fanOut: number },
  callEdges?: ReadonlyArray<readonly [string, string]>,
): Map<string, Role> {
  if (nodes.length === 0) return new Map();

  const { fanIn: medFanIn, fanOut: medFanOut } = medianOverrides ?? computeFanMedians(nodes);
  const typeDefNamesByFile = computeTypeDefNamesByFile(nodes);

  const result = new Map<string, Role>();
  for (const node of nodes) {
    result.set(node.id, classifyNodeRole(node, medFanIn, medFanOut, typeDefNamesByFile));
  }

  if (callEdges && callEdges.length > 0) {
    applyReachabilityDowngrade(nodes, result, callEdges, typeDefNamesByFile);
  }

  return result;
}
