# Implementation Plan: Receiver-correlated invoked-property evidence for object-literal value-refs

**Date:** 2026-08-23
**Author:** planner-agent
**Status:** Draft
**Tracking:** issue #2088 · Roadmap: no dedicated phase entry — issue-only; delivers the object-literal slice of `docs/roadmap/ROADMAP.md` §8.3's remaining unchecked item ("Full allocation-site abstraction and constraint solver"), and builds on §4.2 (Receiver Type Tracking, ✅) and BACKLOG item 73 (PROMOTED → §4.2) · ADRs relied on: `002-dynamic-call-resolution` (binding: new constraints land in the existing points-to solver, "no new subsystem"; `value-ref` `DynamicKind`; RES-2 dispatch-table expansion), `001-dual-engine-architecture` (binding: WASM/native parity)

> **Plan round 1.** No `plan-carry-forward` artifact exists on issue #2088 — `gh api repos/optave/ops-codegraph-tool/issues/2088/comments --paginate` returned zero comments carrying the `<!-- plan-carry-forward task=issue-2088 -->` sentinel, from any author, trusted or not. Everything below is derived fresh from the live source at `origin/main` @ `6221df16`.

## Overview

`codegraph roles --role dead` currently under-reports dead code inside object-literal dispatch tables. When a function is wired in as `{ resolve: neverCalled }`, the resolver keeps the synthetic `calls` edge alive if *any* `x.resolve(...)` member call exists anywhere in the build — `promise.resolve()` in an unrelated file is enough. This plan replaces that bare-property-name match with **allocation-site correlation**: each object literal gets a stable site identity, the existing Andersen points-to solver learns to propagate those sites into receiver variables, and a property is credited as live only when a receiver that provably points at *that* literal invokes *that* key.

The change lands in the resolution layer (`domain/graph/builder` + `domain/graph/resolver/points-to.ts`) and its mirrored native counterpart under `crates/codegraph-core/src/domain/graph/`. No new subsystem: the constraints are new rows in the existing 50-iteration solver, exactly as ADR-002 requires.

Crucially, the tightening is **gated on an escape check** so it can never turn today's conservative false negative into a false positive. Sites whose identity leaves what the solver models keep today's exact behavior.

## Requirements

Hard constraints this plan must satisfy.

**From `CLAUDE.md` (non-negotiables):**

