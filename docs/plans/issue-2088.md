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

tests/integration/issue-2088-correlated-property-evidence.test.ts   NEW   the seven canonical shapes; both engines
tests/integration/issue-2088-escape-fallback.test.ts               NEW   escaping sites keep today's exact behavior (the soundness regression gate)
tests/parsers/javascript.test.ts                                   MODIFIED  site emission + escape-bit unit assertions
tests/benchmarks/resolution/fixtures/pts-javascript/objlit-site.js  NEW   handler-array + alias correlation fixture
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
 *
 * Keyed by file (`fileCalls`), not a flattened call list, and
 * `resolveReceiverSites` takes the calling file's `relPath` as its first
 * argument — round 9, #2088 finding 2: unlike `collectInvokedPropertyNames`,
 * this function resolves through a points-to map, and that map is inherently
 * per-file, so the caller must be able to dispatch to the right one for each
 * call. See WU-5(a)'s pass-ordering note for the full argument and the
 * three-pass restructuring of `buildCallEdgesJS` this requires.
 */
export function collectInvokedPropertySites(
  fileCalls: ReadonlyMap<string, Iterable<{ name: string; receiver?: string; dynamicKind?: string | null; callerName?: string | null }>>,
  resolveReceiverSites: (relPath: string, receiver: string, callerName: string | null) => ReadonlyArray<string>,
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
- **Risk:** Medium — the escape analysis is the correctness-critical piece. Mitigated by defaulting `escapes: true` on every unrecognised shape, and, as of round 8, by a standing non-vacuous-coverage requirement on `allReferencesTracked` itself (see its doc comment below) that fails closed on a walk bug rather than relying solely on review to catch the next one — round 8 found the deepest gap yet in this exact function (a self-shadowing walk that silently examined nothing for every non-module-scope table), which seven prior rounds of inspecting individual reference POSITIONS never surfaced because none of them questioned whether the walk was reaching those positions at all. **Round 9 found that "defaulting `escapes: true` on every unrecognised shape" was itself not yet true of condition 4's own detector** — `literalHasUnmodeledThisReference` was a positive-only detector that silently voted non-escaping on any pair-value or object-member shape it did not recognise (a `spread_element`, a call-expression-valued pair, a parenthesized function, etc.), the exact inversion of every other condition's default. Closed by rewriting it to the same fail-closed contract, now stated once at the level of `computeObjectLiteralSiteEscapes` itself so it binds every current and future predicate uniformly — see the round-9 standing rule in that function's doc comment below, and `literalHasUnmodeledThisReference`'s own doc comment for the rewrite. **Round 10 found that condition 4's own identifier-RESOLUTION chain — not the shape-recognition switch round 9 rewrote — still violated the same fail-closed discipline, in two places: `findTopLevelFunctionNodeByName` resolves DOWN from the module root, so a same-named function-scoped shadow resolves to the wrong (module-level) function with full confidence rather than failing safe; and the shorthand arm's `BUILTIN_GLOBALS` guard short-circuits to a silent non-escaping vote for any builtin-named property, including one this file itself shadows.** Closed by resolving outward from the object literal via round 8's own `findDeclaringScopeNode` before ever falling back to the module-level search, and by replacing the bare builtin-name guard with a shared `isUnshadowedBuiltinGlobal` check applied identically in both the `pair` and `shorthand_property_identifier` arms — see the round-10 essay in `computeObjectLiteralSiteEscapes`'s doc comment below. **Round 11 found two further problems, one in each of round 10's own fixes, the second a regression round 10 itself introduced.** Finding 1: the outward walk missed a `for...of`/`for...in` loop-head binding, since `findDeclaringScopeNode`'s `SCOPE_NODE_TYPES` deliberately excludes `for_in_statement` for a *different* concern (#2260's own reference-walk boundary) that does not apply to this resolution question — closed by a new, resolution-only `findResolvingScopeNode` wrapper, without touching `findDeclaringScopeNode`/`SCOPE_NODE_TYPES` themselves. Finding 2: `isUnshadowedBuiltinGlobal` treats a builtin-named **import** as an unshadowed global, because `definitionNames` (built from `symbols.definitions`) excludes imports by construction — round 10's own recall improvement for the `pair` arm was therefore unsound, not merely incomplete, and is reverted: both arms now escape unconditionally on any `BUILTIN_GLOBALS` name, exactly as the `pair` arm always did through round 9, and `isUnshadowedBuiltinGlobal` is deleted. See the round-11 essay in `computeObjectLiteralSiteEscapes`'s doc comment below.

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

**(b) The escape post-pass.** Runs once per file, after `definitions` and `exports` are collected, and reads the file's own `root` AST directly rather than its already-collected `calls` — `computeObjectLiteralSiteEscapes` takes `exportedNames` (condition 2) and, as of round 7 (finding 3), `definitionNames` (condition 4's identifier-valued-pair resolution) alongside `sites` and `root`; it has no need for `calls` at all, since every check it performs is either a property of the AST directly (conditions 1, 3, 4) or of the file's own name sets (condition 2), never of an already-extracted `Call`. (An earlier draft of this sentence claimed the post-pass "needs all three" including `calls` — reconciled here against the function's actual signature below, which never took a `calls` parameter at any round.)