| Rule | How this plan satisfies it |
|---|---|
| **Dual-engine parity** (ADR-001) | Every WU below that touches extraction or resolution has a named Rust mirror WU (WU-7, WU-8). The `SerializedExtractorOutput` seam gets its own WU (WU-3) because ADR-002 §Trade-offs/Costs.2 names it the primary parity-divergence risk. |
| **New behavioral constants in `DEFAULTS`** | One new key, `analysis.correlatedPropertyEvidence` (see [Configuration & Registry Impact](#configuration--registry-impact)). No magic numbers in modules. |
| **`LANGUAGE_REGISTRY` single source of truth** | N/A — no new language. JS/TS/TSX only; see [Configuration & Registry Impact](#configuration--registry-impact). |
| **Runtime imports in `dependencies`** | N/A — no new package. |
| **One PR = one concern** | One concern: correlating invoked-property evidence to the object literal it belongs to. Two adjacent findings discovered while planning were filed as separate issues rather than folded in — see [Out of Scope](#out-of-scope-filed-not-silently-dropped). |
| **Never document a bug as expected behavior** | The WASM and native engines must produce byte-identical evidence sets and identical `roles` output. WU-10 gates on `/parity`. Any divergence found during execution is a bug in the less-accurate engine and gets fixed, not annotated. |
| **Never silently skip verification** | [Verification Commands](#verification-commands) lists literal, unpiped commands. `cargo test`/`cargo clippy` are included because `crates/codegraph-core/` changes. |
| **Codegraph analyzing itself** | This repo declares its own dispatch tables (e.g. the `GROOVY_NODE_HANDLERS` shape named in `computedDispatchTableEvidence`'s doc comment), so `codegraph roles --role dead -T` on this repo is itself a smoke test — WU-10 records the before/after dead-symbol count. |

**From ADR-002 (binding):**

- §"Resolution in the existing points-to solver" — *"New constraints land in `src/domain/graph/resolver/points-to.ts` and the Rust `build_points_to_map` — **no new subsystem**. The 50-iteration Andersen solver is reused as-is."* WU-4/WU-8 add constraint rows and one seeding pass; the solver loop (`buildCallSiteTypeMap`) is untouched.
- §"Key Design Decisions" — the `value-ref` `DynamicKind` and its function/method/class target-kind filter stay exactly as they are. This plan changes only the *evidence* predicate that runs after that filter.
- §Trade-offs/Costs.5 (RES-2 over-approximation) — the `javascript` benchmark fixture keeps its precision-1.0 floor; new fixture cases go to `pts-javascript`.

**Soundness requirement (this plan's own hard rule):**

> The change must never cause a symbol to be classified dead that today's build classifies live, **unless** the site it belongs to is proven local-closed. Every path where the analysis is incomplete falls back to today's exact predicate.

This is what keeps the fix in the safe error direction. It is enforced structurally by the `escapes` bit (WU-2) and the tier ladder (WU-5), and tested by WU-10's regression case.

---

## Reconciling the tension with ROADMAP §8.3 (field-based, *not* field-sensitive)

The dispatch note flags a possible contradiction: §8.3's stated approach is **field-based** — *"treat all instances of `obj.field` as the same abstract location regardless of which `obj` instance"* — while this issue asks for instance-level correlation. Addressing it head-on:

**There is no contradiction, because the two phrases describe orthogonal axes.**

- *Field sensitivity* is about how **fields** are abstracted: does `a.f` and `b.f` share one location? §8.3 says yes (field-based), and this plan does **not** change that. The pts sets this plan reads and writes are still keyed by name/site, never by `(site, field)` pairs.
- *Allocation-site abstraction* is about how **objects** are abstracted: does each literal get its own identity? §8.3's own Approach block already answers yes, in the bullet immediately below the field-based one:

  > **Allocation-site abstraction:** each `new Foo()`, function literal, or arrow function creates an abstract object tagged with its source location

  and the single remaining unchecked §8.3 item is precisely *"Full allocation-site abstraction and constraint solver (fixed-point iteration over points-to constraints)"*.

So this plan **delivers a slice of §8.3's own unchecked item**, not a deviation from it. The one genuine extension is that §8.3's allocation-site bullet enumerates `new Foo()`, function literals, and arrow functions — it does not mention **object literals**. WU-9 adds that to the roadmap text so the record matches the code.

What this plan deliberately does **not** do, keeping §8.3's field-based choice intact:

- It does not make the pts lattice field-sensitive. The correlated-evidence set is a flat `Set<string>` of `site|key` strings computed *outside* the solver, from the solver's output — the solver itself never learns about fields.
- It does not add per-instance `obj.field` locations. `ObjectPropBinding` (§8.3f) stays name-keyed and untouched.

**Relationship to the other cited prior art:**

- **BACKLOG item 73 → §4.2 (Receiver Type Tracking, ✅)** gives us the `typeMap` this plan reuses for the receiver-side lookup fallback. §4.2 tracks a receiver's *nominal type* (`new Foo()` → `Foo`). That is insufficient here on its own: an anonymous `{ resolve: fn }` literal has no nominal type to match against — which is exactly why site identity, not type name, is the correlation key.
- **ADR-002 RES-2 (dispatch-table expansion)** and its noted over-approximation cost are on the *resolution* path (inventing `calls` edges). This plan is on the *evidence* path (deciding whether an already-resolved value-ref edge survives). They are independent; WU-10 verifies RES-2's `pts-javascript` fixture metrics do not move.
- **`collectObjectLiteralValueRefCall`'s existing `receiver` channel (#2260)** is the closest prior art and is explicitly **built on, not duplicated**: the `computedDispatchTableEvidence` OR-tier stays exactly as it is and remains name-keyed. This plan adds a *third*, site-keyed tier alongside it — see the tier ladder in WU-5.

---

## Folder Structure

```text
src/types.ts                                                   MODIFIED  ObjectLiteralSite type; Call.objectLiteralSite; ExtractorOutput.objectLiteralSites
src/domain/graph/builder/call-resolver.ts                      MODIFIED  collectInvokedPropertySites() alongside collectInvokedPropertyNames()
src/domain/graph/resolver/points-to.ts                         MODIFIED  site seeding + alloc/return constraints; resolveSitesViaPointsTo(); objlit@ filter
src/domain/graph/builder/stages/build-edges.ts                 MODIFIED  correlated-evidence assembly, tier ladder in resolveFallbackTargets, persistence
src/domain/graph/builder/incremental.ts                        MODIFIED  same tier ladder on the watch path; site-evidence persistence
src/extractors/javascript.ts                                   MODIFIED  emit object-literal sites, tag value-ref calls, escape post-pass
src/domain/wasm-worker-protocol.ts                             MODIFIED  SerializedExtractorOutput.objectLiteralSites
src/domain/wasm-worker-entry.ts                                MODIFIED  serialize objectLiteralSites out of the worker
src/domain/wasm-worker-pool.ts                                 MODIFIED  deserialize objectLiteralSites back into ExtractorOutput
src/db/migrations.ts                                           MODIFIED  migration v32: object_literal_sites + invoked_property_sites
src/db/repository/build-stmts.ts                               MODIFIED  purge entries for both new tables
src/domain/graph/builder/stages/detect-changes.ts              MODIFIED  add both tables to the full-wipe statement
src/infrastructure/config.ts                                   MODIFIED  DEFAULTS.analysis.correlatedPropertyEvidence

crates/codegraph-core/src/types.rs                             MODIFIED  ObjectLiteralSite mirror; Call.object_literal_site
crates/codegraph-core/src/extractors/javascript.rs             MODIFIED  mirror of the extractor changes
crates/codegraph-core/src/domain/graph/builder/stages/build_edges.rs
                                                               MODIFIED  mirror of solver seeding, evidence assembly, tier ladder
crates/codegraph-core/src/domain/graph/builder/stages/import_edges.rs
                                                               MODIFIED  persist_invoked_property_sites alongside persist_invoked_property_names
crates/codegraph-core/src/db/connection.rs                     MODIFIED  mirror the v32 CREATE TABLE statements
src/domain/graph/builder/stages/native-orchestrator.ts         MODIFIED  thread objectLiteralSites through the NAPI FileEdgeInput payload

tests/integration/issue-2088-correlated-property-evidence.test.ts   NEW   the four canonical shapes; both engines
tests/integration/issue-2088-escape-fallback.test.ts               NEW   escaping sites keep today's exact behavior (the soundness regression gate)
tests/parsers/javascript.test.ts                                   MODIFIED  site emission + escape-bit unit assertions
tests/benchmarks/resolution/fixtures/pts-javascript/objlit-site.js  NEW   handler-array + alias + param-flow correlation fixture
tests/benchmarks/resolution/fixtures/pts-javascript/expected-edges.json  MODIFIED  expected edges for the new fixture file

docs/roadmap/ROADMAP.md                                        MODIFIED  §8.3 progress sub-bullet; object literals added to the allocation-site bullet
README.md                                                      MODIFIED  dead-code limitation wording
```

## Dual-Engine Impact

**Both engines.** This is a resolution-layer change and every piece of it has a mirrored native counterpart.

| TypeScript | Mirrored native module | What changes |
|---|---|---|
| `src/extractors/javascript.ts` — `collectObjectLiteralValueRefCall`, shorthand collector, new `computeObjectLiteralSiteEscapes` post-pass | `crates/codegraph-core/src/extractors/javascript.rs` — `handle_object_literal_pair_value_ref` (line 4456), `handle_object_literal_shorthand_value_ref` (line 4493), new `compute_object_literal_site_escapes` | Emit `objectLiteralSites`; set `Call.objectLiteralSite` on both value-ref sites |
| `src/domain/graph/resolver/points-to.ts` — `buildPointsToMap`, `resolveViaPointsTo` | `crates/codegraph-core/src/domain/graph/builder/stages/build_edges.rs` — `build_points_to_map` (line 952). **Note: the native tree has no `domain/graph/resolver/` directory** — the Rust solver lives inside `build_edges.rs`, which is the pre-existing mirror layout for this subsystem. Per invariant 7 a *new* Rust module would go at its TS counterpart's path; this is not a new module, so it stays where the existing solver is. | Seed `objlit@…` abstract targets; add alloc/return/call-assignment constraint rows; filter site tokens out of the name-resolution read path |
| `src/domain/graph/builder/call-resolver.ts` — `collectInvokedPropertyNames` (line 91) | `build_edges.rs` — `collect_invoked_property_names` (line 861) | New sibling `collectInvokedPropertySites` / `collect_invoked_property_sites` |
| `src/domain/graph/builder/stages/build-edges.ts` — `resolveFallbackTargets` (line 1692), `persistInvokedPropertyNames` (line 1272) | `build_edges.rs` (tier ladder ~line 1674) + `stages/import_edges.rs` (`persist_invoked_property_names`) | Tier ladder gains the correlated tier; new persistence pass |
| `src/domain/graph/builder/stages/build-edges.ts` — `NativeFileEntry` (line 118), `buildNativeFileEntry` (line 879) | `build_edges.rs` — `FileEdgeInput` (line 115), `build_call_edges` (line 1264) | New `objectLiteralSites` / `object_literal_sites` field threaded across the per-file NAPI payload, mirroring the existing `computedDispatchTableEvidence` field (lines 143 / 158) verbatim — the boundary `buildCallEdgesNative` crosses whenever it runs (WU-8) |
| `src/db/migrations.ts` v32 | `crates/codegraph-core/src/db/connection.rs` (line ~497 declares the `invoked_property_names` DDL) | Both must declare the two new tables identically |

**Serialization seam (ADR-002 §Costs.2 — the named parity risk).** `Call` is passed whole through `SerializedExtractorOutput` (`wasm-worker-protocol.ts:51` is `calls: Call[]`), so the new `Call.objectLiteralSite` field rides along on structured clone with no protocol edit. The new **top-level** `ExtractorOutput.objectLiteralSites` does **not** — top-level extras are threaded explicitly, exactly as `computedDispatchTableEvidence` is at `wasm-worker-protocol.ts:84`, `wasm-worker-entry.ts:758`, and `wasm-worker-pool.ts:130`. WU-3 owns those three edits and is a required checklist item; a field missed here is silently dropped at the Worker boundary and shows up only as a WASM-vs-native divergence.

**Native NAPI seam — a second, distinct boundary from the WASM-worker seam above.** `buildCallEdgesNative` (`build-edges.ts:924`) builds one `NativeFileEntry` per file and calls `native.buildCallEdges(...)` (`build-edges.ts:961`), which napi-rs deserializes into `Vec<FileEdgeInput>` (`build_edges.rs:1264-1265`). `Call.objectLiteralSite` rides through automatically here too (`calls: symbols.calls`, `build-edges.ts:901`, whole-object, same reasoning as above). The new, top-level `ExtractorOutput.objectLiteralSites` does not — it needs the same explicit threading `computedDispatchTableEvidence` already has on both sides of this boundary (`NativeFileEntry.computedDispatchTableEvidence` at `build-edges.ts:143`; `FileEdgeInput.computed_dispatch_table_evidence` at `build_edges.rs:158`). WU-8 owns this pairing. This is a **different file** from the WASM-worker protocol (WU-3) and from `native-orchestrator.ts`, which has no role in either boundary — see WU-8's implementation note for why, and for how this plan's own verification forces the path open.

**Build ordering.** `npm run build` is **required before any WASM-path check**: the WASM engine parses in workers that load compiled `dist/`, so `src/`-only edits are invisible to it. Any parity run that skips the build compares new native code against stale WASM code and reports a false divergence.

## Configuration & Registry Impact

**New `DEFAULTS` entry — one key**, in `src/infrastructure/config.ts`, group `analysis`:

```ts
analysis: {
  // …existing keys…
  /**
   * Enables allocation-site-correlated invoked-property evidence (#2088) for
   * object-literal value-refs. When false, the resolver uses only the
   * bare-property-name evidence set (pre-#2088 behavior) — an escape hatch if
   * a downstream consumer needs the older, looser liveness semantics.
   * Threaded to the WASM solver via `buildCallEdgesJS` (which already holds a
   * resolved `ctx.config`) and to the native engine through the same
   * `BuildConfig` JSON payload that already carries `pointsToMaxIterations`.
   */
  correlatedPropertyEvidence: true,
},
```

No other constant is introduced. The site-id format, the `objlit@` pts-key prefix, and the escape-position sets are structural encodings, not tunable thresholds — they are Category F (standard formulas / safety boundaries) and live as named `const`s beside the code that reads them, mirrored across engines.

**`LANGUAGE_REGISTRY` / AST maps / native `LangAstConfig`:** **None.** No language is added. The `value-ref` `DynamicKind` this plan operates on is emitted only by the JS/TS/TSX extractor (`collectObjectLiteralValueRefCall`) and by Lua's builtin-reassignment site — and the Lua site never sets `keyExpr`, so it is unaffected by the evidence predicate (see the guard in `resolveFallbackTargets`, which only runs when `call.keyExpr` is set).

**DB schema:** migration **v32** (current latest is v31, `src/db/migrations.ts:600`). Two tables, both mirrored in `crates/codegraph-core/src/db/connection.rs`, both purged per-file in `src/db/repository/build-stmts.ts` and wiped in `detect-changes.ts`'s full-reset statement.

## Interface Definitions

This plan **ships the full implementation**; it does not land a signatures-only stub. The reason is that no downstream task is blocked on this shape — #2088 is a leaf improvement to one predicate, and the seams below are internal to the builder, not public API. Freezing an interface for parallel work would add a merge seam with nothing on the other side of it.

The seams, stated in full so a builder agent does not have to re-derive them:

```ts
// ── src/types.ts ────────────────────────────────────────────────────────────

/**
 * One object-literal allocation site (#2088). Emitted by the JS/TS extractor
 * for every object literal that produces at least one `value-ref` Call.
 *
 * Extends ROADMAP §8.3's allocation-site abstraction (which enumerated
 * `new Foo()`, function literals, and arrow functions) to object literals.
 */
export interface ObjectLiteralSite {
  /**
   * File-LOCAL site id: `${startLine}:${startColumn}` of the object-literal
   * node. Deliberately not file-qualified — extraction does not reliably know
   * its own repo-relative path, so the consumer qualifies it via
   * `objectLiteralSiteKey()`, mirroring how `computedDispatchTableEvidence`
   * is emitted bare and keyed with the file at the consumer.
   */
  site: string;
  /**
   * The binding this literal flows into directly, or null when it has none
   * (e.g. passed inline as a call argument):
   *   - `"HANDLERS"`            — `const HANDLERS = { … }`
   *   - `"makeTable::return"`   — `return { … }` inside `makeTable`
   *   - `"RESOLVERS[*]"`        — an element of `const RESOLVERS = [ { … } ]`,
   *                               reusing the existing array-element pts key
   *                               shape already produced by
   *                               `buildArrayElemConstraints`
   */
  owner: string | null;
  /**
   * True when this site's identity can leave the set of flows the points-to
   * solver models, so correlated evidence for it is necessarily incomplete.
   * The resolver falls back to the pre-#2088 bare-name predicate for
   * escaping sites, which is what keeps this change in the conservative
   * error direction. Defaults to `true` on any shape the analysis does not
   * recognise — fail-safe, never fail-open.
   */
  escapes: boolean;
}

/** Added to `interface Call`. */
export interface Call {
  // …existing fields…
  /**
   * File-local id (`ObjectLiteralSite.site`) of the object literal that owns
   * this `dynamicKind: 'value-ref'` property reference (#2088). Set only by
   * the object-literal pair/shorthand collectors — the `instanceof` (#1784)
   * and Lua builtin-reassignment (#1776) value-ref sites leave it undefined,
   * matching how they already leave `keyExpr` undefined.
   */
  objectLiteralSite?: string;
}

/** Added to `interface ExtractorOutput`. */
export interface ExtractorOutput {
  // …existing fields…
  /** #2088 — object-literal allocation sites declared in this file. */
  objectLiteralSites?: ObjectLiteralSite[];
}

// ── src/domain/graph/builder/call-resolver.ts ───────────────────────────────

/**
 * Sibling of `collectInvokedPropertyNames` (#2088): collect
 * `${siteKey}|${propertyName}` pairs for every member call `x.name(...)`
 * whose receiver `x` provably points at a known object-literal site.
 *
 * `resolveReceiverSites` is supplied by the caller and wraps the points-to
 * lookup, so this function stays engine-agnostic and testable in isolation —
 * the same adapter pattern `CallNodeLookup` already uses in this module.
 */
export function collectInvokedPropertySites(
  callsList: Iterable<Iterable<{ name: string; receiver?: string; dynamicKind?: string | null }>>,
  resolveReceiverSites: (receiver: string, callerName: string | null) => ReadonlyArray<string>,
  callerNameOf: (call: { name: string; receiver?: string }) => string | null,
): Set<string>;

// ── src/domain/graph/resolver/points-to.ts ──────────────────────────────────

/**
 * Prefix marking a points-to target as an object-literal ALLOCATION SITE
 * rather than a resolvable symbol name (#2088). `@` cannot appear in a JS
 * identifier, so this can never collide with a real name — the same
 * "synthetic token that can't match a real symbol" device ADR-002 uses for
 * `<dynamic:…>` names.
 */
export const OBJLIT_PTS_PREFIX = 'objlit@';

/** Build the qualified pts target token for a file-local site id. */
export function objectLiteralSiteKey(relPath: string, site: string): string;

/** Key for one unit of correlated evidence: "this site's `key` was invoked". */
export function correlatedEvidenceKey(siteKey: string, propertyName: string): string;

/**
 * Return the object-literal SITE KEYS that `varName` may point to — the
 * site-namespace counterpart of `resolveViaPointsTo`, which returns resolvable
 * symbol names and now filters `OBJLIT_PTS_PREFIX` tokens out.
 */
export function resolveSitesViaPointsTo(varName: string, pts: PointsToMap): string[];
```

## Dependency Graph

```text
WU-1 (types + key helpers)
  │
  ├── WU-2 (TS extractor: sites + escapes) ──┐
  │        │                                 │
  │        └── WU-3 (worker protocol) ───────┤
  │                                          │
  ├── WU-4 (pts solver: site constraints) ───┤
  │                                          │
  └── WU-9a (DEFAULTS key) ──────────────────┤
                                             │
                          WU-5 (build-edges: evidence + tier ladder + migration v32)
                                             │
                          ┌──────────────────┴──────────────────┐
                          │                                     │
                    WU-6 (incremental path)          WU-7 (Rust extractor mirror)
                          │                                     │
                          │                          WU-8 (Rust solver + edges + NAPI)
                          │                                     │
                          └──────────────┬──────────────────────┘
                                         │
                          WU-10 (tests + parity + benchmark)  ← sync point
                                         │
                          WU-9b (docs: ROADMAP §8.3, README)
```

WU-2/WU-4 are parallel after WU-1. WU-6 and WU-7→WU-8 are parallel after WU-5. WU-10 is the sync point and must not start before both engines are complete, because half of what it asserts is that they agree.

## Work Units

### WU-1: `types and key helpers`

- **Layer:** shared (`src/types.ts`) + domain (`points-to.ts` helper exports)
- **Blocked by:** none
- **Blocks:** WU-2, WU-3, WU-4, WU-5
- **Files:** `src/types.ts`, `src/domain/graph/resolver/points-to.ts` (helper exports only)
- **Input contract:** none — pure declarations
- **Output contract:** `ObjectLiteralSite`, `Call.objectLiteralSite`, `ExtractorOutput.objectLiteralSites`, `OBJLIT_PTS_PREFIX`, `objectLiteralSiteKey`, `correlatedEvidenceKey`, `resolveSitesViaPointsTo` (signature only at this stage)
- **Verification:** `npx tsc --noEmit`
- **Risk:** Low — additive optional fields only; no existing shape changes.

#### Implementation

The full type declarations are given verbatim in [Interface Definitions](#interface-definitions). The two key helpers:

```ts
// src/domain/graph/resolver/points-to.ts

export const OBJLIT_PTS_PREFIX = 'objlit@';

/**
 * `objlit@${relPath}#${site}` — file-qualified so two files that each declare
 * an object literal at the same line:col can never share evidence. Mirrors
 * `computedDispatchTableEvidenceKey`'s `${file}::${name}` convention and the
 * `callee::restName` scoping convention (#1358), for the same reason.
 */
export function objectLiteralSiteKey(relPath: string, site: string): string {
  return `${OBJLIT_PTS_PREFIX}${relPath}#${site}`;
}

/** `${siteKey}|${propertyName}` — `|` cannot appear in an identifier or a path segment id. */
export function correlatedEvidenceKey(siteKey: string, propertyName: string): string {
  return `${siteKey}|${propertyName}`;
}
```

> **Why:** file-qualifying at the consumer rather than at extraction keeps the extractor path-agnostic, which is what the existing `computedDispatchTableEvidence` channel already does — and it is what lets the same extractor output be reused unchanged by the incremental path, which knows its own `relPath` but re-parses only one file.

---

### WU-2: `JS/TS extractor — emit object-literal sites and the escape bit`

- **Layer:** domain (extractors)
- **Blocked by:** WU-1
- **Blocks:** WU-3, WU-5, WU-7 (its mirror)
- **Files:** `src/extractors/javascript.ts`
- **Input contract:** tree-sitter AST for one JS/TS/TSX file; the file's own `definitions` and `exports` (already collected before the post-pass runs)
- **Output contract:** `ExtractorOutput.objectLiteralSites`; `Call.objectLiteralSite` set on object-literal pair and shorthand value-refs
- **Verification:** `npx vitest run tests/parsers/javascript.test.ts`
- **Risk:** Medium — the escape analysis is the correctness-critical piece. Mitigated by defaulting `escapes: true` on every unrecognised shape.

#### Implementation

Two changes at the collection sites, then one post-pass.

**(a) Tag the value-ref calls with their owning site.** The object-literal node is the `pair`/shorthand node's parent (or grandparent for shorthand):

```ts
/**
 * File-local allocation-site id for an object-literal node: `${line}:${col}`.
 * Line and column are 0-based tree-sitter coordinates, so this is stable
 * across re-parses of identical source and unique within a file (no two
 * nodes share a start position at the same depth).
 */
function objectLiteralSiteId(objectNode: TreeSitterNode): string {
  return `${objectNode.startPosition.row}:${objectNode.startPosition.column}`;
}

/** Nearest enclosing `object` node, or undefined for a non-literal context. */
function enclosingObjectLiteral(node: TreeSitterNode): TreeSitterNode | undefined {
  const parent = node.parent;
  return parent?.type === 'object' ? parent : undefined;
}
```

`collectObjectLiteralValueRefCall` gains one field (everything else unchanged):

```ts
function collectObjectLiteralValueRefCall(
  pairNode: TreeSitterNode,
  calls: Call[],
  sites: Map<string, ObjectLiteralSite>,
): void {
  const valueNode = pairNode.childForFieldName('value');
  if (valueNode?.type !== 'identifier' || BUILTIN_GLOBALS.has(valueNode.text)) return;
  const keyNode = pairNode.childForFieldName('key');
  const keyExpr = keyNode ? resolveObjectLiteralKeyName(keyNode) || undefined : undefined;

  const objectNode = enclosingObjectLiteral(pairNode);
  const site = objectNode ? objectLiteralSiteId(objectNode) : undefined;
  if (objectNode && site && !sites.has(site)) {
    // Owner and escapes are filled in by the post-pass below; seeded
    // fail-safe so a site that the post-pass never reaches still falls back
    // to the pre-#2088 predicate rather than being trusted.
    sites.set(site, { site, owner: null, escapes: true });
  }

  calls.push({
    name: valueNode.text,
    line: nodeStartLine(valueNode),
    dynamic: true,
    dynamicKind: 'value-ref',
    keyExpr,
    receiver: findEnclosingTableName(pairNode),
    objectLiteralSite: site,
  });
}
```

The shorthand collector (`shorthand_property_identifier` in `runCollectorWalk`) gets the identical two additions.

**(b) The escape post-pass.** Runs once per file, after `definitions`, `exports`, and `calls` are collected — it needs all three.

```ts
/**
 * Positions in which a reference to a site-owning binding is still tracked by
 * the points-to solver. Anything else marks the site as escaping.
 *
 *   member_expression    `T.k(…)`  — the correlated-evidence channel itself
 *   subscript_expression `T[k](…)` — whole-table evidence via #2260's channel
 *   for_in_statement     `for (const r of T)` — modelled by forOfBindings
 */
const TRACKED_REFERENCE_PARENTS: ReadonlySet<string> = new Set([
  'member_expression',
  'subscript_expression',
  'for_in_statement',
]);

/**
 * Decide, per object-literal site, whether correlated evidence for it can be
 * complete (`escapes: false`) or is necessarily partial (`escapes: true`).
 *
 * A site is NON-escaping only when all of the following hold:
 *   1. It has a recognised BINDING owner — `const X = { … }`, or an element
 *      of a declared array literal. A direct `return { … }` from a named
 *      function is also a recognised owner (WU-4 still seeds `pts(f::return)
 *      ⊇ pts(siteKey)` from it) but never satisfies this bullet: the binding
 *      that actually captures the return value (`const X = f()`) is a
 *      call-assignment this per-file pass cannot see, so it always escapes
 *      regardless of whether `f` itself is exported.
 *   2. That owner is not exported from this file. An exported binding can be
 *      read from a file this pass may not be looking at, and cross-module SITE
 *      propagation does not exist yet (only cross-module NAME propagation via
 *      `importedNames`) — so its evidence is necessarily partial.
 *   3. Every other in-file reference to the owner appears in a position the
 *      solver models (TRACKED_REFERENCE_PARENTS); is the `value` field of a
 *      `variable_declarator` whose own `name` field is a plain `identifier`
 *      — a rebinding, `const u = T`, the alias shape `fnRefBindings` already
 *      propagates, while a destructuring `name` such as `const { k } = T` is
 *      rejected the same way `findEnclosingTableName`
 *      (`src/extractors/javascript.ts:4519`) already rejects it for the
 *      identical distinction, since destructuring extracts a property rather
 *      than aliasing the reference and `fnRefBindings` does not model it
 *      (round-3 critic finding: without this guard, the alias case in
 *      WU-10's correlation test never actually exercises T1 — it stays
 *      escaping and falls through to T2's bare-name match, which reports the
 *      same "live" outcome for the wrong reason); or is a bare-identifier
 *      argument to a LOCALLY-DEFINED, NON-EXPORTED function — the shape
 *      `paramBindings` (Phase 8.3c) already propagates.
 *
 * Fail-safe: anything unrecognised leaves the seeded `escapes: true`. Getting
 * this wrong in the `true` direction costs recall (today's behavior); getting
 * it wrong in the `false` direction would cost soundness. The asymmetry is
 * deliberate.
 */
function computeObjectLiteralSiteEscapes(
  sites: Map<string, ObjectLiteralSite>,
  root: TreeSitterNode,
  exportedNames: ReadonlySet<string>,
  localNonExportedFns: ReadonlySet<string>,
): void {
  for (const entry of sites.values()) {
    const objectNode = findNodeAtSite(root, entry.site);
    if (!objectNode) continue;                       // stays escapes: true

    const owner = resolveSiteOwner(objectNode);      // → { key, bindingName } | null
    if (!owner) continue;                            // inline argument, etc.
    entry.owner = owner.key;

    if (owner.bindingName === null) {                // `return { … }` — no binding to scan.
      // Always escapes (round-2 critic finding): the call-assignment that
      // captures this return value (`const X = f()`) can land in ANY
      // binding, exported or not, and buildObjectLiteralSiteConstraints
      // (WU-4) flows the site into it with no escape check of its own — see
      // condition 1 above. `entry.owner` is already set just above, so
      // WU-4's seeding is unaffected; only the escape bit changes, from
      // checking the wrong binding's export status to never being provably
      // non-escaping.
      entry.escapes = true;
      continue;
    }
    if (exportedNames.has(owner.bindingName)) continue;

    entry.escapes = !allReferencesTracked(
      root, owner.bindingName, objectNode, localNonExportedFns,
    );
  }
}
```

`resolveSiteOwner` reuses the existing walk shape of `findEnclosingTableName` (variable-declarator lookup through `TABLE_NAME_PASSTHROUGH_TYPES`), extended with two extra cases — `array` parent → `` `${arrayVarName}[*]` `` (the pts key `buildArrayElemConstraints` already produces), and `return_statement` parent → `` `${enclosingFnName}::return` ``.

`allReferencesTracked` walks the file for identifier nodes whose text equals `bindingName`, skipping the declaration itself and any node under a scope that shadows the name — reusing `introducesShadowedBinding`, the hardened shadow detection already written for #2257 and already used by `findDeclaringScopeLine`. Every surviving reference must have a parent in `TRACKED_REFERENCE_PARENTS`; be the `value` field of a `variable_declarator` whose own `name` field is a plain `identifier` (a rebinding — `const u = T` — rejecting a destructuring `name` the same way `findEnclosingTableName` already does, since destructuring extracts a property rather than aliasing the reference); or be an `arguments`-position identifier whose callee is in `localNonExportedFns`.

> **Why walk for references rather than reuse `blockContainsIdentifierExcluding`:** that helper answers "does this block contain a reference at all", which is the wrong question here — we need to classify *every* reference's position, not detect the first one. The shadow-detection primitive is shared; the traversal is not.

---

### WU-3: `worker-protocol threading for objectLiteralSites`

- **Layer:** domain (WASM worker seam)
- **Blocked by:** WU-2
- **Blocks:** WU-5
- **Files:** `src/domain/wasm-worker-protocol.ts`, `src/domain/wasm-worker-entry.ts`, `src/domain/wasm-worker-pool.ts`
- **Input contract:** `ExtractorOutput.objectLiteralSites` produced inside the worker
- **Output contract:** the same array present on the `ExtractorOutput` the pool hands back to the pipeline
- **Verification:** `npm run build` then `npx vitest run tests/engines/query-walk-parity.test.ts`
- **Risk:** Medium — silent data loss if missed. This WU exists as its own unit precisely because ADR-002 §Costs.2 names this seam the primary parity-divergence risk.

#### Implementation

Three edits, each mirroring the `computedDispatchTableEvidence` precedent already in the same files.

```ts
// src/domain/wasm-worker-protocol.ts — beside line 84's computedDispatchTableEvidence
export interface SerializedExtractorOutput {
  // …
  /** Issue #2088 — see ExtractorOutput.objectLiteralSites. */
  objectLiteralSites?: readonly import('../types.js').ObjectLiteralSite[];
}
```

```ts
// src/domain/wasm-worker-entry.ts — beside line 758
    ...(symbols.objectLiteralSites?.length
      ? { objectLiteralSites: symbols.objectLiteralSites }
      : {}),
```

```ts
// src/domain/wasm-worker-pool.ts — beside line 130
  if (ser.objectLiteralSites?.length) out.objectLiteralSites = [...ser.objectLiteralSites];
```

> **Why no protocol edit for `Call.objectLiteralSite`:** `SerializedExtractorOutput.calls` is typed `Call[]` (`wasm-worker-protocol.ts:51`) and passed whole through structured clone, so new `Call` fields cross the boundary automatically. Only top-level `ExtractorOutput` extras need explicit threading. Verified by reading the protocol file, not assumed — a `keyExpr` grep across all three worker files returns nothing, confirming that existing `Call` field also rides the whole-object path.

---

### WU-4: `points-to solver — object-literal allocation sites`

- **Layer:** domain (`resolver/points-to.ts`)
- **Blocked by:** WU-1
- **Blocks:** WU-5, WU-8 (its mirror)
- **Files:** `src/domain/graph/resolver/points-to.ts`
- **Input contract:** `ExtractorOutput.objectLiteralSites`, existing `callAssignments`, plus every binding array the solver already consumes
- **Output contract:** a `PointsToMap` in which variable keys may additionally hold `objlit@…` site tokens; `resolveSitesViaPointsTo`; `resolveViaPointsTo` filtered to exclude site tokens
- **Verification:** `npx vitest run tests/integration/issue-2088-correlated-property-evidence.test.ts`
- **Risk:** Medium — the solver is shared by every dynamic-call resolution path. Mitigated by the namespace prefix + the filter on the name-resolution read path, so no existing consumer can observe a site token.

#### Implementation

Seeding and constraints — one new builder function appended to the existing `appendAdvancedConstraints` chain. The solver loop `buildCallSiteTypeMap` is **not** touched, per ADR-002.

```ts
/**
 * #2088 — object-literal allocation-site constraints. Delivers the
 * object-literal slice of ROADMAP §8.3's unchecked "full allocation-site
 * abstraction" item.
 *
 * Seeds `pts(siteKey) = { siteKey }` for each site, then flows it into the
 * binding it was declared against:
 *
 *   const T = { … }            → pts(T)              ⊇ pts(siteKey)
 *   const A = [{ … }]          → pts(A[*])           ⊇ pts(siteKey)
 *   function f() { return {…} }→ pts(f::return)      ⊇ pts(siteKey)
 *   const t = f()              → pts(t)              ⊇ pts(f::return)
 *
 * Only the last rule is new information the solver did not already have a
 * shape for: it is derived from the existing `callAssignments` array (added
 * for cross-file return-type propagation, #2138), reused here rather than
 * given a new extractor channel.
 *
 * Everything downstream of these four — aliasing (`const u = t`, via
 * fnRefBindings), for-of over an array of literals (via forOfBindings ⊇
 * `A[*]`), and parameter flow (`f(T)`, via paramBindings) — comes for free
 * from constraints that already exist. That is the whole reason this lands
 * in the existing solver instead of a bespoke matcher.
 */
function buildObjectLiteralSiteConstraints(
  pts: PointsToMap,
  constraints: Array<{ lhs: string; rhsKey: string }>,
  relPath: string,
  objectLiteralSites?: readonly ObjectLiteralSite[],
  callAssignments?: readonly CallAssignment[],
): void {
  if (!objectLiteralSites?.length) return;

  for (const { site, owner } of objectLiteralSites) {
    const siteKey = objectLiteralSiteKey(relPath, site);
    pts.set(siteKey, new Set([siteKey]));
    if (owner) constraints.push({ lhs: owner, rhsKey: siteKey });
  }

  // `const t = f()` → pts(t) ⊇ pts(f::return). Guarded on a `f::return` key
  // actually existing so this adds no constraint rows for the overwhelming
  // majority of call assignments, whose callee returns no object literal.
  for (const { varName, calleeName } of callAssignments ?? []) {
    const returnKey = `${calleeName}::return`;
    if (pts.has(returnKey) || constraints.some((c) => c.lhs === returnKey)) {
      constraints.push({ lhs: varName, rhsKey: returnKey });
    }
  }
}
```

The read side — one guard added, one function added:

```ts
export function resolveViaPointsTo(callName: string, pts: PointsToMap): string[] {
  const targets = pts.get(callName);
  if (!targets) return [];
  // #2088: object-literal SITE tokens share the pts map with resolvable symbol
  // names but are not names — they can never match a symbol, and letting them
  // through would hand `resolveCallTargets` a token it would fruitlessly look
  // up. Same "synthetic token filtered at the read site" device ADR-002 uses
  // for `<dynamic:…>` names.
  return [...targets].filter((t) => t !== callName && !t.startsWith(OBJLIT_PTS_PREFIX));
}

/** Site-namespace counterpart of `resolveViaPointsTo` (#2088). */
export function resolveSitesViaPointsTo(varName: string, pts: PointsToMap): string[] {
  const targets = pts.get(varName);
  if (!targets) return [];
  return [...targets].filter((t) => t.startsWith(OBJLIT_PTS_PREFIX));
}
```

`buildPointsToMap` gains two optional trailing parameters (`relPath`, `objectLiteralSites`, `callAssignments`) placed **before** `maxIterations` would break every existing caller, so they are threaded through `buildPointsToMapForFile` instead — which already receives the whole `ExtractorOutput` and is the entry point both `build-edges.ts` and `incremental.ts` use.

> **Why reuse `callAssignments` rather than add a `returnsObjectLiteral` extractor channel:** it already carries exactly `{ varName, calleeName }` (`src/types.ts:803`), is already extracted for both engines, and is already threaded through the worker protocol. A new channel would be a third thing to keep in parity for zero extra information.

---

### WU-5: `build-edges — correlated evidence, tier ladder, migration v32`

- **Layer:** domain (`builder/stages`) + db
- **Blocked by:** WU-2, WU-3, WU-4, WU-9a
- **Blocks:** WU-6, WU-8, WU-10
- **Files:** `src/domain/graph/builder/call-resolver.ts`, `src/domain/graph/builder/stages/build-edges.ts`, `src/db/migrations.ts`, `src/db/repository/build-stmts.ts`, `src/domain/graph/builder/stages/detect-changes.ts`
- **Input contract:** `ctx.fileSymbols` (with `objectLiteralSites`), the per-file pts maps, the two new persisted tables
- **Output contract:** value-ref `calls` edges that survive only on correlated (or fallback, or computed) evidence
- **Verification:** `npx vitest run tests/integration/issue-2088-correlated-property-evidence.test.ts tests/integration/issue-2088-escape-fallback.test.ts tests/integration/issue-1895-value-ref-invocation-check.test.ts tests/integration/issue-2260-computed-dispatch-table-evidence.test.ts`
- **Risk:** High — this is where behavior actually changes. Mitigated by the tier ladder's structure (below), which makes "escaping site ⇒ byte-identical to today" a property of the control flow rather than of a test.

#### Implementation

**(a) `collectInvokedPropertySites` in `call-resolver.ts`,** the receiver-correlated sibling of `collectInvokedPropertyNames`. Note that `collectInvokedPropertyNames` itself is **left exactly as it is** — it remains the fallback tier, and changing it would change behavior for escaping sites:

```ts
/**
 * #2088 — the receiver-CORRELATED counterpart of
 * `collectInvokedPropertyNames`. For every member call `x.name(...)`, resolve
 * `x` through the points-to map to the object-literal allocation sites it may
 * refer to, and record `${siteKey}|${name}` for each.
 *
 * Where `collectInvokedPropertyNames` answers "was this property name ever
 * invoked ANYWHERE", this answers "was this property invoked on THIS literal" —
 * the correlation the #2034 review asked for and that #1895's coarse
 * "one hop further" heuristic deliberately left out.
 *
 * Value-ref calls are excluded for the same reason they are excluded there: a
 * value-ref is a bare VALUE reference, never an invocation.
 */
export function collectInvokedPropertySites(
  callsList: Iterable<Iterable<CallWithCaller>>,
  resolveReceiverSites: (receiver: string, callerName: string | null) => ReadonlyArray<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const calls of callsList) {
    for (const call of calls) {
      if (!call.receiver || call.dynamicKind === 'value-ref') continue;
      for (const siteKey of resolveReceiverSites(call.receiver, call.callerName ?? null)) {
        keys.add(correlatedEvidenceKey(siteKey, call.name));
      }
    }
  }
  return keys;
}
```

The `resolveReceiverSites` adapter passed in by `buildCallEdgesJS` tries the scoped pts key first, then the bare one. This is the same caller-scoped-then-bare shape `resolveReceiverEdge` already uses against `typeMap`, in this same file (`call-resolver.ts:773-775`) — a shape `build-edges.ts:2123`'s CHA-expansion block explicitly mirrors by name for the identical reason ("mirroring resolveReceiverEdge/resolveReceiverTypeName"). The `ptsMap`-specific sibling of the same idea is the `scopedPtsKey`-then-fallback lookup in `emitPtsNoReceiverEdges` (`build-edges.ts:1965`), mirrored on the incremental path by `emitIncrementalPtsNoReceiverEdges` (`incremental.ts:1350`):

```ts
const resolveReceiverSites = (receiver: string, callerName: string | null) =>
  (callerName ? resolveSitesViaPointsTo(`${callerName}::${receiver}`, ptsMap) : []).concat(
    resolveSitesViaPointsTo(receiver, ptsMap),
  );
```

**(b) The tier ladder in `resolveFallbackTargets`.** The existing `if (call.keyExpr && …)` block is replaced by an explicit three-tier predicate. Read the tiers top-down; the ordering is the soundness argument:

```ts
if (call.dynamicKind === 'value-ref') {
  targets = targets.filter(
    (t) => t.kind === 'function' || t.kind === 'method' || t.kind === 'class',
  );

  if (call.keyExpr && !hasInvocationEvidence(call, relPath, evidence)) targets = [];
}

/**
 * Is this object-literal property backed by evidence that it is ever actually
 * invoked? Three independent tiers, ORed — the property is live if ANY holds.
 *
 *   T1 CORRELATED (#2088, new). The site is proven local-closed
 *      (`escapes === false`), so the correlated evidence set is COMPLETE for
 *      it: a member call on a receiver that points at this very literal.
 *      When the site is local-closed, this tier is used EXCLUSIVELY — the
 *      whole point of #2088 is that `promise.resolve()` must not credit an
 *      unrelated literal's `resolve` key.
 *
 *   T2 BARE NAME (#1895, unchanged). Reached only when the site is ABSENT or
 *      ESCAPING — i.e. correlation is necessarily partial, so falling through
 *      to today's coarse predicate is the conservative choice. Behavior for
 *      every escaping site is byte-identical to pre-#2088.
 *
 *   T3 COMPUTED ACCESS (#2260, unchanged). Whole-table evidence from
 *      `TABLE[computedExpr]` — a computed key cannot name a specific property
 *      statically, so it credits the table, not the key. Deliberately kept
 *      NAME-keyed and ORed in unconditionally, including for local-closed
 *      sites: it is an independent channel and narrowing it is not this
 *      issue's concern (see #2611).
 */
function hasInvocationEvidence(
  call: Call,
  relPath: string,
  evidence: InvocationEvidence,
): boolean {
  const siteKey = call.objectLiteralSite
    ? objectLiteralSiteKey(relPath, call.objectLiteralSite)
    : null;
  const localClosed = siteKey !== null && evidence.nonEscapingSites.has(siteKey);

  // T1 — exclusive when the site is local-closed.
  if (evidence.correlationEnabled && localClosed) {
    if (evidence.correlated.has(correlatedEvidenceKey(siteKey, call.keyExpr as string))) {
      return true;
    }
  } else if (evidence.invokedNames.has(call.keyExpr as string)) {
    // T2 — today's predicate, for absent/escaping sites only.
    return true;
  }

  // T3 — independent, always consulted.
  return (
    call.receiver !== undefined &&
    evidence.computedDispatchTables.has(
      computedDispatchTableEvidenceKey(relPath, call.receiver),
    )
  );
}
```

> **Why T1 is exclusive rather than ORed with T2:** ORing them would make the change a pure no-op — every property T1 rejects, T2 would readmit on a bare name match, which is the exact behavior #2088 exists to remove. Exclusivity is what produces the recall improvement; the `localClosed` guard is what keeps it safe. `evidence.correlationEnabled` is `DEFAULTS.analysis.correlatedPropertyEvidence`, so setting it false restores the pure-T2 ladder exactly.

**(c) Persistence.** Two tables, mirroring `invoked_property_names` (#2087) so a scoped incremental build sees evidence from files it did not re-parse:

```ts
// src/db/migrations.ts — appended after the existing v31 entry
{
  // #2088: durable, per-file record of (a) every object-literal allocation
  // site and whether it escapes, and (b) every `${siteKey}|${property}` pair
  // proven invoked through a correlated receiver. The durable counterpart of
  // the in-memory sets `buildCallEdgesJS` computes, for exactly the reason
  // `invoked_property_names` (v29 / #2087) exists: a scoped incremental build
  // narrows `ctx.fileSymbols` to changed files + reverse-deps, so a consumer
  // living in an untouched file would otherwise be invisible and its site's
  // properties misclassified dead.
  //
  // Deleted and re-inserted per file (see preparePurgeStmts) so a file whose
  // sites changed never leaves stale rows behind.
  version: 32,
  up: `
    CREATE TABLE IF NOT EXISTS object_literal_sites (
      file    TEXT    NOT NULL,
      site    TEXT    NOT NULL,
      escapes INTEGER NOT NULL,
      PRIMARY KEY (file, site)
    );
    CREATE TABLE IF NOT EXISTS invoked_property_sites (
      site_key TEXT NOT NULL,
      name     TEXT NOT NULL,
      file     TEXT NOT NULL,
      PRIMARY KEY (site_key, name, file)
    );
    CREATE INDEX IF NOT EXISTS idx_invoked_property_sites_key
      ON invoked_property_sites(site_key);
  `,
},
```

`invoked_property_sites.file` is the **consuming** file (the one whose call produced the evidence), present solely so per-file purge works; the lookup only ever reads `(site_key, name)`. `object_literal_sites.file` is the **declaring** file.

Both tables get an entry in `preparePurgeStmts` (`src/db/repository/build-stmts.ts`, beside the existing `invokedPropertyNames`/`returnTypes` entries) and are added to `detect-changes.ts:637`'s full-wipe statement. `crates/codegraph-core/src/db/connection.rs` gets the identical DDL beside its existing `invoked_property_names` block (WU-8).

---

### WU-6: `incremental (watch) path parity`

- **Layer:** domain (`builder/incremental.ts`)
- **Blocked by:** WU-5
- **Blocks:** WU-10
- **Files:** `src/domain/graph/builder/incremental.ts`
- **Input contract:** one rebuilt file's `ExtractorOutput` + both persisted tables
- **Output contract:** the same tier ladder decision a full build would make for that file
- **Verification:** `npx vitest run tests/integration/issue-2087-incremental-invoked-property-persistence.test.ts tests/integration/issue-2088-correlated-property-evidence.test.ts`
- **Risk:** Medium — the watch path duplicates the ladder rather than sharing it, matching how #1895/#2260 are already duplicated there (`incremental.ts:1587-1595`). Divergence between the two ladders is the risk; WU-10's incremental test is the gate.

#### Implementation

Mirror WU-5(b) exactly, sourcing the evidence sets from the persisted tables rather than in-memory aggregation, exactly as `persistInvokedPropertyNamesForFile`'s counterpart already does at `incremental.ts:499-503`:

```ts
_invokedSitesSelectStmt = db.prepare(
  'SELECT site_key, name FROM invoked_property_sites WHERE file != ?',
);
_nonEscapingSitesSelectStmt = db.prepare(
  'SELECT file, site FROM object_literal_sites WHERE escapes = 0',
);
```

The rebuilt file's own sites and correlated evidence are recomputed in memory and unioned on top, so this file's fresh state always wins over its stale persisted rows.

> **Why `WHERE file != ?` for the evidence but not for the sites:** the evidence table is unioned with the file's own freshly-computed set, so its stale rows must be excluded (same pattern as `incremental.ts:499`). The sites table is read whole because a site declared in an untouched file is still valid — only the rebuilt file's own rows are replaced, and `purgeFileData` already did that before this read.

---

### WU-7: `Rust extractor mirror`

- **Layer:** native (Rust)
- **Blocked by:** WU-2
- **Blocks:** WU-8
- **Files:** `crates/codegraph-core/src/types.rs`, `crates/codegraph-core/src/extractors/javascript.rs`
- **Input contract:** same AST, same source bytes
- **Output contract:** `object_literal_sites` and `Call.object_literal_site` byte-identical to the TS extractor's
- **Verification:** `cargo test -p codegraph-core --lib extractors::javascript`
- **Risk:** Medium — the escape post-pass is the piece most likely to drift. Both engines must agree on the escape bit or the tier ladder picks different tiers for the same file.

#### Implementation

Mirrors WU-2 one-for-one:

- `types.rs` — `ObjectLiteralSite { site: String, owner: Option<String>, escapes: bool }` with serde field names matching the TS shape (`objectLiteralSite` ↔ `object_literal_site` via the existing rename convention used for `key_expr`/`dynamic_kind`); `Call.object_literal_site: Option<String>`.
- `javascript.rs` — `object_literal_site_id`, `enclosing_object_literal`; `handle_object_literal_pair_value_ref` (line 4456) and `handle_object_literal_shorthand_value_ref` (line 4494) each gain the site seed + tag; new `compute_object_literal_site_escapes` with `TRACKED_REFERENCE_PARENT_KINDS` mirroring `TRACKED_REFERENCE_PARENTS`, placed beside the existing `TABLE_NAME_PASSTHROUGH_KINDS` (line 4372) and cross-referenced in both directions by doc comment, as that constant already is.

Every new Rust item carries a `/// Mirrors <tsSymbol> in src/extractors/javascript.ts` line — the convention `handle_object_literal_pair_value_ref` already follows.

---

### WU-8: `Rust solver, edge builder, and NAPI threading`

- **Layer:** native (Rust) + domain (native orchestrator)
- **Blocked by:** WU-5, WU-7
- **Blocks:** WU-10
- **Files:** `crates/codegraph-core/src/domain/graph/builder/stages/build_edges.rs`, `crates/codegraph-core/src/domain/graph/builder/stages/import_edges.rs`, `crates/codegraph-core/src/db/connection.rs`, `src/domain/graph/builder/stages/build-edges.ts`
- **Input contract:** `NativeFileEntry` (TS, `build-edges.ts:118`) / `FileEdgeInput` (Rust, `build_edges.rs:115`) carrying the new `objectLiteralSites` / `object_literal_sites` field; the two new tables
- **Output contract:** identical edges and identical `roles` output to the WASM path
- **Verification:** `cargo test -p codegraph-core` then `cargo clippy --all-targets -- -D warnings`, **plus** the `--engine wasm` → `--engine native` pair in [Verification Commands](#verification-commands) run in that order on the same `.codegraph/graph.db` — see the note below for why the order is load-bearing
- **Risk:** High — largest single unit, and the engine that most builds actually run (`--engine auto` prefers native).

#### Implementation

- `build_edges.rs` — `build_points_to_map` (line 952) gains the site seeding + constraint rows from WU-4; `MAX_SOLVER_ITERATIONS` (line 926) is untouched. `collect_invoked_property_names` (line 861) is left **unchanged** and gains a sibling `collect_invoked_property_sites` with the same `extra: &[String]` persisted-union parameter shape. The value-ref block at ~line 1674 gains the WU-5(b) tier ladder as `has_invocation_evidence`. The `FileEdgeInput` struct (line 115) gains an `object_literal_sites: Option<Vec<ObjectLiteralSite>>` field beside the existing `computed_dispatch_table_evidence: Option<Vec<String>>` (line 158) — this is what the site-seeding above actually reads.
- `import_edges.rs` — `persist_invoked_property_sites` + `persist_object_literal_sites` beside the existing `persist_invoked_property_names`.
- `db/connection.rs` — the two `CREATE TABLE` statements from WU-5(c), verbatim, beside the existing `invoked_property_names` DDL at ~line 497.
- `src/domain/graph/builder/stages/build-edges.ts` — `NativeFileEntry` (line 118) gains a matching `objectLiteralSites?: ObjectLiteralSite[]` field beside the existing `computedDispatchTableEvidence?: string[]` (line 143); `buildNativeFileEntry` (line 879) populates it from `symbols.objectLiteralSites`, mirroring the existing `computedDispatchTableEvidence` population (lines 918–920) verbatim. `Call.objectLiteralSite` needs no equivalent edit: `calls: symbols.calls` (line 901) already carries the whole `Call` object across this boundary via napi-rs's own struct serialization — the same whole-object reasoning WU-3 establishes for the WASM-worker-protocol seam.

> **Not `native-orchestrator.ts` — and why this needs its own verification step.** `native-orchestrator.ts` contains zero occurrences of `computedDispatchTableEvidence` (verified by reading the full 2970-line file) and constructs no `FileEdgeInput`. It is `tryNativeOrchestrator`'s **post**-build JS passes (CHA expansion, this-dispatch, structure, dataflow-vertices), which run only *after* Rust's own full-pipeline build (`pipeline.rs`) has already extracted and consumed `computed_dispatch_table_evidence` (and will consume `object_literal_sites`) entirely inside Rust memory — no NAPI crossing for this data occurs on that path at all. `FileEdgeInput` is a Rust-only struct name (it never appears under `src/`); its TS-side counterpart is `NativeFileEntry`, above.
>
> The payload this WU adds a field to is instead built by `buildCallEdgesNative` (`build-edges.ts:924`), reached only when `useNativeCallEdges` — `native?.buildCallEdges && (ctx.isFullBuild || ctx.fileSymbols.size > ctx.config.build.smallFilesThreshold)` (`build-edges.ts:2949–2951`) — is true. On an ordinary full build, `tryNativeOrchestrator`'s fast path runs first and returns early (`pipeline.ts:490–492`), so `buildCallEdgesNative` is **never reached**: a plain top-level engine-output comparison does not by itself prove this field threads correctly. It *is* forced, deterministically, by the existing `--engine wasm` → `--engine native` pair already in [Verification Commands](#verification-commands): on the second (`native`) build, `checkEngineSchemaMismatch` sees `prevEngine ('wasm') !== ctx.engineName ('native')` and sets `ctx.forceFullRebuild = true` (`pipeline.ts:108–111`); `detectChanges` turns that into `ctx.isFullBuild = true` (`detect-changes.ts:993–1003`); and `shouldSkipNativeOrchestrator` treats `forceFullRebuild` as its own skip reason (`native-orchestrator.ts:129`), so `tryNativeOrchestrator` returns `undefined` and the build falls through to the JS pipeline. Together these guarantee `buildCallEdgesNative` runs on that second build. **This is order-dependent**: reversing the pair (native build first) or deleting `.codegraph/graph.db` between the two removes the engine mismatch and silently loses this coverage. WU-10 must not reorder those two commands or insert a DB reset between them.

The `correlatedPropertyEvidence` flag reaches Rust through the same `BuildConfig` JSON payload that already carries `pointsToMaxIterations` (documented at `src/infrastructure/config.ts:181-190`) — no new FFI parameter.

---

### WU-9: `configuration and documentation`

- **Layer:** infrastructure (9a) + docs (9b)
- **Blocked by:** none (9a) · WU-10 (9b — written once the measured numbers exist)
- **Blocks:** WU-5 (9a only)
- **Files:** `src/infrastructure/config.ts` (9a); `docs/roadmap/ROADMAP.md`, `README.md` (9b)
- **Input contract:** 9b consumes WU-10's measured before/after dead-symbol counts
- **Output contract:** one `DEFAULTS` key; roadmap and README text matching what shipped
- **Verification:** `npx tsc --noEmit` (9a) · `npm run lint` (9b)
- **Risk:** Low

#### Implementation

**9a** — the `analysis.correlatedPropertyEvidence` key, verbatim as given in [Configuration & Registry Impact](#configuration--registry-impact).

**9b** — two doc edits, both stating only what was measured:

- `ROADMAP.md` §8.3: add object literals to the allocation-site Approach bullet, and a progress sub-bullet recording that the object-literal slice of the unchecked "full allocation-site abstraction" item landed here. The item stays **unchecked** — a constraint solver over `new Foo()`, function literals, and arrow functions is still outstanding, and ticking it would be a fabricated completion claim.
- `README.md`: replace the dead-code caveat with the actual semantics — dispatch-table properties on non-escaping literals are now correlated to their own literal; escaping literals keep the coarse name-based check.

---

### WU-10: `tests, parity, and benchmark`

- **Layer:** tests
- **Blocked by:** WU-6, WU-8
- **Blocks:** WU-9b
- **Files:** `tests/integration/issue-2088-correlated-property-evidence.test.ts` (NEW), `tests/integration/issue-2088-escape-fallback.test.ts` (NEW), `tests/parsers/javascript.test.ts`, `tests/benchmarks/resolution/fixtures/pts-javascript/objlit-site.js` (NEW), `tests/benchmarks/resolution/fixtures/pts-javascript/expected-edges.json`
- **Input contract:** both engines complete
- **Output contract:** green suite + a recorded before/after dead-symbol delta on this repo
- **Verification:** the full [Verification Commands](#verification-commands) block
- **Risk:** Medium — the escape-fallback test is the soundness gate and must be written to fail if T1 ever stops being guarded by `localClosed`.

#### Implementation

**The correlation test** covers the four shapes the design claims, each asserted under **both** engines (`--engine wasm` and `--engine native`, skipped with an explicit message rather than silently if `isNativeAvailable()` is false — never a silent skip):

```js
// 1. Direct local table — the headline case from the issue body.
const HANDLERS = { resolve: neverCalled, reject: isCalled };
function run(x) { return HANDLERS.reject(x); }
// A decoy in a second file, which today keeps `neverCalled` alive:
export function decoy(p) { return p.resolve(1); }
// EXPECT: neverCalled dead, isCalled live.

// 2. Handler ARRAY + for-of — the canonical #1771 idiom, resolved via
//    arrayElemBindings → forOfBindings, both pre-existing.
const RESOLVERS = [{ matches: isFoo, resolve: doFoo }];
function pick(x) { for (const r of RESOLVERS) if (r.matches(x)) return r.resolve(x); }
// EXPECT: isFoo and doFoo both live.

// 3. Alias — via fnRefBindings.
const T = { alpha: fnA }; const u = T; u.alpha();
// EXPECT: fnA live.

// 4. Param flow into a local non-exported callee — via paramBindings (8.3c).
const P = { beta: fnB }; function use(t) { return t.beta(); } use(P);
// EXPECT: fnB live.
```

> **Each case must also assert `escapes = 0`** for its site (`SELECT escapes FROM object_literal_sites WHERE file = ? AND site = ?`), not just the liveness outcome shown above (round-3 critic finding). Liveness alone does not prove T1 fired: if a site were wrongly classified escaping, T2's bare-name fallback would report the same property live for an unrelated reason, and the test would pass while silently losing coverage of the tier it claims to exercise — symmetric to how the escape-fallback test below asserts `escapes = 1` rather than trusting liveness alone. Case 3 (alias) is the load-bearing one: it is exactly the shape WU-2's `variable_declarator` handling in `allReferencesTracked` (condition 3 above) must classify non-escaping, and a regression there would otherwise pass this test unnoticed.

**The escape-fallback test is the soundness gate.** Each case must be classified live *only* because the site escapes and T2 catches it — assert the classification, and assert `object_literal_sites.escapes = 1` for the site, so the test fails loudly if a future change flips the bit rather than silently passing on the wrong tier:

```js
// (a) Exported table read from another file — no cross-module SITE propagation.
export const T = { gamma: fnG };            // a.js
import { T } from './a.js'; T.gamma();      // b.js
// (b) Table passed to an IMPORTED function — the callee is opaque here.
import { register } from './reg.js'; register({ delta: fnD });
// (c) Destructured rather than member-called.
const D = { eps: fnE }; const { eps } = D; eps();
// (d) Returned from a factory and captured by an exported call-assignment —
//     the regression case for the round-2 fix to computeObjectLiteralSiteEscapes's
//     return-statement-owner branch (WU-2b): the site must escape regardless
//     of whether the factory FUNCTION itself is exported.
function factory() { return { zeta: fnZ }; }
export const X = factory();
X.zeta();
// EXPECT (all): live, escapes === 1.
```

**Existing tests that must stay green unchanged** — these are the regression contract and none of them may be edited to accommodate the new behavior:
`issue-1771-dispatch-table-value-ref`, `issue-1895-value-ref-invocation-check`, `issue-2087-incremental-invoked-property-persistence`, `issue-2257-logical-or-ternary-value-ref`, `issue-2260-computed-dispatch-table-evidence`, `issue-1784-instanceof-consumer-credit`, `issue-1776-lua-builtin-reassignment`, `tests/graph/classifiers/roles.test.ts`, `tests/engines/query-walk-parity.test.ts`.

> Note on #1895 specifically: its fixture's literal is returned from an **exported** `makeTable()`, so its site escapes and it resolves on T2 — today's exact path. It must pass untouched. If it does not, the escape analysis is wrong, not the test.

**Benchmark fixture** — `pts-javascript/objlit-site.js` carries shapes 2–4 with their expected `calls` edges added to `expected-edges.json`. `pts-javascript` is the correct home per ADR-002 §Costs.5; the `javascript` fixture's precision-1.0 floor must not move.

**Dogfood measurement** — record `codegraph roles --role dead -T` on this repo before and after, filtering `tests/` out by hand per `.codegraph/basics.md`'s documented `-T` under-filtering caveat (tracked as #2256). Report the delta as a measured number; do not predict one in advance.

## Critical Path

```text
WU-1 → WU-2 → WU-7 → WU-8 → WU-10 → WU-9b
```

Six units. The bottleneck is the Rust chain: WU-7 cannot start until the TS escape analysis is settled (it is a line-for-line mirror, and mirroring a design still in flux means doing it twice), WU-8 cannot start until WU-7 defines the types it consumes, and WU-10 cannot start until both engines are done because half of what it asserts is that they agree.

WU-4 (solver) is off the critical path and should be built in parallel with WU-2 — it depends only on WU-1's key helpers.

## Testing Strategy

| Tier | What it covers here | Files |
|---|---|---|
| **Unit / parser extraction** | Site ids are stable and unique per file; `escapes` is correct for each recognised shape and defaults `true` for unrecognised ones; value-ref calls carry `objectLiteralSite`. | `tests/parsers/javascript.test.ts` |
| **Integration over a fixture project** | The four correlation shapes and the three escape-fallback shapes, end-to-end through `buildGraph` into `nodes.role`. | `tests/integration/issue-2088-*.test.ts` |
| **Resolution precision/recall** | The new `pts-javascript/objlit-site.js` fixture's expected edges. `javascript`'s precision-1.0 floor must not move — that fixture is the false-positive canary per ADR-002. | `tests/benchmarks/resolution/` |
| **Dual-engine parity** | Every integration assertion runs under `--engine wasm` and `--engine native`; `npm run build` runs first so WASM sees the new `dist/`. | both `issue-2088-*` tests + `/parity` |
| **Incremental vs full** | A `codegraph watch`-shaped single-file rebuild reaches the same tier decision as a full build, via the two persisted tables. | `issue-2087-…` + the incremental case in `issue-2088-correlated-property-evidence` |
| **Benchmark / perf canary** | The solver gains constraint rows proportional to object-literal count. `npm run benchmark` guards build time; a >5% regression on this repo's full build is a finding to report, not to absorb. | `npm run benchmark` |

**What no tier catches, and what a human must check instead.** The escape analysis is a *judgment* about completeness, and no test can enumerate every JS shape that leaks an object identity. The tests above prove the recognised shapes are right and that the fail-safe default is `true`; they cannot prove the recognised set is exhaustive. **A reviewer must read `computeObjectLiteralSiteEscapes` (WU-2b) and its Rust mirror against `TRACKED_REFERENCE_PARENTS` and satisfy themselves that every position not in that set is genuinely treated as an escape.** That review is the real gate on the soundness requirement; the WU-10 tests are a sample of it.

## Verification Commands

```bash
npm run lint
npx tsc --noEmit
npm run build
npm test
npm run doctor
cargo test -p codegraph-core
cargo clippy --all-targets -- -D warnings
npx vitest run tests/integration/issue-2088-correlated-property-evidence.test.ts
npx vitest run tests/integration/issue-2088-escape-fallback.test.ts
npx vitest run tests/integration/issue-1895-value-ref-invocation-check.test.ts
npx vitest run tests/integration/issue-2260-computed-dispatch-table-evidence.test.ts
npx vitest run tests/integration/issue-2087-incremental-invoked-property-persistence.test.ts
npx vitest run tests/parsers/javascript.test.ts
npx vitest run tests/engines/query-walk-parity.test.ts
npm run benchmark
node dist/cli.js build --engine wasm
node dist/cli.js roles --role dead -T
node dist/cli.js build --engine native
node dist/cli.js roles --role dead -T
codegraph diff-impact --staged -T
```

`npm run build` must run before the two `--engine wasm` lines — the WASM engine parses in workers that load compiled `dist/`, so a `src/`-only edit is invisible to it and the comparison would be against stale code.

The two `roles --role dead -T` runs are the parity check *and* the dogfood measurement: identical output between engines is required (ADR-001); the delta against `main` is the recall improvement WU-9b documents.

**Do not reorder or split the `--engine wasm` → `--engine native` pair above.** Run in that order, on the same `.codegraph/graph.db`, with no delete/reset between them, the second (`native`) build is also WU-8's verification that the `objectLiteralSites` NAPI field threads correctly: the engine change trips `checkEngineSchemaMismatch`'s mismatch detection, which sets `ctx.forceFullRebuild`; `detectChanges` turns that into `ctx.isFullBuild = true` and it separately makes the Rust-orchestrator fast path skip itself — together guaranteeing `buildCallEdgesNative` (the per-stage NAPI path, otherwise bypassed on a normal full build) actually runs. See WU-8's implementation note for the full mechanism.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Tightening turns a conservative false negative into a **false positive** (live code reported dead) | Structural, not incidental: T1 is reachable only when `escapes === false`, and `escapes` defaults `true` on every unrecognised shape (WU-2b). Escaping sites take T2 — today's exact predicate. Gated by `tests/integration/issue-2088-escape-fallback.test.ts` (WU-10), which asserts both the classification *and* `escapes = 1`, so it fails if the guard is bypassed rather than passing on the wrong tier. |
| Reviewer objection: "this contradicts §8.3's field-based decision" | Pre-rebutted in [Reconciling the tension](#reconciling-the-tension-with-roadmap-83-field-based-not-field-sensitive): field-sensitivity and allocation-site abstraction are orthogonal axes, and §8.3's own Approach block already commits to allocation-site abstraction. The pts lattice stays field-based; the `site\|key` set is computed outside the solver. |
| Reviewer objection: "this duplicates #2260's `receiver` channel" | It does not — T3 is kept name-keyed, unconditional, and untouched (WU-5b). #2088 adds a third tier beside it. The array-literal gap in #2260's own channel is filed separately as #2611 rather than folded in. |
| New `ExtractorOutput` field silently dropped at the Worker boundary | ADR-002 §Costs.2 names this the primary parity risk, so it is its own work unit (WU-3) with its own verification, following the `computedDispatchTableEvidence` precedent in the same three files. `Call.objectLiteralSite` needs no protocol edit — verified by reading `wasm-worker-protocol.ts:51` (`calls: Call[]`, passed whole), not assumed. |
| WASM/native escape-bit drift | The bit is persisted in `object_literal_sites`, so a divergence is directly observable by diffing that table between engine runs rather than only inferable from a differing `roles` output. WU-10 runs every integration assertion under both engines; `/parity` gates. |
| Solver cost grows with object-literal count | Constraints added are O(sites) + O(callAssignments with a matching `::return` key), and the `callAssignments` loop is guarded on that key existing, so it adds no rows for the common case. `MAX_SOLVER_ITERATIONS` is unchanged at 50. `npm run benchmark` is in the verification block; a >5% full-build regression on this repo is reported, not absorbed. |
| Full-vs-incremental divergence in the new channel | Both new tables are persisted and purged per file exactly as `invoked_property_names` (#2087) is — WU-5(c), WU-6. This is deliberately *not* the shortcut #2260 took, whose in-memory-only aggregation is filed as #2610. |
| Scope growth during implementation | Two adjacent findings were filed as issues before this plan was written (#2610, #2611) rather than absorbed. Any further finding gets the same treatment; one PR = one concern. |

## Out of Scope (filed, not silently dropped)

- **`computedDispatchTableEvidence` is in-memory only** — on a scoped incremental build a dispatch table whose only computed-access consumer lives in an untouched file loses its evidence, so `roles --role dead` can report a live property dead. Non-conservative direction, and a full-vs-incremental divergence. Its sibling channel got a durable table in #2087 for exactly this reason. → issue **#2610**
- **`findEnclosingTableName` does not traverse array literals** — `TABLE_NAME_PASSTHROUGH_TYPES` (and its Rust mirror `TABLE_NAME_PASSTHROUGH_KINDS`) omit `array`, so `const RESOLVERS = [{ matches, resolve }]` yields no `receiver` and the #2260 computed-access pathway can never credit a handler array — the exact idiom named in `collectObjectLiteralValueRefCall`'s own doc comment as #1771's motivating case. Not closed by this plan, which leaves T3 name-keyed. → issue **#2611**
- **`-T` under-filters `tests/`**, inflating this repo's dead-symbol count ~3x. Already tracked; relevant here only because WU-10's dogfood measurement must filter `tests/` by hand rather than trust the raw number. → issue **#2256** (pre-existing, referenced in `.codegraph/basics.md`)
- **Cross-module allocation-site propagation** — `importedNames` propagates cross-module *names*, not *sites*, which is why exported tables are classified escaping (WU-2b, condition 2). Shrinking the escape set by propagating sites through import edges is a natural follow-up, in the spirit of ROADMAP §8.3b. **Not filed yet**: it is a design direction rather than a defect, it has no user-visible symptom today (escaping sites simply keep current behavior), and its right shape depends on what WU-10 measures. To be filed at execute time if the measured delta shows exported tables dominate the remaining false negatives.

## Success Criteria

- [ ] `codegraph roles --role dead -T` no longer credits an unrelated `x.name(...)` call as liveness evidence for a **non-escaping** object literal's `{ name: fn }` property — the exact behavior issue #2088 asks for.
- [ ] Every object literal producing a value-ref carries a stable allocation-site id, and its `escapes` bit is persisted in `object_literal_sites`.
- [ ] The points-to solver propagates those sites through the flows it already models — direct binding, array element + for-of, alias, and parameter passing — with **no** change to `buildCallSiteTypeMap` / `MAX_SOLVER_ITERATIONS`, per ADR-002's "no new subsystem".
- [ ] `resolveViaPointsTo` never returns a site token to name resolution.
- [ ] For any site with `escapes === true`, resolution is **byte-identical to pre-#2088**, and all nine listed existing tests pass unedited.
- [ ] WASM and native engines produce identical `object_literal_sites`, identical `invoked_property_sites`, and identical `roles --role dead -T` output on this repo.
- [ ] A scoped incremental rebuild reaches the same tier decision as a full build for the same file.
- [ ] `analysis.correlatedPropertyEvidence` is the only new behavioral constant, lives in `DEFAULTS`, is wired to both engines, and setting it `false` restores pre-#2088 behavior exactly.
- [ ] `pts-javascript` gains the new fixture; `javascript`'s precision-1.0 floor is unmoved.
- [ ] Every command in [Verification Commands](#verification-commands) has been run and passed; any that could not run is reported to the user rather than skipped.
- [ ] The before/after dead-symbol delta on this repo is recorded as a measured number in `ROADMAP.md` §8.3 and the PR body.
- [ ] No new language, no `LANGUAGE_REGISTRY` / `AST_TYPE_MAPS` / `LangAstConfig` change, no new runtime dependency.