```ts
/**
 * THE INVARIANT — binding on this set and on every future addition to it
 * (round-6 critic finding). A position may be listed here only if EVERY
 * invocation of the literal's properties reachable through a reference in
 * that position is visible to T1 as a correlated member call on a receiver
 * that points at this very site. Merely keeping the object's IDENTITY
 * visible to the points-to solver is NOT sufficient — that is a necessary
 * precondition for correlation, never a proof that correlation actually
 * fires for every call that should count. Every round of review on this
 * plan has found another shape where identity stays visible but invocation
 * evidence does not follow it: the alias branch (round 3), the
 * parameter-flow branch (round 5), a same-literal `this.k()` call and a
 * bare (non-call) member/subscript read (round 6), a subscript call keyed
 * by a DYNAMIC expression (`T[k]()`, round 6) — and, round 7, three more:
 * a member/subscript call on the CONTAINER of an array-owned site (`T`'s
 * `object`-field reference stays visible, but nothing seeds a points-to
 * fact tying the callback parameter back to the site — see the
 * `member_expression`/`subscript_expression` bullet below), a `for...of`
 * loop variable that is itself forwarded into a position this analysis does
 * not follow (the same alias-transitivity gap round 4 fixed for `const u =
 * T`, recurring one binding later — see the `for_in_statement` bullet
 * below), and a subscript call keyed by a template string that LOOKS static
 * but contains `${…}` interpolation (see the `subscript_expression` bullet
 * below). Any future addition to this set — or any future loosening of
 * `isTrackedReferencePosition` below — must be checked against this test
 * explicitly; it must not be accepted merely because the solver can still
 * resolve the reference.
 *
 * Positions in which a reference to a site-owning binding is still tracked by
 * the points-to solver, refined by `isTrackedReferencePosition` immediately
 * below to the sub-shape that actually satisfies the invariant above:
 *
 *   member_expression    `T.k(…)`  — the correlated-evidence channel itself,
 *                         but ONLY when this member_expression is itself the
 *                         `function` of an enclosing `call_expression` and
 *                         the reference is that member_expression's `object`
 *                         field. Bare parent-type membership is not enough:
 *                         `T`'s parent is also `member_expression` in
 *                         `const f = T.k;`, `arr.map(T.k)`, and `return T.k`
 *                         — none of which is a call, so none of which can
 *                         ever produce a `collectInvokedPropertySites` entry
 *                         (that collector skips anything that isn't a member
 *                         call). A bare read leaves the site local-closed
 *                         while the read value can go anywhere, including
 *                         straight out of the module, with no compensating
 *                         flow: `const f = T.k` produces an `fnRefBinding`
 *                         keyed `T.k` that nothing seeds. Filed as a
 *                         follow-up capability (not modeled here) — #2620.
 *
 *                         ROUND 7: also requires the site's owner `key` to
 *                         EQUAL its `bindingName` — i.e. this branch fires
 *                         only for a DIRECT binding (`const T = {…}`), never
 *                         for an array-element owner (`const A = [{…}]`,
 *                         `key === "A[*]"`, `bindingName === "A"`, so
 *                         `key !== bindingName`). Without this, `RESOLVERS`
 *                         in `RESOLVERS.forEach((r) => r.matches('foo'))` —
 *                         the plan's own headline #1771 idiom — passed this
 *                         branch (`RESOLVERS` is the `object` of a
 *                         `member_expression` that is itself a call's
 *                         `function`), yet `buildArrayCallbackConstraints`
 *                         (`points-to.ts:225`) seeds a points-to fact for
 *                         `r` only from `Array.from(source, cb)`, never from
 *                         `.forEach`/`.map`/`.find`/`.filter`/`.some` — so
 *                         `r.matches(...)` inside the callback produces zero
 *                         T1 evidence no matter how `RESOLVERS` is
 *                         referenced, and a wrongly-non-escaping site would
 *                         make T1 exclusive over that zero evidence,
 *                         reporting `isFoo` dead where today it is live.
 *                         The only admissible reference to an array-owned
 *                         site's container is therefore the `for_in_statement`
 *                         bullet below; every member/subscript call on the
 *                         container itself now marks the site escaping.
 *                         Filed as a follow-up capability (not modeled
 *                         here) — #2621.
 *   subscript_expression `T[k](…)` — same call-position restriction as
 *                         member_expression (including the round-7
 *                         array-owner restriction just above — it applies to
 *                         both branches identically, since both share one
 *                         `if` in `isTrackedReferencePosition`), PLUS a
 *                         static-key requirement: only `T['resolve'](…)` /
 *                         `` T[`resolve`](…) `` (a string/template-string
 *                         index) is tracked — a dynamic index (`T[k](…)`, `k`
 *                         a variable) has no statically-known property name,
 *                         so it can never produce a
 *                         `collectInvokedPropertySites` entry for any
 *                         specific property, regardless of how `T` is
 *                         referenced elsewhere. Mirrors the identical
 *                         static/dynamic distinction #2260's own
 *                         `collectComputedDispatchTableEvidence` already
 *                         makes for the same reason.
 *
 *                         ROUND 8 (#2088 finding 3) — REPLACES round 7's fix
 *                         below, which was itself incomplete. Round 7 required
 *                         a `template_string` index to contain no `${…}`
 *                         interpolation, but left the `string` arm
 *                         unconditional — so `T['co$t'](…)` (a plain,
 *                         non-interpolated string key that happens to
 *                         CONTAIN a `$` character) was accepted as tracked
 *                         even though it can never produce correlated
 *                         evidence, for the identical reason an interpolated
 *                         template can't. Verified against the live
 *                         extractor, not assumed: `extractSubscriptCallInfo`
 *                         (`src/extractors/javascript.ts:5897-5900`) and its
 *                         Rust mirror `extract_call_info`
 *                         (`!method_name.contains('$')`,
 *                         `crates/codegraph-core/src/extractors/javascript.rs:6479`)
 *                         apply ONE check to BOTH index types identically —
 *                         strip quote/backtick characters from the index
 *                         text, then require the result to be non-empty and
 *                         free of `$` — with no special case for `string`.
 *                         `T['co$t']()` strips to `methodName = 'co$t'`,
 *                         which contains `$`, so the extractor emits no
 *                         named, receiver-carrying Call for it either: it
 *                         falls through to `<dynamic:unresolved>`, with no
 *                         name and no receiver, exactly like an interpolated
 *                         template. Greptile flagged this exact gap on this
 *                         PR, against round 7's code, before this fix landed
 *                         ("Quoted dollar keys lose evidence",
 *                         `docs/plans/issue-2088.md:676-679` at the time of
 *                         that review) — the round-8 fix below closes it by
 *                         applying the SAME stripped-text/no-`$` check to
 *                         both index types, rather than gating only the
 *                         `template_string` arm on it. Neither a `$`-bearing
 *                         static string key nor an interpolated template can
 *                         ever produce `collectInvokedPropertySites` evidence
 *                         for the property it names, regardless of how `T` is
 *                         referenced elsewhere — filed as a follow-up
 *                         capability (not modeled here, and unchanged by
 *                         round 8: it was already scoped to interpolation
 *                         only, not to `$`-bearing static keys, which round 8
 *                         fixes outright rather than exclude) — #2623.
 *   for_in_statement     `for (const r of T)` ONLY, i.e. the `of` variant
 *                         with the reference in the node's `right` field —
 *                         modelled by forOfBindings. The `in` variant is
 *                         EXCLUDED: it enumerates KEYS, not values, and
 *                         `for (const k in T) T[k]()` produces neither T1
 *                         nor T3 evidence for any property of `T` — see
 *                         `isTrackedReferencePosition`'s doc comment for why.
 *                         Filed as a follow-up capability — #2619.
 *
 *                         ROUND 7: accepting `T`'s reference here is not
 *                         enough on its own — the SAME alias-transitivity
 *                         principle round 4 applied to `const u = T` applies
 *                         one binding later, to the loop variable `r`
 *                         itself. `for (const r of A) sink(r)` (`sink`
 *                         imported) must NOT read as tracked merely because
 *                         `A`'s own reference is structurally accepted here:
 *                         `r` is a brand-new binding this analysis has not
 *                         yet followed, and `sink(r)` is exactly the
 *                         bare-identifier-argument shape condition 3's
 *                         parameter-flow exclusion (round 5, #2617) already
 *                         treats as untracked. `allReferencesTracked` (see
 *                         its own doc comment below) now recurses into the
 *                         loop variable exactly as it already recurses into
 *                         a rebinding alias, under the same depth-6 cap.
 *                         Further, this branch only fires at all when the
 *                         loop variable is a SINGLE PLAIN IDENTIFIER — the
 *                         same restriction `collectForOfBinding` itself
 *                         already applies when deciding whether to emit a
 *                         `forOfBindings` entry in the first place (verified:
 *                         it requires the declarator's `name` field to be a
 *                         plain `identifier`). A DESTRUCTURING loop variable
 *                         (`for (const { matches } of B) matches(x)`) gets no
 *                         `forOfBindings` entry at all — nothing seeds a
 *                         points-to fact for `matches` — so treating `B`'s
 *                         reference as tracked here would reopen this exact
 *                         gap for every destructuring for-of. Filed as a
 *                         follow-up capability, the array-element analogue
 *                         of #2620's bare-property-read gap — #2622.
 */
const TRACKED_REFERENCE_PARENTS: ReadonlySet<string> = new Set([
  'member_expression',
  'subscript_expression',
  'for_in_statement',
]);

/**
 * Structural refinement of `TRACKED_REFERENCE_PARENTS` (round-6 critic
 * finding, extended round 7): true only when `refNode` — an identifier
 * reference to a site-owning binding, found by `allReferencesTracked`'s file
 * walk — sits in a position that actually satisfies the invariant stated
 * above the set, not merely a position whose PARENT has one of that set's
 * node types. Bare parent-type membership was the round-5 predicate; it is
 * necessary but not sufficient, which is exactly what let both round-6
 * shapes through, and — one level more structural still — what let the
 * round-7 shapes through the round-6 fix:
 *
 *   - `T`'s parent is `member_expression` in `T.k()` AND in a bare read like
 *     `const f = T.k;` — only the structural check below tells them apart.
 *   - `T`'s parent is `for_in_statement` in `for (const r of T)` AND in
 *     `for (const k in T)` — both parse to the same node type in
 *     tree-sitter-javascript's grammar, distinguished only by which keyword
 *     token appears, exactly as `collectForOfBinding` already discriminates
 *     them (`src/extractors/javascript.ts:4285-4291`) for the solver's own
 *     `forOfBindings` seeding. `for (const k in T) T[k]()` gets neither T1
 *     evidence (the call's key is the loop variable `k`, never a static
 *     property name, so `collectInvokedPropertySites` has no `name` to key
 *     on) nor T3 evidence (`collectComputedDispatchTableEvidence` only fires
 *     on the `const x = T[expr]; x(...)` declarator form — verified against
 *     its guard clauses at `src/extractors/javascript.ts:5523-5538` — never
 *     on a direct `T[expr]()` call). Extending T3 to the direct-call form is
 *     filed as a follow-up — #2619 — not attempted here.
 *   - (round 7) `T.k()`'s call-position shape is IDENTICAL whether `T` owns
 *     its site directly or is the array-element wildcard's bare container
 *     (`RESOLVERS.forEach(...)`) — the AST alone cannot tell them apart;
 *     only knowing the site's OWNER can. Hence the new `isArrayOwner`
 *     parameter below, threaded in by the caller from `resolveSiteOwner`'s
 *     result rather than re-derived here.
 *   - (round 7) `` T[`resolve`]() `` and `` T[`al${x}pha`]() `` are both
 *     `subscript_expression` with a `template_string` index — the AST NODE
 *     TYPE alone cannot tell them apart either; only inspecting the
 *     template's own text (for a `$`) can, mirroring the extractor's own
 *     `extractSubscriptCallInfo` guard exactly rather than inventing a
 *     parallel notion of "static".
 *
 * Node identity below is compared via `.id`, never `===` — a fresh JS
 * wrapper object is minted on every `childForFieldName()`/`parent` access,
 * so two independently-fetched references to the same AST node are never
 * `===`-equal. Same reasoning `collectAccessorPropertyRead` already
 * documents at its own `.id` comparison (`src/extractors/javascript.ts:1022-1026`);
 * the Rust mirror reuses the identical `.id()` idiom already established at
 * `handle_accessor_property_read` (`crates/codegraph-core/src/extractors/javascript.rs:2323-2326`)
 * — not a new convention for either engine.
 *
 * @param isArrayOwner — round 7. True iff the site's `resolveSiteOwner().key`
 *   differs from its `bindingName` — the ONLY owner shape where that happens
 *   is an array element (`key === "A[*]"`, `bindingName === "A"`); every
 *   other owner shape has `key === bindingName`. Supplied by the caller,
 *   never recomputed here, so this function stays a pure structural check of
 *   `refNode`'s position and never needs its own copy of the owner-shape
 *   logic `resolveSiteOwner` already owns.
 */
function isTrackedReferencePosition(refNode: TreeSitterNode, isArrayOwner: boolean): boolean {
  const parent = refNode.parent;
  if (!parent || !TRACKED_REFERENCE_PARENTS.has(parent.type)) return false;

  if (parent.type === 'member_expression' || parent.type === 'subscript_expression') {
    // Round 7 (finding 1): a member/subscript call on an ARRAY-OWNED site's
    // CONTAINER is never tracked, full stop — see the round-7 addendum to
    // the member_expression bullet above for why `RESOLVERS.forEach(...)`
    // must not be accepted merely because it has the right AST shape. The
    // only admissible reference for an array owner is the for_in_statement
    // branch below.
    if (isArrayOwner) return false;
    // Must be the object being called, not a bare read: `T.k(…)` / `T[k](…)`
    // where this member/subscript expression is itself the callee.
    if (parent.childForFieldName('object')?.id !== refNode.id) return false;
    const grandparent = parent.parent;
    if (
      grandparent?.type !== 'call_expression' ||
      grandparent.childForFieldName('function')?.id !== parent.id
    ) {
      return false;
    }
    if (parent.type === 'subscript_expression') {
      // A STATIC key (`T['resolve']()`) is already normalized by the
      // generic call extractor into the same Call shape as `T.resolve()` —
      // verified against `collectComputedDispatchTableEvidence`'s own index
      // guard, which skips exactly this case for the identical reason
      // (`src/extractors/javascript.ts:5509-5511` doc, `:5533-5534` guard:
      // `if (indexNode?.type === 'string' || indexNode?.type ===
      // 'template_string') return;`) — genuinely correlatable, safe to
      // track, PROVIDED the extractor itself actually emits a named Call for
      // this exact index text (see ROUND 8 below — round 7's version of this
      // check got that proviso only half right). A DYNAMIC key (`T[k]()`) is
      // not: the call has no statically-known property name, so it can never
      // produce a `collectInvokedPropertySites` entry for any specific
      // property no matter how `T` is referenced elsewhere — the same
      // reasoning that excludes the `for...in` variant below, generalised to
      // every dynamic subscript call, not only ones reached through a loop.
      // Filed as a follow-up capability (not modeled here) — #2619.
      const indexNode = parent.childForFieldName('index');
      const indexType = indexNode?.type;
      if (indexType !== 'string' && indexType !== 'template_string') return false;
      // ROUND 8 (#2088 finding 3) — REPLACES round 7's `isTrackedStaticKey`,
      // which mirrored `extractSubscriptCallInfo`'s `$`-guard onto the
      // `template_string` arm only, leaving `string` unconditional. The
      // extractor (and its Rust mirror `extract_call_info`,
      // `crates/codegraph-core/src/extractors/javascript.rs:6479`) apply ONE
      // check to BOTH index types identically — strip quote/backtick
      // characters from the index text, then require the result to be
      // non-empty and `$`-free — with no special case for either kind of
      // quoting. Mirrored here verbatim rather than re-deriving a "static"
      // notion of its own, exactly as round 7 already intended but did not
      // fully implement. See the doc comment above this bullet for the
      // concrete `T['co$t']()` case this closes.
      const methodName = indexNode!.text.replace(/['"`]/g, '');
      if (!methodName || methodName.includes('$')) return false;
    }
    return true;
  }

  // for_in_statement: only the `of` variant, and only in the iterated
  // (`right`) position — never the loop-variable (`left`) pattern. Reuses
  // the exact `child.text === 'of'` discriminator collectForOfBinding
  // already applies, so the escape check can never disagree with the
  // solver about which loops forOfBindings models. (Round 7: this branch
  // never itself inspects the loop VARIABLE's own name or shape — that is
  // `allReferencesTracked`'s job, described in its own doc comment below,
  // exactly as it already owns the rebinding branch rather than this
  // function.)
  if (parent.childForFieldName('right')?.id !== refNode.id) return false;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i)?.text === 'of') return true;
  }
  return false; // `for (const k in T) …` — enumerates keys, not values.
}

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
 *      `importedNames`) — so its evidence is necessarily partial. Checked on
 *      `owner.bindingName` — see `resolveSiteOwner`'s doc comment (round-7
 *      critic finding, #2088 finding 5) for why this must be the BARE
 *      declarator identifier, never the `[*]`-suffixed key, for an
 *      array-element owner: `exportedNames` holds bare identifiers, so
 *      checking anything else here would silently never match and this
 *      condition would never fire for an exported array.
 *   3. Every other in-file reference to the owner satisfies
 *      `isTrackedReferencePosition` (the structural refinement of
 *      `TRACKED_REFERENCE_PARENTS` — see its own doc comment), called with
 *      `isArrayOwner = owner.key !== owner.bindingName` (true for, and only
 *      for, an array-element owner — round-7 critic finding, #2088 finding
 *      1: `RESOLVERS.forEach((r) => r.matches(x))` must not read as tracked
 *      merely because `RESOLVERS` sits in a call-position member expression —
 *      `buildArrayCallbackConstraints` never seeds a points-to fact for a
 *      `.forEach`/`.map`/`.find`/`.filter`/`.some` callback parameter, only
 *      for `Array.from`, so no correlated evidence for `r.matches(...)` can
 *      ever exist regardless of this reference); or is the `value` field of
 *      a `variable_declarator` whose own `name` field is a plain `identifier`
 *      — a rebinding, `const u = T`, the alias shape `fnRefBindings` already
 *      propagates, while a destructuring `name` such as `const { k } = T` is
 *      rejected the same way `findEnclosingTableName`
 *      (`src/extractors/javascript.ts:4519`) already rejects it for the
 *      identical distinction, since destructuring extracts a property rather
 *      than aliasing the reference and `fnRefBindings` does not model it
 *      (round-3 critic finding: without this guard, the alias case in
 *      WU-10's correlation test never actually exercises T1 — it stays
 *      escaping and falls through to T2's bare-name match, which reports the
 *      same "live" outcome for the wrong reason) — AND, when a reference is
 *      accepted on that rebinding branch, condition 3 must ALSO hold,
 *      recursively, for the new alias name itself (round-4 critic finding on
 *      the round-3 fix: accepting the `const u = T` reference alone, without
 *      then requiring every reference to `u` to be tracked too, lets the
 *      site read as local-closed while it still escapes through `u` — e.g.
 *      `const u = T; importedFn(u)` — which is exactly the class of gap
 *      condition 1 already calls out for a return-captured binding, here
 *      recurring one hop later for an alias-captured one); or is accepted on
 *      the `for_in_statement` `of`-branch — round-7 critic finding, #2088
 *      finding 2, the SAME alias-transitivity principle applied one binding
 *      further: accepting `A`'s reference in `for (const r of A) …` is not
 *      enough on its own, condition 3 must ALSO hold, recursively, for the
 *      loop variable `r` itself, and ONLY when the loop variable is a single
 *      plain identifier (mirroring the exact shape `collectForOfBinding`
 *      itself requires before it will even emit a `forOfBindings` entry — a
 *      destructuring loop variable, e.g. `for (const { matches } of B) …`,
 *      gets no such entry at all, so `B`'s reference is NEVER accepted on
 *      this branch when its loop variable destructures). `r`'s own recursive
 *      check is made with `isArrayOwner = false` regardless of the outer
 *      site's own `isArrayOwner` — a for-of loop variable always denotes a
 *      single ELEMENT, never a further array, so `r.matches(...)`/
 *      `r.resolve(...)` must be checked as direct-binding-shaped member
 *      calls, exactly as WU-10's existing handler-array correlation shape
 *      (`for (const r of RESOLVERS) if (r.matches(x)) return r.resolve(x);`)
 *      already requires in order to keep resolving as tracked — re-verified
 *      against this round's tightened rules: `RESOLVERS`'s only reference is
 *      this for-of head (accepted structurally, `isArrayOwner = true` for
 *      the reference to `RESOLVERS` but irrelevant to the for_in_statement
 *      branch, which never gates on it), recursing into `r` with
 *      `isArrayOwner = false` finds `r.matches(x)`/`r.resolve(x)` both
 *      correlated-call-shaped — so this headline shape is unaffected by
 *      round 7's tightening.
 *
 *      A bare-identifier argument to a function is deliberately NOT treated
 *      as a tracked reference: `buildParamFlowConstraints` (`points-to.ts`,
 *      Phase 8.3c) adds `pts(callee::paramName) ⊇ pts(argName)` with no
 *      escape check of its own, so crediting this position without recursing
 *      into the callee's own body to verify it stays tracked there too would
 *      reopen the same class of gap condition 1 and the rebinding branch
 *      above both close — regardless of whether the callee is local and
 *      non-exported. Parameter-passing positions therefore always mark the
 *      site escaping in this iteration; recursing into the callee's body to
 *      lift this is filed as a follow-up, not attempted here — see #2617.
 *      This exclusion applies identically to the for-of loop-variable
 *      recursion above — `for (const r of A) sink(r)` (`sink` imported or
 *      local, either way) fails `r`'s own check the same way `f(T)` already
 *      fails `T`'s, without needing a separate rule.
 *
 *   4. The literal itself does not define a method or function-valued
 *      property whose body references `this` (round-6 critic finding,
 *      extended round 7 — see `literalHasUnmodeledThisReference`'s doc
 *      comment for the full argument, including the identifier-valued-pair
 *      case round 7 adds). This condition is independent of 1–3: it is not a
 *      property of any reference to the OWNER BINDING at all — `this` is a
 *      different token — so no amount of tracking the binding's own
 *      references can catch it. `const T = { alpha: fnA, run() { return
 *      this.alpha(); } }; T.run();` has its only reference to `T` in a
 *      tracked position (condition 3 is satisfied — `T.run()` is a genuine
 *      correlated call), so without this condition the site would read as
 *      local-closed while `this.alpha()` produces no correlated evidence at
 *      all: nothing seeds a points-to fact for `this` here (the solver's
 *      only `this` key is `${callee}::this`, seeded from `thisCallBindings`
 *      only for `.call(ctx)` shapes — `src/domain/graph/resolver/points-to.ts:548-554`)
 *      — and `fnA` would lose its only in-edge. Conservative exclusion, not
 *      correlation: extending the design so a same-literal `this.k()` call
 *      resolves to its own site would need per-call-site correlation the
 *      tier ladder does not do today (it credits a property once ANY
 *      correlated call reaches it, not per invocation) — filed as a
 *      follow-up, not attempted here — see #2618. The SAME reasoning applies
 *      whether the `this`-referencing function is written inline
 *      (`run() {…}`, `run: function() {…}`) or named and referenced by
 *      identifier (`run: runImpl`, `function runImpl() {…}`) — round 6 only
 *      implemented the former; round 7 (#2088 finding 3) closes the latter.
 *
 * Fail-safe: anything unrecognised leaves the seeded `escapes: true`. Getting
 * this wrong in the `true` direction costs recall (today's behavior); getting
 * it wrong in the `false` direction would cost soundness. The asymmetry is
 * deliberate. (Round 9: this sentence describes the CONTRACT every condition
 * below must satisfy; condition 4's own detector did not yet satisfy it
 * through round 8 — see the round-9 standing rule after the round-8 essay
 * below, and `literalHasUnmodeledThisReference`'s doc comment for the fix.)
 *
 * > **ROUND 8 (#2088 finding 1) WITHDRAWS the round-7 conclusion below —
 * > it does not merely patch it.** Round 7 argued that a vacuous
 * > `allReferencesTracked` result is always safe because "every escape
 * > channel this design accounts for... manifests as SOME AST reference
 * > node," so an empty SURVIVING set could not be hiding one. That argument
 * > is true of the RAW AST and false of the SURVIVING set, and round 7
 * > conflated the two: it implicitly assumed the walk that PRODUCES the
 * > surviving set always sees every reference the raw AST actually
 * > contains. It does not. `introducesShadowedBinding`'s `statement_block`
 * > case returns `true` whenever the checked name is declared directly
 * > inside it (verified at `src/extractors/javascript.ts:4744-4771`) — correct
 * > when applied to some OTHER, later-encountered nested scope, but wrong
 * > when applied to the site's OWN declaring scope, which trivially
 * > "declares" the name by construction. A walk that checks every
 * > `SCOPE_NODE_TYPES` node it meets uniformly, INCLUDING the declaring
 * > scope itself, self-shadows: it prunes the entire block a non-module-scope
 * > table is declared in, finds zero references anywhere, and `.every()`
 * > reads that as vacuously true — not because no escape channel exists, but
 * > because the walk never looked. Concretely, this is not hypothetical:
 * >
 * > ```js
 * > // b.js
 * > export function register(t) { return t.alpha(); }
 * > // a.js
 * > import { register } from './b.js';
 * > function fnA() { return 1; }
 * > function install() {
 * >   const T = { alpha: fnA };   // declared inside a function
 * >   register(T);                // real escape — the pre-round-8 walk never sees it
 * > }
 * > install();
 * > ```
 * >
 * > `T`'s declaring scope is `install`'s own body block, which the naive walk
 * > self-shadows; `register(T)` — the ONLY other reference to `T` in the file
 * > — is inside that same pruned block, so it is never visited, the
 * > surviving set is empty, and pre-round-8 `allReferencesTracked` returns
 * > `true`. `T` reads as local-closed; `collectInvokedPropertySites` finds no
 * > correlated call in `a.js` (the real invocation, `t.alpha()`, is in
 * > `b.js`, and the points-to map is per-file, and parameter flow into an
 * > IMPORTED callee is not modeled — see WU-4's own "Scope: intra-module
 * > only" note); T1 becomes exclusive over zero evidence; `fnA` is reported
 * > **dead**, though it is genuinely reachable. This silently defeats
 * > condition 3's parameter-flow exclusion (round 5, #2617) for every
 * > NON-module-scope table specifically BECAUSE the walk never reaches the
 * > `register(T)` reference at all — condition 3 cannot exclude a reference
 * > it never sees. Every WU-10 fixture through round 7 declares its table at
 * > MODULE scope, where the declaring "scope" is `program` — a node type
 * > `introducesShadowedBinding`'s switch has no case for (`default: return
 * > false`, `javascript.ts:4813-4814`) — which is exactly why this survived
 * > seven rounds of review restating and re-verifying the SAME invariant
 * > against a test suite that structurally could not exercise it.
 * >
 * > **The corrected rule, replacing round 7's:** a vacuous (empty-surviving-set)
 * > result is trustworthy ONLY when the walk that produced it is PROVEN
 * > exhaustive over the binding's actual scope — i.e. (a) it never
 * > self-shadows the one scope it is rooted at, and (b) it was never
 * > truncated. Part (a) is fixed structurally below (the walk is rooted at,
 * > and exempts from the shadow-prune, ONLY the site's own declaring scope —
 * > see `allReferencesTracked`'s own doc comment, later in this file, for the
 * > full mechanism and its `hasLaterReferenceInEnclosingBlock` precedent).
 * > Part (b) is the STANDING RULE this round adds and the more consequential
 * > half: `allReferencesTracked` returns `true` only when it can PROVE it
 * > examined every reference in scope; any truncation — this walk's own
 * > `MAX_WALK_DEPTH` cap, or the alias-chain/for-of recursion's existing
 * > depth-6 cap — makes the result unproven, and unproven is treated exactly
 * > like "found a disqualifying reference": the site escapes. This converts
 * > the gate from "enumerate positions that look safe" to "escape unless
 * > coverage is proven," so that the NEXT walk bug — not just this one — fails
 * > CLOSED (today's conservative behavior) instead of silently promoting an
 * > incomplete search to non-escaping. Getting this wrong toward "unproven ⇒
 * > escapes" costs recall, the same asymmetry as every other fail-safe
 * > default in this design; that is the price of the standing rule, paid
 * > deliberately. What survives from round 7's discussion is narrower than
 * > its conclusion: a search that actually runs to completion and finds
 * > nothing (`const u = T;` with `u` never used again, an empty for-of body)
 * > still correctly reads as tracked — `covered === true` there, nothing was
 * > truncated, there is genuinely nothing to find. What is withdrawn is the
 * > broader claim that vacuous truth needs no exhaustiveness proof at all.
 *
 * > **ROUND 9 (#2088 finding 1) — the fail-closed contract, generalised from
 * > the walk to the whole function.** Round 8 made `allReferencesTracked`
 * > prove its own coverage before trusting a vacuous result — but that
 * > discipline was scoped to condition 3's walk specifically. Condition 4's
 * > own detector, `literalHasUnmodeledThisReference`, sat outside it: through
 * > round 8 it was a POSITIVE detector — it returned `true` only for a closed
 * > enumeration of recognised `this`-using shapes (a `method_definition`, an
 * > inline `function_expression`/`function`-valued pair, or a same-file
 * > resolved identifier-valued pair) and silently returned `false` — voting
 * > NON-escaping — for every shape it had never seen before. That is the
 * > exact inversion of every other condition in this function. Concretely:
 * >
 * > ```js
 * > function fnA() { return 1; }
 * > const mixin = { run() { return this.alpha(); } };
 * > const T = { alpha: fnA, ...mixin };
 * > T.run();
 * > ```
 * >
 * > `literalHasUnmodeledThisReference` walks `T`'s direct children: the
 * > `alpha` pair (identifier value, resolves in-file to `fnA`, no `this` in
 * > its body → safe) and the `...mixin` `spread_element`, which matches
 * > NEITHER the `pair` nor the `method_definition` branch, so the pre-round-9
 * > loop skips it without comment. `T.run()` is condition 3's only reference
 * > to `T`, and it is a genuine tracked call — so the site reads as
 * > local-closed while `this.alpha()` (reached only through the spread-copied
 * > `run` method, which DOES reference `this`) produces zero correlated
 * > evidence: nothing seeds a points-to fact for `this` here, the same gap
 * > condition 4 exists to catch for an inline `this.k()` method. `fnA` is
 * > reported dead, though `T.run()` calls it on every invocation. Two
 * > equivalent variants need no second literal at all: `run:
 * > (function () { return this.alpha(); })` (a `pair` whose value is a
 * > `parenthesized_expression`) and `run: makeRunner()` (a `pair` whose value
 * > is a `call_expression`) — neither matches any branch of the pre-round-9
 * > loop either. The line-991 "restrict to the simplest syntactic shape"
 * > precedent (#1771/#1784) the pre-round-9 doc comment cited for this
 * > silence governs *edge emission* — a recall choice about which
 * > resolutions to attempt — never a *safety predicate* about which shapes
 * > are proven harmless; conflating the two is what let this stand as an
 * > unreviewed exception to every other condition's fail-closed default.
 * >
 * > **The corrected, and now function-wide, rule:** every predicate
 * > `computeObjectLiteralSiteEscapes` consults — not just
 * > `allReferencesTracked`'s coverage (round 8), and not just condition 4 —
 * > must return "escaping" for any shape it does not POSITIVELY recognise as
 * > safe, with no third "silently skip and implicitly vote non-escaping"
 * > outcome anywhere in the chain. `literalHasUnmodeledThisReference` (below)
 * > is rewritten to this contract: it now enumerates the shapes POSITIVELY
 * > PROVEN never to bind their own `this` to the literal, and escapes on
 * > everything else — see its own doc comment for the exact enumeration. This
 * > is a STANDING RULE on `computeObjectLiteralSiteEscapes`'s own contract,
 * > not a one-off patch to condition 4 alone: any predicate added to this
 * > function in a future round — a hypothetical condition 5, or a further
 * > refinement of conditions 1–3 — inherits it automatically, exactly as
 * > round 8's non-vacuous-coverage requirement is a standing rule on
 * > `allReferencesTracked` specifically rather than a one-off fix to the
 * > shadow-prune bug that motivated it. Getting this wrong toward "escaping"
 * > costs recall, the same asymmetry every fail-safe default in this design
 * > accepts; getting it wrong the other way is precisely the class of bug
 * > both standing rules now exist to catch structurally, in every future
 * > change to this function, not only in the one instance found this round.
 *
 * > **ROUND 10 (#2088 findings 1 and 2) — condition 4's own
 * > identifier-RESOLUTION chain still violated a fail-closed discipline in
 * > two places, even after round 9's rewrite made the shape-recognition
 * > switch itself fail closed.** Both gaps live one layer deeper than round
 * > 9 touched: not in WHICH pair-value shapes `literalHasUnmodeledThisReference`
 * > recognises, but in HOW it resolves the one shape that requires finding a
 * > same-file declaration by name — an identifier value or a shorthand
 * > property.
 * >
 * > **Finding 1 — `findTopLevelFunctionNodeByName` searches DOWN from the
 * > module root, so a shadowing declaration resolves to the WRONG function
 * > with full confidence instead of failing safe.**
 * > `resolveIdentifierValueThisReference` resolved an identifier-valued
 * > pair/shorthand property by searching ONLY `root`'s direct (module-level)
 * > children. Its pre-round-10 doc comment claimed this was safely
 * > backstopped: a nested-past-module-scope declaration this bounded search
 * > cannot reach returns `null`, which the caller already treats as
 * > unresolved and fails safe on. That backstop fires only when NO
 * > module-level declaration of the name exists at all. When one ALSO
 * > exists — shadowed, at the object literal's own lexical position, by a
 * > closer, non-module declaration — the search returns that unrelated
 * > module-level node with full confidence, never `null`, so the backstop
 * > this doc comment relied on never actually fires:
 * >
 * > ```js
 * > function fnA() { return 1; }
 * > function run() { return 0; }                  // module-level, this-free
 * > function install() {
 * >   function run() { return this.alpha(); }     // shadows it, uses `this`
 * >   const T = { alpha: fnA, run };
 * >   T.run();
 * > }
 * > install();
 * > ```
 * >
 * > Conditions 1–3 pass (`T` is a plain local binding, never exported, and
 * > `T.run()` is `T`'s only tracked reference). Condition 4's shorthand arm
 * > resolves `run` via `findTopLevelFunctionNodeByName(root, 'run')`, which
 * > returns the OUTER, `this`-free `run` — the INNER, `this`-using `run`
 * > actually in scope at `T`'s own position is invisible to a search that
 * > only ever looks at `root`'s direct children.
 * > `subtreeContainsThisKeyword` finds nothing in the wrong function's body,
 * > condition 4 votes safe, `escapes` reads `false`, T1 is exclusive over
 * > zero evidence for `alpha`, and `fnA` is reported dead though
 * > `install() → T.run() → this.alpha() → fnA()` runs on every invocation.
 * > This is a strictly worse failure than an unresolved identifier: a
 * > sub-predicate that returns a WRONG answer with full confidence is worse
 * > than one that returns no answer, because nothing downstream carries any
 * > signal that something went wrong. Fixed by resolving OUTWARD from the
 * > object literal's own position FIRST, reusing round 8's own
 * > `findDeclaringScopeNode(objectNode, name)`: when it finds a scope
 * > strictly between `objectNode` and the module root that ALSO declares
 * > `name`, `resolveIdentifierValueThisReference` now fails safe
 * > immediately, before `findTopLevelFunctionNodeByName` ever runs, rather
 * > than trusting a search that structurally cannot see the shadowing
 * > declaration at all. See `resolveIdentifierValueThisReference`'s own doc
 * > comment for why failing safe — rather than resolving INTO the shadowing
 * > scope — is the chosen remedy, and `findTopLevelFunctionNodeByName`'s own
 * > doc comment for the corrected backstop claim.
 * >
 * > **Finding 2 — the shorthand arm's `BUILTIN_GLOBALS` guard short-circuits
 * > to a silent, unproven "non-escaping" vote.** The shorthand arm's round-9
 * > guard, `!BUILTIN_GLOBALS.has(child.text) &&
 * > resolveIdentifierValueThisReference(...)`, short-circuits to `continue`
 * > (non-escaping) the instant `child.text` merely TEXTUALLY MATCHES a known
 * > global's name — `Stream`, `Buffer`, `process`, `document`, `URL`, and
 * > everything else `BUILTIN_GLOBALS` lists (`src/extractors/javascript.ts:37-95`)
 * > — with NO check for whether this file itself SHADOWS that name with its
 * > own, potentially `this`-using, declaration. This is precisely the
 * > "silently skip and implicitly vote non-escaping" outcome the round-9
 * > standing rule above forbids for every predicate this function consults,
 * > condition 4's own detector included:
 * >
 * > ```js
 * > function fnA() { return 1; }
 * > function Stream() { return this.alpha(); }   // shadows the global Stream
 * > const T = { alpha: fnA, Stream };
 * > T.Stream();
 * > ```
 * >
 * > `Stream` here names a same-file, `this`-using function, not the global
 * > it happens to share a name with — but the guard never calls
 * > `resolveIdentifierValueThisReference` to find that out, because
 * > `BUILTIN_GLOBALS.has('Stream')` is true regardless of what this file
 * > itself declares. `escapes` reads `false`, T1 is exclusive, and `fnA` is
 * > reported dead though `T.Stream()` invokes it on every call. The `pair`
 * > arm does not share this SPECIFIC hole — a builtin-named identifier VALUE
 * > there falls through to `isPositivelyThisFreeLiteral` (false for
 * > `identifier`) and hits the fail-closed default — which is what made the
 * > round-9 doc comment's claim that the two arms get "the IDENTICAL
 * > identifier-resolution treatment" false, not true: the `pair` arm's
 * > fallthrough ALWAYS escapes on a builtin-named identifier, shadowed or
 * > not, which is sound but neither identical to the shorthand arm's
 * > behavior nor itself precise — it fails to credit a genuinely unshadowed
 * > builtin (a real, structural non-escape) as safe. Fixed by replacing the
 * > bare `!BUILTIN_GLOBALS.has(name)` guard, in BOTH arms identically, with
 * > a new shared `isUnshadowedBuiltinGlobal(name, definitionNames)`: skip
 * > resolution (vote safe) only when `name` is a builtin AND this file
 * > defines no same-file symbol by that name at all — a genuine, unshadowed
 * > native global whose internals are not this file's code and so cannot
 * > reference a sibling property via `this`. The instant `definitionNames`
 * > also contains the name, it routes through
 * > `resolveIdentifierValueThisReference` exactly like any other same-file
 * > identifier, escaping when that resolution is unproven `this`-free. This
 * > is not merely a shorthand-arm patch: applying the identical guard to the
 * > `pair` arm's identifier branch too is what makes the two arms' treatment
 * > ACTUALLY identical, as the prose already claimed, rather than
 * > superficially similar in shape but different in the builtin-name case —
 * > and it is a strict recall IMPROVEMENT for the `pair` arm's own
 * > previously-unconditional builtin escape, not a new exclusion (see
 * > Success Criteria).
 * >
 * > **Both findings fix condition 4's identifier-RESOLUTION chain
 * > specifically, not the shape-recognition rewrite round 9 already
 * > completed.** Round 9 established WHICH pair-value shapes are positively
 * > recognised as `this`-free; round 10 fixes HOW the one shape that
 * > requires resolving a same-file declaration by name actually finds that
 * > declaration. Finding 1 is thematically continuous with round 8 (a
 * > search returning a confidently WRONG answer, rather than an honestly
 * > absent one); finding 2 is a direct instance of the round-9 standing rule
 * > that round 9's own rewrite did not audit its way into, since
 * > `resolveIdentifierValueThisReference` and `isUnshadowedBuiltinGlobal`'s
 * > predecessor guard predate round 9 and were not themselves part of what
 * > round 9 rewrote. Every other condition, and every pair-value shape round
 * > 9 already covers, is unaffected: this essay and the fix beneath it touch
 * > only `resolveIdentifierValueThisReference`, `findTopLevelFunctionNodeByName`'s
 * > doc comment (never its body — it was never the bug; the caller's missing
 * > precondition was), and the two call sites' guard expression. Failing
 * > safe on a shadowed identifier (finding 1) costs recall for the narrow
 * > case where the shadowing declaration is itself `this`-free — filed as a
 * > follow-up rather than silently accepted, see Success Criteria and
 * > #2625. Finding 2 costs no recall anywhere; it is a soundness fix with a
 * > strict recall improvement as a side effect, per round 8's own framing of
 * > what does and does not need a new exclusion.
 *
 * > **ROUND 11 (#2088 findings 1 and 2) — round 10's own two fixes each had
 * > a further problem: finding 1 a gap round 10 did not close, finding 2 a
 * > REGRESSION round 10 itself introduced while "unifying" the two arms.**
 * >
 * > **Finding 1 — `findDeclaringScopeNode` cannot see a `for...of`/`for...in`
 * > loop-head binding, because its `SCOPE_NODE_TYPES` deliberately excludes
 * > `for_in_statement` for a DIFFERENT concern than this one.** Verified at
 * > `src/extractors/javascript.ts:4610-4614`: `for_in_statement` is absent
 * > from `SCOPE_NODE_TYPES` (defined at `javascript.ts:4616-4627`) on
 * > purpose, per its own doc comment — a `for (… of right)` head that binds
 * > `name` must not prune `allReferencesTracked`'s reference walk, because
 * > `right` is evaluated in the ENCLOSING scope and can hold a genuine read
 * > (`for (const x of fn())`); `blockContainsIdentifierExcluding` handles
 * > that shape directly instead. That reasoning governs condition 3's
 * > reference-WALK boundary (#2260) specifically. It says nothing about
 * > condition 4's RESOLUTION question — whether `name`, at the object
 * > literal's own lexical position, refers to the loop variable rather than
 * > to whatever `findTopLevelFunctionNodeByName` would find at module level —
 * > and a loop-head binding shadows exactly like any other scope's binding
 * > for THAT question. The round-10 doc comment above claimed "both
 * > questions reduce to the same one... which is why both reuse
 * > `findDeclaringScopeNode` rather than each rolling its own ancestor walk"
 * > — false as stated; corrected where it was made
 * > (`resolveIdentifierValueThisReference`'s own doc comment, below).
 * > Concretely:
 * >
 * > ```js
 * > function fnA() { return 1; }
 * > function run() { return 0; }                       // module-level decoy, this-free
 * > const impls = [function () { return this.alpha(); }];
 * > for (const run of impls) {                         // loop var shadows module `run`
 * >   const T = { alpha: fnA, run };
 * >   T.run();                                         // → this.alpha() → fnA()
 * > }
 * > ```
 * >
 * > `run`'s declaring scope for THIS question is the `for_in_statement`
 * > head — but `findDeclaringScopeNode`'s ancestor walk passes straight over
 * > that node (not in `SCOPE_NODE_TYPES`) without ever asking whether its own
 * > head binds `run`, reaches `program`, and returns `undefined`; the
 * > `?? root` fallback then makes `declaringScope === root`, the "shadowed by
 * > a non-module scope" fail-safe never fires, `findTopLevelFunctionNodeByName`
 * > finds the OUTER, `this`-free decoy `run` with full confidence, condition 4
 * > votes safe, `escapes` reads `false`, T1 is exclusive over zero real
 * > evidence for `alpha`, and `fnA` is reported dead though `T.run()` invokes
 * > it via the INNER, `this`-using loop-element function every iteration —
 * > the SAME failure mode round 10's own finding 1 named for a function/block
 * > shadow (a sub-predicate returning a confidently WRONG answer rather than
 * > an honest "unresolved"), just via a scope kind round 10's fix did not
 * > know to look for.
 * >
 * > Fixed by a new, resolution-path-ONLY wrapper, `findResolvingScopeNode`,
 * > used exclusively by `resolveIdentifierValueThisReference` below — NOT by
 * > adding `for_in_statement` to `SCOPE_NODE_TYPES` and NOT by changing
 * > `findDeclaringScopeNode`/`findDeclaringScopeLine` themselves, both of
 * > which stay exactly as round 8 left them for `allReferencesTracked`'s own,
 * > already-verified-sound purpose (#2260) — widening what THEY consider a
 * > shadow would reopen exactly the genuine read `SCOPE_NODE_TYPES`'s own doc
 * > comment protects. `findResolvingScopeNode` ORs the existing
 * > `introducesShadowedBinding` check with one extra disjunct: does a
 * > `for_in_statement` ancestor's own `left` field bind `name`, tested with
 * > `patternBindsName` — the SAME primitive `blockContainsIdentifierExcluding`'s
 * > own for-in branch already uses for this identical field
 * > (`src/extractors/javascript.ts:5197-5199`). See `findResolvingScopeNode`'s
 * > own doc comment, below, for the full mechanism.
 * >
 * > **Finding 2 — `isUnshadowedBuiltinGlobal` treats a builtin-named IMPORT
 * > as a genuine, unshadowed global, because `definitionNames` excludes
 * > imports by construction — making round 10's own `pair`-arm
 * > "improvement" a REGRESSION, not merely an incomplete fix.**
 * > `definitionNames` is built `symbols.definitions.map((d) => d.name)`
 * > (verified, `src/domain/graph/builder/stages/build-edges.ts:559`) —
 * > `symbols.definitions` never includes an imported binding;
 * > `points-to.ts` itself relies on this exact split, testing
 * > `definitionNames` and `importedNames` as two separate sets (verified,
 * > `src/domain/graph/resolver/points-to.ts:306`).
 * > `isUnshadowedBuiltinGlobal(name, definitionNames)` —
 * > `BUILTIN_GLOBALS.has(name) && !definitionNames.has(name)` — is therefore
 * > `true` for a builtin-named IMPORT exactly as it is for a genuine,
 * > un-redeclared global: an import shadows the name just as much as a
 * > same-file declaration does, but this check cannot tell the two apart.
 * > Concretely:
 * >
 * > ```js
 * > // resp.js
 * > export function Response() { return this.alpha(); }
 * > // a.js
 * > import { Response } from './resp.js';
 * > function fnA() { return 1; }
 * > const T = { alpha: fnA, handler: Response };
 * > T.handler();                                       // → this.alpha() → fnA()
 * > ```
 * >
 * > `Response` is in `BUILTIN_GLOBALS` (`src/extractors/javascript.ts:37-95`,
 * > verified). `isUnshadowedBuiltinGlobal('Response', definitionNames)` is
 * > `true`, the `pair` arm's identifier branch short-circuits to `continue`
 * > (non-escaping) without ever calling `resolveIdentifierValueThisReference`,
 * > `escapes` reads `false`, and `fnA` is reported dead though `T.handler()`
 * > invokes it on every call. The identical shape with `Response` as a
 * > shorthand property (`{ alpha: fnA, Response }; T.Response();`) hits the
 * > shorthand arm's identical guard. **This is a genuine regression, not an
 * > incomplete fix**: through round 9 the `pair` arm's guard was
 * > `value.type === 'identifier' && !BUILTIN_GLOBALS.has(value.text)` — for a
 * > builtin-named value this condition was simply `false`, the whole
 * > identifier-branch was skipped, execution fell through to
 * > `isPositivelyThisFreeLiteral(value)` (`false` for `identifier`), and hit
 * > the function's own fail-closed default — ALWAYS escaping on a
 * > builtin-named `pair` value, shadowed or not, imported or not. Round 10
 * > replaced that with `isUnshadowedBuiltinGlobal`, framing it purely as a
 * > recall improvement for the `pair` arm ("a strict recall IMPROVEMENT...
 * > not a new exclusion," per the closing paragraph above) — true for a
 * > same-file shadow, which `definitionNames` does see, but false for an
 * > imported one, which it does not: the "improvement" made the `pair` arm
 * > unsound for exactly the case `definitionNames` cannot observe.
 * >
 * > **Fixed by taking back the recall improvement, not by patching
 * > `isUnshadowedBuiltinGlobal` to also consult `importedNames`.** Threading
 * > `importedNames` through would close this specific hole but was not
 * > chosen: it adds a new parameter to a soundness-critical resolution chain
 * > this plan has already found bugs in across rounds 7, 8, 9, and 10, for an
 * > improvement that itself has not yet had its own, focused review round.
 * > Instead, BOTH arms now escape UNCONDITIONALLY on any `BUILTIN_GLOBALS`
 * > name, with no resolution attempted at all — restoring the `pair` arm's
 * > pre-round-10, always-verified-sound behaviour, and giving the shorthand
 * > arm that SAME unconditional-escape treatment for the first time (through
 * > round 9 the shorthand arm instead short-circuited to a silent
 * > non-escaping `continue` on any builtin name — its OWN, differently-shaped
 * > bug, which is what round 10's finding 2 was originally fixing). With
 * > nothing left to distinguish the two arms' builtin handling — no
 * > `definitionNames` lookup, no shadow question, nothing but a
 * > `BUILTIN_GLOBALS` membership test — `isUnshadowedBuiltinGlobal` has no
 * > remaining call site and is deleted rather than kept as a vestigial
 * > abstraction. Crediting a genuinely unshadowed builtin (imported names
 * > included) as safe again is a real recall opportunity — filed as its own
 * > follow-up, to be designed and reviewed as its own round rather than
 * > re-attempted inline here — see Success Criteria and
 * > #2627.
 */
function computeObjectLiteralSiteEscapes(
  sites: Map<string, ObjectLiteralSite>,
  root: TreeSitterNode,
  exportedNames: ReadonlySet<string>,
  definitionNames: ReadonlySet<string>,
): void {
  for (const entry of sites.values()) {
    const objectNode = findNodeAtSite(root, entry.site);
    if (!objectNode) continue;                       // stays escapes: true

    const owner = resolveSiteOwner(objectNode);      // → { key, bindingName } | null — see its own doc comment for the full contract (round-7 critic finding, #2088 finding 5)
    if (!owner) continue;                            // inline argument, etc.
    entry.owner = owner.key;

    // Condition 4 — independent of the bindingName branches below, so it is
    // checked uniformly regardless of which kind of owner this site has.
    // `entry.owner` is already set above, so WU-4's seeding is unaffected;
    // only the escape bit changes. `root` and `definitionNames` are threaded
    // through so the round-7 identifier-valued-pair case can resolve a
    // same-file function by name — see literalHasUnmodeledThisReference.
    if (literalHasUnmodeledThisReference(objectNode, root, definitionNames)) {
      entry.escapes = true;
      continue;
    }

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

    // Round 7 (#2088 finding 1): the ONLY owner shape where `key` and
    // `bindingName` differ is an array element (see resolveSiteOwner's doc
    // comment) — reusing that difference as the isArrayOwner signal avoids
    // a second, redundant way to ask the same question.
    const isArrayOwner = owner.key !== owner.bindingName;
    // Top-level call — `declaringScope` is omitted, so `allReferencesTracked`
    // computes it once via `findDeclaringScopeNode(objectNode, owner.bindingName)
    // ?? root` (round 8, #2088 finding 1) and threads that fixed node through
    // its own recursive calls unchanged. See `allReferencesTracked`'s own doc
    // comment below for why the boundary must be computed exactly once, here,
    // rather than re-derived per recursive call.
    entry.escapes = !allReferencesTracked(
      root, owner.bindingName, objectNode, isArrayOwner,
    );
  }
}

/**
 * True unless the object literal's own direct children are ALL positively
 * proven never to bind their own `this` to the literal (round-6 critic
 * finding, condition 4 above; round 7, #2088 finding 3, added the
 * identifier-valued-pair case; **round 9, #2088 finding 1, inverted the
 * default itself** — see the ROUND 9 standing rule in
 * `computeObjectLiteralSiteEscapes`'s doc comment above for why). Walks
 * `objectNode`'s DIRECT children only — the same one-level shape
 * `extractObjectLiteralFunctions` already uses to enumerate an object
 * literal's own methods (`src/extractors/javascript.ts:2065-2091`) — and
 * classifies each one as one of:
 *
 *   - `method_definition` — its own subtree is searched for `this`.
 *   - a `pair` whose value is `arrow_function` — POSITIVELY SAFE, never
 *     unrecognised: an arrow function never binds its own `this` — inside
 *     one, `this` resolves lexically to whatever `this` was where the
 *     literal itself was written, which is never the literal, regardless of
 *     how the enclosing method is later called. Excluding it costs no
 *     soundness and preserves recall.
 *   - a `pair` whose value is `function_expression` or `function` (written
 *     INLINE) — its own subtree is searched for `this`, same as the
 *     `method_definition` case.
 *   - a `pair` whose value is a plain `identifier` (round 7, #2088 finding
 *     3 — round 6 only inspected an INLINE function/method value, so
 *     `{ alpha: alphaImpl, run: runImpl }` with `function runImpl() {
 *     return this.alpha(); }` defined elsewhere in the same file slipped
 *     through entirely: `run`'s value is `identifier`, not
 *     `function_expression`, so the round-6 walk never looked at it,
 *     `T.run()` read as a genuine tracked call (condition 3 satisfied), and
 *     the site read as local-closed while `this.alpha()` produced zero
 *     correlated evidence — `alphaImpl` would be reported dead where today
 *     it is live) — resolved via `resolveIdentifierValueThisReference`
 *     below, with the SAME conservative, FOUR-way (round 10, #2088 finding
 *     1, adds the second bullet below; through round 9 this was three-way)
 *     fail-safe structure the rest of this design already uses: is a
 *     BUILTIN name (`BUILTIN_GLOBALS.has(name)`, round 11, #2088 finding 2 —
 *     UNCONDITIONALLY, with no `definitionNames` lookup at all; see the
 *     round-11 essay above for why round 10's shadow-aware
 *     `isUnshadowedBuiltinGlobal` is reverted rather than extended) → never
 *     even reaches this resolution at all, handled at the call site instead
 *     by escaping outright; is SHADOWED — some scope strictly between the
 *     object literal and the module root also declares this name, INCLUDING
 *     (round 11, #2088 finding 1) a `for...of`/`for...in` loop-head binding,
 *     which `findDeclaringScopeNode`'s own `SCOPE_NODE_TYPES` deliberately
 *     does NOT treat as a shadow for ITS OWN purpose (#2260) but which
 *     shadows exactly as much for THIS one (`findResolvingScopeNode`, round
 *     11, layered on round 8's `findDeclaringScopeNode` without changing it)
 *     → FAIL SAFE without attempting to resolve into that shadowing
 *     declaration, since doing so would return the WRONG (module-level)
 *     function with false confidence rather than an honest "unresolved" —
 *     see `resolveIdentifierValueThisReference`'s own doc comment for why
 *     fail-safe, not deeper resolution, is the chosen remedy; resolves
 *     in-file, UNSHADOWED, to a non-arrow function/method → check its body
 *     for `this`, same as the inline case; resolves in-file, UNSHADOWED, to
 *     an ARROW function → excluded, same reasoning as an inline arrow-valued
 *     pair above; does not resolve to any in-file function-shaped definition
 *     at all (imported, global, a non-function binding, or declared only in
 *     some OTHER scope that is neither the module root nor an ancestor of
 *     this object literal) → FAIL SAFE, treated as if it might contain
 *     `this`.
 *   - a `shorthand_property_identifier` (round 9, #2088 finding 1 — `{ run }`
 *     rather than `{ run: run }`) — the IDENTICAL identifier-resolution
 *     treatment as the bullet above (true since round 10 for the
 *     shadow/resolution ladder; as of round 11, #2088 finding 2, ALSO true
 *     again for the builtin gate, and now trivially so — with
 *     `isUnshadowedBuiltinGlobal` deleted, both arms share the exact same
 *     one-line `BUILTIN_GLOBALS.has(name)` check rather than two calls into
 *     one helper), keyed off the shorthand node's own text (a shorthand
 *     property's key and
 *     value name the same binding). This is not an incidental addition:
 *     shorthand properties are common enough that, without this bullet,
 *     round 9's inverted default just below would make EVERY object literal
 *     that uses one escape unconditionally — `shorthand_property_identifier`
 *     is a distinct tree-sitter node type from `pair` (verified:
 *     `collectObjectPropBindings`, `src/extractors/javascript.ts:4437`,
 *     already branches on it separately for the identical reason), so it
 *     needs its own explicit case rather than falling out of the `pair`
 *     handling above.
 *   - a `pair` whose value is a positively-safe non-function LITERAL or
 *     PRIMITIVE (`string`, `number`, `true`, `false`, `null`,
 *     `template_string`, `regex`, or a nested `array`/`object`) — safe not
 *     because it cannot contain a `this` token in its own text (a
 *     `template_string`'s `${…}` interpolation can), but because condition 4
 *     only cares whether invoking `T.key()` LATER can bind `this` to `T`,
 *     and none of these value shapes is itself directly callable: a
 *     `template_string`'s interpolation is evaluated EAGERLY, once, at
 *     object-construction time, in the SURROUNDING scope's own `this` (T
 *     does not exist yet), never creating a property invocable as `T.key()`
 *     later; and a nested `array`/`object` cannot itself be invoked as
 *     `T.key()` either — reaching a function nested inside it requires an
 *     extra property hop (`T.key[0]()`, `T.key.method()`) that rebinds the
 *     receiver to the nested value, never to `T`, so any `this` arbitrarily
 *     deep inside it can never resolve to `T` when called through `T`. See
 *     `isPositivelyThisFreeLiteral` below for the exact enumeration.
 *   - anything else — a `spread_element`, or a `pair` whose value is a
 *     `call_expression`, `parenthesized_expression`, `member_expression`,
 *     `as_expression`/`satisfies_expression`, a logical/ternary expression,
 *     or any other shape this function does not positively recognise —
 *     **round 9, #2088 finding 1: now escaping, not silently skipped.**
 *     Through round 8 this function fell through such a child with no
 *     branch taken at all, implicitly voting non-escaping — the exact
 *     inversion of every other condition's fail-closed default. Concretely:
 *     `const mixin = { run() { return this.alpha(); } }; const T = {
 *     alpha: fnA, ...mixin }; T.run();` — the `...mixin` `spread_element`
 *     matched no branch, `T.run()` is condition 3's only (tracked) reference
 *     to `T`, so the site read as local-closed while the spread-copied
 *     `run` method's `this.alpha()` produced zero correlated evidence,
 *     reporting `fnA` dead though `T.run()` calls it every time. `run:
 *     (function () { return this.alpha(); })` (`parenthesized_expression`)
 *     and `run: makeRunner()` (`call_expression`) are equivalent variants
 *     needing no second literal. The line-991-era "restrict to the simplest
 *     syntactic shape" precedent (#1771/#1784) previously cited to justify
 *     this silence governs *edge emission* — a recall choice about which
 *     resolutions to attempt — never a *safety predicate* about which shapes
 *     are proven harmless; this function no longer cites it for that
 *     purpose. Recall for these shapes is genuinely narrower than before
 *     this round (an object literal using object-spread, or any of the
 *     value shapes just listed, alongside a call the design would otherwise
 *     have correlated, now escapes and falls to T2) — tracked as a follow-up
 *     capability rather than silently accepted, per the Success Criteria
 *     note and #2624.
 *
 * Conservative exclusion, not correlation, for the shapes this function DOES
 * recognise as `this`-using — see condition 4's doc comment and #2618 for
 * the fuller design tradeoff that acceptance path takes.
 */
function literalHasUnmodeledThisReference(
  objectNode: TreeSitterNode,
  root: TreeSitterNode,
  definitionNames: ReadonlySet<string>,
): boolean {
  for (let i = 0; i < objectNode.childCount; i++) {
    const child = objectNode.child(i);
    if (!child) continue;

    if (child.type === 'method_definition') {
      if (subtreeContainsThisKeyword(child, 0)) return true;
      continue;
    }

    if (child.type === 'shorthand_property_identifier') {
      // Round 9 (#2088 finding 1) — see doc comment above for why this
      // needs the identical identifier-resolution treatment a `pair`'s
      // identifier value gets, rather than falling through to the
      // fail-closed default just below (which would otherwise make every
      // shorthand-using literal escape unconditionally). ROUND 11 (#2088
      // finding 2) — a builtin-named property escapes UNCONDITIONALLY,
      // full stop: `isUnshadowedBuiltinGlobal` (round 10) is deleted, since
      // it silently treated a builtin-named IMPORT as an unshadowed global
      // (`definitionNames` excludes imports by construction — see the
      // round-11 essay in `computeObjectLiteralSiteEscapes`'s doc comment).
      if (BUILTIN_GLOBALS.has(child.text)) return true;
      if (resolveIdentifierValueThisReference(objectNode, root, child.text, definitionNames)) {
        return true;
      }
      continue;
    }

    if (child.type === 'pair') {
      const value = child.childForFieldName('value');
      if (!value) return true; // malformed pair — fail safe, not silently skipped.
      if (value.type === 'arrow_function') continue; // never binds its own `this`.
      if (value.type === 'function_expression' || value.type === 'function') {
        if (subtreeContainsThisKeyword(value, 0)) return true;
        continue;
      }
      if (value.type === 'identifier') {
        // Round 7 (finding 3) — see doc comment above for the regression
        // this closes. Resolved and handled here directly (rather than
        // falling through to the fail-closed default below) because a
        // resolved arrow function must be excluded the same way an inline
        // arrow-valued pair already is. ROUND 11 (#2088 finding 2) — a
        // builtin-named value escapes UNCONDITIONALLY, exactly as it always
        // did through round 9 (`value.type === 'identifier' &&
        // !BUILTIN_GLOBALS.has(value.text)` — a builtin-named identifier
        // failed that guard and fell through to the fail-closed default
        // below). Round 10's `isUnshadowedBuiltinGlobal` briefly made this
        // arm ALSO skip resolution (vote safe) for a builtin name absent
        // from `definitionNames` — which silently included a builtin-named
        // IMPORT, since `definitionNames` excludes imports by construction
        // — turning a same-file shadow improvement into an unsound regression
        // for the import case. Reverted: see the round-11 essay in
        // `computeObjectLiteralSiteEscapes`'s doc comment for the
        // counter-example and why the fix is a revert, not a patch.
        if (BUILTIN_GLOBALS.has(value.text)) return true;
        if (resolveIdentifierValueThisReference(objectNode, root, value.text, definitionNames)) {
          return true;
        }
        continue;
      }
      if (isPositivelyThisFreeLiteral(value)) continue;
      // Round 9 (#2088 finding 1) — every other pair-value shape (a
      // `call_expression`, a `parenthesized_expression`, a
      // `member_expression`, an `as_expression`, a logical/ternary
      // expression, or anything else this function does not positively
      // recognise) is NOT proven `this`-free, so it now escapes rather
      // than being silently skipped. See the doc comment above for the
      // counter-example this closes.
      return true;
    }

    if (child.type === 'spread_element') {
      // Round 9 (#2088 finding 1) — a spread's own source object can carry
      // ANY property, including a method that references `this` (see the
      // `{ ...mixin }` counter-example in the doc comment above). Nothing
      // about `spread_element`'s own shape lets this function positively
      // rule that out, so it now escapes rather than being silently
      // skipped — previously it matched no branch at all.
      return true;
    }

    // Punctuation (`{`, `,`, `}`) and comments are not a property at all
    // and are never escaping.
  }
  return false;
}

/**
 * True for a `pair`-VALUE node whose own shape guarantees it can never
 * itself be invoked as `T.key()` with `this` bound to `T` later — condition
 * 4's only concern (round 9, #2088 finding 1). A positive allowlist, not a
 * negative denylist: a value type not in this set falls through to the
 * caller's fail-closed default, it is not treated as safe by omission. See
 * `literalHasUnmodeledThisReference`'s doc comment for why a `template_string`
 * (eager, once-only interpolation in the SURROUNDING scope's `this`, never
 * `T`'s) and a nested `array`/`object` (reaching a function inside one
 * requires an extra property hop that rebinds the receiver away from `T`)
 * are both included despite not being JS primitives in the strict sense.
 */
function isPositivelyThisFreeLiteral(value: TreeSitterNode): boolean {
  return (
    value.type === 'string' ||
    value.type === 'number' ||
    value.type === 'true' ||
    value.type === 'false' ||
    value.type === 'null' ||
    value.type === 'template_string' ||
    value.type === 'regex' ||
    value.type === 'array' ||
    value.type === 'object'
  );
}

/**
 * ROUND 11 (#2088 finding 1) — resolution-path counterpart of round 8's
 * `findDeclaringScopeNode`, used ONLY by `resolveIdentifierValueThisReference`
 * below. `allReferencesTracked`'s own call to `findDeclaringScopeNode`
 * (condition 3's reference-walk boundary, #2260) is a DIFFERENT question and
 * is UNCHANGED by this function's existence — `findDeclaringScopeNode` and
 * `findDeclaringScopeLine` keep exactly the semantics round 8 gave them.
 *
 * `findDeclaringScopeNode` walks ancestors testing `introducesShadowedBinding`,
 * whose switch has no case for `for_in_statement` — DELIBERATELY: its own
 * doc comment (`src/extractors/javascript.ts:4610-4614`, on the
 * `SCOPE_NODE_TYPES` constant it is checked against) explains that a
 * `for (… of right)` head binding must not prune `allReferencesTracked`'s
 * reference walk, because `right` is evaluated in the ENCLOSING scope and
 * pruning the node would lose a genuine read there —
 * `blockContainsIdentifierExcluding` handles that shape directly instead.
 * That reasoning is specific to the reference-WALK question and does not
 * hold for the resolution question asked here: whether `name`, AT THE
 * OBJECT LITERAL'S OWN LEXICAL POSITION, refers to a for-of/for-in loop
 * variable rather than to whatever `findTopLevelFunctionNodeByName` would
 * find at module level. A loop-head binding shadows exactly like any other
 * scope's binding for THIS question. See the round-11 essay in
 * `computeObjectLiteralSiteEscapes`'s doc comment for the counter-example
 * this closes.
 *
 * Fixed by ORing one extra disjunct onto the same ancestor walk, checked
 * ONLY here: does some `for_in_statement` ancestor's own `left` field bind
 * `name`, using `patternBindsName` — the exact primitive
 * `blockContainsIdentifierExcluding`'s own for-in branch
 * (`src/extractors/javascript.ts:5197-5199`) already uses for this identical
 * field. `SCOPE_NODE_TYPES` and `introducesShadowedBinding` are not touched
 * by this function — it layers on top of them without altering what they
 * mean for #2260's own, already-verified-sound callers.
 *
 * ROUND 12 (#2088 finding 1) — a SECOND disjunct, independent of the for-in
 * one above and closing a different gap in the same underlying primitive.
 * `introducesShadowedBinding`'s shared function-shape case
 * (`function_declaration`/`function_expression`/`generator_function_declaration`/
 * `generator_function`/`arrow_function`/`method_definition`,
 * `src/extractors/javascript.ts:4694-4712`) reads only
 * `node.childForFieldName('parameters')` — the PLURAL field tree-sitter
 * populates for a parenthesized parameter list (`(run) => {…}`,
 * `formal_parameters`). A BARE, unparenthesized single-identifier arrow
 * parameter (`run => {…}`) is carried in a DIFFERENT, singular `parameter`
 * field instead — verified directly against `tree-sitter-javascript@0.25.0`'s
 * own `node-types.json`: `arrow_function` declares `parameter` (type
 * `identifier`) and `parameters` (type `formal_parameters`) as two mutually
 * exclusive optional fields — which the shared case never reads at all, even
 * though the `catch_clause` case immediately below it
 * (`javascript.ts:4713-4716`) already reads that identical singular field
 * name for its own exception binding, confirming the field is neither
 * unknown to this file nor to this switch's own author. Concretely:
 *
 * ```js
 * function fnA() { return 1; }
 * function run() { return 0; }                 // module-level decoy, this-free
 * const make = run => {                        // bare param shadows module `run`
 *   const T = { alpha: fnA, run };
 *   return T.run();                            // → this.alpha() → fnA()
 * };
 * make(function () { return this.alpha(); });
 * ```
 *
 * `run`'s declaring scope for THIS question is the arrow function itself —
 * but `introducesShadowedBinding`'s shared case checks only `parameters`,
 * finds it `null` for this shape, finds no `var` in the body either, and
 * returns `false`; the walk (pre-round-12) continues past the arrow, reaches
 * `program`, and returns `undefined`; `?? root` then makes
 * `declaringScope === root`, and `findTopLevelFunctionNodeByName` resolves to
 * the OUTER, `this`-free decoy with full confidence — the identical failure
 * mode the for-in disjunct above closes, for a different AST shape. Fixed
 * the same way: ORing a THIRD disjunct onto the same walk, checked ONLY
 * here — does the current ancestor's own `parameter` field (singular)
 * text-match `name` — introducing no new primitive, just a direct field read
 * and text comparison. `introducesShadowedBinding` and `SCOPE_NODE_TYPES`
 * are, again, deliberately NOT widened: `introducesShadowedBinding`'s OWN
 * blind spot to this same field is a separate, pre-existing gap in a
 * reference-walk primitive `allReferencesTracked` also depends on (condition
 * 3, #2260) — filed separately (#2629) rather than fixed here, since
 * widening it would touch that already-verified-sound walk too, exactly the
 * risk round 11 (above) already declined to take for the for-in case.
 */
function findResolvingScopeNode(node: TreeSitterNode, name: string): TreeSitterNode | undefined {
  let current: TreeSitterNode | null = node.parent;
  while (current) {
    if (current.type === 'for_in_statement') {
      const left = current.childForFieldName('left');
      if (left && patternBindsName(left, name)) return current;
    }
    if (current.type === 'arrow_function') {
      const param = current.childForFieldName('parameter');
      if (param && param.text === name) return current;
    }
    if (introducesShadowedBinding(current, name)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * Round 7 (#2088 finding 3) — resolve a plain identifier that is the value
 * of an object-literal pair (or, round 9, a shorthand property) to the
 * same-file function it names, and report whether that function's body
 * contains `this`. FOUR-way fail-safe structure as of round 10 (three-way
 * through round 9) — see `literalHasUnmodeledThisReference`'s doc comment
 * for the full argument; this function implements exactly those branches
 * and nothing else.
 *
 * `objectNode` (round 10, #2088 finding 1) is the object-literal node this
 * identifier is a property VALUE of — never the identifier node itself —
 * threaded through purely so `findResolvingScopeNode` can walk OUTWARD from
 * the literal's own lexical position, below. This is a SIMILARLY SHAPED
 * reuse of the ancestor-walk primitive round 8's `allReferencesTracked`
 * boundary uses (`findDeclaringScopeNode`), for a RELATED but not identical
 * purpose: round 8 bounds a REFERENCE WALK to one scope, deliberately
 * excluding a `for_in_statement` head binding from ever pruning that walk
 * (see `findResolvingScopeNode`'s own doc comment, just above, for why);
 * this disambiguates WHICH declaration an identifier resolves to, for which
 * a `for_in_statement` head binding shadows exactly like any other scope's.
 * **Round 11 (#2088 finding 1) found that this plan's earlier claim —
 * "both questions reduce to the same one... which is why both reuse
 * `findDeclaringScopeNode`" — was false as stated**, precisely because of
 * this divergence: the two questions are related, not identical, so this
 * function now calls its OWN thin wrapper, `findResolvingScopeNode`, rather
 * than sharing `findDeclaringScopeNode` outright — which would either widen
 * `SCOPE_NODE_TYPES` for `allReferencesTracked`'s own purpose (reopening the
 * genuine read its exclusion protects) or leave this function's resolution
 * question under-covered (the original round-10 bug). See
 * `findResolvingScopeNode`'s own doc comment for the counter-example this
 * closes.
 *
 * `definitionNames` is this file's own definition names — built the same
 * way `points-to.ts` already builds its own `definitionNames` from
 * `symbols.definitions` (`new Set(definitions.map((d) => d.name))`), just
 * computed here in the extractor since this post-pass runs before the
 * file's `ExtractorOutput` (and hence `symbols.definitions` as the solver
 * sees it) is assembled. It is a cheap existence pre-filter for the common
 * case (an imported or global identifier) that lets this function skip the
 * AST search below entirely; `findTopLevelFunctionNodeByName`'s own
 * structural checks are what actually confirm a function shape, so the two
 * checks are intentionally layered rather than either one alone being load
 * bearing — the same defense-in-depth relationship the `MAX_WALK_DEPTH` cap
 * already has with the (structurally acyclic) rebinding recursion below.
 *
 * > **ROUND 10 (#2088 finding 1) — why fail safe, rather than fully
 * > resolve, when a shadowing scope is found.** A more complete fix would
 * > resolve `name` INSIDE the shadowing scope `findResolvingScopeNode`
 * > (round 8's `findDeclaringScopeNode` through round 10; see that
 * > function's own doc comment for why round 11 layers a thin wrapper on
 * > top rather than widening it) finds and check THAT declaration's own
 * > body for `this`, preserving
 * > correlation for a shadowing function that itself happens to be
 * > `this`-free. This function deliberately does not: doing so would mean
 * > generalising `findTopLevelFunctionNodeByName`'s declaration-shape
 * > matching to run against an ARBITRARY block/function scope rather than
 * > only `program`'s direct children — a second AST-search shape to keep
 * > correct, in both engines, for a pattern (`{ run }` shadowing a
 * > same-named module-level sibling) the `#1771`/`#1784` "restrict to the
 * > simplest syntactic shape" precedent was never asked to cover. Failing
 * > safe costs recall only for the narrow case where the shadowing
 * > declaration is itself `this`-free — filed as a follow-up rather than
 * > silently accepted; see Success Criteria and #2625.
 */
function resolveIdentifierValueThisReference(
  objectNode: TreeSitterNode,
  root: TreeSitterNode,
  name: string,
  definitionNames: ReadonlySet<string>,
): boolean {
  if (!definitionNames.has(name)) return true; // not a same-file definition at all — fail-safe.

  // ROUND 10 (#2088 finding 1) — resolve OUTWARD from the object literal's
  // own lexical position BEFORE ever consulting the module-level-only
  // search below. When some scope strictly between `objectNode` and the
  // module root ALSO declares `name`, that closer declaration — not
  // whatever `findTopLevelFunctionNodeByName` would find at module level —
  // is what `name` actually refers to at `objectNode`'s position, and
  // searching the module level anyway would return a CONFIDENTLY WRONG
  // node rather than this function's own promised "unresolved" fail-safe.
  // ROUND 11 (#2088 finding 1) — via `findResolvingScopeNode`, not
  // `findDeclaringScopeNode` directly, so a `for...of`/`for...in` loop-head
  // shadow is ALSO caught here (see that function's own doc comment for the
  // counter-example this closes), without widening what
  // `allReferencesTracked` itself treats as a shadow for its own, different
  // purpose. See this function's own doc comment for why fail-safe, not
  // deeper resolution, is the chosen remedy once a shadow is found.
  const declaringScope = findResolvingScopeNode(objectNode, name) ?? root;
  if (declaringScope !== root) return true; // shadowed by a non-module scope — fail-safe.

  const fnNode = findTopLevelFunctionNodeByName(root, name);
  if (!fnNode) return true; // no module-level declaration of this name exists at all — fail-safe.

  if (fnNode.type === 'arrow_function') return false; // never binds its own `this`.
  return subtreeContainsThisKeyword(fnNode, 0);
}

/**
 * Bounded, MODULE-LEVEL-ONLY resolution of a plain identifier to the
 * function node it names — a "restrict to the simplest syntactic shape"
 * precedent (#1771/#1784), applied one hop through an identifier. Unwraps
 * one leading `export_statement` (`export function f(){}` / `export const
 * f = …` are still module-level declarations).
 * Returns the `function_declaration` node itself (its own subtree is what
 * `subtreeContainsThisKeyword` searches) or a `variable_declarator`'s
 * `value` node (`arrow_function`, `function_expression`, or `function`) —
 * never a declaration nested inside a block, matching `resolveSiteOwner`'s
 * own module-level bias. Returns `null` when NO module-level declaration of
 * `name` exists at all — a class, a plain variable, an import, or a name
 * declared only inside some block/function this search never looks inside —
 * which `resolveIdentifierValueThisReference` above treats as fail-safe.
 *
 * > **ROUND 10 (#2088 finding 1) corrects a backstop claim this doc
 * > comment made through round 9 that did not actually hold.** It used to
 * > claim this function's `null` return was ALSO the backstop for a
 * > nested-past-module-scope declaration — i.e. that when `name` is
 * > declared only inside some block or function, this search's inability to
 * > see it would surface as `null`, which the caller already treats as
 * > fail-safe. That is true ONLY when no module-level declaration of `name`
 * > exists at all. It is false the moment a module-level declaration of the
 * > SAME name ALSO exists, shadowed at the reference's own lexical position
 * > by a closer, non-module declaration: this function has no way to know
 * > shadowing occurred, so it confidently returns the (wrong,
 * > out-of-lexical-scope-at-that-position) module-level node instead of
 * > `null` — a CONFIDENTLY WRONG answer, not an honest "unresolved" one,
 * > and strictly worse than the fail-safe this doc comment claimed
 * > backstopped it. Concretely: `function run() { return 0; }`
 * > (module-level, `this`-free) shadowed by `function install() { function
 * > run() { return this.alpha(); } const T = { alpha: fnA, run };
 * > T.run(); }` — this function returns the OUTER, `this`-free `run`,
 * > `subtreeContainsThisKeyword` finds nothing, `resolveIdentifierValueThisReference`
 * > reads `run` as safe, and `fnA` is reported dead though `T.run()`
 * > invokes it via the INNER, `this`-using `run` every time. Greptile
 * > flagged exactly this shape against this plan ("Shadowed handler
 * > resolves incorrectly"). Fixed not here but in the CALLER: as of round
 * > 10, `resolveIdentifierValueThisReference` checks a declaring-scope
 * > helper BEFORE ever calling this function, and fails safe outright
 * > whenever that returns a non-module scope — so by the time this
 * > function's own module-level search runs, `name` is already known to
 * > have no CLOSER, shadowing declaration relative to the object literal,
 * > and this function's `null` return is once again an honest "no
 * > module-level declaration of this name exists at all," restoring the
 * > backstop this doc comment always intended to describe. This function's
 * > own body is UNCHANGED by round 10 — it was never the bug; the caller's
 * > missing precondition was. (ROUND 11: that declaring-scope helper is now
 * > `findResolvingScopeNode`, not `findDeclaringScopeNode` directly — round
 * > 10's own check missed a `for...of`/`for...in` loop-head shadow, which
 * > `findResolvingScopeNode` additionally covers; see that function's own
 * > doc comment. The backstop argument here is unaffected either way: this
 * > function's `null` return is honest exactly when the caller has already
 * > ruled out every kind of closer shadow, and round 11 only widens what
 * > "every kind" means.)
 */
function findTopLevelFunctionNodeByName(root: TreeSitterNode, name: string): TreeSitterNode | null {
  for (let i = 0; i < root.childCount; i++) {
    let stmt = root.child(i);
    if (stmt?.type === 'export_statement') {
      stmt = stmt.childForFieldName('declaration') ?? stmt.child(1);
    }
    if (!stmt) continue;
    if (stmt.type === 'function_declaration') {
      if (stmt.childForFieldName('name')?.text === name) return stmt;
      continue;
    }
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      for (let j = 0; j < stmt.childCount; j++) {
        const decl = stmt.child(j);
        if (decl?.type !== 'variable_declarator') continue;
        if (decl.childForFieldName('name')?.text !== name) continue;
        const value = decl.childForFieldName('value');
        if (
          value &&
          (value.type === 'arrow_function' ||
            value.type === 'function_expression' ||
            value.type === 'function')
        ) {
          return value;
        }
      }
    }
  }
  return null;
}

/**
 * Depth-capped `this`-node search used only by
 * `literalHasUnmodeledThisReference`. Reuses `MAX_WALK_DEPTH`, the same cap
 * `blockContainsIdentifierExcluding` already uses (`javascript.ts:5053`) —
 * but INVERTS its truncation default. `blockContainsIdentifierExcluding`
 * fails toward "not found" on truncation because that keeps ITS caller's
 * liveness evidence conservative; here the safe direction is the opposite
 * one, because "contains `this`" is what drives `escapes: true`. Failing
 * toward "not found" on truncation would let a pathologically deep method
 * body read as safe by omission — the wrong side of the fail-safe/fail-open
 * asymmetry this whole design is built on.
 */
function subtreeContainsThisKeyword(node: TreeSitterNode, depth: number): boolean {
  if (depth >= MAX_WALK_DEPTH) return true;
  if (node.type === 'this') return true;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && subtreeContainsThisKeyword(child, depth + 1)) return true;
  }
  return false;
}
```

`resolveSiteOwner` reuses the existing walk SHAPE of `findEnclosingTableName` (variable-declarator lookup through `TABLE_NAME_PASSTHROUGH_TYPES`) — the traversal only, never `findEnclosingTableName`'s return-value construction — extended with two extra cases — `array` parent → `` `${arrayVarName}[*]` `` (the pts key `buildArrayElemConstraints` already produces), and `return_statement` parent → `` `${enclosingFnName}::return` ``.

> **`resolveSiteOwner`'s return contract, stated explicitly** (round-7 critic finding, #2088 finding 5 — the previous draft left this implicit, which is itself the bug; ROUND 8, #2088 finding 2, extends it one guarantee further): `resolveSiteOwner(objectNode): { key: string; bindingName: string | null } | null`.
> - `key` is the pts-constraint LHS `buildObjectLiteralSiteConstraints` (WU-4) flows this site's pts fact into, and is also what `entry.owner` is set to, verbatim, regardless of owner kind: the bare variable name for a direct binding (`const T = {…}` → `"T"`), the array-element wildcard key for an array element (`const A = [{…}]` → `"A[*]"`), or the scoped return key for a returned literal (`return {…}` inside `f` → `"f::return"`). This is the ONLY field the points-to solver (WU-4) or T1's evidence matching (WU-5b) ever reads — both work purely in terms of site tokens and pts facts, never by textually matching a binding name.
> - `bindingName` is **always the bare declarator identifier** that `allReferencesTracked` walks the binding's declaring scope for, and **never** carries a `[*]` or `::return` suffix (round-7, finding 5) — **nor, round 8 (finding 2), a `#${scopeLine}` disambiguating suffix either**: it is always `nameNode.text` read directly off the `variable_declarator`'s `name` field, never the string `findEnclosingTableName` itself would return for that same declarator. `findEnclosingTableName` (`src/extractors/javascript.ts:4513-4528`) appends exactly that suffix — `` `${nameNode.text}#${scopeLine}` `` — for any declaration scoped inside a block, via `findDeclaringScopeLine`; `resolveSiteOwner` must stop at `nameNode.text` and never call through to that suffix-appending return construction, precisely because `bindingName` is consumed as an AST SEARCH TARGET (`allReferencesTracked` looks for identifier nodes whose `.text` equals it), not as a human-readable disambiguating label the way `findEnclosingTableName`'s result is. Concretely: `"T"` for a direct binding regardless of what scope it's declared in, `"A"` (never `"A[*]"`) for an array element, or `null` for a return-owner (there is no binding at all to scan — condition 1 already makes every return-owner escape unconditionally, before condition 3 ever runs `allReferencesTracked`). This is unrelated to, and must never be confused with, `Call.receiver` (set by the pre-existing, UNCHANGED `collectObjectLiteralValueRefCall` as `findEnclosingTableName(pairNode)` — see WU-2's implementation above): `receiver` is #2260's own T3 (`computedDispatchTableEvidence`) matching key and is EXPECTED to keep its `#line` suffix, since T3 disambiguates by exactly that string; `bindingName` is WU-2b's own escape-analysis input and must NOT carry it. Two different fields, two different consumers, two different rules — round 8 exists because an earlier draft let them blur.
> - The two fields are EQUAL (`key === bindingName`) for exactly one owner kind — direct binding — and differ for exactly one other — array element (`"A[*]" !== "A"`). This is what `isArrayOwner = owner.key !== owner.bindingName` (condition 3, above) relies on, and it is why `bindingName` cannot be left to be "whatever seems natural": were it ever `"A[*]"` instead of `"A"`, or ever `"T#7"` instead of `"T"`, `allReferencesTracked` would search the AST for an identifier literally spelled `A[*]` or `T#7` — text that can never appear as identifier syntax — find zero surviving references for every affected site, and read that vacuous walk as non-escaping. Round 8 (see the withdrawal of round 7's vacuous-truth conclusion, above) is precisely why this can no longer be waved away as "vacuous truth is always fine": a search that structurally can never match anything is not an exhaustive, PROVEN-COVERED search — it is a broken one, and must be treated as unproven, not as a trivial pass. This would silently bypass condition 2's export check for every affected site, exported or not, and (for the `A[*]` case specifically) would also make `isArrayOwner` permanently `false`, silently bypassing round 7 finding 1's fix at the same time. Both failure modes are why WU-10 adds a dedicated `export const A = [{…}]` regression case (below) rather than trusting this contract to prose alone.

> **ROUND 8 (#2088 finding 1) — `allReferencesTracked`'s search boundary.** New helper `findDeclaringScopeNode(node: TreeSitterNode, name: string): TreeSitterNode | undefined` — the node-returning counterpart of the existing `findDeclaringScopeLine` (`src/extractors/javascript.ts:4484-4491`), which now becomes a thin wrapper over it (`return findDeclaringScopeNode(node, name)?.startPosition.row;`) so the two functions can never silently disagree about what "the declaring scope" is for the same node. `allReferencesTracked(root, bindingName, objectNode, isArrayOwner, declaringScope?)` gains an optional trailing parameter: on the TOP-level call (from `computeObjectLiteralSiteEscapes`, which never passes it), the function computes it once, `findDeclaringScopeNode(objectNode, bindingName) ?? root` — `root` covers module scope, since `introducesShadowedBinding` has no case for `program` and always returns `false` for it (confirmed at `javascript.ts:4813-4814`), exactly the property that let every module-scope WU-10 fixture pass by accident before this fix existed. On every RECURSIVE call (rebinding alias, for-of loop variable — below), this SAME node is threaded through unchanged as the explicit argument, never recomputed from the alias/loop-variable's own position: that position is not necessarily an ancestor of `objectNode`, so re-deriving the boundary from it would walk the wrong ancestor chain. This is always safe, never merely convenient: any binding reachable ONLY through a reference to the original site (an alias, a loop variable) must itself be declared somewhere lexically inside the original site's own declaring-scope subtree, or it could never have seen `bindingName` in scope to reference it in the first place — so the fixed boundary is never too narrow for a recursive check, only ever exactly as wide as it needs to be.

`allReferencesTracked` walks the DESCENDANTS of that one declaring scope (never the whole file, and never a scope wider than the site could actually be referenced from) for identifier nodes whose text equals the name currently being checked, skipping the declaration itself and any node under a NESTED scope that shadows the name — reusing `introducesShadowedBinding`, the hardened shadow detection already written for #2257 and already used by `findDeclaringScopeLine` — with exactly ONE exemption: the shadow-check is never applied to the fixed `declaringScope` node itself, at any recursion level, for any name. That exemption is not optional polish; it is the fix. `introducesShadowedBinding`'s own `statement_block` case returns `true` for a block that DIRECTLY declares the checked name (`src/extractors/javascript.ts:4744-4771`) — correct signal for a nested scope encountered deeper in the walk, but always true, vacuously, of the declaring scope itself, which is exactly why applying the check there uniformly self-shadows. `hasLaterReferenceInEnclosingBlock` (`src/extractors/javascript.ts:5393-5435`) already documents this identical trap for its own, narrower (single-block, first-match) search and already works around it by scanning the block's CHILDREN rather than the block itself (`javascript.ts:5411-5415`'s own comment: "running the shadow check... on the block itself would always find that declaration and wrongly treat the whole block as shadowed"); this fix generalises the SAME carve-out from "one block's direct children, stop at the first match" to "one scope's full recursive descendant subtree, collect every match." `allReferencesTracked`'s signature is `allReferencesTracked(root, bindingName, objectNode, isArrayOwner, declaringScope?): boolean`, where `isArrayOwner` is threaded straight into every `isTrackedReferencePosition(refNode, isArrayOwner)` call for this walk's references — see condition 3 above for where the initial value comes from and how it changes across the two recursive branches below.

> **The non-vacuous-coverage requirement (ROUND 8, #2088 finding 1 — the structurally important half).** `allReferencesTracked` returns `true` only when BOTH: (1) the walk is PROVEN exhaustive over the declaring scope's subtree — it did not truncate at `MAX_WALK_DEPTH` anywhere within it; AND (2) every reference the (proven-exhaustive) walk found satisfies `isTrackedReferencePosition`, or is accepted on a recursive branch that ALSO satisfies this same two-part contract. Either an unproven walk OR a disqualifying reference makes the result `false` (escaping) — there is no third, "we're not sure, but let's call it safe" outcome. This is a STANDING RULE about the function's return contract, not a special case bolted onto the vacuous-empty-set scenario specifically: it applies identically whether the surviving set is empty, has one reference, or has a hundred. Getting this wrong toward "unproven ⇒ escapes" costs recall — the same asymmetry every other fail-safe default in this design accepts; getting it wrong the other way is precisely the class of bug this rule exists to catch structurally, in every FUTURE change to this walk, not only in the one instance found this round.

> **The rebinding branch recurses — accepting the `const u = T` reference is not enough on its own** (round-4 critic finding). `allReferencesTracked` must additionally hold, recursively, for the new alias name, with `isArrayOwner` UNCHANGED and `declaringScope` UNCHANGED (`allReferencesTracked(root, aliasName, objectNode, isArrayOwner, declaringScope)`) — an alias of the CONTAINER is still the container, not a single element, so it must keep whatever `isArrayOwner` value the site already has, and (round 8) the search boundary established for the original binding, since `u`'s own declaration is necessarily somewhere inside that same subtree (see the `findDeclaringScopeNode` note above) — or a site reads as local-closed while it can still escape through `u` — e.g. `const u = T; importedFn(u)`. The `name` field of the `variable_declarator` must itself be a plain `identifier`; a destructuring `name` such as `const { k } = T` is rejected the same way `findEnclosingTableName` already does, since destructuring extracts a property rather than aliasing the reference. The first cut of this branch (round-3) checked only the reference to `T` and never followed where `u` goes; that is exactly the same shape of gap condition 1 already documents for a return-captured binding, one alias hop later. The recursion depth is capped at 6, reusing `findEnclosingTableName`'s own `hops` bound rather than inventing a new one — a chain of `const a = T; const b = a; const c = b; …` cannot cycle (each step names a fresh `const` binding), so the cap is defense-in-depth, not a correctness requirement. A recursive call returning `false` — including by hitting the cap, and, as of round 8, by failing its own non-vacuous-coverage requirement — makes that reference, and so the whole site, escaping; it is not a partial result the other branches paper over. Coverage composes the same way: the OUTER call is proven-covered only if every recursive call it makes is also proven-covered.
>
> **The for-of branch ALSO recurses, into the loop variable — the same principle, one binding further** (round-7 critic finding, #2088 finding 2). Accepting `A`'s reference in `for (const r of A) …` on `isTrackedReferencePosition`'s `for_in_statement` branch is not enough on its own: `r` is a brand-new binding, and this analysis must follow it exactly as it follows a rebinding alias, or a site reads as local-closed while it can still escape through `r` — e.g. `for (const r of A) sink(r)` with `sink` imported (or local — the parameter-passing exclusion in condition 3 does not care which). Concretely: when a for-of-parented reference passes `isTrackedReferencePosition`, `allReferencesTracked` extracts the loop variable's name using the exact same shape `collectForOfBinding` itself already requires before it will emit a `forOfBindings` entry at all (a `variable_declarator`'s plain-`identifier` `name` field, or a bare pre-declared `identifier` `left` with no declaration keyword) and, ONLY when that yields a single plain identifier, requires `allReferencesTracked(root, loopVarName, objectNode, false, declaringScope)` to also hold — the SAME fixed `declaringScope` from the outer call, per the round-8 note above, never recomputed from `r`'s own position — under the same depth-6 cap shared with the rebinding recursion above, and the same non-vacuous-coverage requirement — `isArrayOwner` is hardcoded `false` for this recursive call regardless of the outer site's own `isArrayOwner`, because a for-of loop variable always denotes a single ELEMENT of the array, never the array itself, so `r.matches(...)`/`r.resolve(...)` must be checked as direct-binding-shaped member calls (see WU-10's re-verification of its own handler-array shape against this exact rule, condition 3 above). When the loop variable's shape is anything OTHER than a single plain identifier — most notably a destructuring pattern, `for (const { matches } of B) matches(x)` — the reference to `A`/`B` is REJECTED outright on this branch, full stop, with no recursive call to attempt at all: `collectForOfBinding` never emits a `forOfBindings` entry for a destructured loop variable (verified: it requires the declarator's `name` field to be a plain `identifier`), so nothing seeds a points-to fact for `matches` here, and `matches(x)` can never be a correlated call on a receiver pointing at `B`'s site no matter how `B` is referenced elsewhere — treating the reference as tracked regardless would silently reopen this exact gap for every destructuring for-of. Filed as a follow-up capability, the array-element analogue of #2620's bare-property-read gap — #2622.
>
> **Why walk for references rather than reuse `blockContainsIdentifierExcluding`:** that helper answers "does this block contain a reference at all", which is the wrong question here — we need to classify *every* reference's position, not detect the first one. The shadow-detection primitive is shared; the traversal is not. (Round 8: this is also why `blockContainsIdentifierExcluding`'s OWN `MAX_WALK_DEPTH` truncation — which fails toward "not found," i.e. toward NOT flagging a problem — is not reused here unmodified: `allReferencesTracked` needs to know not just "was a disqualifying reference found" but "did the search even finish," which `blockContainsIdentifierExcluding`'s boolean return conflates. The non-vacuous-coverage requirement above is what keeps that conflation from becoming a silent false-negative once this design's own walk hits the same cap.)

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
 * fnRefBindings) and for-of over an array of literals (via forOfBindings ⊇
 * `A[*]`) — comes for free from constraints that already exist. That is the
 * whole reason those two shapes land in the existing solver instead of a
 * bespoke matcher.
 *
 * Parameter flow (`f(T)`) does NOT come for free in the same sense:
 * `buildParamFlowConstraints` (Phase 8.3c) still propagates
 * `pts(callee::paramName) ⊇ pts(argName)` for a site token exactly as it
 * does for any other value, but that propagation has no escape check of its
 * own and is documented "Scope: intra-module only". WU-2b's escape analysis
 * (condition 3) treats a bare-identifier argument to a function as escaping
 * regardless, so a site reached only through a parameter never becomes
 * `localClosed` and always resolves on T2 — the solver constraint is
 * harmless but unused for this purpose. Extending correlation to this shape
 * by recursing into the callee's own body is filed as a follow-up (#2617),
 * not attempted here.
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

**(a) `collectInvokedPropertySites` in `call-resolver.ts`,** the receiver-correlated sibling of `collectInvokedPropertyNames`. Note that `collectInvokedPropertyNames` itself is **left exactly as it is** — it remains the fallback tier, and changing it would change behavior for escaping sites.

> **Pass ordering (ROUND 9, #2088 finding 2) — load-bearing, not incidental.** `collectInvokedPropertyNames` and `computedDispatchTableEvidence` are pure name/file aggregations over `fileSymbols` — resolving them needs no points-to information at all, which is exactly why `buildCallEdgesJS` builds both of them ONCE, up front, at `build-edges.ts:1350-1373`, **before** the existing per-file loop that builds each file's own points-to map via `buildPointsToMapForFile` (`build-edges.ts:1425`). `collectInvokedPropertySites` cannot be slotted into that same pre-loop position unchanged: resolving a call's receiver through the points-to map is inherently a PER-FILE operation — a receiver variable can only be resolved against the points-to map for the file its own call sits in — and no such map exists yet, for ANY file, at the point `invokedPropertyNames`/`computedDispatchTableEvidence` are assembled. A builder who reads this WU's doc-comment framing ("the receiver-CORRELATED counterpart of `collectInvokedPropertyNames`") as license to slot it into the identical pre-loop position, closing `resolveReceiverSites` over whatever `ptsMap` binding happens to be lexically nearest, gets code that either fails to compile (no `ptsMap` in scope yet) or — worse, because it WOULD compile and pass every single-file fixture in WU-10 — silently resolves every file's calls against one arbitrary file's map (e.g. whichever file's `ptsMap` a hoisted variable last held), under-populating `correlated` for every other file and reporting some of their sites' properties dead. `buildCallEdgesJS` is therefore restructured into three passes, not two:
>
> 1. **Pts pre-pass.** For every file, call `buildImportedNamesMap` and `buildPointsToMapForFile` exactly once each and cache both results, keyed by `relPath`:
>    ```ts
>    const importedNamesByFile = new Map<string, ReturnType<typeof buildImportedNamesMap>>();
>    const ptsMapsByFile = new Map<string, PointsToMap>();
>    for (const [relPath, symbols] of fileSymbols) {
>      if (barrelOnlyFiles.has(relPath)) continue;
>      const importedNames = buildImportedNamesMap(ctx, relPath, symbols, rootDir);
>      importedNamesByFile.set(relPath, importedNames);
>      ptsMapsByFile.set(
>        relPath,
>        buildPointsToMapForFile(symbols, importedNames.importedNames, ctx.config.analysis.pointsToMaxIterations),
>      );
>    }
>    ```
> 2. **Evidence pass.** Assemble `nonEscapingSites` — a pure per-file read of each file's own already-extracted `objectLiteralSites`, needing no points-to information, so it may run in either order relative to pass 1:
>    ```ts
>    const nonEscapingSites = new Set<string>();
>    for (const [relPath, symbols] of fileSymbols) {
>      for (const site of symbols.objectLiteralSites ?? []) {
>        if (!site.escapes) nonEscapingSites.add(objectLiteralSiteKey(relPath, site.site));
>      }
>    }
>    ```
>    — and `correlated`, via `collectInvokedPropertySites`, now reading `ptsMapsByFile` instead of a single closed-over map (signature below).
> 3. **Edge-resolution pass.** The existing per-file loop, unchanged in shape, now reading `importedNamesByFile.get(relPath)!` / `ptsMapsByFile.get(relPath)!` instead of recomputing either — both to avoid computing each exactly twice, and, more importantly, so `resolveFallbackTargets` never runs for any file before `correlated`/`nonEscapingSites` are fully assembled across every file.
>
> This ordering requirement holds regardless of how many files a given site's OWN correlation actually spans — see the two-file WU-10 fixture below for why it must be tested with more than one file even though a single non-escaping site's own evidence is always intra-file (condition 2 forces any genuinely cross-file reference to be exported, hence escaping, hence T2 — see WU-2b). Mirrored on the Rust side by WU-8's own pass-ordering note, since `EdgeContext::new` aggregates `invoked_property_names`/`computed_dispatch_table_evidence` globally in the identical "before any file's points-to map exists" position.

`collectInvokedPropertySites` is therefore keyed by file from the start, not a flattened call list — the Interface Definitions section above states the same signature:

```ts
/**
 * #2088 — the receiver-CORRELATED counterpart of
 * `collectInvokedPropertyNames`. For every member call `x.name(...)`, resolve
 * `x` through the points-to map for the FILE THAT CALL IS IN to the
 * object-literal allocation sites it may refer to, and record
 * `${siteKey}|${name}` for each.
 *
 * Where `collectInvokedPropertyNames` answers "was this property name ever
 * invoked ANYWHERE", this answers "was this property invoked on THIS literal" —
 * the correlation the #2034 review asked for and that #1895's coarse
 * "one hop further" heuristic deliberately left out.
 *
 * Value-ref calls are excluded for the same reason they are excluded there: a
 * value-ref is a bare VALUE reference, never an invocation.
 *
 * Unlike `collectInvokedPropertyNames`, this function is keyed by file, not a
 * flattened `Iterable<Iterable<Call>>` — see the pass-ordering note above for
 * why: `resolveReceiverSites` must dispatch to the points-to map for the
 * SAME file a given call belongs to, so the caller (and this function) must
 * know which file each call came from, not just have an undifferentiated
 * stream of calls.
 */
export function collectInvokedPropertySites(
  fileCalls: ReadonlyMap<string, Iterable<{ name: string; receiver?: string; dynamicKind?: string | null; callerName?: string | null }>>,
  resolveReceiverSites: (relPath: string, receiver: string, callerName: string | null) => ReadonlyArray<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const [relPath, calls] of fileCalls) {
    for (const call of calls) {
      if (!call.receiver || call.dynamicKind === 'value-ref') continue;
      for (const siteKey of resolveReceiverSites(relPath, call.receiver, call.callerName ?? null)) {
        keys.add(correlatedEvidenceKey(siteKey, call.name));
      }
    }
  }
  return keys;
}
```

The `resolveReceiverSites` adapter passed in by `buildCallEdgesJS` tries the scoped pts key first, then the bare one, against the CALLING file's own cached map. This is the same caller-scoped-then-bare shape `resolveReceiverEdge` already uses against `typeMap`, in this same file (`call-resolver.ts:773-775`) — a shape `build-edges.ts:2123`'s CHA-expansion block explicitly mirrors by name for the identical reason ("mirroring resolveReceiverEdge/resolveReceiverTypeName"). The `ptsMap`-specific sibling of the same idea is the `scopedPtsKey`-then-fallback lookup in `emitPtsNoReceiverEdges` (`build-edges.ts:1965`), mirrored on the incremental path by `emitIncrementalPtsNoReceiverEdges` (`incremental.ts:1350`):

```ts
const resolveReceiverSites = (relPath: string, receiver: string, callerName: string | null) => {
  const ptsMap = ptsMapsByFile.get(relPath);
  if (!ptsMap) return [];
  return (callerName ? resolveSitesViaPointsTo(`${callerName}::${receiver}`, ptsMap) : []).concat(
    resolveSitesViaPointsTo(receiver, ptsMap),
  );
};
const correlated = collectInvokedPropertySites(
  new Map(Array.from(fileSymbols, ([relPath, symbols]) => [relPath, symbols.calls])),
  resolveReceiverSites,
);
```

> **Why `collectInvokedPropertyNames`'s OWN call site does not need this treatment:** it takes `Array.from(fileSymbols.values(), (s) => s.calls)` — a flattened, file-blind list — precisely because it never resolves anything through a points-to map; it only tests `call.receiver`/`call.dynamicKind`/`call.name`, all of which are already on the `Call` object regardless of which file it came from. `collectInvokedPropertySites` cannot use the same flattened shape for the reason stated above, which is also why it is a genuinely new, not merely copy-pasted, sibling rather than a one-line variation.

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

Mirrors WU-2 one-for-one, including every round-7, round-8, round-9, round-10, round-11, AND round-12 refinement — dual-engine parity (ADR-001) means none of round 7's finding 1/2/3/4/5 fixes, round 8's finding 1/2/3 fixes, round 9's finding 1 fix, round 10's finding 1/2 fixes, round 11's finding 1/2 fixes, nor round 12's finding 1 fix, are TS-only:

- `types.rs` — `ObjectLiteralSite { site: String, owner: Option<String>, escapes: bool }` with serde field names matching the TS shape (`objectLiteralSite` ↔ `object_literal_site` via the existing rename convention used for `key_expr`/`dynamic_kind`); `Call.object_literal_site: Option<String>`.
- `javascript.rs` — `object_literal_site_id`, `enclosing_object_literal`; `handle_object_literal_pair_value_ref` (line 4456) and `handle_object_literal_shorthand_value_ref` (line 4493) each gain the site seed + tag; new `compute_object_literal_site_escapes(sites, root, source, exported_names, definition_names)` — the trailing `definition_names: &HashSet<String>` parameter mirrors the TS side's round-7 addition (finding 3) and is built the same way, from `symbols.definitions` — with:
  - `TRACKED_REFERENCE_PARENT_KINDS` mirroring `TRACKED_REFERENCE_PARENTS`, placed beside the existing `TABLE_NAME_PASSTHROUGH_KINDS` (line 4372) and cross-referenced in both directions by doc comment, as that constant already is;
  - `is_tracked_reference_position(ref_node: &Node, is_array_owner: bool, source: &[u8]) -> bool` mirroring `isTrackedReferencePosition` one-for-one, including:
    - the member/subscript call-position narrowing;
    - round 7 / finding 1: `is_array_owner` short-circuits the member/subscript branch to `false` before any other check runs, exactly as the TS side does — an array-owned site's container is tracked only through the for-of branch;
    - the subscript static-key requirement, ROUND 8 (#2088 finding 3 — REPLACES round 7's finding-4 version of this same check): a `string` OR `template_string` index, quote/backtick-stripped, then required non-empty and `$`-free — ONE check, applied identically to BOTH index kinds, mirroring `extract_call_info`'s OWN guard verbatim (`!method_name.contains('$')`, `javascript.rs:6479`, subscript arm at `javascript.rs:6469-6489`). Round 7's Rust mirror must not repeat the TS side's round-7 mistake of gating the `$` check on `template_string` alone — `T['co$t'](…)` needs the identical rejection as `` T[`al${x}pha`]() ``, for the identical reason: neither can ever produce a named, receiver-carrying `computed-literal` Call at extraction, in either engine;
    - the for-of/for-in discriminator (reusing the same `is_for_of` child-text scan `collect_for_of_binding` already applies at `javascript.rs:7553`).

    Node-identity comparisons use `.id()`, not `==` — not a new convention for this engine's Rust side: `handle_accessor_property_read` (the existing mirror of `collectAccessorPropertyRead`) already compares this exact shape via `.id()` at `javascript.rs:2323-2326` (`parent.child_by_field_name("function").map(|f| f.id()) == Some(node.id())`), so this bullet reuses that idiom rather than introducing one;
  - ROUND 8 (#2088 finding 1) — new `find_declaring_scope_node<'a>(node: &Node<'a>, name: &str, source: &[u8]) -> Option<Node<'a>>`, the node-returning counterpart of the existing `find_declaring_scope_line` (`javascript.rs:4400`) — mirroring the identical TS-side refactor, `find_declaring_scope_line` becomes a thin wrapper (`find_declaring_scope_node(node, name, source).map(|n| n.start_position().row as u32)`), so the two engines' escape analyses and #2260's own disambiguation share one ancestor-walk implementation each, rather than two copies that could silently drift. `all_references_tracked<'a>(root: &Node<'a>, binding_name: &str, object_node: &Node<'a>, is_array_owner: bool, source: &[u8], declaring_scope: Option<&Node<'a>>) -> bool` mirrors `allReferencesTracked` one-for-one — Rust has no default-parameter sugar, so `declaring_scope: Option<&Node>` is the direct, idiomatic mirror of the TS side's optional trailing parameter: the TOP-level call passes `None` (the function then computes `find_declaring_scope_node(object_node, binding_name, source)` internally), and every RECURSIVE call passes `Some(&fixed_scope)` explicitly — never re-deriving it. It now includes:
    - the round-8 declaring-scope restriction: the walk is bounded to, and exempts from the shadow-prune, ONLY the one scope `find_declaring_scope_node(object_node, binding_name, source)` returns (`root`/`program` when it returns `None`, i.e. a module-scope binding) — never `root` unconditionally regardless of nesting, and this fixed scope is established ONCE, at the top-level call, never re-derived per recursive call (re-deriving it from the alias/loop-variable's own position would walk the wrong ancestor chain, since that position is not necessarily an ancestor of `object_node` — see the TS-side doc comment for the full argument);
    - the round-8 non-vacuous-coverage requirement: the walk returns `true` only when it PROVABLY examined every reference in that scope — truncation by the shared `MAX_WALK_DEPTH` cap, or by the pre-existing depth-6 alias/for-of recursion cap below, makes the result `false` (escaping) unconditionally, never a silently-trusted vacuous `true`;
    - BOTH pre-existing recursive branches, threading the SAME fixed declaring-scope node down unchanged rather than recomputing it: the round-4 rebinding recursion (`is_array_owner` unchanged across the recursive call) and the round-7 for-of-loop-variable recursion (finding 2 — `is_array_owner` hardcoded `false` for the recursive call, and the reference rejected outright, no recursive call attempted, when the loop variable's `left` is not a single plain identifier — reusing `collect_for_of_binding`'s own `var_name` extraction shape at `javascript.rs:7576-7597` to decide "single plain identifier" the same way the TS side reuses `collectForOfBinding`'s);
  - `resolve_site_owner(object_node: &Node, source: &[u8]) -> Option<SiteOwner>` where `SiteOwner { key: String, binding_name: Option<String> }` — round 7 / finding 5: `binding_name` is always the bare declarator identifier (never `[*]`- or `::return`-suffixed), matching the TS contract field-for-field, for the identical reason (an `is_array_owner` derived from `key != binding_name` that could ever be wrong for the array case would silently disable finding 1's fix and condition 2's export check together, on this engine too). ROUND 8 (#2088 finding 2) extends the identical guarantee one step further: `binding_name` also never carries the `#{line}` suffix `find_enclosing_table_name`/`find_declaring_scope_line`-style disambiguation appends (`javascript.rs:4419-4425`) — it is always the `name` field's own `utf8_text(source)`, verbatim, never routed through `find_enclosing_table_name`'s suffix-appending return construction (only its ancestor-walk SHAPE is reused, not its return value). Getting this wrong would make `all_references_tracked` search for an identifier literally spelled `T#7` — text that cannot exist in the grammar — silently reopening finding 1's exact vacuous-walk failure mode for every non-module-scope binding on this engine too, the round-8 counterpart of finding 5's `[*]`/`::return` case just above;
  - `literal_has_unmodeled_this_reference(object_node, root, definition_names, source) -> bool` and its depth-capped `this`-kind subtree search, mirroring `literalHasUnmodeledThisReference` / `subtreeContainsThisKeyword` one-for-one, including the truncate-toward-`true` direction (the inverse of `block_contains_identifier_excluding`'s own truncate-toward-`false`, for the same reason the TS side documents) — PLUS, round 7 / finding 3, the identifier-valued-pair branch: new `resolve_identifier_value_this_reference(object_node, root, name, definition_names, source) -> bool` (round 10 adds the leading `object_node` parameter — see below) and `find_top_level_function_node_by_name(root, name, source) -> Option<Node>`, mirroring `resolveIdentifierValueThisReference` / `findTopLevelFunctionNodeByName` one-for-one, including the identical fail-safe branches (resolves, unshadowed, to a same-file non-arrow function → check its body; resolves, unshadowed, to an arrow function → excluded; shadowed by a non-module scope, or does not resolve in-file at all → fail-safe `true`).
    - ROUND 9 (#2088 finding 1) — REWRITES the match arms inside `literal_has_unmodeled_this_reference`'s own child loop to the same fail-closed contract the TS side adopts: a `method_definition` or inline `function_expression`/`function`-valued `pair` still has its subtree searched; an `arrow_function`-valued `pair` is still excluded; an identifier-valued `pair` still routes through `resolve_identifier_value_this_reference`; new `shorthand_property_identifier` arm, resolving the shorthand node's own text through the identical `resolve_identifier_value_this_reference` call (necessary, not optional — without it, round 9's inverted default would make every literal using a shorthand property escape unconditionally on this engine too); new `is_positively_this_free_literal(value: &Node) -> bool` mirroring `isPositivelyThisFreeLiteral`'s exact node-kind list (`string`, `number`, `true`, `false`, `null`, `template_string`, `regex`, `array`, `object`); and — the actual fix — the match's fall-through arm, covering `spread_element` and every `pair`-value kind not named above (`call_expression`, `parenthesized_expression`, `member_expression`, `as_expression`, a logical/ternary expression, or anything else), now returns `true` (escaping) instead of falling out of the loop with no arm taken. Round 7's Rust mirror already established the convention of matching the TS side's fail-safe direction exactly rather than a locally-"reasonable" approximation (see the `$`-guard parity risk this same section calls out below); this is the identical discipline applied to this function's own default.
    - ROUND 10 (#2088 finding 1) — `resolve_identifier_value_this_reference` gains the leading `object_node: &Node` parameter and, immediately after its existing `definition_names.contains(name)` check, calls a declaring-scope helper (see round 11, below) and returns `true` (fail-safe) whenever it resolves to `Some` — i.e. whenever some scope strictly between `object_node` and the module root also declares `name`. Only when it resolves to `None` does execution reach `find_top_level_function_node_by_name`, exactly mirroring the TS side's shadow check. Both call sites inside `literal_has_unmodeled_this_reference` (the `shorthand_property_identifier` arm and the `pair` arm's identifier branch) pass `object_node` straight through — it is already a parameter of the enclosing function, so this needs no new plumbing beyond the one added parameter. `find_top_level_function_node_by_name`'s own body and doc comment are UNCHANGED by round 10 (only its Rust doc comment gains the identical backstop correction the TS side's does) — it was never the bug; the missing precondition in its caller was.
    - ROUND 11 (#2088 finding 1) — new `find_resolving_scope_node<'a>(node: &Node<'a>, name: &str, source: &[u8]) -> Option<Node<'a>>`, the Rust mirror of the TS-side's own round-11 wrapper, called ONLY from `resolve_identifier_value_this_reference` in place of the `find_declaring_scope_node(object_node, name, source)` call round 10 used — `find_declaring_scope_node`/`find_declaring_scope_line` themselves are UNCHANGED, and `all_references_tracked`'s own call to `find_declaring_scope_node` (round 8, above) is unaffected. `find_resolving_scope_node` ORs `introduces_shadowed_binding` (checked exactly as `find_declaring_scope_node` checks it) with one extra disjunct: does a `for_in_statement` ancestor's own `left` field bind `name`, tested with `pattern_binds_name` — the same primitive `block_contains_identifier_excluding`'s own for-in branch already uses for this identical field, mirroring the TS side's reuse of `patternBindsName`. This closes a gap `SCOPE_NODE_TYPES` (Rust: the constant `find_declaring_scope_node` checks node kinds against) leaves deliberately open for `all_references_tracked`'s own, different reference-walk purpose (#2260) — a `for_in_statement`/`for...in` loop-head binding shadows a name for THIS function's resolution question exactly as much as any other scope's binding does, even though it must not prune `all_references_tracked`'s walk. See the TS-side doc comment (`findResolvingScopeNode`) for the full argument and counter-example; this Rust function mirrors it one-for-one, including leaving `find_declaring_scope_node`/`SCOPE_NODE_TYPES` untouched.
    - ROUND 12 (#2088 finding 1) — `find_resolving_scope_node` gains a THIRD disjunct, mirroring the TS side's own round-12 addition one-for-one and in the SAME position (checked after the `for_in_statement` disjunct, before the `introduces_shadowed_binding` fallback — matching parameter order with the TS function's own `if` sequence): does the current ancestor's `kind() == "arrow_function"`, and, if so, does its `parameter` field (singular — Rust's tree-sitter binding exposes the identical field name as the JS grammar's own `node-types.json`) text-match `name` via `utf8_text(source)`. This closes the Rust mirror's own instance of the identical gap the TS side's round-12 essay documents: `introduces_shadowed_binding`'s shared function-shape case reads only the plural `parameters` field, so a bare, unparenthesized single-identifier arrow parameter is invisible to it on this engine too. `introduces_shadowed_binding` and the Rust constant mirroring `SCOPE_NODE_TYPES` are, again, NOT widened — see the TS-side `findResolvingScopeNode` doc comment (round 12) for the full argument, the counter-example, and why the fix for `introduces_shadowed_binding`'s own blind spot is filed separately (#2629) rather than folded in here.
    - ROUND 11 (#2088 finding 2) — `is_unshadowed_builtin_global` (round 10) is DELETED: it treated a builtin-named IMPORT as an unshadowed global, since `definition_names` (built from `symbols.definitions`, mirroring the TS side's `build-edges.ts:559`) excludes imports by construction — a regression in the `pair` arm specifically, which through round 9 always escaped unconditionally on a builtin name and never called this helper's predecessor guard at all. Both the `shorthand_property_identifier` arm and the `pair` arm's identifier branch now short-circuit to `true` (escaping) on a bare `BUILTIN_GLOBALS.contains(name)`, with no `definition_names` lookup and no resolution attempted — restoring the `pair` arm's pre-round-10 behaviour and giving the shorthand arm that same unconditional-escape treatment for the first time. With nothing left to distinguish the two arms' builtin handling, there is no remaining call site for `is_unshadowed_builtin_global` on either engine, and it is removed from `javascript.rs` rather than kept as a vestigial, uncalled function (which `cargo clippy -- -D warnings`'s dead-code lint would flag in any case). Crediting a genuinely unshadowed builtin (imports included) as safe again is filed as its own follow-up, to be designed and mirrored in both engines together as its own round — see Success Criteria.
  - `compute_object_literal_site_escapes` gains no new PARAMETER for round 9, round 10, round 11, or round 12 (unlike round 7's `definition_names` and round 8's `declaring_scope`/`source`-threading) — all four rounds are entirely internal to `literal_has_unmodeled_this_reference`'s own shape recognition and its identifier-resolution helpers, so its call site in `compute_object_literal_site_escapes` is unchanged since round 8.

Every new Rust item carries a `/// Mirrors <tsSymbol> in src/extractors/javascript.ts` line — the convention `handle_object_literal_pair_value_ref` already follows.

> **Parity risk specific to round 7 through round 10:** round 7's `is_array_owner` short-circuit, round 8's stripped-text/no-`$` check applied uniformly to both subscript index kinds (replacing round 7's template-only version), round 8's declaring-scope/non-vacuous-coverage walk, round 9's fall-through-arm inversion in `literal_has_unmodeled_this_reference`, and round 10's shadow-check-before-module-search ordering in `resolve_identifier_value_this_reference` plus its shared builtin guard are all easy to port correctly for the obvious cases and easy to narrow silently in a hand-written port — exactly the class of mistake round 7's Rust mirror of the `$`-guard itself would repeat if copied without noticing round 8's TS-side correction. Round 9 specifically: a Rust `match` on `child.kind()` with an explicit `_ => false` fall-through arm looks, on a quick read, like ordinary exhaustiveness hygiene rather than a safety-critical default — the reviewer diffing the two engines side by side (below) must confirm that arm is `true`, not `false`, and that `spread_element` is not silently absent from the match altogether (which would compile fine under a wildcard arm and be just as wrong). Round 10 specifically: it is easy to port `is_unshadowed_builtin_global` correctly while forgetting to apply it to BOTH arms — e.g. fixing only the `shorthand_property_identifier` arm and leaving the `pair` arm's identifier branch on its old, differently-shaped guard would compile, pass every existing single-arm-focused assertion, and silently reintroduce the exact "not actually identical" gap finding 2 closes, just moved to the other arm. WU-10's dual-engine assertion on the new escape-fallback cases (below) is what actually catches a missed one — a reviewer diffing the two `is_tracked_reference_position`/`isTrackedReferencePosition` and `all_references_tracked`/`allReferencesTracked` bodies side by side, now extended to `literal_has_unmodeled_this_reference`/`literalHasUnmodeledThisReference` and `resolve_identifier_value_this_reference`/`resolveIdentifierValueThisReference` for rounds 9 and 10, is the other half of the gate, per the Testing Strategy section's "what no tier catches" note.
>
> **Parity risk specific to round 11 — REMOVING code correctly is its own hazard, distinct from porting new code correctly.** Two failure modes, both silent if missed: (1) deleting `is_unshadowed_builtin_global` and its two call sites in ONE engine but not the other — e.g. fixing the TS side and leaving `javascript.rs` on round 10's `is_unshadowed_builtin_global` guard — would make the TWO ENGINES DISAGREE on every builtin-named-import fixture, exactly the drift `/parity` exists to catch, but only if WU-10's new cases (ab)/(ac) actually run under both engines; (2) porting `find_resolving_scope_node` while missing that it must be called ONLY from `resolve_identifier_value_this_reference`, never from `all_references_tracked`'s own `find_declaring_scope_node` call — accidentally wiring the new for-in-aware check into the WRONG call site would silently change condition 3's reference-walk boundary (already correct, already re-verified sound) rather than only condition 4's resolution question, reopening exactly the genuine `for (const x of fn())` read `SCOPE_NODE_TYPES`'s own doc comment protects. A reviewer diffing the two engines' `resolve_identifier_value_this_reference`/`resolveIdentifierValueThisReference` and `all_references_tracked`/`allReferencesTracked` bodies side by side must confirm BOTH: that `find_resolving_scope_node` appears in exactly one of the two call chains, and that `is_unshadowed_builtin_global` appears in neither engine at all, not merely that it was renamed or narrowed. WU-10's new escape-fallback cases (aa)–(ac), run under both engines, are what actually forces this rather than trusting the diff-review alone. **Round 12 adds a THIRD disjunct to the same function (the bare arrow-parameter case, finding 1) and carries the identical porting hazard as the for-in one:** a hand-written Rust port that checks `child_by_field_name("parameter")` against the wrong node (e.g. testing it on `node` itself rather than on `current` inside the same loop iteration as the other two disjuncts) or that omits the check silently compiles and passes every fixture except the one new case built to catch it — case (ad), run under both engines, is what forces this rather than a side-by-side read alone.

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

> **Pass ordering on the Rust side (ROUND 9, #2088 finding 2) — mirrors WU-5(a)'s note exactly, and for the identical reason.** Verified against the real source: `build_call_edges` (`build_edges.rs:1264`) calls `EdgeContext::new(&all_nodes, &builtin_receivers, &files, &extra_names)` (`build_edges.rs:1272`) — which eagerly aggregates `invoked_property_names` and `computed_dispatch_table_evidence` across the FULL `files: &[FileEdgeInput]` slice inside its own constructor (`build_edges.rs:322-327`) — **before** the per-file loop (`for file_input in &files { process_file(&ctx, file_input, ...) }`, `build_edges.rs:1274-1276`) that calls `build_points_to_map` once per file from inside `process_file`. This is the exact same shape as the TS side's `invokedPropertyNames`/`computedDispatchTableEvidence`-before-`buildPointsToMapForFile` ordering, and it means the Rust mirror of `collect_invoked_property_sites` has the identical problem `collectInvokedPropertySites` does: it cannot be added as another field `EdgeContext::new` computes the same way `invoked_property_names` is computed today, because no file's points-to map exists yet at that point in construction. The fix is the same three-pass shape: `EdgeContext::new` (or a helper it calls before its own field-initializer list runs) must build every file's points-to map FIRST — reusing whatever per-file inputs `process_file`'s own points-to construction already assembles — cache them (e.g. `HashMap<&str, PointsToMap>`, keyed by `rel_path`), compute `correlated_property_sites`/`non_escaping_sites` from that cache exactly as `collect_invoked_property_names`/`collect_computed_dispatch_table_evidence` are computed today, and store the SAME cached maps on `EdgeContext` so `process_file`'s own per-file points-to step becomes a lookup into the cache rather than a second `build_points_to_map` call. WU-10's dual-engine assertion on the new two-file correlation shape (below) is what actually forces this: a Rust implementation that (like a naive TS one) tries to resolve `collect_invoked_property_sites` against a single, most-recently-built map would pass every single-file WU-10 fixture and only diverge from the TS engine's (correctly three-passed) output once a second file with its own local, same-named table is present.

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

**The correlation test** covers the seven shapes the design claims (three from earlier rounds, two added in round 8 to close the testing blind spot described below, and two added in round 9 for finding 1's over-escape check and finding 2's pass-ordering check), each asserted under **both** engines (`--engine wasm` and `--engine native`, skipped with an explicit message rather than silently if `isNativeAvailable()` is false — never a silent skip):

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

// 4. (ROUND 8, #2088 finding 1) FUNCTION-SCOPED table, referenced only
//    through a tracked position — every shape above declares its table at
//    MODULE scope, which is exactly why the round-8 shadow-prune bug
//    survived seven rounds undetected (see the withdrawn round-7
//    vacuous-truth argument in WU-2b for the counter-example this shape
//    guards against: a function-scoped table forwarded to an IMPORTED
//    callee, which must escape — that is a NEW escape-fallback case (o)
//    below, not this one). This shape proves the fix does not OVER-escape
//    the common case once it stops self-shadowing.
function makeLocal() {
  const L = { iota: fnI };
  return L.iota();
}
makeLocal();
// EXPECT: fnI live, escapes === 0 for L's site.

// 5. (ROUND 8, #2088 finding 1) BLOCK-SCOPED table — an `if` body, not a
//    function body. `M`'s declaring `statement_block` is a direct child of
//    `if_statement`, not of any function-like node: a different AST shape
//    than case 4, exercising `findDeclaringScopeNode`/`introducesShadowedBinding`'s
//    shared `SCOPE_NODE_TYPES` path for a BARE block specifically, proving
//    the round-8 fix generalises beyond function bodies to any block scope.
function maybeRun(cond) {
  if (cond) {
    const M = { kappa: fnJ };
    M.kappa();
  }
}
maybeRun(true);
// EXPECT: fnJ live, escapes === 0 for M's site.

// 6. (ROUND 9, #2088 finding 1) A table mixing DATA properties (safe,
//    non-function literal values) with a correlated method — proves the
//    round-9 fail-closed rewrite of literalHasUnmodeledThisReference does
//    not over-correct: a `number`/`string`/`array` value must not itself
//    trip the new default, or every real-world dispatch table that pairs
//    routing metadata with a handler (an extremely common shape) would
//    wrongly and permanently escape.
const N = { priority: 1, label: 'default', tags: ['x', 'y'], resolve: isBaz };
N.resolve();
// EXPECT: isBaz live, escapes === 0 for N's site.

// 7. (ROUND 9, #2088 finding 2) TWO independent, same-named local tables in
//    SEPARATE files — the pass-ordering regression case. Each site's own
//    correlation is still fully intra-file: condition 2 forces any
//    genuinely cross-file reference to be exported, hence escaping, hence
//    T2 (see WU-2b) — no shape can make ONE site's own T1 evidence span two
//    files. What this shape actually exercises is WU-5(a)'s pass
//    restructuring: collectInvokedPropertySites needs EVERY file's
//    points-to map, built before evidence assembly runs (see WU-5(a)'s
//    pass-ordering note) — an implementation that resolves a call against
//    the WRONG file's map (e.g. the last one built, instead of its own)
//    would be invisible in every single-file shape above, since with one
//    file there is no "wrong" map to confuse it with. Reusing the SAME
//    local name `T` and the SAME property name `resolve` in both files
//    makes exactly that class of mix-up observable: if file B's calls were
//    ever resolved against file A's map (or vice versa), `fnA5`/`fnB5`
//    would swap liveness outcomes, or one would lose its evidence outright.
// file-a.js:
const T = { resolve: fnA5 };
T.resolve();
// file-b.js:
const T = { resolve: fnB5 };
T.resolve();
// EXPECT: fnA5 live via file-a.js's OWN T1 evidence, escapes === 0 for
// file-a.js's site; fnB5 live via file-b.js's OWN T1 evidence, escapes ===
// 0 for file-b.js's site — each independently, regardless of fileSymbols
// iteration order.
```

> **Each case must also assert `escapes = 0`** for its site (`SELECT escapes FROM object_literal_sites WHERE file = ? AND site = ?`), not just the liveness outcome shown above (round-3 critic finding). Liveness alone does not prove T1 fired: if a site were wrongly classified escaping, T2's bare-name fallback would report the same property live for an unrelated reason, and the test would pass while silently losing coverage of the tier it claims to exercise — symmetric to how the escape-fallback test below asserts `escapes = 1` rather than trusting liveness alone. Case 3 (alias) is the load-bearing one: it is exactly the shape WU-2's `variable_declarator` handling in `allReferencesTracked` (condition 3 above) must classify non-escaping, and a regression there would otherwise pass this test unnoticed. Cases 4 and 5 (round 8) are equally load-bearing for finding 1 specifically: without the declaring-scope exemption, BOTH would (wrongly, per the withdrawn round-7 argument) still read as `escapes = 0` today for the SAME reason the headline counter-example does — a vacuous walk, not a genuine one — so passing this assertion alone does not yet distinguish "the walk is exhaustive and found nothing disqualifying" from "the walk never looked." That distinction is exactly what escape-fallback case (o) below is for: it is cases 4/5's photographic negative, using the SAME function-scope shape but with a reference the fix must NOT accept. Case 6 (round 9) is the equivalent load-bearing check for finding 1's OTHER direction — over-escaping rather than under-escaping — and case 7 (round 9) must additionally assert `escapes = 0` for BOTH files' sites independently, since a pass-ordering bug that resolves one file's calls against the other's map could plausibly leave one of the two sites falsely `escapes = 1` while the other stays `0`, which liveness alone (both `fnA5` and `fnB5` might still end up "live" via T2's bare-name coincidence) would not by itself reveal.
>
> **Case 2 re-verified against round 7's tightened rules.** `RESOLVERS` is an array-element owner (`isArrayOwner = true`), so its own reference — the for-of head in `for (const r of RESOLVERS) …` — is checked on the `for_in_statement` branch, which does not gate on `isArrayOwner` at all (only the member/subscript branch does, per finding 1). Accepting that reference now additionally requires `allReferencesTracked(root, 'r', objectNode, false, declaringScope)` to hold (finding 2) — `declaringScope` being the SAME fixed node established for `RESOLVERS` itself (round 8, #2088 finding 1; `RESOLVERS` is module-scope here, so that node is `root`): `r`'s only two references, `r.matches(x)` and `r.resolve(x)`, are both call-position member expressions checked with `isArrayOwner = false` (a loop variable always denotes a single element), so both pass unchanged. This shape was the plan's own headline #1771 idiom and is confirmed unaffected by round 7 or round 8 — the array-owned shape round 7 actually excludes is the CONTAINER-level `.forEach`/`.map`/etc. call, added as new case (i) below, which this correlation test does not and should not exercise; round 8's declaring-scope restriction changes nothing here either, since `RESOLVERS`' own declaring scope was already `root` (module scope was never affected by the bug it fixes).

> **Builder note (round 10) — an IMPORTED handler makes condition 4 fail safe, which fails these shapes' own `escapes = 0` assertion outright, not merely "passes without proving T1."** Shapes 1, 3, and 6 each carry at least one identifier-valued handler property (`resolve: neverCalled`/`reject: isCalled`; `alpha: fnA`; `resolve: isBaz`) that condition 4 must positively resolve to a same-file, `this`-free function for the site to read `escapes = 0` at all — and, on inspection, this requirement is not unique to 1/3/6: EVERY one of the seven shapes above (2, 4, 5, and 7 included) uses at least one identifier-valued pair for the same reason. `resolveIdentifierValueThisReference`'s first check is `definitionNames.has(name)` — this is a FILE-WIDE, flat set (built the same way `points-to.ts` builds its own from `symbols.definitions`), so it is true for a same-file declaration at ANY depth, but false for anything imported. An IMPORTED handler (`import { neverCalled } from './handlers.js'`) therefore fails this very first check and returns `true` (fail-safe) — and because condition 4 is a WHOLE-SITE check (one `true` from any child fails the whole literal), THIS SITE's `escapes` flips to `1`, directly contradicting the shape's own required `escapes === 0` assertion (the round-3 rule, above) — a hard, loud test failure, not a silent pass. The same fate befalls a handler that is same-file but declared ONLY inside some nested function/block: `definitionNames.has(name)` still passes (the set is flat, not scope-aware), but `findTopLevelFunctionNodeByName`'s own module-level-only search then fails to find it, hitting the identical fail-safe. **The correct fix, if this friction is hit while implementing WU-10, is to make every correlation-shape handler a genuine same-file, TOP-LEVEL (module-scope) declaration or `const` arrow/function-expression — never an import, never nested-only — not to weaken or drop the shape's own `escapes = 0` assertion to make the failure go away.** Dropping that assertion is exactly how a fixture could end up "passing" while proving nothing about T1: liveness alone can still be explained by an unrelated T2 match (shape 1's own decoy is a standing example of that risk), which is precisely why the round-3 rule requires checking `escapes` explicitly for every shape in the first place.

**Naming convention:** the correlation test's seven shapes (used by their numbers, 1–7, throughout this plan) and the escape-fallback test's shapes ((a)–(z), then, round 11, (aa)–(ac), then, round 12, (ad) — spreadsheet-style continuation rather than renumbering, so every existing cross-reference to a lettered case stays valid — used by their letters) are two independent, alphabetically/numerically-keyed lists — a re-verified shape 2 above is unrelated to the lettered cases below.

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
// (e) Aliased, then the alias itself passed to an IMPORTED function — the
//     regression case for the round-4 fix to allReferencesTracked's
//     rebinding branch: accepting `const w = U` is not enough on its own,
//     `w`'s own references must also be tracked, recursively, or the site
//     must escape even though the direct reference to U looks safe.
import { sink } from './sink.js';
const U = { eta: fnH }; const w = U; sink(w); w.eta();
// (f) Table passed as a bare-identifier argument to a LOCAL, non-exported
//     function — the regression case for dropping the parameter-flow branch
//     from WU-2b's condition 3 (round-5 critic finding): the branch used to
//     credit this shape as tracked without ever inspecting what the callee
//     does with the parameter, and `buildParamFlowConstraints` (points-to.ts)
//     has no escape check of its own — so the site must escape even though
//     the callee's own use of the parameter (`t.beta()`) is itself a tracked
//     shape. Recursing into the callee's body to lift this is filed as a
//     follow-up (#2617), not attempted here.
const P = { beta: fnB }; function use(t) { return t.beta(); } use(P);
// (g) A method's own `this.k()` call on a SIBLING property of the SAME
//     literal — the regression case for literalHasUnmodeledThisReference /
//     condition 4 (round-6 critic finding): `Q`'s only reference besides
//     its declaration is `Q.run()`, which the round-6 narrowing classifies
//     as a genuine tracked call position — so WITHOUT condition 4, `Q`
//     would (wrongly) read as local-closed. `this` inside `run()` is not a
//     reference to `Q` at all, and nothing seeds a points-to fact for
//     `this` here (the solver's only `this` key is `${callee}::this`, from
//     `thisCallBindings`, for `.call(ctx)` shapes only) — so T1 would find
//     zero evidence for `alpha` and report `fnC` dead even though
//     `Q.run()` genuinely invokes it. Filed as a follow-up capability
//     (same-literal `this` correlation) — #2618 — not attempted here.
const Q = { alpha: fnC, run() { return this.alpha(); } };
Q.run();
// (h) A bare property READ bound to a local, called through that alias,
//     with an unrelated decoy elsewhere matching only by name — the
//     regression case for narrowing member_expression/subscript_expression
//     to call-position only (round-6 critic finding): `R`'s only own
//     reference besides its declaration is the READ `R.beta` in
//     `const f = R.beta`, never a call — `collectInvokedPropertySites`
//     only records evidence for calls, so this can never produce a T1
//     entry for `beta` correlated to R's site, regardless of how `f` is
//     later used. If a bare read were (wrongly) counted tracked, `R` would
//     read as local-closed with zero T1 evidence for `beta` — reporting
//     `fnF` dead even though `f()` genuinely invokes it — while the
//     decoy's coincidental name match is what correctly keeps it live once
//     `R` is (rightly) classified escaping and falls through to T2's
//     bare-name match, the same "any x.resolve(...) is enough" imprecision
//     the Overview's own headline example describes. Extending correlation
//     to this alias shape is filed as a follow-up — #2620 — not attempted
//     here.
const R = { beta: fnF };
const f = R.beta;
f();
otherTable.beta();
// (i) An ARRAY-OWNED site's CONTAINER called via `.forEach` — the regression
//     case for finding 1 (round-7 critic finding): WU-10 previously had NO
//     array-owned escape case at all, so nothing could catch the plan's own
//     headline #1771 idiom regressing. `A`'s only reference besides its
//     declaration is `A.forEach(...)` — a call-position member expression,
//     which the pre-round-7 predicate accepted as tracked. But
//     `buildArrayCallbackConstraints` seeds a points-to fact for a callback
//     parameter only from `Array.from`, never from `.forEach`, so `r.k()`
//     inside the callback produces zero T1 evidence regardless — a
//     wrongly-non-escaping `A` would make T1 exclusive over that zero
//     evidence and report `fnK` dead, even though `.forEach` genuinely
//     invokes it. Round 7 requires the member/subscript branch to see
//     `isArrayOwner === false`, so `A.forEach(...)` is now rejected outright
//     and `A` correctly escapes, falling to T2 — which finds "k" from
//     `r.k()` itself, exactly as case (g)/(h) already rely on a call's own
//     name populating T2 regardless of correlation. Filed as a follow-up
//     capability (not modeled here) — #2621.
const A = [{ k: fnK }];
A.forEach((r) => r.k());
otherObj.k();
// (j) A for-of loop variable forwarded into an imported function — the
//     regression case for finding 2 (round-7 critic finding): accepting the
//     reference to the ARRAY on the for-of branch is not enough on its own,
//     exactly as accepting `const u = T` alone is not enough for the
//     rebinding branch (round 4) — the loop variable `r`'s OWN references
//     must be tracked too, recursively. `sink(r)` passes `r` as a
//     bare-identifier argument to an imported function, which the existing
//     parameter-flow exclusion (condition 3, round 5, #2617) already treats
//     as untracked regardless of what the callee does with it — so `r`'s
//     recursive check fails and the site must escape even though `A`'s own
//     for-of reference looks safe in isolation.
import { sink } from './sink.js';
const C = [{ gamma: fnG }];
for (const r of C) sink(r);
otherObj.gamma();
// (k) A DESTRUCTURED for-of loop variable — a natural extension of finding 2
//     round 7 identified while closing it: the for_in_statement branch only
//     ever forwards a SINGLE PLAIN IDENTIFIER loop variable, mirroring
//     `collectForOfBinding`'s own extraction exactly; a destructuring `left`
//     such as `{ matches }` extracts a property directly, and
//     `collectForOfBinding` never emits a `forOfBindings` entry for it at
//     all (verified: it requires the declarator's `name` field to be a
//     plain `identifier`) — so `matches(x)` below is never a correlated
//     call on a receiver pointing at this site, regardless of how the array
//     is referenced. Treating the array reference as tracked here would
//     silently reopen finding 2's exact gap for every destructuring for-of,
//     not just the plain-identifier one the fix names explicitly. Filed as
//     a follow-up capability, the array-element analogue of #2620 — #2622.
const B = [{ matches: isBar }];
for (const { matches } of B) matches(x);
otherObj.matches();
// (l) An identifier-valued property whose named function body references
//     `this` on a SIBLING property — the regression case for finding 3
//     (round-7 critic finding) in `literalHasUnmodeledThisReference`: round
//     6 only inspected a `pair`'s value when it was written INLINE
//     (`method_definition`, or a direct `function`/`function_expression`
//     value), never a plain identifier value that itself names a same-file
//     function — so `alphaImpl`'s `this` was invisible to condition 4 even
//     though `run`'s only reference (`T.run()`) is itself a genuine tracked
//     call, and the site would (wrongly) read as local-closed with zero T1
//     evidence for `alpha`. T2 catches it via `this.alpha()` itself, the
//     same way case (g) already relies on `this.alpha()` populating T2
//     once the site correctly escapes — no separate decoy needed.
function alphaImpl() { }
function runImpl() { return this.alpha(); }
const T2 = { alpha: alphaImpl, run: runImpl };
T2.run();
// (m) A subscript call keyed by an INTERPOLATED template string — the
//     regression case for finding 4 (round-7 critic finding):
//     `isTrackedReferencePosition`'s static-key requirement previously
//     accepted ANY `template_string` index unconditionally, but
//     `extractSubscriptCallInfo`'s own extraction guard
//     (`!methodName.includes('$')`) never produces a named,
//     receiver-carrying Call for an INTERPOLATED template key — only
//     `<dynamic:unresolved>`, with no name and no receiver — so correlated
//     evidence for `alpha` can never exist for this shape regardless of how
//     `V` is referenced elsewhere.
const V = { alpha: fnA2 };
const part = 'pha';
V[`al${part}`]();
otherObj.alpha();
// (n) An EXPORTED array literal — the regression case for finding 5
//     (round-7 critic finding) confirming `resolveSiteOwner`'s `bindingName`
//     contract: if `bindingName` were ever the KEY form (`"A[*]"`) rather
//     than the bare declarator identifier (`"A"`), condition 2's
//     `exportedNames.has(owner.bindingName)` check would look up a string
//     that can never be in `exportedNames` (which holds bare identifiers)
//     and would never fire for an exported array; `allReferencesTracked`
//     would then search the AST for an identifier literally spelled `A[*]`
//     — text that cannot exist — find zero surviving references, and read
//     that vacuous walk as non-escaping (see the vacuous-`allReferencesTracked`
//     discussion in WU-2b), silently bypassing condition 2 for every
//     array-owned site, exported or not. With the contract correctly
//     stated, condition 2 catches this BEFORE condition 3 ever runs.
export const W = [{ theta: fnT }];
otherObj.theta();
// (o) (ROUND 8, #2088 finding 1) A FUNCTION-SCOPED table forwarded to an
//     IMPORTED function — the headline counter-example motivating the
//     round-8 shadow-prune fix (see the withdrawn round-7 vacuous-truth
//     argument in WU-2b for the full mechanism). `T`'s declaring scope is
//     `install`'s own body block; `register(T)` is the ONLY other
//     reference to `T` in this file, and it is a bare-identifier argument
//     to an IMPORTED function — condition 3's existing parameter-flow
//     exclusion (round 5, #2617) already treats this as untracked once the
//     walk actually reaches it, exactly as it already does for a
//     module-scope table (case (f) above). BEFORE round 8, the walk
//     self-shadowed `install`'s entire body — `introducesShadowedBinding`
//     found `T`'s OWN declaration as a direct child of that block and
//     pruned it whole — so `register(T)` was never visited at all, the
//     surviving-reference set was empty, and the (wrongly) vacuous result
//     read as tracked; this is cases 4/5's photographic negative, using the
//     SAME function-scope AST shape but with a reference the fix must NOT
//     accept. `register`'s own `t.alpha()` (reusing case (b)'s `./reg.js`
//     import — its body is exactly this shape, which case (b) never needed
//     to specify since its own literal has no owner) is the real
//     invocation, but the points-to map is per-file and parameter flow into
//     an IMPORTED callee is not modeled (WU-4's "Scope: intra-module
//     only"), so it produces no T1 evidence for THIS site regardless of the
//     round-8 fix — the site must escape, and T2's bare-name match (`alpha`
//     was invoked somewhere, via `t.alpha()` itself — the same coarse
//     evidence the Overview's own headline example describes) is what
//     correctly keeps `fnA3` live, for the right (T2) reason.
// reg.js:
export function register(t) { return t.alpha(); }
// consumer file:
import { register } from './reg.js';
function fnA3() { return 1; }
function install() {
  const T3 = { alpha: fnA3 };
  register(T3);
}
install();
// (p) (ROUND 8, #2088 finding 3) A subscript CALL keyed by a STATIC STRING
//     containing `$` — the regression case for finding 3. Round 7's
//     `isTrackedStaticKey` accepted ANY `string` index unconditionally, but
//     `extractSubscriptCallInfo`'s own guard (`!methodName.includes('$')`,
//     applied identically to `string` and `template_string`) never produces
//     a named, receiver-carrying Call once the stripped index text contains
//     `$` — regardless of whether the `$` arrived via interpolation
//     (case (m), already covered) or is simply part of a literal string key
//     ACCESSED VIA BRACKETS (this case, previously uncovered — Greptile
//     flagged exactly this gap on this PR, "Quoted dollar keys lose
//     evidence", against round 7's code). `co$t` is an unusual but
//     syntactically valid property name — `$` is a legal identifier
//     character in JS, so the DECLARATION below needs no quoting at all —
//     but `V2['co$t']()` deliberately accesses it through a quoted BRACKET
//     subscript, which is what routes it through `extractSubscriptCallInfo`'s
//     string-index arm rather than the plain member-expression path: it
//     produces `<dynamic:unresolved>` at extraction — no name, no receiver
//     — so correlated evidence for `co$t` can never exist regardless of how
//     `V2` is referenced elsewhere. The cross-file decoy calls the SAME
//     property through ORDINARY DOT notation (`co$t` needs no bracket at
//     all there), which goes through the plain member-expression path with
//     no `$`-stripping and no exclusion — genuinely populating T2's
//     bare-name evidence for `co$t` — and is what correctly keeps `fnA4`
//     live once `V2` is (rightly) classified escaping.
const V2 = { co$t: fnA4 };
V2['co$t']();
otherObj.co$t();
// (q) (ROUND 9, #2088 finding 1) MODULE-scoped OBJECT-SPREAD — the headline
//     counter-example motivating the round-9 fail-closed rewrite of
//     literalHasUnmodeledThisReference. `T4`'s own reference besides its
//     declaration is `T4.run()`, a genuine tracked call-position member
//     expression (condition 3 is satisfied) — so before round 9, condition
//     4's positive-only detector matched neither the `alpha` pair (an
//     identifier resolving to a same-file, `this`-free function — correctly
//     recognised as safe both before and after round 9) nor the
//     `...mixin4` `spread_element` (which matched NO branch at all,
//     pre-round-9, and so was silently treated as safe by omission), and
//     the site read as local-closed while `mixin4.run`'s `this.alpha()` —
//     reached only because the spread copies `run`'s function reference
//     onto `T4`, so `T4.run()` invokes it with `this === T4` — produced
//     zero correlated evidence for `alpha`. `run` is a plain method here,
//     never itself a value-ref target (spread never produces one — see the
//     doc comment above), so it needs no evidence of its own; `fnAlpha4` is
//     what is at risk. T2 catches it via `this.alpha()` ITSELF, the same
//     way case (g)/(l) already rely on their own inline `this.alpha()`
//     populating T2 once the site correctly escapes — no separate decoy
//     needed, since `this.alpha()` is a genuine, receiver-bearing call
//     regardless of which function body it is textually written inside.
function fnAlpha4() { return 1; }
const mixin4 = { run() { return this.alpha(); } };
const T4 = { alpha: fnAlpha4, ...mixin4 };
T4.run();
// (r) (ROUND 9, #2088 finding 1) A pair valued by a CALL EXPRESSION — the
//     same underlying gap as case (q), a different unrecognised pair-value
//     shape: `makeRunner()` is evaluated once, at object-construction time,
//     to whatever function it returns, and nothing rules out that returned
//     function referencing `this`. Pre-round-9, a `call_expression` value
//     matched no branch in `literalHasUnmodeledThisReference` either. No
//     decoy needed, for the identical reason as case (q): the returned
//     function's own `this.alpha()` is what populates T2.
function fnAlpha5() { return 1; }
function makeRunner() { return function () { return this.alpha(); }; }
const T5 = { alpha: fnAlpha5, run: makeRunner() };
T5.run();
// (s) (ROUND 9, #2088 finding 1) A pair valued by a PARENTHESIZED function
//     expression — a third unrecognised pair-value shape reaching the same
//     gap: parentheses around an inline function expression change its AST
//     type from `function_expression` to `parenthesized_expression`, which
//     (pre-round-9) also matched no branch. No decoy needed, same as (q).
function fnAlpha6() { return 1; }
const T6 = { alpha: fnAlpha6, run: (function () { return this.alpha(); }) };
T6.run();
// (t) (ROUND 9, #2088 finding 1) The SAME object-spread shape as case (q),
//     but FUNCTION-scoped — proving the round-9 fix is scope-independent:
//     literalHasUnmodeledThisReference inspects `objectNode`'s direct
//     children regardless of where `objectNode` itself sits in the tree, so
//     nothing about round 8's declaring-scope machinery should interact
//     with round 9's fix, and this case is what confirms that rather than
//     assumes it — the same discipline the Testing Strategy's module/
//     function/block trio requires of every branch going forward. No decoy
//     needed, same as (q).
function fnAlpha7() { return 1; }
function installT7() {
  const mixin7 = { run() { return this.alpha(); } };
  const T7 = { alpha: fnAlpha7, ...mixin7 };
  T7.run();
}
installT7();
// (u) (ROUND 9, #2088 finding 1) The SAME object-spread shape again,
//     BLOCK-scoped (an `if` body, not a function body) — completing the
//     module/function/block trio for this round's fix, and, as a side
//     effect, this is also the FIRST bare-block-scoped ESCAPING case in the
//     whole suite (round 8 never added one: its own escaping case, (o), is
//     function-scoped). No decoy needed, same as (q).
function fnAlpha8() { return 1; }
function maybeInstallT8(cond) {
  if (cond) {
    const mixin8 = { run() { return this.alpha(); } };
    const T8 = { alpha: fnAlpha8, ...mixin8 };
    T8.run();
  }
}
maybeInstallT8(true);
// (v) (ROUND 10, #2088 finding 1) A FUNCTION-SCOPED shadow — a shorthand
//     property AND a pair-identifier property both name a LOCAL,
//     `this`-using declaration that shadows a same-named MODULE-level,
//     `this`-free one — the headline counter-example motivating the
//     round-10 fix to `resolveIdentifierValueThisReference`'s search
//     direction. Greptile flagged exactly this shape against this plan
//     ("Shadowed handler resolves incorrectly"). Pre-round-10,
//     `findTopLevelFunctionNodeByName` searched DOWN from the module root
//     and found the OUTER, `this`-free `run`/`run2` with full confidence —
//     never the INNER, `this`-using ones actually in scope at `T9`'s own
//     position — so condition 4 voted safe for BOTH properties. `T9.run()`
//     and `T9.other()` are `T9`'s only tracked references besides its
//     declaration (conditions 1-3 pass), so the site read as local-closed
//     while the inner `run`'s `this.alpha()` and the inner `run2`'s
//     `this.gamma()` — reached only because `install9` assigns THOSE
//     closures onto `T9`, never the outer module-level ones — produced zero
//     correlated evidence, reporting `fnAlpha9`/`fnGamma9` dead though
//     `T9.run()`/`T9.other()` invoke them on every call. No decoy needed:
//     each inner function's own `this.xxx()` call populates T2 once the
//     site correctly escapes, the same way case (g)/(q) already rely on
//     their own inline `this.alpha()` doing so. Condition 4 short-circuits
//     on the first disqualifying child, so this one fixture's `escapes = 1`
//     assertion is satisfied by whichever of `run`/`other` is visited
//     first; it does not independently prove both arms in isolation, but
//     both route through the identical `resolveIdentifierValueThisReference`
//     call post-fix (see that function's own doc comment), so one fixture
//     exercising both AST shapes is representative of both.
function run() { return 0; }                    // module-level, this-free
function run2() { return 0; }                   // module-level, this-free
function fnAlpha9() { return 1; }
function fnGamma9() { return 1; }
function install9() {
  function run() { return this.alpha(); }       // shadows it: shorthand target
  function run2() { return this.gamma(); }      // shadows it: pair target
  const T9 = { alpha: fnAlpha9, gamma: fnGamma9, run, other: run2 };
  T9.run();
  T9.other();
}
install9();
// (w) (ROUND 10, #2088 finding 1) The SAME shadow shape as case (v), but
//     BLOCK-scoped (an `if` body, not a function body) — completing the
//     function/block trio the Testing Strategy's own scope-coverage rule
//     requires going forward. There is deliberately no MODULE-scope member
//     of this trio: the bug requires a scope strictly between the object
//     literal and the module root to shadow through, which is structurally
//     impossible for a module-scope literal — there is no shallower scope
//     left to be confused with. Correlation shapes 1-7 (all module-scope,
//     or array/alias variants declared at module scope) are this fix's
//     module-scope regression coverage instead — see the Testing Strategy
//     section's own round-10 note.
function run3() { return 0; }                   // module-level, this-free
function fnAlpha10() { return 1; }
function maybeInstallT10(cond) {
  if (cond) {
    function run3() { return this.alpha(); }    // shadows it, block-scoped
    const T10 = { alpha: fnAlpha10, run3 };
    T10.run3();
  }
}
maybeInstallT10(true);
// (x) (ROUND 10, #2088 finding 2) A MODULE-scoped BUILTIN-NAMED shorthand
//     shadow — `Stream` (`BUILTIN_GLOBALS`) is redefined, at module scope,
//     as a `this`-using local function — the headline counter-example
//     motivating the round-10 fix to the `BUILTIN_GLOBALS` guard itself.
//     Pre-round-10, the shorthand arm's `!BUILTIN_GLOBALS.has(child.text)`
//     guard short-circuited to `continue` (non-escaping) for ANY
//     builtin-named property, shadowed or not, WITHOUT ever calling
//     `resolveIdentifierValueThisReference` — so this file's OWN
//     `this`-using `Stream` was never even inspected. `T11.Stream()` is
//     `T11`'s only tracked reference besides its declaration, so the site
//     read as local-closed while `Stream`'s own `this.alpha()` produced
//     zero correlated evidence, reporting `fnAlpha11` dead though
//     `T11.Stream()` invokes it every call. No decoy needed: `this.alpha()`
//     itself populates T2 once the site correctly escapes.
function fnAlpha11() { return 1; }
function Stream() { return this.alpha(); }
const T11 = { alpha: fnAlpha11, Stream };
T11.Stream();
// (y) (ROUND 10, #2088 finding 2) The SAME builtin-shadow shape, but
//     FUNCTION-scoped — proves finding 2's fix is necessary INDEPENDENTLY
//     of finding 1's, not merely subsumed by it: even after finding 1's
//     shadow-fail-safe lands inside `resolveIdentifierValueThisReference`,
//     the PRE-round-10 shorthand guard still short-circuits on
//     `BUILTIN_GLOBALS.has('Stream')` BEFORE `resolveIdentifierValueThisReference`
//     — and so before finding 1's own shadow check (`findResolvingScopeNode`
//     as of round 11; `findDeclaringScopeNode` at the time round 10 wrote
//     this fixture) — ever runs at all. Finding 1's fix alone, without
//     finding 2's, would NOT catch this shape, which is exactly why both
//     are blocking fixes rather than one subsuming the other — still true
//     post-round-11, since the builtin check still runs first and now
//     short-circuits even earlier (no resolution call at all).
function fnAlpha12() { return 1; }
function install12() {
  function Stream() { return this.alpha(); }
  const T12 = { alpha: fnAlpha12, Stream };
  T12.Stream();
}
install12();
// (z) (ROUND 10, #2088 finding 2) The SAME builtin-shadow shape again,
//     BLOCK-scoped (an `if` body, not a function body) — completing the
//     module/function/block trio for this finding. Unlike finding 1's own
//     trio (cases (v)/(w), which deliberately omit a module-scope member),
//     this finding's fix IS scope-independent: through round 10,
//     `definitionNames` was a flat, file-wide set with no notion of lexical
//     position, so `isUnshadowedBuiltinGlobal`'s answer for `'Stream'` did
//     not depend on WHERE in the file the shadowing declaration or the
//     object literal sit — which is exactly why this finding, unlike
//     finding 1, gets a genuine three-member trio (module, function, block
//     all independently load-bearing) rather than two, mirroring round 9's
//     own precedent for a scope-independent fix (cases (q)/(t)/(u)) rather
//     than round 8's for a scope-DEPENDENT one (cases 4/5, no module-scope
//     member). ROUND 11 (#2088 finding 2) makes this trio's own POINT even
//     stronger without invalidating it: `isUnshadowedBuiltinGlobal` and its
//     `definitionNames` lookup are deleted outright, so a builtin name now
//     escapes with NO lexical-position sensitivity whatsoever — this trio
//     still passes for that simpler reason, and still proves scope does not
//     matter, just via a mechanism with one fewer moving part.
function fnAlpha13() { return 1; }
function maybeInstall13(cond) {
  if (cond) {
    function Stream() { return this.alpha(); }
    const T13 = { alpha: fnAlpha13, Stream };
    T13.Stream();
  }
}
maybeInstall13(true);
// (aa) (ROUND 11, #2088 finding 1) A `for...of` LOOP-HEAD shadow — the loop
//      variable itself, not any function/block BODY, is what shadows a
//      module-level, `this`-free decoy of the same name. `SCOPE_NODE_TYPES`
//      (`src/extractors/javascript.ts:4616-4627`) deliberately excludes
//      `for_in_statement` for a DIFFERENT reason (#2260's own
//      reference-walk boundary — see `findResolvingScopeNode`'s doc
//      comment), so pre-round-11 `findDeclaringScopeNode` never saw this
//      shadow at all: `run4` resolved to the OUTER, `this`-free decoy with
//      full confidence, condition 4 voted safe, and `fnAlpha14` was
//      reported dead though `T14.run4()` invokes it every iteration via the
//      INNER, `this`-using loop-element function. No decoy needed: the
//      loop-body element function's own `this.alpha()` call populates T2
//      once the site correctly escapes, the same way case (v)'s inner
//      `run`/`run2` do. Fresh names (`run4`, not `run`/`run2`/`run3`) avoid
//      colliding with cases (v)/(w)'s own module-level decoys.
function run4() { return 0; }                     // module-level, this-free
function fnAlpha14() { return 1; }
const impls14 = [function () { return this.alpha(); }];
for (const run4 of impls14) {                     // loop var shadows module `run4`
  const T14 = { alpha: fnAlpha14, run4 };         // shorthand: key and value both `run4`
  T14.run4();
}
// (ab) (ROUND 11, #2088 finding 2) A builtin-named PAIR value that is an
//      IMPORT, not a same-file declaration — the exact shape `definitionNames`
//      cannot see, since it is built from `symbols.definitions` only
//      (verified: `build-edges.ts:559`) and never includes an imported
//      binding. Through round 10, `isUnshadowedBuiltinGlobal('Response',
//      definitionNames)` was `true` here — `Response` is in `BUILTIN_GLOBALS`
//      (`src/extractors/javascript.ts:37-95`) and absent from this file's
//      OWN `definitionNames` — so the `pair` arm's identifier branch
//      short-circuited to `continue` without ever calling
//      `resolveIdentifierValueThisReference`, and the import's own
//      `this`-using body was never inspected. Unlike cases (x)-(z), there is
//      NO same-file shadowing declaration at all here — the only
//      declaration of `Response` in scope is the import itself, which is
//      precisely what the deleted helper could not tell apart from a
//      genuine global.
export function Response() { return this.alpha(); }   // resp15.js
import { Response } from './resp15.js';                // a15.js
function fnAlpha15() { return 1; }                      // a15.js
const T15 = { alpha: fnAlpha15, handler: Response };    // a15.js
T15.handler();                                          // a15.js
// (ac) (ROUND 11, #2088 finding 2) The SAME imported-builtin shape as (ab),
//      but through the SHORTHAND arm — proves the fix (and the regression
//      it reverts) applies to BOTH arms identically, not only the one the
//      finding's own repro happened to use. A separate module
//      (`resp16.js`) avoids any incidental interaction with (ab)'s own
//      `resp15.js` import.
export function Response() { return this.alpha(); }   // resp16.js
import { Response } from './resp16.js';                // a16.js
function fnAlpha16() { return 1; }                      // a16.js
const T16 = { alpha: fnAlpha16, Response };             // a16.js
T16.Response();                                         // a16.js
// (ad) (ROUND 12, #2088 finding 1) A single-identifier ARROW-FUNCTION
//      PARAMETER shadow — `run17`'s own bare, unparenthesized parameter
//      binding, not any function/block BODY declaration, is what shadows a
//      module-level, `this`-free decoy of the same name. tree-sitter-
//      javascript puts a bare arrow parameter in a singular `parameter`
//      field — `(run17) => {…}` would use `parameters`/`formal_parameters`
//      instead, already covered by `introducesShadowedBinding`'s existing
//      `childForFieldName('parameters')` read — so `introducesShadowedBinding`'s
//      shared function-shape case (`src/extractors/javascript.ts:4694-4712`)
//      never sees this binding at all: it reads only the plural field,
//      never the singular one the `catch_clause` case immediately below it
//      (`javascript.ts:4713-4716`) already reads for its own parameter.
//      Pre-round-12, `run17` resolved to the OUTER, `this`-free decoy with
//      full confidence, condition 4 voted safe, and `fnAlpha17` was reported
//      dead though `T17.run17()` invokes it every call via the INNER,
//      `this`-using function passed into `make17`. No decoy needed beyond
//      the module-level `run17`: the passed-in function's own
//      `this.alpha()` call populates T2 once the site correctly escapes, the
//      same way case (aa)'s loop-element function does.
function run17() { return 0; }                    // module-level, this-free
function fnAlpha17() { return 1; }
const make17 = run17 => {                         // bare param shadows module `run17`
  const T17 = { alpha: fnAlpha17, run17 };        // shorthand: key and value both `run17`
  return T17.run17();
};
make17(function () { return this.alpha(); });
// EXPECT (all): live, escapes === 1.
```

**Existing tests that must stay green unchanged** — these are the regression contract and none of them may be edited to accommodate the new behavior:
`issue-1771-dispatch-table-value-ref`, `issue-1895-value-ref-invocation-check`, `issue-2087-incremental-invoked-property-persistence`, `issue-2257-logical-or-ternary-value-ref`, `issue-2260-computed-dispatch-table-evidence`, `issue-1784-instanceof-consumer-credit`, `issue-1776-lua-builtin-reassignment`, `tests/graph/classifiers/roles.test.ts`, `tests/engines/query-walk-parity.test.ts`.

> Note on #1895 specifically: its fixture's literal is returned from an **exported** `makeTable()`, so its site escapes and it resolves on T2 — today's exact path. It must pass untouched. If it does not, the escape analysis is wrong, not the test.

**Benchmark fixture** — `pts-javascript/objlit-site.js` carries shapes 2–3 with their expected `calls` edges added to `expected-edges.json`. `pts-javascript` is the correct home per ADR-002 §Costs.5; the `javascript` fixture's precision-1.0 floor must not move.

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
| **Integration over a fixture project** | The seven correlation shapes and the 30 escape-fallback shapes (eight from earlier rounds, six added in round 7 for findings 1, 2 — split into its plain-forwarding and destructuring sub-cases — 3, 4, and 5, two added in round 8 for the headline shadow-prune fix and finding 3's `$`-guard gap, five added in round 9 for finding 1's fail-open condition-4 default spanning module, function, and block scope, five added in round 10 for finding 1's shadowed-identifier-resolution fix (function + block, no module member — see the round-10 scope-coverage note below) and finding 2's `BUILTIN_GLOBALS`-guard fix (module + function + block), three added in round 11 — one for finding 1's `for...of`/`for...in` loop-head shadow gap and two for finding 2's imported-builtin regression, one per affected arm (see the round-11 scope-coverage note below for why neither gets a module/function/block trio) — and one added in round 12 for finding 1's bare arrow-parameter shadow gap, a second AST shape reaching the same resolution question the for-in gap did (see the round-11 scope-coverage note below for why this one needs no trio either)), end-to-end through `buildGraph` into `nodes.role`. | `tests/integration/issue-2088-*.test.ts` |
| **Resolution precision/recall** | The new `pts-javascript/objlit-site.js` fixture's expected edges. `javascript`'s precision-1.0 floor must not move — that fixture is the false-positive canary per ADR-002. | `tests/benchmarks/resolution/` |
| **Dual-engine parity** | Every integration assertion runs under `--engine wasm` and `--engine native`; `npm run build` runs first so WASM sees the new `dist/`. | both `issue-2088-*` tests + `/parity` |
| **Incremental vs full** | A `codegraph watch`-shaped single-file rebuild reaches the same tier decision as a full build, via the two persisted tables. | `issue-2087-…` + the incremental case in `issue-2088-correlated-property-evidence` |
| **Benchmark / perf canary** | The solver gains constraint rows proportional to object-literal count. `npm run benchmark` guards build time; a >5% regression on this repo's full build is a finding to report, not to absorb. | `npm run benchmark` |

**Scope coverage is a first-class testing requirement, not an incidental property (ROUND 8).** Every WU-10 fixture through round 7 declared its table at MODULE scope — the one scope `introducesShadowedBinding` never self-shadows by construction (`default: return false` for `program`) — which is exactly why the round-8 shadow-prune bug (finding 1) went undetected for seven rounds: the test suite was structurally incapable of exercising the code path it broke. Closing that blind spot for THIS round's fix is not enough on its own to guarantee it stays closed. **Fixtures for every branch of the escape predicate — conditions 1–4 in `computeObjectLiteralSiteEscapes`, `isTrackedReferencePosition`'s member/subscript/for-of branches, and both recursive branches of `allReferencesTracked` — must include at least one MODULE-scope, one FUNCTION-scope, and one BLOCK-scope (an `if`/`for`/bare-block body, not a function body) case going forward.** Correlation shapes 4 and 5 (function- and block-scoped tables used correctly) and escape-fallback case (o) (a function-scoped table that must escape) establish this baseline for round 8's own fix; a reviewer adding a new branch to the escape predicate in a future round must add its own module/function/block trio rather than defaulting to module scope alone, the same way the original seven rounds did. **Round 9 follows this discipline for its own condition-4 fix**, even though the fix itself is not scope-sensitive the way round 8's shadow-prune bug was (`literalHasUnmodeledThisReference` inspects an object literal's own direct children regardless of where the literal sits in the tree) — cases (q), (t), and (u) exercise the identical object-spread shape at module, function, and block scope respectively, precisely BECAUSE assuming a new branch is scope-independent without a fixture proving it is the same assumption that let round 8's bug stand for seven rounds; (u) also closes a standing asymmetry noted while writing it — round 8 never added a BLOCK-scoped ESCAPING case of its own (only a function-scoped one, (o)), so (u) is the first in the suite.

**Round 10 splits across BOTH precedents above, because its two findings differ on exactly the axis that distinguishes them.** Finding 1 (the shadowed-identifier fix) is scope-DEPENDENT the way round 8's shadow-prune bug was — it can only manifest when some scope strictly between the object literal and the module root ALSO declares the shadowed name, which is structurally impossible when the literal itself sits at module scope (there is no shallower scope to be confused with) — so, mirroring round 8's own cases 4/5, it gets a two-member trio: case (v) is function-scoped, case (w) is block-scoped, and correlation shapes 1-7's existing module-scope coverage stands in for the missing third member, exactly as round 8's own case-4 comment already established this precedent. Finding 2 (the `BUILTIN_GLOBALS`-guard fix) is scope-INDEPENDENT the way round 9's fall-through-arm fix was — `isUnshadowedBuiltinGlobal` consults only `BUILTIN_GLOBALS` and the flat, file-wide `definitionNames` set, neither of which has any notion of lexical position — so, mirroring round 9's own cases (q)/(t)/(u), it gets a genuine three-member trio: case (x) is module-scoped (matching the finding's own repro), case (y) is function-scoped, and case (z) is block-scoped, each independently load-bearing because the pre-round-10 shorthand guard short-circuits BEFORE finding 1's own shadow check ever runs, so finding 1's fix alone would not have caught cases (y)/(z) either. A reviewer adding a new branch to the escape predicate in a future round should determine which of these two shapes their own fix has — scope-dependent (two-member trio, module coverage inherited from existing shapes) or scope-independent (three-member trio) — rather than mechanically adding three cases regardless of whether a module-scope member can even exist.

**Round 11's two findings fit NEITHER precedent above, and are deliberately not forced into one.** Finding 1 (the `for...of`/`for...in` loop-head shadow) does not vary with what encloses the `for_in_statement` itself: `findResolvingScopeNode`'s new disjunct fires (or does not) purely on whether SOME `for_in_statement` ancestor's `left` binds `name`, a question the loop's own enclosing module/function/block context never changes — case (aa) alone, with the loop at module scope (matching finding 1's own repro), exercises the identical code path a function- or block-nested loop would; a second or third variant would repeat the same assertion against the same branch, not add coverage the way round 8's/round 10's own trios do against a genuinely scope-sensitive walk. Finding 2 (the imported-builtin gap) is answered even more starkly: post-fix, a builtin name escapes with NO lexical-position sensitivity at all — not `definitionNames`, not scope, nothing but `BUILTIN_GLOBALS.has(name)` — so scope is not the coverage axis this finding's own fixtures need to prove. The axis that matters is which of the TWO CODE PATHS (the `pair` arm's identifier branch, or the `shorthand_property_identifier` arm) was regressed, since both call sites carry their own, independently-editable guard expression — case (ab) exercises the `pair` arm, case (ac) the shorthand arm, both at module scope, because scope has nothing left to vary. A reviewer adding a new branch in a future round should ask not just "is this scope-dependent or scope-independent" (round 8/9/10's own axis) but, per round 11, whether the fix's OWN inputs have any notion of lexical position at all before reaching for a trio by default — a fix with fewer sensitivities needs fewer fixtures to characterise it, not more.

**Round 12's finding is the SAME shape as round 11's finding 1, for the identical reason, against a second AST shape.** `findResolvingScopeNode`'s new `arrow_function`/`parameter` disjunct fires purely on whether SOME `arrow_function` ancestor's own bare `parameter` field text-matches `name` — a question, like the for-in disjunct's, that the arrow's own enclosing module/function/block context never changes: an arrow with a bare parameter shadows identically whether it is itself declared at module scope, nested in a function, or nested in a block. Case (ad) alone, with `make17` declared at module scope (matching this finding's own repro, and case (aa)'s own precedent), exercises the identical code path a function- or block-nested arrow would; no second or third variant would add coverage a trio elsewhere in this file does not already provide for the OTHER thing that varies (module/function/block nesting of the *table*, not of the shadowing arrow). This is round 11's own scope-coverage note applied to a second disjunct on the same function, not a new argument.

**What no tier catches, and what a human must check instead.** The escape analysis is a *judgment* about completeness, and no test can enumerate every JS shape that leaks an object identity. The tests above prove the recognised shapes are right and that the fail-safe default is `true`; they cannot prove the recognised set is exhaustive. **A reviewer must read `computeObjectLiteralSiteEscapes` (WU-2b) and its Rust mirror against `TRACKED_REFERENCE_PARENTS`, `isTrackedReferencePosition`, `literalHasUnmodeledThisReference`, AND (round 10) the identifier-resolution helpers those two shape-recognition functions call into — `resolveIdentifierValueThisReference`, `findResolvingScopeNode` (round 11, extended round 12 — layered on round 8's `findDeclaringScopeNode`, below it in the same call chain), and `findTopLevelFunctionNodeByName` — and satisfy themselves — against the stated invariant, not just against parent-type membership — that every position/shape they do not accept is genuinely treated as an escape.** Round 10's own two findings are exactly what this last clause was added to name explicitly: both rounds 7 and 9 correctly reviewed WHICH shapes `literalHasUnmodeledThisReference` recognises, but neither round's review descended into HOW the identifier-valued shapes it recognises actually get resolved, which is precisely where both round-10 bugs hid. **Round 11 went one layer deeper still, and found that round 10's own fix — the very code this clause was written to demand closer reading of — had not itself been read closely enough**: finding 1 is a gap in `findDeclaringScopeNode`'s applicability (a `SCOPE_NODE_TYPES` exclusion that is correct for #2260 but incomplete for condition 4) that round 10's own review did not surface, and finding 2 is a REGRESSION that round 10's own fix introduced while opportunistically improving the `pair` arm — the first time in this plan's history that a review round's finding is a defect in a PRIOR round's fix, rather than in the original design. **Round 12 found that round 11's OWN fix for finding 1 was itself incomplete, not merely that the original design was** — `findResolvingScopeNode`'s new wrapper closed the for-in gap but shared `introducesShadowedBinding`'s pre-existing blind spot to a bare arrow parameter, the same class of "the fix for the fix needs its own audit" round 11 first named for round 10. That review is the real gate on the soundness requirement; the WU-10 tests are a sample of it — and, as of round 8, that sample must itself span module, function, and block scope wherever the branch under test is scope-dependent (round 10's own Scope coverage note above states when a two-member, rather than three-member, trio is the correct sample; round 11's own note, extended by round 12's, explains why neither of their findings need one), not stand in for a single scope repeated across all 30 lettered cases.

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
| Tightening turns a conservative false negative into a **false positive** (live code reported dead) | Structural, not incidental: T1 is reachable only when `escapes === false`, and `escapes` defaults `true` on every unrecognised shape (WU-2b). Escaping sites take T2 — today's exact predicate. Gated by `tests/integration/issue-2088-escape-fallback.test.ts` (WU-10), which asserts both the classification *and* `escapes = 1`, so it fails if the guard is bypassed rather than passing on the wrong tier. Round 6 found and closed four such gaps (the alias, parameter-flow, same-literal `this`, and bare-read branches); round 7 re-applied the SAME invariant test to the round-6 result itself and found and closed five more (array-owned container calls, for-of loop-variable forwarding, identifier-valued `this`, interpolated template keys, and the owner `bindingName`/`key` contract) — see the round-7 annotations throughout WU-2b and the six new WU-10 cases (i)–(n) added to gate them. **Round 8 found the deepest gap yet by re-applying the same invariant test to the WALK ITSELF rather than to another reference position**: the shadow-prune `allReferencesTracked` reused (`introducesShadowedBinding`) self-shadows the site's own declaring scope whenever that scope is not the module (every fixture through round 7 was module-scope, which is why this survived seven rounds), silently vacuously "tracking" a table that was never actually examined at all — a strictly worse failure than any round-6/7 gap, since those each mis-tracked one REACHED reference, while this one meant entire scopes were never reached. Closed two ways, not one: (a) the walk is now rooted at, and exempts from the shadow-prune, only the site's own declaring scope (mirroring `hasLaterReferenceInEnclosingBlock`'s existing, narrower carve-out for the identical trap); and (b) a new standing rule requires the walk to PROVE it was exhaustive — any truncation now forces `escapes = true` unconditionally — so a FUTURE walk bug of this same shape fails closed instead of silently passing, rather than relying on finding every instance of it by inspection one round at a time. Round 8 also fixed a second, independent bug in the same area (`bindingName` could inherit a `#line` suffix `allReferencesTracked` could never match against real identifier text — the same "structurally can never match" failure mode finding 5 already named for `A[*]`) and a third in `isTrackedReferencePosition`'s subscript branch (the `$`-guard was mirrored onto `template_string` only, not `string`, so `T['co$t']()` was wrongly accepted — Greptile flagged this independently on this PR). See the round-8 annotations throughout WU-2b, the withdrawn round-7 vacuous-truth argument, and WU-10 correlation shapes 4–5 plus escape-fallback cases (o)–(p). **Round 9 found a gap of the SAME class in condition 4 specifically**: `literalHasUnmodeledThisReference` was a positive-only detector that silently voted non-escaping (rather than escaping) on any shape it did not recognise — a `spread_element`, or a `pair` valued by a `call_expression`/`parenthesized_expression`/other unrecognised expression — the exact inversion of this row's own stated mitigation, which through round 8 was true of every OTHER condition but not yet of condition 4's own internals. Closed by rewriting the function to the same fail-closed contract, now stated once at the level of `computeObjectLiteralSiteEscapes` itself (a standing rule, mirroring round 8's `allReferencesTracked`-specific one) so a future predicate cannot repeat this exact class of gap unnoticed. See the round-9 annotations in WU-2b and WU-10 correlation shapes 6–7 plus escape-fallback cases (q)–(u). **Round 10 found that condition 4's identifier-RESOLUTION chain — one layer beneath the shape-recognition switch round 9 rewrote — still violated a fail-closed discipline in two places, both flagged independently (finding 1 by Greptile, "Shadowed handler resolves incorrectly").** Finding 1: `findTopLevelFunctionNodeByName` searches DOWN from the module root only, so a function-scoped shorthand/pair-identifier property that shadows a same-named MODULE-level declaration resolved to the WRONG (module-level) function with full confidence — worse than round 8's vacuous-truth bug, because a sub-predicate returning a confidently wrong answer gives downstream code no signal anything is amiss, whereas an honest "unresolved" at least triggers the caller's own fail-safe. Finding 2: the shorthand arm's `!BUILTIN_GLOBALS.has(name)` guard short-circuited to a silent non-escaping vote for ANY builtin-named property, shadowed or not — exactly the round-9 standing rule's forbidden outcome, just in a helper round 9's own audit did not reach. Closed by resolving OUTWARD from the object literal via `findDeclaringScopeNode` (reusing round 8's own helper) before ever falling back to the module-level search, and by unifying both arms' builtin guard into one shared `isUnshadowedBuiltinGlobal(name, definitionNames)` predicate that skips resolution only for a genuinely unshadowed global. See the round-10 essay in WU-2b, `resolveIdentifierValueThisReference`'s and `findTopLevelFunctionNodeByName`'s own doc comments, and WU-10 escape-fallback cases (v)–(z). **Round 11 found that round 10's own two fixes each had a further problem — the first time in this plan's history that a finding is a defect in a PRIOR round's fix rather than in the original design.** Finding 1: `findDeclaringScopeNode`'s ancestor walk cannot see a `for...of`/`for...in` loop-head binding, because its `SCOPE_NODE_TYPES` deliberately excludes `for_in_statement` for a DIFFERENT reason (#2260's own reference-walk boundary — a genuine read in the loop's `right` expression must survive) that does not apply to condition 4's resolution question — a loop variable shadows a same-named module-level decoy exactly like any other scope's binding does for THAT question, and the pre-round-11 code resolved to the decoy with full confidence instead. Closed by a new, resolution-path-ONLY wrapper, `findResolvingScopeNode`, that ORs the existing shadow check with a `for_in_statement`-head test — `findDeclaringScopeNode`/`SCOPE_NODE_TYPES` themselves are untouched, so `allReferencesTracked`'s own, already-verified-sound use of them (condition 3, round 8) is unaffected. Finding 2: `isUnshadowedBuiltinGlobal` treats a builtin-named IMPORT as an unshadowed global, because `definitionNames` (built from `symbols.definitions`) excludes imports by construction — making round 10's own `pair`-arm recall improvement a REGRESSION, not merely an incomplete fix, since through round 9 the `pair` arm always escaped unconditionally on a builtin name. Closed by reverting the improvement rather than patching it: both arms now escape unconditionally on any `BUILTIN_GLOBALS` name, `isUnshadowedBuiltinGlobal` is deleted, and crediting a genuinely unshadowed builtin (imports included) as safe is filed as its own follow-up rather than re-attempted inline. See the round-11 essay in WU-2b, `findResolvingScopeNode`'s own doc comment, and WU-10 escape-fallback cases (aa)–(ac). **Round 12 found that round 11's own finding-1 fix — `findResolvingScopeNode` — was itself incomplete: its ancestor walk ORs in a `for_in_statement` disjunct but still falls through, for every OTHER ancestor type, to `introducesShadowedBinding`, whose shared function-shape case reads only the plural `parameters` field and so cannot see a BARE, unparenthesized single-identifier arrow parameter (`run => {…}`) — a shape tree-sitter-javascript carries in a separate, singular `parameter` field (verified against `tree-sitter-javascript@0.25.0`'s own `node-types.json`), which the `catch_clause` case two lines below already reads for its own binding.** A same-named module-level decoy shadowed only by such a bare arrow parameter resolved, pre-round-12, to the decoy with full confidence, the identical failure mode finding 1 named twice already. Closed the same way as the for-in case: one more disjunct ORed onto `findResolvingScopeNode` alone, checked only there — `introducesShadowedBinding`/`SCOPE_NODE_TYPES` are again left untouched, and the pre-existing primitive's own blind spot to this same field (which affects `allReferencesTracked`'s reference walk too, in the conservative direction only — over-inclusion, never unsoundness) is filed separately as #2629 rather than widened inline. See `findResolvingScopeNode`'s own doc comment (round 12) and WU-10 escape-fallback case (ad). |
| WU-5's `collectInvokedPropertySites` resolves calls against the WRONG file's points-to map (ROUND 9, #2088 finding 2) — silently under-populates T1, the exact false-dead class this plan is gated on, in a way no single-file fixture can reveal | `collectInvokedPropertyNames`/`computedDispatchTableEvidence` are pure name/file aggregations needing no points-to information, so `buildCallEdgesJS` builds them once, globally, before any file's points-to map exists. `collectInvokedPropertySites` cannot use that same pre-loop position unchanged, because resolving a receiver is inherently per-file. Mitigated structurally, not by convention: `buildCallEdgesJS` is restructured into three explicit passes (pts pre-pass → evidence assembly → per-file edge resolution, WU-5(a)), and `collectInvokedPropertySites`'s own signature is keyed by file (`ReadonlyMap<string, Iterable<Call>>` plus a `relPath`-aware `resolveReceiverSites`) rather than a flattened list, so a caller cannot wire it up without supplying the right map for each file. Gated by WU-10 correlation shape 7, a two-file fixture built specifically because every other WU-10 fixture is single-file and so cannot distinguish "resolved against the right map" from "resolved against the only map." Mirrored on the Rust side, where `EdgeContext::new` has the identical ordering shape (WU-8's own pass-ordering note). |
| Reviewer objection: "this contradicts §8.3's field-based decision" | Pre-rebutted in [Reconciling the tension](#reconciling-the-tension-with-roadmap-83-field-based-not-field-sensitive): field-sensitivity and allocation-site abstraction are orthogonal axes, and §8.3's own Approach block already commits to allocation-site abstraction. The pts lattice stays field-based; the `site\|key` set is computed outside the solver. |
| Reviewer objection: "this duplicates #2260's `receiver` channel" | It does not — T3 is kept name-keyed, unconditional, and untouched (WU-5b). #2088 adds a third tier beside it. The array-literal gap in #2260's own channel is filed separately as #2611 rather than folded in. |
| New `ExtractorOutput` field silently dropped at the Worker boundary | ADR-002 §Costs.2 names this the primary parity risk, so it is its own work unit (WU-3) with its own verification, following the `computedDispatchTableEvidence` precedent in the same three files. `Call.objectLiteralSite` needs no protocol edit — verified by reading `wasm-worker-protocol.ts:51` (`calls: Call[]`, passed whole), not assumed. |
| WASM/native escape-bit drift | The bit is persisted in `object_literal_sites`, so a divergence is directly observable by diffing that table between engine runs rather than only inferable from a differing `roles` output. WU-10 runs every integration assertion under both engines; `/parity` gates. |
| Solver cost grows with object-literal count | Constraints added are O(sites) + O(callAssignments with a matching `::return` key), and the `callAssignments` loop is guarded on that key existing, so it adds no rows for the common case. `MAX_SOLVER_ITERATIONS` is unchanged at 50. `npm run benchmark` is in the verification block; a >5% full-build regression on this repo is reported, not absorbed. |
| Full-vs-incremental divergence in the new channel | Both new tables are persisted and purged per file exactly as `invoked_property_names` (#2087) is — WU-5(c), WU-6. This is deliberately *not* the shortcut #2260 took, whose in-memory-only aggregation is filed as #2610. |
| Scope growth during implementation | Two adjacent findings were filed as issues before this plan was written (#2610, #2611) rather than absorbed. Every review round since has kept the same discipline for findings that narrow the escape-analysis design rather than fix it (#2617–#2620 from rounds 4–6; #2621–#2623 from round 7) — see the Success Criteria exclusion list. Round 8 filed no new follow-up issues: all three of its findings are soundness fixes to what earlier rounds already claimed the design covers, not new named exclusions from it — see the Success Criteria note on round 8 for why that distinction matters here specifically. **Round 9 filed one — #2624** — because, unlike round 8's findings, inverting condition 4's default genuinely narrows recall for shapes the pre-round-9 code (incorrectly) accepted: an object literal using object-spread, or a pair valued by anything other than the positively-safe enumeration, now escapes where it previously (unsoundly) did not. Finding 2 (the WU-5 pass-ordering fix) filed no issue: it is a soundness/buildability fix to how a not-yet-implemented WU is sequenced, not a narrowing of any capability the design claims. **Round 10 filed one of its own two findings — #2625** — for finding 1: failing safe on ANY non-module shadowing scope, rather than fully resolving into it, costs recall for a shadowing declaration that happens to itself be `this`-free, a capability a fuller (but more invasive) fix could have preserved. Finding 2 filed no issue: unifying both arms onto `isUnshadowedBuiltinGlobal` is a soundness fix for the shorthand arm and a strict recall IMPROVEMENT for the `pair` arm's own previously-unconditional builtin escape, not a narrowing of anything the design claims, matching round 8's own framing for a fix that makes an existing claim true rather than trading it away. **Round 11 filed one of its own two findings — #2627** — for finding 2, and for a reason distinct from every prior round's filing criterion: round 10's own "strict recall IMPROVEMENT" claim just above is what round 11 found to be UNSOUND, not merely optimistic — crediting a genuinely unshadowed builtin (imports included) as safe is a real capability, but attempting it again needs its own focused round and its own review, exactly the discipline round 10's own drive-by fix skipped the first time. Finding 1 filed no issue: closing the `for...of`/`for...in` detection gap in the shadow check falls under #2625's already-filed scope (a shadowing scope, once DETECTED, always fails safe unconditionally rather than resolving into it — #2625 already discloses that cost for every scope kind the check can see; round 11 only makes a for-in head one of the kinds it CAN see, the same "closes a DETECTION gap without changing the underlying exclusion" pattern round 7's identifier-pair fix already established for condition 4 — no new issue for that shape either). One PR = one concern. |

## Out of Scope (filed, not silently dropped)

- **`computedDispatchTableEvidence` is in-memory only** — on a scoped incremental build a dispatch table whose only computed-access consumer lives in an untouched file loses its evidence, so `roles --role dead` can report a live property dead. Non-conservative direction, and a full-vs-incremental divergence. Its sibling channel got a durable table in #2087 for exactly this reason. → issue **#2610**
- **`findEnclosingTableName` does not traverse array literals** — `TABLE_NAME_PASSTHROUGH_TYPES` (and its Rust mirror `TABLE_NAME_PASSTHROUGH_KINDS`) omit `array`, so `const RESOLVERS = [{ matches, resolve }]` yields no `receiver` and the #2260 computed-access pathway can never credit a handler array — the exact idiom named in `collectObjectLiteralValueRefCall`'s own doc comment as #1771's motivating case. Not closed by this plan, which leaves T3 name-keyed. → issue **#2611**
- **`-T` under-filters `tests/`**, inflating this repo's dead-symbol count ~3x. Already tracked; relevant here only because WU-10's dogfood measurement must filter `tests/` by hand rather than trust the raw number. → issue **#2256** (pre-existing, referenced in `.codegraph/basics.md`)
- **Cross-module allocation-site propagation** — `importedNames` propagates cross-module *names*, not *sites*, which is why exported tables are classified escaping (WU-2b, condition 2). Shrinking the escape set by propagating sites through import edges is a natural follow-up, in the spirit of ROADMAP §8.3b. **Not filed yet**: it is a design direction rather than a defect, it has no user-visible symptom today (escaping sites simply keep current behavior), and its right shape depends on what WU-10 measures. To be filed at execute time if the measured delta shows exported tables dominate the remaining false negatives.

## Success Criteria

- [ ] `codegraph roles --role dead -T` no longer credits an unrelated `x.name(...)` call as liveness evidence for a **non-escaping** object literal's `{ name: fn }` property — the exact behavior issue #2088 asks for.
- [ ] Every object literal producing a value-ref carries a stable allocation-site id, and its `escapes` bit is persisted in `object_literal_sites`.
- [ ] The points-to solver propagates those sites through the flows it already models and treats as tracked — direct binding, array element + for-of, and alias — with **no** change to `buildCallSiteTypeMap` / `MAX_SOLVER_ITERATIONS`, per ADR-002's "no new subsystem". The following positions/shapes are treated as escaping in this iteration and are deliberately excluded from the correlated set, each narrower than an earlier round of this plan claimed — round 6 (and, re-applying the identical invariant test to round 6's OWN result, round 7) found that an earlier, looser predicate would have accepted them without their invocations actually being provable via T1, which is a soundness gap, not a stylistic nit. Recall is smaller than that earlier draft claimed, again; each exclusion below is filed as a follow-up capability rather than silently narrowed:
  - Parameter-passing positions (WU-2b condition 3, WU-4) — #2617. This exclusion also applies transitively to a for-of loop variable forwarded into a function call (round 7) — no separate issue; it is the same gap one binding further, per condition 3's own note.
  - A same-literal `this.k()` call from a method/function defined inside the literal itself (WU-2b condition 4) — #2618. Round 7 closed a DETECTION gap in this same condition (an identifier-valued property naming a same-file function was previously invisible to the check at all) without changing the underlying exclusion itself — no new issue for that fix; it makes an existing checkbox true rather than narrowing it further.
  - `for...in` enumeration (only the `for...of` variant of `for_in_statement` is tracked) and, more generally, a computed dispatch call `TABLE[expr]()` made directly rather than through the `const x = TABLE[expr]; x(...)` declarator form T3 already requires — #2619.
  - A bare (non-call) member/subscript read of a tracked binding's property, assigned to a local and called through that alias (e.g. `const f = T.k; f()`) — #2620.
  - (round 7) A member/subscript call on an ARRAY-OWNED site's CONTAINER (`RESOLVERS.forEach(...)`, `.map`, `.find`, `.filter`, `.some`) — only a `for...of` head over the container is admissible; `buildArrayCallbackConstraints` seeds no points-to fact for any of these callbacks' parameters — #2621.
  - (round 7) A `for...of` loop variable forwarded into a position this analysis does not itself follow, beyond the plain parameter-passing case above — specifically, a DESTRUCTURING loop variable (`for (const { k } of A) k()`), which `collectForOfBinding` never seeds a points-to fact for at all — #2622.
  - (round 7) A subscript call keyed by an interpolated template string (`` T[`al${x}pha`]() ``) — the extractor's own guard never produces a named, receiver-carrying call for it, so no property name is ever available to correlate, regardless of how the receiver is referenced — #2623.
  - **(round 8) No new exclusion added to this list.** Round 8's three findings (below and throughout WU-2b) are SOUNDNESS fixes to the escape analysis's own implementation, not new accepted recall limitations in its DESIGN — unlike every bullet above, none of them names a shape the design deliberately declines to model. Finding 1 (the declaring-scope shadow-prune) and finding 2 (the `bindingName` suffix) together made the escape check WRONGLY non-escaping for every non-module-scope table regardless of how it was actually used — fixing them does not shrink what the design already claimed was trackable, it makes the claim true instead of vacuously true for shapes it was already supposed to cover (correlation shapes 4/5 above confirm function- and block-scoped tables used correctly still correlate after the fix). Finding 3 (the `$`-guard) made the escape check WRONGLY tracked for a reference the extractor can never actually produce T1 evidence for; the fix aligns it with what #2623 already correctly assumed the extractor does, for a case #2623 was never scoped to cover (a `$`-bearing STATIC key, as opposed to genuine interpolation). Recall for the shapes round 8 touches is therefore unchanged from what earlier rounds already claimed, once "claimed" means "actually verified against a fixture in that scope," which is precisely what correlation shapes 4/5 and escape-fallback cases (o)/(p) now do.
  - **(round 8) One narrow, EXPECTED conservative consequence of finding 1(b), not a new exclusion needing its own issue:** a declaring scope whose AST subtree is deep enough to hit the pre-existing `MAX_WALK_DEPTH` cap now unconditionally escapes, per the non-vacuous-coverage requirement below — where pre-round-8 (buggy) behavior would have silently returned "not found" and read a truncated walk as tracked. This is the SAME depth-cap convention already applied uniformly throughout this file's other recursive walks (`blockContainsIdentifierExcluding`, `patternBindsName`, `scanPatternDefaultsForReference`, `subtreeContainsThisKeyword`) — Category F, a standard safety boundary, not a newly-discovered gap in this design specifically — so it is not filed as a follow-up capability the way #2617–#2623 are; those name shapes the design does not yet recognise at all, while this names a depth the AST would have to be pathological to reach.
  - **(round 9, #2088 finding 1) A NEW exclusion, unlike round 8's — genuinely narrower recall, not a detection-gap fix.** A `pair` whose value is not positively proven `this`-free — an object-spread source (`const T = { alpha: fnA, ...mixin }`), a call-expression-valued pair (`run: makeRunner()`), a parenthesized function expression (`run: (function () { … })`), a bare member-expression read, an `as`/`satisfies` cast, or a logical/ternary expression — now marks the site escaping, where the pre-round-9 implementation (unsoundly) treated it as safe by omission. Unlike round 7's identifier-valued-pair fix (which closed a DETECTION gap in an already-sound exclusion, condition 4's own `this`-using-method rule), round 9 removes a capability the pre-round-9 code claimed to have but never actually had soundly: correlating a value-ref inside a literal that ALSO carries one of these shapes. Recall is smaller than the pre-round-9 draft implied for this narrow case; filed as a follow-up rather than silently narrowed — #2624.
  - **(round 9, #2088 finding 2) No new exclusion — a buildability/soundness fix, not a design narrowing.** WU-5(a)'s three-pass restructuring (pts pre-pass → evidence assembly → per-file edge resolution) does not remove any capability the design claims; it is what makes `collectInvokedPropertySites` implementable at all against a per-file points-to map, a requirement WU-5's own doc comment already implied ("the receiver-CORRELATED counterpart of `collectInvokedPropertyNames`") but never stated precisely enough to build correctly. No follow-up issue.
  - **(round 10, #2088 finding 1) A NEW exclusion, narrower for a different reason than round 9's: implementation-simplicity, not an unavoidable safety boundary.** Once `resolveIdentifierValueThisReference` finds that some scope strictly between the object literal and the module root also declares the identifier's name, it fails safe UNCONDITIONALLY rather than resolving into that shadowing scope's own declaration and checking whether THAT declaration is itself `this`-free. A shadowing declaration that happens to be genuinely `this`-free would, under a fuller fix, still correlate via T1; under this one it always escapes and falls to T2, because doing otherwise would require generalising `findTopLevelFunctionNodeByName`'s module-level-only declaration matching into a second, arbitrary-scope traversal — another AST-search shape to keep correct, in both engines, for a pattern the `#1771`/`#1784` precedent was never asked to cover. Filed as a follow-up rather than silently accepted — #2625.
  - **(round 10, #2088 finding 2) No new exclusion — a soundness fix with a strict recall IMPROVEMENT as a side effect, matching round 8's framing rather than round 9's.** Unifying the `pair` and `shorthand_property_identifier` arms onto one shared `isUnshadowedBuiltinGlobal` guard closes the shorthand arm's silent-safe-vote hole (a soundness fix — nothing the design claimed to cover gets narrower) AND, as a side effect, lets the `pair` arm correctly credit a genuinely UNSHADOWED builtin-named property as safe — a case the pre-round-10 `pair` arm always, unnecessarily, escaped. No follow-up issue. **SUPERSEDED by round 11, immediately below: this "recall IMPROVEMENT" claim was itself unsound** (`isUnshadowedBuiltinGlobal` could not distinguish a genuine global from a builtin-named IMPORT), so the improvement is reverted rather than kept.
  - **(round 11, #2088 finding 1) No new exclusion — closes a DETECTION gap in round 10's own #2625 exclusion, the same way round 7 closed one in condition 4's original exclusion.** #2625 already discloses that ANY shadowing scope, once detected, makes `resolveIdentifierValueThisReference` fail safe unconditionally rather than resolving into it — this round only widens WHICH scopes the check can detect as shadowing (adding a `for...of`/`for...in` loop head, via `findResolvingScopeNode`) without changing that already-disclosed unconditional-fail-safe behavior itself. Pre-round-11, a loop-head shadow was not merely "conservatively excluded" the way #2625 describes — it was invisible to the check entirely, producing a confidently WRONG answer (the same failure class finding 1 originally named), not a disclosed conservative one. No new issue: it makes #2625's own disclosed scope wider, rather than disclosing a new one.
  - **(round 11, #2088 finding 2) A regression REVERTED, not a new exclusion — recall for the `pair` arm's builtin-named-identifier case returns to exactly what it was through round 9.** `isUnshadowedBuiltinGlobal` is deleted; both arms now escape unconditionally on any `BUILTIN_GLOBALS` name, with no `definitionNames` lookup and no resolution attempted. This is strictly MORE conservative than round 10's (unsound) behavior — recall is smaller than round 10 claimed, for the same reason round 10's own "strict recall IMPROVEMENT" framing (immediately above) does not survive this round. It is not, however, narrower than what round 9 (and every prior round) actually delivered soundly: the `pair` arm always escaped unconditionally on a builtin name through round 9, and the shorthand arm's own pre-round-10 bug (a silent, unproven non-escaping vote) is still fixed, just via unconditional escape rather than via a shadow-aware guard. Crediting a genuinely unshadowed builtin (imports included) as safe remains a real, unclaimed recall opportunity — filed as its own follow-up, to be designed and reviewed as its own round — #2627.
  - **(round 12, #2088 finding 1) No new exclusion — closes ANOTHER detection gap in round 10's own #2625 exclusion, the same way round 11 did for the for-in case.** #2625 already discloses that ANY shadowing scope, once detected, makes `resolveIdentifierValueThisReference` fail safe unconditionally rather than resolving into it; round 11 widened which scopes `findResolvingScopeNode` can detect to include a `for...of`/`for...in` loop head, and this round widens it once more to include a bare, unparenthesized single-identifier arrow-function parameter (`run => {…}`) — a shape `introducesShadowedBinding`'s existing, plural-only `parameters` field read cannot see. Pre-round-12, this shadow was not a disclosed conservative exclusion — it was invisible to the check entirely, producing a confidently WRONG answer, the same failure class finding 1 originally named. No new issue: it makes #2625's own disclosed scope wider still, rather than disclosing a new one. `introducesShadowedBinding`'s own blind spot to this same field — which affects `allReferencesTracked`'s reference walk too, safely (over-inclusion only) — is a pre-existing gap in a primitive this round deliberately does not widen; filed separately as #2629.
- [ ] **(round 9, #2088 finding 1 — the fail-closed contract, generalised).** Every predicate `computeObjectLiteralSiteEscapes` consults returns "escaping" for any shape it does not positively recognise as safe — not just `allReferencesTracked`'s own coverage (round 8's standing rule, above), and not just condition 4's enumerated `this`-free shapes (`isPositivelyThisFreeLiteral`, an `arrow_function`, an inline function/method whose subtree was searched, or an identifier/shorthand-property resolved in-file to a non-arrow `this`-free function). This is a standing contract on `computeObjectLiteralSiteEscapes`'s own return value, not a one-off patch to condition 4: any predicate this function gains in a future round — a hypothetical condition 5, or a further refinement of conditions 1–3 — inherits it automatically, the same way round 8's non-vacuous-coverage requirement binds every future change to `allReferencesTracked` specifically. Verified by WU-10 correlation shape 6 (a mixed data/handler table does NOT over-escape) and escape-fallback cases (q)–(u) (the five shapes named in the bullet above DO escape, across module, function, and block scope).
- [ ] **(round 9, #2088 finding 2 — the pass-ordering contract).** `collectInvokedPropertySites` never resolves a call's receiver against any file's points-to map other than the one for the file that call is declared in — enforced by the revised signature (`ReadonlyMap<string, Iterable<Call>>` plus a `relPath`-aware `resolveReceiverSites`, WU-5(a)/WU-8), not merely by caller discipline. Verified by WU-10 correlation shape 7, a two-file fixture built specifically because a single-file fixture cannot distinguish "resolved against the right file's map" from "resolved against the only map there is."
- [ ] **(round 10, #2088 finding 1 — the identifier-resolution shadow contract; extended round 11 and round 12, #2088 finding 1).** `resolveIdentifierValueThisReference` never resolves an identifier-valued pair/shorthand property against a declaration OUTSIDE the one actually in lexical scope at the object literal's own position — enforced structurally by checking `findResolvingScopeNode(objectNode, name)` (round 8's `findDeclaringScopeNode`, itself unchanged, through round 10; a thin resolution-only wrapper around it as of round 11, additionally covering a `for...of`/`for...in` loop-head binding, and, as of round 12, a bare single-identifier arrow-function parameter too) before ever consulting `findTopLevelFunctionNodeByName`'s module-level-only search, not merely by caller discipline or by that search's own (previously mis-stated) fail-safe backstop. Verified by WU-10 escape-fallback cases (v)–(w) (a function- and a block-scoped shadow of a `this`-free module-level sibling must escape), round 11's case (aa) (a `for...of` loop-head shadow must escape too), and, round 12, case (ad) (a bare arrow-parameter shadow must escape too) — none may silently resolve to the wrong, harmless declaration.
- [ ] **(round 11, #2088 finding 2 — the unconditional builtin-escape contract, SUPERSEDING round 10's shared builtin-guard contract).** Both the `pair`-value and `shorthand_property_identifier` arms of `literalHasUnmodeledThisReference` escape UNCONDITIONALLY on any `BUILTIN_GLOBALS`-member name, with no `definitionNames` lookup and no identifier resolution attempted — enforced by one identical `BUILTIN_GLOBALS.has(name)` check inlined at both call sites, not by a shared helper that (round 10's `isUnshadowedBuiltinGlobal`) could, and did, silently mistake a builtin-named IMPORT for a genuine, unshadowed global. Verified by WU-10 escape-fallback cases (x)–(z) (a builtin-named property shadowed by a same-file, `this`-using declaration must escape at module, function, and block scope alike — still true, now for a simpler reason) and, round 11, cases (ab)–(ac) (a builtin-named property populated by an IMPORTED, `this`-using declaration must escape too, in both the `pair` and `shorthand_property_identifier` arms).
- [ ] `resolveViaPointsTo` never returns a site token to name resolution.
- [ ] For any site with `escapes === true`, resolution is **byte-identical to pre-#2088**, and all nine listed existing tests pass unedited.
- [ ] `resolveSiteOwner`'s `key`/`bindingName` contract (round 7 finding 5, extended round 8 finding 2) holds for every owner shape, verified by WU-10's dedicated `export const A = [{…}]` case (round 7) and by correlation shapes 4/5 and escape-fallback case (o) (round 8): condition 2's export check, the `isArrayOwner` derivation, and (round 8) `allReferencesTracked`'s own AST search all depend on `bindingName` never carrying a `[*]`/`::return` suffix (round 7) NOR a `#${scopeLine}` disambiguating suffix (round 8) — the latter being exactly what `findEnclosingTableName` would otherwise append for any non-module-scope declaration.
- [ ] WASM and native engines produce identical `object_literal_sites`, identical `invoked_property_sites`, and identical `roles --role dead -T` output on this repo.
- [ ] A scoped incremental rebuild reaches the same tier decision as a full build for the same file.
- [ ] `analysis.correlatedPropertyEvidence` is the only new behavioral constant, lives in `DEFAULTS`, is wired to both engines, and setting it `false` restores pre-#2088 behavior exactly.
- [ ] `pts-javascript` gains the new fixture; `javascript`'s precision-1.0 floor is unmoved.
- [ ] Every command in [Verification Commands](#verification-commands) has been run and passed; any that could not run is reported to the user rather than skipped.
- [ ] The before/after dead-symbol delta on this repo is recorded as a measured number in `ROADMAP.md` §8.3 and the PR body.
- [ ] No new language, no `LANGUAGE_REGISTRY` / `AST_TYPE_MAPS` / `LangAstConfig` change, no new runtime dependency.
