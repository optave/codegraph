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

tests/integration/issue-2088-correlated-property-evidence.test.ts   NEW   the eight canonical shapes; both engines
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

**(a) Tag the value-ref calls with their owning site.** The object-literal node is the `pair`/shorthand node's parent in both cases (ROUND 18 nit, #2088: corrected from "or grandparent for shorthand" — stale prose describing code that never matched it; `shorthand_property_identifier` is a direct alternative in `object`'s own child list, the same as `pair`, not wrapped in any intermediate node, verified against `tree-sitter-javascript@0.25.0`'s own `grammar.js`, so `enclosingObjectLiteral`'s uniform `node.parent` read below was always correct for both shapes):

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
    // ROUND 20 (#2088, UE-C, non-blocking) — a member call whose PROPERTY is
    // literally `call`/`apply`/`bind` (`T.bind(…)`) is not itself a genuine
    // `T.<key>()` correlation candidate, even when `T` owns a property
    // spelled that way (`{ call: fn, bind: fn }`): the pre-existing, general
    // call extractor (`extractMemberExprCallInfo`,
    // `src/extractors/javascript.ts:5764-5788`) treats ANY `<expr>.bind(…)`/
    // `.call(…)`/`.apply(…)` as the reflective mechanism regardless of
    // context, rewriting the extracted `Call` to `{ name: <objText>,
    // dynamicKind: 'reflection' }` with NO `receiver` field at all. Verified
    // against the real source, not assumed. Accepting this reference as
    // tracked therefore credits condition 3 with a correlation that can
    // never actually materialise: `collectInvokedPropertySites` (T1) needs
    // `call.receiver` to correlate at all, and this call site never sets
    // one — the identical `receiver`-dependency `collectInvokedPropertyNames`
    // (T2) already has, so this shape is invisible to BOTH tiers, in EITHER
    // direction, regardless of this design. Left unexcluded, a table whose
    // ONLY other reference is a `.bind()`/`.call()`/`.apply()`-shaped call
    // would read as tracked (satisfying condition 3) while producing ZERO
    // usable evidence for ANY of its properties — an UNDER-escape, since T1
    // then becomes exclusive over nothing. Fixed by rejecting this shape
    // outright, before the call-position check below ever runs — cheaper
    // than resolving whether the extractor's own rewrite would apply here
    // specifically (which depends on `obj`'s own node type, checked deep
    // inside that function), and correct regardless: no construction through
    // `.call`/`.apply`/`.bind` can ever produce `collectInvokedPropertySites`
    // evidence for ANY property, so treating the reference as untracked here
    // costs nothing this design could otherwise have credited. Matches
    // escape-fallback case (bj).
    const propText = parent.childForFieldName('property')?.text;
    if (propText === 'call' || propText === 'apply' || propText === 'bind') return false;
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
  // (`right`) position — never the loop-variable (`left`) pattern. (Round
  // 7: this branch never itself inspects the loop VARIABLE's own name or
  // shape — that is `allReferencesTracked`'s job, described in its own doc
  // comment below, exactly as it already owns the rebinding branch rather
  // than this function.)
  //
  // ROUND 18 (nit, #2088) — discriminates via the `operator` FIELD, not a
  // blanket child-text scan for `'of'`. `for_in_statement` carries a
  // required, single-value `operator` field whose only possible tokens are
  // `in`/`of` (verified against `tree-sitter-javascript@0.25.0`'s own
  // `node-types.json`) — reading it directly cannot collide with anything
  // else in the loop. The blanket scan this branch previously used (the
  // same shape `collectForOfBinding` itself applies,
  // `src/extractors/javascript.ts:4285-4291`) does not have that property:
  // if the loop's own ITERATED expression (`right`) happens to be a
  // variable literally named `of` (`of` is an ordinary identifier, not a
  // reserved word), a blanket scan finds that `right` node's OWN text
  // matching `'of'` and misreads `for (const k in of)` — a genuine for-IN,
  // enumerating `of`'s keys — as a for-OF. Fixed here, reading the field
  // directly; `collectForOfBinding`'s own identical blanket-scan pattern is
  // a separate, pre-existing gap in already-shipped code, out of this
  // plan's own scope — filed at #2639, not changed here.
  if (parent.childForFieldName('right')?.id !== refNode.id) return false;
  return parent.childForFieldName('operator')?.text === 'of';
  // `for (const k in T) …` (`operator` text `'in'`) correctly returns
  // `false` here — enumerates keys, not values.
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
 *     below, with the SAME conservative, FIVE-way (round 13, #2088 finding
 *     1, adds the reassignment bullet below; round 10, #2088 finding 1,
 *     added the shadow bullet; through round 9 this was three-way)
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
 *     fail-safe, not deeper resolution, is the chosen remedy; is REASSIGNED
 *     — some `assignment_expression`/`augmented_assignment_expression` BINDS
 *     this same name on its `left` (round 14, #2088 finding 1: checked via
 *     `patternBindsName`, so a destructuring target counts too, not only a
 *     bare identifier — see `subtreeContainsReassignmentOf`'s own doc
 *     comment for the one shape, a parenthesized target, still open at
 *     #2630), an `update_expression` operates on it, or a declaration-less
 *     `for...of`/`for...in` loop-head target does (round 13, #2088 finding
 *     1; `subtreeContainsReassignmentOf`, checked AFTER the shadow test
 *     above but BEFORE the two branches just below ever trust the resolved
 *     declaration) → FAIL SAFE, since the module-level declaration resolved
 *     below is only that binding's INITIAL value, never proof that no later
 *     statement rebinds it to something `this`-using — see that function's
 *     own doc comment for the counter-example this closes; resolves
 *     in-file, UNSHADOWED, and NEVER REASSIGNED, to a non-arrow
 *     function/method → check its body for `this`, same as the inline
 *     case; resolves in-file, UNSHADOWED, and NEVER REASSIGNED, to an ARROW
 *     function → excluded, same reasoning as an inline arrow-valued pair
 *     above; does not resolve to any in-file function-shaped definition at
 *     all (imported, global, a non-function binding, declared only in some
 *     OTHER scope that is neither the module root nor an ancestor of this
 *     object literal, or — round 14, #2088 finding 2 — declared MORE THAN
 *     ONCE at module level, so no single declaration can be trusted as THE
 *     one in effect; see `findTopLevelFunctionNodeByName`'s own doc comment)
 *     → FAIL SAFE, treated as if it might contain `this`.
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
 *
 * > **ROUND 18 (#2088) — the `method_definition` branch proves safety only
 * > via `subtreeContainsThisKeyword`, which is sound for an ordinary method
 * > but not for a GETTER, whose own danger has nothing to do with what its
 * > own body contains.** A getter's body executes, with `this` bound to the
 * > receiver, the instant its property is READ (`T.k`, no call syntax
 * > needed) — but that alone is not the gap this branch already closes
 * > correctly: a getter whose OWN body references `this` directly (`get
 * > run(){ return this.alpha(); }`) is still caught, since `method_definition`
 * > covers getters and plain methods alike at the grammar level (verified
 * > against `tree-sitter-javascript@0.25.0`'s own `node-types.json`: `get`/
 * > `set` are unfielded token children, not a distinct node kind), and
 * > `subtreeContainsThisKeyword` walks the getter's body exactly as it would
 * > a plain method's. **The actual gap is one property hop further: a
 * > getter can RETURN a value with no `this` token anywhere in its own body,
 * > and if that returned value is then CALLED — `T.k()` — the CALL's own
 * > `this` binds to `T` regardless of how the callee value was obtained,
 * > per ordinary member-expression-callee semantics, not per anything the
 * > getter itself does.** Concretely, verified runnable under Node:
 * >
 * > ```js
 * > function fnA() { return 41; }
 * > function runImpl() { return this.alpha(); }
 * > const T = { alpha: fnA, get run() { return runImpl; } };
 * > T.run();            // → 41: fnA invoked via this.alpha(), this === T
 * > ```
 * >
 * > `get run(){ return runImpl; }`'s own body contains no `this` token, so
 * > `subtreeContainsThisKeyword` returns `false` and this branch votes safe
 * > — but `T.run()` evaluates `T.run` (invoking the getter, which returns
 * > the plain function `runImpl`) and then CALLS the result, and that call's
 * > own `this` is `T` (the base of the `T.run` reference the call's callee
 * > expression names), not whatever `runImpl` was defined to close over.
 * > `runImpl`'s `this.alpha()` therefore genuinely invokes `fnA` on every
 * > call — condition 4 votes safe, `escapes` reads `false`, and `fnA` would
 * > be reported dead though `T.run()` invokes it every time. **A plain
 * > method is not affected by this same construction**, verified as a
 * > control: `run2(){ return runImpl; }` called as `T2.run2()` returns
 * > `runImpl` itself, UNCALLED — reaching the function still bound inside
 * > it would require a SECOND, explicit call (`T2.run2()()`), which this
 * > shape does not perform, so the existing `subtreeContainsThisKeyword`
 * > check remains sound for every non-accessor method. A SETTER is also
 * > unaffected, for a different reason: `T.k = v` invokes a setter with
 * > `this` bound to `T` (a genuine risk `subtreeContainsThisKeyword` already
 * > catches, identically to a plain method, since nothing about `this`
 * > binding differs for a setter's OWN body), but nothing ever CALLS a
 * > setter's return value — assignment expressions evaluate to the assigned
 * > VALUE, never to what the setter itself returns — so a setter cannot
 * > smuggle a `this`-using function through a return value the way a getter
 * > can. The gap is getter-specific, not accessor-general.
 * >
 * > **Fixed by treating a `get`-flavoured `method_definition` as escaping
 * > UNCONDITIONALLY, regardless of what `subtreeContainsThisKeyword` finds
 * > in its own body — "escape on accessors outright," not a deeper
 * > resolution ladder.** A ladder mirroring the identifier-valued `pair`
 * > arm's own resolution chain (resolve a bare-identifier `return`, check
 * > ITS body for `this`) was considered and rejected: it would still be
 * > incomplete, since a getter may return an INLINE function expression, a
 * > call expression, or any other shape — not only a bare identifier — and
 * > any one of those could itself be `this`-using with no bounded number of
 * > resolution hops able to rule every shape out soundly. Unconditional
 * > escape is both simpler and strictly safer, matching this design's own
 * > established preference (round 9's `spread_element`, round 13's
 * > reassignment detection, round 10's shadow detection) for "detect the
 * > shape reliably, then fail safe outright" over a resolution chain that
 * > would still be incomplete. This is a NEW, narrower exclusion — an
 * > object literal with an otherwise entirely harmless getter (`get
 * > value(){ return 42; }`) now also escapes, costing recall alone, never
 * > soundness — filed as a follow-up rather than silently accepted; see
 * > Success Criteria and #2638. A plain method's and a setter's own
 * > branches are unchanged. Matches escape-fallback case (ax) and
 * > correlation shape 19.
 * >
 * > **ROUND 19 (#2088 finding 1) — the `pair`-value branch's `object`/`array`
 * > arm (`isPositivelyThisFreeLiteral`, below) reasons from the value's own
 * > node TYPE that reaching a nested function requires an extra property hop
 * > that rebinds the receiver away from `T` — true for every ordinary key,
 * > but false for the one key the language treats specially.** A
 * > non-computed `__proto__` pair does not create an ordinary own property at
 * > all; per ECMA-262 Annex B.3.1, it sets `T`'s own `[[Prototype]]` instead
 * > (when the value is an object or `null`), so a method on the assigned
 * > object becomes reachable as `T.method()` with NO extra hop, and `this`
 * > bound directly to `T`, not to some nested value. Concretely, verified
 * > runnable under Node:
 * >
 * > ```js
 * > function fnA() { return 41; }
 * > const T = { alpha: fnA, __proto__: { run() { return this.alpha(); } } };
 * > T.run();   // → 41; this === T; Object.getOwnPropertyNames(T) === ['alpha']
 * > ```
 * >
 * > `__proto__`'s value here is an `object`, so `isPositivelyThisFreeLiteral`
 * > votes safe and this branch `continue`s without ever inspecting the
 * > nested literal's own `run` method — but `T.run()` genuinely invokes it
 * > with `this === T`, since `run` now lives one lookup away, on `T`'s own
 * > prototype, not behind a second property access the way an ordinary
 * > nested `object`/`array` value would put it. The string-literal spelling
 * > (`"__proto__": { … }`) triggers the identical prototype-setting magic and
 * > is equally affected; so is an array-element owner
 * > (`[{ alpha: fnA, __proto__: { … } }]`) — the magic is a property of the
 * > object-literal SYNTAX itself, not of whatever binds the literal
 * > afterward. **The COMPUTED spelling is NOT affected, and must stay
 * > safe**: Annex B.3.1's special handling applies only to a literal,
 * > non-computed `PropertyName : AssignmentExpression` pair —
 * > `["__proto__"]: { … }` creates an ordinary OWN property named
 * > `__proto__`, exactly like any other computed key, and does not touch
 * > `T`'s prototype at all (verified: `T3.go` is `undefined` for
 * > `{ ["__proto__"]: { go() {…} } }`, and `Object.getOwnPropertyNames(T3)`
 * > lists `"__proto__"` as an ordinary own key). A blanket ban on
 * > `object`/`array`-valued pairs would therefore be both unnecessary (it
 * > would escape the overwhelming majority of harmless nested-literal pairs
 * > this design already correlates, e.g. correlation shape 6's own `tags:
 * > ['x', 'y']`) and beside the point on its own terms: nothing about "the
 * > value is an object" distinguishes the dangerous shape from the safe
 * > one — the KEY is what changes the semantics here, never the value.
 * >
 * > **Fixed by checking the `pair`'s own `key` field FIRST, before any
 * > value-shape branching ever runs, rather than narrowing
 * > `isPositivelyThisFreeLiteral` itself.** A `pair` whose `key` is a
 * > non-computed `property_identifier` or `string` (quote-stripped, reusing
 * > this file's own established `.replace(/['"`]/g, '')` idiom rather than
 * > inventing a second one) with text exactly `__proto__` now escapes
 * > UNCONDITIONALLY, regardless of what `value` is — the dangerous behavior
 * > comes from being assigned to `[[Prototype]]` at all, and resolving
 * > whether a given value is itself `this`-using would still be incomplete
 * > for the same reason round 18's getter fix already gives (an assigned
 * > value this design does not itself fully resolve, e.g. a further
 * > identifier or call expression, could always turn out `this`-using), so
 * > this mirrors that round's own "detect the shape reliably, then fail safe
 * > outright" choice rather than adding a narrower, still-incomplete
 * > resolution ladder. A `computed_property_name`-keyed pair is deliberately
 * > EXCLUDED from this new check and falls through to the ordinary
 * > value-shape branching unchanged, per the Annex B.3.1 distinction above.
 * > `isPositivelyThisFreeLiteral` itself is untouched — its `object`/`array`
 * > members remain correct for every OTHER key, and this fix lives entirely
 * > in this caller, the same discipline round 18's `method_definition`
 * > carve-out (above) already established for a different node kind and a
 * > different shared primitive. Matches escape-fallback case (bb) and
 * > correlation shape 23.
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
      // ROUND 18 (#2088) — a GETTER escapes UNCONDITIONALLY, regardless of
      // what subtreeContainsThisKeyword finds in its own body: a getter's
      // danger is in what it RETURNS, not merely what it references — see
      // this function's own doc comment for the counter-example. `get`/
      // `set` are unfielded token children, not a distinct node kind
      // (verified against `tree-sitter-javascript@0.25.0`'s own
      // `node-types.json`), so both must be read positionally.
      for (let i = 0; i < child.childCount; i++) {
        if (child.child(i)?.type === 'get') return true;
      }
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
      // ROUND 19 (#2088 finding 1) — checked BEFORE `value` is even read: a
      // non-computed `__proto__` key sets `T`'s own [[Prototype]] (ECMA-262
      // Annex B.3.1), not an ordinary own property, so a method reachable
      // through it binds `this` to `T` directly, with none of the extra
      // property hop `isPositivelyThisFreeLiteral`'s `object`/`array` arms
      // otherwise rely on. Escapes UNCONDITIONALLY, regardless of `value`'s
      // own shape — see this function's own doc comment for the
      // counter-example and why a computed key (`['__proto__']: …`, which
      // creates an ordinary own property and does NOT set the prototype) is
      // deliberately excluded.
      //
      // ROUND 20 (#2088, B1) — `key.text` is RAW SOURCE TEXT, not the KEY'S
      // OWN COOKED VALUE, and round 19's comparison conflated the two. A key
      // spelled with a unicode escape — `"\u005f\u005fproto\u005f\u005f"`, or
      // the identical escape inside a bare identifier key,
      // `\u005f\u005fproto\u005f\u005f: {…}` — evaluates (cooks) to the exact
      // string `__proto__` and triggers the identical Annex B.3.1
      // prototype-setting magic, but its RAW text is the escape sequence
      // itself, never the seven bare characters `__proto__`, so stripping
      // only quote/backtick characters can never make it equal that literal.
      // Executed: for `const T = { alpha: fnA, "\u005f\u005fproto\u005f\u005f":
      // { run() { return this.alpha(); } } }`, `T.run()` returns `41`,
      // `Object.getOwnPropertyNames(T)` is `['alpha']` (the escaped key is
      // NOT an own property), and `T`'s prototype is the custom object —
      // `fnA` genuinely invoked with `this === T` — while round 19's own
      // check, run against this exact pair, answers `false` (does not
      // escape): a false "safe" vote on a table that demonstrably escapes.
      // Fixed by additionally fail-safing on any RAW BACKSLASH in the key's
      // own text: a backslash can only appear in a non-computed
      // `property_identifier`/`string` key via an escape sequence (a
      // unicode/hex escape in either grammar, or a legacy octal/identity
      // escape in a string), and this design has no cheaper way to prove an
      // escaped key does NOT cook to `__proto__` short of actually cooking
      // it — which would duplicate a full string/identifier unescaper this
      // file does not otherwise need, for a check whose only job is
      // detecting nine characters. Scoped to the SAME `key.type !==
      // 'computed_property_name'` guard as the original check, not widened
      // to computed keys — see below and correlation shape 23 (rebuilt) for
      // why a computed key's own raw text can never satisfy either half of
      // this check regardless, and why the guard is therefore still
      // necessary once the backslash fail-safe is added, not merely
      // inherited unchanged. This costs recall only for the vanishingly rare
      // case of a non-`__proto__` key that happens to itself contain an
      // escape sequence (e.g. `{ "a\nb": fn }`) — filed as a follow-up rather
      // than resolved by building a full unescaper — #2641. Matches
      // escape-fallback case (be).
      const key = child.childForFieldName('key');
      if (key && key.type !== 'computed_property_name') {
        const rawKeyText = key.text;
        if (rawKeyText.includes('\\') || rawKeyText.replace(/['"`]/g, '') === '__proto__') {
          return true;
        }
      }
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
 * ROUND 19 (#2088 finding 1) — this function answers a VALUE-shape question
 * only and stays that way: the `object`/`array` members' own "extra property
 * hop" reasoning has exactly one exception, a non-computed `__proto__` KEY,
 * which is a shape of the `pair` itself, not of `value`. That exception is
 * therefore checked by the CALLER, before this function is ever reached for
 * such a pair — see `literalHasUnmodeledThisReference`'s own doc comment —
 * rather than threading a key-aware special case through this function's
 * otherwise purely value-shaped contract.
 *
 * > **ROUND 20 (#2088, B1) — round 19's own `__proto__`-key check compares
 * > `key.text` (raw source text) to the literal string `__proto__`, which is
 * > sound for the shape round 19 verified but blind to an EQUIVALENT key
 * > spelled with an escape sequence.** ECMA-262's Annex B.3.1 magic keys on
 * > the pair's own COOKED property name, not on how that name is spelled in
 * > source — `"\u005f\u005fproto\u005f\u005f"` and `{ \u005f\u005fproto\u005f\u005f: … }`
 * > (an escaped `property_identifier`, unicode escapes being legal inside an
 * > identifier per the grammar's own `IdentifierStart`/`IdentifierPart`
 * > productions) both cook to the seven-character string `__proto__` and
 * > both therefore set `[[Prototype]]` exactly as the bare spelling does —
 * > but `key.text.replace(/['"\`]/g, '')` strips only quote/backtick
 * > characters, never resolves an escape, so it strips down to the escape
 * > sequence itself, never to `__proto__`, and round 19's check silently
 * > votes safe. Verified runnable: `Object.getOwnPropertyNames(T)` for
 * > `const T = { alpha: fnA, "\u005f\u005fproto\u005f\u005f":
 * > { run() { return this.alpha(); } } }` is `['alpha']` (the escaped key
 * > never becomes an own property), `T.run()` returns `41`, and `T`'s own
 * > prototype is the assigned object — `fnA` genuinely invoked with
 * > `this === T` — while round 19's own check, unmodified, answers `false`
 * > for this exact pair. Fixed by additionally fail-safing on any backslash
 * > present in the (non-computed) key's own raw text, alongside the
 * > existing stripped-text equality — see the round-20 comment on the `pair`
 * > branch below for the full argument and the follow-up (#2641) this
 * > narrows recall by. `isPositivelyThisFreeLiteral` itself remains
 * > untouched by this round too, for the identical reason round 19 states:
 * > the fix is a property of the `pair`'s own KEY, not of `value`'s shape,
 * > and lives entirely in the caller.
 * >
 * > **Round 20 also found round 19's OWN correlation shape 23 — the fixture
 * > meant to prove the `computed_property_name` exclusion is not
 * > over-broad — was vacuous, and its own claim about what it proves was
 * > false.** See `literalHasUnmodeledThisReference`'s round-20 comment on the
 * > `pair` branch, and correlation shape 23's own rebuilt commentary in
 * > WU-10, for the full argument: a `computed_property_name`'s raw text
 * > always retains its enclosing `[`/`]` brackets, so the stripped-text
 * > comparison can never equal `__proto__` for a computed key regardless of
 * > whether the `computed_property_name` guard exists at all — the guard
 * > was unreachable dead code against round 19's own check. It is NOT
 * > removed, because it is no longer dead against the round-20 check: the
 * > NEW backslash fail-safe would otherwise wrongly escape an entirely
 * > ordinary computed key whose own inner expression happens to contain an
 * > escape sequence unrelated to `__proto__` (e.g. `['a\nb']: 5`) — the
 * > guard is now load-bearing for a different reason than round 19 gave it,
 * > not merely restated.
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
 * mean for #2260's own, already-verified-sound callers. This one disjunct
 * covers `for await (… of …)` as well as plain `for...in`/`for...of` — the
 * grammar represents all three with the SAME `for_in_statement` node type,
 * distinguishing them only via the node's own `kind` field (whose token set
 * includes `await` alongside `const`/`let`/`var`/`using`), never a separate
 * `for_await_statement` node, so no extra disjunct is needed for it.
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
 *
 * A `class` expression's own NAME (`const C = class run { … }`) is
 * deliberately not a fourth disjunct here, even though it superficially
 * resembles the arrow-parameter and for-in cases above: `T.run()` on a
 * class throws (a class is not callable without `new`), and `new
 * T.run()` binds `this` to the newly-constructed INSTANCE, never to `T` —
 * so a class's own name can never be invoked the way this function's two
 * existing disjuncts guard against, and adding one for it would widen the
 * walk for a shape that cannot produce the failure mode this function
 * exists to prevent.
 *
 * > **ROUND 16 (#2088, #2630) — the for-in disjunct's own `left` field
 * > read admits a shape `patternBindsName` cannot see.** `for_in_statement.left`
 * > (verified against `tree-sitter-javascript@0.25.0`'s own `node-types.json`,
 * > same citation as `subtreeContainsReassignmentOf`'s round-13 essay) permits
 * > `parenthesized_expression` alongside `identifier`/`array_pattern`/
 * > `object_pattern`/`member_expression`/`subscript_expression` — `for ((run)
 * > of iter)` is grammar-valid, `left` is a `parenthesized_expression`
 * > wrapping the identifier `run`, and `patternBindsName`'s `default: return
 * > false` (`src/extractors/javascript.ts:4906-4907`) never sees inside it.
 * > Concretely, verified runnable under real Node: `function run() { return
 * > 0; } function install() { for ((run) of [function () { return
 * > this.alpha(); }]) { const T = { alpha: fnA, run }; T.run(); } }` —
 * > `run`'s declaring scope for THIS question is the for-of loop itself, but
 * > pre-round-16 the disjunct never fires, the walk continues past the
 * > loop, reaches `program`, and `run` resolves to the OUTER, `this`-free
 * > decoy with full confidence — the identical failure mode the round-11
 * > for-in disjunct closed for the unparenthesized case, reopened by one
 * > layer of parens. Fixed by unwrapping `left` through a new local
 * > `unwrapParens` helper (below) before ever calling `patternBindsName` on
 * > it — NOT by adding a `parenthesized_expression` case to `patternBindsName`
 * > itself, which stays exactly as narrow as its other verified consumers
 * > (`blockContainsIdentifierExcluding`'s own for-in branch, `killsBinding`'s
 * > assignment branch, `declarationDeclaresName`) already depend on it being.
 * > This is the resolution-path half of a gap with two other, independent
 * > call sites — see `subtreeContainsReassignmentOf`'s own round-16 essay for
 * > the write-scan half, and #2630 (whose own second comment already
 * > corrected this issue's original "safe direction" framing to note that
 * > THIS consumer, unlike `blockContainsIdentifierExcluding`'s, is fail-OPEN,
 * > not conservative) for the full four-consumer history. Of #2630's four
 * > named consumers, this round closes three — this disjunct,
 * > `subtreeContainsReassignmentOf`'s for-in branch, and its
 * > assignment-expression branch — leaving only `blockContainsIdentifierExcluding`'s
 * > own for-in branch open, which is the one consumer #2630 itself already
 * > proved is conservative-only (a missed shadow there can only ADD a
 * > candidate reference to a conjunction, never flip a `true` to a `false`),
 * > so leaving it be costs no soundness — `blockContainsIdentifierExcluding`
 * > is condition 3's own, already-verified-sound walk (#2260), not condition
 * > 4's, and this round does not touch it.
 * >
 * > **ROUND 16 (#2088, #2632) — a fourth disjunct, for a shape neither the
 * > for-in nor the arrow-parameter check above can see: a block-scoped
 * > `using`/`await using` declaration.** `introducesShadowedBinding`'s
 * > `statement_block` case (`src/extractors/javascript.ts:4744-4771`)
 * > recognises `lexical_declaration`, and, by name field,
 * > `function_declaration`/`generator_function_declaration`/`class_declaration`
 * > — but NOT `using_declaration`, a distinct grammar kind (verified against
 * > `tree-sitter-javascript@0.25.0`'s own `node-types.json`: `using run =
 * > mk();` / `await using run = mk();` parse as `using_declaration`, never
 * > `lexical_declaration`) that falls through to `default: return false`.
 * > Concretely: `function fnA() { return 1; } function run() { return 0; }
 * > function install() { using run = mk(); const T = { alpha: fnA, run };
 * > T.run(); }` (`mk()` returning any object with a `[Symbol.dispose]`
 * > method and a callable shape) — `run`'s declaring scope for THIS question
 * > is the `install` function's own block, but pre-round-16
 * > `introducesShadowedBinding` never notices the `using` declaration, the
 * > walk continues past it, and `run` resolves to the OUTER, `this`-free
 * > decoy with full confidence, the identical failure mode the round-12
 * > arrow-parameter disjunct closed for a different AST shape. **Fixed here,
 * > in `findResolvingScopeNode` alone — NOT in `introducesShadowedBinding`,
 * > despite #2632's own "Suggested fix shape" proposing exactly that.** A
 * > `using_declaration` node carries the IDENTICAL child shape a
 * > `lexical_declaration` does (a `kind` field plus a list of unfielded
 * > `variable_declarator` children — verified against `grammar.json`), so the
 * > EXISTING, type-agnostic `declarationDeclaresName` needs no change at all
 * > to answer the question for it; only a new `child.type === 'using_declaration'`
 * > guard is needed, checked here as a fourth disjunct alongside the
 * > for-in and arrow-parameter ones already ORed onto this same walk.
 * > `introducesShadowedBinding` is deliberately NOT widened, for a sharper
 * > reason than rounds 11/12 gave for the same discipline: #2632's own body
 * > shows condition 3's consumer (`findDeclaringScopeNode`'s ancestor walk,
 * > which shares `introducesShadowedBinding` as its base check) does not
 * > actually NEED this fix at all — missing a `using`-declared shadow there
 * > only ever adds an extra candidate reference to `allReferencesTracked`'s
 * > own conjunction, which can flip its result toward `escapes = true` but
 * > never the other way (the identical conservative-only argument #2629 and
 * > #2630 already establish for the sibling arrow-parameter and for-in gaps
 * > in this same primitive) — while condition 4's consumer, resolved here,
 * > IS a genuine fail-open gap. Widening the shared primitive would fix a
 * > consumer that does not need fixing at the cost of re-perturbing
 * > condition 3's own already-verified-sound walk for no corresponding
 * > benefit — exactly the risk rounds 11 and 12 already declined to take for
 * > the for-in and arrow-parameter gaps, applied here a third time. Closes
 * > #2632.
 * >
 * > This new disjunct is scoped to a `statement_block` ancestor only,
 * > matching #2632's own repro exactly — it does not check a `switch_body`
 * > ancestor, whose own case/default-clause enumeration (in
 * > `introducesShadowedBinding`) carries the identical missing-`using_declaration`
 * > gap `statement_block`'s did. Not verified either way this round, and not
 * > silently left as an unstated gap: filed as its own follow-up — #2637 —
 * > rather than assumed safe or fixed here without first confirming the
 * > `switch_body` case actually reaches it.
 * >
 * > **ROUND 17 (#2088, #2637) — the `switch_body` gap the round-16 essay
 * > above flagged but declined to fix without first confirming it exists.**
 * > Confirmed against the real, already-shipped source:
 * > `introducesShadowedBinding`'s `switch_body` case
 * > (`src/extractors/javascript.ts:4772-4811`) enumerates each
 * > `switch_case`/`switch_default` clause's own direct children for a
 * > `lexical_declaration` (via `declarationDeclaresName`) or a named
 * > `function_declaration`/`generator_function_declaration`/`class_declaration`
 * > — the IDENTICAL enumeration shape its `statement_block` case uses, and
 * > the IDENTICAL omission: no `using_declaration` arm, so an unbraced
 * > `case`/`default` clause's own `using` declaration falls through
 * > unmatched, exactly as a block-scoped one did before round 16's
 * > `statement_block` fix. Concretely, verified runnable under Node 22.18
 * > with `--js-explicit-resource-management`: `function fnA() { return 1; }
 * > function run() { return 0; } function install() { switch (1) { case 1:
 * > using run = mk(); const T = { alpha: fnA, run }; T.run(); } }` (`mk()`
 * > returning any object with a `[Symbol.dispose]` method and a callable
 * > shape, as in round 16's own case (ao)) — `run`'s declaring scope for
 * > THIS question is the `switch`'s own shared clause scope, but
 * > pre-round-17 the walk never notices the `using` declaration, continues
 * > past the `switch_body`, reaches `program`, and `run` resolves to the
 * > OUTER, `this`-free decoy with full confidence — the identical failure
 * > mode round 16's `statement_block` fix closed, for a different AST shape.
 * > Fixed the same way, and in the same function alone — NOT in
 * > `introducesShadowedBinding`, for the identical reason round 16's own
 * > essay gives (condition 3's consumer of the shared primitive does not
 * > need this fix; only condition 4's resolution-only wrapper does): a
 * > fifth disjunct, scoped to a `switch_body` ancestor, scans each direct
 * > `switch_case`/`switch_default` child's own direct children for a
 * > `using_declaration` matching via the existing, unmodified,
 * > type-agnostic `declarationDeclaresName` — the exact shape
 * > `introducesShadowedBinding`'s own `switch_body` arm already uses for
 * > `lexical_declaration`, confirmed by reading that arm directly rather
 * > than assumed. Closes #2637 — found while implementing round 16's
 * > `statement_block` fix, filed rather than fixed blind, and now fixed the
 * > round it was investigated rather than carried further, per the standing
 * > rule in Success Criteria (itself corrected this round — see there for
 * > why leaving this filed any longer was never actually compliant with
 * > that rule's own intent). Matches escape-fallback case (ar) and
 * > correlation shape 13.
 * >
 * > **ROUND 17 (#2088, #2637) — closing #2637 by auditing `switch_body`
 * > alone, rather than every `SCOPE_NODE_TYPES` case for the identical
 * > missing-`using_declaration` gap, would have been the SAME incomplete
 * > confirmation round 16 itself is being corrected for above.** Checked
 * > each of the other nine `SCOPE_NODE_TYPES` members against the real,
 * > already-shipped `introducesShadowedBinding` source directly: seven
 * > (`function_declaration`/`function_expression`/`generator_function_declaration`/
 * > `generator_function`/`arrow_function`/`method_definition`/`catch_clause`)
 * > have no comparable gap, since none of them scans its OWN direct children
 * > for a bare `lexical_declaration`/`using_declaration` at all — a
 * > function's body is itself a nested `statement_block` (or, for an arrow
 * > with an expression body, contains no statement position at all), already
 * > handled when the ancestor walk reaches THAT nested block separately, the
 * > same reasoning `introducesShadowedBinding`'s own `switch_body` doc
 * > comment already gives for a BRACED `case`. Round 17 also claimed
 * > `for_statement`'s own case (the case immediately preceding
 * > `statement_block`'s) checks ONLY `lexical_declaration` among its direct
 * > children — the identical omission `switch_body`'s case had, one node
 * > type over — and closed it with a disjunct scanning that node's direct
 * > children for a `using_declaration`. **ROUND 18 (#2088) found that fix
 * > was dead code, and the claim that motivated it was never checked
 * > against the parser this design actually analyzes with.**
 * >
 * > Round 17's own support for "grammar-valid" was a single fact: `for
 * > (using x = mk(); false; ) {}` "parses and runs under Node 22.18 with
 * > `--js-explicit-resource-management`" — a claim about V8's own
 * > EXPERIMENTAL, in-progress implementation of Explicit Resource
 * > Management, never about `tree-sitter-javascript@0.25.0`, the grammar
 * > `findResolvingScopeNode`/`introducesShadowedBinding` actually walk. The
 * > two disagree, and re-running that exact snippet confirms it: it still
 * > runs under Node (V8 accepts it, leniently, as an in-progress feature),
 * > but it does not parse the way the pre-round-18 fix assumed. Read
 * > directly, `for_statement`'s `initializer` field (`grammar.js:375-390`,
 * > the same file this design already cites for every other grammar claim
 * > in this chain) is `choice($.lexical_declaration, $.variable_declaration)`,
 * > OR a bare `$._expressions` clause, OR `$.empty_statement` — three
 * > alternatives, confirmed identically by the compiled
 * > `node-types.json`'s own `initializer` field schema (`lexical_declaration`,
 * > `variable_declaration`, `expression`, `sequence_expression`,
 * > `empty_statement` — five listed types, no more). `using_declaration` is
 * > declared as its own, independent top-level rule (`grammar.js:335-342`),
 * > reachable only through the general `declaration`/`statement` production
 * > (`grammar.js:223-230`, `293-316`) — the SAME route that makes it a
 * > perfectly ordinary statement inside a `switch_case`'s own clause body
 * > (round 17's `switch_body` fix, correctly verified, above) or a
 * > `statement_block` (round 16's) — but the C-style `for(;;)`'s own
 * > three-clause head is not reached by that general route at all: its
 * > `initializer` slot is a closed, hand-written `choice` that was never
 * > extended to include `using_declaration`. The round-17 disjunct's own
 * > `child?.type === 'using_declaration'` test can therefore never match
 * > anything a `for_statement` can legally contain — dead code, verified by
 * > actually parsing the fixture with the real, installed grammar (via
 * > `web-tree-sitter` against `tree-sitter-javascript`'s own published
 * > `tree-sitter-javascript.wasm`), not merely inferred from the grammar
 * > source: `for (using run45 = disposable45; true; )` produces a
 * > `for_statement` whose would-be initializer position holds not a
 * > `using_declaration` but an `ERROR` node — `ERROR "using run45 =
 * > disposable45"`, ending exactly where the following `;` begins — with
 * > `rootNode.hasError === true` for the whole file. **This means #2637 was
 * > never actually closed for the `for_statement` half — closing it on the
 * > strength of a fix that cannot fire was itself the mistake. #2637 is
 * > reopened.**
 * >
 * > The disjunct's DIRECTION was still right — a `using` declaration
 * > attempted in a for-loop's init clause genuinely should make resolution
 * > through that ancestor fail safe, exactly as round 17 intended — only the
 * > AST SHAPE it keyed on was wrong. Fixed by keying on what the parser
 * > actually produces instead of what a clean re-implementation of the
 * > proposal would: a `for_statement` whose direct children include an
 * > `ERROR` node whose own text begins with `using` or `await using` makes
 * > resolution through that ancestor UNKNOWABLE and fails safe
 * > UNCONDITIONALLY — the same shape the `with_statement` disjunct
 * > immediately below already uses, and for the identical reason: a
 * > malformed `using` attempt is not a declaration this walk can resolve a
 * > NAME against (there is no clean `using_declaration` node to call
 * > `declarationDeclaresName` on), so, like `with`, it does not try to. The
 * > `await using` spelling parses one layer deeper — verified separately,
 * > also against the real parser: `await`, outside an async function, is an
 * > ordinary identifier, not a keyword, so `for (await using run46 = …)`
 * > parses `await using run46` as an `assignment_expression` with `await`
 * > as its own valid, unremarkable `left`-adjacent identifier and the
 * > `ERROR` nested one level inside THAT node instead (`ERROR "using
 * > run46"`) — checked here too, one level down, for the identical reason;
 * > a decoy fixture with `using` used as an ordinary (non-declaration)
 * > variable name in a for-loop head (`for (using = 5; using < 10;
 * > using++)`) parses to the SAME direct-child `ERROR` shape as the plain
 * > `using`-declaration attempt, confirming the check is deliberately as
 * > coarse as `with_statement`'s own — it does not, and structurally
 * > cannot, distinguish a broken declaration attempt from an ordinary
 * > identifier merely spelled `using` colliding with the same parser
 * > ambiguity; both make this walk fail safe, which is the conservative,
 * > correct-by-construction direction this whole design already accepts
 * > everywhere else. `introducesShadowedBinding` is, again, not touched.
 * > Closes #2637 (reopened, then re-closed by this fix). Matches
 * > escape-fallback cases (av) (corrected) and (aw), and correlation shape
 * > 17 (rebuilt).
 * >
 * > **Standing rule (ROUND 18) — added because this is exactly the failure
 * > the fixture-verification step exists to catch, and no round before this
 * > one actually performed it: every fixture in this plan must be parsed
 * > with the real `tree-sitter-javascript` grammar this design analyzes
 * > with, and the node type(s) the corresponding fix keys on must be
 * > confirmed present in the resulting parse tree — not merely inferred
 * > from what a hand-written recursive-descent parser (V8, Babel, or any
 * > other engine) accepts at runtime.** A source snippet "running under
 * > Node" proves the snippet is valid ECMAScript to V8; it proves nothing
 * > about what shape `tree-sitter-javascript` — a separate,
 * > independently-implemented, GLR grammar that may be stricter, looser, or
 * > simply different in its error-recovery behavior for a given construct —
 * > produces for that same text. This design has, since round 8, required
 * > every fixture to prove its intended RUNTIME outcome ("verified runnable
 * > under Node"); it never separately required proving the intended
 * > PARSE-TREE SHAPE, and round 17's own `for_statement` fix is the direct
 * > consequence: its own author verified the runtime behavior meticulously
 * > (correctly) and never once asked tree-sitter what it actually does with
 * > the same text. This binds every round after this one the same way
 * > round 8's non-vacuous-coverage rule and round 9's fail-closed-default
 * > rule already do: a claim of the form "`<node kind>` is what a
 * > `<construct>` parses to" is not established until it has been checked
 * > against the grammar (or, better, the actual parser) directly — a claim
 * > about EXECUTION SEMANTICS and a claim about PARSE STRUCTURE are two
 * > different facts, and this design's fixtures must independently verify
 * > both, never inferring one from the other.
 * >
 * > **ROUND 17 (#2088 finding 3) — a seventh disjunct, on a different axis
 * > than any shadow-detection gap above: a `with` block makes resolution
 * > UNKNOWABLE, not merely shadowed by a declaration this walk failed to
 * > recognise.** `with (obj) { … }` (sloppy mode only — a `SyntaxError`
 * > under `"use strict"` or an ES module, exactly the sloppy-CJS premise
 * > round 15's own Annex-B branch already treats as in scope) resolves an
 * > unqualified identifier reference against `obj`'s OWN properties first,
 * > at RUNTIME, before ever falling back to the lexical scope chain — a
 * > question no static AST walk can answer, since it depends on `obj`'s
 * > actual shape at the moment the block executes. No case for
 * > `with_statement` exists anywhere in this walk, in
 * > `introducesShadowedBinding`, or in `SCOPE_NODE_TYPES`, so a same-named
 * > module-level decoy resolves through a `with` block with full, entirely
 * > unearned confidence. Concretely, verified runnable as sloppy CommonJS:
 * > `function fnA() { return 1; } function run() { return 0; } function
 * > install() { const obj = { run: function () { return this.alpha(); } };
 * > with (obj) { const T = { alpha: fnA, run }; T.run(); } }` — inside the
 * > `with` block, the bare reference `run` (in the shorthand property)
 * > resolves to `obj.run`, the `this`-using function, NOT to the outer,
 * > `this`-free `function run()` declaration; pre-round-17,
 * > `findResolvingScopeNode` has nothing that recognises a `with_statement`
 * > ancestor, so the walk continues past it to `program`, and `run`
 * > resolves to the outer decoy with full confidence. **This does not
 * > contradict the Risks table's own, pre-existing observation that no
 * > static analysis can see through a `with` block** (see the round-17
 * > correction there) — that observation is about determining WHAT `run`
 * > resolves to inside the block, which remains genuinely undecidable
 * > statically; this fix does not attempt that. It only detects THAT
 * > resolution through this ancestor is unknowable, and fails safe
 * > accordingly: any `with_statement` ancestor, regardless of `name`, makes
 * > this function return that ancestor immediately, exactly as though it
 * > were a shadowing declaration for the object literal's own resolution
 * > question. Cheap and strictly conservative — this disjunct only ever
 * > makes MORE sites fail safe, never fewer, and needs no new primitive:
 * > `with_statement` is an ordinary, structurally visible AST node type,
 * > unlike `eval`'s opaque runtime string argument, which offers no
 * > equivalent structural hook to detect at all (see the Risks table's
 * > round-17 correction for why these two Category-F-adjacent shapes are
 * > not actually the same kind of unattemptable). Matches escape-fallback
 * > case (au) and correlation shape 16.
 */
function unwrapParens(node: TreeSitterNode, depth = 0): TreeSitterNode {
  if (depth >= MAX_WALK_DEPTH) return node;
  if (node.type !== 'parenthesized_expression') return node;
  const inner = node.namedChild(0);
  return inner ? unwrapParens(inner, depth + 1) : node;
}

/**
 * ROUND 16 (#2088, #2630/#2632) — the shared unwrap two of
 * `findResolvingScopeNode`'s and both of `subtreeContainsReassignmentOf`'s
 * write-shape disjuncts now route through before calling `patternBindsName`.
 * `parenthesized_expression`'s own grammar shape (verified against
 * `tree-sitter-javascript@0.25.0`'s `grammar.json`: `seq('(', _expressions,
 * ')')`) carries its inner expression with NO field name at all, so it must
 * be read positionally, via `namedChild(0)` — never `childForFieldName`.
 * Mirrors `killsBinding`'s own, pre-existing `parenthesized_expression`
 * unwrap (`src/extractors/javascript.ts:5317-5323`) rather than inventing a
 * new idiom: that function's own comment already establishes RECURSING
 * (not peeling once) is required, since a doubly-parenthesized target
 * (`((run)) = …`) nests two `parenthesized_expression` layers deep. Depth
 * capped like every other recursive walk in this file (`MAX_WALK_DEPTH`);
 * on truncation, returns the node UNCHANGED (still wrapped) rather than its
 * unreached innermost expression, so the caller's own `patternBindsName`
 * call simply fails to match on a pathologically deep nest — fail-OPEN on
 * truncation, the same direction `patternBindsName` itself already takes on
 * its own depth cap (see `countHoistedVarScopeDeclarations`'s own doc
 * comment for why this asymmetry is inherited, not introduced, here) — not
 * a new risk this helper adds.
 *
 * Deliberately local to condition 4's own three call sites — NOT a change
 * to `patternBindsName` itself, which stays exactly as narrow as every
 * OTHER verified consumer (`blockContainsIdentifierExcluding`'s for-in
 * branch, `killsBinding`'s own assignment branch, `declarationDeclaresName`)
 * already depends on it being. Widening the shared primitive to add a
 * `parenthesized_expression` case directly would fix this same gap for
 * every consumer at once, including `blockContainsIdentifierExcluding`'s —
 * which #2630 already shows does not need it (see `findResolvingScopeNode`'s
 * own round-16 essay) — for no benefit over unwrapping at the two call
 * sites that actually do.
 */
function findResolvingScopeNode(node: TreeSitterNode, name: string): TreeSitterNode | undefined {
  let current: TreeSitterNode | null = node.parent;
  while (current) {
    if (current.type === 'for_in_statement') {
      const left = current.childForFieldName('left');
      if (left && patternBindsName(unwrapParens(left), name)) return current;
    }
    if (current.type === 'arrow_function') {
      const param = current.childForFieldName('parameter');
      if (param && param.text === name) return current;
    }
    // ROUND 16 (#2088, #2632) — see the essay above for why this is checked
    // here, on `findResolvingScopeNode`'s own walk, rather than added to
    // `introducesShadowedBinding`'s `statement_block` case.
    if (current.type === 'statement_block') {
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child?.type === 'using_declaration' && declarationDeclaresName(child, name)) {
          return current;
        }
      }
    }
    // ROUND 17 (#2088, #2637) — the `switch_body` counterpart of the
    // `statement_block` case just above; see the essay above for why this
    // is fixed here, mirroring `introducesShadowedBinding`'s own
    // `switch_body` enumeration shape rather than widening that shared
    // primitive.
    if (current.type === 'switch_body') {
      for (let i = 0; i < current.childCount; i++) {
        const clause = current.child(i);
        if (!clause) continue;
        if (clause.type !== 'switch_case' && clause.type !== 'switch_default') continue;
        for (let j = 0; j < clause.childCount; j++) {
          const child = clause.child(j);
          if (child?.type === 'using_declaration' && declarationDeclaresName(child, name)) {
            return current;
          }
        }
      }
    }
    // ROUND 18 (#2088, #2637 reopened) — REPLACES round 17's own
    // `for_statement` disjunct, which scanned for a `using_declaration`
    // child that `tree-sitter-javascript@0.25.0`'s grammar can never
    // produce there (verified against `grammar.js:375-390` and
    // `node-types.json`'s own `initializer` field schema, and against the
    // real parser: the broken text surfaces as an `ERROR` node, not a
    // `using_declaration` one) — see the essay above for the full
    // correction and the new fixture-verification standing rule it adds.
    // Detects the MALFORMED shape itself and fails safe unconditionally,
    // exactly like the `with_statement` disjunct below: there is no clean
    // declaration node here to resolve a name against, so this does not
    // attempt to.
    if (current.type === 'for_statement') {
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child && isMalformedUsingInitializer(child)) return current;
      }
    }
    // ROUND 17 (#2088 finding 3) — a `with` block makes resolution
    // UNKNOWABLE, not merely shadowed by a declaration this walk failed to
    // recognise; see the essay above. Unconditional: no `name` check, since
    // ANY `with` ancestor makes EVERY identifier resolved inside it
    // unknowable, not only ones a shadow check could in principle rule out.
    if (current.type === 'with_statement') return current;
    if (introducesShadowedBinding(current, name)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * ROUND 18 (#2088, #2637 reopened) — true when `node` is the parser's own
 * error-recovery artifact for a `using`/`await using` declaration attempted
 * where the grammar does not allow one (a C-style `for_statement`'s
 * initializer clause — see `findResolvingScopeNode`'s own `for_statement`
 * disjunct and its doc comment for the full argument and the parse-tree
 * evidence). Checked at two levels, never recursively deeper, because only
 * two shapes have been observed and verified against the real parser:
 *
 *   - The plain `using` spelling surfaces as a direct-child `ERROR` node
 *     whose own text begins with it (`ERROR "using run45 = disposable45"`).
 *   - The `await using` spelling parses one layer deeper: `await`, outside
 *     an async function, is an ordinary identifier rather than a keyword,
 *     so the whole clause parses as an `assignment_expression` with `await`
 *     as its valid left-adjacent identifier and the `ERROR` nested one
 *     level inside THAT node instead (`ERROR "using run46"`).
 *
 * Deliberately coarse, matching `with_statement`'s own unconditional
 * disjunct: this cannot distinguish a broken declaration attempt from an
 * ordinary identifier merely spelled `using`/`await` that collides with the
 * same parser ambiguity (verified: `for (using = 5; using < 10; using++)`,
 * `using` used purely as a variable name, parses to the identical
 * direct-child `ERROR` shape) — both make the caller fail safe, which is
 * the accepted, conservative direction, not a new risk this helper adds.
 */
function isMalformedUsingInitializer(node: TreeSitterNode): boolean {
  if (node.type === 'ERROR' && /^(await\s+using|using)\b/.test(node.text)) return true;
  for (let i = 0; i < node.childCount; i++) {
    const inner = node.child(i);
    if (inner?.type === 'ERROR' && /^(await\s+using|using)\b/.test(inner.text)) return true;
  }
  return false;
}

/**
 * Round 7 (#2088 finding 3) — resolve a plain identifier that is the value
 * of an object-literal pair (or, round 9, a shorthand property) to the
 * same-file function it names, and report whether that function's body
 * contains `this`. FIVE-way fail-safe structure as of round 13 (four-way
 * through round 12; three-way through round 9) — see
 * `literalHasUnmodeledThisReference`'s doc comment for the full argument;
 * this function implements exactly those branches and nothing else.
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
 * >
 * > **ROUND 13 (#2088 finding 1) — resolving to an unshadowed, in-file
 * > declaration is still not enough: the declaration itself must never be
 * > REASSIGNED.** `findTopLevelFunctionNodeByName` below deliberately
 * > accepts a `function_declaration`, a `lexical_declaration` (`let`), OR a
 * > `variable_declaration` (`var`) — every one of which is a MUTABLE
 * > binding, not just the `const` case. Nothing before this round asked
 * > whether the name is ever WRITTEN to after that initial declaration, so
 * > a module-level `let run = () => {};` read as positively safe (an
 * > arrow, excluded by the very next branch) even when a later, plain
 * > top-level statement — `run = function () { return this.alpha(); };` —
 * > rebinds `run` to a `this`-using function before the object literal
 * > using it is ever constructed. Concretely: `function fnAlpha() { return
 * > 1; } let run = () => {}; run = function () { return this.alpha(); };
 * > const T = { alpha: fnAlpha, run }; T.run();` — `run` resolves,
 * > unshadowed, to the ARROW value of the `let run` declarator (no scope
 * > strictly between `T` and the module root declares `run`, so
 * > `findResolvingScopeNode` finds nothing to fail safe on), the
 * > arrow-function branch below votes safe without ever looking at the
 * > reassignment, `escapes` comes out `false`, and `fnAlpha` is reported
 * > dead though `T.run()` — `this === T` — invokes it on every call via the
 * > REASSIGNED function. This is also a regression against today:
 * > `extractReceiverName` returns `'this'` for the INNER `this.alpha()`
 * > call's own receiver, and `collectInvokedPropertyNames` credits any
 * > truthy receiver regardless of which literal it points at, so `fnAlpha`
 * > is currently (pre-#2088) live. Closed by a new check, run AFTER
 * > `findTopLevelFunctionNodeByName` resolves a node but BEFORE the
 * > arrow-function branch ever votes safe: `subtreeContainsReassignmentOf`
 * > (below) walks the WHOLE file — not just the resolved declaration's own
 * > subtree, since the reassignment in the counter-example above is a
 * > SIBLING top-level statement, not nested inside it — for an
 * > `assignment_expression`/`augmented_assignment_expression` whose `left`
 * > BINDS `name` (round 14, #2088 finding 1: via `patternBindsName`, so a
 * > destructuring target counts too, not only a bare identifier — see
 * > `subtreeContainsReassignmentOf`'s own doc comment for what this closes
 * > and the one shape, tracked at #2630, it still cannot see), an
 * > `update_expression` on it, or a
 * > `for_in_statement` whose `left` binds it with NO `kind` field (an
 * > assignment to a pre-existing binding, never a declaration — verified
 * > against `tree-sitter-javascript@0.25.0`'s own `grammar.json`: the
 * > for-loop's own leading `await` token, when present, carries NO field
 * > name at all, so it can never be mistaken for the SEPARATELY
 * > `kind`-tagged `var`/`let`/`const`/`using` declaration keyword — a
 * > `for await (run of asyncIter)` reassignment is therefore caught by this
 * > same "no `kind` field" test exactly like a plain `for (run of iter)`
 * > would be). Finding ANY such write fails safe unconditionally,
 * > regardless of what the write assigns — this function does not attempt
 * > to resolve the NEW value and check IT for `this`-freedom, the same
 * > "detect, then fail safe outright, rather than resolve one layer
 * > deeper" choice round 10 already made for a shadowing declaration, for
 * > the identical reason: doing so would require a THIRD AST-search shape
 * > (after the module-level declaration search and the ancestor shadow
 * > walk) to keep correct in both engines, for a case the `#1771`/`#1784`
 * > precedent was never asked to cover. Failing safe costs recall only for
 * > the case where `name` IS reassigned but every value it is ever
 * > reassigned to is ALSO provably `this`-free — filed as a follow-up
 * > rather than silently accepted; see Success Criteria and #2631. This
 * > does not touch `findResolvingScopeNode`, `introducesShadowedBinding`,
 * > or `SCOPE_NODE_TYPES` — the shadow question (is `name`, AT THIS
 * > LEXICAL POSITION, a DIFFERENT binding than the module-level one) and
 * > the reassignment question (is the module-level binding ITSELF ever
 * > overwritten) are independent axes, and round 10–12's shadow walk is
 * > unaffected by, and does not need to know about, this one.
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
  // ROUND 19 (#2088, non-blocking consistency finding) — compares `.id`, not
  // the node objects themselves: this file's own established convention
  // (`isTrackedReferencePosition`'s `parent.childForFieldName('object')?.id
  // !== refNode.id` and its sibling checks, lines 666/670/735) exists
  // because this binding mints a fresh wrapper object per access, so two
  // wrappers over the identical underlying node are never `===`. The `??
  // root` fallback above happens to return the SAME wrapper reference `root`
  // already is, so a bare `!==` was not, in practice, observed to misfire —
  // but it is the one node-identity comparison in this file that did not
  // follow the established convention, and relying on that happening to be
  // safe today is not a substitute for following the same rule every other
  // comparison in this file does. Corrected for consistency; no behavior
  // change.
  if (declaringScope.id !== root.id) return true; // shadowed by a non-module scope — fail-safe.

  const fnNode = findTopLevelFunctionNodeByName(root, name);
  if (!fnNode) return true; // no UNAMBIGUOUS module-level declaration — either none at all, or (round 14, #2088 finding 2) more than one — fail-safe.

  // ROUND 13 (#2088 finding 1) — the resolved declaration is a MUTABLE
  // binding (`findTopLevelFunctionNodeByName` accepts `let`/`var` as well as
  // `const`); nothing above asks whether it is ever WRITTEN to elsewhere in
  // the file, so a reassignment to a `this`-using value would otherwise
  // slip past the arrow-function check just below undetected. See this
  // function's own doc comment for the counter-example this closes.
  if (subtreeContainsReassignmentOf(root, name, 0)) return true; // reassigned somewhere in the file — fail-safe.

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
 * or (ROUND 14, #2088 finding 2) when MORE THAN ONE top-level declaration of
 * `name` exists, regardless of shape — both of which
 * `resolveIdentifierValueThisReference` above treats identically, as
 * fail-safe.
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
 * >
 * > (ROUND 13: this function's own declaration-shape matching is UNCHANGED
 * > — it still deliberately accepts a `let`/`var` binding alongside
 * > `const`, per the doc comment above, and it still should: rejecting a
 * > mutable binding outright would cost recall for the overwhelmingly
 * > common case where such a binding is never actually reassigned. What
 * > changed is the CALLER: it now separately checks, via
 * > `subtreeContainsReassignmentOf`, whether the resolved declaration is
 * > ever WRITTEN to elsewhere in the file, and fails safe if so, BEFORE
 * > ever reaching the arrow-function/`this`-body check that would
 * > otherwise trust this function's returned node at face value. See
 * > `resolveIdentifierValueThisReference`'s own doc comment for the
 * > counter-example this closes and #2631 for the recall the fix costs.)
 * >
 * > **ROUND 14 (#2088 finding 2) — this function's OWN body changes, for
 * > the first time in this plan's history; every prior round's fix (10
 * > through 13) lived entirely in the CALLER.** Through round 13, the loop
 * > below returned the FIRST top-level declaration of `name` it encountered
 * > and stopped — a `function_declaration` match returns immediately, and a
 * > `variable_declarator` match returns its value the instant it finds one
 * > of the three recognised function shapes — silently ignoring any SECOND
 * > (or later) top-level declaration of the identical name. `var` permits
 * > redeclaration (legal in both a classic script and an ES module), and a
 * > sibling `function_declaration` with the same name is legal in a
 * > non-strict, non-module CommonJS file — a `SyntaxError` only under
 * > `"use strict"` or an ES module. In both shapes the RUNTIME binding is
 * > always the LAST declaration, never the first:
 * >
 * > ```js
 * > var run = () => {};                              // FIRST — this-free
 * > var run = function () { return this.alpha(); };  // LAST — this is what runs
 * > ```
 * > ```js
 * > function run() { return 0; }                     // FIRST — this-free
 * > function run() { return this.alpha(); }          // LAST — this is what runs
 * > ```
 * >
 * > Pre-round-14, this function returned the FIRST, `this`-free declaration
 * > in either shape with full confidence — never `null` — so
 * > `resolveIdentifierValueThisReference`'s own fail-safe (`if (!fnNode)
 * > return true`) never fired, condition 4 voted safe, and the handler
 * > actually backed by the SECOND, `this`-using declaration was reported
 * > dead though it is what every call invokes. This is the identical
 * > "confidently wrong rather than honestly unresolved" failure class round
 * > 10 closed for a shadowed name and round 13 closed for a reassigned one —
 * > applied here to a REDECLARED one instead. Neither shape is an
 * > `assignment_expression`/`augmented_assignment_expression`/
 * > `update_expression`/`for_in_statement`, so `subtreeContainsReassignmentOf`
 * > (including its own round-14 finding-1 widening, below) cannot see either
 * > one regardless: a second declaration is not a WRITE to an existing
 * > binding, it is a second DECLARATION of one — a different grammar shape
 * > entirely, and a question only THIS function, not the reassignment scan,
 * > is positioned to answer. Fixed by counting every top-level declaration of
 * > `name` this loop encounters — a `function_declaration` match, or a
 * > `variable_declarator` match under a `lexical_declaration`/
 * > `variable_declaration`, regardless of whether ITS OWN value is one of
 * > the three recognised function shapes — and returning `null` the instant
 * > more than one exists, rather than the first. This costs recall for a
 * > name declared more than once at module level where the LAST declaration
 * > alone is what actually executes and is itself provably `this`-free (or,
 * > more narrowly, a harmless `var name;` restatement with no initializer at
 * > all, which this fix also — over-conservatively — treats as disqualifying)
 * > — filed as a follow-up rather than silently accepted; see Success
 * > Criteria and #2633.
 * >
 * > **ROUND 15 (#2088 finding 1) — the count above is itself too narrow: it
 * > only ever sees a declaration that is a DIRECT CHILD of `root`, but `var`
 * > is function-scoped, not block-scoped.** A `var name` sitting inside a
 * > bare block, `if`, `for`, `try`, or `switch` body at module level hoists
 * > to the SAME module-scope binding a direct top-level `var name` would —
 * > not a distinct, block-scoped shadow the way a `let`/`const name` in the
 * > identical position is. The Testing Strategy section's own round-14
 * > scope-coverage note claimed "there is no function- or block-scoped
 * > variant of 'two top-level declarations' to fixture at all... the
 * > question is structurally module-scope-only" — true of this function's
 * > pre-round-15 IMPLEMENTATION, but false of JS semantics; corrected there
 * > as of this round. Concretely, verified runnable under real Node (a
 * > plain ES module — no sloppy mode, no Annex B required):
 * >
 * > ```js
 * > function fnAlpha() { return 1; }
 * > var run = () => {};                                 // only TOP-LEVEL declaration
 * > if (globalThis.LEGACY !== 'never') {
 * >   var run = function () { return this.alpha(); };   // same hoisted binding, in a block
 * > }
 * > const T = { alpha: fnAlpha, run };
 * > T.run();                                             // => 1: invokes the SECOND declaration
 * > ```
 * >
 * > Pre-round-15, `declarationCount` only ever walked `root`'s direct
 * > children, so it saw exactly the first `var run = () => {}` and nothing
 * > else — the `if` body is not itself a direct-child match, and this
 * > function never looked inside it — leaving `declarationCount` at 1 and
 * > `result` pointing at the arrow, confidently wrong in the identical way
 * > round 10 (a shadowed name), round 13 (a reassigned one), and round 14
 * > (a duplicate direct-child one) already closed for this same chain,
 * > applied here to a redeclaration reachable only through hoisting. The
 * > classic sloppy-mode "Annex B" web-legacy semantics (ECMA-262 §B.3.3)
 * > extend the identical hazard to a bare block-level `function` declaration
 * > instead of `var`: `function run(){return 0;} { function run(){return
 * > this.alpha();} }` is also verified runnable (as a non-strict, non-module
 * > script) and resolves the same way.
 * >
 * > Fixed by widening the count from "direct children of `root`" to "the
 * > module's own var scope": every top-level statement that is NEITHER a
 * > direct `function_declaration` NOR a direct `lexical_declaration`/
 * > `variable_declaration` (the two shapes the loop below already handles)
 * > is additionally walked, via new `countHoistedVarScopeDeclarations`
 * > below, for a `var` declarator or a block-level `function_declaration`
 * > matching `name` anywhere in its subtree, PROVIDED the walk never crosses
 * > into a nested function — reusing `functionScopeDeclaresVar`'s own
 * > traversal rule (`src/extractors/javascript.ts:4660-4672`), generalised
 * > from a boolean "does at least one exist" to a count, because this
 * > function's fail-safe needs to know not just THAT a hoisted redeclaration
 * > exists, but whether the TOTAL — direct-child plus hoisted-through-block —
 * > exceeds one. **Deliberately excludes `lexical_declaration` (`let`/
 * > `const`) from the hoisted count**: a `let`/`const name` nested in a
 * > sibling block is block-scoped — a genuinely DIFFERENT binding, not a
 * > redeclaration of the module-level one — and is already the shadow
 * > axis's own concern (`findResolvingScopeNode`/`introducesShadowedBinding`,
 * > checked at the object literal's OWN lexical position, rounds 10-12),
 * > never this count's. Counting a `let`/`const` here would treat every
 * > legitimate inner shadow already covered by cases (v)-(z)/(aa)/(ad) as an
 * > ambiguous "duplicate declaration" instead, forcing this function to fail
 * > safe on an ordinary, correctly-handled shadow and silently regressing
 * > every one of those fixtures' own T1 correlation. WU-10's new correlation
 * > shape 8 proves this exclusion holds, not just states it. This fix does
 * > not attempt to resolve `result` to a declaration that exists ONLY inside
 * > a nested block (an unambiguous total of exactly one, entirely hoisted),
 * > nor gate the Annex-B branch on the file's own strict/sloppy/module parse
 * > goal — both cost recall, never soundness, the same accepted asymmetry as
 * > round 14's own #2633; filed as a follow-up rather than silently accepted
 * > — see Success Criteria and #2635. Matches escape-fallback cases (aj)/(ak).
 * >
 * > **ROUND 16 (#2088, #2636) — the direct-children loop's own
 * > `function_declaration` test is an exact match against ONE of two sibling
 * > grammar kinds `FUNCTION_SCOPE_NODE_TYPES` itself already distinguishes: a
 * > generator function DECLARATION (`function* name(){}`) is
 * > `generator_function_declaration`, a separate kind, invisible to this loop
 * > entirely through round 15.** Concretely, verified runnable under real
 * > Node: `function run() { return 0; } function* run() { return this.alpha();
 * > } const T = { alpha: fnA, run }; T.run();` — `run`'s SECOND declaration
 * > (a generator) wins at runtime, per ordinary "last sibling declaration
 * > wins" semantics this chain already relies on for two plain
 * > `function_declaration`s (case (ai)) — confirmed empirically:
 * > `run.constructor.name === 'GeneratorFunction'` after the redeclaration.
 * > **#2636's own body claims this gap is "fail-safe-already… since nothing
 * > ever returns such a node as `result` either" — true only when EVERY
 * > declaration of `name` is a generator (its own worked example). It is
 * > FALSE, and the failure is CONFIDENTLY WRONG, not fail-safe, the moment
 * > the redeclaration is MIXED, as in the example just above:** the FIRST
 * > declaration (`function run(){}`, plain) matches this loop's existing
 * > `function_declaration` branch, `declarationCount` becomes 1 and `result`
 * > is set to it; the SECOND declaration (the generator) matches neither this
 * > branch nor the `lexical_declaration`/`variable_declaration` one, so
 * > (pre-round-16) it falls to the hoisted-count branch below and is
 * > invisible there too (see `countHoistedVarScopeDeclarations`'s own
 * > round-16 essay) — `declarationCount` never exceeds 1, and this function
 * > confidently returns the FIRST, `this`-free declaration, though the
 * > runtime binding is the SECOND, `this`-using one. This is also a
 * > regression against today, for the same reason rounds 13-15's own gaps
 * > were. Fixed by giving `generator_function_declaration` its own branch
 * > here, parallel to `function_declaration` in every respect — count AND
 * > set `result` AND `continue` — so a top-level generator is recognised as
 * > a redeclaration CANDIDATE exactly like a plain function declaration is,
 * > and a LONE top-level generator still resolves with confidence (matching
 * > this chain's own "an honestly unambiguous case must still correlate"
 * > discipline, e.g. case 6/8's own guard shapes). See
 * > `countHoistedVarScopeDeclarations`'s own round-16 essay for why this
 * > loop — not that function's recursive walk — is where the fix belongs.
 * > Closes #2636; corrects the identical non-sequitur repeated in this
 * > plan's own Success Criteria section and in `countHoistedVarScopeDeclarations`'s
 * > doc comment.
 */
function findTopLevelFunctionNodeByName(root: TreeSitterNode, name: string): TreeSitterNode | null {
  let result: TreeSitterNode | null = null;
  let declarationCount = 0; // ROUND 14 (#2088 finding 2); ROUND 15 (#2088 finding 1)
                            // widens what this counts to the module's own var scope
                            // — see doc comment above.
  for (let i = 0; i < root.childCount; i++) {
    let stmt = root.child(i);
    if (stmt?.type === 'export_statement') {
      stmt = stmt.childForFieldName('declaration') ?? stmt.child(1);
    }
    if (!stmt) continue;
    if (stmt.type === 'function_declaration' || stmt.type === 'generator_function_declaration') {
      // ROUND 16 (#2088, #2636) — `generator_function_declaration` is a full
      // sibling of `function_declaration` here: both are top-level
      // redeclaration CANDIDATES, and either may be the one the runtime
      // actually binds `name` to. See this function's own doc comment.
      if (stmt.childForFieldName('name')?.text === name) {
        declarationCount++;
        result = stmt;
      }
      continue;
    }
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      for (let j = 0; j < stmt.childCount; j++) {
        const decl = stmt.child(j);
        if (decl?.type !== 'variable_declarator') continue;
        if (decl.childForFieldName('name')?.text !== name) continue;
        declarationCount++;
        const value = decl.childForFieldName('value');
        if (
          value &&
          (value.type === 'arrow_function' ||
            value.type === 'function_expression' ||
            value.type === 'function')
        ) {
          result = value;
        }
      }
      continue;
    }
    // ROUND 15 (#2088 finding 1) — `stmt` is some OTHER top-level statement
    // (a bare block, `if`, `for`, `try`, `switch`, or anything else) — but
    // `var` is function-scoped, not block-scoped, and a sloppy-mode
    // block-level `function` declaration (Annex B) ALSO hoists to the
    // enclosing script's own scope: either shape, buried anywhere in this
    // statement's own subtree, declares the SAME module-level binding a
    // direct top-level `var`/`function` of the same name would, provided the
    // walk never crosses INTO a nested function. See this function's own
    // doc comment for why a `let`/`const` in the same position is
    // deliberately NOT counted here.
    declarationCount += countHoistedVarScopeDeclarations(stmt, name, 0);
  }
  // ROUND 14 (#2088 finding 2) — more than one top-level declaration of `name`
  // exists; the runtime binding is always the LAST one, never the first
  // (which `result` may still hold from an earlier loop iteration), so
  // returning any single candidate with confidence would be the identical
  // "confidently wrong" failure mode round 10 already closed for a shadowed
  // name. Fail safe instead — see this function's own doc comment. (ROUND
  // 15: `declarationCount` may now also include a hoisted-through-block
  // match `result` was never assigned from — the fail-safe fires exactly the
  // same way regardless of which side of the count contributed the second
  // one.)
  return declarationCount > 1 ? null : result;
}

/**
 * ROUND 15 (#2088 finding 1) — counts every declaration of `name` reachable
 * from `node` without crossing a FUNCTION boundary that hoists to the
 * ENCLOSING module/script's own var scope: a `var` declarator
 * (`variable_declaration`, never a `lexical_declaration` — see below), or a
 * block-level `function_declaration` (the sloppy-mode "Annex B" web-legacy
 * hoisting rule, ECMA-262 §B.3.3). `findTopLevelFunctionNodeByName`'s own
 * direct-children loop above cannot see either shape once it is nested
 * inside a bare block/`if`/`for`/`try`/`switch` body rather than sitting as
 * a direct child of `root` — this function is what makes those hoisted
 * declarations visible to that loop's own `declarationCount` fail-safe.
 *
 * Builds on `functionScopeDeclaresVar`'s traversal rule — never cross into a
 * nested function's own, independent `var`/Annex-B scope — generalised from
 * that function's boolean "does at least one exist" return to a count,
 * because `findTopLevelFunctionNodeByName`'s own fail-safe needs to know not
 * just THAT an additional hoisted declaration exists, but how many exist in
 * total once combined with the direct-children count gathered above.
 *
 * **Not a literal one-for-one reuse of that function's shape, for a reason
 * specific to this extension.** `functionScopeDeclaresVar` only ever needs
 * to recognise a `variable_declaration` node, which is NEVER ITSELF a member
 * of `FUNCTION_SCOPE_NODE_TYPES` — so it can safely pre-filter, at the
 * PARENT's own loop, any CHILD whose type opens a function scope, before
 * ever calling itself on that child at all: a `var` match can never be lost
 * this way, since a `var` declaration node is never one of the types being
 * filtered out. This function additionally needs to recognise a
 * `function_declaration` node — which IS itself a member of
 * `FUNCTION_SCOPE_NODE_TYPES` — so the identical parent-side pre-filter
 * would skip calling this function on a nested `function_declaration`
 * child entirely, silently discarding the exact Annex-B match this function
 * exists to find (case (ak) would go uncounted, the FIRST direct-child
 * `run25` would be returned with full confidence, and this fix would not
 * fire at all for the one AST shape it was built to catch). The traversal
 * below therefore checks EVERY node's own type for a match FIRST — on the
 * node itself, not pre-filtered by its parent — and only THEN asks whether
 * that same node's type means "stop, do not recurse into its body," rather
 * than deciding whether to visit a node at all before ever examining it.
 *
 * **Deliberately excludes `lexical_declaration` (`let`/`const`).** A
 * `let`/`const name` declared inside a nested block is block-scoped — a
 * genuinely DIFFERENT binding from a module-level `name`, not a
 * redeclaration of it — and is already the shadow axis's own concern,
 * covered by `findResolvingScopeNode`/`introducesShadowedBinding` at the
 * object literal's OWN lexical position (rounds 10-12), never by this
 * count. Counting a `let`/`const` here would treat every legitimate inner
 * shadow as an ambiguous "duplicate declaration" and force
 * `findTopLevelFunctionNodeByName` to fail safe on an ordinary,
 * correctly-handled shadow — silently regressing every fixture rounds
 * 10-12 already established for that axis (cases (v)-(z)/(aa)/(ad)). See
 * WU-10's new correlation shape 8, which proves this exclusion holds, not
 * just states it.
 *
 * Does not distinguish the file's own strict/sloppy/module parse goal
 * before counting a block-level `function_declaration` — Annex B hoisting
 * applies only in sloppy script code, so this over-counts (costing recall,
 * never soundness) in a strict-mode/ESM file; filed as a follow-up rather
 * than threading parse-goal detection through this call chain — #2635.
 *
 * **ROUND 16 (#2088, #2636) — corrects a claim this doc comment made through
 * round 15 that did not actually hold.** It used to say the
 * `node.type === 'function_declaration'` check above — an exact string match
 * against ONE of two sibling grammar kinds `FUNCTION_SCOPE_NODE_TYPES` itself
 * already distinguishes, leaving a generator function DECLARATION
 * (`function* name(){}`, kind `generator_function_declaration`) invisible to
 * this count — was "fail-safe-already, not confidently wrong, since nothing
 * here ever returns such a node as `result` either." **That is true only
 * when EVERY top-level declaration of `name` is a generator — #2636's own
 * worked example (two sibling generators). It is false, and the failure is
 * CONFIDENTLY WRONG, the moment the redeclaration is MIXED**: a direct-child
 * `function_declaration` sets `findTopLevelFunctionNodeByName`'s own `result`
 * and increments its `declarationCount` through that loop's OWN
 * `function_declaration` branch, entirely independently of this function;
 * a SECOND, generator-shaped sibling — direct-child or hoisted through a
 * block alike — was invisible to both this function AND that loop, so
 * `declarationCount` never exceeded 1 and the FIRST, possibly-stale
 * declaration was returned with full confidence. See
 * `findTopLevelFunctionNodeByName`'s own round-16 essay for the
 * counter-example this closes and confirmation this doc comment's
 * "fail-safe-already" framing does not hold for that shape either. **Fixed
 * in `findTopLevelFunctionNodeByName`'s direct-children loop, NOT here**: a
 * generator sitting as a direct child of `root` is now caught there
 * directly (mirroring `function_declaration` exactly — counted, and set as
 * `result`) and never reaches this function's own recursive walk at all.
 * **This function's own recursive walk deliberately does NOT gain a
 * `generator_function_declaration` case, unlike `function_declaration`'s
 * unconditional (any-depth) one just above** — verified empirically against
 * real Node (a sloppy, non-strict, non-module script): `function run(){}
 * if(true){ function* run(){} } console.log(run())` prints the OUTER
 * function's own return value, unchanged — Annex B §B.3.3's block-level
 * hoisting is defined only for a plain `FunctionDeclaration`, never for a
 * `GeneratorDeclaration`/`AsyncFunctionDeclaration`/`AsyncGeneratorDeclaration`,
 * so a NESTED generator (reached only via this function's own recursion,
 * never via the direct-children loop's now-fixed top-level branch) does NOT
 * hoist to or redeclare the enclosing module/script scope at all — it is a
 * genuinely different, block-scoped binding, already `introducesShadowedBinding`'s
 * own `statement_block` case's concern (which already lists
 * `generator_function_declaration` alongside `function_declaration`/
 * `class_declaration`, `javascript.ts:4761-4768`), exactly the same
 * "block-scoped, not hoisted, already the shadow axis's own concern" reason
 * `lexical_declaration` is excluded just above. Counting it here would
 * silently re-widen this function's already-established `let`/`const`
 * exclusion to a second shape for no corresponding real-world hoisting rule
 * — a fabricated, non-existent hoist this doc comment declines to claim
 * merely because `findTopLevelFunctionNodeByName`'s own direct-children fix
 * needed the SAME node kind recognised one level up. Closes #2636; also
 * corrects the identical non-sequitur this plan's own Success Criteria
 * section repeated verbatim.
 *
 * Depth-bounded like every other recursive walk in this file
 * (`MAX_WALK_DEPTH`) — and, like `subtreeContainsReassignmentOf`, truncation
 * counts toward "an additional declaration exists" (returns 2, guaranteeing
 * the combined total exceeds the caller's `> 1` fail-safe threshold
 * regardless of what else this call contributes) rather than toward "not
 * found": this function's whole contract is detecting ambiguity, so
 * truncating toward zero would let a pathologically deep file read as
 * unambiguous by omission — the same fail-safe/fail-open asymmetry
 * `subtreeContainsReassignmentOf`'s own doc comment already states for the
 * identical reason.
 *
 * One asymmetry this reuse inherits rather than introduces: `declarationDeclaresName`
 * resolves a `var` declarator's own name through `patternBindsName`, whose
 * `depth >= MAX_WALK_DEPTH` case returns `false` — fail-OPEN, the opposite of
 * this function's and `subtreeContainsReassignmentOf`'s own truncate-toward-
 * "found" convention. A 200-deep nested destructuring pattern on a hoisted
 * `var`'s own name (`var { a: { b: { … 200 levels … : name } } } = x;`) could
 * therefore, in principle, go uncounted rather than forcing the fail-safe
 * this function otherwise guarantees — pathological enough that no fixture
 * targets it, but worth stating rather than leaving silent now that this
 * function is the first caller in `findTopLevelFunctionNodeByName`'s own
 * chain to reach `patternBindsName` at all.
 *
 * **ROUND 17 (#2088 finding 1) — this function's own enumeration has a gap
 * of the SAME kind as round 16's #2636 finding in the sibling function,
 * `findTopLevelFunctionNodeByName`'s direct-children loop: a
 * grammar-distinct declaration SHAPE this recursive walk never checks for
 * at all.** A `var`-kind for-of/for-in loop head — `for (var name of
 * iter)` — is, per `var`'s own function-scoped semantics, a hoisted
 * declaration of `name` at this SAME var scope, exactly like a direct
 * top-level `var name` or an Annex-B block-level `function name(){}` is —
 * but, verified directly against the real grammar (the same
 * `tree-sitter-javascript@0.25.0` this file's other round-13-through-16
 * essays already cite): `for (var name of xs)` places the `var` token and
 * the `name` pattern DIRECTLY under the `for_in_statement` node itself, via
 * its own `kind`/`left` fields — there is no nested `variable_declaration`
 * node for this function's existing first check to match at all, unlike a
 * bare-block `var name;` statement, which IS wrapped in one. Concretely,
 * verified runnable under real Node, as a plain ES module with NO flags:
 *
 * ```js
 * function fnAlpha() { return 1; }
 * var run = () => {};                                          // direct top-level declaration — this-free
 * for (var run of [function () { return this.alpha(); }]) { }   // REBINDS the same hoisted `run`
 * const T = { alpha: fnAlpha, run };
 * T.run();                                                      // => 1: invokes the REBOUND function
 * ```
 *
 * Pre-round-17, this function's walk finds no match for the for-of
 * statement at all (its own two checks recognise only `variable_declaration`
 * and `function_declaration`), so `declarationCount` stays at 1 (from the
 * direct top-level `var run` alone), `findTopLevelFunctionNodeByName`
 * confidently returns the FIRST, `this`-free arrow — the identical
 * "confidently wrong rather than honestly unresolved" failure class rounds
 * 10, 13, 14, 15, and 16 each closed elsewhere in this chain. Fixed by a new
 * check recognising a `for_in_statement` whose own `kind` field's text is
 * `var` and whose `left` field binds `name` (via `unwrapParens`/
 * `patternBindsName`, the same primitives every other `for_in_statement.left`
 * read in this file already uses) as one more hoisted declaration.
 * `let`/`const`/`using` for-of/for-in heads are deliberately NOT matched by
 * this new check, for the identical reason `lexical_declaration` is already
 * excluded just above: each creates a genuinely NEW, loop-scoped binding,
 * already the shadow axis's own concern (`findResolvingScopeNode`'s
 * pre-existing for-in disjunct, rounds 11/16), never a redeclaration of the
 * module-level one. `for_in_statement` is not itself a
 * `FUNCTION_SCOPE_NODE_TYPES` member, so the walk still recurses into its
 * `right` expression and `body` afterward exactly as before, finding any
 * further hoisted declaration nested inside the loop. This fix and
 * `subtreeContainsReassignmentOf`'s own round-17 fix close the same
 * construct via two independent mechanisms (a detected redeclaration here;
 * a detected write there) — see that function's own doc comment for the
 * write-scan half of this same gap, and why both are fixed rather than
 * relying on either one alone. Matches escape-fallback case (as) and
 * correlation shape 14.
 */
function countHoistedVarScopeDeclarations(node: TreeSitterNode, name: string, depth: number): number {
  if (depth >= MAX_WALK_DEPTH) return 2;
  let count = 0;
  if (node.type === 'variable_declaration' && declarationDeclaresName(node, name)) count++;
  if (node.type === 'function_declaration' && node.childForFieldName('name')?.text === name) {
    count++;
  }
  // ROUND 17 (#2088 finding 1) — a `var`-kind for-of/for-in loop HEAD binds
  // `name` at this SAME hoisted var scope; see this function's own doc
  // comment. Read unconditionally (never gated on `kind` being absent,
  // unlike `subtreeContainsReassignmentOf`'s and `findResolvingScopeNode`'s
  // own for-in checks, which each ask a DIFFERENT question) and routed
  // through `unwrapParens`/`patternBindsName`, exactly as every other
  // `for_in_statement.left` read in this file already is.
  if (node.type === 'for_in_statement') {
    const kind = node.childForFieldName('kind');
    const left = node.childForFieldName('left');
    if (kind?.text === 'var' && left && patternBindsName(unwrapParens(left), name)) count++;
  }
  // A function/method node's OWN name (just checked above, if applicable) is
  // examined, but its BODY opens its own, independent var/Annex-B scope —
  // stop here rather than recursing into it. Checked on THIS node, after
  // the self-checks above, never pre-filtered on a CHILD before visiting it
  // (see this function's own doc comment for why that distinction matters).
  // `for_in_statement` is not one of these function-scope-opening types, so
  // execution falls through to the recursive loop below even after the
  // round-17 check just above matches.
  if (FUNCTION_SCOPE_NODE_TYPES.has(node.type)) return count;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    count += countHoistedVarScopeDeclarations(child, name, depth + 1);
  }
  return count;
}

/**
 * ROUND 13 (#2088 finding 1) — used only by
 * `resolveIdentifierValueThisReference`, run on the resolved declaration's
 * name AFTER `findTopLevelFunctionNodeByName` returns a node but BEFORE the
 * arrow-function/`this`-body check ever trusts it. `findTopLevelFunctionNodeByName`
 * deliberately resolves a `function_declaration`, a `lexical_declaration`
 * (`let`), OR a `variable_declaration` (`var`) — every one of which is a
 * MUTABLE binding — so the node it returns is only the declaration's own
 * INITIAL value, never proof that no LATER statement rebinds the same name
 * to something else entirely. This function is that proof, or the lack of
 * it: it walks the WHOLE file — not just the resolved declaration's own
 * subtree, since a reassigning statement is typically a SIBLING top-level
 * statement, never nested inside the declaration it rebinds — for any of
 * three shapes that write to a bare `identifier` whose text is `name`:
 *
 *   - an `assignment_expression` or `augmented_assignment_expression` whose
 *     `left` field BINDS that identifier — checked via `patternBindsName`
 *     (ROUND 14, #2088 finding 1; a bare `left?.type === 'identifier' &&
 *     left.text === name` text match through round 13 — see the round-14
 *     essay below for what this closes, what it still cannot see, and why
 *     the "restrict to the simplest syntactic shape" precedent this bullet
 *     previously cited for the narrower test was never a valid justification
 *     for it);
 *   - an `update_expression` (`name++`/`--name`) whose `argument` field IS
 *     that identifier;
 *   - a `for_in_statement` whose `left` field BINDS that identifier (via
 *     `patternBindsName`, the same primitive `findResolvingScopeNode`'s own
 *     for-in disjunct already uses for this identical field) AND which
 *     carries NO `kind` field — i.e. `for (name of iter)`/`for (name in
 *     obj)`, reassigning a PRE-EXISTING binding, never `for (let name of
 *     iter)`/`for (const name of iter)`, which instead DECLARES a fresh,
 *     loop-scoped `name` that shadows the outer one and is already
 *     `findResolvingScopeNode`'s own concern, not this function's. Verified
 *     against `tree-sitter-javascript@0.25.0`'s own `grammar.json`: a
 *     `for`-loop's own leading `await` token (`for await (… of …)`) carries
 *     NO field name at all — it sits OUTSIDE the parenthesized head
 *     entirely — so it can never be mistaken for the separately
 *     `kind`-tagged `var`/`let`/`const`/`using` declaration keyword that
 *     lives INSIDE the head; a bare `for await (name of asyncIter)` therefore
 *     still carries no `kind` field and is still correctly caught by this
 *     same test, exactly like a plain, non-await `for (name of iter)` is.
 *
 * Finding ANY of the three fails safe unconditionally in the caller — this
 * function only reports THAT a write exists, never what it assigns, and
 * deliberately does not attempt to resolve the write's own right-hand side
 * (an arrow, a further identifier, …) and check IT for `this`-freedom: see
 * `resolveIdentifierValueThisReference`'s own doc comment for why (the same
 * "detect, then fail safe outright" choice round 10 already made for a
 * shadowing declaration) and #2631 for the recall this costs.
 *
 * Reuses `MAX_WALK_DEPTH` like every other recursive walk in this file, and
 * — like `subtreeContainsThisKeyword` just below, for the identical reason
 * — INVERTS `blockContainsIdentifierExcluding`'s own truncate-toward-`false`
 * default: "contains a reassignment" is what drives the caller's fail-safe
 * `true`, so truncating toward "not found" would let a pathologically deep
 * file read as safe by omission, the wrong side of this design's own
 * fail-safe/fail-open asymmetry.
 *
 * Deliberately does NOT touch, reuse as a shadow check, or otherwise
 * interact with `findResolvingScopeNode`, `introducesShadowedBinding`, or
 * `SCOPE_NODE_TYPES` — this function answers a different question (is the
 * binding ever OVERWRITTEN) than theirs (is the binding SHADOWED at this
 * lexical position), and the two are independent: a name can be shadowed
 * without ever being reassigned, or reassigned without ever being shadowed,
 * and this round's fix only needs the latter.
 *
 * > **ROUND 14 (#2088 finding 1) — the assignment-expression branch's
 * > pre-round-14 test answered a narrower question than the one this
 * > function exists to answer.** `assignment_expression.left` (verified
 * > against `tree-sitter-javascript@0.25.0`'s own `node-types.json`) admits
 * > `array_pattern`, `identifier`, `member_expression`, `object_pattern`,
 * > `parenthesized_expression`, and `subscript_expression` — a bare
 * > `left?.type === 'identifier' && left.text === name` text match sees only
 * > ONE of those six grammar-permitted shapes, so every destructuring write
 * > to `name` — `[name] = […]`, `({ name } = …)`, `({ x: name } = …)`,
 * > `[name = mk()] = […]`, `[...name] = […]`, and a nested
 * > `({ a: { name } } = …)` alike — slipped past this branch entirely.
 * > Concretely — this same function's own round-13 counter-example (above),
 * > with the identical write spelled as a destructuring target instead of a
 * > bare one:
 * >
 * > ```js
 * > function fnAlpha() { return 1; }
 * > let run = () => {};
 * > [run] = [function () { return this.alpha(); }];
 * > const T = { alpha: fnAlpha, run };
 * > T.run();
 * > ```
 * >
 * > `left` here is an `array_pattern`, never `identifier`, so the
 * > pre-round-14 test never matches regardless of what name the pattern
 * > binds — this function returns `false` (no reassignment found), the
 * > caller trusts the arrow's own genuinely `this`-free body, and `fnAlpha`
 * > is reported dead though `T.run()` invokes it via the REASSIGNED,
 * > `this`-using function on every call — Greptile flagged exactly this
 * > shape against this plan ("Destructuring writes bypass reassignment
 * > tracking"). Fixed by replacing the bare-identifier test with
 * > `patternBindsName(left, name)` — not a new primitive: it is the SAME one
 * > this function's OWN for-in branch above already calls for the identical
 * > question on a different field, the one `blockContainsIdentifierExcluding`'s
 * > own assignment-expression branch already uses for this EXACT field
 * > (`src/extractors/javascript.ts:5157-5160`), and the one `killsBinding`'s
 * > own doc comment (`javascript.ts:5286-5290`) already credits with
 * > covering "destructuring targets like `[name] = arr`" — even `killsBinding`'s
 * > own assignment-expression branch (`javascript.ts:5332-5334`) resolves the
 * > identical field the identical way. This function was the odd one out for
 * > using a narrower, ad hoc test instead of the house primitive for exactly
 * > this question, not a function that needed a new primitive invented for it.
 * >
 * > **This does not make the assignment branch as complete as the question
 * > it answers, only as complete as `patternBindsName` itself is.**
 * > `patternBindsName` has no case for a `parenthesized_expression` — the
 * > SIXTH shape `assignment_expression.left` permits — so `(name) = …` is
 * > still invisible to this branch after this fix, exactly as `for ((name)
 * > of iter)` remains invisible to this function's OWN for-in branch above
 * > and to `findResolvingScopeNode`'s for-in disjunct, both already tracked
 * > at #2630. This round extends #2630's scope to name this branch as a
 * > FOURTH affected consumer of the identical `patternBindsName` gap — the
 * > three already named there are `findResolvingScopeNode`'s for-in
 * > disjunct, `blockContainsIdentifierExcluding`'s for-in branch, and this
 * > function's OWN for-in branch — rather than opening a new issue for what
 * > is the same root cause reaching a fourth call site. **#2630 stays open**;
 * > this fix narrows what leaving it open costs without closing it.
 * >
 * > **Corrected precedent citation (#2088 finding 3(a)).** This bullet
 * > previously justified excluding a destructuring target by "mirroring this
 * > function's own narrow 'restrict to the simplest syntactic shape' scope"
 * > — the SAME `#1771`/`#1784` precedent `findTopLevelFunctionNodeByName`
 * > cites for its own, deliberately bounded module-level-only search. Round
 * > 9 already ruled that precedent out for exactly this kind of use, in
 * > `literalHasUnmodeledThisReference`'s own doc comment (above): it governs
 * > *edge emission* — a recall choice about which resolutions to attempt —
 * > never a *safety predicate* about which shapes are proven harmless. This
 * > function's write-scan IS a safety predicate (its whole contract is
 * > "detect every write, or fail safe"), so that citation was never a valid
 * > justification for a narrower scan here, independent of this round's own
 * > fix making the narrowness moot for every shape `patternBindsName` does
 * > recognise.
 * >
 * > **Implementation note (complexity, not a redesign).** As specified, this
 * > function walks the WHOLE file once per identifier-valued property per
 * > object-literal site condition 4 checks — O(sites × properties × file
 * > size) in the worst case, since `resolveIdentifierValueThisReference`
 * > calls it fresh for every identifier-valued `pair`/`shorthand_property_identifier`
 * > it resolves. The intended IMPLEMENTATION (not a change to this doc's
 * > other passes) is a single per-file pre-pass, run once before condition 4
 * > ever runs, that collects every name written anywhere in the file — via
 * > the same three shapes enumerated above — into one `Set<string>`, turning
 * > each call site's own check into an O(1) `Set.has(name)` lookup against
 * > that pre-built set rather than a fresh whole-file walk per property.
 * >
 * > **ROUND 16 (#2088, #2630) — the assignment and for-in branches' own
 * > `left` field reads both admit a shape `patternBindsName` cannot see: a
 * > `parenthesized_expression`.** `assignment_expression.left` and
 * > `for_in_statement.left` (both verified against
 * > `tree-sitter-javascript@0.25.0`'s `node-types.json`) each permit
 * > `parenthesized_expression` alongside the shapes round 14 already routes
 * > through `patternBindsName` — `(run) = fn` and `for ((run) of iter)` are
 * > both grammar-valid, and `patternBindsName`'s `default: return false`
 * > (`javascript.ts:4906-4907`) never sees inside the parens. Concretely,
 * > verified runnable under real Node: `function fnAlpha() { return 1; } let
 * > run = () => {}; (run) = function () { return this.alpha(); }; const T =
 * > { alpha: fnAlpha, run }; T.run();` — the parenthesized reassignment is
 * > invisible to this branch, `subtreeContainsReassignmentOf` returns
 * > `false`, the caller trusts the arrow's own genuinely `this`-free body,
 * > and `fnAlpha` is reported dead though `T.run()` invokes it via the
 * > REASSIGNED function on every call — the identical failure class round
 * > 13 closed for a bare identifier and round 14 for a destructuring target,
 * > reopened here by one layer of parens; a `for ((run) of [thisUsingFn])`
 * > write-scan miss follows the same shape, one field over. This is also a
 * > regression against today, for the same reason rounds 13-15's own gaps
 * > were: `collectInvokedPropertyNames` credits any non-empty receiver
 * > regardless of which value currently occupies the binding. Fixed by
 * > unwrapping `left` through a new local `unwrapParens` helper (below,
 * > shared with `findResolvingScopeNode`'s own round-16 fix) before ever
 * > calling `patternBindsName` on it — NOT by adding a
 * > `parenthesized_expression` case to `patternBindsName` itself; see
 * > `unwrapParens`'s own doc comment for why. This narrows #2630's remaining
 * > scope to its one, conservative-direction consumer,
 * > `blockContainsIdentifierExcluding`'s own for-in branch (condition 3,
 * > untouched by this round) — see `findResolvingScopeNode`'s own round-16
 * > essay for the full four-consumer accounting.
 * >
 * > **ROUND 16 (#2088, #2634) — none of the three shapes above sees a write
 * > that reaches the SAME script-scope `var` binding through the global
 * > object instead of through the bare identifier.** A top-level `var name`
 * > in a non-module (classic script) file is also exposed as
 * > `globalThis.name` (and, in the appropriate host, `global.name`/
 * > `self.name`/`window.name` — all four resolve to the same object in a
 * > non-strict, non-module script); `let`/`const` are never exposed this
 * > way. `globalThis.name = function () { return this.alpha(); };` reassigns
 * > that SAME binding without ever writing to a bare `identifier` at all —
 * > `left` here is a `member_expression`, a shape neither `patternBindsName`
 * > nor this function's own assignment branch (pre-round-16) inspects.
 * > Concretely: `function fnAlpha() { return 1; } var run = () => {};
 * > globalThis.run = function () { return this.alpha(); }; const T = {
 * > alpha: fnAlpha, run }; T.run();` — the global-qualified write is
 * > invisible pre-round-16, `subtreeContainsReassignmentOf` returns `false`,
 * > and `fnAlpha` is reported dead though `T.run()` invokes it via the
 * > REASSIGNED function every call — filed as #2634, and, unlike #2625/#2631/
 * > round 14 finding 2's own filed exclusions, this was never a capability
 * > this design chose not to build: it is a decidable, enumerable AST shape
 * > this scan simply never looked at, the identical fail-open class rounds
 * > 13-15 each closed elsewhere in this same chain — #2634's own issue body
 * > and this plan's Risks table previously (wrongly) grouped it alongside
 * > those accepted recall trade-offs; both are corrected as of this round
 * > (see the Risks table). Fixed by a new `isGlobalObjectQualifiedWrite`
 * > check (below), ORed onto the existing assignment/augmented-assignment
 * > branch. **Deliberately does not gate on the resolved declaration having
 * > actually come from a `variable_declaration`** — the only shape for which
 * > a `globalThis`-qualified write is EVER a reassignment of the SAME
 * > binding at all, since a `let`/`const`/`function` declaration is never
 * > exposed this way — because that would require threading the CALLER's
 * > own resolved-declaration kind into this whole-file, name-keyed scan,
 * > which carries no such context today. The consequence is strictly
 * > one-directional and already-accepted: this check may (harmlessly) treat
 * > an UNRELATED `globalThis.name = …` write as a reassignment when `name`
 * > actually resolves to a `let`/`const`/`function` declaration no such
 * > write could ever affect, pushing that resolution to fail safe when a
 * > fuller, declaration-kind-aware check would not have — costing recall
 * > only, never soundness, the same direction #2635's own un-gated
 * > strict/sloppy-mode Annex-B over-count already accepts for an analogous
 * > reason. No new issue: this is a simplicity choice within #2634's own
 * > already-filed scope, not a new narrowing of anything the design claims.
 * >
 * > **ROUND 17 (#2088 finding 1) — the for-in branch's own
 * > `!node.childForFieldName('kind')` gate answers a narrower question than
 * > the one this function exists to answer.** That gate was written (round
 * > 13) to admit only a DECLARATION-LESS for-in/for-of head — `for (name of
 * > iter)`, reassigning a PRE-EXISTING binding — while excluding a
 * > `let`/`const`/`using` head, each of which DECLARES a fresh, loop-scoped
 * > `name` rather than reassigning the outer one. That exclusion is correct
 * > for `let`/`const`/`using`, but wrong for `var`: `var` is
 * > function-scoped, not block-scoped, so `for (var name of iter)` does not
 * > declare a new binding at all — it REBINDS the same
 * > module/function-scoped `name` the resolved declaration itself is, once
 * > per iteration, exactly as much a write to it as a bare `name = …`
 * > assignment is. Concretely — the identical counter-example
 * > `countHoistedVarScopeDeclarations`'s own round-17 essay gives, verified
 * > the same way: `function fnAlpha() { return 1; } var run = () => {}; for
 * > (var run of [function () { return this.alpha(); }]) { } const T = {
 * > alpha: fnAlpha, run }; T.run();` — pre-round-17, this branch's
 * > `!node.childForFieldName('kind')` test is FALSE (a `kind` field, `var`,
 * > IS present), so the whole condition is false, and this write is
 * > invisible to the scan regardless of whether
 * > `findTopLevelFunctionNodeByName`'s own count (see its sibling fix) also
 * > catches it. Fixed by widening the gate from "no `kind` field" to "no
 * > `kind` field OR `kind`'s text is `var`" — `let`/`const`/`using` keep
 * > failing this test exactly as before, since each creates a genuinely NEW
 * > binding this function must not treat as a write to the OUTER one (that
 * > remains `findResolvingScopeNode`'s own concern, rounds 11/16/17 —
 * > untouched by this fix, which only widens what counts as a WRITE, never
 * > what counts as a SHADOW). Both this fix and
 * > `countHoistedVarScopeDeclarations`'s own round-17 fix are applied
 * > together, independently closing the same construct via two different
 * > mechanisms — see that function's own doc comment for why relying on
 * > either function alone was not enough. Matches escape-fallback case (as)
 * > and correlation shape 14.
 * >
 * > **ROUND 17 (Greptile, PR #2612) — the `update_expression` branch's own
 * > `arg?.type === 'identifier'` test reads `argument` directly, never
 * > through `unwrapParens`, unlike the assignment and for-in branches
 * > beside it.** A parenthesized update target — `(name)++`/`(name)--` — is
 * > grammar-valid (verified runnable: `let run = () => {}; (run)++;` parses
 * > and executes) and, pre-this-fix, invisible to this branch for the exact
 * > same structural reason round 16's #2630 named for the assignment and
 * > for-in branches. Fixed by routing `argument` through `unwrapParens`
 * > before the identifier comparison, exactly mirroring the other two
 * > branches — closing the asymmetry rather than leaving this branch the
 * > one exception to a pattern this file otherwise applies uniformly.
 * > **Unlike every other finding in this chain, this one is NOT an
 * > UNDER-escape gap, verified empirically rather than assumed:** an
 * > `update_expression` performs ECMAScript's own `ToNumeric` coercion on
 * > its operand before writing back, so `(name)++`/`(name)--` can NEVER
 * > reassign `name` to an arbitrary new function value the way an
 * > assignment or a for-in rebind can — confirmed directly (`let run = ()
 * > => {}; (run)++; typeof run` is `"number"`, value `NaN`, never a
 * > callable this-using function). The pre-fix gap therefore had NO
 * > exploitable soundness consequence: there is no construction through
 * > this branch alone where a genuinely `this`-using handler was ever
 * > wrongly read as `this`-free because of it, unlike U1's `switch_body`/
 * > `for_statement` gaps or finding 1's `var`-for-in gap, each of which has
 * > a verified-runnable live-reported-dead repro. This fix is therefore
 * > applied for STRUCTURAL CONSISTENCY with its sibling branches and to
 * > close the finding Greptile raised, not because a soundness repro
 * > exists — and none is fabricated to manufacture one where empirical
 * > verification shows none can exist. Guarded by correlation shape 18: a
 * > parenthesized update to a DIFFERENT name elsewhere in the file must
 * > not perturb the table's own correlation.
 */
const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set(['globalThis', 'global', 'self', 'window']);

/**
 * ROUND 16 (#2088, #2634) — true when `node` (an assignment/augmented-
 * assignment `left`) is `<globalObject>.name` for one of the four aliases
 * above, parsed as an ordinary `member_expression` (`object`: an
 * `identifier`; `property`: a `property_identifier` — verified against
 * `tree-sitter-javascript@0.25.0`'s own `node-types.json`). See
 * `subtreeContainsReassignmentOf`'s own doc comment for the counter-example
 * this closes and for why this check is deliberately not gated on the
 * resolved declaration's own kind.
 *
 * **ROUND 17 (#2088 finding 2) — the member-expression check above
 * recognises only the DOT spelling, `globalThis.name`, and returns `false`
 * for anything that is not itself a `member_expression` — including the
 * IDENTICAL write spelled with brackets, `globalThis['name'] = …`, a
 * `subscript_expression`, not a `member_expression`, at the JS grammar
 * level.** Concretely, verified runnable via `vm.runInThisContext` (the
 * same classic-script premise #2634 itself relies on): `function fnAlpha()
 * { return 1; } var run = () => {}; globalThis['run'] = function () {
 * return this.alpha(); }; const T = { alpha: fnAlpha, run }; T.run();` —
 * pre-round-17, `node.type !== 'member_expression'` is true for this
 * subscript write, so this function returns `false` unconditionally, the
 * write is invisible to `subtreeContainsReassignmentOf`, and `fnAlpha` is
 * reported dead though `T.run()` invokes the reassigned function every call
 * — the identical failure mode #2634 itself closed for the dot spelling,
 * reopened here by one spelling variant. Fixed by ALSO accepting a
 * `subscript_expression` whose `object` is an `identifier` in
 * `GLOBAL_OBJECT_NAMES` and whose `index` is a STATIC string/template key
 * matching `name` — reusing `isTrackedReferencePosition`'s own
 * subscript-key normalisation VERBATIM (quote/backtick-strip, then require
 * non-empty and `$`-free — the identical ONE check round 8 already applies
 * uniformly to both index kinds, not a new notion of "static" invented for
 * this function) rather than re-deriving a parallel one. A DYNAMIC key
 * (`globalThis[k] = …`) is still not accepted — the write has no
 * statically-known property name to compare against `name` at all, the
 * same reasoning `isTrackedReferencePosition`'s own dynamic-key exclusion
 * already gives (#2619). Matches escape-fallback case (at) and correlation
 * shape 15.
 *
 * > **ROUND 18 (#2088) — both arms require `object.type === 'identifier'`,
 * > so a SINGLE paren layer around just the global-object identifier
 * > defeats the whole check.** Concretely, verified against the real
 * > parser (`tree-sitter-javascript@0.25.0`): `(globalThis).run = …` parses
 * > as an `assignment_expression` whose `left` is an ordinary
 * > `member_expression` `(globalThis).run` — same as the unparenthesized
 * > spelling — but that `member_expression`'s own `object` FIELD is a
 * > `parenthesized_expression` wrapping `globalThis`, not an `identifier`
 * > directly. Pre-round-18, `object.type === 'identifier'` is false, both
 * > arms return `false` unconditionally, and the write is invisible to
 * > `subtreeContainsReassignmentOf`. Verified runnable via
 * > `vm.runInThisContext` (the same classic-script premise round 16's own
 * > #2634 fix relies on): `function fnAlpha() { return 1; } var run = ()
 * > => {}; (globalThis).run = function () { return this.alpha(); }; const
 * > T = { alpha: fnAlpha, run }; T.run();` evaluates to `1` — the identical
 * > failure mode #2634 and round 17's own bracket-subscript fix each closed
 * > for their own spelling, reopened here by one paren layer. Fixed the
 * > identical way round 16 already fixed `findResolvingScopeNode`'s for-in
 * > disjunct and `subtreeContainsReassignmentOf`'s own write-scan branches
 * > for the SAME class of gap: routing `object` through the existing, local
 * > `unwrapParens` before the identifier-type/name checks, in BOTH arms —
 * > not by widening `patternBindsName` or any shared primitive, since
 * > neither is involved here at all. Also routed at this function's own
 * > call site in `subtreeContainsReassignmentOf` (`unwrapParens(left)`
 * > rather than bare `left`), matching the `patternBindsName` call
 * > immediately above it — closing the residual "whole assignment target
 * > parenthesized" shape (`((globalThis).run) = …`) that unwrapping only
 * > `object` inside this function would not reach, since that call would
 * > otherwise still receive a `parenthesized_expression` as `node`, matching
 * > neither of this function's two arms at all. Matches escape-fallback
 * > case (az) and correlation shape 21.
 */
function isGlobalObjectQualifiedWrite(node: TreeSitterNode, name: string): boolean {
  if (node.type === 'member_expression') {
    // ROUND 18 (#2088) — `object` routed through `unwrapParens`; see this
    // function's own doc comment above for why a paren layer around just
    // the global-object identifier (`(globalThis).name = …`) previously
    // defeated the `object.type === 'identifier'` check outright.
    const object = node.childForFieldName('object');
    const property = node.childForFieldName('property');
    return (
      !!object &&
      unwrapParens(object).type === 'identifier' &&
      GLOBAL_OBJECT_NAMES.has(unwrapParens(object).text) &&
      !!property &&
      property.text === name
    );
  }
  // ROUND 17 (#2088 finding 2) — the bracket-subscript spelling of the
  // identical write; see this function's own doc comment above.
  if (node.type === 'subscript_expression') {
    // ROUND 18 (#2088) — `object` routed through `unwrapParens` here too,
    // for the identical reason as the `member_expression` arm above:
    // `(globalThis)['name'] = …` is the bracket-spelling counterpart of the
    // same paren-layer gap.
    const object = node.childForFieldName('object');
    if (!object || unwrapParens(object).type !== 'identifier') return false;
    if (!GLOBAL_OBJECT_NAMES.has(unwrapParens(object).text)) return false;
    // ROUND 20 (#2088, G1 — Greptile, PR #2612) — `index` routed through
    // `unwrapParens` too: `globalThis[('name')] = …` parenthesizes the
    // INDEX rather than the object, and pre-round-20 `index?.type` reads
    // `parenthesized_expression` for that shape, never `string`, so the
    // write was invisible for the identical structural reason a paren layer
    // around `object` defeated this function before round 18's own fix.
    // Verified runnable via `vm.runInThisContext` (the same classic-script
    // premise every fixture on this function already relies on):
    // `function fnA(){return 1;} var run=()=>{}; globalThis[('run')] =
    // function(){return this.alpha();}; const T={alpha:fnA,run}; T.run();`
    // evaluates to `1` — the identical failure mode round 16/17/18 each
    // closed for their own spelling, reopened here by a paren layer around
    // the index specifically. Fixed the same way as every other paren-layer
    // gap on this function: unwrap before the type check, not after.
    const rawIndex = node.childForFieldName('index');
    const index = rawIndex ? unwrapParens(rawIndex) : undefined;
    const indexType = index?.type;
    if (indexType !== 'string' && indexType !== 'template_string') return false;
    // Mirrors `isTrackedReferencePosition`'s own round-8 static-key
    // normalisation verbatim — strip quote/backtick characters, then
    // require the result to be non-empty and `$`-free, with no special case
    // for either kind of quoting.
    const propertyName = index!.text.replace(/['"`]/g, '');
    return !!propertyName && !propertyName.includes('$') && propertyName === name;
  }
  return false;
}

function subtreeContainsReassignmentOf(node: TreeSitterNode, name: string, depth: number): boolean {
  if (depth >= MAX_WALK_DEPTH) return true;
  if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
    const left = node.childForFieldName('left');
    if (left && patternBindsName(unwrapParens(left), name)) return true;
    // ROUND 16 (#2088, #2634) — a script-scope `var` is also exposed as a
    // property of the global object; see this function's own doc comment.
    // ROUND 18: `left` is unwrapped here too, matching the
    // `patternBindsName` call immediately above and closing the residual
    // "whole target parenthesized" shape (`((globalThis).name) = …`) that
    // routing the unwrap only inside `isGlobalObjectQualifiedWrite` itself
    // would not reach, since that call would otherwise still receive a
    // `parenthesized_expression`, never the `member_expression`/
    // `subscript_expression` its own two arms match on.
    if (left && isGlobalObjectQualifiedWrite(unwrapParens(left), name)) return true;
  } else if (node.type === 'update_expression') {
    // ROUND 17 (Greptile, PR #2612) — see this function's own doc comment
    // for why this branch is fixed for consistency with its two siblings
    // even though, unlike them, no construction through THIS branch alone
    // can actually reassign `name` to a new function value.
    const arg = node.childForFieldName('argument');
    const target = arg ? unwrapParens(arg) : undefined;
    if (target?.type === 'identifier' && target.text === name) return true;
  } else if (node.type === 'for_in_statement') {
    const left = node.childForFieldName('left');
    const kind = node.childForFieldName('kind');
    // ROUND 17 (#2088 finding 1) — `var` is function-scoped, so a
    // `var`-kind head REASSIGNS the same binding a declaration-less head
    // does; only `let`/`const`/`using` create a genuinely new, loop-scoped
    // binding — see this function's own doc comment.
    if (left && patternBindsName(unwrapParens(left), name) && (!kind || kind.text === 'var')) {
      return true;
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && subtreeContainsReassignmentOf(child, name, depth + 1)) return true;
  }
  return false;
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
 *
 * ROUND 19 (#2088, non-blocking) — restates, for THIS function specifically,
 * the same Category F acceptance the Risks table's "Scope growth during
 * implementation" row already states for `subtreeContainsReassignmentOf`:
 * a method body that reaches `this` only through `eval('this.alpha()')` is
 * invisible to this search, since the text `this` never appears as a `this`
 * -typed AST node at all — it is a substring of a STRING literal, the
 * identical `eval`-is-opaque-to-static-analysis limitation the Risks table
 * already accepts for the reassignment scan, now disclosed against THIS
 * function too rather than only its sibling. No static analysis can see
 * through a runtime `eval` call regardless of which of this file's walks is
 * asked to; Category F, not a new gap this round introduces or fixes.
 *
 * ROUND 20 (#2088, UE-D, non-blocking) — an OPTION exists to make the
 * non-vacuous-coverage claim (round 8's standing rule) hold literally rather
 * than only modulo `eval`: the extractor already emits a distinguishable
 * `<dynamic:eval>`/`new Function` call shape (ADR-002), so a per-file
 * fail-safe — if the file contains ANY such call at all, treat every
 * escape-analysis walk over it as unproven — is buildable from data this
 * design already collects, no new AST walk required. Not built this round:
 * it is new design scope (a file-wide pre-check threaded into every WU-2b
 * entry point, in both engines), broader than a fix to an existing
 * predicate, and costs recall FILE-WIDE (any table in a file that uses
 * `eval` anywhere, for any reason, loses T1 correlation entirely) for a
 * limitation Category F already accepts as unattemptable regardless. Filed
 * as an explicit follow-up capability rather than silently left unmentioned
 * — #2642.
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
> - `bindingName` is **always the bare declarator identifier** that `allReferencesTracked` walks the binding's declaring scope for, and **never** carries a `[*]` or `::return` suffix (round-7, finding 5) — **nor, round 8 (finding 2), a `#${scopeLine}` disambiguating suffix either**: it is always `nameNode.text` read directly off the `variable_declarator`'s `name` field, never the string `findEnclosingTableName` itself would return for that same declarator. `findEnclosingTableName` (`src/extractors/javascript.ts:4513-4528`) appends exactly that suffix — `` `${nameNode.text}#${scopeLine}` `` — for any declaration scoped inside a block, via `findDeclaringScopeLine`; `resolveSiteOwner` must stop at `nameNode.text` and never call through to that suffix-appending return construction, precisely because `bindingName` is consumed as an AST SEARCH TARGET (`allReferencesTracked` looks for `identifier` AND `shorthand_property_identifier` nodes — ROUND 19, #2088 finding 3, corrects this parenthetical's own pre-round-19 wording, which named only `identifier`; see `allReferencesTracked`'s own doc comment for why the omission is load-bearing, not editorial — whose `.text` equals it), not as a human-readable disambiguating label the way `findEnclosingTableName`'s result is. Concretely: `"T"` for a direct binding regardless of what scope it's declared in, `"A"` (never `"A[*]"`) for an array element, or `null` for a return-owner (there is no binding at all to scan — condition 1 already makes every return-owner escape unconditionally, before condition 3 ever runs `allReferencesTracked`). This is unrelated to, and must never be confused with, `Call.receiver` (set by the pre-existing, UNCHANGED `collectObjectLiteralValueRefCall` as `findEnclosingTableName(pairNode)` — see WU-2's implementation above): `receiver` is #2260's own T3 (`computedDispatchTableEvidence`) matching key and is EXPECTED to keep its `#line` suffix, since T3 disambiguates by exactly that string; `bindingName` is WU-2b's own escape-analysis input and must NOT carry it. Two different fields, two different consumers, two different rules — round 8 exists because an earlier draft let them blur.
> - The two fields are EQUAL (`key === bindingName`) for exactly one owner kind — direct binding — and differ for exactly one other — array element (`"A[*]" !== "A"`). This is what `isArrayOwner = owner.key !== owner.bindingName` (condition 3, above) relies on, and it is why `bindingName` cannot be left to be "whatever seems natural": were it ever `"A[*]"` instead of `"A"`, or ever `"T#7"` instead of `"T"`, `allReferencesTracked` would search the AST for an identifier literally spelled `A[*]` or `T#7` — text that can never appear as identifier syntax — find zero surviving references for every affected site, and read that vacuous walk as non-escaping. Round 8 (see the withdrawal of round 7's vacuous-truth conclusion, above) is precisely why this can no longer be waved away as "vacuous truth is always fine": a search that structurally can never match anything is not an exhaustive, PROVEN-COVERED search — it is a broken one, and must be treated as unproven, not as a trivial pass. This would silently bypass condition 2's export check for every affected site, exported or not, and (for the `A[*]` case specifically) would also make `isArrayOwner` permanently `false`, silently bypassing round 7 finding 1's fix at the same time. Both failure modes are why WU-10 adds a dedicated `export const A = [{…}]` regression case (below) rather than trusting this contract to prose alone.

> **ROUND 8 (#2088 finding 1) — `allReferencesTracked`'s search boundary.** New helper `findDeclaringScopeNode(node: TreeSitterNode, name: string): TreeSitterNode | undefined` — the node-returning counterpart of the existing `findDeclaringScopeLine` (`src/extractors/javascript.ts:4484-4491`), which now becomes a thin wrapper over it (`return findDeclaringScopeNode(node, name)?.startPosition.row;`) so the two functions can never silently disagree about what "the declaring scope" is for the same node. `allReferencesTracked(root, bindingName, objectNode, isArrayOwner, declaringScope?)` gains an optional trailing parameter: on the TOP-level call (from `computeObjectLiteralSiteEscapes`, which never passes it), the function computes it once, `findDeclaringScopeNode(objectNode, bindingName) ?? root` — `root` covers module scope, since `introducesShadowedBinding` has no case for `program` and always returns `false` for it (confirmed at `javascript.ts:4813-4814`), exactly the property that let every module-scope WU-10 fixture pass by accident before this fix existed. On every RECURSIVE call (rebinding alias, for-of loop variable — below), this SAME node is threaded through unchanged as the explicit argument, never recomputed from the alias/loop-variable's own position: that position is not necessarily an ancestor of `objectNode`, so re-deriving the boundary from it would walk the wrong ancestor chain. This is always safe, never merely convenient: any binding reachable ONLY through a reference to the original site (an alias, a loop variable) must itself be declared somewhere lexically inside the original site's own declaring-scope subtree, or it could never have seen `bindingName` in scope to reference it in the first place — so the fixed boundary is never too narrow for a recursive check, only ever exactly as wide as it needs to be.

`allReferencesTracked` walks the DESCENDANTS of that one declaring scope (never the whole file, and never a scope wider than the site could actually be referenced from) for `identifier` **AND** `shorthand_property_identifier` nodes (ROUND 19, #2088 finding 3 — see this function's own doc comment, below, for why a text-match filter that names only `identifier` is not merely imprecise prose but a load-bearing under-count) whose text equals the name currently being checked, skipping the declaration itself and any node under a NESTED scope that shadows the name — reusing `introducesShadowedBinding`, the hardened shadow detection already written for #2257 and already used by `findDeclaringScopeLine` — with exactly ONE exemption: the shadow-check is never applied to the fixed `declaringScope` node itself, at any recursion level, for any name. That exemption is not optional polish; it is the fix. `introducesShadowedBinding`'s own `statement_block` case returns `true` for a block that DIRECTLY declares the checked name (`src/extractors/javascript.ts:4744-4771`) — correct signal for a nested scope encountered deeper in the walk, but always true, vacuously, of the declaring scope itself, which is exactly why applying the check there uniformly self-shadows. `hasLaterReferenceInEnclosingBlock` (`src/extractors/javascript.ts:5393-5435`) already documents this identical trap for its own, narrower (single-block, first-match) search and already works around it by scanning the block's CHILDREN rather than the block itself (`javascript.ts:5411-5415`'s own comment: "running the shadow check... on the block itself would always find that declaration and wrongly treat the whole block as shadowed"); this fix generalises the SAME carve-out from "one block's direct children, stop at the first match" to "one scope's full recursive descendant subtree, collect every match." `allReferencesTracked`'s signature is `allReferencesTracked(root, bindingName, objectNode, isArrayOwner, declaringScope?): boolean`, where `isArrayOwner` is threaded straight into every `isTrackedReferencePosition(refNode, isArrayOwner)` call for this walk's references — see condition 3 above for where the initial value comes from and how it changes across the two recursive branches below.

> **ROUND 19 (#2088 finding 3) — a shorthand-property REFERENCE (as opposed
> to a shorthand-property DECLARATION site, round 9's own concern inside
> `literalHasUnmodeledThisReference`) is invisible to this walk when the
> filter is read literally as "`identifier` nodes whose text equals the
> name."** `{ T }` — passing an existing binding `T` into some OTHER object
> literal by shorthand — parses its own property to a
> `shorthand_property_identifier` node, a distinct tree-sitter node kind
> from `identifier` (this file already relies on that same distinction
> elsewhere: `literalHasUnmodeledThisReference`'s own child loop, and
> `collectObjectPropBindings`, `src/extractors/javascript.ts:4437`, each
> branch on it separately for exactly this reason). A walk that matches only
> `node.type === 'identifier' && node.text === name` therefore never visits
> this node at all — not "visits it and rejects it," but never reaches it in
> the first place — so a genuine escaping reference silently vanishes from
> the surviving set rather than failing `isTrackedReferencePosition` the way
> it should. Concretely, verified runnable under Node:
>
> ```js
> // sink.js: export function sink(x) { return x.T.alpha(); }
> import { sink } from './sink.js';
> function fnA() { return 1; }
> const T = { alpha: fnA };
> sink({ T });   // shorthand: passes T itself, keyed by its own name
> ```
>
> `T`'s only reference besides its own declaration is the shorthand `T`
> inside `sink({ T })` — a genuine escape (`T` is forwarded into an imported
> function, exactly the shape escape-fallback case (b) already requires to
> escape for a PLAIN identifier argument). An `identifier`-only filter finds
> no reference to classify at all, the walk believes itself (vacuously)
> exhaustive over an empty surviving set, and — per the non-vacuous-coverage
> requirement immediately below — a genuinely empty, PROVEN-exhaustive set
> reads as covered, so `allReferencesTracked` returns `true` (non-escaping).
> Executed both ways to confirm this is the filter's own node-type
> restriction and nothing else: with the stated `identifier`-only filter,
> `escapes` reads `false`; adding `shorthand_property_identifier` to the same
> filter (with no other change) flips it to `true`. Runtime confirms the
> control: `fnA` is genuinely invoked through `sink({ T }) → x.T.alpha()`.
>
> **Fixed by widening the walk's own node-type filter to match text on
> EITHER `identifier` OR `shorthand_property_identifier`, not by touching
> `isTrackedReferencePosition`, `introducesShadowedBinding`, or
> `SCOPE_NODE_TYPES`.** This is a pure RECALL-of-references fix — it only
> changes which AST nodes are ever considered candidate references in the
> first place, never how a found candidate is classified once matched — so
> it cannot by itself turn a genuinely tracked reference into an escaping
> one; it can only stop a genuinely escaping one from being silently missed.
> A `property_identifier` (an ORDINARY, non-shorthand object-literal KEY,
> e.g. the `T` in `{ T: 5 }`) is deliberately NOT added to this filter: a
> `pair`'s own key is never itself a value-producing reference to any
> binding — it is a label — so matching it here would spuriously count an
> unrelated object literal's own key as a "reference" to the tracked
> binding merely because the two happen to share spelling, an over-escape
> this design has no reason to accept. See correlation shape 24 for the
> fixture proving this distinction holds. This closes the two places this
> plan states the filter in prose (this paragraph, and `resolveSiteOwner`'s
> own return-contract essay above) — both now name both node kinds
> explicitly, rather than one of the two continuing to say "identifier
> nodes" as informal shorthand for a check that was never only about
> `identifier` nodes to begin with. Matches escape-fallback case (bc) and
> correlation shape 24.
>
> **The non-vacuous-coverage requirement (ROUND 8, #2088 finding 1 — the structurally important half).** `allReferencesTracked` returns `true` only when BOTH: (1) the walk is PROVEN exhaustive over the declaring scope's subtree — it did not truncate at `MAX_WALK_DEPTH` anywhere within it; AND (2) every reference the (proven-exhaustive) walk found satisfies `isTrackedReferencePosition`, or is accepted on a recursive branch that ALSO satisfies this same two-part contract. Either an unproven walk OR a disqualifying reference makes the result `false` (escaping) — there is no third, "we're not sure, but let's call it safe" outcome. This is a STANDING RULE about the function's return contract, not a special case bolted onto the vacuous-empty-set scenario specifically: it applies identically whether the surviving set is empty, has one reference, or has a hundred. Getting this wrong toward "unproven ⇒ escapes" costs recall — the same asymmetry every other fail-safe default in this design accepts; getting it wrong the other way is precisely the class of bug this rule exists to catch structurally, in every FUTURE change to this walk, not only in the one instance found this round.

> **The rebinding branch recurses — accepting the `const u = T` reference is not enough on its own** (round-4 critic finding). `allReferencesTracked` must additionally hold, recursively, for the new alias name, with `isArrayOwner` UNCHANGED and `declaringScope` UNCHANGED (`allReferencesTracked(root, aliasName, objectNode, isArrayOwner, declaringScope)`) — an alias of the CONTAINER is still the container, not a single element, so it must keep whatever `isArrayOwner` value the site already has, and (round 8) the search boundary established for the original binding, since `u`'s own declaration is necessarily somewhere inside that same subtree (see the `findDeclaringScopeNode` note above) — or a site reads as local-closed while it can still escape through `u` — e.g. `const u = T; importedFn(u)`. The `name` field of the `variable_declarator` must itself be a plain `identifier`; a destructuring `name` such as `const { k } = T` is rejected the same way `findEnclosingTableName` already does, since destructuring extracts a property rather than aliasing the reference. The first cut of this branch (round-3) checked only the reference to `T` and never followed where `u` goes; that is exactly the same shape of gap condition 1 already documents for a return-captured binding, one alias hop later. The recursion depth is capped at 6, reusing `findEnclosingTableName`'s own `hops` bound rather than inventing a new one — a chain of `const a = T; const b = a; const c = b; …` cannot cycle (each step names a fresh `const` binding), so the cap is defense-in-depth, not a correctness requirement. A recursive call returning `false` — including by hitting the cap, and, as of round 8, by failing its own non-vacuous-coverage requirement — makes that reference, and so the whole site, escaping; it is not a partial result the other branches paper over. Coverage composes the same way: the OUTER call is proven-covered only if every recursive call it makes is also proven-covered.
>
> **ROUND 18 (#2088, Greptile) — reusing the OUTER call's `declaringScope` unchanged for the recursive alias check is unsound when the alias itself is `var`-declared, not merely convenient.** The argument that justifies reuse (above: "`u`'s own declaration is necessarily somewhere inside that same subtree... so the fixed boundary is never too narrow") proves only that the ALIAS's DECLARATION sits inside `declaringScope`'s subtree — it says nothing about where the alias can be REFERENCED from. For a `let`/`const` alias (every case this branch was verified against through round 17) those coincide: a block-scoped binding's own visibility never extends past its nearest enclosing block, which is itself inside `declaringScope`'s subtree by construction. They do NOT coincide for a `var` alias: `var` is function-scoped, so `var u = T` declared inside a NESTED block (an `if`/`for`/`try`/bare block within `declaringScope`, itself possibly narrower than a whole function) makes `u` visible, and referenceable, throughout the ENCLOSING FUNCTION — anywhere outside that nested block but still inside the function, a region the recursive call's reused, narrower `declaringScope` does not cover at all. Concretely:
> >
> > ```js
> > function fnA() { return 1; }
> > function sink(x) { return x.alpha(); }
> > function install() {
> >   if (true) {
> >     const T = { alpha: fnA };   // T's declaringScope is the if-block
> >     var u = T;                 // var — visible throughout install(), not just the if-block
> >   }
> >   sink(u);                     // OUTSIDE the if-block, still inside install() — genuinely reachable
> > }
> > install();
> > ```
> >
> > `T`'s declaringScope (round 8) is the `if` statement's own block. The recursive call for alias `u` reuses that SAME block as its search boundary — but `sink(u)`, `u`'s only other reference, sits textually AFTER the block closes, never a descendant of it. The recursive walk finds zero references to `u` within its (too-narrow) boundary, and — believing itself exhaustive over the scope it was told to search — returns `true`. The site reads local-closed; `sink(u)` → `x.alpha()` produces zero correlated evidence; `fnA` would be reported dead though `sink(u)` invokes it on every call. This is the identical "the walk is exhaustive over the WRONG boundary, and doesn't know it" shape round 8's own headline bug and the `method_definition` carve-out (above) both are — a third instance, on a third axis (a boundary reused across a scope-widening `var`, rather than a self-shadow or a spurious shadow).
> >
> > **Fixed by widening the recursive call's OWN `declaringScope`, not by touching the OUTER call's.** When the alias's own declarator is `var`-kind (checked the same way `subtreeContainsReassignmentOf`'s for-in branch and `countHoistedVarScopeDeclarations` already distinguish `var` from `let`/`const`/`using`: the enclosing `variable_declaration` node, never `lexical_declaration`), the recursive call computes a NEW boundary — the `body` field of the nearest enclosing member of `FUNCTION_SCOPE_NODE_TYPES` (ROUND 20 correction, below — through round 19 this was the function-shape node ITSELF, not its `body`; the same, pre-existing, real constant `functionScopeDeclaresVar` already walks by is reused here rather than duplicated, only to locate that enclosing node) starting from the alias's OWN declaration position, or `root` if none exists — and passes THAT as `declaringScope` for the recursive call, instead of reusing the outer call's. A `let`/`const` alias is unaffected: it keeps reusing the outer call's own `declaringScope` exactly as every round through 17 already established, since that reasoning is sound for a block-scoped binding. **This paragraph's own pre-round-19 text additionally parenthesised "(or a for-of loop variable, always block-scoped)" onto that same sentence — ROUND 19 (#2088 finding 2) finds that parenthetical false, not merely imprecise: a `var`-kind for-of/for-in loop variable is function-scoped, not block-scoped, exactly as this same file's own `countHoistedVarScopeDeclarations` (round 17) and `subtreeContainsReassignmentOf` (round 17) already establish by testing `for_in_statement`'s `kind === 'var'` for the identical distinction.** See the for-of recursion's own paragraph, below, for the counter-example this self-inconsistency closes and the identical `var`-kind widening applied there. `SCOPE_NODE_TYPES`, `introducesShadowedBinding`, and `findDeclaringScopeNode` are untouched — this widens only which subtree THIS ONE recursive call searches, not what either shared primitive considers a shadow. Matches escape-fallback case (ba) and correlation shape 22.
> >
> > **ROUND 20 (#2088, B2) — widening to the enclosing function-shape node ITSELF, as originally specified above, reopens round 8's own self-shadow bug one level up, for a boundary this round introduces rather than one round 8 already covered.** Round 8's exemption is keyed by node IDENTITY: the walk never runs the shadow-check against the fixed `declaringScope` node itself, at any recursion level. When `declaringScope` is the enclosing FUNCTION node (as specified pre-round-20), that exemption covers the function node — but the walk still recurses INTO that node's own `body` field, a `statement_block`, which is a DIFFERENT node (a different `.id`) and therefore NOT exempt: it is checked against `introducesShadowedBinding` like any other nested scope the walk reaches. That check's `statement_block` case treats a body-level `function_declaration`/`generator_function_declaration`/`class_declaration` whose own name matches the tracked name as a shadow — correct for a GENUINELY nested, distinct binding, but WRONG here: a `function r(){}` sitting at the SAME top level of the very function the boundary was just widened to is not a distinct binding from a function-scoped `var r` anywhere else in that function (redeclaring a name as both `var` and a sibling `function` at the same scope is one coalesced binding, not two) — yet the check fires anyway, on this false premise, and prunes the function's ENTIRE body. Verified runnable, isolating the bug from every existing fixture (shape 22 and case (ba) both happen not to construct a same-named body-level function-or-class declaration, so neither one exercises this): with `widenTarget` set to the function node (the pre-round-20 specification),
> >
> > ```js
> > function fnAlpha() { return 1; }
> > function sink(x) { return x.alpha(); }
> > function install() {
> >   const T = { alpha: fnAlpha };
> >   function u() {}      // body-level, same name as the var below
> >   var u = T;            // var — widens the recursive call's boundary to install() itself
> >   sink(u);               // OUTSIDE nothing — but the whole body is now (wrongly) pruned
> > }
> > install();
> > ```
> >
> > the recursive check for `u` walks `install`'s body, reaches the `function u(){}` statement-block-level match, and — because `declaringScope` is `install` itself, not its body — treats the body as shadowed and prunes it wholesale: `sink(u)` is never visited, the surviving set is empty, and the (vacuously, not genuinely) exhaustive walk returns `true`. `T.escapes` reads `false`; `fnAlpha` would be reported dead though `sink(u)` invokes it via `T` every call. Executed against a small standalone model of this exact predicate chain (real `tree-sitter-javascript@0.25.0` parse, the unmodified, pre-existing `introducesShadowedBinding`/`SCOPE_NODE_TYPES`/`FUNCTION_SCOPE_NODE_TYPES` primitives, and this round's own widening logic): `widenTarget = <enclosing function node>` reads `escapes = 0` (wrong); `widenTarget = <that node's own body>` reads `escapes = 1` (correct). This is round 8's own self-shadow class of bug, recurring at a new node because this round's widening handed the walk a boundary of the WRONG GRANULARITY, not because round 8's exemption mechanism itself needs a second, bespoke carve-out (the way round 18's `method_definition` name-collision fix added one) — the boundary need only be the SAME KIND of node round 8's exemption already assumes everywhere else: a node whose own direct children ARE the search space, exactly what a `let`/`const` alias's un-widened `declaringScope` already naturally is (a `statement_block`), never a function-shape wrapper with a `name`/`parameters`/`body` structure sitting between it and that space. **Fixed by widening to the enclosing function-shape node's own `body` field instead of the node itself** — a `statement_block` for every `FUNCTION_SCOPE_NODE_TYPES` member capable of directly containing a `var` declaration in the first place (an arrow function's concise, non-block expression body cannot itself contain a `var` statement, so this is never a lossy substitution for the shapes this widening actually needs to cover) — which requires no second exemption and no change to round 8's own mechanism at all: the existing `.id`-based exemption, applied to the body node instead of the function node, already does the right thing, because it now matches the SAME invariant every other `declaringScope` in this design already satisfies. The alternative considered — extending round 8's exemption to ALSO cover the widened boundary's own direct function-body child as a second, bespoke special case — was rejected: it would fix this one instance while leaving the underlying mismatch (declaringScope sometimes a block, sometimes a function-shape wrapper) in place for the NEXT widening a future round adds, whereas fixing the granularity itself closes the whole class. Re-verified against shape 22 and case (ba) (neither constructs the colliding body-level declaration this bug needs, so both are unaffected either way) and against escape-fallback case (bd)/correlation shape 25 below, whose own for-of counterpart of this exact bug this round also fixes. New escape-fallback case (bf) is the minimal reproduction above, guarding this fix directly. `SCOPE_NODE_TYPES`, `introducesShadowedBinding`, `patternBindsName`, and `findDeclaringScopeNode` remain untouched.
>
> **The for-of branch ALSO recurses, into the loop variable — the same principle, one binding further** (round-7 critic finding, #2088 finding 2). Accepting `A`'s reference in `for (const r of A) …` on `isTrackedReferencePosition`'s `for_in_statement` branch is not enough on its own: `r` is a brand-new binding, and this analysis must follow it exactly as it follows a rebinding alias, or a site reads as local-closed while it can still escape through `r` — e.g. `for (const r of A) sink(r)` with `sink` imported (or local — the parameter-passing exclusion in condition 3 does not care which). Concretely: when a for-of-parented reference passes `isTrackedReferencePosition`, `allReferencesTracked` extracts the loop variable's name using the exact same shape `collectForOfBinding` itself already requires before it will emit a `forOfBindings` entry at all. **(ROUND 20, non-blocking prose correction)** — a `for_in_statement`'s own `left` field is ALWAYS a bare pattern node directly, for every `kind` (`const`/`let`/`var`/`using`/none): the grammar never wraps it in a `variable_declarator`, unlike a `lexical_declaration`/`variable_declaration` elsewhere in this file (verified against `tree-sitter-javascript@0.25.0`'s own `node-types.json`: `for_in_statement.left` admits `array_pattern`/`identifier`/`object_pattern`/`member_expression`/`parenthesized_expression`/`subscript_expression` directly, none of them a `variable_declarator`). `collectForOfBinding`'s own check therefore reduces to ONE branch here, not a choice between two — reading `left` as a bare `identifier` — and this walk reuses that SAME single branch; the pre-round-20 prose's parenthetical describing a second, `variable_declarator`-based alternative named a shape that cannot occur for THIS construct at all (it described the OTHER declaration forms this file handles elsewhere, not a second for-of shape) — the underlying CODE was never wrong, only this sentence's account of which branch fires. And, ONLY when that yields a single plain identifier, requires `allReferencesTracked(root, loopVarName, objectNode, false, loopDeclaringScope)` to also hold — "skipping the declaration itself" (the round-8 contract, above) means, for this head specifically, that the loop's own `left` identifier node is excluded from the candidate-reference set BEFORE this recursive call ever runs, since it is the BINDING occurrence, not a use; an implementation that instead only ever skipped a `variable_declarator`'s `name` field (the shape a `const`/`let` OWNER binding's own declaration takes) would never skip a for-of head's `left` at all, since — per the correction just above — it is never wrapped in one, making the loop variable's own declaring occurrence wrongly count as a disqualifying self-reference and escape every for-of correlation shape this design depends on, shape 2's own headline idiom included — where `loopDeclaringScope` is the SAME fixed `declaringScope` from the outer call, per the round-8 note above, UNLESS (ROUND 19, #2088 finding 2 — see this paragraph's own essay, below) the loop head's own `kind` field reads `var`, in which case it is widened exactly as the rebinding recursion's own `declaringScope` is widened for a `var`-kind alias (above) — under the same depth-6 cap shared with the rebinding recursion above, and the same non-vacuous-coverage requirement — `isArrayOwner` is hardcoded `false` for this recursive call regardless of the outer site's own `isArrayOwner`, because a for-of loop variable always denotes a single ELEMENT of the array, never the array itself, so `r.matches(...)`/`r.resolve(...)` must be checked as direct-binding-shaped member calls (see WU-10's re-verification of its own handler-array shape against this exact rule, condition 3 above). When the loop variable's shape is anything OTHER than a single plain identifier — most notably a destructuring pattern, `for (const { matches } of B) matches(x)` — the reference to `A`/`B` is REJECTED outright on this branch, full stop, with no recursive call to attempt at all: `collectForOfBinding` never emits a `forOfBindings` entry for a destructured loop variable (verified: it requires the declarator's `name` field to be a plain `identifier`), so nothing seeds a points-to fact for `matches` here, and `matches(x)` can never be a correlated call on a receiver pointing at `B`'s site no matter how `B` is referenced elsewhere — treating the reference as tracked regardless would silently reopen this exact gap for every destructuring for-of. Filed as a follow-up capability, the array-element analogue of #2620's bare-property-read gap — #2622.
>
> **ROUND 19 (#2088 finding 2) — a `var`-kind for-of/for-in HEAD is
> function-scoped, exactly like a `var`-kind alias (round 18, above), and the
> for-of recursion's own `declaringScope` reuse needed the identical widening
> round 18 gave the rebinding recursion, which pre-round-19 it did not
> have.** Round 18 widened the REBINDING recursion's own boundary for a
> `var`-declared alias, and its own closing sentence claimed a for-of loop
> variable was "always block-scoped" and therefore unaffected — but `var` is
> function-scoped regardless of which STATEMENT introduces it, and a for-of
> loop head is no exception: this plan's own round-17 fixes to
> `countHoistedVarScopeDeclarations` and `subtreeContainsReassignmentOf`
> already encode exactly that fact, each testing `for_in_statement`'s own
> `kind === 'var'` field for the identical distinction this recursion needed
> and did not have. Concretely, verified runnable under Node:
>
> ```js
> // sink.js: export function sink(x) { return x.alpha(); }
> import { sink } from './sink.js';
> function fnA() { return 1; }
> function install() {
>   if (true) {
>     const A = [{ alpha: fnA }];
>     for (var r of A) { }        // `var` — visible throughout install(), not just the if-block
>   }
>   sink(r);                      // OUTSIDE the if-block, still inside install() — genuinely reachable
> }
> install();
> ```
>
> `A`'s declaring scope (round 8) is the `if` statement's own block. The
> for-of recursion for `r`, pre-round-19, reused that SAME narrow block as
> `r`'s own search boundary — but `sink(r)`, `r`'s only other reference, sits
> textually AFTER the block closes, never a descendant of it. The recursive
> walk finds zero references to `r` within its (too-narrow) boundary and —
> believing itself exhaustive over the scope it was told to search — returns
> `true`. The site reads local-closed; `sink(r)` produces zero correlated
> evidence; `fnA` would be reported dead though `sink(r)` invokes it on every
> call. This is the identical failure shape round 18's own rebinding-recursion
> fix closes, for the loop-variable recursion instead of the alias one — the
> two recursions are siblings in this same function, and round 18 fixed only
> one of them.
>
> **Fixed by widening the for-of recursion's OWN `declaringScope` the
> identical way round 18 widens the rebinding recursion's, keyed on the SAME
> field this file's own round-17 fixes already test.** When the for-of head's
> `kind` field reads `var` (checked exactly as `countHoistedVarScopeDeclarations`
> and `subtreeContainsReassignmentOf` already check it for this identical
> node), the recursive call for the loop variable computes a NEW boundary —
> the `body` field of the nearest enclosing `FUNCTION_SCOPE_NODE_TYPES`
> member starting from the `for_in_statement` node itself (ROUND 20
> correction, below — through round 19 this was that member NODE ITSELF, not
> its `body`), or `root` if none — and passes THAT as `declaringScope`,
> instead of reusing the outer call's. A `let`/`const`
> for-of head (round 7 through round 18's own, now-corrected claim) keeps
> reusing the outer call's own `declaringScope` unchanged, since a
> block-scoped loop variable's visibility never extends past its nearest
> enclosing block, which is itself inside that boundary by construction.
> `SCOPE_NODE_TYPES`, `introducesShadowedBinding`, and `findDeclaringScopeNode`
> are untouched — this widens only which subtree THIS recursive call
> searches, mirroring round 18's own rebinding fix exactly, one binding
> further. Matches escape-fallback case (bd) and correlation shape 25.
>
> **ROUND 20 (#2088, B2/B4) — this widening has the SAME granularity bug as
> the rebinding recursion's, fixed the identical way, for the identical
> reason.** Setting `declaringScope` to the enclosing function-shape node
> itself, rather than that node's own `body`, means the walk's later descent
> into `body` (a DIFFERENT node from the exempted `declaringScope`, hence not
> itself exempt from the shadow-prune) can self-shadow on a body-level
> `function`/`class` declaration that merely happens to share the loop
> variable's own name — the identical mechanism the rebinding recursion's own
> round-20 essay (above) documents in full, one binding further. Verified
> runnable, again isolating the bug from every existing fixture (shape 25 and
> case (bd) below both happen not to construct a same-named body-level
> function/class declaration, so neither exercises it):
>
> ```js
> function fnAlpha() { return 1; }
> function sink(x) { return x; }
> function install() {
>   const A = [{ alpha: fnAlpha }];
>   function r() {}          // body-level, same name as the loop variable below
>   for (var r of A) { }      // var — widens the recursive call's boundary to install() itself
>   sink(r);
> }
> install();
> ```
>
> — `widenTarget = <enclosing function node>` reads `escapes = 0` (wrong: `sink(r)` is a genuine escape); `widenTarget = <that node's own body>` reads `escapes = 1` (correct). **Directly consequential for THIS round's own regression check: shape 25 (below) was itself vacuous under the pre-round-20 widening — ablating its `kind === 'var'` gate (forcing the widening to apply unconditionally, even to shape 25's own `let`-kind loop variable) still read `escapes = 0`, the SAME as the correct, gated answer, for exactly this reason: the unconditionally-widened boundary landed on `install64` itself, and `install64`'s own body is then self-shadow-pruned by ITS unrelated, later `const r64 = 5` — masking the ablation rather than revealing it.** Fixing this round's own granularity bug (widen to `body`, not to the function node) is what makes shape 25 non-vacuous: with the SAME ablation applied post-fix, the walk correctly reaches, and is correctly NOT confused by, the unrelated `r64` — see shape 25's own rebuilt commentary in WU-10 for the full before/after. Fixed the identical way as the rebinding recursion: widen to the enclosing function-shape member's own `body` field, never the member itself. New escape-fallback case (bg) is the minimal reproduction above. `SCOPE_NODE_TYPES`, `introducesShadowedBinding`, `patternBindsName`, and `findDeclaringScopeNode` remain untouched.
>
> **Why walk for references rather than reuse `blockContainsIdentifierExcluding`:** that helper answers "does this block contain a reference at all", which is the wrong question here — we need to classify *every* reference's position, not detect the first one. The shadow-detection primitive is shared; the traversal is not. (Round 8: this is also why `blockContainsIdentifierExcluding`'s OWN `MAX_WALK_DEPTH` truncation — which fails toward "not found," i.e. toward NOT flagging a problem — is not reused here unmodified: `allReferencesTracked` needs to know not just "was a disqualifying reference found" but "did the search even finish," which `blockContainsIdentifierExcluding`'s boolean return conflates. The non-vacuous-coverage requirement above is what keeps that conflation from becoming a silent false-negative once this design's own walk hits the same cap.)

> **ROUND 18 (#2088) — a SECOND scope this walk must exempt from the
> shadow-prune, alongside round 8's own `declaringScope` exemption: a
> NESTED `method_definition` whose own PROPERTY NAME happens to equal the
> name being tracked is not a genuine shadow at all, and pruning it hides a
> genuine reference exactly as round 8's self-shadow bug did.**
> `introducesShadowedBinding`'s shared function-shape case treats a
> `method_definition`'s own `name` field the same as a
> `function_declaration`/`function_expression`/etc.'s — a real binding, for
> those five node kinds. It is not one for a `method_definition`: a
> method's property key is a `property_identifier`, never an identifier
> BINDING accessible from within the method's own body, unlike a named
> function expression's own name (which genuinely IS bound inside its own
> body for self-reference — the shared case is correct for that kind).
> Concretely, verified runnable:
>
> ```js
> // b.js
> export function register(t) { return t.alpha(); }
> // a.js
> import { register } from './b.js';
> function fnA() { return 1; }
> const T = { alpha: fnA };
> const holder = { T() { register(T); } };   // method named T — same as the outer binding
> holder.T();
> ```
>
> `T`'s only reference outside its own declaration is `register(T)`, inside
> `holder`'s `T` method. `holder`'s object literal is a nested
> `SCOPE_NODE_TYPES` member reached during the walk (never the site's own
> `declaringScope`, so round 8's exemption does not apply to it), and
> `introducesShadowedBinding(holder's method_definition, 'T')` returns
> `true` — not because of a genuine parameter or hoisted `var`, but SOLELY
> because the method's own property key text happens to equal `T`. The
> walk prunes the ENTIRE method body, `register(T)` is never visited, the
> surviving set is empty, and — because the walk believes itself exhaustive
> over every scope it did not (correctly, by its own accounting) prune —
> this reads as `covered === true`, non-escaping, exactly the "the walk
> never looked, and doesn't know it never looked" failure round 8 already
> named, via a different mechanism: not a self-shadow at the DECLARING
> scope, but a false-positive shadow at a NESTED one. `fnA` would be
> reported dead though `register(T)` → `t.alpha()` invokes it through the
> cross-module call this exact shape is designed to test. This violates
> round 8's own standing rule (above) that this function returns `true`
> only when it can PROVE it examined every reference in scope — a
> proof that is only as good as the shadow-detection it leans on, and here
> that detection itself was wrong.
>
> **Fixed entirely in this consumer — NOT in `introducesShadowedBinding`,
> which stays untouched, per the discipline rounds 11/12/16/17 already
> established for this exact primitive.** When the walk reaches a
> `method_definition` node, it no longer treats
> `introducesShadowedBinding`'s bare `true`/`false` result as the whole
> answer for that node; it re-derives the two GENUINE sub-checks that
> function's own shared case already makes for this node kind — does the
> method's `parameters` field bind `name` (`patternBindsName`), or does its
> `body` hoist a `var name` anywhere inside it (`functionScopeDeclaresVar`)
> — and prunes the method only when one of THOSE holds. The method's own
> `name`-field match, alone, no longer prunes anything here — the walk
> continues into the method's params and body exactly as it would for any
> other non-shadowing scope. This re-derives, rather than reimplements,
> `introducesShadowedBinding`'s own two valid checks for this one node
> kind — a resolution-only carve-out for the SAME reason round 18's other
> three fixes stay local to their own consumers rather than widening a
> primitive several other, already-verified-sound call sites depend on: a
> method genuinely named the same as its own PARAMETER or a `var` hoisted
> in its body is still a real shadow and must still prune, exactly as
> `introducesShadowedBinding` already says for every other function-shape
> node kind. Matches escape-fallback case (ay) and correlation shape 20.
>
> **This is the OPPOSITE direction from every gap this walk's own history
> has found before it.** Round 8 (finding 1, above) and every fixture this
> chain has added since ask "which shadows does this walk MISS?" —
> fail-open BY OMISSION. This is "which NON-bindings does this walk treat
> AS bindings?" — fail-open BY FALSE POSITIVE, a direction nobody had
> audited for this primitive before. Auditing every OTHER
> `introducesShadowedBinding` arm for the identical direction (a node type
> or field read that is treated as a binding but is not one) found no
> further instance: `catch_clause`'s `parameter` field, `for_statement`'s
> `lexical_declaration` children, `statement_block`'s and `switch_body`'s
> `lexical_declaration`/named-declaration children, and the shared
> function-shape case's OWN `parameters`/hoisted-`var` checks are all
> genuine bindings by construction — `method_definition`'s bare `name`
> field is the only node-kind/field combination in this function that is
> not.

> **ROUND 20 (#2088, B5) — closes #2640: a `globalThis`-qualified READ of a
> script-scope binding is invisible to this walk in both directions, the
> read-side counterpart of round 16's own write-side fix
> (`isGlobalObjectQualifiedWrite`, #2634).** In a classic (non-module)
> script, a top-level `var T = {…}` attaches to the global object, so
> `globalThis.T.alpha()` is exactly as reachable a reference to `T` as a bare
> `T.alpha()` is. This walk's own node-matching filter, through round 19,
> only ever matches an `identifier`/`shorthand_property_identifier` node
> whose TEXT equals `bindingName` — a `member_expression`'s `property` field
> is a `property_identifier`, a distinct, deliberately-excluded node kind
> (round 19's own correlation shape 24 depends on that exclusion staying in
> place: an object-literal or member-expression KEY is never itself a
> value-producing reference to a binding of the same name). A `globalThis.T`
> read is therefore never visited by the walk at all — not classified
> untracked, simply never found — so a table read only this way reads as if
> it has zero references beyond its own declaration, and the non-vacuous
> coverage requirement (round 8) reads that vacuous result as `covered`,
> `escapes` reads `false`. Verified runnable (approximating the classic-script
> premise via a function-scoped `var`, the same mechanism
> `isGlobalObjectQualifiedWrite`'s own fixtures already rely on — see cases
> (ap)/(at)):
>
> ```js
> function fnA() { return 1; }
> var T = { alpha: fnA };
> function sink() { return globalThis.T.alpha(); }
> sink();
> ```
>
> `sink()` returns `1`, invoking `fnA` via `T`'s own `alpha` through the
> `globalThis`-qualified path — `T`'s only reference besides its own
> declaration — while the pre-round-20 walk finds no candidate reference to
> classify at all and reads this table as local-closed. **Fixed by giving the
> walk a THIRD way to recognise a candidate reference, alongside the
> `identifier`/`shorthand_property_identifier` text-match (round 19): a
> `member_expression`/`subscript_expression` node for which
> `isGlobalObjectQualifiedWrite(node, bindingName)` — the round-16 predicate,
> reused here VERBATIM and UNMODIFIED, exactly as its own existing fixtures
> already exercise it for the write side — returns `true`.** Executed against
> that exact, unmodified predicate: it matches `globalThis.T`,
> `globalThis['T']`, and `window.T` inside `globalThis.T.alpha()`/equivalents,
> and correctly does NOT match `unrelatedObj.T` (correlation shape 26, below,
> makes this an explicit regression guard, not merely an executed claim).
> Unlike the two existing node kinds this walk matches by TEXT, a match here
> is UNCONDITIONALLY untracked — no call to `isTrackedReferencePosition` is
> attempted, and no recursion into a further alias/loop-variable follows: no
> T1-like channel exists for a `globalThis`-qualified read (T1 correlates a
> member/subscript CALL through the points-to solver's own `objlit@`
> tokens, seeded only by a receiver variable the solver has traced — never
> through a synthetic global-object lookup), so finding one always makes the
> whole site escape, matching this design's own established "detect the
> shape reliably, then fail safe outright" preference (round 9's
> `spread_element`, round 18's getter, round 19's `__proto__` key) rather
> than inventing a fourth, still-necessarily-incomplete resolution path.
> Implemented as a THIRD disjunct in the walk's own candidate-matching step,
> checked before the two existing node-kind matches — not as a new branch of
> `isTrackedReferencePosition`, which classifies the POSITION of an
> already-matched, name-TEXTED reference and has no natural place for a node
> whose relevance is structural (an `object`/`property` shape) rather than
> textual. `TRACKED_REFERENCE_PARENTS`, `isTrackedReferencePosition`,
> `SCOPE_NODE_TYPES`, and `introducesShadowedBinding` are all untouched.
>
> **The write-side/read-side asymmetry #2640 itself raised is not coherent,
> and is not introduced here: `isGlobalObjectQualifiedWrite` never tested
> script-vs-module either.** It is a purely syntactic shape match — an
> identifier in `GLOBAL_OBJECT_NAMES` as the object, the binding name as the
> property/static index — with no check anywhere for whether the file
> parses as a classic script (where the premise is real) or an ES module
> (where `globalThis.name` reads the global object's OWN property, unrelated
> to any module-scope `T`, and this match would be a harmless, if pointless,
> false positive: an ES-module `T` can never actually be reached this way,
> so recognising the shape anyway only ever costs recall, never soundness).
> Round 16 accepted this for the write side without comment; this round
> accepts the identical simplification for the read side for the identical
> reason, rather than threading a parse-goal check through a resolution
> chain #2634's own Risks-table entry already declines to add for the write
> side. Matches escape-fallback case (bh) and correlation shape 26.
> `isGlobalObjectQualifiedWrite` itself is untouched by this fix — reused,
> not modified, exactly as its own doc comment already promises for the
> write side it was built for.

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

Mirrors WU-2 one-for-one, including every refinement through round 16 — dual-engine parity (ADR-001) means no finding from any round this plan documents, at any level (a whole round or an individual numbered finding within it), is TS-only. (Rounds 15 and 16 are the two most recent additions to this mirror at the time of writing; rather than hand-extend this sentence's own round-by-round, finding-by-finding enumeration again next round — the exact kind of list that goes stale silently, since nothing forces an editor touching WU-2 to also revisit this one — this sentence is deliberately phrased to describe the CURRENT round without naming every round that came before it. See WU-2's own doc comments for the full per-round, per-finding history this mirrors; the itemised bullets immediately below name only the rounds whose Rust-side mechanics are non-obvious enough to warrant their own callout, not a complete roster.)

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
    - ROUND 13 (#2088 finding 1) — new `subtree_contains_reassignment_of<'a>(node: &Node<'a>, name: &str, source: &[u8], depth: u32) -> bool` (the trailing `depth` mirrors `subtreeContainsThisKeyword`'s own explicit depth-cap parameter, since Rust has no default-parameter sugar here either — the TOP-level call passes `0`, exactly as `subtreeContainsThisKeyword`'s own does), called from `resolve_identifier_value_this_reference` immediately after `find_top_level_function_node_by_name` resolves a node and BEFORE the arrow-function check, mirroring the TS side's `subtreeContainsReassignmentOf` one-for-one: it walks the WHOLE file (not just the resolved node's own subtree) for an `assignment_expression`/`augmented_assignment_expression` whose `left` BINDS `name` (round 14, #2088 finding 1, below, replaces the round-13-original bare identifier match here with `pattern_binds_name`), an `update_expression` whose `argument` is `name`, or a `for_in_statement` whose `left` binds `name` (via `pattern_binds_name`, the same primitive `find_resolving_scope_node`'s own for-in disjunct already uses) with no `kind` field present — using the identical grammar fields verified against the same `tree-sitter-javascript@0.25.0` grammar the TS side's own round-13 doc comment cites. `find_top_level_function_node_by_name`'s own body is UNCHANGED by round 13 (it still deliberately accepts a `let`/`var` binding, not just `const`; ROUND 14, #2088 finding 2, below, is the first round to change it) — the missing precondition was in the caller, exactly as round 10's own finding 1 was. Returning `true` (found a write) makes the caller fail safe unconditionally, without attempting to resolve the write's own right-hand side — see the TS-side essay for why, and #2631 for the recall this costs. This function does not call, and is not called by, `find_resolving_scope_node`/`find_declaring_scope_node`/`introduces_shadowed_binding` — the reassignment question and the shadow question are independent, mirroring the TS side's own doc comment on this point.
    - ROUND 14 (#2088 finding 1) — `subtree_contains_reassignment_of`'s `assignment_expression`/`augmented_assignment_expression` arm replaces its round-13 bare `left.kind() == "identifier" && left.utf8_text(source).ok() == Some(name)` text match with `left.is_some_and(|l| pattern_binds_name(&l, name, source))` — mirroring the TS side's identical substitution one-for-one, and matching this same file's own pre-existing `pattern_binds_name` call sites for the identical question (`block_contains_identifier_excluding`'s `assignment_expression` arm, and `kills_binding`'s). `assignment_expression.left` (verified against the same `tree-sitter-javascript@0.25.0` grammar the TS side's own doc comment cites) permits `array_pattern`/`object_pattern` alongside `identifier`, so a destructuring write is now caught on this engine too, matching case (af)/(ag); it still cannot see a `parenthesized_expression` target, since `pattern_binds_name` has no case for one on either engine — tracked at #2630, extended by this round to name this arm (not merely the `for_in_statement` arm already named there) as an affected consumer. The `update_expression` and `for_in_statement` arms are UNCHANGED by this finding — `for_in_statement` already called `pattern_binds_name` before this round.
    - ROUND 14 (#2088 finding 2) — `find_top_level_function_node_by_name`'s OWN body changes, mirroring the TS side's identical restructuring and the first round on either engine in which this function's own body, rather than only its caller's, is what changes: rather than returning the first qualifying top-level declaration found, it now counts every top-level declaration of `name` it encounters while walking — a `function_declaration` name match, or a `variable_declarator` name match under a `lexical_declaration`/`variable_declaration`, regardless of whether ITS OWN value is one of the three recognised function shapes — and returns `None` once that count exceeds one, rather than the first candidate found. Mirrors the TS side's `declarationCount`/`result` bookkeeping one-for-one; matches cases (ah)/(ai).
    - ROUND 15 (#2088 finding 1) — `find_top_level_function_node_by_name`'s own body changes again, mirroring the TS side's identical widening: rather than counting only declarations that are direct children of `root`, it now ALSO counts a `var` declarator or a block-level `function_declaration` matching `name` reachable from `root` without crossing a function boundary — i.e. hoisted through a bare block/`if`/`for`/`try`/`switch` body, exactly as `var`'s own function-scoping (and, in sloppy-mode script code, Annex B's block-level-function hoisting, ECMA-262 §B.3.3) requires. New `count_hoisted_var_scope_declarations(node: &Node, name: &str, source: &[u8], depth: usize) -> u32`, called once per non-declaration top-level statement from the SAME loop `find_top_level_function_node_by_name` already runs, mirrors the TS side's `countHoistedVarScopeDeclarations` one-for-one — builds on, but is NOT a literal one-for-one reuse of, `function_scope_declares_var`'s own traversal shape (`FUNCTION_SCOPE_NODE_TYPES`, `javascript.rs:4697-4745`, already shipped for the analogous #2257 shadow check): that function only ever needs to recognise a `variable_declaration` node, which is never itself a `FUNCTION_SCOPE_NODE_TYPES` member, so it safely pre-filters a CHILD's type at the parent's own loop before ever visiting it. This function additionally recognises a `function_declaration` node — which IS itself a `FUNCTION_SCOPE_NODE_TYPES` member — so pre-filtering children the same way would skip visiting a nested `function_declaration` entirely, silently discarding the Annex-B match this function exists to find (see the TS-side doc comment for the full argument and the exact case, (ak), this distinction is load-bearing for). Every node's own type is instead checked for a match FIRST, and only THEN does that same node's type decide whether to recurse into its own children — generalised from `function_scope_declares_var`'s boolean "does at least one exist" return to a count, exactly as the TS side generalises `functionScopeDeclaresVar`'s. Deliberately counts a `variable_declaration` match (never a `lexical_declaration` one — a `let`/`const` in the identical nested position is block-scoped and already `find_resolving_scope_node`'s own concern, not this one's, matching the TS side's exclusion one-for-one) and a nested `function_declaration` match identically; on hitting `MAX_WALK_DEPTH`, returns `2` rather than `0` — the same truncate-toward-"an additional declaration exists" convention `subtree_contains_reassignment_of` already uses, for the identical reason (this function's whole contract is detecting ambiguity, so truncating toward zero would read a pathologically deep file as unambiguous by omission). Matches cases (aj)/(ak) and correlation shape 8.
    - ROUND 16 (#2088, #2630/#2632/#2634/#2636) — four independent fixes, verified against the REAL, already-shipped Rust source (not merely assumed to mirror it): `pattern_binds_name`'s own `_ => false` default arm (`javascript.rs:5036`) and `introduces_shadowed_binding`'s `statement_block` arm (`javascript.rs:4830-4864`, already listing `function_declaration`/`generator_function_declaration`/`class_declaration` beside `lexical_declaration` — the identical set the TS side lists, confirming this gap is not TS-specific) carry the identical gaps their TS counterparts do. New `unwrap_parens<'a>(node: &Node<'a>, depth: usize) -> &Node<'a>` (called with `depth: 0` at each call site, mirroring this file's own no-default-parameter convention elsewhere) mirrors the TS side's `unwrapParens` one-for-one, reusing `named_child(0)` — not `child_by_field_name`, since `parenthesized_expression`'s inner expression carries no field name in this grammar either — the same idiom this file's own `kills_binding` already applies at its own, pre-existing `parenthesized_expression` unwrap (`javascript.rs:5606-5611`). Called from `find_resolving_scope_node`'s `for_in_statement` disjunct and from BOTH of `subtree_contains_reassignment_of`'s `left`-reading branches (assignment/augmented-assignment and for-in), exactly mirroring the TS side's three call sites — `pattern_binds_name` and `introduces_shadowed_binding` themselves are, again, NOT widened. `find_resolving_scope_node` additionally gains a FOURTH disjunct: a `statement_block` ancestor whose direct children include a `using_declaration` for which `declaration_declares_name` (`javascript.rs:4923`, already type-agnostic — no changes needed) returns `true` — fixed here, not in `introduces_shadowed_binding`, for the identical reason the TS side's own round-16 essay gives (condition 3's own consumer of the shared primitive does not need this fix; only condition 4's resolution-only wrapper does). New `is_global_object_qualified_write(node: &Node, name: &str, source: &[u8]) -> bool` mirrors `isGlobalObjectQualifiedWrite` one-for-one — a `member_expression` `left` whose `object` is an `identifier` in `{"globalThis", "global", "self", "window"}` and whose `property` text equals `name` — ORed onto `subtree_contains_reassignment_of`'s existing assignment/augmented-assignment branch, gated identically (not conditioned on the resolved declaration's own kind, for the same accepted-simplicity reason the TS side's essay states). `find_top_level_function_node_by_name`'s direct-children loop gains `generator_function_declaration` as a full sibling of `function_declaration` — counted, sets `result`, `continue` — mirroring the TS side's fix exactly; `count_hoisted_var_scope_declarations` gains NO matching case for `generator_function_declaration` in its own recursive walk, mirroring the TS side's deliberate non-fix there (Annex B never covers a generator declaration, so a NESTED one does not hoist and is already `introduces_shadowed_binding`'s `statement_block` arm's own concern, which — as just verified above — already lists `generator_function_declaration` beside `function_declaration`). Matches cases (al)-(aq) and correlation shapes 9-12.
    - ROUND 17 (#2088, #2637 / finding 1 / finding 2 / finding 3 / Greptile) — six further additions, mirroring the TS side one-for-one; the `switch_body` and `for_statement` gaps were both independently re-verified against the REAL, already-shipped Rust source rather than assumed to mirror the TS side's own citation: `introduces_shadowed_binding`'s `switch_body` arm (`javascript.rs:4883-4913`) enumerates each `switch_case`/`switch_default` clause's own children for `lexical_declaration` (via `declaration_declares_name`) and the same three named-declaration kinds the TS side's own arm does, with the identical missing `using_declaration` case — confirming this gap, like round 16's four, is not TS-specific. `find_resolving_scope_node` gains a FIFTH disjunct mirroring the TS side's own new `switch_body` check: scans each direct `switch_case`/`switch_default` child of a `switch_body` ancestor for a `using_declaration` matching via `declaration_declares_name` (`javascript.rs:4923`), exactly as its existing `statement_block` disjunct (round 16) already does for that node kind — `introduces_shadowed_binding` remains untouched, for the identical reason round 16's own essay gives. Closes #2637. `introduces_shadowed_binding`'s `for_statement` arm (`javascript.rs:4818-4829`, immediately preceding its `statement_block` arm) was independently checked for the identical gap, since the underlying TS-side audit found it was not unique to `switch_body` — confirmed to carry it too (`lexical_declaration` only among its own direct children). `find_resolving_scope_node` gains a further disjunct mirroring the TS side's own new `for_statement` check: scans the `for_statement` ancestor's own direct children (never wrapped in a clause container, unlike `switch_body`'s) for a `using_declaration` matching via `declaration_declares_name` — `introduces_shadowed_binding` again remains untouched. Also closes #2637. `find_resolving_scope_node` gains a further, unconditional disjunct: any `with_statement` ancestor returns immediately, with no `name` check — mirroring the TS side's own new check one-for-one; Rust's tree-sitter binding exposes the identical `with_statement` node kind, so no new grammar assumption is introduced on this engine. `count_hoisted_var_scope_declarations` gains a new `for_in_statement` case: a `kind` field whose text is `"var"` and a `left` field that, after `unwrap_parens`, `pattern_binds_name`s `name`, counts as one more hoisted declaration — mirroring the TS side's `countHoistedVarScopeDeclarations` fix one-for-one, and, like that fix, falling through to the existing recursive loop afterward rather than short-circuiting, since `for_in_statement` is not itself a `FUNCTION_SCOPE_NODE_TYPES` member on either engine. `subtree_contains_reassignment_of`'s own `for_in_statement` arm widens its existing `kind().is_none()` gate to `kind().is_none() || kind_text == "var"` — mirroring the TS side's identical gate change, and, like it, leaving `let`/`const`/`using` heads to keep failing the gate (still creating a genuinely new, loop-scoped binding, the shadow axis's own concern). `is_global_object_qualified_write` gains a `subscript_expression` arm alongside its existing `member_expression` one: `object` an `identifier` in the same four-name allow-list, `index` a `string`/`template_string` whose quote/backtick-stripped, `$`-free text equals `name` — reusing `is_tracked_reference_position`'s own static-key normalisation verbatim, exactly as the TS side's `isGlobalObjectQualifiedWrite` does. Separately, `subtree_contains_reassignment_of`'s own `update_expression` arm routes `argument` through `unwrap_parens` before the identifier comparison, mirroring the TS side's identical Greptile-flagged consistency fix — verified empirically on this engine too that an update expression's own numeric-coercion semantics mean no construction through this arm alone can reassign `name` to a new function value, so this fix (like its TS counterpart) closes a structural asymmetry with the arm's assignment/for-in siblings, not a soundness gap. Matches cases (ar)-(av) and correlation shapes 13-18.
    - ROUND 18 (#2088, #2637 reopened) — REPLACES round 17's own `for_statement` disjunct above, which scanned for a `using_declaration` child `tree-sitter-javascript@0.25.0`'s grammar can never produce there — confirmed against the REAL, already-shipped Rust source exactly as the TS-side fix was confirmed against the real JS grammar and the real parser: `for_statement`'s `initializer` field admits only `lexical_declaration`/`variable_declaration`, a bare expression, or `empty_statement` on both engines' shared grammar, never `using_declaration`, so the round-17 Rust disjunct (mirroring the TS side's own dead code one-for-one, per this section's own stated mirroring discipline) was equally unreachable. New `is_malformed_using_initializer(node: &Node, source: &[u8]) -> bool` mirrors `isMalformedUsingInitializer` one-for-one: `node.kind() == "ERROR"` and its own `utf8_text(source)` begins with `using`/`await using` (checked via a regex or an equivalent manual prefix-plus-word-boundary test, matching the TS side's `RegExp` exactly in behavior, not necessarily in implementation), OR the identical test on any DIRECT child of `node` one level down — mirroring the TS side's two-level check for the `await using` spelling, which nests its own `ERROR` one level inside a misparsed `assignment_expression` on both engines identically (verified: Rust's `tree-sitter` binding parses the same source bytes through the same compiled grammar, so a shape verified on one engine's parse tree is, by construction, identical on the other's — this is the FIRST fixture-verification claim in this plan's history to lean on that equivalence explicitly rather than re-deriving it per engine). `find_resolving_scope_node`'s `for_statement` disjunct now calls `is_malformed_using_initializer` against each direct child instead of matching `using_declaration`, and fails safe UNCONDITIONALLY on a match — no `name` parameter involved, mirroring the TS side's own unconditional shape and the `with_statement` disjunct immediately below it. `introduces_shadowed_binding` remains untouched. Re-closes #2637 (reopened because the round-17 fix, on both engines, was never reachable). Separately, three further mirrors of the TS side's own three round-18 fixes: `literal_has_unmodeled_this_reference`'s `method_definition` arm now checks for a `get` token among the node's direct children (Rust's tree-sitter binding exposes the identical unfielded `get`/`set` tokens the TS grammar does) and escapes unconditionally when found, regardless of what `subtree_contains_this_keyword` finds in the getter's own body — mirroring `literalHasUnmodeledThisReference`'s own new getter rule one-for-one; `all_references_tracked` gains the identical `method_definition` name-field carve-out, re-deriving `pattern_binds_name`/`function_scope_declares_var` for that one node kind rather than trusting `introduces_shadowed_binding`'s own name-field match, mirroring `allReferencesTracked`'s own new exemption; and `is_global_object_qualified_write` routes `object` through the existing `unwrap_parens` in both arms (mirroring `isGlobalObjectQualifiedWrite`'s own fix), with the function's own call site in `subtree_contains_reassignment_of` also unwrapping its `left` argument before passing it in, matching the TS side's identical belt-and-suspenders call-site fix (also closing Greptile's own separately-flagged whole-target-parenthesized shape, `(globalThis.run) = …`, verified as the identical call-site gap rather than a fifth, distinct fix). A fifth mirror, also Greptile-flagged: `all_references_tracked`'s rebinding recursion widens its own search boundary — the nearest enclosing member of the Rust mirror's own `FUNCTION_SCOPE_NODE_TYPES` constant (`function_scope_declares_var`'s own, `javascript.rs:4697-4745`), starting from the alias's declaration, or `root` if none — when the alias's own declarator `kind` is `var` (mirroring the TS side's own `variable_declaration`-vs-`lexical_declaration` distinction), rather than reusing the outer call's `declaring_scope` unconditionally; a `let`/`const` alias keeps reusing the outer call's boundary exactly as every prior round already established. **(ROUND 19 correction — this bullet's own parenthetical "(or for-of loop variable)" was false, mirroring the identical TS-side error the round-19 TS essay corrects; see ROUND 19's own bullet, below, for the fix this engine's for-of recursion needed and did not have.)** `SCOPE_NODE_TYPES`, `introduces_shadowed_binding`, and `find_declaring_scope_node` are untouched. Matches cases (aw)-(ba) and correlation shapes 19-22.
    - ROUND 19 (#2088, findings 1-3) — three independent mirrors, plus one correction to this section's own round-18 text (immediately above): `literal_has_unmodeled_this_reference`'s `pair` arm gains a check on the `pair`'s own `key` field, read BEFORE `value`: a non-computed `property_identifier`/`string` key (quote/backtick-stripped via the existing `unwrap`-adjacent idiom this file already uses for a static key elsewhere) whose text equals `"__proto__"` escapes UNCONDITIONALLY, mirroring `isPositivelyThisFreeLiteral`'s TS-side caller-side fix one-for-one; `is_positively_this_free_literal` itself is untouched, matching the TS side's own discipline of fixing this in the caller rather than the value-shape predicate. `all_references_tracked`'s own node-type filter — through round 18, `identifier` only — gains `shorthand_property_identifier` as a second matched kind, mirroring the TS side's identical widening; `property_identifier`/`private_property_identifier` (object-literal KEY positions) are deliberately not added, since a key is never itself a value-producing reference. Finally, the for-of recursion inside `all_references_tracked` gains the identical `var`-kind boundary-widening round 18 gave the REBINDING recursion one bullet above, correcting this same bullet's own false claim that a for-of loop variable "keeps reusing the outer call's boundary" unconditionally: when the `for_in_statement`'s own `kind` field reads `"var"`, the recursive call for the loop variable computes a new boundary — the nearest enclosing `FUNCTION_SCOPE_NODE_TYPES` member starting from the `for_in_statement` node itself, or `root` if none — mirroring the TS side's identical fix and reusing the same `kind === "var"` field test `count_hoisted_var_scope_declarations` and `subtree_contains_reassignment_of` (round 17) already apply to this exact node. `SCOPE_NODE_TYPES`, `introduces_shadowed_binding`, `pattern_binds_name`, and `find_declaring_scope_node` are untouched by all three. Separately, non-blocking: `resolve_identifier_value_this_reference`'s TS counterpart gains an `.id`-comparison consistency fix this round (see WU-2's own doc comment) — Rust's mirror never had the equivalent comparison to begin with, since `find_resolving_scope_node` returns `Option<Node>` and this function branches on `.is_some()`/`.is_none()` directly rather than computing a `?? root`-style fallback and then comparing it back against `root`; no Rust change is needed, and this is noted here only so a future reviewer does not go looking for one. Matches cases (bb)-(bd) and correlation shapes 23-25.
    - ROUND 20 (#2088, B1-B5/#2640, G1, UE-C) — five mirrors of the TS side's own five fixes, plus two non-blocking consistency mirrors: `literal_has_unmodeled_this_reference`'s `pair`-key check gains the identical backslash fail-safe — `raw_key_text.contains('\\')`, checked via a byte scan over the key's own `utf8_text(source)`, ORed onto the existing stripped-text equality, both still gated behind the unchanged `key.kind() != "computed_property_name"` guard (B1). `all_references_tracked`'s rebinding-alias and for-of-loop-variable recursions each compute their widened boundary as the nearest enclosing `FUNCTION_SCOPE_NODE_TYPES` member's own `body` field (via `child_by_field_name("body")`), not that member node itself — mirroring the TS side's identical correction to both call sites (B2); correlation shapes 23 and 25 are corrected/re-verified on this engine identically, and cases (bf)/(bg), run under both engines, are what actually force the `body`-vs-node distinction, per this section's own established parity-risk discipline (see below). `all_references_tracked`'s own candidate-matching walk gains a THIRD node-matching arm: a `member_expression`/`subscript_expression` for which `is_global_object_qualified_write(node, binding_name, source)` — the existing, round-16 write-side predicate, called here UNMODIFIED — returns `true`, treated as unconditionally untracked, with no recursive call attempted (B5, closes #2640). Separately, non-blocking: `is_global_object_qualified_write`'s `subscript_expression` arm routes its `index` field through the existing `unwrap_parens` before the type check, mirroring the TS side's identical fix (G1); `is_tracked_reference_position`'s member/subscript branch gains a `property.utf8_text(source)` check against `"call"`/`"apply"`/`"bind"`, returning `false` immediately when matched, before the call-position check runs (UE-C). `SCOPE_NODE_TYPES`, `introduces_shadowed_binding`, `pattern_binds_name`, and `find_declaring_scope_node` are untouched by all five. Matches cases (be)-(bj) and correlation shape 26.
    - ROUND 11 (#2088 finding 2) — `is_unshadowed_builtin_global` (round 10) is DELETED: it treated a builtin-named IMPORT as an unshadowed global, since `definition_names` (built from `symbols.definitions`, mirroring the TS side's `build-edges.ts:559`) excludes imports by construction — a regression in the `pair` arm specifically, which through round 9 always escaped unconditionally on a builtin name and never called this helper's predecessor guard at all. Both the `shorthand_property_identifier` arm and the `pair` arm's identifier branch now short-circuit to `true` (escaping) on a bare `BUILTIN_GLOBALS.contains(name)`, with no `definition_names` lookup and no resolution attempted — restoring the `pair` arm's pre-round-10 behaviour and giving the shorthand arm that same unconditional-escape treatment for the first time. With nothing left to distinguish the two arms' builtin handling, there is no remaining call site for `is_unshadowed_builtin_global` on either engine, and it is removed from `javascript.rs` rather than kept as a vestigial, uncalled function (which `cargo clippy -- -D warnings`'s dead-code lint would flag in any case). Crediting a genuinely unshadowed builtin (imports included) as safe again is filed as its own follow-up, to be designed and mirrored in both engines together as its own round — see Success Criteria.
  - `compute_object_literal_site_escapes` gains no new PARAMETER for round 9, round 10, round 11, round 12, or round 13 (unlike round 7's `definition_names` and round 8's `declaring_scope`/`source`-threading) — all five rounds are entirely internal to `literal_has_unmodeled_this_reference`'s own shape recognition and its identifier-resolution helpers, so its call site in `compute_object_literal_site_escapes` is unchanged since round 8.

Every new Rust item carries a `/// Mirrors <tsSymbol> in src/extractors/javascript.ts` line — the convention `handle_object_literal_pair_value_ref` already follows.

> **Parity risk specific to round 7 through round 10:** round 7's `is_array_owner` short-circuit, round 8's stripped-text/no-`$` check applied uniformly to both subscript index kinds (replacing round 7's template-only version), round 8's declaring-scope/non-vacuous-coverage walk, round 9's fall-through-arm inversion in `literal_has_unmodeled_this_reference`, and round 10's shadow-check-before-module-search ordering in `resolve_identifier_value_this_reference` plus its shared builtin guard are all easy to port correctly for the obvious cases and easy to narrow silently in a hand-written port — exactly the class of mistake round 7's Rust mirror of the `$`-guard itself would repeat if copied without noticing round 8's TS-side correction. Round 9 specifically: a Rust `match` on `child.kind()` with an explicit `_ => false` fall-through arm looks, on a quick read, like ordinary exhaustiveness hygiene rather than a safety-critical default — the reviewer diffing the two engines side by side (below) must confirm that arm is `true`, not `false`, and that `spread_element` is not silently absent from the match altogether (which would compile fine under a wildcard arm and be just as wrong). Round 10 specifically: it is easy to port `is_unshadowed_builtin_global` correctly while forgetting to apply it to BOTH arms — e.g. fixing only the `shorthand_property_identifier` arm and leaving the `pair` arm's identifier branch on its old, differently-shaped guard would compile, pass every existing single-arm-focused assertion, and silently reintroduce the exact "not actually identical" gap finding 2 closes, just moved to the other arm. WU-10's dual-engine assertion on the new escape-fallback cases (below) is what actually catches a missed one — a reviewer diffing the two `is_tracked_reference_position`/`isTrackedReferencePosition` and `all_references_tracked`/`allReferencesTracked` bodies side by side, now extended to `literal_has_unmodeled_this_reference`/`literalHasUnmodeledThisReference` and `resolve_identifier_value_this_reference`/`resolveIdentifierValueThisReference` for rounds 9 and 10, is the other half of the gate, per the Testing Strategy section's "what no tier catches" note.
>
> **Parity risk specific to round 11 — REMOVING code correctly is its own hazard, distinct from porting new code correctly.** Two failure modes, both silent if missed: (1) deleting `is_unshadowed_builtin_global` and its two call sites in ONE engine but not the other — e.g. fixing the TS side and leaving `javascript.rs` on round 10's `is_unshadowed_builtin_global` guard — would make the TWO ENGINES DISAGREE on every builtin-named-import fixture, exactly the drift `/parity` exists to catch, but only if WU-10's new cases (ab)/(ac) actually run under both engines; (2) porting `find_resolving_scope_node` while missing that it must be called ONLY from `resolve_identifier_value_this_reference`, never from `all_references_tracked`'s own `find_declaring_scope_node` call — accidentally wiring the new for-in-aware check into the WRONG call site would silently change condition 3's reference-walk boundary (already correct, already re-verified sound) rather than only condition 4's resolution question, reopening exactly the genuine `for (const x of fn())` read `SCOPE_NODE_TYPES`'s own doc comment protects. A reviewer diffing the two engines' `resolve_identifier_value_this_reference`/`resolveIdentifierValueThisReference` and `all_references_tracked`/`allReferencesTracked` bodies side by side must confirm BOTH: that `find_resolving_scope_node` appears in exactly one of the two call chains, and that `is_unshadowed_builtin_global` appears in neither engine at all, not merely that it was renamed or narrowed. WU-10's new escape-fallback cases (aa)–(ac), run under both engines, are what actually forces this rather than trusting the diff-review alone. **Round 12 adds a THIRD disjunct to the same function (the bare arrow-parameter case, finding 1) and carries the identical porting hazard as the for-in one:** a hand-written Rust port that checks `child_by_field_name("parameter")` against the wrong node (e.g. testing it on `node` itself rather than on `current` inside the same loop iteration as the other two disjuncts) or that omits the check silently compiles and passes every fixture except the one new case built to catch it — case (ad), run under both engines, is what forces this rather than a side-by-side read alone.
>
> **Parity risk specific to round 13 — a NEW helper function, not another disjunct on an existing one.** Unlike rounds 11–12 (which each added one more disjunct to the SAME `find_resolving_scope_node`/`findResolvingScopeNode`), round 13 introduces an entirely new function, `subtree_contains_reassignment_of`/`subtreeContainsReassignmentOf`, called from a DIFFERENT point in `resolve_identifier_value_this_reference` than any existing disjunct. A hand-written Rust port that wires this new call in AFTER the arrow-function check instead of before (matching the TS side's own placement precisely — "before the arrow_function early-return" is the load-bearing detail the counter-example exploits) would compile, pass every fixture that never reaches this code path, and only diverge on case (ae) specifically, which is what actually forces the ordering rather than a side-by-side read alone. A second, narrower hazard: the `for_in_statement` branch's "no `kind` field" test must check for the ABSENCE of a field, not merely branch on the for-loop's own leading `await` token — porting it as a positional or textual check on the loop's leading tokens rather than `node.child_by_field_name("kind").is_none()` would silently reintroduce exactly the ambiguity the TS-side doc comment's `grammar.json` citation rules out (the loop's own `await`, when present, is unfielded and structurally cannot collide with the separately `kind`-tagged declaration keyword) — a reviewer diffing the two engines' `subtree_contains_reassignment_of`/`subtreeContainsReassignmentOf` bodies side by side must confirm both use the field-based test, not a positional or textual one.
>
> **Parity risk specific to round 14 — two independent fixes in the SAME function pair, each with its own narrow porting hazard.** Finding 1 is a one-line substitution (`pattern_binds_name` for a bare identifier match) inside an EXISTING match arm — easy to port correctly, but just as easy to port into the WRONG arm: `subtree_contains_reassignment_of` has three arms (assignment, update, for-in), and this round touches ONLY the first. A hand-written port that also routes the `update_expression` arm's `argument` field through `pattern_binds_name` would compile and might even pass every existing fixture (an update target cannot syntactically be a destructuring pattern in the first place — see the TS-side doc comment) while silently diverging from the TS side's own, deliberately narrower arm the moment either engine is re-audited and the other is not; the two arms must be diffed independently; they are not interchangeable merely for sitting three lines apart. Finding 2 is the more structurally hazardous of the two: it is the FIRST round to change `find_top_level_function_node_by_name`'s own body rather than only its caller, on either engine, so there is no prior-round Rust mirror of this exact editing shape to pattern-match against. The load-bearing detail is that the declaration COUNT must increment for EVERY top-level declaration of `name` encountered — including one whose OWN value is not a recognised function shape (a bare `var name;` or `var name = 5;`) — not only for one that would itself qualify as a return candidate. A hand-written Rust port that increments the counter only inside the existing "value is one of the three recognised shapes" branch, rather than for every matching `variable_declarator` regardless of its own value, would silently under-count and miss exactly the `var run = () => {}; var run = function () { return this.alpha(); };` shape case (ah) exists to catch — cases (ah)/(ai), run under both engines, are what actually force this rather than a side-by-side read alone.
>
> **Parity risk specific to round 15 — a new helper, called from inside the SAME loop it widens, not from a downstream caller.** Unlike round 14 finding 2 (which changed `find_top_level_function_node_by_name`'s existing loop body but added no new function), round 15 adds `count_hoisted_var_scope_declarations`/`countHoistedVarScopeDeclarations` and calls it from a NEW branch inside that same loop — the branch that runs when `stmt` is neither a direct `function_declaration` nor a direct `lexical_declaration`/`variable_declaration`. A hand-written Rust port that places this call OUTSIDE the loop (e.g. as a single whole-file pre-pass added to `declaration_count` once at the end) rather than accumulating it per-statement inside the loop would compile and might even pass cases (aj)/(ak) in isolation, but would silently double-count a hoisted declaration that ALSO happens to sit inside a statement the loop's existing branches already inspect for an unrelated reason — case (aj)/(ak), run under both engines, force the correct placement rather than a side-by-side read alone. The second, sharper hazard is the `lexical_declaration` exclusion itself: `count_hoisted_var_scope_declarations`'s first check must read `node.kind() == "variable_declaration"`, never `"lexical_declaration"` — a hand-written port that copies `declaration_declares_name`'s own call without first re-checking which of the two sibling declaration kinds it is being invoked against would silently widen the count to `let`/`const` too, exactly the over-escape correlation shape 8 exists to catch; a reviewer diffing `count_hoisted_var_scope_declarations`/`countHoistedVarScopeDeclarations` side by side must confirm both engines gate on `variable_declaration` specifically, not on `declaration_declares_name`'s own kind-agnostic name match alone. **The third hazard is the most dangerous because a naive port of `function_scope_declares_var`'s OWN pre-existing traversal shape compiles, looks like a faithful reuse, and passes case (aj) while silently failing case (ak).** `function_scope_declares_var`'s loop checks each CHILD's `kind()` against `FUNCTION_SCOPE_NODE_TYPES` and skips recursing into it BEFORE ever visiting it — safe there because the ONLY node kind it recognises, `variable_declaration`, is never itself a `FUNCTION_SCOPE_NODE_TYPES` member, so nothing this filter skips could ever have been a match anyway. This function recognises `function_declaration` too, which IS itself a `FUNCTION_SCOPE_NODE_TYPES` member — porting the parent-side pre-filter unchanged would skip visiting a nested `function_declaration` child entirely, so its own name-match self-check never runs, and the Annex-B redeclaration case (ak) exists specifically to catch counts silently going to zero. The correct shape checks EVERY node's own kind for a match FIRST, THEN gates recursion on that SAME node's kind — self-check, then decide whether to descend — never a child-kind filter applied before the child is ever visited; a reviewer diffing the two engines' bodies must confirm both structure the walk this way, not merely that both reference `FUNCTION_SCOPE_NODE_TYPES`.

> **Parity risk specific to round 16 — four independent fixes, each with its own narrow porting hazard, none of which may be satisfied by widening a shared primitive.** First, `unwrap_parens`: a hand-written port that reads `child_by_field_name` instead of `named_child(0)` would compile (both return `Option<Node>`) and silently return `None`/never unwrap, since `parenthesized_expression`'s inner expression carries no field name in this grammar — cases (al)/(am)/(an), run under both engines, are what actually force the positional read rather than a side-by-side read alone. Second, and the more structurally hazardous of the four: a port that adds `unwrap_parens` calls but ALSO adds a `parenthesized_expression` case directly to `pattern_binds_name` (reasoning, plausibly, "since we're touching this anyway") would compile, pass every one of this round's own new cases, and silently widen a primitive `blockContainsIdentifierExcluding`'s Rust mirror and `kills_binding` both depend on staying exactly as narrow as it is today — no fixture in this suite is positioned to catch that widening by itself, since every existing consumer's own fixtures were written against the CURRENT, narrower behavior; a reviewer diffing `pattern_binds_name`/`patternBindsName` side by side must confirm neither engine's copy gained a new match arm, not merely that the NEW call sites behave correctly. Third, the `using_declaration` disjunct: a port that adds it to `introduces_shadowed_binding`'s `statement_block` arm instead of to `find_resolving_scope_node` — the SAME shared-primitive-widening mistake, one function over — would also compile and also pass case (ao) (since that fixture's own object literal sits inside the shadowing block either way), but would silently change condition 3's `find_declaring_scope_node`/`allReferencesTracked` reference-walk boundary too, reopening exactly the kind of accidental cross-consumer coupling round 11's own parity-risk paragraph already warns about for a different disjunct; case (ao) alone cannot distinguish "fixed in the right function" from "fixed in the wrong one," which is why the essay in `find_resolving_scope_node`'s own doc comment, not the fixture, is what a reviewer must check. Fourth, `is_global_object_qualified_write`: a port that matches on `property` text alone, without also checking `object.kind() == "identifier"` and membership in the four-name allow-list, would compile and pass case (ap) (a genuine `globalThis.run34` write) but would ALSO wrongly fire on case 11's own guard (`obj28.run28 = …`), turning an intended non-escaping correlation shape into a spurious escape — case 11, run under both engines, is what forces the full guard rather than a side-by-side read alone. Unlike rounds 11-15, none of round 16's four fixes may be satisfied by widening `pattern_binds_name` or `introduces_shadowed_binding` themselves, on either engine — the discipline this whole parity-risk section has maintained since round 11 (do not touch `SCOPE_NODE_TYPES`/`find_declaring_scope_node` for a condition-4-only need) is, as of this round, extended to the pattern-matching primitive itself, not only to the scope-walk one.
>
> **Parity risk specific to round 17 — six independent fixes (across four functions), each with a narrow porting hazard distinct from round 16's four.** First, the `switch_body` disjunct and its `for_statement` sibling (found by auditing every `SCOPE_NODE_TYPES` member for the identical gap): a port that adds either to `introduces_shadowed_binding`'s own matching arm instead of to `find_resolving_scope_node` — the SAME shared-primitive-widening mistake round 16's own parity-risk paragraph already names for the `using_declaration`/`statement_block` case, one node kind over — would compile and pass case (ar) or (av) respectively (since each fixture's own object literal sits inside the shadowing construct either way), but would silently change condition 3's reference-walk boundary too; neither case alone can distinguish "fixed in the right function" from "fixed in the wrong one," so a reviewer must check `find_resolving_scope_node`'s own body directly for BOTH disjuncts, exactly as round 16's own paragraph already requires for its sibling disjunct. Second, the `with_statement` disjunct: because it is UNCONDITIONAL (no `name` check at all), a port that accidentally guards it behind a `name`-bearing test copied from a neighbouring disjunct — plausible, since every OTHER disjunct in this function reads a field and compares it to `name` — would compile, and would even pass case (au) if that fixture's own construction happens to satisfy the copied guard, but would silently under-fire on any `with` block whose own shape does not incidentally match it; a reviewer diffing `find_resolving_scope_node`/`findResolvingScopeNode` side by side must confirm this disjunct takes no `name`-bearing condition at all, not merely that it returns `current` somewhere. Third, and the most dangerous because it can pass every fixture while being HALF wrong on one engine: the `for_in_statement`/`var` gap spans TWO independent functions, `count_hoisted_var_scope_declarations` and `subtree_contains_reassignment_of`, and either one alone already closes case (as) once fixed — so a port that fixes only one of the two on a given engine passes every WU-10 fixture in this suite (including the dual-engine assertion, if the OTHER engine's port happens to carry the identical partial fix in the identical function), while that engine's own two functions silently disagree about whether a `var`-kind for-of/for-in head is a write, a redeclaration, both, or neither — a latent inconsistency no CURRENT fixture is positioned to surface, since case (as) asks only for the combined OUTCOME, never which function produced it. A reviewer must independently confirm BOTH `count_hoisted_var_scope_declarations`/`countHoistedVarScopeDeclarations` AND `subtree_contains_reassignment_of`/`subtreeContainsReassignmentOf` each carry their own half of this fix, on each engine separately, rather than inferring one function's correctness from the fixture passing or from the other function's own presence — the same "the fixture proves the end-to-end outcome, not which code path produced it" caveat case (an)'s own commentary already states for a different pair of functions. Fourth, the `update_expression` branch's own `unwrapParens` routing (Greptile-flagged, not a WU-2b finding): a port that skips it — reasoning, plausibly, that an update expression can never reassign a handler to a new function value anyway, so the branch "doesn't matter" — would be correct about the SOUNDNESS conclusion but would leave the two engines' `subtree_contains_reassignment_of`/`subtreeContainsReassignmentOf` bodies STRUCTURALLY divergent from each other for no reason, reopening exactly the kind of asymmetry a future reviewer, or a future round widening this branch for an unrelated purpose, could misread as intentional; correlation shape 18, run under both engines, is what confirms the port landed on both regardless of its own nil soundness stakes. Fifth, `is_global_object_qualified_write`'s new `subscript_expression` arm: a port that matches on `index` text alone, without also checking `object.kind() == "identifier"` and membership in the four-name allow-list — the SAME simplification hazard round 16's own parity-risk paragraph already names for this function's `member_expression` arm, one arm over — would compile and pass case (at) (a genuine `globalThis['run42']` write) but would ALSO wrongly fire on case 15's own guard (`obj38['run38'] = …`), turning an intended non-escaping correlation shape into a spurious escape; a reviewer must confirm the new arm re-derives the SAME object-identity check the existing `member_expression` arm already applies, not merely a copy of its quote-stripping logic alone.
>
> **Parity risk specific to round 18 — the first round where the TS-side fix ITSELF was found unreachable, not merely at risk of a narrow port.** First, `is_malformed_using_initializer`: a port that checks direct children only, never the one-level-deeper nesting the `await using` spelling produces, would compile and pass case (av) (the plain `using` spelling, a direct-child `ERROR`) but silently miss case (aw) (the `await using` spelling, nested one level inside a misparsed `assignment_expression`) — the two spellings are independently fixtured for exactly this reason, mirroring the TS side's own two-case split. Second, and specific to this round: because the round-17 Rust disjunct was ALREADY dead code on this engine too (confirmed above, not assumed), a reviewer diffing `find_resolving_scope_node`'s two engines side by side for round 18 must confirm the REPLACEMENT logic — `is_malformed_using_initializer`, not a patched `using_declaration` check — appears on both, not merely that "the round-17 code was already identical on both engines, so nothing to check here"; identical dead code on both engines is still dead code on both engines, and case (av)/(aw), run under both, are what actually force the live replacement rather than a side-by-side read of code that never executes. Third, `literal_has_unmodeled_this_reference`'s new getter check: a port that tests for a `get` FIELD rather than an unfielded token child (plausible, since several OTHER node kinds this file inspects — `method_definition`'s own `name`/`parameters`/`body` among them — DO use fields) would compile against Rust's tree-sitter API (which does not error on a field name absent from a given node's schema, per this design's own `child_by_field_name` semantics) but silently never match anything, since `get`/`set` carry no field name in this grammar on either engine — case (ax), run under both engines, is what forces the token-child form rather than a plausible-looking field read. Fourth, `all_references_tracked`'s `method_definition` carve-out: a port that suppresses the ENTIRE `introduces_shadowed_binding` result for a `method_definition` node, rather than re-deriving only its two genuine sub-checks, would compile, pass case (ay) (the spurious name-collision shape), and silently BREAK correlation shape 20 (a method whose PARAMETER genuinely shadows the binding) — the same "fixing the wrong direction of the same bug" hazard a reviewer must rule out on both engines independently, since shape 20's own dual-engine run is what actually distinguishes "removed the false positive" from "removed shadow detection for this node kind entirely." Fifth, `is_global_object_qualified_write`'s `unwrap_parens` routing: a port that unwraps `object` inside the function but forgets the identical unwrap at `subtree_contains_reassignment_of`'s OWN call site would compile and pass the first half of case (az) (a single paren layer around just the global identifier) while still failing its second half (a paren layer around the WHOLE target, `(globalThis.run56) = …`, Greptile's own repro shape) — a reviewer must confirm BOTH the function's own two arms AND its one call site carry the fix on each engine, not infer the call site from the arms alone. Sixth, `all_references_tracked`'s var-alias boundary widening: a port that widens the boundary for EVERY alias unconditionally, not only a `var`-kind one, would compile and pass case (ba) (since widening for a `let`/`const` alias too is merely redundant there, never wrong) but would silently mask a hypothetical future regression in the `kind`-check itself, since no CURRENT fixture distinguishes "widened because `var`" from "widened unconditionally"; a reviewer must confirm the `kind` check gates the widening on both engines, not merely that case (ba)/correlation shape 22 pass. A port that computes the new boundary from the OUTER call's own position (the table's declaring scope) rather than from the ALIAS's own declaration position would compile and could pass or fail case (ba) unpredictably depending on incidental AST shape, rather than being correct by construction — a reviewer must confirm both engines walk upward from the alias's `variable_declarator`, not from the table's own node.
>
> **Parity risk specific to round 19 — three independent fixes, one of them a correction to a claim round 18's OWN parity-risk paragraph (immediately above) never made a claim about at all, because round 18 never touched this recursion.** First, the `__proto__` key check: a port that reads `key.text` without stripping quotes/backticks would silently never match the string-literal spelling (`"__proto__": …`), passing whichever of shape 23/case (bb)'s two spellings the port author happened to test and failing the other — a reviewer must confirm both the bare and string-literal spellings are exercised, on both engines, not merely that ONE compiles and passes. A port that omits the `key.type != "computed_property_name"` guard — plausible, since the guard's ENTIRE purpose is to exclude a shape that looks superficially similar — would compile and pass case (bb) (a non-computed key) but silently BREAK correlation shape 23 (the computed-key guard, proving `["__proto__"]: …` stays safe), the identical "fixing the wrong direction of the same bug" hazard round 18's own fourth risk names for a different function; shape 23's own dual-engine run is what actually distinguishes "escapes on the dangerous spelling only" from "escapes on any key merely containing the text `__proto__`." Second, the `all_references_tracked` node-type widening: a port that widens the filter to match on TEXT alone, regardless of node kind (e.g. any node with a `.utf8_text(source)` equal to `name`), rather than gating on `kind() == "identifier" || kind() == "shorthand_property_identifier"` specifically, would compile and pass case (bc) (the shorthand-reference gap) but would ALSO match a `property_identifier` object-literal KEY sharing the tracked name's spelling, silently over-escaping a legitimate neighbouring table the same way round 16's `is_global_object_qualified_write` guard (property-name-alone, no object-identity check) over-fired before that round's own fix — correlation shape 24 (an unrelated `pair` keyed by the same text) is what forces the node-KIND gate rather than a bare text comparison. Third, and the most structurally hazardous of the three: the for-of recursion's `var`-kind boundary widening is a SEPARATE code path from the rebinding recursion's OWN round-18 widening, sharing the same underlying `FUNCTION_SCOPE_NODE_TYPES`-walk-from-declaration-position helper but invoked from a DIFFERENT call site with a DIFFERENT starting node (the `for_in_statement` itself, not a `variable_declarator`) — a port that adds the `kind === "var"` check to the rebinding recursion's own call site a second time, reasoning "I already added this," while never touching the for-of recursion's own separate call site, would compile, pass every round-18 fixture (cases (ax)-(ba), shapes 19-22, untouched by this round), and silently leave case (bd)/shape 25 as the ONLY thing distinguishing "both recursions widened" from "one recursion widened twice" — a reviewer must confirm the widening helper is invoked from BOTH the rebinding recursion's call site AND the for-of recursion's call site, on each engine independently, not infer the second from the first the way round 18's own sixth risk warns against for a single-call-site fix.
>
> **Parity risk specific to round 20 — the first round whose OWN fixes were ablated before being written down, which changes what a reviewer must re-verify: not "does the fix work" (already executed) but "does the PORT preserve the exact granularity/shape the ablation was run against."** First, the backslash fail-safe: a port that checks `raw_key_text.contains('\\')` against the COOKED text (if some future refactor threads a cooked-text helper through this call site for an unrelated reason) rather than the RAW `utf8_text(source)` would silently stop matching the escaped spelling entirely, since a cooked string never itself contains a backslash — case (be), run under both engines, is what would catch this, but only if a reviewer confirms the check runs against the SAME raw-text source both engines already use for the adjacent stripped-text comparison, not a hypothetical future cooked one. Second, and the most structurally hazardous of this round's five: the `body`-field widening must be applied at BOTH the rebinding-alias and for-of-loop-variable call sites — a port that fixes one (most likely the alias one, since it is listed first in both the TS essay and this section) and leaves the other targeting the function node itself would compile, pass cases (be)/(bh)/(bi)/(bj) and shape 26 (none of which exercise the OTHER recursion's own granularity), and pass every round-18/19 fixture (neither recursion's pre-existing fixtures construct the colliding body-level declaration this bug needs) — only case (bg) (the for-of variant) or case (bf) (the alias variant), whichever call site was NOT fixed, would fail; a reviewer must confirm `child_by_field_name("body")` (or its TS equivalent) is read at BOTH call sites independently, not infer one from the other. Third, the `globalThis`-qualified-read recognition: a port that adds the new node-matching arm but treats a match as TRACKED (`continue`/`Ok(())`-equivalent) rather than as an unconditional escape would compile, and might even look correct on a superficial read ("we now recognise the reference, so treat it as found"), but would silently reintroduce the READ side of the exact under-escape #2640 named — case (bh), run under both engines, is what forces the classification to be "found AND untracked," not merely "found"; a reviewer must confirm the new arm never falls through to a `continue`/success path, on either engine. Fourth, the subscript-index unwrap (G1): a port that unwraps `index` but not through the SAME `unwrap_parens` already used for `object` (e.g. a hand-rolled single-layer peel) would compile and pass a single-paren case but silently diverge from the TS side's own recursive-unwrap semantics on a doubly-parenthesized index — case (bi) alone does not distinguish single- from double-parenthesization, so a reviewer must confirm the SAME shared helper is reused, not a narrower one written to make this one case pass. Fifth, the `call`/`apply`/`bind` rejection (UE-C): a port that checks the REFERENCE node's own text against these three strings, rather than the ENCLOSING member/subscript expression's `property` field, would compile and might accidentally pass case (bj) (where the table's own binding name is `T71`, never `call`/`apply`/`bind` itself) while rejecting every ordinary `T.call`-NAMED property read as a false structural match — a reviewer must confirm the check reads `parent.child_by_field_name("property")`, never `ref_node` itself.

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

**The correlation test** covers the twenty-five shapes the design claims (three from earlier rounds, two added in round 8 to close the testing blind spot described below, two added in round 9 for finding 1's over-escape check and finding 2's pass-ordering check, one added in round 15 to prove the var/Annex-B hoist-count fix's own `let`/`const` exclusion, four added in round 16 — one guard per that round's own four fixes, proving none of them over-escapes the legitimate neighbouring shape — six added in round 17, the identical discipline applied to that round's own five fixes (the `switch_body` and `for_statement` halves of the `using_declaration`-shadow fix each get their own guard, the redeclaration-count and write-scan halves of the `var`-kind for-of/for-in fix share one, and the Greptile-flagged `update_expression` consistency fix gets its own), and four added in round 18 for that round's own four fixes, one of them (the `allReferencesTracked` var-alias boundary widening) itself Greptile-flagged rather than an orchestrator finding — plus two of round 17's own six (the `with_statement` and `for_statement`/`using` guards) REBUILT rather than reused, since parsing them with the real grammar shows both were no-ops (see the Naming convention note for why their rebuilt versions assert `escapes = 1`, the sole exception to this test's own rule)), three added in round 19 — one guard per that round's own three fixes (the computed-`__proto__`-key guard, the tracked-`shorthand_property_identifier`-vs-untracked-`property_identifier`-key guard, and the `let`-kind-for-of-does-not-widen guard) — and one of round 17's own (shape 17, the `for_statement`/malformed-`using` guard) FURTHER REBUILT this round, since its round-18 rebuild, though no longer a no-op, still could not distinguish the disjunct's own contribution from an unrelated confound in the same fixture (see shape 17's own commentary for why), each asserted under **both** engines (`--engine wasm` and `--engine native`, skipped with an explicit message rather than silently if `isNativeAvailable()` is false — never a silent skip):

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

// 8. (ROUND 15, #2088 finding 1) A same-named `let` in a SIBLING block,
//    alongside an UNRELATED handler on the same table — proves the round-15
//    widening of findTopLevelFunctionNodeByName's count to include hoisted
//    var/Annex-B declarations does NOT also swallow a `let`/`const` in the
//    identical nested position, which is a genuinely DIFFERENT, block-scoped
//    binding, not a redeclaration. `run23`'s only top-level declaration is
//    the module-level `const run23 = () => {}`; the sibling `if` block's
//    `let run23` is a separate binding, never read, and must not be counted
//    toward the round-15 hoist total. `beta`'s value `fnBeta23` is what
//    proves the table's OWN escape classification, not just `run23`'s own
//    resolution: if the exclusion were missing, `run23`'s resolution would
//    fail safe, condition 4 would vote escaping for the WHOLE literal (a
//    single `true` fails the whole site), and `T23` would read `escapes = 1`
//    — see the load-bearing note below for why liveness alone cannot catch
//    this regression here.
function fnAlpha23() { return 1; }
function fnBeta23() { return 2; }
const run23 = () => {};
if (Math.random() < 0) {
  let run23 = function () { return this.neverReached(); };
}
const T23 = { alpha: fnAlpha23, beta: fnBeta23, run23 };
T23.beta();
T23.run23();
// EXPECT: fnBeta23 live via T1 (T23.beta() is T23's own tracked call);
// fnAlpha23 dead (nothing anywhere invokes `.alpha(`); escapes === 0 for
// T23's site.

// 9. (ROUND 16; STRENGTHENED ROUND 17 — a critic found the original version
//    of this shape never actually invoked the helper it names) An ordinary,
//    harmless `parenthesized_expression` elsewhere in the file, not used as
//    a write or loop-head target at all, PLUS a genuine parenthesized WRITE
//    to a DIFFERENT name — proves `unwrapParens` (new, round 16) is reached
//    only through the two write-scan/shadow call sites' own `left`-field
//    reads and does not misfire against an unrelated grouped expression
//    merely because one exists in the same file as a correlated table
//    (`scratch26`'s own parens, unchanged from round 16), AND (round 17)
//    that when `unwrapParens` is actually CALLED — on a real
//    `assignment_expression`'s `left`, not merely an ambient parenthesized
//    expression with no write role at all — the unwrapped identifier's own
//    name comparison still correctly rejects a name other than `run26`'s.
//    Pre-round-17, this shape's own code contained no assignment or for-in
//    `left` for `unwrapParens` to be invoked on at all: `scratch26`'s parens
//    sit inside an arithmetic/ternary expression, never a write target, so
//    the guard's own claimed mechanism was never actually exercised by it.
function fnAlpha26() { return 1; }
const run26 = () => {};                          // never reassigned, never shadowed
const scratch26 = (1 + 2) * (run26 ? 1 : 0);      // ordinary parens, not a write target
let other26 = 0;
(other26) = 1;                                    // parenthesized WRITE to a DIFFERENT name — actually reaches unwrapParens
const T26 = { alpha: fnAlpha26, run26 };
T26.run26();
// EXPECT: fnAlpha26 dead (nothing invokes `.alpha(`); escapes === 0 for
// T26's site.

// 10. (ROUND 16) A `using` declaration for a DIFFERENT name in the SAME
//     block a table's own handler is declared in — proves the new
//     `using_declaration` disjunct in `findResolvingScopeNode` is gated on
//     NAME, not merely on the presence of a `using` declaration in some
//     ancestor block: `run27`'s own resolution must not be affected by an
//     unrelated `using other27 = …` sharing its block.
function mk27() { return { [Symbol.dispose]() {} }; }
function fnAlpha27() { return 1; }
function run27() { return 0; }
function install27() {
  using other27 = mk27();                        // unrelated name, same block
  const T27 = { alpha: fnAlpha27, run27 };
  T27.run27();
}
install27();
// EXPECT: fnAlpha27 dead (nothing invokes `.alpha(`); escapes === 0 for
// T27's site.

// 11. (ROUND 16) A member-expression write to an ORDINARY (non-global)
//     object's OWN property sharing the table's handler name — proves
//     `isGlobalObjectQualifiedWrite` is gated on the object identifier
//     being one of the four recognised global-object aliases specifically,
//     not on `member_expression` writes in general: `obj28.run28 = …` must
//     not be mistaken for a reassignment of the module-level `run28`
//     binding merely because the property name matches.
function fnAlpha28() { return 1; }
const run28 = () => {};                            // never reassigned
const obj28 = {};
obj28.run28 = function () { return 'unrelated'; };  // writes a DIFFERENT binding entirely
const T28 = { alpha: fnAlpha28, run28 };
T28.run28();
// EXPECT: fnAlpha28 dead (nothing invokes `.alpha(`); escapes === 0 for
// T28's site.

// 12. (ROUND 16) A LONE top-level generator-function declaration — no
//     plain sibling, no redeclaration at all — proves the new
//     `generator_function_declaration` branch in
//     `findTopLevelFunctionNodeByName`'s direct-children loop still sets
//     `result` (not merely `declarationCount`) for the unambiguous case, so
//     a same-file generator handler correlates exactly as a plain function
//     declaration already does.
function fnAlpha29() { return 1; }
function* run29() { return 0; }                    // the ONLY declaration of `run29`
const T29 = { alpha: fnAlpha29, run29 };
T29.run29();
// EXPECT: fnAlpha29 dead (nothing invokes `.alpha(`); escapes === 0 for
// T29's site.

// 13. (ROUND 17) A `using` declaration for a DIFFERENT name in the SAME
//     switch clause a table's own handler is declared in — proves the new
//     `switch_body` disjunct in `findResolvingScopeNode` is gated on NAME,
//     not merely on the presence of a `using` declaration in some ancestor
//     switch clause: `run36`'s own resolution must not be affected by an
//     unrelated `using other36 = …` sharing its clause.
function mk36() { return { [Symbol.dispose]() {} }; }
function fnAlpha36() { return 1; }
function run36() { return 0; }
function install36() {
  switch (1) {
    case 1:
      using other36 = mk36();                    // unrelated name, same switch clause
      const T36 = { alpha: fnAlpha36, run36 };
      T36.run36();
  }
}
install36();
// EXPECT: fnAlpha36 dead (nothing invokes `.alpha(`); escapes === 0 for
// T36's site.

// 14. (ROUND 17) A sibling `let`-kind for-of loop reusing the SAME name as
//     a table's own handler — proves the new `kind?.text === 'var'` checks
//     in `countHoistedVarScopeDeclarations` and `subtreeContainsReassignmentOf`
//     do NOT also sweep up a `let`/`const`/`using` for-of head: those create
//     a genuinely NEW, loop-scoped binding, the shadow axis's own concern
//     (`findResolvingScopeNode`), never a redeclaration or reassignment of
//     the module-level `run37` this table actually reads.
function fnAlpha37() { return 1; }
const run37 = () => {};                              // never reassigned, never redeclared
for (const run37 of []) { /* empty: a fresh, loop-scoped binding, not a rebind of the outer one */ }
const T37 = { alpha: fnAlpha37, run37 };
T37.run37();
// EXPECT: fnAlpha37 dead (nothing invokes `.alpha(`); escapes === 0 for
// T37's site.

// 15. (ROUND 17) A bracket-subscript write to an ORDINARY (non-global)
//     object's OWN property sharing the table's handler name — proves the
//     new `subscript_expression` arm of `isGlobalObjectQualifiedWrite` is
//     gated on the object identifier being one of the four recognised
//     global-object aliases specifically, not on ANY bracket-subscript
//     write whose key happens to match `name`: `obj38['run38'] = …` must
//     not be mistaken for a reassignment of the module-level `run38`
//     binding merely because the property name matches.
function fnAlpha38() { return 1; }
const run38 = () => {};                              // never reassigned
const obj38 = {};
obj38['run38'] = function () { return 'unrelated'; }; // writes a DIFFERENT binding entirely
const T38 = { alpha: fnAlpha38, run38 };
T38.run38();
// EXPECT: fnAlpha38 dead (nothing invokes `.alpha(`); escapes === 0 for
// T38's site.

// 16. (ROUND 17, REBUILT ROUND 18) A `with (obj) { … }` block whose OWN
//     object has NO property matching the table's handler name — proves
//     the `with_statement` disjunct in `findResolvingScopeNode` is truly
//     UNCONDITIONAL, not a check that happens to pass whether or not it
//     exists. **The original round-17 fixture for this slot — "an ordinary
//     table with NO `with` statement anywhere" — was a no-op: it never put
//     a `with` block on the ancestor chain at all, so it passed identically
//     whether the disjunct existed, was deleted entirely, or was
//     accidentally gated behind a `name`-bearing test copied from a
//     neighbouring disjunct (the exact hazard WU-7's own round-17
//     parity-risk paragraph already names for this disjunct specifically).
//     A regression could not have failed this test; it was not testing
//     anything.** This shape replaces it: a `with` block DOES enclose the
//     table, and its own object (`deco47`) has no `run47` property
//     whatsoever — a name-aware check could, in principle, prove THIS
//     SPECIFIC `with` cannot shadow `run47` and let the site correlate, but
//     the disjunct this design ships takes no `name`-bearing condition at
//     all, so it fails safe here exactly as it does for case (au)'s
//     genuinely shadowing `with`. **This is, necessarily, an
//     `escapes === 1` outcome, not `escapes === 0`** — see the Naming
//     convention note below for why correlation shapes 16 and 17 are the
//     two deliberate exceptions to "every correlation shape asserts
//     `escapes = 0`."
function fnAlpha47() { return 1; }
function run47() { return 0; }                      // module-level, this-free
function install47() {
  const deco47 = { label: 'unrelated' };             // no `run47` property at all
  with (deco47) {
    const T47 = { alpha: fnAlpha47, run47 };          // shorthand: key and value both `run47`
    T47.run47();
  }
}
install47();
// EXPECT: fnAlpha47 LIVE (T47's site escapes and falls to T2's bare-name
// fallback); escapes === 1 for T47's site.

// 17. (ROUND 17, REBUILT ROUND 18) A malformed `using` initializer in a
//     C-style for-loop, for a DIFFERENT name than the table's own handler
//     — proves the `for_statement`/`isMalformedUsingInitializer` disjunct
//     in `findResolvingScopeNode` is, like `with_statement`'s, truly
//     UNCONDITIONAL: it fails safe on the mere PRESENCE of the malformed
//     shape, never on whether that shape's own (unparseable) name happens
//     to match the table's handler. **The original round-17 fixture for
//     this slot ("a `using` declaration for a DIFFERENT name … must not be
//     mistaken for a shadow of `run44` itself") was worse than a no-op: its
//     own `for (using other44 = mk44(); true; )` is exactly the SAME
//     grammar-invalid shape case (av) is built to demonstrate — parsing it
//     with the real grammar yields ZERO `using_declaration` nodes and ONE
//     `ERROR` node, so this fixture never exercised the disjunct it claimed
//     to guard at all; a buggy implementation (including no implementation)
//     would have passed it identically.** The round-18 rebuild replaced it
//     with this shape's own `run50`/`other50` construction — correctly
//     unconditional, no longer a no-op — but (ROUND 19 finding, found by
//     ablating the disjunct rather than by inspection alone) it was STILL
//     not clean: the round-18 fixture's `run50: disposable50` pair resolved
//     its handler to a `const` declared INSIDE `install50`, never at module
//     level, which makes `resolveIdentifierValueThisReference` fail safe on
//     its OWN, `for_statement`-disjunct-INDEPENDENT first principle (no
//     module-level declaration of `disposable50` exists for
//     `findTopLevelFunctionNodeByName` to resolve to at all — the identical
//     fail-safe path the Builder note above documents for a handler
//     "declared ONLY inside some nested function/block") — so ablating the
//     `for_statement`/malformed-`using` disjunct entirely left this shape's
//     own `escapes` UNCHANGED at `1`, proving nothing about the disjunct
//     specifically. **ROUND 19 rebuild: `run50`'s pair is now the bare
//     shorthand `run50`, resolving to the pre-existing module-level,
//     `this`-free `function run50()` above** — the SAME clean, unshadowed,
//     never-reassigned, singly-declared handler shape every OTHER
//     correlation shape in this suite already requires (Builder note,
//     above) — so the malformed-`using` disjunct is now the ONLY thing that
//     can make this site escape. Verified both ways: with the disjunct
//     present, `escapes` reads `1` (below); with it ablated (the disjunct's
//     own check removed, or the `for_statement`'s malformed child never
//     matched), `run50` resolves cleanly with nothing else in this fixture
//     to fail safe on, and `escapes` flips to `0` — the load-bearing flip
//     this shape exists to prove and its round-18 predecessor could not.
function mk50() { return { [Symbol.dispose]() {} }; }
function fnAlpha50() { return 1; }
function run50() { return 0; }                      // module-level, this-free — T50's ONLY handler
function install50() {
  for (using other50 = mk50(); true; ) {              // UNRELATED name, malformed init
    const T50 = { alpha: fnAlpha50, run50 };          // shorthand: resolves to the module-level run50 above
    T50.run50();
    break;
  }
}
install50();
// EXPECT: fnAlpha50 LIVE (T50's site escapes and falls to T2's bare-name
// fallback); escapes === 1 for T50's site — the disjunct fires regardless
// of the malformed clause's own (unresolvable) name, and (ROUND 19) is now
// the ONLY thing that can make this site escape: ablating it must flip
// `escapes` to `0`, since `run50` otherwise resolves cleanly.

// 18. (ROUND 17, Greptile) A parenthesized update (`(other46)++`) to a
//     DIFFERENT name elsewhere in the file — proves the new `unwrapParens`
//     routing in `subtreeContainsReassignmentOf`'s `update_expression`
//     branch is gated on NAME, exactly like its assignment/for-in siblings,
//     not merely on the presence of SOME parenthesized update anywhere:
//     `run46`'s own resolution must not be affected by an unrelated
//     `(other46)++` elsewhere in the file.
function fnAlpha46() { return 1; }
const run46 = () => {};                          // never reassigned, never shadowed
let other46 = 0;
(other46)++;                                     // parenthesized update to a DIFFERENT name
const T46 = { alpha: fnAlpha46, run46 };
T46.run46();
// EXPECT: fnAlpha46 dead (nothing invokes `.alpha(`); escapes === 0 for
// T46's site.

// 19. (ROUND 18; EXPECT CORRECTED ROUND 19) A getter property whose OWN
//     body is `this`-free but whose property NAME differs from any handler
//     this literal actually resolves via identifier-value/shorthand — this
//     shape's round-18 commentary claimed it proves the getter-escapes-
//     unconditionally rule "does not make the WHOLE site escape" and that
//     "each property is still judged on its own shape." **ROUND 19: that
//     claim was false, not merely imprecise — `literalHasUnmodeledThisReference`
//     is a WHOLE-LITERAL predicate, one `true` from ANY child fails
//     condition 4 for the entire object node, and this design's own
//     Success Criteria says so verbatim: "an entirely harmless getter...
//     now also makes ITS LITERAL escape."** A getter co-located with an
//     otherwise-safe, already-resolving identifier-valued handler does not
//     escape "as its own property" while `run51` stays "non-escaping as its
//     own property" — there is no per-property escapes bit, only a
//     per-SITE one, and the getter's mere presence anywhere in `T51` makes
//     THAT bit `1` for the whole site. What this shape actually shows,
//     correctly stated: the getter-escapes-unconditionally rule fires
//     exactly the same way whether the getter is the ONLY property under
//     test (case (ax), below) or co-located with siblings this design
//     already resolves cleanly — proving U2 is not accidentally bypassed,
//     short-circuited, or suppressed by an otherwise-safe neighbour, not
//     proving the neighbour survives independently (it cannot, and does
//     not need to: `run51` is still correctly LIVE, via `T51.run51()`
//     itself, exactly as it would be if the whole site fell to T2's
//     bare-name fallback for any other reason). The setter is declared
//     BEFORE the getter here (reordered from the round-18 original, which
//     put the getter first): tree-sitter's child-list order is the walk's
//     own iteration order, and a getter-first ordering would return `true`
//     the instant the getter is reached, leaving the setter's own,
//     genuinely `this`-free body — the round-18 commentary's OTHER claim —
//     entirely unexercised by the walk. Setter-first means the walk
//     actually visits the setter (finds it `this`-free, continues) BEFORE
//     reaching the getter and escaping, so both claims this shape makes are
//     ones the walk in fact demonstrates, not one live and one vestigial.
//     Ablating U2 (removing the getter's own unconditional-escape check, so
//     it falls back to `subtreeContainsThisKeyword` like a plain method)
//     must flip this shape's own `escapes` from `1` to `0`, since the
//     getter's own body (`return 'unrelated';`) contains no `this` token —
//     the load-bearing signature every round-19 fix is now held to.
function fnAlpha51() { return 1; }
function run51() { return 2; }                       // plain method value, this-free
let label51Store;
const T51 = {
  alpha: fnAlpha51,
  run51,
  set label51(v) { label51Store = v; },               // this-free setter body — visited, found safe, first
  get label51() { return 'unrelated'; },              // this-free getter — escapes UNCONDITIONALLY regardless (U2)
};
T51.run51();
// EXPECT: fnAlpha51 dead (nothing invokes `.alpha(`) — liveness alone does
// NOT distinguish this from the round-18 (wrong) expectation, which is
// exactly why the explicit `escapes` assertion is the one that matters
// here, per the round-3 rule above; escapes === 1 for T51's site — the
// co-located getter still makes the WHOLE site escape, regardless of its
// otherwise-safe siblings, per U2's own unconditional rule.

// 20. (ROUND 18) A NESTED method whose property NAME is DIFFERENT from the
//     table's own binding name — proves the new `method_definition`
//     name-field carve-out in `allReferencesTracked` is scoped to the
//     SPURIOUS case (name collision only) and does not disable the
//     GENUINE shadow cases the same primitive still must catch: a method
//     named the same as one of its OWN PARAMETERS, or hoisting a `var`
//     matching the table's name in its body, must still prune correctly.
function fnAlpha52() { return 1; }
const run52 = () => {};                               // never reassigned, never shadowed
const holder52 = {
  unrelatedMethod52(run52) {                          // parameter named run52 — GENUINE shadow
    return run52();                                   // refers to the PARAMETER, not the outer run52
  },
};
holder52.unrelatedMethod52(() => 'irrelevant');
const T52 = { alpha: fnAlpha52, run52 };
T52.run52();
// EXPECT: fnAlpha52 dead (nothing invokes `.alpha(`); escapes === 0 for
// T52's site — `unrelatedMethod52`'s own parameter shadow of `run52` is
// still correctly pruned; only the NAME-FIELD-ONLY match (case (ay) below)
// is exempted.

// 21. (ROUND 18) An ordinary object's own property write, parenthesized,
//     to a NON-global object — proves the `unwrapParens`-routed
//     `isGlobalObjectQualifiedWrite` still requires the (unwrapped) object
//     identifier to be one of the four recognised global-object aliases,
//     not merely an identifier of ANY kind: a parenthesized write to an
//     ordinary local object's own same-named property must not be mistaken
//     for a `globalThis`-qualified write merely because unwrapping now
//     happens before the identifier check.
function fnAlpha53() { return 1; }
const run53 = () => {};                               // never reassigned
const obj53 = {};
(obj53).run53 = function () { return 'unrelated'; };  // parenthesized write to a NON-global object
const T53 = { alpha: fnAlpha53, run53 };
T53.run53();
// EXPECT: fnAlpha53 dead (nothing invokes `.alpha(`); escapes === 0 for
// T53's site.

// 22. (ROUND 18, Greptile) A `var` alias of a table, with BOTH declared
//     directly in the SAME function body — no nested block between them —
//     proves the new var-alias boundary-widening in `allReferencesTracked`
//     is a no-op when the alias's nearest enclosing function already
//     equals the outer call's own `declaringScope`: adds no spurious
//     search area, and the site still correlates precisely (T1 exclusivity,
//     not merely liveness) exactly as an unaliased table already would.
function fnAlpha61() { return 1; }
function neverCalled61() { return 2; }
function install61() {
  const T61 = { alpha: fnAlpha61, beta: neverCalled61 };
  var u61 = T61;              // var alias, same function body — declaringScope already correct
  return u61.alpha();
}
install61();
// EXPECT: neverCalled61 dead (nothing invokes `.beta(`); fnAlpha61 live via
// T1 exclusively; escapes === 0 for T61's site.

// 23. (ROUND 19; REBUILT ROUND 20 — see below) A COMPUTED, ESCAPED `__proto__`
//     key — proves the `computed_property_name` exclusion in
//     `literalHasUnmodeledThisReference`'s `pair`-key check is scoped to the
//     special, non-computed spelling ECMA-262 Annex B.3.1 actually gives
//     magic meaning to, not to every pair whose key merely COOKS to
//     `__proto__`: `['__proto__']: { … }` (a computed key
//     whose own string literal cooks to exactly `__proto__`) creates an
//     ORDINARY own property, never touches `[[Prototype]]`, and must stay
//     non-escaping exactly like any other object-valued pair, regardless of
//     what its own text contains.
//
//     ROUND 20 (#2088, B3): round 19's original fixture here used the BARE,
//     non-escaped spelling, `['__proto__']: { … }` — its own raw text,
//     `['__proto__']`, retains the enclosing `[`/`]` brackets no matter what
//     is inside them (`.replace(/['"`]/g, '')` strips quotes/backticks only,
//     never brackets), so the stripped text can NEVER equal the bare string
//     `__proto__` for ANY computed key, with or without the
//     `key.type !== 'computed_property_name'` guard in place. Ablating that
//     guard against round 19's own check therefore left `escapes` unchanged
//     at `0` — the guard was UNREACHABLE, dead code, and this shape never
//     actually exercised it; round 19's own claim that "a bug that keyed on
//     the text `__proto__` alone, without also excluding
//     `computed_property_name`, would fail this one specifically" was FALSE,
//     not merely unverified — confirmed by executing exactly that ablation.
//     Rebuilt using an ESCAPED computed key instead, which discriminates for
//     a DIFFERENT reason tied to round 20's own backslash fail-safe (see
//     `literalHasUnmodeledThisReference`'s round-20 doc comment): this key's
//     raw text, `['\u005f\u005fproto\u005f\u005f']`, contains a backslash,
//     so an implementation that applied the backslash check WITHOUT the
//     `computed_property_name` exclusion would wrongly escape here, while
//     the correct implementation (exclusion present) does not — the guard is
//     load-bearing again, just for the round-20 check, not the round-19 one
//     the original fixture (wrongly) claimed to guard. Verified runnable,
//     confirming the ESCAPED computed spelling is exactly as inert as the
//     bare one: `Object.getOwnPropertyNames(T62)` includes `'__proto__'` as
//     an ordinary own key, and `T62.go` is `undefined`.
function fnAlpha62() { return 1; }
function run62() { return 2; }                        // plain method value, this-free
const T62 = {
  alpha: fnAlpha62,
  run62,
  ['\u005f\u005fproto\u005f\u005f']: { go() { return 'unrelated'; } },    // COMPUTED + ESCAPED — still an ordinary own key
};
T62.run62();
// EXPECT: fnAlpha62 dead (nothing invokes `.alpha(`); escapes === 0 for
// T62's site — neither the computed spelling nor the escape sequence inside
// it trips the `__proto__` check.

// 24. (ROUND 19) An UNRELATED object literal's own property KEY sharing the
//     tracked table's binding NAME — proves the widened
//     `allReferencesTracked` node-type filter (round 19) matches on
//     `identifier`/`shorthand_property_identifier` specifically, never on a
//     `pair`'s own `key` field (a `property_identifier`, a distinct node
//     kind carrying no value-producing reference at all): `decoy63`'s own
//     `T63: 'unrelated'` key must not be mistaken for a reference to the
//     `T63` binding merely because the two are spelled alike.
function fnAlpha63() { return 1; }
function run63() { return 2; }                        // plain method value, this-free
const T63 = { alpha: fnAlpha63, run63 };
const decoy63 = { T63: 'unrelated' };                 // KEY named `T63` — not a reference to the T63 binding
T63.run63();
// EXPECT: fnAlpha63 dead (nothing invokes `.alpha(`); escapes === 0 for
// T63's site — `decoy63`'s own key does not count as a reference to `T63`.

// 25. (ROUND 19; REBUILT ROUND 20 — see below) A `let`-kind for-of loop
//     variable, with an UNRELATED, later, wider-scoped binding of the
//     identical name — proves the `var`-kind boundary-widening in the for-of
//     recursion is gated on `kind === 'var'` specifically, not applied
//     unconditionally: a `let`-kind loop variable keeps its un-widened,
//     block-scoped boundary, so the walk for `r64` never reaches — and is
//     never confused by — the unrelated, sibling `r64` declared outside the
//     loop's own block.
//
//     ROUND 20 (#2088, B4): this shape was VACUOUS under the pre-round-20
//     widening target — ablating the `kind === 'var'` gate (forcing the
//     widening to apply unconditionally, even to this shape's own `let`-kind
//     loop variable) still read `escapes === 0`, the SAME as the correct,
//     gated answer, so the ablation proved nothing about the gate
//     specifically. Cause: unconditional widening (pre-round-20) resolves
//     `r64`'s boundary to `install64` ITSELF (not its `body`); the walk then
//     descends into `install64`'s own body and self-shadow-prunes it,
//     because the walk's declaringScope-exemption covers `install64` but
//     not its distinct `body` child — pruning the WHOLE body hides the
//     unrelated `const r64 = 5`/`sink64(r64)` statements this shape exists
//     to expose, and the vacuously-exhausted walk reads `escapes === 0`
//     regardless of whether the gate fired — the SAME root cause as the
//     rebinding recursion's own B2 bug, one binding over (see
//     `allReferencesTracked`'s round-20 essay on the for-of recursion).
//     Fixing that root cause (widen to the enclosing function's `body`, not
//     the function node) is what makes this shape non-vacuous: post-fix,
//     ablating the gate now correctly flips `escapes` from `0` to `1`,
//     because the walk reaches `install64`'s own body directly (exempt, per
//     the SAME single mechanism every other `declaringScope` already
//     relies on) and correctly finds the unrelated `r64`'s own declaration
//     and `sink64(r64)` as disqualifying references. No change to this
//     shape's own JS source was needed or made — only the underlying
//     widening logic the shape was always meant to guard.
function fnAlpha64() { return 1; }
function sink64(x) { return x; }                      // untracked position: a bare-identifier argument
function install64() {
  if (true) {
    const A64 = [{ alpha: fnAlpha64 }];
    for (let r64 of A64) { /* empty: r64 has no reference outside this block */ }
  }
  const r64 = 5;                                       // a DIFFERENT, unrelated `r64` — sibling scope
  sink64(r64);                                          // references the UNRELATED r64, not the loop variable
}
install64();
// EXPECT: fnAlpha64 dead (nothing invokes `.alpha(`); escapes === 0 for
// A64's site — a `var`-only widening must not reach far enough to
// misclassify the unrelated, wider-scoped `r64` as the loop variable's own
// reference; an unconditional widening would (wrongly) make this escape.

// 26. (ROUND 20, #2640/B5) An UNRELATED object's own property, spelled with
//     the identical name as the tracked binding, accessed through a
//     DIFFERENT object identifier that is not one of the four recognised
//     global-object aliases — proves the new `globalThis`-qualified-read
//     recognition inside `allReferencesTracked`'s own walk requires the
//     (unwrapped) object identifier to actually be one of
//     `GLOBAL_OBJECT_NAMES`, not merely that SOME member expression's own
//     property text happens to match the binding's name.
function fnAlpha65() { return 1; }
function run65() { return 2; }                        // plain method value, this-free
const T65 = { alpha: fnAlpha65, run65 };
const unrelatedObj65 = { T65: () => 'unrelated' };    // an ORDINARY object, own property named `T65`
function sink65() { return unrelatedObj65.T65(); }    // NOT a globalThis-qualified reference to T65
sink65();
T65.run65();
// EXPECT: fnAlpha65 dead (nothing invokes `.alpha(`); escapes === 0 for
// T65's site — `unrelatedObj65.T65` must not be mistaken for a
// `globalThis`-qualified read of the `T65` binding merely because the
// property text matches.
```

> **Each case must also assert `escapes = 0`** for its site (`SELECT escapes FROM object_literal_sites WHERE file = ? AND site = ?`), not just the liveness outcome shown above (round-3 critic finding). Liveness alone does not prove T1 fired: if a site were wrongly classified escaping, T2's bare-name fallback would report the same property live for an unrelated reason, and the test would pass while silently losing coverage of the tier it claims to exercise — symmetric to how the escape-fallback test below asserts `escapes = 1` rather than trusting liveness alone. Case 3 (alias) is the load-bearing one: it is exactly the shape WU-2's `variable_declarator` handling in `allReferencesTracked` (condition 3 above) must classify non-escaping, and a regression there would otherwise pass this test unnoticed. Cases 4 and 5 (round 8) are equally load-bearing for finding 1 specifically: without the declaring-scope exemption, BOTH would (wrongly, per the withdrawn round-7 argument) still read as `escapes = 0` today for the SAME reason the headline counter-example does — a vacuous walk, not a genuine one — so passing this assertion alone does not yet distinguish "the walk is exhaustive and found nothing disqualifying" from "the walk never looked." That distinction is exactly what escape-fallback case (o) below is for: it is cases 4/5's photographic negative, using the SAME function-scope shape but with a reference the fix must NOT accept. Case 6 (round 9) is the equivalent load-bearing check for finding 1's OTHER direction — over-escaping rather than under-escaping — and case 7 (round 9) must additionally assert `escapes = 0` for BOTH files' sites independently, since a pass-ordering bug that resolves one file's calls against the other's map could plausibly leave one of the two sites falsely `escapes = 1` while the other stays `0`, which liveness alone (both `fnA5` and `fnB5` might still end up "live" via T2's bare-name coincidence) would not by itself reveal. Case 8 (round 15) is load-bearing for a reason unique among these eight shapes: without the `lexical_declaration` exclusion in `countHoistedVarScopeDeclarations`, `run23`'s sibling-block `let` would be wrongly counted toward the hoist total, `findTopLevelFunctionNodeByName` would fail safe, condition 4 would vote escaping for the WHOLE literal, and `T23`'s site would (wrongly) read `escapes = 1` — but the LIVENESS outcome would not change at all: `fnBeta23` would still read live via T2's own bare-name match on `T23.beta()` itself (the very call this shape already makes), and `fnAlpha23` would still read dead, since nothing anywhere calls `.alpha(` regardless of which tier resolves it. Liveness alone is structurally incapable of distinguishing the correct `escapes = 0` outcome from this regression here; only the explicit `escapes = 0` assertion can. **Cases 9–12 (round 16) are each a guard for one of round 16's four fixes, proving the opposite direction from the escape-fallback list's own new cases (al)–(aq) below: that the fix does not OVER-escape a legitimate neighbouring shape.** Case 9 guards `unwrapParens`: an unrelated, ordinary grouped expression elsewhere in the file must not perturb `run26`'s own correlation. Case 10 guards the `using_declaration` disjunct: a `using` declaration for a DIFFERENT name sharing `run27`'s own block must not be mistaken for a shadow of `run27` itself — a bug that checked ANY `using_declaration` in an ancestor block, rather than one that actually binds `name`, would pass every escape-fallback case but fail this one specifically. Case 11 guards `isGlobalObjectQualifiedWrite`: an ordinary object's own `.run28` property write must not be mistaken for a `globalThis`-qualified write merely because the property name matches — a bug that matched on property name alone, without checking the object identifier against the four recognised aliases, would pass every escape-fallback case but fail this one. Case 12 guards the `generator_function_declaration` branch: a LONE top-level generator must still set `result`, not merely increment `declarationCount` — a bug that counted a generator without also assigning `result` to it (mirroring `countHoistedVarScopeDeclarations`'s own no-`result`-variable shape rather than `function_declaration`'s) would silently fail safe on this single, unambiguous case, the identical class of regression case 8's own guard proves does not recur for the `let`/`const` exclusion. **Cases 13–16 (round 17) apply the identical discipline to that round's own three fixes.** Case 13 guards the new `switch_body` disjunct: a `using` declaration for a DIFFERENT name sharing `run36`'s own switch clause must not be mistaken for a shadow of `run36` itself — the switch-clause counterpart of case 10's `statement_block` guard. Case 14 guards BOTH halves of the `var`-kind for-of/for-in fix at once: a sibling `let`-kind for-of loop reusing `run37`'s own name must not be swept up by the new `kind?.text === 'var'` checks in either `countHoistedVarScopeDeclarations` or `subtreeContainsReassignmentOf` — a bug that tested for the PRESENCE of a `kind` field rather than specifically its `'var'` text (e.g. reverting to the pre-round-13 unconditional-shadow treatment, or gating on "any kind" instead of "no kind or `var`") would pass every escape-fallback case but fail this one specifically, proving the exclusion holds rather than merely stating it, the same discipline case 8 already established for the sibling block-hoisting exclusion. Case 15 guards `isGlobalObjectQualifiedWrite`'s new `subscript_expression` arm: an ordinary object's own bracket-subscript `['run38']` write must not be mistaken for a `globalThis`-qualified write merely because the property name matches — the bracket-spelling counterpart of case 11's dot-spelling guard. **Cases 16 and 17, ROUND 17's ORIGINALS, were no-ops — REBUILT round 18 (see the Naming convention note below for why their assertions now read `escapes = 1`, the one exception to this paragraph's own opening rule).** Round 17's case 16 ("an ordinary table in a file with no `with` statement anywhere") never put a `with` block on the table's ancestor chain at all, so it passed identically whether the `with_statement` disjunct existed, was deleted, or was accidentally gated behind a copied `name`-bearing test — a regression could not have failed it. Round 17's case 17 ("a `using` declaration for a DIFFERENT name in a C-style for-loop's own init clause") was worse: its own for-loop init, `using other44 = mk44()`, is grammar-invalid in that position (round 18 finding, see `findResolvingScopeNode`'s own doc comment) and parses to zero `using_declaration` nodes and one `ERROR` node — it never exercised the code path it claimed to guard either. Rebuilt case 16 now guards the `with_statement` disjunct's actual unconditionality: a `with` block DOES enclose the table, over an object (`deco47`) with NO property matching the handler name at all — proving the disjunct fires on the ancestor's mere presence, never on whether that specific `with`-object could plausibly shadow anything. Rebuilt case 17 does the same for the (corrected) `for_statement`/malformed-`using` disjunct: the malformed clause names something OTHER than the table's own handler (`other50`, not `run50`) — proving this disjunct, too, cannot be satisfied by a copied name-bearing guard, since it takes no `name` parameter to copy one against in the first place. Case 18 guards the `update_expression` branch's own new `unwrapParens` routing (the Greptile-flagged consistency fix, which — unlike every other round-17 fix — has no accompanying escape-fallback case, since an update expression's own `ToNumeric` coercion means no construction through it alone can ever reassign a handler to a `this`-using value; see that fix's own doc comment): a parenthesized update to a DIFFERENT name must not perturb `run46`'s own correlation, the update-expression counterpart of case 9's assignment-expression guard. **Cases 19–21 (round 18) apply the same discipline to that round's own three fixes, this time back on the `escapes = 0` side.** Case 19 guards the getter-escapes-unconditionally rule: a `this`-free getter, co-located with a `this`-free setter of the same accessor pair and an ordinary, already-resolving identifier-valued handler in the SAME literal, still makes the WHOLE site escape — since `literalHasUnmodeledThisReference` is a whole-literal predicate, not a per-property one (ROUND 19 correction: this case's own pre-round-19 EXPECT and commentary claimed the opposite, that the getter's presence does NOT perturb the site; that claim contradicted this design's own Success Criteria and is corrected — see the shape's own rebuilt commentary). Case 20 guards the `allReferencesTracked` `method_definition` carve-out: a NESTED method whose own PARAMETER (not its property name) genuinely shadows the table's binding must still be pruned correctly — proving the carve-out removes only the spurious name-field match, not the primitive's genuine parameter/hoisted-`var` shadow detection for that same node kind. Case 21 guards `isGlobalObjectQualifiedWrite`'s `unwrapParens` routing: a parenthesized write to an ORDINARY (non-global) object's own same-named property must not be mistaken for a `globalThis`-qualified write merely because unwrapping now happens before the identifier/allow-list check — the paren-layer counterpart of case 11's plain-identifier guard. Case 22 guards `allReferencesTracked`'s new `var`-alias boundary-widening (Greptile-flagged, not a WU-2b/orchestrator finding — see that essay's own doc comment): a `var` alias declared in the SAME function body as the table itself, with no narrower block between them, must correlate exactly as before, proving the widening is a no-op precisely when no widening is needed. **Cases 23–25 (round 19; corrected round 20) apply the identical discipline to that round's own three fixes — ROUND 20 found cases 23 and 25 did not actually hold up to it.** Case 23 guards the non-computed-`__proto__`-key check's `computed_property_name` exclusion: a COMPUTED key, which Annex B.3.1 does not give prototype-setting meaning to regardless of what it cooks to, must correlate exactly as any other object-valued pair. **Round 19's own original fixture here (a bare, non-escaped `['__proto__']` key) was VACUOUS: a computed key's raw text always retains its enclosing brackets, so the stripped-text comparison can never equal `__proto__` for ANY computed key whether or not the exclusion exists, and ablating the exclusion left `escapes` unchanged — round 19's own claim that a bug omitting the exclusion "would fail this one specifically" was executed and found false.** Rebuilt (round 20) using an ESCAPED computed `__proto__` spelling instead, which correctly discriminates for the round-20 backslash fail-safe specifically: the exclusion is what keeps that new check from wrongly firing on a computed key whose own inner text happens to contain a backslash — see shape 23's own rebuilt commentary and `literalHasUnmodeledThisReference`'s round-20 doc comment. Case 24 guards the `allReferencesTracked` node-type widening: an unrelated object literal's own `property_identifier` key sharing the tracked binding's spelling must not be mistaken for a reference to it — a bug that matched on TEXT alone, without also gating on node KIND (`identifier`/`shorthand_property_identifier` only), would pass every escape-fallback case but fail this one specifically, the identical "text match alone is not enough" hazard round 16's own `isGlobalObjectQualifiedWrite` guards (cases 11/15) already establish for a different pair of functions — re-verified round 20 and unaffected by this round's fixes. Case 25 guards the for-of recursion's `var`-kind boundary-widening: a `let`-kind loop variable, with an unrelated, wider-scoped binding of the identical name declared outside its own block, must keep its un-widened boundary and must not be confused by that unrelated binding. **Round 19's own original widening target (the enclosing function-shape node itself, not its `body`) made THIS shape vacuous too: ablating the `kind === 'var'` gate landed the (wrongly) unconditionally-widened boundary on `install64`, whose own body was then self-shadow-pruned by its unrelated `const r64 = 5` — the SAME root cause as B2, masking the ablation rather than revealing it.** Fixing that root cause (round 20 — widen to the enclosing function's own `body`, never the function node) is what makes this shape's own ablation discriminate correctly; no change to the shape's own JS source was needed. See `allReferencesTracked`'s round-20 essay on the for-of recursion, and shape 25's own rebuilt commentary, for the full argument. **Case 26 (round 20) guards the new `globalThis`-qualified-read recognition (#2640/B5): an ordinary, non-global object's own same-named property (`unrelatedObj.T`) must not be mistaken for a `globalThis.T` reference merely because both are member expressions whose property text matches the tracked binding's name — the identical "structural shape alone is not enough, the object identifier must also be checked" hazard cases 11/15 and 24 already establish, for a fourth function.** A bug that recognized any `<expr>.T`/`<expr>['T']` member/subscript regardless of what `<expr>` is, rather than requiring it to be one of the four `GLOBAL_OBJECT_NAMES` identifiers, would pass every escape-fallback case but wrongly make this shape's table escape too.
>
> **Case 2 re-verified against round 7's tightened rules.** `RESOLVERS` is an array-element owner (`isArrayOwner = true`), so its own reference — the for-of head in `for (const r of RESOLVERS) …` — is checked on the `for_in_statement` branch, which does not gate on `isArrayOwner` at all (only the member/subscript branch does, per finding 1). Accepting that reference now additionally requires `allReferencesTracked(root, 'r', objectNode, false, declaringScope)` to hold (finding 2) — `declaringScope` being the SAME fixed node established for `RESOLVERS` itself (round 8, #2088 finding 1; `RESOLVERS` is module-scope here, so that node is `root`): `r`'s only two references, `r.matches(x)` and `r.resolve(x)`, are both call-position member expressions checked with `isArrayOwner = false` (a loop variable always denotes a single element), so both pass unchanged. This shape was the plan's own headline #1771 idiom and is confirmed unaffected by round 7 or round 8 — the array-owned shape round 7 actually excludes is the CONTAINER-level `.forEach`/`.map`/etc. call, added as new case (i) below, which this correlation test does not and should not exercise; round 8's declaring-scope restriction changes nothing here either, since `RESOLVERS`' own declaring scope was already `root` (module scope was never affected by the bug it fixes).

> **Builder note (round 10) — an IMPORTED handler makes condition 4 fail safe, which fails these shapes' own `escapes = 0` assertion outright, not merely "passes without proving T1."** Shapes 1, 3, and 6 each carry at least one identifier-valued handler property (`resolve: neverCalled`/`reject: isCalled`; `alpha: fnA`; `resolve: isBaz`) that condition 4 must positively resolve to a same-file, `this`-free function for the site to read `escapes = 0` at all — and, on inspection, this requirement is not unique to 1/3/6: EVERY one of these twenty-six shapes EXCEPT 16 and 17 (2, 4, 5, 7, and 8 included) uses at least one identifier-valued pair for the same reason, each needing to resolve past its own guard condition for the site to read `escapes = 0`; shapes 16 and 17 are the two deliberate exceptions (their handler resolves past the guard condition too, but the SITE is still expected to read `escapes = 1` regardless, per their own rebuilt commentary above and the Naming convention note below) — shape 8 (round 15) specifically needs `run23` to resolve past its own sibling-block `let` shadow without tripping the widened duplicate-declaration count, shapes 9–12 (round 16) each specifically need their own `run26`/`run27`/`run28`/`run29` to resolve past the exact guard condition each one exercises, and shapes 13–18 (round 17, 16 REBUILT round 18, 17 REBUILT round 18 AND AGAIN round 19) likewise each need their own `run36`/`run37`/`run38`/`run47`/`run50`/`run46` to resolve past that round's own guard condition (shapes 16 and 17 are the two exceptions — see the Naming convention note below — needing their handler to resolve past the guard's own `escapes = 1` outcome instead; shape 17's own handler is `run50`, not the round-18 fixture's own `disposable50` — see shape 17's own commentary for why that confound was removed in round 19), shapes 19–22 (round 18) likewise each need their own `run51`/`run52`/`run53`/`fnAlpha61` to resolve past THAT round's own guard condition, and shapes 23–25 (round 19, corrected round 20 — see each shape's own commentary) likewise each need their own `run62`/`run63`/`fnAlpha64` to resolve past round 19's own guard condition unchanged by round 20's own fixes (neither B3 nor B4 touches handler resolution — only the key-check and the widening target), and shape 26 (round 20) likewise needs its own `run65` to resolve past the new `globalThis`-qualified-read guard's own condition. `resolveIdentifierValueThisReference`'s first check is `definitionNames.has(name)` — this is a FILE-WIDE, flat set (built the same way `points-to.ts` builds its own from `symbols.definitions`), so it is true for a same-file declaration at ANY depth, but false for anything imported. An IMPORTED handler (`import { neverCalled } from './handlers.js'`) therefore fails this very first check and returns `true` (fail-safe) — and because condition 4 is a WHOLE-SITE check (one `true` from any child fails the whole literal), THIS SITE's `escapes` flips to `1`, directly contradicting the shape's own required `escapes === 0` assertion (the round-3 rule, above) — a hard, loud test failure, not a silent pass. The same fate befalls a handler that is same-file but declared ONLY inside some nested function/block: `definitionNames.has(name)` still passes (the set is flat, not scope-aware), but `findTopLevelFunctionNodeByName`'s own module-level-only search then fails to find it, hitting the identical fail-safe. **The correct fix, if this friction is hit while implementing WU-10, is to make every correlation-shape handler a genuine same-file, TOP-LEVEL (module-scope) declaration or `const` arrow/function-expression — never an import, never nested-only — not to weaken or drop the shape's own `escapes = 0` assertion to make the failure go away.** Dropping that assertion is exactly how a fixture could end up "passing" while proving nothing about T1: liveness alone can still be explained by an unrelated T2 match (shape 1's own decoy is a standing example of that risk), which is precisely why the round-3 rule requires checking `escapes` explicitly for every shape in the first place.

**Naming convention:** the correlation test's twenty-six shapes (used by their numbers, 1–26 — eight through round 15, four more, 9–12, added round 16 as guards for that round's own four fixes, six more, 13–18, added round 17 as guards for that round's own five fixes, four more, 19–22, added round 18 as guards for that round's own four fixes (U2/U3/U4 and the Greptile-flagged var-alias boundary widening, below), three more, 23–25, added round 19 as guards for that round's own three fixes (23 and 25 REBUILT round 20 — see their own commentary above for why the round-19 originals were vacuous), and one more, 26, added round 20 as a guard for the new `globalThis`-qualified-read recognition (#2640/B5) — throughout this plan) and the escape-fallback test's shapes ((a)–(z), then, round 11, (aa)–(ac), then, round 12, (ad), then, round 13, (ae), then, round 14, (af)–(ai), then, round 15, (aj)–(ak), then, round 16, (al)–(aq), then, round 17, (ar)–(av), then, round 18, (aw)–(ba), then, round 19, (bb)–(bd), then, round 20, (be)–(bj) — spreadsheet-style continuation rather than renumbering, so every existing cross-reference to a lettered case stays valid — used by their letters) are two independent, alphabetically/numerically-keyed lists — a re-verified shape 2 above is unrelated to the lettered cases below. **Round 17's sixth fix (the `update_expression` consistency fix, Greptile-flagged) is the only one of this plan's history to gain a correlation-shape guard (18) with no matching escape-fallback case** — see that fix's own doc comment for why no soundness repro exists to fixture. **Round 20's sixth fix (UE-C, non-blocking) is the second: case (bj) alone guards `isTrackedReferencePosition`'s new `call`/`apply`/`bind` rejection, with no correlation-shape counterpart, since every existing correlation shape already exercises an ordinary, non-reflective member call and none would be perturbed by narrowing this one shape further.**

**Standing rule, restated (ROUND 20).** Round 19 itself added the ablation-verification standing rule (Success Criteria, below) — every fix must be shown load-bearing by ablation, and a fixture that still passes with its own fix removed proves nothing and must be rebuilt — but did not apply it to its own two new fixtures needing it most, shapes 23 and 25 (see their own round-20 corrections above). Round 20 applies it to every fix in this round (B1–B5, and the two non-blocking fixes, G1 and UE-C) before ever proposing a fixture, per the process this round was itself run under, and additionally re-applies it retroactively to the two round-19 shapes that needed it and did not have it.

**ROUND 18 exception — correlation shapes 16 and 17 assert `escapes === 1`, not `escapes === 0`, and are the only two shapes in this numbered list that do.** Every OTHER correlation shape proves a fix does not perturb an otherwise-safe table (the round-3 rule, above, requiring `escapes = 0`). Shapes 16 and 17 exist for a narrower, different purpose specific to the two UNCONDITIONAL disjuncts on `findResolvingScopeNode` (`with_statement` and, as of round 18, the malformed-`using` `for_statement` check): proving those disjuncts fire regardless of whether the specific ancestor COULD plausibly shadow the name being resolved, since neither disjunct takes a `name`-bearing condition at all. Because they take no such condition, the only fixture that actually exercises "does this disjunct discriminate on name" is one where discrimination is IMPOSSIBLE even in principle (a `with`-object provably lacking the property; a malformed `using` clause naming something else entirely) — and the correct, intended outcome for such a fixture is that the table still escapes. The round-17 originals in this slot asserted `escapes = 0` against fixtures that never put the disjunct's own ancestor node on the table's chain at all, which is precisely why they were no-ops (see each shape's own commentary, above) — the round-18 rebuild fixes the VACUOUSNESS, and fixing it requires flipping the assertion, not merely changing the source. No other correlation shape needs this treatment: every other disjunct in this chain (`for_in_statement`, `arrow_function`/`parameter`, `statement_block`/`using_declaration`, `switch_body`/`using_declaration`) IS gated on `name`, so a same-shape-different-name fixture for those legitimately proves non-interference at `escapes = 0`, exactly as shapes 10/13 (among others) already do. **ROUND 19 — shape 17 needed a SECOND rebuild, for a reason orthogonal to this one.** This round-18 rebuild fixed shape 17's VACUOUSNESS (the round-17 original never exercised the disjunct at all); it did not fix a second, independent problem the rebuild happened to introduce: the round-18 fixture's OTHER property, `run50: disposable50`, resolved its handler to a scope-local `const`, which fails `resolveIdentifierValueThisReference` on its own, disjunct-independent first principle (no module-level declaration to resolve to at all) — so ablating the `for_statement`/malformed-`using` disjunct left this shape's own `escapes` unchanged at `1` regardless, proving nothing about the disjunct specifically, the identical "passes regardless of whether the fix exists" failure this whole section exists to rule out, just from a different cause than round 17's own no-op. Round 19 rebuilds shape 17 a second time, giving `run50` a clean, module-level resolution so the disjunct is the ONLY remaining thing that can make the site escape — see shape 17's own commentary. Shape 16 was independently re-checked for the identical class of confound and does not have it: `run47` already resolves via shorthand to a clean, module-level, `this`-free function with nothing else in that fixture able to fail safe on its own.

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
// (ae) (ROUND 13, #2088 finding 1) A REASSIGNED `let`-bound arrow — the
//      module-level declaration `findTopLevelFunctionNodeByName` resolves
//      to is itself genuinely `this`-free (an arrow function), but it is
//      NOT the value in effect at `T18`'s own construction: `run18` is
//      reassigned, as a plain top-level statement, to a `this`-using
//      function expression before `T18` is ever built. Pre-round-13,
//      neither `findResolvingScopeNode` (no shadowing scope exists here —
//      `run18` is reassigned, not redeclared, so there is nothing for the
//      shadow walk to find) nor `findTopLevelFunctionNodeByName` (which
//      deliberately accepts a mutable `let`/`var` binding, not just
//      `const`) asks whether the resolved declaration is ever WRITTEN to
//      after its own initializer — so condition 4 read the arrow's
//      (`() => {}`) own trivially `this`-free body, voted safe, and
//      `fnAlpha18` was reported dead though `T18.run18()` invokes it on
//      every call via the REASSIGNED, `this`-using function. This is also
//      a regression against today: `collectInvokedPropertyNames` credits
//      any non-empty receiver, so `fnAlpha18` is currently (pre-#2088)
//      live. No decoy needed: the reassigned function's own `this.alpha()`
//      call populates T2 once the site correctly escapes, the same way
//      case (v)'s inner `run`/`run2` do.
function fnAlpha18() { return 1; }
let run18 = () => {};                             // module-level arrow — looks safe
run18 = function () { return this.alpha(); };     // reassigned before T18 is built
const T18 = { alpha: fnAlpha18, run18 };          // shorthand: key and value both `run18`
T18.run18();
// EXPECT (all): live, escapes === 1.
// (af) (ROUND 14, #2088 finding 1) An ARRAY-DESTRUCTURING reassignment
//      target — the SAME underlying shape as case (ae), reached through a
//      write `subtreeContainsReassignmentOf`'s pre-round-14 assignment
//      branch could not see at all: `left` here is an `array_pattern`, never
//      `identifier`, so the bare `left?.type === 'identifier'` test never
//      matched regardless of what name the pattern bound. Greptile flagged
//      exactly this shape against this plan ("Destructuring writes bypass
//      reassignment tracking"). Fixed by routing the assignment branch
//      through `patternBindsName(left, name)` — the same primitive the
//      for_in_statement branch immediately below it already used for this
//      identical question. No decoy needed: the reassigned function's own
//      `this.alpha()` call populates T2 once the site correctly escapes, the
//      same way case (ae)'s does.
function fnAlpha19() { return 1; }
let run19 = () => {};                              // module-level arrow — looks safe
[run19] = [function () { return this.alpha(); }];  // destructuring reassignment
const T19 = { alpha: fnAlpha19, run19 };           // shorthand: key and value both `run19`
T19.run19();
// (ag) (ROUND 14, #2088 finding 1) An OBJECT-DESTRUCTURING reassignment
//      target — the SAME gap as (af), a different pattern shape: `left` is
//      an `object_pattern` wrapping a `shorthand_property_identifier_pattern`
//      for `run20`, which the pre-round-14 bare-identifier test also could
//      not see. Proves the fix is pattern-shape-general, not merely
//      array-pattern-specific — together (af)/(ag) exercise `patternBindsName`'s
//      own `array_pattern` and `object_pattern` cases
//      (`src/extractors/javascript.ts:4861-4909`), the same two shapes its
//      own doc comment names as motivating cases. No decoy needed, same
//      reason as (af).
function fnAlpha20() { return 1; }
let run20 = () => {};                                         // module-level arrow — looks safe
({ run20 } = { run20: function () { return this.alpha(); } }); // destructuring reassignment
const T20 = { alpha: fnAlpha20, run20 };                       // shorthand: key and value both `run20`
T20.run20();
// (ah) (ROUND 14, #2088 finding 2) A DUPLICATE top-level `var` declaration —
//      `findTopLevelFunctionNodeByName`'s pre-round-14 module-level search
//      returned the FIRST top-level declaration of `name` it encountered and
//      stopped; neither `var` declaration here is an `assignment_expression`,
//      so `subtreeContainsReassignmentOf` (round 13's fix, and round 14
//      finding 1's widening, above) cannot see either one regardless — a
//      legal redeclaration is not a write to an existing binding, it is a
//      second declaration of the SAME `var` binding (`var` has no block
//      scope and permits redeclaration, in both an ES module and a classic
//      script). The runtime binding is always the LAST declaration's
//      initializer, but this function returned the FIRST, with full
//      confidence, never `null`, so no caller ever failed safe. `T21.run21()`
//      is `T21`'s only tracked reference, so the site read as local-closed
//      while the SECOND, `this`-using declaration — the one actually in
//      effect — produced zero correlated evidence, reporting `fnAlpha21`
//      dead though `T21.run21()` invokes it every call. Fixed by making
//      `findTopLevelFunctionNodeByName` fail safe (return `null`) the moment
//      it finds a SECOND top-level declaration of `name`, rather than
//      returning the first and ignoring the rest — see that function's own
//      doc comment for why an honest "unresolved" beats a confidently wrong
//      first-match answer, the same choice round 10 made for a shadowing
//      declaration. No decoy needed: the second declaration's own
//      `this.alpha()` call populates T2 once the site correctly escapes.
function fnAlpha21() { return 1; }
var run21 = () => {};                              // FIRST declaration — this-free
var run21 = function () { return this.alpha(); };  // SECOND — this is what actually runs
const T21 = { alpha: fnAlpha21, run21 };            // shorthand: key and value both `run21`
T21.run21();
// (ai) (ROUND 14, #2088 finding 2) DUPLICATE top-level `function`
//      declarations — the SAME gap as (ah), a different AST shape: two
//      sibling `function_declaration`s sharing one name is a `SyntaxError`
//      under an ES module or `"use strict"` (redeclaring a `let`-like
//      binding), but legal in a classic, non-strict CommonJS script — this
//      fixture must run as one when WU-10 wires it up, exactly as (ah) may
//      run as either. `findTopLevelFunctionNodeByName`'s pre-round-14 loop
//      matched the FIRST `function_declaration` whose `name` field equalled
//      `run22` and returned immediately; the runtime binding, per hoisting
//      rules, is always the LAST sibling declaration — the identical failure
//      mode as (ah), one AST kind over. Same fix, same fixture shape. No
//      decoy needed, same reason as (ah).
function fnAlpha22() { return 1; }
function run22() { return 0; }                       // FIRST declaration — this-free
function run22() { return this.alpha(); }            // SECOND — this is what actually runs
const T22 = { alpha: fnAlpha22, run22 };              // shorthand: key and value both `run22`
T22.run22();
// EXPECT (af)-(ai): live, escapes === 1.
// (aj) (ROUND 15, #2088 finding 1) `var` HOISTS THROUGH A BLOCK — a
//      module-level `var` re-declared inside a bare `if` body is the SAME
//      hoisted binding, not a block-scoped shadow. Pre-round-15,
//      `findTopLevelFunctionNodeByName` only walked `root`'s DIRECT
//      children, so it never saw the second declaration at all:
//      `declarationCount` stayed at 1, and the function confidently
//      returned the FIRST, `this`-free declaration instead of failing
//      safe — the identical "confidently wrong rather than honestly
//      unresolved" failure class case (ah) already closed for a
//      direct-child redeclaration, one hoisting hop further. Verified
//      runnable under real Node (a plain ES module — no sloppy mode, no
//      Annex B required): prints `T24.run24() => 1`, i.e. `this.alpha()`
//      resolves `this === T24` and invokes `fnAlpha24` via the SECOND,
//      hoisted declaration. `T24.run24()` is `T24`'s only tracked
//      reference, so the site read as local-closed while the SECOND
//      declaration — the one actually in effect — produced zero
//      correlated evidence, reporting `fnAlpha24` dead though `T24.run24()`
//      invokes it every call. No decoy needed: the second declaration's
//      own `this.alpha()` call populates T2 once the site correctly
//      escapes, the same way case (ah)'s does.
function fnAlpha24() { return 1; }
var run24 = () => {};                                 // FIRST — only DIRECT-CHILD declaration
if (globalThis.LEGACY !== 'never') {
  var run24 = function () { return this.alpha(); };   // SECOND — same hoisted binding, in a block
}
const T24 = { alpha: fnAlpha24, run24 };
T24.run24();
// (ak) (ROUND 15, #2088 finding 1) ANNEX-B BLOCK-LEVEL FUNCTION HOISTING —
//      the identical mechanism as (aj), against a bare block-level
//      `function` declaration instead of `var`, legal ONLY in sloppy
//      (non-strict, non-module) script code (ECMA-262 §B.3.3); a `.mjs`/
//      module-scoped file, or one under `"use strict"`, would make the
//      inner `function run25(){}` a `SyntaxError` (redeclaring a `let`-like
//      binding) rather than a hoist — WU-10 must wire this fixture up as a
//      genuine non-`.mjs`, no-`"type":"module"` CommonJS file (see Testing
//      Strategy). Pre-round-15, `findTopLevelFunctionNodeByName` saw only
//      the FIRST, direct-child `function run25(){}` and returned it with
//      full confidence; the SECOND, block-nested declaration — the one
//      Annex B actually hoists to this scope, and the one the runtime
//      invokes — was invisible to the count entirely. Verified runnable
//      under real Node as a sloppy script: prints `T25.run25() => 1`. No
//      decoy needed, same reason as (aj).
function run25() { return 0; }                        // FIRST — direct-child, this-free
{
  function run25() { return this.alpha(); }           // SECOND — Annex-B hoisted, this-using
}
function fnAlpha25() { return 1; }
const T25 = { alpha: fnAlpha25, run25 };
T25.run25();
// EXPECT (aj)-(ak): live, escapes === 1.

// (al) (ROUND 16, #2088, #2630) A PARENTHESIZED assignment target — the
//      SAME underlying shape as case (ae), reached through a write
//      `subtreeContainsReassignmentOf`'s assignment branch could not see at
//      all pre-round-16: `left` is a `parenthesized_expression` wrapping the
//      identifier `run30`, a shape `patternBindsName` has no case for
//      (`default: return false`, `javascript.ts:4906-4907`), so neither the
//      round-13 bare-identifier nor the round-14 destructuring test ever
//      matched it. Verified runnable under real Node:
//      `T30.run30()` evaluates to `1`. Fixed by routing `left` through the
//      new `unwrapParens` helper before ever calling `patternBindsName` — see
//      `subtreeContainsReassignmentOf`'s own round-16 essay. No decoy
//      needed: the reassigned function's own `this.alpha()` call populates
//      T2 once the site correctly escapes, the same way case (ae)'s does.
function fnAlpha30() { return 1; }
let run30 = () => {};                              // module-level arrow — looks safe
(run30) = function () { return this.alpha(); };    // PARENTHESIZED reassignment
const T30 = { alpha: fnAlpha30, run30 };            // shorthand: key and value both `run30`
T30.run30();
// (am) (ROUND 16, #2088, #2630) A PARENTHESIZED for-of/for-in loop-head
//      REASSIGNMENT target, as a SIBLING top-level statement (not enclosing
//      the table, mirroring case (ae)'s own sibling placement) — the SAME
//      gap as (al), on `subtreeContainsReassignmentOf`'s OWN for-in branch
//      instead of its assignment branch. `for ((run31) of […])` is
//      grammar-valid: verified against `tree-sitter-javascript@0.25.0`'s
//      `grammar.json`, `parenthesized_expression` is reachable ONLY through
//      `_for_header`'s NO-`kind`-field alternative — i.e. a parenthesized
//      for-of/for-in head can never be a declaration, always a reassignment
//      of a pre-existing binding — so this branch's own `!node.childForFieldName('kind')`
//      guard is satisfied here just as it is for the unparenthesized case,
//      and only the `patternBindsName` call on `left` was the gap. Verified
//      runnable under real Node: `T31.run31()` evaluates to `1`. Same fix as
//      (al): `unwrapParens` on this branch's own `left` read. No decoy
//      needed, same reason as (al).
function fnAlpha31() { return 1; }
let run31 = () => {};                                       // module-level arrow — looks safe
for ((run31) of [function () { return this.alpha(); }]) {}  // PARENTHESIZED for-of reassignment, SIBLING statement
const T31 = { alpha: fnAlpha31, run31 };                     // shorthand: key and value both `run31`
T31.run31();
// (an) (ROUND 16, #2088, #2630) The SAME parenthesized for-of head as (am),
//      but as an ANCESTOR of the table it shadows rather than a sibling —
//      exercises `findResolvingScopeNode`'s OWN for-in disjunct (condition
//      4's resolution question), not `subtreeContainsReassignmentOf`'s
//      write-scan. `T32`'s object literal sits INSIDE the loop body, so
//      `findResolvingScopeNode`'s ancestor walk from `T32` reaches this
//      `for_in_statement` directly, pre-round-16 finds no case in
//      `patternBindsName` for the parenthesized `left`, and continues past
//      it (and past `install32`, which does not itself declare `run32`) all
//      the way to `root` — `run32` then resolves, unshadowed, to the OUTER,
//      `this`-free module-level decoy, the identical failure mode case (aa)
//      closed for an unparenthesized loop-head shadow. Verified runnable
//      under real Node: `T32.run32()` evaluates to `1`. Fixed the same way
//      as (al)/(am): `unwrapParens` on this disjunct's own `left` read — see
//      `findResolvingScopeNode`'s own round-16 essay. No decoy needed: the
//      loop body's own `this.alpha()` call populates T2 once the site
//      correctly escapes, the same way case (aa)'s does. **Unlike case (aa)
//      (a genuine, KIND-BEARING `const run4 of …` declaration, which
//      `subtreeContainsReassignmentOf`'s own `!kind` guard structurally
//      excludes from that function's consideration, cleanly isolating the
//      ancestor-walk mechanism), a PARENTHESIZED for-of head can only ever
//      be the grammar's NO-KIND alternative** — parenthesization and a
//      `kind` field are mutually exclusive productions in `_for_header`
//      (confirmed above, and independently by #2630's own second comment) —
//      so this exact shape is, by construction, ALSO always visible to
//      `subtreeContainsReassignmentOf`'s independent whole-file scan (case
//      (am)'s own mechanism). This fixture therefore cannot cleanly isolate
//      `findResolvingScopeNode`'s own disjunct fix from
//      `subtreeContainsReassignmentOf`'s the way case (aa) could for the
//      unparenthesized case: a regression that silently dropped ONLY this
//      disjunct, leaving `subtreeContainsReassignmentOf`'s own for-in fix
//      intact, would still pass this fixture via the fallback write-scan
//      path. A reviewer verifying this disjunct's own fix in isolation must
//      diff `findResolvingScopeNode`'s body directly, per the Testing
//      Strategy's "what no tier catches" standing rule — this fixture
//      proves the end-to-end outcome is correct, not which of the two code
//      paths produced it.
function fnAlpha32() { return 1; }
function run32() { return 0; }                      // module-level decoy, this-free
function install32() {
  for ((run32) of [function () { return this.alpha(); }]) {  // PARENTHESIZED, ENCLOSES the table
    const T32 = { alpha: fnAlpha32, run32 };          // shorthand: key and value both `run32`
    T32.run32();
  }
}
install32();
// EXPECT (al)-(an): live, escapes === 1.

// (ao) (ROUND 16, #2088, #2632) A block-scoped `using`/Explicit Resource
//      Management declaration shadow — `introducesShadowedBinding`'s
//      `statement_block` case recognises `lexical_declaration` and, by name
//      field, `function_declaration`/`generator_function_declaration`/
//      `class_declaration`, but has no case for the distinct grammar kind
//      `using_declaration` (verified against `tree-sitter-javascript@0.25.0`'s
//      `node-types.json`), so it falls through to `default: return false`.
//      `run33`'s declaring scope for condition 4's own question is
//      `install33`'s own block, but pre-round-16 `findResolvingScopeNode`
//      never notices the `using` declaration, the walk continues past it to
//      `root`, and `run33` resolves to the OUTER, `this`-free module-level
//      decoy with full confidence — the identical failure mode case (ad)'s
//      arrow-parameter shadow closed for a different AST shape. Verified
//      runnable under real Node 22.18.0 with the (as of this Node version,
//      still-experimental) `--js-explicit-resource-management` V8 flag:
//      `T33.run33()` evaluates to `1` — this flag governs only the RUNTIME
//      verification of this fixture's own claimed semantics, not codegraph's
//      own static analysis of it, since tree-sitter parses `using_declaration`
//      as an ordinary grammar node independently of any V8 feature flag.
//      Fixed in `findResolvingScopeNode` alone, NOT in
//      `introducesShadowedBinding` — see that function's own round-16 essay
//      for why. No decoy needed: the disposable function's own
//      `this.alpha()` call populates T2 once the site correctly escapes,
//      the same way case (ad)'s does. Closes #2632.
function fnAlpha33() { return 1; }
function run33() { return 0; }                      // module-level decoy, this-free
function install33() {
  const disposable33 = function () { return this.alpha(); };
  disposable33[Symbol.dispose] = () => {};
  using run33 = disposable33;                       // block-scoped `using` shadows outer run33
  const T33 = { alpha: fnAlpha33, run33 };            // shorthand: key and value both `run33`
  T33.run33();
}
install33();
// EXPECT (ao): live, escapes === 1.

// (ap) (ROUND 16, #2088, #2634) A script-scope `var` reassigned through the
//      GLOBAL OBJECT rather than through the bare identifier —
//      `subtreeContainsReassignmentOf`'s assignment branch (even after this
//      round's own `unwrapParens` fix) only ever inspects a `left` that
//      BINDS `name` via `patternBindsName` — `globalThis.run34` is a
//      `member_expression`, a shape neither that primitive nor this
//      function's own pre-round-16 code recognised as writing to `run34` at
//      all, though a script-scope `var` IS exposed as exactly that property
//      at runtime. Verified runnable under real Node as a genuine
//      script-scope evaluation (`node -e '…'`, where top-level `var` attaches
//      to `globalThis` — unlike a CommonJS `.js` file, which Node wraps in a
//      function, scoping a top-level `var` to that wrapper instead):
//      `T34.run34()` evaluates to `1`. Fixed by the new
//      `isGlobalObjectQualifiedWrite` check, ORed onto the existing
//      assignment/augmented-assignment branch — see
//      `subtreeContainsReassignmentOf`'s own round-16 essay for why this
//      check is deliberately not gated on the resolved declaration's own
//      kind. No decoy needed: the reassigned function's own `this.alpha()`
//      call populates T2 once the site correctly escapes, the same way case
//      (ae)'s does. Closes #2634; corrects this plan's own Risks table,
//      which previously grouped #2634 alongside #2625/#2631/round-14's
//      duplicate-declaration fail-safe as if it were the same kind of
//      accepted recall trade-off — it is not: those are fail-safe
//      (detected-then-declined-to-resolve-further); this was a missed write
//      entirely, the opposite direction.
function fnAlpha34() { return 1; }
var run34 = () => {};                                       // module-level arrow — looks safe
globalThis.run34 = function () { return this.alpha(); };    // GLOBAL-OBJECT-qualified reassignment
const T34 = { alpha: fnAlpha34, run34 };                     // shorthand: key and value both `run34`
T34.run34();
// EXPECT (ap): live, escapes === 1.

// (aq) (ROUND 16, #2088, #2636) A MIXED plain-then-generator top-level
//      redeclaration — `findTopLevelFunctionNodeByName`'s direct-children
//      loop (pre-round-16) recognises ONLY `function_declaration` as a
//      redeclaration candidate; a generator function DECLARATION
//      (`function* name(){}`) is the distinct grammar kind
//      `generator_function_declaration` and was invisible to both this loop
//      and `countHoistedVarScopeDeclarations`'s own hoisted extension alike.
//      **#2636's own issue body (and this plan's own Success Criteria
//      section and `countHoistedVarScopeDeclarations` doc comment, corrected
//      elsewhere this round) claimed this gap was "fail-safe-already… since
//      nothing ever returns such a node as `result` either" — true only of
//      #2636's OWN worked example, where EVERY declaration of the name is a
//      generator. It is false, and the failure is CONFIDENTLY WRONG, in this
//      MIXED case**: the FIRST declaration (`function run35(){}`, plain)
//      matches the pre-round-16 loop's existing branch, setting
//      `declarationCount = 1` and `result` to it; the SECOND (the generator)
//      matched neither that branch nor the hoisted-count branch, so
//      `declarationCount` never exceeded 1, and this function confidently
//      returned the FIRST, `this`-free declaration though the runtime
//      binding — per ordinary "last sibling declaration wins" semantics this
//      chain already relies on for two plain `function_declaration`s (case
//      (ai)) — is the SECOND, `this`-using generator. Verified runnable
//      under real Node: `T35.run35()` returns a generator object, and
//      `T35.run35().next().value` evaluates to `1`. This is also a
//      regression against today, for the same reason rounds 13-15's own
//      gaps were. Fixed by giving `generator_function_declaration` its own
//      branch in the direct-children loop, parallel to `function_declaration`
//      in every respect (count, set `result`, `continue`) — see
//      `findTopLevelFunctionNodeByName`'s own round-16 essay, and
//      `countHoistedVarScopeDeclarations`'s own round-16 essay for why that
//      OTHER function's recursive walk deliberately does NOT gain a matching
//      case (a nested generator does not hoist — Annex B never covers
//      generator declarations, verified empirically). Closes #2636.
function fnAlpha35() { return 1; }
function run35() { return 0; }                       // FIRST — direct-child, this-free
function* run35() { return this.alpha(); }           // SECOND — this is what actually runs
const T35 = { alpha: fnAlpha35, run35 };              // shorthand: key and value both `run35`
T35.run35().next();
// EXPECT (aq): live, escapes === 1.

// (ar) (ROUND 17, #2088, #2637) A block-scoped `using`/Explicit Resource
//      Management declaration shadow inside an UNBRACED `switch` case —
//      `introducesShadowedBinding`'s `switch_body` case recognises
//      `lexical_declaration` and, by name field,
//      `function_declaration`/`generator_function_declaration`/
//      `class_declaration`, but has no case for the distinct grammar kind
//      `using_declaration` (verified against `tree-sitter-javascript@0.25.0`'s
//      `node-types.json`, the same citation case (ao) already uses for the
//      `statement_block` variant of this gap), so it falls through
//      unmatched. `run40`'s declaring scope for condition 4's own question
//      is the `switch`'s own shared clause scope, but pre-round-17
//      `findResolvingScopeNode` never notices the `using` declaration, the
//      walk continues past the `switch_body` to `root`, and `run40`
//      resolves to the OUTER, `this`-free module-level decoy with full
//      confidence — the identical failure mode case (ao) closed for a
//      `statement_block` ancestor instead of a `switch_body` one. Verified
//      runnable under Node 22.18.0 with `--js-explicit-resource-management`:
//      `T40.run40()` evaluates to `1`. Fixed in `findResolvingScopeNode`
//      alone, NOT in `introducesShadowedBinding` — see that function's own
//      round-17 essay for why. No decoy needed: the disposable function's
//      own `this.alpha()` call populates T2 once the site correctly
//      escapes, the same way case (ao)'s does. Closes #2637.
function fnAlpha40() { return 1; }
function run40() { return 0; }                      // module-level decoy, this-free
function install40() {
  const disposable40 = function () { return this.alpha(); };
  disposable40[Symbol.dispose] = () => {};
  switch (1) {
    case 1:
      using run40 = disposable40;                   // unbraced clause, block-scoped `using` shadows outer run40
      const T40 = { alpha: fnAlpha40, run40 };        // shorthand: key and value both `run40`
      T40.run40();
  }
}
install40();
// EXPECT (ar): live, escapes === 1.

// (as) (ROUND 17, #2088 finding 1) A `var`-kind for-of loop head REBINDING
//      the SAME module-scope binding a direct top-level `var` declaration
//      already created — `var` is function-scoped, not block-scoped, so
//      `for (var name of iter)` does not declare a fresh, loop-scoped
//      binding the way `let`/`const`/`using` heads do; it rebinds the SAME
//      hoisted `run41`, once per iteration. Two gates both missed this,
//      independently: `subtreeContainsReassignmentOf`'s for-in branch was
//      gated `&& !node.childForFieldName('kind')`, so it skipped any head
//      WITH a `kind` field at all, `var` included; and
//      `countHoistedVarScopeDeclarations` had no case recognising a
//      `for_in_statement` as a hoisted declaration site in the first place
//      — verified against the real grammar: the `var` token and the `left`
//      pattern sit DIRECTLY under `for_in_statement`, via its own
//      `kind`/`left` fields, never wrapped in a `variable_declaration` node
//      the way a bare-block `var name;` statement is. Verified runnable
//      under real Node, as a plain ES module with NO flags: `T41.run41()`
//      evaluates to `1`. Fixed both ways: the for-in gate in
//      `subtreeContainsReassignmentOf` now also accepts `kind`'s text being
//      `"var"`, and `countHoistedVarScopeDeclarations` now also counts such
//      a head as one more hoisted declaration — see both functions' own
//      round-17 essays for why each is fixed independently rather than
//      relying on either one alone. No decoy needed: the loop's own
//      `this.alpha()` call populates T2 once the site correctly escapes,
//      the same way case (ae)'s does.
function fnAlpha41() { return 1; }
var run41 = () => {};                                        // direct top-level declaration — this-free
for (var run41 of [function () { return this.alpha(); }]) { } // REBINDS the same hoisted `run41`
const T41 = { alpha: fnAlpha41, run41 };                      // shorthand: key and value both `run41`
T41.run41();
// EXPECT (as): live, escapes === 1.

// (at) (ROUND 17, #2088 finding 2) A script-scope `var` reassigned through
//      the GLOBAL OBJECT via BRACKET-SUBSCRIPT notation rather than the dot
//      spelling case (ap) already covers — `isGlobalObjectQualifiedWrite`
//      (even after round 16's own fix) returned `false` for anything that
//      is not itself a `member_expression`, and `globalThis['run42'] = …`
//      is a `subscript_expression` at the grammar level, a DIFFERENT node
//      type from `globalThis.run42 = …`'s `member_expression`. Verified
//      runnable via `vm.runInThisContext` (the same classic-script premise
//      case (ap) itself relies on): `T42.run42()` evaluates to `1`. Fixed
//      by the new `subscript_expression` arm on `isGlobalObjectQualifiedWrite`,
//      reusing `isTrackedReferencePosition`'s own static-key normalisation
//      verbatim — see that function's own round-17 essay. No decoy needed:
//      the reassigned function's own `this.alpha()` call populates T2 once
//      the site correctly escapes, the same way case (ap)'s does.
function fnAlpha42() { return 1; }
var run42 = () => {};                                        // module-level arrow — looks safe
globalThis['run42'] = function () { return this.alpha(); };  // GLOBAL-OBJECT-qualified reassignment, bracket spelling
const T42 = { alpha: fnAlpha42, run42 };                      // shorthand: key and value both `run42`
T42.run42();
// EXPECT (at): live, escapes === 1.

// (au) (ROUND 17, #2088 finding 3) A `with (obj) { … }` block whose own
//      bound object shadows the table's handler at RUNTIME, in a way no
//      static AST walk can resolve — no `with_statement` case exists
//      anywhere in the shadow chain (`findResolvingScopeNode`,
//      `introducesShadowedBinding`, or `SCOPE_NODE_TYPES`), so `run43`
//      resolves to the module-level decoy with full, unearned confidence.
//      Verified runnable as sloppy CommonJS (a `SyntaxError` under
//      `"use strict"` or an ES module, the same sloppy-mode premise round
//      15's own Annex-B branch already treats as in scope): `T43.run43()`
//      evaluates to `1` — inside the `with` block, the bare reference
//      `run43` resolves against `obj43`'s own `run43` property, not the
//      outer, `this`-free `function run43()` declaration. Fixed by a new,
//      UNCONDITIONAL `with_statement` disjunct on `findResolvingScopeNode`
//      — any `with` ancestor makes resolution unknowable, so it fails safe
//      regardless of `name`; see that function's own round-17 essay for why
//      this does not contradict the Risks table's own observation that
//      `with`'s RESOLUTION target is undecidable statically — this fix only
//      detects the block's mere PRESENCE, an ordinary AST node, never what
//      it resolves to. No decoy needed: `obj43.run43`'s own `this.alpha()`
//      call populates T2 once the site correctly escapes, the same way case
//      (ae)'s does.
function fnAlpha43() { return 1; }
function run43() { return 0; }                      // module-level decoy, this-free
function install43() {
  const obj43 = { run43: function () { return this.alpha(); } };
  with (obj43) {
    const T43 = { alpha: fnAlpha43, run43 };          // shorthand: key and value both `run43`
    T43.run43();
  }
}
install43();
// EXPECT (au): live, escapes === 1.

// (av) (ROUND 17, CORRECTED ROUND 18, #2088, #2637) A `using`/Explicit
//      Resource Management declaration attempted in a C-STYLE for-loop's
//      own init clause — grammar-invalid there (verified against
//      `tree-sitter-javascript@0.25.0`'s `grammar.js:375-390` and
//      `node-types.json`'s own `initializer` field schema: neither lists
//      `using_declaration`), so this is NOT a shadowing declaration the way
//      case (ar)'s `switch_body` one is — it is a parse ERROR. Round 17's
//      own essay for this case claimed `introducesShadowedBinding`'s
//      `for_statement` case "recognises only `lexical_declaration`" and
//      that a `using_declaration` node "falls through unmatched," and
//      shipped a `findResolvingScopeNode` disjunct scanning for exactly
//      that node type — a disjunct that can never fire, since no
//      `using_declaration` node can ever appear here at all. Parsing this
//      exact fixture with the real, installed grammar (`web-tree-sitter`
//      against `tree-sitter-javascript`'s own `tree-sitter-javascript.wasm`)
//      confirms it directly: the `for_statement`'s initializer position
//      holds an `ERROR` node (`ERROR "using run45 = disposable45"`), never
//      a `using_declaration` one, with `rootNode.hasError === true`. Round
//      17's claim that this snippet "parses ... under Node" was true of
//      V8's own experimental Explicit-Resource-Management implementation
//      and false of tree-sitter-javascript, the grammar this design
//      actually walks — conflating the two is exactly the gap ROUND 18's
//      new fixture-verification standing rule now forbids (see
//      `findResolvingScopeNode`'s own doc comment). The fixture's
//      OBSERVABLE runtime outcome was never wrong — `T45.run45()` still
//      genuinely evaluates to `1` under Node with
//      `--js-explicit-resource-management`, exactly as before — only the
//      MECHANISM the pre-round-18 fix relied on to catch it was. Fixed by
//      keying on the actual parse shape instead: `findResolvingScopeNode`'s
//      `for_statement` disjunct now detects the malformed-`using`-shaped
//      `ERROR` node itself (`isMalformedUsingInitializer`, covering both
//      the plain and `await using` spellings — see that helper's own doc
//      comment) and fails safe UNCONDITIONALLY, the same shape the
//      `with_statement` disjunct already uses, since there is no clean
//      declaration node here to check a name against. `introducesShadowedBinding`
//      remains untouched. No decoy needed: the disposable function's own
//      `this.alpha()` call populates T2 once the site correctly escapes.
//      Also re-closes #2637, reopened because the prior fix for this half
//      of it was never actually reachable.
function fnAlpha45() { return 1; }
function run45() { return 0; }                      // module-level decoy, this-free
function install45() {
  const disposable45 = function () { return this.alpha(); };
  disposable45[Symbol.dispose] = () => {};
  for (using run45 = disposable45; true; ) {        // C-style for-init `using` shadows outer run45
    const T45 = { alpha: fnAlpha45, run45 };          // shorthand: key and value both `run45`
    T45.run45();
    break;
  }
}
install45();
// EXPECT (av): live, escapes === 1.

// (aw) (ROUND 18, #2088, #2637) The `await using` SPELLING of case (av)'s
//      same C-style for-loop init clause — proves `isMalformedUsingInitializer`
//      catches BOTH spellings, not just the plain `using` one: `await`,
//      outside an async function, is an ordinary identifier rather than a
//      keyword, so `for (await using run49 = …)` parses one layer deeper
//      than case (av)'s own fixture does — the whole clause is an
//      `assignment_expression` with `await` as its own valid, unremarkable
//      left-adjacent identifier and the `ERROR` node nested ONE LEVEL
//      INSIDE that node (`ERROR "using run49"`), not a direct child of the
//      `for_statement` the way case (av)'s is. A fix that checked only
//      DIRECT children for the malformed shape (case (av) alone would not
//      have caught this) would pass (av) and silently miss this spelling
//      entirely — verified by actually parsing this exact fixture with the
//      real grammar, not inferred from case (av)'s own shape.
function fnAlpha49() { return 1; }
function run49() { return 0; }                      // module-level decoy, this-free
function install49() {
  const disposable49 = function () { return this.alpha(); };
  disposable49[Symbol.dispose] = () => {};
  for (await using run49 = disposable49; true; ) {  // `await using` spelling
    const T49 = { alpha: fnAlpha49, run49 };          // shorthand: key and value both `run49`
    T49.run49();
    break;
  }
}
install49();
// EXPECT (aw): live, escapes === 1.

// (ax) (ROUND 18, #2088) A getter whose own body carries no `this` token at
//      all but RETURNS a `this`-using function — proves
//      `literalHasUnmodeledThisReference`'s new getter-escapes-
//      unconditionally rule actually escapes, not merely that it was
//      reasoned about: `subtreeContainsThisKeyword` alone would vote this
//      getter safe (its body is `return runImpl;`, no `this` anywhere), yet
//      accessing-then-calling the property invokes `runImpl` with `this`
//      bound to the table, exactly like case (g)'s same-literal `this.k()`
//      method except one property-return hop further.
function fnAlpha51x() { return 1; }
function runImpl51x() { return this.alpha(); }
const T51x = { alpha: fnAlpha51x, get run() { return runImpl51x; } };
T51x.run();
// EXPECT (ax): live, escapes === 1.

// (ay) (ROUND 18, #2088) A NESTED method whose own property NAME collides
//      with the table's binding name — proves `allReferencesTracked`'s new
//      `method_definition` name-field carve-out was necessary, not merely
//      that a plausible-sounding gap was described: without it, the
//      colliding method's entire body — including the one genuine
//      reference to the table this fixture provides — is wrongly pruned as
//      though the method's own property key were a shadowing declaration.
export function register(t) { return t.alpha(); }   // b.js
import { register } from './b.js';                  // a.js
function fnAlpha54() { return 1; }
const T54 = { alpha: fnAlpha54 };
const holder54 = { T54() { register(T54); } };      // method named the SAME as the table binding
holder54.T54();
// EXPECT (ay): live, escapes === 1.

// (az) (ROUND 18, #2088) A script-scope `var` reassigned through the
//      GLOBAL OBJECT via dot notation, with ONE PAREN LAYER around the
//      global-object identifier itself, PLUS (Greptile, flagged separately
//      on this PR) a second layer around the WHOLE assignment target —
//      proves `isGlobalObjectQualifiedWrite`'s `unwrapParens` routing
//      (both arms AND its own call site in `subtreeContainsReassignmentOf`)
//      actually closes both shapes, not merely that a plausible one-line
//      fix was described: `object.type === 'identifier'` alone is false
//      for `(globalThis)`, a `parenthesized_expression` (the object-only
//      paren, `run55`); and, independently, `isGlobalObjectQualifiedWrite`
//      itself never even runs against a clean `member_expression` at all
//      when the ENTIRE target is parenthesized — `(globalThis.run56) = …`
//      — since `patternBindsName` receives the unwrapped target (via the
//      call site's own existing unwrap) but, pre-round-18,
//      `isGlobalObjectQualifiedWrite` received the ORIGINAL
//      `parenthesized_expression` and rejected it outright (Greptile's own
//      exact repro shape, `run56`).
function fnAlpha55() { return 1; }
var run55 = () => {};                                        // module-level arrow — looks safe
(globalThis).run55 = function () { return this.alpha(); };   // PAREN-WRAPPED object identifier
const T55 = { alpha: fnAlpha55, run55 };                      // shorthand: key and value both `run55`
T55.run55();
// EXPECT (az): live, escapes === 1.

function fnAlpha56() { return 1; }
var run56 = () => {};                                        // module-level arrow — looks safe
(globalThis.run56) = function () { return this.alpha(); };   // PAREN-WRAPPED whole target (Greptile)
const T56 = { alpha: fnAlpha56, run56 };                      // shorthand: key and value both `run56`
T56.run56();
// EXPECT (az, cont'd): fnAlpha56 also live, escapes === 1 for T56's site.

// (ba) (ROUND 18, #2088, Greptile) A `var`-declared alias of a BLOCK-scoped
//      table, referenced OUTSIDE that block but still inside the enclosing
//      FUNCTION — proves `allReferencesTracked`'s rebinding recursion
//      widens its own search boundary for a `var` alias specifically,
//      rather than reusing the outer call's `declaringScope` unconditionally:
//      `var` is function-scoped, so `u`'s true visibility extends past the
//      `if`-block `T`'s own declaringScope is rooted at.
function fnAlpha57() { return 1; }
function sink57(x) { return x.alpha(); }
function install57() {
  if (true) {
    const T57 = { alpha: fnAlpha57 };
    var u57 = T57;                    // `var` alias — visible throughout install57(), not just the if-block
  }
  sink57(u57);                        // OUTSIDE the if-block, still inside install57() — genuinely reachable
}
install57();
// EXPECT (ba): live, escapes === 1.

// (bb) (ROUND 19, #2088 finding 1) A non-computed `__proto__` pair — proves
//      the new key-shape check in `literalHasUnmodeledThisReference`
//      actually escapes, not merely that a plausible-sounding gap was
//      described: `isPositivelyThisFreeLiteral`'s own `object` arm alone
//      would vote this pair safe (its value IS an `object`), yet a method
//      reached through a non-computed `__proto__` pair binds `this` to the
//      table directly, with no property hop at all.
function fnAlpha58() { return 1; }
const T58 = { alpha: fnAlpha58, __proto__: { run() { return this.alpha(); } } };
T58.run();
// EXPECT (bb): live, escapes === 1.

// (bc) (ROUND 19, #2088 finding 3) A binding forwarded into an imported
//      function by SHORTHAND property, rather than as a bare identifier
//      argument (case (b)'s own shape) — proves `allReferencesTracked`'s
//      widened node-type filter actually escapes, not merely that a
//      plausible-sounding gap was described: an `identifier`-only filter
//      never visits the `shorthand_property_identifier` node `{ T59 }`
//      parses its own property to, so the walk would (wrongly) believe
//      itself exhaustive over an empty surviving set and read this table
//      as local-closed.
import { sink } from './sink.js';
function fnAlpha59() { return 1; }
const T59 = { alpha: fnAlpha59 };
sink({ T59 });
otherObj.alpha();
// EXPECT (bc): live, escapes === 1.

// (bd) (ROUND 19, #2088 finding 2) A `var`-kind for-of loop variable,
//      declared inside a block NARROWER than the table's own for-of head
//      sits at, referenced OUTSIDE that block but still inside the
//      enclosing FUNCTION — the for-of counterpart of case (ba)'s own
//      rebinding-alias construction, one binding further: proves the
//      for-of recursion's own `var`-kind boundary-widening actually
//      escapes, not merely that a plausible-sounding gap was described.
function fnAlpha60() { return 1; }
function sink60(x) { return x.alpha(); }
function install60() {
  if (true) {
    const A60 = [{ alpha: fnAlpha60 }];
    for (var r60 of A60) { }   // `var` — visible throughout install60(), not just the if-block
  }
  sink60(r60);                 // OUTSIDE the if-block, still inside install60() — genuinely reachable
}
install60();
// EXPECT (bd): live, escapes === 1.

// (be) (ROUND 20, #2088, B1) A non-computed `__proto__` pair spelled with a
//      unicode escape sequence, cooking to the identical prototype-setting
//      key as case (bb)'s bare spelling — proves the round-20 backslash
//      fail-safe actually escapes, not merely that a plausible-sounding
//      evasion was described: round 19's own check, run against this exact
//      pair, votes safe (its stripped raw text is the escape sequence
//      itself, never the bare seven characters), while the table
//      genuinely escapes.
function fnAlpha66() { return 1; }
const T66 = { alpha: fnAlpha66, "\u005f\u005fproto\u005f\u005f": { run() { return this.alpha(); } } };
T66.run();
// EXPECT (be): live, escapes === 1.

// (bf) (ROUND 20, #2088, B2) A `function`/`var` REDECLARATION of the SAME
//      name at the very top level of the enclosing function a `var` alias's
//      boundary widens to — proves `allReferencesTracked`'s rebinding
//      recursion widens to the enclosing function's own `body`, not the
//      function node itself: widening to the function node lets the later
//      walk self-shadow-prune that WHOLE body on the co-located
//      `function u67(){}` declaration, hiding `sink67(u67)` entirely.
function fnAlpha67() { return 1; }
function sink67(x) { return x.alpha(); }
function install67() {
  const T67 = { alpha: fnAlpha67 };
  function u67() {}     // body-level, same name as the var alias below
  var u67 = T67;          // var alias -- widens the recursive call's boundary to install67() itself
  sink67(u67);
}
install67();
// EXPECT (bf): live, escapes === 1.

// (bg) (ROUND 20, #2088, B2) The identical shape as (bf), one binding
//      further: a `function`/`var` REDECLARATION of the SAME name as a
//      `var`-kind for-of LOOP VARIABLE, at the top level of the function
//      the for-of recursion's own boundary widens to — proves that
//      recursion widens to the enclosing function's own `body` too, for the
//      identical reason as the rebinding recursion above.
function fnAlpha68() { return 1; }
function sink68(x) { return x.alpha(); }
function install68() {
  const A68 = [{ alpha: fnAlpha68 }];
  function r68() {}          // body-level, same name as the loop variable below
  for (var r68 of A68) { }    // var -- widens the recursive call's boundary to install68() itself
  sink68(r68);
}
install68();
// EXPECT (bg): live, escapes === 1.

// (bh) (ROUND 20, #2088, B5/#2640) A classic-script `globalThis.T.alpha()`
//      READ of a script-scope `var` — proves `allReferencesTracked`'s new
//      third node-matching case (a `member_expression`/`subscript_expression`
//      recognised by `isGlobalObjectQualifiedWrite`) actually makes the
//      table escape, not merely that a plausible-sounding read-side gap was
//      described: pre-round-20, this read is invisible to the walk in
//      both directions, and the table reads (wrongly) local-closed.
function fnA69() { return 1; }
var T69 = { alpha: fnA69 };
function sink69() { return globalThis.T69.alpha(); }
sink69();
// EXPECT (bh): live, escapes === 1.

// (bi) (ROUND 20, #2088, G1 -- Greptile, PR #2612) A script-scope `var`
//      reassigned through the global object via BRACKET notation, with the
//      INDEX itself parenthesized -- proves `isGlobalObjectQualifiedWrite`'s
//      `subscript_expression` arm actually unwraps the index, not merely
//      the object: `globalThis[('run70')] = ...` was invisible pre-round-20
//      for the identical structural reason a paren layer around the
//      object defeated this function before round 18's own fix.
function fnAlpha70() { return 1; }
var run70 = () => {};                                          // module-level arrow -- looks safe
globalThis[('run70')] = function () { return this.alpha(); };  // PAREN-WRAPPED index
const T70 = { alpha: fnAlpha70, run70 };
T70.run70();
// EXPECT (bi): live, escapes === 1.

// (bj) (ROUND 20, #2088, UE-C, non-blocking) A property literally named
//      `bind`, invoked via `T.bind(...)` -- proves `isTrackedReferencePosition`
//      rejects this shape rather than wrongly accepting it as a genuine
//      correlation candidate: the pre-existing, general call extractor
//      rewrites ANY `<expr>.bind(...)` to a receiver-less `reflection` Call
//      regardless of context, so this call can never produce
//      `collectInvokedPropertySites` evidence for ANY of T71's properties --
//      accepting the reference as tracked would (wrongly) let T71 read
//      local-closed while producing zero real evidence for anything.
function fnAlpha71() { return 1; }
const T71 = { alpha: fnAlpha71, bind: () => 2 };
T71.bind(1);
// EXPECT (bj): fnAlpha71 dead (nothing invokes `.alpha(`); escapes === 1 for
// T71's site -- `T71.bind(1)` must not be accepted as a tracked reference.
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
| **Integration over a fixture project** | The twenty-six correlation shapes and the 62 escape-fallback shapes (eight from earlier rounds, six added in round 7 for findings 1, 2 — split into its plain-forwarding and destructuring sub-cases — 3, 4, and 5, two added in round 8 for the headline shadow-prune fix and finding 3's `$`-guard gap, five added in round 9 for finding 1's fail-open condition-4 default spanning module, function, and block scope, five added in round 10 for finding 1's shadowed-identifier-resolution fix (function + block, no module member — see the round-10 scope-coverage note below) and finding 2's `BUILTIN_GLOBALS`-guard fix (module + function + block), three added in round 11 — one for finding 1's `for...of`/`for...in` loop-head shadow gap and two for finding 2's imported-builtin regression, one per affected arm (see the round-11 scope-coverage note below for why neither gets a module/function/block trio) — one added in round 12 for finding 1's bare arrow-parameter shadow gap, a second AST shape reaching the same resolution question the for-in gap did (see the round-11 scope-coverage note below for why this one needs no trio either), one added in round 13 for finding 1's reassignment-tracking gap in condition 4's identifier resolution (see the round-13 scope-coverage note below for why this one needs no trio either), four added in round 14 — two for finding 1's destructuring-write detection gap in the same reassignment scan (an array- and an object-pattern target) and two for finding 2's duplicate-top-level-declaration fail-safe (a `var` redeclaration and a duplicate sibling `function` declaration) — see the round-14 scope-coverage note below for why none of the four needs a trio either — two added in round 15 for the var-hoists-through-blocks gap in that same duplicate-declaration fail-safe (a `var`-in-block case and an Annex-B block-level-function case) — see the round-15 scope-coverage note below for why this one needs no trio either — six added in round 16, one per closed under-escape path: a parenthesized assignment target and a parenthesized for-of write-scan target (the write-scan half of #2630), a parenthesized for-of loop-head shadow (the resolution half of #2630), a block-scoped `using`-declaration shadow (#2632), a `globalThis`-qualified write (#2634), and a mixed plain-then-generator top-level redeclaration (#2636) — see the round-16 scope-coverage note below for why none of the six needs a trio either — and five added in round 17, covering that round's four closed under-escape paths: a block-scoped `using`-declaration shadow inside an unbraced `switch` case (#2637), the identical `using`-declaration shadow gap in a C-style for-loop's own init clause, found while auditing every `SCOPE_NODE_TYPES` member for it rather than stopping at `switch_body` alone (also #2637), a `var`-kind for-of loop head rebinding a direct top-level `var` (finding 1), a `globalThis`-qualified write spelled with bracket-subscript notation (finding 2), and a `with` block shadowing a handler at runtime (finding 3) — see the round-17 scope-coverage note below for why none of the five needs a trio either; a sixth round-17 fix, a Greptile-flagged `unwrapParens` consistency gap in `subtreeContainsReassignmentOf`'s `update_expression` branch, gains no escape-fallback case of its own, since no soundness repro exists for it — see correlation shape 18 and that fix's own doc comment — and five added in round 18, one per closed under-escape path: the `await using` spelling of the C-style for-loop gap case (av) already covers, nested one level deeper in the parse tree than the plain spelling (case (av) itself is corrected, not replaced — its fixture was always right, only its own essay's account of WHY was wrong); a getter that returns, rather than itself references, a `this`-using function (the U2 gap); a nested method whose property name spuriously collides with the table's own binding name (the U3 gap); a global-object write with a paren layer around the global identifier itself (the U4 gap, extended in-fixture for a second, Greptile-flagged paren layer around the whole assignment target); and a `var`-declared alias of a block-scoped table referenced outside that block (Greptile-flagged) — see the round-18 scope-coverage note below for why none of the five needs a module/function/block trio), and three added in round 19, one per closed under-escape path: a non-computed `__proto__` pair, which sets the table's own `[[Prototype]]` rather than an ordinary own property and so binds a nested method's `this` to the table with no property hop at all; a binding forwarded by SHORTHAND property into an imported function, invisible to `allReferencesTracked`'s pre-round-19 `identifier`-only reference filter; and a `var`-kind for-of loop variable referenced outside the block its table is declared in, the for-of counterpart of round 18's own rebinding-alias boundary widening — see the round-19 scope-coverage note below for why none of the three needs a module/function/block trio either — and six added in round 20, one per closed gap (five blocking, one non-blocking): a `__proto__` pair spelled with a unicode escape sequence (B1); the SAME granularity fix applied to both the rebinding-alias and for-of-loop-variable recursions' boundary widening, one case each, since the two recursions share the widening helper but are independent call sites (B2); a classic-script `globalThis`-qualified read (B5/#2640); a `globalThis`-qualified write through a bracket-subscript notation with the index itself parenthesized (G1, Greptile-flagged); and a property literally named `call`/`apply`/`bind` invoked reflectively (UE-C, non-blocking) — B3 and B4 needed no new escape-fallback case, since both are corrections to existing round-19 fixtures' own vacuousness rather than new gaps (see the round-20 corrections to correlation shapes 23 and 25, above) — see the round-20 scope-coverage note below for why none of the six needs a module/function/block trio either, end-to-end through `buildGraph` into `nodes.role`. | `tests/integration/issue-2088-*.test.ts` |
| **Resolution precision/recall** | The new `pts-javascript/objlit-site.js` fixture's expected edges. `javascript`'s precision-1.0 floor must not move — that fixture is the false-positive canary per ADR-002. | `tests/benchmarks/resolution/` |
| **Dual-engine parity** | Every integration assertion runs under `--engine wasm` and `--engine native`; `npm run build` runs first so WASM sees the new `dist/`. | both `issue-2088-*` tests + `/parity` |
| **Incremental vs full** | A `codegraph watch`-shaped single-file rebuild reaches the same tier decision as a full build, via the two persisted tables. | `issue-2087-…` + the incremental case in `issue-2088-correlated-property-evidence` |
| **Benchmark / perf canary** | The solver gains constraint rows proportional to object-literal count. `npm run benchmark` guards build time; a >5% regression on this repo's full build is a finding to report, not to absorb. | `npm run benchmark` |

**Sloppy-mode CommonJS fixture wiring (disclosing a round-14 gap, closed round 15).** Escape-fallback case (ai) (round 14) and case (ak) (round 15) each rely on a duplicate, sibling `function` declaration of the identical name at the same scope — legal ONLY in a classic, non-strict, non-module script; a `SyntaxError` under an ES module or a file carrying `"use strict"`. WU-10's harness must therefore provision an explicit fixture file for each that is neither given a `.mjs` extension nor covered by a `package.json` `"type": "module"` field, and carries no `"use strict"` directive of its own — every OTHER escape-fallback and correlation fixture in this suite is free to run as an ES module (the default this repo's own test harness otherwise assumes); these two are the only ones that cannot. Round 14 named this requirement in case (ai)'s own doc comment ("this fixture must run as one when WU-10 wires it up") but never surfaced it at the level a builder scanning this section for what WU-10 needs to provision would actually look — round 15 (case (ak), which carries the identical requirement for the identical reason) is what surfaces it here.

**Scope coverage is a first-class testing requirement, not an incidental property (ROUND 8).** Every WU-10 fixture through round 7 declared its table at MODULE scope — the one scope `introducesShadowedBinding` never self-shadows by construction (`default: return false` for `program`) — which is exactly why the round-8 shadow-prune bug (finding 1) went undetected for seven rounds: the test suite was structurally incapable of exercising the code path it broke. Closing that blind spot for THIS round's fix is not enough on its own to guarantee it stays closed. **Fixtures for every branch of the escape predicate — conditions 1–4 in `computeObjectLiteralSiteEscapes`, `isTrackedReferencePosition`'s member/subscript/for-of branches, and both recursive branches of `allReferencesTracked` — must include at least one MODULE-scope, one FUNCTION-scope, and one BLOCK-scope (an `if`/`for`/bare-block body, not a function body) case going forward.** Correlation shapes 4 and 5 (function- and block-scoped tables used correctly) and escape-fallback case (o) (a function-scoped table that must escape) establish this baseline for round 8's own fix; a reviewer adding a new branch to the escape predicate in a future round must add its own module/function/block trio rather than defaulting to module scope alone, the same way the original seven rounds did. **Round 9 follows this discipline for its own condition-4 fix**, even though the fix itself is not scope-sensitive the way round 8's shadow-prune bug was (`literalHasUnmodeledThisReference` inspects an object literal's own direct children regardless of where the literal sits in the tree) — cases (q), (t), and (u) exercise the identical object-spread shape at module, function, and block scope respectively, precisely BECAUSE assuming a new branch is scope-independent without a fixture proving it is the same assumption that let round 8's bug stand for seven rounds; (u) also closes a standing asymmetry noted while writing it — round 8 never added a BLOCK-scoped ESCAPING case of its own (only a function-scoped one, (o)), so (u) is the first in the suite.

**Round 10 splits across BOTH precedents above, because its two findings differ on exactly the axis that distinguishes them.** Finding 1 (the shadowed-identifier fix) is scope-DEPENDENT the way round 8's shadow-prune bug was — it can only manifest when some scope strictly between the object literal and the module root ALSO declares the shadowed name, which is structurally impossible when the literal itself sits at module scope (there is no shallower scope to be confused with) — so, mirroring round 8's own cases 4/5, it gets a two-member trio: case (v) is function-scoped, case (w) is block-scoped, and correlation shapes 1-7's existing module-scope coverage stands in for the missing third member, exactly as round 8's own case-4 comment already established this precedent. Finding 2 (the `BUILTIN_GLOBALS`-guard fix) is scope-INDEPENDENT the way round 9's fall-through-arm fix was — `isUnshadowedBuiltinGlobal` consults only `BUILTIN_GLOBALS` and the flat, file-wide `definitionNames` set, neither of which has any notion of lexical position — so, mirroring round 9's own cases (q)/(t)/(u), it gets a genuine three-member trio: case (x) is module-scoped (matching the finding's own repro), case (y) is function-scoped, and case (z) is block-scoped, each independently load-bearing because the pre-round-10 shorthand guard short-circuits BEFORE finding 1's own shadow check ever runs, so finding 1's fix alone would not have caught cases (y)/(z) either. A reviewer adding a new branch to the escape predicate in a future round should determine which of these two shapes their own fix has — scope-dependent (two-member trio, module coverage inherited from existing shapes) or scope-independent (three-member trio) — rather than mechanically adding three cases regardless of whether a module-scope member can even exist.

**Round 11's two findings fit NEITHER precedent above, and are deliberately not forced into one.** Finding 1 (the `for...of`/`for...in` loop-head shadow) does not vary with what encloses the `for_in_statement` itself: `findResolvingScopeNode`'s new disjunct fires (or does not) purely on whether SOME `for_in_statement` ancestor's `left` binds `name`, a question the loop's own enclosing module/function/block context never changes — case (aa) alone, with the loop at module scope (matching finding 1's own repro), exercises the identical code path a function- or block-nested loop would; a second or third variant would repeat the same assertion against the same branch, not add coverage the way round 8's/round 10's own trios do against a genuinely scope-sensitive walk. Finding 2 (the imported-builtin gap) is answered even more starkly: post-fix, a builtin name escapes with NO lexical-position sensitivity at all — not `definitionNames`, not scope, nothing but `BUILTIN_GLOBALS.has(name)` — so scope is not the coverage axis this finding's own fixtures need to prove. The axis that matters is which of the TWO CODE PATHS (the `pair` arm's identifier branch, or the `shorthand_property_identifier` arm) was regressed, since both call sites carry their own, independently-editable guard expression — case (ab) exercises the `pair` arm, case (ac) the shorthand arm, both at module scope, because scope has nothing left to vary. A reviewer adding a new branch in a future round should ask not just "is this scope-dependent or scope-independent" (round 8/9/10's own axis) but, per round 11, whether the fix's OWN inputs have any notion of lexical position at all before reaching for a trio by default — a fix with fewer sensitivities needs fewer fixtures to characterise it, not more.

**Round 12's finding is the SAME shape as round 11's finding 1, for the identical reason, against a second AST shape.** `findResolvingScopeNode`'s new `arrow_function`/`parameter` disjunct fires purely on whether SOME `arrow_function` ancestor's own bare `parameter` field text-matches `name` — a question, like the for-in disjunct's, that the arrow's own enclosing module/function/block context never changes: an arrow with a bare parameter shadows identically whether it is itself declared at module scope, nested in a function, or nested in a block. Case (ad) alone, with `make17` declared at module scope (matching this finding's own repro, and case (aa)'s own precedent), exercises the identical code path a function- or block-nested arrow would; no second or third variant would add coverage a trio elsewhere in this file does not already provide for the OTHER thing that varies (module/function/block nesting of the *table*, not of the shadowing arrow). This is round 11's own scope-coverage note applied to a second disjunct on the same function, not a new argument.

**Round 13's finding is a DIFFERENT axis from rounds 11–12's, and needs neither a module/function/block trio NOR a per-arm pair.** `subtreeContainsReassignmentOf` walks the WHOLE file looking for a write to the resolved name — a question with NO notion of where the TABLE (the object literal using that name) itself sits: a reassignment reachable from the module root is exactly as reachable whether the literal reading the name is declared at module, function, or block scope, since the write-scan does not start from the literal's own position at all (unlike `findResolvingScopeNode`'s ancestor walk, which does). Case (ae) alone, with the table (`T18`) at module scope, matching the finding's own repro, therefore exercises the identical code path a function- or block-nested table would; a second or third variant would repeat the same assertion against the same walk, not add coverage the way round 8's/round 10's own trios do. Nor does it need round 11 finding 2's kind of per-ARM pair (`pair` vs `shorthand_property_identifier`): both arms already route through the identical `resolveIdentifierValueThisReference` call this fix lives inside, so one arm exercising it is representative of both, the same reasoning case (v) already relies on for round 10's finding 1. The three write SHAPES `subtreeContainsReassignmentOf` itself recognises (plain/augmented assignment, update expression, declaration-less for-in) are likewise not independently fixtured here: unlike round 11 finding 2's two arms, which are two SEPARATE, independently-editable guard expressions at two different call sites, all three write shapes are branches of the SAME new helper, checked by the SAME caller — a porting or logic error in any one of them is exactly what a future round's own re-audit (per the standing "what no tier catches" rule below) is for, not a combinatorial fixture matrix up front.

**Round 14's two findings are each a DIFFERENT axis again.** Finding 1 (cases (af)/(ag)) widens WHICH shapes count as a write inside the SAME whole-file scan round 13's finding already established is scope-independent — the argument above applies unchanged: a destructuring write reachable from the module root is exactly as reachable regardless of where the table itself sits, so (af)/(ag) each need only one instance, at module scope, matching the shape of case (ae) they extend. The two ARE independently fixtured from each other, unlike round 13's three write shapes: `patternBindsName`'s `array_pattern` and `object_pattern` cases are two separate branches of a switch a porting error could narrow independently (fixing the array case while missing the object one, or vice versa), the same reasoning that gives round 11 finding 2's two arms independent cases rather than one. Finding 2 (cases (ah)/(ai)) is a different question this text through round 14 claimed had the identical "needs no trio" answer for a DIFFERENT, and — **round 15 found — WRONG**, reason: it claimed "does `name` have more than one top-level declaration" is a property of the MODULE's own top level only, because "`findTopLevelFunctionNodeByName` never looks inside a function or block in the first place, so there is no function- or block-scoped variant of 'two top-level declarations' to fixture at all." **That is true of this function's pre-round-15 IMPLEMENTATION and false of JS semantics** — `var` is function-scoped, not block-scoped, so a `var name` (or, in sloppy-mode code, an Annex-B block-level `function name(){}`) hoisted from inside a nested block IS exactly such a variant, simply one round 14's own direct-children-only count could not see; see the round-15 note immediately below, which corrects this claim rather than leaving it stand uncorrected beside its own refutation. What DOES remain true of cases (ah)/(ai) specifically, narrower than what round 14's text claimed for the underlying question generally: each is a pure module-level, DIRECT-CHILD redeclaration, which is why those two cases themselves need no trio — round 15's cases (aj)/(ak) are the function-or-block-scoped variant this paragraph, through round 14, wrongly said could not exist. `(ah)`/`(ai)` remain two independent cases for the same reason (af)/(ag) are: `var`-redeclaration and duplicate-`function`-declaration are two separate AST shapes a hand-written fix could narrow independently, mirroring how round 12's bare-arrow-parameter case (ad) needed its own fixture distinct from round 11's for-in case (aa) despite answering the same underlying resolution question.

**Round 15's finding is the SAME underlying question as round 14 finding 2 — "does `name` have more than one declaration reachable from module scope" — but widens WHAT COUNTS AS SUCH A DECLARATION, exactly the axis round 14's own text (corrected above) wrongly assumed was exhausted.** `var` is function-scoped, not block-scoped: a `var name` hoisted from inside a bare block/`if`/`for`/`try`/`switch` body is the SAME module-scope binding a direct top-level `var name` is, and sloppy-mode Annex B (ECMA-262 §B.3.3) extends the identical hazard to a block-level `function name(){}`. This needs two fixtures, not a module/function/block trio — there is no THIRD member here, for the same structural reason round 14's cases (ah)/(ai) needed none: the table itself, and the fail-safe this fixes, both live at module scope regardless of where the HOISTED declaration is nested — but case (aj) (a `var`-in-block) and case (ak) (an Annex-B block-level `function`) are independently fixtured from each other for the same reason (af)/(ag) and (ah)/(ai) are: two separate branches of `countHoistedVarScopeDeclarations` a hand-written fix could narrow independently, fixing the `var` case while missing the `function_declaration` one or vice versa. Unlike any prior round in this chain, round 15 ALSO needs a case proving the fix does not over-reach: correlation shape 8 (WU-10) proves a `let`/`const` in the identical nested position — a genuinely different, block-scoped binding — is correctly EXCLUDED from the widened count, the same "prove the exclusion holds, not just state it" discipline round 9's cases (q)/(t)/(u) already established for their own fail-closed rewrite.

**Round 16's four fixes each fall on the scope-INDEPENDENT side of round 8's/round 10's own axis, matching round 11's, round 13's, and round 14's own precedent — none needs a module/function/block trio.** The parenthesized-target fix (cases (al)/(am)) widens WHICH shapes `subtreeContainsReassignmentOf`'s write-scan recognises, inside the SAME whole-file scan round 13's and round 14's own findings already established is scope-independent — the argument stands unchanged: a parenthesized write reachable from the module root is exactly as reachable regardless of where the table itself sits. The parenthesized-shadow fix (case (an)) widens `findResolvingScopeNode`'s for-in disjunct, which round 11's own note already established fires purely on whether some `for_in_statement` ancestor's `left` matches `name` — a question the loop's own enclosing module/function/block context never changes; unlike round 11's own case (aa), however, this disjunct's fixture must place the TABLE inside the loop body for the ancestor walk to reach it at all (see case (an)'s own commentary for why this also means the fixture cannot cleanly isolate this fix from the write-scan one, unlike round 11's clean isolation from round 13's). The `using`-declaration fix (case (ao)) is the same shape as round 12's bare-arrow-parameter disjunct: it fires on whether some `statement_block` ancestor contains a `using_declaration` for `name`, a question that, like round 12's own arrow-parameter check, does not vary with what encloses the shadowing block itself. The generator-redeclaration fix (case (aq)) is the same underlying question as round 14 finding 2 and round 15 — "does `name` have more than one declaration reachable from module scope" — narrowed to the direct-children loop alone (see `findTopLevelFunctionNodeByName`'s and `countHoistedVarScopeDeclarations`'s own round-16 essays for why the fix deliberately does NOT extend to a nested generator, unlike `var`/Annex-B's own genuine hoisting): a pure module-level, direct-child redeclaration, needing no trio for the identical structural reason cases (ah)/(ai) did not. The `globalThis`-qualified-write fix (case (ap)) is the same shape as round 13's and round 14's own reassignment-scan findings, for the identical reason: the whole-file scan does not care where the table sits.

**Round 17's four fixes likewise all fall on the scope-INDEPENDENT side, continuing round 11's precedent — none needs a module/function/block trio.** The `switch_body` fix (case (ar)) and its `for_statement` sibling (case (av), found while auditing every `SCOPE_NODE_TYPES` member for the identical gap rather than stopping at `switch_body` alone) are both the identical shape as round 16's own `using`-declaration/`statement_block` fix (case (ao)): each fires on whether some ancestor of that one node type contains a `using_declaration` for `name`, a question that does not vary with what encloses the shadowing switch or for-loop itself. The `var`-kind for-of/for-in fix (case (as)) spans two functions but is scope-independent in both: `countHoistedVarScopeDeclarations`'s new check is reached from `findTopLevelFunctionNodeByName`'s own direct-children loop exactly as round 15's hoisted-count fix already is (module-level table, hoisted-elsewhere declaration — no third member exists here for the identical structural reason cases (aj)/(ak) needed none), and `subtreeContainsReassignmentOf`'s widened gate is the same whole-file, table-position-independent scan round 13's and round 14's own findings already established needs no trio. The `globalThis`-subscript fix (case (at)) is the bracket-spelling variant of round 16's own dot-spelling fix (case (ap)) and needs nothing that fix did not already establish. The `with_statement` fix (case (au)) is, if anything, LESS scope-sensitive than any prior disjunct on `findResolvingScopeNode`: it takes no `name` parameter in its own condition at all, so there is no shadow-versus-no-shadow axis to vary by table position in the first place — a `with` ancestor is unknowable regardless of where the table inside it sits, module/function/block distinctions notwithstanding.

**Round 18's five fixes are a mix of the shapes this section has already named, plus one genuinely new axis (and, separately, a SECOND genuinely new axis for its Greptile-flagged fifth fix, described at this paragraph's own end).** The corrected `for_statement`/malformed-`using` disjunct (cases (av), corrected, and (aw)) is the SAME shape as round 17's own `with_statement` fix, immediately above: it fires on the ancestor's own detectable shape (now an `ERROR` node of a particular text prefix, rather than a `using_declaration` node that could never appear there), with no `name`-bearing condition at all, so table position never enters into it — no trio needed, for the identical reason case (au) needed none. The getter fix (case (ax)) is scope-independent for a different, simpler reason: `literalHasUnmodeledThisReference` inspects an object literal's own direct children regardless of where the literal sits in the tree, exactly as round 9's own spread/pair-value fix already established — no trio needed, mirroring cases (q)/(t)/(u)'s own precedent for the identical function. **The `allReferencesTracked` `method_definition` carve-out (case (ay)) is the one genuinely NEW axis this list has not needed before: it is scope-dependent, but not on the TABLE's own position — on the NESTED colliding method's position relative to the table's own `declaringScope`.** The walk only reaches a node at all if it is a descendant of that fixed scope (round 8's own boundary), so the fixture's requirement is not "vary the table's module/function/block position" (round 8's/round 10's own axis) but "place the colliding method somewhere the walk actually visits" — case (ay)'s own module-scope construction (`declaringScope === root`) already exercises the widest, least-constrained version of that requirement, since ROOT's own descendant set is a superset of any narrower `declaringScope`'s; a function- or block-scoped table would only narrow which portion of the same walk the colliding method has to sit inside, not change the mechanism being tested. The `isGlobalObjectQualifiedWrite`/`unwrapParens` fix (case (az)) is the same shape as round 16's/round 17's own global-object-write fixes: `subtreeContainsReassignmentOf`'s whole-file scan does not care where the table sits, so no trio is needed here either, mirroring cases (ap)/(at)'s own precedent. **The `allReferencesTracked` var-alias boundary-widening fix (case (ba), Greptile-flagged) is the SECOND genuinely new axis this section has needed, distinct even from case (ay)'s: it is scope-dependent not on the TABLE's position, and not merely on the colliding node's position relative to a fixed boundary (case (ay)'s own axis), but on the RELATIONSHIP between the table's own declaring scope and the alias's declaration's own scoping keyword (`var` versus `let`/`const`).** A trio varying the TABLE's own module/function/block position would not exercise this fix at all — the gap requires the TABLE to be nested inside a block narrower than a full function, with a `var` alias declared in that same block, referenced outside it; case (ba)'s own construction (an `if`-block inside a function) is the minimal shape exhibiting the gap, and correlation shape 22 is the minimal shape proving the fix does not widen when no widening is needed (alias and table share the same function-body scope directly). Neither needs a module/function/block trio in the round 8/10 sense, since the axis that matters here is the alias's OWN declaration keyword, not the table's nesting depth as such.

**Round 19's three fixes split the same way round 16-18's own already do: two scope-independent, one the SAME genuinely-new axis case (ba) established, applied to a sibling recursion.** The `__proto__`-key check (case (bb)) is scope-independent for the identical, simplest reason round 9's and round 18's own condition-4 fixes already are: `literalHasUnmodeledThisReference` inspects an object literal's own direct children regardless of where the literal sits in the tree — no trio needed, mirroring cases (q)/(t)/(u)/(ax)'s own precedent. The `allReferencesTracked` node-type widening (case (bc)) is likewise scope-independent, for a reason closer to round 11 finding 2's than to round 8's: it changes which NODES the walk's own filter ever visits within whatever subtree it is already bounded to, with no notion of lexical position of its own — a shorthand-property escape is exactly as invisible to an `identifier`-only filter whether the table sits at module, function, or block scope, so no trio adds coverage a single case does not already provide. **The for-of recursion's `var`-kind boundary-widening (case (bd)) is NOT a new axis — it is the SAME axis case (ba) and correlation shape 22 already established for the sibling rebinding recursion, applied one binding further**: scope-dependent not on the TABLE's own position, but on the relationship between the table's declaring scope and the LOOP VARIABLE's own scoping keyword (`var` versus `let`/`const`/`using`) — case (bd) is the minimal shape exhibiting the gap (mirroring case (ba)'s own `if`-block-inside-a-function construction), and correlation shape 25 is the minimal shape proving the widening does not fire, and is not needed, for a `let`-kind loop variable. A reviewer verifying this fix should read case (ba)'s own commentary and this one side by side — the two recursions share the SAME widening helper and the SAME hazard (a port that fixes one call site and not the other passes every fixture neither call site's own guard shape overlaps with), not treat them as unrelated findings that happen to look similar.

**Round 20's fixes split three ways: two scope-independent for the identical reasons round 9/18/19 already established, two the SAME granularity axis applied to both existing widening call sites at once, one scope-independent for a reason closer to round 11 finding 2's, and the last (non-blocking) needing no trio at all for a different, simpler reason.** The unicode-escaped `__proto__`-key check (case (be)) is scope-independent for the identical reason case (bb) is: `literalHasUnmodeledThisReference` inspects an object literal's own direct children regardless of where the literal sits in the tree. The `globalThis`-qualified-read recognition (case (bh)) is scope-independent for the identical reason case (ap)'s own write-side sibling already is: the walk's new third node-matching case fires on the shape of a `member_expression`/`subscript_expression` alone, with no notion of the TABLE's own lexical position at all — a script-scope `var`'s own module-level nature is what makes the classic-script premise apply, not where any particular read of it sits. **Cases (bf) and (bg) are NOT a new axis — they are round 18's/19's own alias/for-of-boundary axis (case (ba)/correlation shape 22, case (bd)/correlation shape 25), corrected at its existing granularity, not extended to a new one**: the fix changes WHAT NODE the widening targets (a function's `body`, not the function itself), not WHEN it fires, so the SAME "scope-dependent on the relationship between the table's declaring scope and the alias/loop-variable's own scoping keyword" axis rounds 18/19 already established governs both cases unchanged — each needs exactly one instance, not a trio, for the identical reason cases (ba)/(bd) needed none. The bracket-subscript parenthesized-index fix (case (bi)) is the same shape as round 17's own bracket-subscript fix (case (at)) and round 18's own paren-layer fixes (case (az)): `subtreeContainsReassignmentOf`'s whole-file scan does not care where the table sits, so no trio is needed here either. UE-C's `call`/`apply`/`bind` rejection (case (bj), non-blocking) needs no trio for a reason none of this section's prior entries share: it is not a question about SHADOWING, RESOLUTION, or REASSIGNMENT at all — it narrows condition 3's own `isTrackedReferencePosition`, a pure structural check of a reference's immediate AST shape, with no notion of scope, module/function/block nesting, or lexical position anywhere in its own contract.

**What no tier catches, and what a human must check instead.** The escape analysis is a *judgment* about completeness, and no test can enumerate every JS shape that leaks an object identity. The tests above prove the recognised shapes are right and that the fail-safe default is `true`; they cannot prove the recognised set is exhaustive. **A reviewer must read `computeObjectLiteralSiteEscapes` (WU-2b) and its Rust mirror against `TRACKED_REFERENCE_PARENTS`, `isTrackedReferencePosition`, `literalHasUnmodeledThisReference` (round 9 rewrites its fall-through default; round 18 adds an unconditional getter exclusion, since a `this`-free getter body proves nothing about what it returns; round 19 adds a caller-side, key-shape-only check ahead of `isPositivelyThisFreeLiteral`'s own value-shape reasoning, for the one key — non-computed `__proto__` — that reasoning does not hold for), `allReferencesTracked` (round 8's own non-vacuous-coverage/declaring-scope exemption; round 18 adds a second, narrower exemption for a `method_definition`'s spurious name-field match, AND, separately, Greptile-flagged, widens the rebinding recursion's own search boundary for a `var`-declared alias specifically; round 19 widens the walk's own node-type filter to also match `shorthand_property_identifier`, and widens the SIBLING for-of recursion's own boundary the identical way round 18 widened the rebinding recursion's, for a `var`-kind loop variable specifically), AND (round 10) the identifier-resolution helpers those two shape-recognition functions call into — `resolveIdentifierValueThisReference`, `findResolvingScopeNode` (round 11, extended round 12, extended again round 16 for a `using_declaration` shadow, again round 17 for `switch_body` and `for_statement` variants of that same shadow plus an unconditional `with_statement` disjunct — layered on round 8's `findDeclaringScopeNode`, below it in the same call chain — and again round 18, REPLACING the round-17 `for_statement` disjunct with one keyed on the actual, parser-verified `ERROR` shape rather than a `using_declaration` node the grammar can never produce there), `findTopLevelFunctionNodeByName` (round 14 changes its own body for the first time, round 15 widens that same change further, round 16 widens it once more for a generator-shaped redeclaration — see below) together with `countHoistedVarScopeDeclarations`, the helper it calls into (round 15, extended round 17 for a `var`-kind for-in/for-of head), `subtreeContainsReassignmentOf` (round 13, extended round 14, extended again round 16 for a parenthesized target and a `globalThis`-qualified write, and again round 17 for the identical `var`-kind for-in/for-of widening on its own, independent gate, plus a Greptile-flagged `unwrapParens` consistency fix on its `update_expression` arm), and `unwrapParens`/`isGlobalObjectQualifiedWrite` (round 16), the latter extended again round 17 for a bracket-subscript spelling and again round 18 for a parenthesized global-object identifier, in both arms and at its own call site — and satisfy themselves — against the stated invariant, not just against parent-type membership — that every position/shape they do not accept is genuinely treated as an escape.** Round 10's own two findings are exactly what this last clause was added to name explicitly: both rounds 7 and 9 correctly reviewed WHICH shapes `literalHasUnmodeledThisReference` recognises, but neither round's review descended into HOW the identifier-valued shapes it recognises actually get resolved, which is precisely where both round-10 bugs hid. **Round 11 went one layer deeper still, and found that round 10's own fix — the very code this clause was written to demand closer reading of — had not itself been read closely enough**: finding 1 is a gap in `findDeclaringScopeNode`'s applicability (a `SCOPE_NODE_TYPES` exclusion that is correct for #2260 but incomplete for condition 4) that round 10's own review did not surface, and finding 2 is a REGRESSION that round 10's own fix introduced while opportunistically improving the `pair` arm — the first time in this plan's history that a review round's finding is a defect in a PRIOR round's fix, rather than in the original design. **Round 12 found that round 11's OWN fix for finding 1 was itself incomplete, not merely that the original design was** — `findResolvingScopeNode`'s new wrapper closed the for-in gap but shared `introducesShadowedBinding`'s pre-existing blind spot to a bare arrow parameter, the same class of "the fix for the fix needs its own audit" round 11 first named for round 10. **Round 13 found a gap on a different axis of the SAME resolution chain: resolving to an unshadowed, in-file declaration was never enough on its own, because that declaration's own MUTABILITY was never checked** — `findTopLevelFunctionNodeByName` deliberately accepts a `let`/`var` binding, not just `const`, and no round before this one asked whether the resolved binding is ever WRITTEN to elsewhere in the file, so a module-level `let run = () => {}` later reassigned to a `this`-using function resolved, unshadowed and un-reassignment-checked, straight to the arrow's own trivially safe body. This is not a defect in `findResolvingScopeNode`'s shadow walk, which round 13 does not touch at all (the shadow question and the reassignment question are independent — see that function's own doc comment) — it is a gap in what the REST of the resolution chain had ever asked, the same "the fix for the fix needs its own audit" pattern applied one layer further than round 12's. **Round 14 found that round 13's OWN fix — the very code the previous sentence's clause was written to demand closer reading of — had not itself been read closely enough, in two DIFFERENT and INDEPENDENT places, one in each of the two functions round 13's fix touches.** Finding 1: `subtreeContainsReassignmentOf`'s write-scan tested only `left?.type === 'identifier'` for the assignment branch, so any destructuring write was as invisible to round 13's OWN detector as the shadow and reassignment questions were to the code round 13 was fixing in the first place — the identical "the fix for the fix needs its own audit" pattern, one layer further still, applied to round 13's OWN new helper rather than to the pre-existing chain it was added to. Finding 2, independently: `findTopLevelFunctionNodeByName` — a function round 13's own doc comment explicitly says is "UNCHANGED" and "was never the bug" — turns out to have its own, PRE-EXISTING bug untouched by every round from 7 through 13: it returns the FIRST of several same-named top-level declarations, never asking whether a later one exists, the identical "confidently wrong rather than honestly unresolved" class every round since round 10 has been closing instances of, in the ONE place nobody had looked yet because round 10 explicitly said looking there was unnecessary. **Round 15 found a gap of a different KIND from every round before it: not a defect in a prior round's CODE fix, but a false claim in a prior round's own REASONING about that fix's scope.** Round 14's scope-coverage note (this section's own paragraph, above) asserted `findTopLevelFunctionNodeByName`'s redeclaration question was "structurally module-scope-only" because the function "never looks inside a function or block in the first place" — true of the pre-round-15 implementation, false of JS semantics: `var` hoists through a block, and Annex B extends the identical hazard to a block-level `function` declaration, so a SECOND declaration of `name` can exist entirely inside a nested block, invisible to round 14's own direct-children-only count. Round 14's own text asserted this variant could not exist at all, rather than merely noting it was unimplemented. This is not "the fix for the fix needs its own audit" (rounds 11-14's own recurring pattern, each finding a defect in a prior round's CODE) but its documentation-level analogue: the REASONING that scoped what needed fixing was itself unaudited, and stood uncorrected for one full round longer than the code gap it was reasoning about. **Round 16 found FOUR gaps at once, of two different kinds this section has already named separately but never together: three (the parenthesized-target write-scan and shadow disjuncts, #2630; the `using_declaration` shadow disjunct, #2632) are round 11/12's own "the fix for the fix needs its own audit" pattern — each a pre-existing blind spot in machinery ALREADY reviewed and trusted by name in this very paragraph (`findResolvingScopeNode` in round 11's own sentence above; `patternBindsName`, the primitive `subtreeContainsReassignmentOf` depends on but this paragraph had never separately named as its OWN audit target until now) — while the fourth (the `globalThis`-qualified write, #2634, and the generator-redeclaration gap, #2636) is round 15's own kind: not a defect in a prior round's code, but a FALSE CLAIM about that code's own safety — #2630's issue body claimed a parenthesized-target gap was uniformly "the safe direction," true for exactly one of its four named consumers and fail-open for the other three; #2636's issue body claimed its own gap was "fail-safe-already," true only when every redeclaration of the name is a generator, and confidently wrong the moment the redeclaration is mixed. Both false claims were caught only by attempting the counter-example the claim itself invited, exactly the discipline round 15's own sentence above demands of every future round, this one included.** **Round 17 closed one residual round 16 itself left standing (#2637 — the `switch_body` counterpart of round 16's own `statement_block` fix, flagged but not verified either way when round 16 landed), and, auditing every `SCOPE_NODE_TYPES` member for the identical gap rather than stopping there, found ONE more instance of the same #2637 shape — `for_statement`'s own case has the identical missing-`using_declaration` omission — closed the same way. Round 17 then found two further gaps this section's own enumeration had not yet reached: `countHoistedVarScopeDeclarations` and `subtreeContainsReassignmentOf`'s for-in branch each independently answer a narrower question than the constructs they exist to cover — a `var`-kind for-of/for-in loop head rebinds the SAME module-scope binding a direct `var` declaration created, but the former had no case recognising a `for_in_statement` as a declaration site at all, and the latter's own gate excluded any head carrying a `kind` field, `var` included, confusing "genuinely new binding" (true of `let`/`const`/`using`) with "carries a `kind` token" (true of all four); and `isGlobalObjectQualifiedWrite` recognised only the dot spelling of a global-object-qualified write, leaving the identical bracket-subscript spelling as invisible as the dot spelling itself was before round 16 closed it. All three are the same "confidently wrong rather than honestly unresolved" failure class every round since round 10 has been closing instances of, applied to constructs this section's own enumeration had not yet named — not a defect in a prior round's fix, and not a false claim about one either, but a fresh instance of the same recurring shape at a spelling/keyword variant this design had not yet enumerated. Round 17 also closed a SIXTH item, flagged by Greptile rather than found by this plan's own re-audit: `subtreeContainsReassignmentOf`'s `update_expression` arm was the one branch round 16's own #2630 fix left without `unwrapParens`. Verified, not merely argued, to be a pure consistency fix rather than a seventh instance of this paragraph's own recurring failure class: an update expression's own numeric-coercion semantics mean no construction through it alone can ever reassign a handler to a new function value, so this branch's pre-fix gap carried no soundness cost at all — the first item in this plan's history closed for symmetry alone, not because a live-reported-dead repro exists or could be built.** **Round 18 found a gap of a NEW kind this paragraph has not yet named: not a defect in a prior round's fix, and not a false claim about one, but a fix that was never REACHABLE in the first place — round 17's own `for_statement` disjunct scanned for a `using_declaration` node `tree-sitter-javascript@0.25.0`'s grammar can never produce in that position, verified by actually parsing the fixture with the real, installed parser rather than inferring the shape from the grammar source or from the fixture's own runtime behavior under Node. This is precisely why the fixture-verification standing rule (see `findResolvingScopeNode`'s own doc comment) now requires checking BOTH facts independently — that a snippet executes as intended, and that the parser this design actually analyzes with produces the node shape the fix keys on — rather than treating "verified runnable under Node" as proof of the second merely because it already proves the first.** Round 18 separately found three further gaps of the ordinary "confidently wrong rather than honestly unresolved" / "silently voting safe by omission" kind this paragraph already tracks, each on an axis not yet enumerated here: a getter's return value, not merely its own body, can carry an unmodeled `this` reference (`literalHasUnmodeledThisReference`); a `method_definition`'s bare property name is not a lexical binding, so treating it as one spuriously prunes genuine references (`allReferencesTracked`, the first finding in this paragraph's history against condition 3's own walk rather than condition 4's resolution chain); and a single paren layer around a global-object identifier defeats `isGlobalObjectQualifiedWrite` exactly as it would any other bare-identifier check this design has repeatedly had to route through `unwrapParens`. **A fifth, Greptile-flagged finding is on the SAME condition-3 walk as the `method_definition` one, but a different axis again**: `allReferencesTracked`'s rebinding recursion reuses the OUTER call's `declaringScope` for a `var`-declared alias exactly as it does for a `let`/`const` one, but a `var` alias's true visibility extends past whatever narrower block the original table happens to be declared in — the reused boundary is too narrow, and a genuine reference outside it is never visited. This is the reasoning that justified reuse (a prior round's own argument, not a defect in prior CODE) turning out to hold only for lexically-scoped aliases — the documentation-level failure kind round 15 first named, applied here to an argument about condition 3 rather than condition 4. **Round 19 found three further gaps, one of each kind this paragraph already distinguishes, and one self-inconsistency in round 18's own prior text.** First, a fresh instance of the ordinary "voting safe by omission" class: `isPositivelyThisFreeLiteral`'s `object`/`array` arms reason from the VALUE's own shape that reaching a nested function requires an extra property hop rebinding the receiver away from the table — true for every ordinary key, but false for a non-computed `__proto__` pair, which sets the table's own `[[Prototype]]` instead, with no hop at all; an axis ("does the KEY, not the VALUE, change the semantics") this paragraph's own enumeration of `literalHasUnmodeledThisReference`'s fixes had not yet reached. Second, the identical class applied to condition 3's own walk rather than condition 4's resolution chain, mirroring round 18's own `method_definition` finding one paragraph up: `allReferencesTracked`'s node-type filter matched `identifier` nodes only, so a binding forwarded by SHORTHAND property (`sink({ T })`) was invisible to the walk entirely — not classified untracked, simply never visited — the identical "the walk never looked, and doesn't know it never looked" shape round 8's own headline bug and round 18's `method_definition` carve-out both are, a THIRD instance of it, on a THIRD axis (a node-type omission in the walk's own reference filter, rather than a self-shadow or a spurious shadow). Third, a documentation-level self-inconsistency of the exact kind round 15 first named, but this time found in round 18's OWN prior text rather than in an issue body: round 18's var-alias boundary-widening essay closed with "a `let`/`const` alias (or a for-of loop variable, always block-scoped) is unaffected" — false, not merely imprecise, since a `var`-kind for-of/for-in HEAD is function-scoped exactly like a `var`-kind alias, a fact this same file's own round-17 fixes to `countHoistedVarScopeDeclarations` and `subtreeContainsReassignmentOf` already encode by testing `for_in_statement`'s `kind === 'var'`; round 18 widened the rebinding recursion's boundary and, in the same essay, asserted the SIBLING for-of recursion needed no equivalent widening, without ever checking whether that assertion was true. That review is the real gate on the soundness requirement; the WU-10 tests are a sample of it — and, as of round 8, that sample must itself span module, function, and block scope wherever the branch under test is scope-dependent (round 10's own Scope coverage note above states when a two-member, rather than three-member, trio is the correct sample; round 11's own note, extended by round 12's, round 13's, round 14's, round 15's, round 16's, round 17's, round 18's, round 19's, and round 20's, explains why none of their findings need one), not stand in for a single scope repeated across all 62 lettered cases. **Round 20 found a gap of a kind this paragraph names for the first time: not a defect in a prior round's fix, not a false claim about one, not an unreachable fix, but a fixture that PASSED its own round's newly-added ablation standing rule (round 19) only because the rule was never actually RUN against it** — round 19 wrote the rule, and, immediately afterward, added three of its own new fixtures without applying it to two of them. Ablating correlation shape 23's `computed_property_name` exclusion left it unchanged (a computed key's raw text structurally can never equal `__proto__` regardless, brackets included) — shape 23 never actually exercised the exclusion it claimed to guard. Ablating correlation shape 25's `kind === 'var'` gate also left it unchanged, for a DIFFERENT, coincidental reason: the (buggy, pre-round-20) unconditional widening this ablation forced landed on the enclosing function node itself, which round 20's own B2 finding shows self-shadow-prunes on an unrelated later declaration regardless of the gate — masking the ablation rather than revealing it. Both were found by mechanically applying round 19's own rule to round 19's own fixtures, the same audit discipline round 15 first demanded of a prior round's REASONING, applied here to a prior round's PROCESS instead: writing a standing rule and never checking it against the fixtures introduced in the same breath is not compliance with it. Separately, round 20 found and closed #2640 (B5) — carried, not fixed, since round 19's own review, in violation of the DIRECTION-labels standing rule's requirement that an `UNDER-escape` gap be fixed the round it is found — and one further genuine UNDER-escape gap of the ordinary kind, found by re-auditing `allReferencesTracked`'s own var-boundary-widening fix (round 18/19) against the self-shadow class round 8 already named once: widening to the enclosing FUNCTION rather than to that function's own `body` reopens round 8's bug one level up, for the boundary this design's own rounds 18/19 introduced (B2/B4). B1 (the unicode-escaped `__proto__` evasion) and G1/UE-C (both non-blocking, the latter Greptile- and self-audit-found respectively) are each a fresh instance of the ordinary "voting safe/tracked by omission" class, on axes this paragraph's own enumeration had not yet reached (a key's COOKED value versus its raw spelling; a parenthesized SUBSCRIPT INDEX as opposed to the subscript's own object; a reflective `.bind`/`.call`/`.apply` call shape the general extractor already treats specially for an unrelated reason).

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
| Tightening turns a conservative false negative into a **false positive** (live code reported dead) | Structural, not incidental: T1 is reachable only when `escapes === false`, and `escapes` defaults `true` on every unrecognised shape (WU-2b). Escaping sites take T2 — today's exact predicate. Gated by `tests/integration/issue-2088-escape-fallback.test.ts` (WU-10), which asserts both the classification *and* `escapes = 1`, so it fails if the guard is bypassed rather than passing on the wrong tier. Round 6 found and closed four such gaps (the alias, parameter-flow, same-literal `this`, and bare-read branches); round 7 re-applied the SAME invariant test to the round-6 result itself and found and closed five more (array-owned container calls, for-of loop-variable forwarding, identifier-valued `this`, interpolated template keys, and the owner `bindingName`/`key` contract) — see the round-7 annotations throughout WU-2b and the six new WU-10 cases (i)–(n) added to gate them. **Round 8 found the deepest gap yet by re-applying the same invariant test to the WALK ITSELF rather than to another reference position**: the shadow-prune `allReferencesTracked` reused (`introducesShadowedBinding`) self-shadows the site's own declaring scope whenever that scope is not the module (every fixture through round 7 was module-scope, which is why this survived seven rounds), silently vacuously "tracking" a table that was never actually examined at all — a strictly worse failure than any round-6/7 gap, since those each mis-tracked one REACHED reference, while this one meant entire scopes were never reached. Closed two ways, not one: (a) the walk is now rooted at, and exempts from the shadow-prune, only the site's own declaring scope (mirroring `hasLaterReferenceInEnclosingBlock`'s existing, narrower carve-out for the identical trap); and (b) a new standing rule requires the walk to PROVE it was exhaustive — any truncation now forces `escapes = true` unconditionally — so a FUTURE walk bug of this same shape fails closed instead of silently passing, rather than relying on finding every instance of it by inspection one round at a time. Round 8 also fixed a second, independent bug in the same area (`bindingName` could inherit a `#line` suffix `allReferencesTracked` could never match against real identifier text — the same "structurally can never match" failure mode finding 5 already named for `A[*]`) and a third in `isTrackedReferencePosition`'s subscript branch (the `$`-guard was mirrored onto `template_string` only, not `string`, so `T['co$t']()` was wrongly accepted — Greptile flagged this independently on this PR). See the round-8 annotations throughout WU-2b, the withdrawn round-7 vacuous-truth argument, and WU-10 correlation shapes 4–5 plus escape-fallback cases (o)–(p). **Round 9 found a gap of the SAME class in condition 4 specifically**: `literalHasUnmodeledThisReference` was a positive-only detector that silently voted non-escaping (rather than escaping) on any shape it did not recognise — a `spread_element`, or a `pair` valued by a `call_expression`/`parenthesized_expression`/other unrecognised expression — the exact inversion of this row's own stated mitigation, which through round 8 was true of every OTHER condition but not yet of condition 4's own internals. Closed by rewriting the function to the same fail-closed contract, now stated once at the level of `computeObjectLiteralSiteEscapes` itself (a standing rule, mirroring round 8's `allReferencesTracked`-specific one) so a future predicate cannot repeat this exact class of gap unnoticed. See the round-9 annotations in WU-2b and WU-10 correlation shapes 6–7 plus escape-fallback cases (q)–(u). **Round 10 found that condition 4's identifier-RESOLUTION chain — one layer beneath the shape-recognition switch round 9 rewrote — still violated a fail-closed discipline in two places, both flagged independently (finding 1 by Greptile, "Shadowed handler resolves incorrectly").** Finding 1: `findTopLevelFunctionNodeByName` searches DOWN from the module root only, so a function-scoped shorthand/pair-identifier property that shadows a same-named MODULE-level declaration resolved to the WRONG (module-level) function with full confidence — worse than round 8's vacuous-truth bug, because a sub-predicate returning a confidently wrong answer gives downstream code no signal anything is amiss, whereas an honest "unresolved" at least triggers the caller's own fail-safe. Finding 2: the shorthand arm's `!BUILTIN_GLOBALS.has(name)` guard short-circuited to a silent non-escaping vote for ANY builtin-named property, shadowed or not — exactly the round-9 standing rule's forbidden outcome, just in a helper round 9's own audit did not reach. Closed by resolving OUTWARD from the object literal via `findDeclaringScopeNode` (reusing round 8's own helper) before ever falling back to the module-level search, and by unifying both arms' builtin guard into one shared `isUnshadowedBuiltinGlobal(name, definitionNames)` predicate that skips resolution only for a genuinely unshadowed global. See the round-10 essay in WU-2b, `resolveIdentifierValueThisReference`'s and `findTopLevelFunctionNodeByName`'s own doc comments, and WU-10 escape-fallback cases (v)–(z). **Round 11 found that round 10's own two fixes each had a further problem — the first time in this plan's history that a finding is a defect in a PRIOR round's fix rather than in the original design.** Finding 1: `findDeclaringScopeNode`'s ancestor walk cannot see a `for...of`/`for...in` loop-head binding, because its `SCOPE_NODE_TYPES` deliberately excludes `for_in_statement` for a DIFFERENT reason (#2260's own reference-walk boundary — a genuine read in the loop's `right` expression must survive) that does not apply to condition 4's resolution question — a loop variable shadows a same-named module-level decoy exactly like any other scope's binding does for THAT question, and the pre-round-11 code resolved to the decoy with full confidence instead. Closed by a new, resolution-path-ONLY wrapper, `findResolvingScopeNode`, that ORs the existing shadow check with a `for_in_statement`-head test — `findDeclaringScopeNode`/`SCOPE_NODE_TYPES` themselves are untouched, so `allReferencesTracked`'s own, already-verified-sound use of them (condition 3, round 8) is unaffected. Finding 2: `isUnshadowedBuiltinGlobal` treats a builtin-named IMPORT as an unshadowed global, because `definitionNames` (built from `symbols.definitions`) excludes imports by construction — making round 10's own `pair`-arm recall improvement a REGRESSION, not merely an incomplete fix, since through round 9 the `pair` arm always escaped unconditionally on a builtin name. Closed by reverting the improvement rather than patching it: both arms now escape unconditionally on any `BUILTIN_GLOBALS` name, `isUnshadowedBuiltinGlobal` is deleted, and crediting a genuinely unshadowed builtin (imports included) as safe is filed as its own follow-up rather than re-attempted inline. See the round-11 essay in WU-2b, `findResolvingScopeNode`'s own doc comment, and WU-10 escape-fallback cases (aa)–(ac). **Round 12 found that round 11's own finding-1 fix — `findResolvingScopeNode` — was itself incomplete: its ancestor walk ORs in a `for_in_statement` disjunct but still falls through, for every OTHER ancestor type, to `introducesShadowedBinding`, whose shared function-shape case reads only the plural `parameters` field and so cannot see a BARE, unparenthesized single-identifier arrow parameter (`run => {…}`) — a shape tree-sitter-javascript carries in a separate, singular `parameter` field (verified against `tree-sitter-javascript@0.25.0`'s own `node-types.json`), which the `catch_clause` case two lines below already reads for its own binding.** A same-named module-level decoy shadowed only by such a bare arrow parameter resolved, pre-round-12, to the decoy with full confidence, the identical failure mode finding 1 named twice already. Closed the same way as the for-in case: one more disjunct ORed onto `findResolvingScopeNode` alone, checked only there — `introducesShadowedBinding`/`SCOPE_NODE_TYPES` are again left untouched, and the pre-existing primitive's own blind spot to this same field (which affects `allReferencesTracked`'s reference walk too, in the conservative direction only — over-inclusion, never unsoundness) is filed separately as #2629 rather than widened inline. See `findResolvingScopeNode`'s own doc comment (round 12) and WU-10 escape-fallback case (ad). **Round 13 found a gap on a different axis of the same resolution chain: a resolved, unshadowed, in-file declaration is not `this`-free just because it currently reads that way — it must also never be REASSIGNED.** `findTopLevelFunctionNodeByName` deliberately resolves a `function_declaration`, a `lexical_declaration` (`let`), or a `variable_declaration` (`var`) — every one of which is a MUTABLE binding — and nothing before round 13 asked whether the resolved binding is ever WRITTEN to elsewhere in the file: a module-level `let run = () => {}` later reassigned, as a plain top-level statement, to a `this`-using function resolved to the arrow's own genuinely `this`-free body with full confidence, the identical "confidently wrong rather than honestly unresolved" failure class rounds 10–12 already closed for other gaps in this same chain. This is also a regression against today: `collectInvokedPropertyNames` credits any non-empty receiver regardless of which function currently occupies the binding, so the affected handler is currently (pre-#2088) live. Closed by a new helper, `subtreeContainsReassignmentOf`, that fails safe unconditionally the moment it finds ANY write to the resolved name anywhere in the file (a plain or augmented assignment, an update expression, or a declaration-less for-in/for-of loop-head target) — checked after the module-level search resolves a node but before the arrow-function branch ever trusts it, and deliberately not attempting to resolve what the write assigns, the same "detect, then fail safe outright" choice round 10 already made for a shadowing declaration. `findResolvingScopeNode`, `introducesShadowedBinding`, and `SCOPE_NODE_TYPES` are untouched — the shadow question and the reassignment question are independent, and this round answers only the second. See the round-13 essay in `resolveIdentifierValueThisReference`'s own doc comment, `subtreeContainsReassignmentOf`'s own doc comment, and WU-10 escape-fallback case (ae). **Round 14 found two further gaps, each independent, one in each of the two functions round 13's fix touches.** Finding 1: `subtreeContainsReassignmentOf`'s own assignment-expression branch tested only a bare `identifier` on `left`, so a destructuring write — `[run] = [fn]`, `({ run } = o)` — slipped past round 13's OWN new detector exactly as round 13's counter-example slipped past the pre-round-13 code, one AST shape over; Greptile flagged this independently ("Destructuring writes bypass reassignment tracking"). Closed by routing that branch through `patternBindsName`, the SAME primitive this function's own for-in branch, `blockContainsIdentifierExcluding`'s assignment branch, and `killsBinding`'s assignment branch already use for the identical field — this function was the one outlier using a narrower, ad hoc test, not a function needing a new primitive invented for it. Still cannot see a parenthesized target (`(run) = fn`) — `patternBindsName` itself has no such case — tracked, not silently accepted, at #2630 (now naming this arm as a fourth affected consumer, alongside the for-in disjunct in `findResolvingScopeNode`, the for-in branch in `blockContainsIdentifierExcluding`, and this function's OWN for-in branch). Finding 2, independent of finding 1: `findTopLevelFunctionNodeByName` — the function round 13's own doc comment explicitly said was "UNCHANGED" and "was never the bug" — returns the FIRST of several same-named top-level declarations and stops, never asking whether a SECOND one exists; a `var run = () => {}; var run = function () { return this.alpha(); };` redeclaration (legal in both an ES module and CommonJS) or a duplicate sibling `function run(){…}` (legal in CommonJS; a `SyntaxError` under an ES module) resolves to the FIRST, `this`-free declaration with full confidence, though the runtime binding is always the LAST — the identical "confidently wrong rather than honestly unresolved" failure class rounds 10–13 already closed elsewhere in this chain, found this round in the one place round 10's own doc comment said needed no further look. Closed by making this function count every top-level declaration of the name and return `null`, fail-safe, once more than one exists, rather than the first — the FIRST round in this plan's history in which `findTopLevelFunctionNodeByName`'s own body, not merely its caller's, changes. See the round-14 essays in `subtreeContainsReassignmentOf`'s and `findTopLevelFunctionNodeByName`'s own doc comments, and WU-10 escape-fallback cases (af)–(ai). **Round 15 found that `findTopLevelFunctionNodeByName`'s own round-14 fix was itself incomplete, in the SAME "confidently wrong rather than honestly unresolved" failure class, one hoisting hop further: the declaration count only ever walked `root`'s DIRECT children, so a SECOND declaration of `name` reachable only by `var`-hoisting through a nested block (or, in sloppy-mode code, Annex B's identical block-level-function hoisting) was invisible to it entirely** — `var run = () => {}; if (cond) { var run = function () { return this.alpha(); }; }` resolves, pre-round-15, to the FIRST, `this`-free declaration with full confidence, verified runnable under real Node to invoke the SECOND, `this`-using one on every call. This is also a regression against today, for the identical reason round 13's and round 14's own gaps were: `collectInvokedPropertyNames` credits any non-empty receiver regardless of which declaration currently occupies the binding. Closed by generalising the count from "direct children of `root`" to "the module's own var scope" — a new `countHoistedVarScopeDeclarations` reuses `functionScopeDeclaresVar`'s own traversal rule (skip a nested function's own scope) to additionally count a `var` declarator or block-level `function` declaration hoisted from any nested block, while deliberately EXCLUDING a `let`/`const` in the identical position, which is a genuinely different, block-scoped binding already covered by the shadow axis (`findResolvingScopeNode`) — verified not to over-fire by WU-10's new correlation shape 8. See the round-15 essay in `findTopLevelFunctionNodeByName`'s own doc comment, and WU-10 escape-fallback cases (aj)–(ak). **Round 16 found four further gaps, closing an audit finding that ANY tracked exclusion left standing under this row's own "conservative false negative" framing must actually BE conservative-direction, which two of the four were not.** First and second: `patternBindsName` (the shared primitive `subtreeContainsReassignmentOf`'s write-scan and `findResolvingScopeNode`'s for-in disjunct both call) has no case for a `parenthesized_expression` target — `(run) = fn`, `for ((run) of iter)` as a write, and the identical shape as an ancestor loop-head shadow — three independent call sites (#2630) confidently resolving to a stale or shadowed declaration instead of failing safe. Third: `introducesShadowedBinding`'s `statement_block` case has no `using_declaration` branch, so a block-scoped Explicit-Resource-Management shadow is invisible to `findResolvingScopeNode` (#2632). Fourth: `subtreeContainsReassignmentOf` has no case for a script-scope `var` reassigned through the global object (`globalThis.name = …`/`global`/`self`/`window`) rather than the bare identifier (#2634). All four are closed WITHOUT widening `patternBindsName` or `introducesShadowedBinding` themselves — a small local `unwrapParens` helper at the three affected call sites, a fourth disjunct on `findResolvingScopeNode`'s own walk (not on the shared primitive both it and condition 3 depend on), and a new `isGlobalObjectQualifiedWrite` check on `subtreeContainsReassignmentOf`'s own assignment branch — mirroring the "fix the resolution-only wrapper, not the shared walk" discipline rounds 11/12 already established. **Two further findings this round are corrections to prior CLAIMS, not to code, of the same kind round 15's own text needed correcting for a different function**: #2630's issue body called its gap uniformly "the safe direction," true only for `blockContainsIdentifierExcluding`'s own for-in branch (condition 3, a conjunction over every found reference, where a missed shadow can only ADD a spurious candidate — conservative by construction) and false for the other three consumers, which are single fail-safe branches where a missed shadow REMOVES the branch that would have fired, letting a confidently-wrong resolution through unchallenged — fail-OPEN, not conservative; and #2636's issue body called its gap "fail-safe-already… since nothing ever returns such a node as `result` either," true only when EVERY redeclaration of the name is a generator, and confidently wrong in the mixed plain-then-generator case a corrected reading surfaces. Also found, and separately closed, a FIFTH gap in `findTopLevelFunctionNodeByName`'s own direct-children loop: a top-level `generator_function_declaration` is a distinct grammar kind from `function_declaration`, invisible to both round 14's original redeclaration count and round 15's own hoisted extension, so a mixed plain-then-generator top-level redeclaration resolved to the FIRST, stale declaration with full confidence rather than failing safe on the ambiguity — #2636, same failure class as round 14 finding 2's and round 15's own duplicate-declaration gaps, closed by giving `generator_function_declaration` its own branch in the direct-children loop alone (NOT in `countHoistedVarScopeDeclarations`'s own recursive hoisting walk — verified empirically against real Node that Annex B never extends block-level hoisting to a generator declaration, so a NESTED generator does not redeclare the outer binding and remains correctly, exclusively the shadow axis's own concern). See the round-16 essays in `findResolvingScopeNode`'s, `subtreeContainsReassignmentOf`'s, `findTopLevelFunctionNodeByName`'s, and `countHoistedVarScopeDeclarations`'s own doc comments, and WU-10 escape-fallback cases (al)–(aq) plus correlation shapes 9–12. **Round 17 closed a residual round 16 itself left standing — #2637, `introducesShadowedBinding`'s `switch_body` case carrying the identical missing-`using_declaration` gap its `statement_block` case did — and, auditing every OTHER `SCOPE_NODE_TYPES` member for the identical gap rather than stopping there, found ONE more instance: its `for_statement` case has the same omission.** Both closed the same way round 16 closed the `statement_block` one: a disjunct on `findResolvingScopeNode` alone, not on the shared `introducesShadowedBinding` primitive. **Separately, round 17 found two further gaps of a different kind, each spanning a construct this row's own enumeration had not yet reached.** First: a `var`-kind for-of/for-in loop head (`for (var name of iter)`) rebinds the SAME module-scope binding a direct top-level `var` declaration created, since `var` is function-scoped, not block-scoped — but `subtreeContainsReassignmentOf`'s own for-in gate excluded ANY head carrying a `kind` field, `var` included, conflating "carries a `kind` token" with "declares a genuinely new binding" (true only of `let`/`const`/`using`); and `countHoistedVarScopeDeclarations` had no case recognising a `for_in_statement` as a hoisted declaration site at all, since the grammar places its `kind`/`left` fields directly under `for_in_statement`, never wrapped in a `variable_declaration` node the way a bare-block `var name;` is. Both closed independently — a widened gate on the former, a new branch on the latter — neither relying on the other alone. Second: `isGlobalObjectQualifiedWrite` (round 16) recognised only the `member_expression` (dot) spelling of a global-object-qualified write; the identical write spelled with bracket-subscript notation (`globalThis['name'] = …`) is a `subscript_expression`, invisible for the identical reason the dot spelling was before round 16 — closed by a new `subscript_expression` arm reusing `isTrackedReferencePosition`'s own static-key normalisation verbatim. **Also, round 17 corrected this row's own prior framing of `with`:** grouped alongside `eval` as something "no static analysis can see through" wherever this row's history has mentioned it, `with`'s RESOLUTION target genuinely is undecidable statically, but its mere PRESENCE as an ancestor is an ordinary, detectable AST node — closed by a new, unconditional `with_statement` disjunct on `findResolvingScopeNode`, gated on no more than the ancestor's own node type, never on `name`. All five fixes are closed WITHOUT widening `patternBindsName`, `introducesShadowedBinding`, or `SCOPE_NODE_TYPES` themselves. See the round-17 essays in `findResolvingScopeNode`'s, `countHoistedVarScopeDeclarations`'s, `subtreeContainsReassignmentOf`'s, and `isGlobalObjectQualifiedWrite`'s own doc comments, and WU-10 escape-fallback cases (ar)–(av) plus correlation shapes 13–17. **A sixth item Greptile flagged on this same round's own commit — `subtreeContainsReassignmentOf`'s `update_expression` branch reads its `argument` directly, never through `unwrapParens`, the one branch of the three round 16's own #2630 fix did not touch — is NOT a seventh false-positive risk, verified empirically rather than assumed: an update expression's own `ToNumeric` coercion means `(name)++`/`(name)--` can never reassign `name` to an arbitrary new function value in the first place, so no construction through this branch alone can turn a genuinely `this`-using handler into one wrongly read as `this`-free.** Fixed anyway, for structural consistency with its two siblings, and guarded by correlation shape 18 — but not narrated here as a false-positive risk this row exists to track, since none exists. **Round 18 found that round 17's OWN `for_statement` disjunct — the fix this row's own round-17 entry just described — was never reachable: it scanned for a `using_declaration` node that `tree-sitter-javascript@0.25.0`'s grammar cannot produce as a `for_statement` initializer (verified against `grammar.js:375-390` and `node-types.json`'s own field schema, and against the real parser directly: the broken text surfaces as an `ERROR` node instead), so the disjunct's own `child?.type === 'using_declaration'` test could never match anything. This is a NEW failure kind for this row: not a gap the design failed to close, and not a false claim about what a fix costs, but a fix that was never executed at all despite looking, and reading, exactly like every other disjunct in this same function.** Closed by keying on the actual parse shape — an `ERROR` node whose text begins with `using`/`await using`, checked both as a direct child (the plain spelling) and one level deeper (the `await using` spelling, which nests inside a misparsed `assignment_expression` since `await` outside an async function is an ordinary identifier) — and failing safe UNCONDITIONALLY, the same shape the `with_statement` disjunct already uses. #2637 is reopened (it was closed on the strength of the unreachable fix) and re-closed by this one. **A standing rule is added because of this: every fixture in this plan must be parsed with the real `tree-sitter-javascript` grammar, and the node type(s) a fix keys on must be confirmed present in the resulting tree — a claim that a snippet "parses/runs under Node" is a claim about V8's own parser, never about tree-sitter's, and this design's fixtures must verify both facts independently rather than inferring one from the other** (see `findResolvingScopeNode`'s own doc comment for the full essay). Round 18 separately closes three further UNDER-escape gaps, none previously named by this row: `literalHasUnmodeledThisReference`'s `method_definition` arm proved safety only via `subtreeContainsThisKeyword`, sound for a plain method but not for a GETTER — a getter's own body can be entirely `this`-free while RETURNING a value that, once accessed then called (`T.k()`), binds `this` to the receiver regardless of how the callee was obtained; closed by treating a `get`-flavoured `method_definition` as escaping unconditionally, a plain method's and a setter's own checks unchanged. `allReferencesTracked` reused `introducesShadowedBinding`'s shared function-shape case, whose `method_definition` alternative treats the node's own PROPERTY NAME as a binding the same way a function/class declaration's NAME field genuinely is — but a method's property key is not a lexical binding at all, so a nested method merely NAMED the same as the tracked binding spuriously prunes its entire body, hiding a genuine reference exactly as round 8's own self-shadow bug did, via a different mechanism (a false-positive shadow at a nested scope, not a self-shadow at the declaring one); closed entirely in this consumer, re-deriving `introducesShadowedBinding`'s own two GENUINE sub-checks (parameter binding, hoisted `var`) for this one node kind without touching the shared primitive itself. `isGlobalObjectQualifiedWrite` required `object.type === 'identifier'` in both arms, so a single paren layer around just the global-object identifier (`(globalThis).run = …`) defeated it entirely, the identical class of gap #2634/round 17's bracket-subscript fix each closed for their own spelling; closed by routing `object` through the existing `unwrapParens` in both arms, and at the function's own call site. All three are fixed the round they were found, per the standing rule below; none is filed as an accepted exclusion, except the getter fix's own necessary narrowing (an otherwise-harmless getter now also escapes) — see Success Criteria. **A fifth item, flagged by Greptile rather than found by this plan's own re-audit, closes a gap in `allReferencesTracked`'s rebinding recursion (condition 3): reusing the outer call's `declaringScope` for a recursive alias check is sound only when the alias is lexically (`let`/`const`) scoped, since only then is its visibility guaranteed to stay inside that same boundary — a `var`-declared alias is function-scoped and can be genuinely referenced outside a narrower block the table itself sits in, a region the reused boundary never reaches.** Closed by widening the recursive call's own boundary to the alias's nearest enclosing function (or root) specifically when its declarator is `var`-kind; a `let`/`const` alias is unaffected. `SCOPE_NODE_TYPES`/`introducesShadowedBinding`/`findDeclaringScopeNode` remain untouched. **Round 19 found three further UNDER-escape gaps, all fixed the round they were found, per the standing rule — the first two independent of one another, the third a correction to round 18's OWN prior text rather than to code.** First: `isPositivelyThisFreeLiteral`'s `object`/`array` arms reason that reaching a nested function requires an extra property hop rebinding the receiver away from the table — sound for every ordinary key, unsound for the one key the language treats specially: a non-computed `__proto__` pair sets the table's own `[[Prototype]]` (ECMA-262 Annex B.3.1) rather than an ordinary own property, so a method reachable through it binds `this` to the table directly, with no hop at all. Closed by a caller-side check on the `pair`'s own KEY, ahead of any value-shape reasoning — escaping unconditionally on a non-computed `__proto__` key, regardless of the value's own shape — rather than narrowing `isPositivelyThisFreeLiteral` itself; a COMPUTED `['__proto__']` key is deliberately excluded, since Annex B.3.1 gives it no such special meaning and it creates an ordinary own property like any other computed key. Second, on condition 3's own walk rather than condition 4's resolution chain, the identical class round 8's headline bug and round 18's `method_definition` carve-out already are: `allReferencesTracked`'s reference-matching filter recognised `identifier` nodes only, so a binding forwarded into an external function by SHORTHAND property (`sink({ T })`) was invisible to the walk entirely — not classified untracked, simply never visited, since a shorthand property parses to a `shorthand_property_identifier`, a distinct node kind. Closed by widening the filter to match both node kinds; a `property_identifier` (an ordinary object-literal KEY) is deliberately excluded, since a key is never itself a value-producing reference to any binding. Third: round 18's own var-alias boundary-widening essay claimed, without checking, that a for-of loop variable was "always block-scoped" and therefore needed no equivalent widening to the one round 18 gave the rebinding recursion — false, since a `var`-kind for-of/for-in head is function-scoped exactly like a `var`-kind alias, a fact this file's own round-17 fixes to `countHoistedVarScopeDeclarations` and `subtreeContainsReassignmentOf` already encode. Closed by widening the for-of recursion's own boundary the identical way, gated on the identical `kind === 'var'` field test; a `let`/`const` for-of head is unaffected. None of the three is filed as a standing exclusion. **Round 20 found five further UNDER-escape gaps (three of them, B3/B4, corrections to round 19's OWN fixtures rather than to code) and closed a sixth, carried gap (#2640) this row's own standing rule already forbade carrying.** First (B1): round 19's own `__proto__`-key check compares `key.text` — RAW source text — to the literal string `__proto__`, blind to an equivalent key spelled with a unicode escape sequence, which cooks to the identical string and triggers the identical Annex B.3.1 magic; closed by additionally fail-safing on any backslash in a non-computed key's own raw text. Second (B2): the round-18/19 var-boundary-widening fixes (immediately above) widen the rebinding-alias and for-of recursions' own `declaringScope` to the enclosing FUNCTION-shape node — but the walk's later, unrelated descent into that node's own `body` (a DIFFERENT node from the exempted `declaringScope`) can self-shadow-prune the WHOLE body on a co-located `function`/`class` declaration merely sharing the alias/loop-variable's name, round 8's own self-shadow class recurring one level up on a boundary rounds 18/19 introduced; closed by widening to that node's own `body` field instead, reusing round 8's existing exemption mechanism unchanged rather than adding a second, bespoke one. Third and fourth (B3/B4): round 19's own correlation shapes 23 and 25, meant to guard the `__proto__`-key exclusion and the for-of widening's `kind === 'var'` gate respectively, were each VACUOUS — ablating what they claimed to guard left `escapes` unchanged in both cases (shape 23: a computed key's raw text structurally can never equal `__proto__` regardless of the exclusion, brackets included; shape 25: the pre-fix widening's own B2 bug masked the ablation by self-shadow-pruning the unrelated declaration the shape depends on) — found by applying round 19's OWN newly-written ablation standing rule to round 19's own new fixtures, which round 19 never did. Fixing B2 is what makes shape 25 non-vacuous; shape 23 is separately rebuilt with an escaped computed key, which discriminates for the round-20 backslash fail-safe specifically. Fifth: #2640 (a classic-script `globalThis.T.alpha()` READ, symmetric to round 16's own write-side #2634) was filed at round 19's own review as an explicitly flagged departure from this row's/Success Criteria's standing rule that an `UNDER-escape` gap must be fixed the round it is found — round 20 closes it rather than extending the departure, giving `allReferencesTracked`'s own candidate-matching walk a third, structural (not text-based) way to recognise a reference, reusing `isGlobalObjectQualifiedWrite` verbatim from its existing write-side role. Separately, non-blocking: a Greptile-flagged parenthesized-INDEX gap in `isGlobalObjectQualifiedWrite`'s bracket-subscript arm (G1 — `globalThis[('name')] = …`, the index-side counterpart of round 18's own object-side paren fix) and a call/apply/bind rejection in `isTrackedReferencePosition` (UE-C — the pre-existing, general call extractor already strips the receiver from any `<expr>.bind(…)`-shaped call regardless of context, so accepting such a reference as tracked credits a correlation that can never materialise) are both fixed the round they were found. `SCOPE_NODE_TYPES`, `introducesShadowedBinding`, `patternBindsName`, and `findDeclaringScopeNode` remain untouched by all of B1–B5/G1/UE-C. None of round 20's five blocking findings is filed as a standing exclusion. |
| `findDeclaringScopeNode` (round 8, condition 3's reference-walk boundary, #2260) and `findResolvingScopeNode` (round 11, condition 4's identifier-resolution question) are two near-identical ancestor walks over the same AST, sharing `introducesShadowedBinding` as a base check but each layering its OWN, different disjuncts on top (`findResolvingScopeNode`'s `for_in_statement` and `arrow_function`/`parameter` disjuncts, rounds 11–12; its `statement_block`/`using_declaration` disjunct, round 16; and its `switch_body`/`for_statement`/`using_declaration` and unconditional `with_statement` disjuncts, round 17) — a future round could "simplify" by unifying them into one parameterised walk, silently widening condition 3's already-verified-sound walk (reopening the genuine `for (const x of fn())`/bare-arrow-parameter read `SCOPE_NODE_TYPES` and `introducesShadowedBinding` themselves protect) or under-covering condition 4's resolution question if the merge goes the other way | Each walk OWNS one question, and a future round must not merge them without re-verifying both from scratch: `findDeclaringScopeNode` answers "does some ancestor shadow this SITE'S OWN binding, for the reference-walk boundary #2260 needs" and must never gain a resolution-only disjunct; `findResolvingScopeNode` answers "does some ancestor shadow this IDENTIFIER, for condition 4's resolution question" and is the only one of the two allowed to grow resolution-only disjuncts (rounds 11, 12). See `findResolvingScopeNode`'s own doc comment (round 11) for why they are two functions layered on a shared base rather than one. |
| WU-5's `collectInvokedPropertySites` resolves calls against the WRONG file's points-to map (ROUND 9, #2088 finding 2) — silently under-populates T1, the exact false-dead class this plan is gated on, in a way no single-file fixture can reveal | `collectInvokedPropertyNames`/`computedDispatchTableEvidence` are pure name/file aggregations needing no points-to information, so `buildCallEdgesJS` builds them once, globally, before any file's points-to map exists. `collectInvokedPropertySites` cannot use that same pre-loop position unchanged, because resolving a receiver is inherently per-file. Mitigated structurally, not by convention: `buildCallEdgesJS` is restructured into three explicit passes (pts pre-pass → evidence assembly → per-file edge resolution, WU-5(a)), and `collectInvokedPropertySites`'s own signature is keyed by file (`ReadonlyMap<string, Iterable<Call>>` plus a `relPath`-aware `resolveReceiverSites`) rather than a flattened list, so a caller cannot wire it up without supplying the right map for each file. Gated by WU-10 correlation shape 7, a two-file fixture built specifically because every other WU-10 fixture is single-file and so cannot distinguish "resolved against the right map" from "resolved against the only map." Mirrored on the Rust side, where `EdgeContext::new` has the identical ordering shape (WU-8's own pass-ordering note). |
| Reviewer objection: "this contradicts §8.3's field-based decision" | Pre-rebutted in [Reconciling the tension](#reconciling-the-tension-with-roadmap-83-field-based-not-field-sensitive): field-sensitivity and allocation-site abstraction are orthogonal axes, and §8.3's own Approach block already commits to allocation-site abstraction. The pts lattice stays field-based; the `site\|key` set is computed outside the solver. |
| Reviewer objection: "this duplicates #2260's `receiver` channel" | It does not — T3 is kept name-keyed, unconditional, and untouched (WU-5b). #2088 adds a third tier beside it. The array-literal gap in #2260's own channel is filed separately as #2611 rather than folded in. |
| New `ExtractorOutput` field silently dropped at the Worker boundary | ADR-002 §Costs.2 names this the primary parity risk, so it is its own work unit (WU-3) with its own verification, following the `computedDispatchTableEvidence` precedent in the same three files. `Call.objectLiteralSite` needs no protocol edit — verified by reading `wasm-worker-protocol.ts:51` (`calls: Call[]`, passed whole), not assumed. |
| WASM/native escape-bit drift | The bit is persisted in `object_literal_sites`, so a divergence is directly observable by diffing that table between engine runs rather than only inferable from a differing `roles` output. WU-10 runs every integration assertion under both engines; `/parity` gates. |
| Solver cost grows with object-literal count | Constraints added are O(sites) + O(callAssignments with a matching `::return` key), and the `callAssignments` loop is guarded on that key existing, so it adds no rows for the common case. `MAX_SOLVER_ITERATIONS` is unchanged at 50. `npm run benchmark` is in the verification block; a >5% full-build regression on this repo is reported, not absorbed. |
| Full-vs-incremental divergence in the new channel | Both new tables are persisted and purged per file exactly as `invoked_property_names` (#2087) is — WU-5(c), WU-6. This is deliberately *not* the shortcut #2260 took, whose in-memory-only aggregation is filed as #2610. |
| Scope growth during implementation | Two adjacent findings were filed as issues before this plan was written (#2610, #2611) rather than absorbed. Every review round since has kept the same discipline for findings that narrow the escape-analysis design rather than fix it (#2617–#2620 from rounds 4–6; #2621–#2623 from round 7) — see the Success Criteria exclusion list. Round 8 filed no new follow-up issues: all three of its findings are soundness fixes to what earlier rounds already claimed the design covers, not new named exclusions from it — see the Success Criteria note on round 8 for why that distinction matters here specifically. **Round 9 filed one — #2624** — because, unlike round 8's findings, inverting condition 4's default genuinely narrows recall for shapes the pre-round-9 code (incorrectly) accepted: an object literal using object-spread, or a pair valued by anything other than the positively-safe enumeration, now escapes where it previously (unsoundly) did not. Finding 2 (the WU-5 pass-ordering fix) filed no issue: it is a soundness/buildability fix to how a not-yet-implemented WU is sequenced, not a narrowing of any capability the design claims. **Round 10 filed one of its own two findings — #2625** — for finding 1: failing safe on ANY non-module shadowing scope, rather than fully resolving into it, costs recall for a shadowing declaration that happens to itself be `this`-free, a capability a fuller (but more invasive) fix could have preserved. Finding 2 filed no issue: unifying both arms onto `isUnshadowedBuiltinGlobal` is a soundness fix for the shorthand arm and a strict recall IMPROVEMENT for the `pair` arm's own previously-unconditional builtin escape, not a narrowing of anything the design claims, matching round 8's own framing for a fix that makes an existing claim true rather than trading it away. **Round 11 filed one of its own two findings — #2627** — for finding 2, and for a reason distinct from every prior round's filing criterion: round 10's own "strict recall IMPROVEMENT" claim just above is what round 11 found to be UNSOUND, not merely optimistic — crediting a genuinely unshadowed builtin (imports included) as safe is a real capability, but attempting it again needs its own focused round and its own review, exactly the discipline round 10's own drive-by fix skipped the first time. Finding 1 filed no issue: closing the `for...of`/`for...in` detection gap in the shadow check falls under #2625's already-filed scope (a shadowing scope, once DETECTED, always fails safe unconditionally rather than resolving into it — #2625 already discloses that cost for every scope kind the check can see; round 11 only makes a for-in head one of the kinds it CAN see, the same "closes a DETECTION gap without changing the underlying exclusion" pattern round 7's identifier-pair fix already established for condition 4 — no new issue for that shape either). **Round 12 filed no issue of its own**, for the same reason round 11's finding 1 did not: closing the bare-arrow-parameter detection gap in the shadow check falls under #2625's already-filed scope too — a second kind of shadow the check can now see, not a new disclosed cost. `introducesShadowedBinding`'s own pre-existing blind spot to that same field, affecting condition 3's walk in the conservative direction only, is filed separately as #2629 (a primitive-level gap, not a design-scope narrowing). **Round 13 filed one of its own — #2631** — for the identical reason as round 10's own finding 1: failing safe on ANY detected reassignment, rather than resolving what every write actually assigns and checking each one, costs recall for a binding reassigned only to OTHER provably `this`-free values — a capability a fuller, but more invasive (third-AST-search-shape), fix could have preserved. **Round 14 filed one of its own two findings — #2633** — for finding 2: failing safe on ANY duplicate top-level declaration, rather than determining which one the runtime actually uses (the LAST) and checking THAT one, costs recall for a redeclared name where the last declaration alone is what runs and is itself provably `this`-free — the identical trade-off round 10 and round 13 each already made once, applied here to a redeclared binding instead. Finding 1 filed no issue: routing the write-scan's assignment branch through `patternBindsName` is a DETECTION-gap fix to round 13's own already-filed #2631 exclusion — a detected write, however it is detected, already fails safe unconditionally per #2631's own disclosure, so widening WHICH writes are detected does not disclose a new cost, the same "closes a detection gap without changing the underlying exclusion" pattern rounds 11 and 12 already established for #2625. Also filed this round, outside the two findings proper: **#2634**, for a decidable AST shape the round's own enumeration surfaced that no round has attempted — a script-scope `var` reassigned via `globalThis.name = …` (or `global`/`self`/`window`) rather than through the bare identifier directly, invisible to `subtreeContainsReassignmentOf` because it is a `member_expression` target, not an identifier or a pattern. **Correction (round 16): #2634 was never the same KIND of filing as #2625/#2631/round-14 finding 2's own #2633, though this row previously narrated it in the same breath as those three, immediately after them, with no distinguishing framing — an editorial proximity that is itself the bug this correction fixes.** Every one of those three is a DETECTED condition the resolution chain deliberately declines to resolve further (a shadow, a reassignment, a duplicate declaration — each found, each unconditionally failed safe rather than chased one layer deeper) — recall trade-offs, costing completeness never soundness, exactly this row's own stated mitigation. #2634 was not that: it was a write the scan never DETECTED at all, on par with round 13's and round 14's own PRE-fix gaps in this same function, not with what remained after those fixes landed. Two further gaps the same enumeration surfaced are correctly NOT filed, because no static analysis can see through them regardless of how this function is written, not because this design declines to build a capability it could: direct `eval('name = fn')`, and the sloppy-mode `with` statement, can each rebind or shadow `name` in ways no AST-level scan can enumerate — Category F, the same standing platform-level limitation this design already accepts elsewhere, not a new disclosed design exclusion. **(Round 19, non-blocking) The identical `eval` acceptance extends to condition 4's OWN `this`-detection, not only to this reassignment scan**: `eval('this.alpha()')` inside a method body is equally invisible to `subtreeContainsThisKeyword`, for the identical reason — pre-round-19 this row disclosed the acceptance against `subtreeContainsReassignmentOf` alone, though the same opaque-runtime-string limitation always applied to both consumers equally; see `subtreeContainsThisKeyword`'s own doc comment for the restatement. No behavior changes; this corrects which of this function's siblings the row names. **Round 17 finds this framing was only HALF right — true of `with`'s RESOLUTION target, false of its mere PRESENCE.** No static analysis can determine WHAT a bare identifier resolves to inside a `with (obj) { … }` block, since that depends on `obj`'s actual runtime shape — that half of the round-14 claim stands. But `with_statement` is an ordinary, syntactically visible AST node, unlike `eval`'s opaque runtime string argument, which offers no structural hook to detect at all — so DETECTING that resolution through a `with` ancestor is unknowable, and failing safe on that fact alone, was never actually impossible the way genuinely opaque `eval` is; it was simply unattempted. `with` was grouped with `eval` under the same "Category F, no static analysis can see through them" framing here though only `eval` is truly of that kind — closed by a new, unconditional `with_statement` disjunct on `findResolvingScopeNode` (see that function's own round-17 essay); `eval` remains, correctly, Category F. **Round 15 filed one of its own — #2635** — for the same reason as round 10's finding 1, round 13, and round 14's finding 2: the widened hoist-count fails safe on ANY hoisted var/Annex-B redeclaration unconditionally, rather than resolving to a sole hoisted-only declaration or gating the Annex-B branch on the file's own strict/sloppy/module parse goal — either would preserve more recall at the cost of more resolution machinery this chain has repeatedly declined to add for an unobserved pattern. Round 15's OTHER change — widening what the count sees to include hoisted declarations at all — filed no issue of its own: it is a soundness fix to what round 14's own text INCORRECTLY claimed was already exhaustive (see the Testing Strategy section's round-15 note), not a new narrowing of anything the design claims, the identical "closes a gap in what an earlier round said needed no further look" framing round 14's own finding 2 used for round 10's text. **Also filed this round, outside the finding proper: #2636**, for a pre-existing detection gap surfaced while verifying round 15's own reuse of the `function_declaration` string match: a generator function declaration (`function* name(){}`) is a distinct grammar kind, `generator_function_declaration`, invisible to this test in both round 14's original loop and round 15's own hoisted extension alike. **Correction (round 16): this was mis-described as "fail-safe-already, not confidently wrong" — true only of #2636's own worked example (every declaration a generator), and false, confidently-wrong-not-fail-safe, the moment the redeclaration is mixed (a plain `function_declaration` followed by a `generator_function_declaration`) — see the Risks table's main row, above, and #2636's own corrected issue comment.** **Round 16 closed all four of #2630/#2632/#2634/#2636 rather than filing or re-filing any of them — the first round in this plan's history in which every issue touched this round is a CLOSURE, not a new filing or a scope extension of an existing one.** This is also the round that establishes the standing rule the Success Criteria section now states explicitly: a tracked exclusion may be filed as an accepted, shippable limitation only when it is genuinely OVER-escape (a detected condition the design declines to resolve further, costing recall alone) — the #2625/#2631/#2633/#2635 shape — never when it is UNDER-escape (live code reported dead), which #2634 and #2636 both were and #2630/#2632 both risked being for at least one of their own consumers; an under-escape gap must be fixed in the same round it is found, exactly as this round does for all four, or the plan does not ship. One PR = one concern. **Round 17 closes #2637 — the `switch_body` residual round 16 itself flagged but declined to fix without first confirming it exists — and finds three further UNDER-escape gaps of its own, all fixed the round they were found rather than filed, per the same standing rule.** #2637: `introducesShadowedBinding`'s `switch_body` case carries the identical missing-`using_declaration` gap its `statement_block` case did before round 16 — confirmed against the real, shipped source rather than assumed, and closed by the same "fix the resolution-only wrapper, not the shared primitive" disjunct on `findResolvingScopeNode` round 16 already established for the `statement_block` case. Auditing every OTHER `SCOPE_NODE_TYPES` member for the identical gap, rather than stopping at `switch_body` alone, surfaced ONE more instance — `introducesShadowedBinding`'s `for_statement` case has the same omission — closed the same way, and also credited to #2637 (one root cause, one issue). Finding 1: a `var`-kind for-of/for-in loop head rebinds the SAME module-scope binding a direct top-level `var` declaration created — `var` is function-scoped, not block-scoped, so this is a REASSIGNMENT and a REDECLARATION at once, and both `subtreeContainsReassignmentOf`'s for-in gate (which excluded any head carrying a `kind` field, `var` included, rather than only `let`/`const`/`using`, which alone create a genuinely new binding) and `countHoistedVarScopeDeclarations` (which had no `for_in_statement` case at all — verified against the real grammar that `for (var name of xs)` places the `var` token and pattern directly under `for_in_statement`, never wrapped in a `variable_declaration` node) missed it independently. Both are fixed, closing the same construct via two separate mechanisms rather than relying on either alone. Finding 2: `isGlobalObjectQualifiedWrite` (round 16, #2634) recognised only the dot spelling of a global-object-qualified write (`globalThis.name = …`); the identical write spelled with bracket-subscript notation (`globalThis['name'] = …`) is a `subscript_expression`, a different node kind, and was just as invisible as the dot spelling was before round 16 — closed by a new `subscript_expression` arm reusing `isTrackedReferencePosition`'s own static-key normalisation verbatim. Finding 3: a `with` block, addressed above at this row's own eval/`with` correction — `findResolvingScopeNode` had no `with_statement` case anywhere, so a same-named module-level decoy resolved through a `with` block with full, unearned confidence; closed by a new, unconditional disjunct, cheap and strictly conservative since it only ever adds MORE fail-safe outcomes, never fewer. **None of round 17's three findings is misfiled as OVER-escape and none is left as a standing exclusion** — all three are fixed in this same round, mirroring round 16's own discipline exactly. **A fourth item this round closes, outside the three findings proper, files no issue for a different reason than any prior round's own "no new issue" entries above**: Greptile flagged `subtreeContainsReassignmentOf`'s `update_expression` branch for the identical missing-`unwrapParens` gap round 16's own #2630 fix left in this one branch. Fixed for consistency, but verified — not merely argued — to carry no soundness cost at all: an update expression's own numeric-coercion semantics mean it can never reassign a handler to a new function value, so unlike every other entry on this row, this is neither a recall trade-off needing a filed exclusion nor an under-escape gap needing the standing rule's own remedy — it is a pure code-symmetry fix with no user-visible behavior change at all. One PR = one concern. **Round 18 REOPENS #2637**: it was closed by round 17 on the strength of a `for_statement` fix that parsing the fixture with the real grammar shows was never reachable (`tree-sitter-javascript@0.25.0` cannot produce a `using_declaration` node in that position at all) — a NEW failure kind for this row, a fix that looked and read like every other disjunct in the same function but never executed. Re-closed the same round it is reopened, by keying on the actual, parser-verified `ERROR` shape instead. **Round 18 also finds three further UNDER-escape gaps, all fixed the round they are found, per the standing rule**: a getter's return value (not merely its own body) can carry an unmodeled `this` reference; `allReferencesTracked`'s reuse of `introducesShadowedBinding`'s shared function-shape case treats a `method_definition`'s bare property name as a binding, which it is not, spuriously pruning a genuine reference exactly as round 8's own self-shadow bug did, via a different mechanism; and a single paren layer around a global-object identifier defeats `isGlobalObjectQualifiedWrite` in both arms. None is filed as a standing exclusion. **Round 18 files one new OVER-escape exclusion of its own — #2638** — for the getter fix's own necessary narrowing: an otherwise entirely harmless getter (`get value(){ return 42; }`) now also escapes, since resolving what a getter returns to any bounded depth would still be incomplete (a returned call expression or inline function could itself be `this`-using), the identical "detect the shape, fail safe outright" trade-off round 9's `spread_element` exclusion and round 10's/round 13's shadow/reassignment exclusions already made for the same reason. **A fifth item, flagged by Greptile on this PR rather than found by this plan's own re-audit, files no issue**: `allReferencesTracked`'s rebinding recursion reused the outer call's `declaringScope` unconditionally for a recursive alias check, sound only for a lexically-scoped alias — a `var`-declared one is function-scoped and can be referenced past that boundary. Closed the round it was found, per the standing rule; it is a soundness fix to condition 3's own walk, not a new narrowing of anything the design claims. **Round 19 files no issue for any of its three findings** — the `__proto__`-key check, the `allReferencesTracked` node-type widening, and the for-of recursion's `var`-kind boundary fix are all soundness fixes closing UNDER-escape gaps this design already claimed to cover (a literal's own condition-4 shape-recognition, condition 3's own reference-tracking completeness), not new narrowings of anything the design claims — matching round 16's own framing for its non-#2634/#2636 fixes, and round 18's own framing for its first four. None is filed as a standing exclusion, per the standing rule below. **Round 20 closes #2640 rather than carrying it further (B5) — the first item on THIS row, as opposed to the main row above, to be a closure of a previously-filed departure rather than a fix narrated only there** — and files one genuinely new `OVER-escape` exclusion of its own, matching round 9's/round 13's own framing: **#2641**, for the B1 backslash fail-safe's own necessary narrowing (a key merely containing an unrelated escape sequence now also escapes, since resolving whether an escaped key cooks to anything other than `__proto__` would require a full string/identifier unescaper this design does not otherwise need). B2, B3, and B4 file no issue: B2 is a soundness fix to boundary-widening machinery rounds 18/19 already introduced (not a narrowing of anything the design claims), and B3/B4 are corrections to round 19's OWN fixtures' vacuousness, not new findings against the design itself. B5 (closing #2640) files no new issue either — closing a previously-filed departure is not a new exclusion. Separately, non-blocking: UE-D — an OPTIONAL, broader file-level `eval`/`new Function` fail-safe that would make the non-vacuous-coverage claim hold literally rather than only Category-F-modulo — is filed as its own follow-up rather than built this round, since it is new design scope (a file-wide pre-check threaded into every entry point, in both engines) costing recall file-wide, not a narrow fix: **#2642**. G1 and UE-C file no issue: both are soundness/consistency fixes to already-shipped machinery (a missed `unwrapParens` call, a reflective-call-shape exclusion), not new narrowings of anything the design claims. |

## Out of Scope (filed, not silently dropped)

- **`computedDispatchTableEvidence` is in-memory only** — on a scoped incremental build a dispatch table whose only computed-access consumer lives in an untouched file loses its evidence, so `roles --role dead` can report a live property dead. Non-conservative direction, and a full-vs-incremental divergence. Its sibling channel got a durable table in #2087 for exactly this reason. **`UNDER-escape` in direction (verified round 16, see the Success Criteria exclusion list's own DIRECTION-labels note for the full argument and why this is the one exception to the round-16 standing rule): pre-existing, inherited from #2260, and verifiably not worsened by this plan — any table with a cross-file computed-access consumer must itself be exported, so condition 2 already makes its site escape, and unconditionally, BEFORE condition 4 (this plan's own new machinery) ever runs; resolution then falls to T2/T3 exactly as it does today, byte-identical to pre-#2088.** → issue **#2610**
- **`findEnclosingTableName` does not traverse array literals** — `TABLE_NAME_PASSTHROUGH_TYPES` (and its Rust mirror `TABLE_NAME_PASSTHROUGH_KINDS`) omit `array`, so `const RESOLVERS = [{ matches, resolve }]` yields no `receiver` and the #2260 computed-access pathway can never credit a handler array — the exact idiom named in `collectObjectLiteralValueRefCall`'s own doc comment as #1771's motivating case. Not closed by this plan, which leaves T3 name-keyed. → issue **#2611**
- **`-T` under-filters `tests/`**, inflating this repo's dead-symbol count ~3x. Already tracked; relevant here only because WU-10's dogfood measurement must filter `tests/` by hand rather than trust the raw number. → issue **#2256** (pre-existing, referenced in `.codegraph/basics.md`)
- **Cross-module allocation-site propagation** — `importedNames` propagates cross-module *names*, not *sites*, which is why exported tables are classified escaping (WU-2b, condition 2). Shrinking the escape set by propagating sites through import edges is a natural follow-up, in the spirit of ROADMAP §8.3b. **Not filed yet**: it is a design direction rather than a defect, it has no user-visible symptom today (escaping sites simply keep current behavior), and its right shape depends on what WU-10 measures. To be filed at execute time if the measured delta shows exported tables dominate the remaining false negatives.
- ~~**Classic-script `globalThis.T.alpha()` READS are invisible to `allReferencesTracked`'s reference walk**~~ — **CLOSED, ROUND 20.** Round 16 (#2634) already accepted the classic-script premise for a `globalThis`-qualified **write** to a script-scope `var`; the symmetric READ was found during round 19's review, filed at #2640 rather than fixed inline, and flagged there as a departure from this plan's own standing rule that an `UNDER-escape` gap must be fixed the round it is found. Round 20 fixes it rather than carrying the departure further: `allReferencesTracked`'s own candidate-reference walk gains a third node-matching case, alongside its `identifier`/`shorthand_property_identifier` text-matches, for a `member_expression`/`subscript_expression` recognised by `isGlobalObjectQualifiedWrite` (reused verbatim, unmodified, from its existing write-side role) — unconditionally untracked, since no T1-like channel exists for a `globalThis`-qualified read. See `allReferencesTracked`'s own round-20 doc comment for the full argument, verified runnable repro, and why the write/read asymmetry #2640 raised was never coherent to begin with (`isGlobalObjectQualifiedWrite` never tested script-vs-module either). Verified by new escape-fallback case (bh) and correlation shape 26. Closes **#2640**.

## Success Criteria

- [ ] `codegraph roles --role dead -T` no longer credits an unrelated `x.name(...)` call as liveness evidence for a **non-escaping** object literal's `{ name: fn }` property — the exact behavior issue #2088 asks for.
- [ ] Every object literal producing a value-ref carries a stable allocation-site id, and its `escapes` bit is persisted in `object_literal_sites`.
- [ ] The points-to solver propagates those sites through the flows it already models and treats as tracked — direct binding, array element + for-of, and alias — with **no** change to `buildCallSiteTypeMap` / `MAX_SOLVER_ITERATIONS`, per ADR-002's "no new subsystem". The following positions/shapes are treated as escaping in this iteration and are deliberately excluded from the correlated set, each narrower than an earlier round of this plan claimed — round 6 (and, re-applying the identical invariant test to round 6's OWN result, round 7) found that an earlier, looser predicate would have accepted them without their invocations actually being provable via T1, which is a soundness gap, not a stylistic nit. Recall is smaller than that earlier draft claimed, again; each exclusion below is filed as a follow-up capability rather than silently narrowed.
  >
  > **DIRECTION labels (ROUND 16; wording corrected ROUND 17 — a standing rule for BOTH this list AND the Out of Scope list above, and for every future round's own additions to either).** Every bullet naming a currently-open, filed exclusion — in this list, or in Out of Scope, above — is tagged `OVER-escape` or `UNDER-escape`. **`OVER-escape`** means the site escapes when a fuller analysis could, in principle, have proven it closed — this costs RECALL only (a correlation the design could draw but doesn't yet), never SOUNDNESS, and is the direction every such bullet actually is, #2610 alone excepted (see below). **`UNDER-escape`** would mean the opposite: a site reads `escapes = false` while some real invocation is invisible to T1 — live code reported dead, a soundness failure, not a recall trade-off. **An `UNDER-escape` gap may never be filed as an accepted limitation on EITHER list. It must be fixed in the round that finds it, or the plan does not ship.** This rule exists because it was violated twice before being written down: #2634 (a script-scope `var` reassigned through the global object, invisible to `subtreeContainsReassignmentOf` entirely) and #2636 (a mixed plain-then-generator top-level redeclaration, confidently resolved to the stale first declaration) were each, at various points before round 16, narrated in this plan's own Risks table alongside genuine `OVER-escape` trade-offs (#2625, #2631, round 14 finding 2's #2633) as though they belonged to the same accepted-cost bucket — round 16 corrects both misfilings (see the Risks table) and closes both gaps rather than re-filing them, together with two further `UNDER-escape` consumers of the identical `patternBindsName` gap named at #2630 and one of `introducesShadowedBinding`'s own blind spots named at #2632 — see the round-16 contract bullet below for all four. **ROUND 17 — the rule's own original wording let a THIRD violation slip past, in the very same commit that wrote it.** "Every bullet below" scoped the rule to this list's own bulleted items alone; #2637 — a residual `switch_body`/`using_declaration` gap surfaced while implementing round 16's `statement_block` fix — was filed in Out of Scope, a section physically ABOVE this one, and carried no direction label at all, an omission the rule's own LETTER did not clearly forbid even though its SPIRIT plainly did: #2637 was exactly as UNDER-escape as #2630/#2632/#2634/#2636, and leaving it "filed, not silently dropped" for even one further round was never actually compliant with what this rule exists to prevent. Fixed two ways: the rule's own wording now explicitly spans both lists, as stated above, so no future omission can shelter in the gap between them; and #2637 itself is closed this round rather than carried, together with two further `UNDER-escape` gaps round 17 found and closed the same way (a `var`-kind for-of/for-in loop head, and a bracket-subscript-spelled global-object write) — see the round-17 contract bullet below for all three. **One exception to this rule, not a violation of it: #2610**, `computedDispatchTableEvidence`'s in-memory-only aggregation (Out of Scope, above), is also `UNDER-escape` in direction (its own issue body says so explicitly: "the non-conservative error direction... genuinely live code reported dead") — but it is a PRE-EXISTING gap inherited from #2260, entirely out of this plan's own scope (T1/condition 2's export check), not introduced or worsened by it: any table with a cross-file computed-access consumer must itself be exported for that consumer to ever see it, condition 2 already makes an exported table's site escape unconditionally before condition 4 (this plan's own new machinery) ever runs, and resolution then falls to T2/T3 exactly as it does today — byte-identical to pre-#2088. #2610 is inherited, verified not worsened, and someone else's round to fix; #2634/#2636/#2637 were this plan's own, found by this plan's own review, and their own round's to fix, which is why the standing rule applies to them and not, retroactively, to #2610.
  - `OVER-escape`. Parameter-passing positions (WU-2b condition 3, WU-4) — #2617. This exclusion also applies transitively to a for-of loop variable forwarded into a function call (round 7) — no separate issue; it is the same gap one binding further, per condition 3's own note.
  - `OVER-escape`. A same-literal `this.k()` call from a method/function defined inside the literal itself (WU-2b condition 4) — #2618. Round 7 closed a DETECTION gap in this same condition (an identifier-valued property naming a same-file function was previously invisible to the check at all) without changing the underlying exclusion itself — no new issue for that fix; it makes an existing checkbox true rather than narrowing it further.
  - `OVER-escape`. `for...in` enumeration (only the `for...of` variant of `for_in_statement` is tracked) and, more generally, a computed dispatch call `TABLE[expr]()` made directly rather than through the `const x = TABLE[expr]; x(...)` declarator form T3 already requires — #2619.
  - `OVER-escape`. A bare (non-call) member/subscript read of a tracked binding's property, assigned to a local and called through that alias (e.g. `const f = T.k; f()`) — #2620.
  - `OVER-escape`. (round 7) A member/subscript call on an ARRAY-OWNED site's CONTAINER (`RESOLVERS.forEach(...)`, `.map`, `.find`, `.filter`, `.some`) — only a `for...of` head over the container is admissible; `buildArrayCallbackConstraints` seeds no points-to fact for any of these callbacks' parameters — #2621.
  - `OVER-escape`. (round 7) A `for...of` loop variable forwarded into a position this analysis does not itself follow, beyond the plain parameter-passing case above — specifically, a DESTRUCTURING loop variable (`for (const { k } of A) k()`), which `collectForOfBinding` never seeds a points-to fact for at all — #2622.
  - `OVER-escape`. (round 7) A subscript call keyed by an interpolated template string (`` T[`al${x}pha`]() ``) — the extractor's own guard never produces a named, receiver-carrying call for it, so no property name is ever available to correlate, regardless of how the receiver is referenced — #2623.
  - **(round 8) No new exclusion added to this list.** Round 8's three findings (below and throughout WU-2b) are SOUNDNESS fixes to the escape analysis's own implementation, not new accepted recall limitations in its DESIGN — unlike every bullet above, none of them names a shape the design deliberately declines to model. Finding 1 (the declaring-scope shadow-prune) and finding 2 (the `bindingName` suffix) together made the escape check WRONGLY non-escaping for every non-module-scope table regardless of how it was actually used — fixing them does not shrink what the design already claimed was trackable, it makes the claim true instead of vacuously true for shapes it was already supposed to cover (correlation shapes 4/5 above confirm function- and block-scoped tables used correctly still correlate after the fix). Finding 3 (the `$`-guard) made the escape check WRONGLY tracked for a reference the extractor can never actually produce T1 evidence for; the fix aligns it with what #2623 already correctly assumed the extractor does, for a case #2623 was never scoped to cover (a `$`-bearing STATIC key, as opposed to genuine interpolation). Recall for the shapes round 8 touches is therefore unchanged from what earlier rounds already claimed, once "claimed" means "actually verified against a fixture in that scope," which is precisely what correlation shapes 4/5 and escape-fallback cases (o)/(p) now do.
  - **(round 8) One narrow, EXPECTED conservative consequence of finding 1(b), not a new exclusion needing its own issue:** a declaring scope whose AST subtree is deep enough to hit the pre-existing `MAX_WALK_DEPTH` cap now unconditionally escapes, per the non-vacuous-coverage requirement below — where pre-round-8 (buggy) behavior would have silently returned "not found" and read a truncated walk as tracked. This is the SAME depth-cap convention already applied uniformly throughout this file's other recursive walks (`blockContainsIdentifierExcluding`, `patternBindsName`, `scanPatternDefaultsForReference`, `subtreeContainsThisKeyword`) — Category F, a standard safety boundary, not a newly-discovered gap in this design specifically — so it is not filed as a follow-up capability the way #2617–#2623 are; those name shapes the design does not yet recognise at all, while this names a depth the AST would have to be pathological to reach.
  - `OVER-escape`. **(round 9, #2088 finding 1) A NEW exclusion, unlike round 8's — genuinely narrower recall, not a detection-gap fix.** A `pair` whose value is not positively proven `this`-free — an object-spread source (`const T = { alpha: fnA, ...mixin }`), a call-expression-valued pair (`run: makeRunner()`), a parenthesized function expression (`run: (function () { … })`), a bare member-expression read, an `as`/`satisfies` cast, or a logical/ternary expression — now marks the site escaping, where the pre-round-9 implementation (unsoundly) treated it as safe by omission. Unlike round 7's identifier-valued-pair fix (which closed a DETECTION gap in an already-sound exclusion, condition 4's own `this`-using-method rule), round 9 removes a capability the pre-round-9 code claimed to have but never actually had soundly: correlating a value-ref inside a literal that ALSO carries one of these shapes. Recall is smaller than the pre-round-9 draft implied for this narrow case; filed as a follow-up rather than silently narrowed — #2624.
  - **(round 9, #2088 finding 2) No new exclusion — a buildability/soundness fix, not a design narrowing.** WU-5(a)'s three-pass restructuring (pts pre-pass → evidence assembly → per-file edge resolution) does not remove any capability the design claims; it is what makes `collectInvokedPropertySites` implementable at all against a per-file points-to map, a requirement WU-5's own doc comment already implied ("the receiver-CORRELATED counterpart of `collectInvokedPropertyNames`") but never stated precisely enough to build correctly. No follow-up issue.
  - `OVER-escape`. **(round 10, #2088 finding 1) A NEW exclusion, narrower for a different reason than round 9's: implementation-simplicity, not an unavoidable safety boundary.** Once `resolveIdentifierValueThisReference` finds that some scope strictly between the object literal and the module root also declares the identifier's name, it fails safe UNCONDITIONALLY rather than resolving into that shadowing scope's own declaration and checking whether THAT declaration is itself `this`-free. A shadowing declaration that happens to be genuinely `this`-free would, under a fuller fix, still correlate via T1; under this one it always escapes and falls to T2, because doing otherwise would require generalising `findTopLevelFunctionNodeByName`'s module-level-only declaration matching into a second, arbitrary-scope traversal — another AST-search shape to keep correct, in both engines, for a pattern the `#1771`/`#1784` precedent was never asked to cover. Filed as a follow-up rather than silently accepted — #2625.
  - **(round 10, #2088 finding 2) No new exclusion — a soundness fix with a strict recall IMPROVEMENT as a side effect, matching round 8's framing rather than round 9's.** Unifying the `pair` and `shorthand_property_identifier` arms onto one shared `isUnshadowedBuiltinGlobal` guard closes the shorthand arm's silent-safe-vote hole (a soundness fix — nothing the design claimed to cover gets narrower) AND, as a side effect, lets the `pair` arm correctly credit a genuinely UNSHADOWED builtin-named property as safe — a case the pre-round-10 `pair` arm always, unnecessarily, escaped. No follow-up issue. **SUPERSEDED by round 11, immediately below: this "recall IMPROVEMENT" claim was itself unsound** (`isUnshadowedBuiltinGlobal` could not distinguish a genuine global from a builtin-named IMPORT), so the improvement is reverted rather than kept.
  - **(round 11, #2088 finding 1) No new exclusion — closes a DETECTION gap in round 10's own #2625 exclusion, the same way round 7 closed one in condition 4's original exclusion.** #2625 already discloses that ANY shadowing scope, once detected, makes `resolveIdentifierValueThisReference` fail safe unconditionally rather than resolving into it — this round only widens WHICH scopes the check can detect as shadowing (adding a `for...of`/`for...in` loop head, via `findResolvingScopeNode`) without changing that already-disclosed unconditional-fail-safe behavior itself. Pre-round-11, a loop-head shadow was not merely "conservatively excluded" the way #2625 describes — it was invisible to the check entirely, producing a confidently WRONG answer (the same failure class finding 1 originally named), not a disclosed conservative one. No new issue: it makes #2625's own disclosed scope wider, rather than disclosing a new one.
  - **(round 11, #2088 finding 2) A regression REVERTED, not a new exclusion — recall for the `pair` arm's builtin-named-identifier case returns to exactly what it was through round 9.** `isUnshadowedBuiltinGlobal` is deleted; both arms now escape unconditionally on any `BUILTIN_GLOBALS` name, with no `definitionNames` lookup and no resolution attempted. This is strictly MORE conservative than round 10's (unsound) behavior — recall is smaller than round 10 claimed, for the same reason round 10's own "strict recall IMPROVEMENT" framing (immediately above) does not survive this round. It is not, however, narrower than what round 9 (and every prior round) actually delivered soundly: the `pair` arm always escaped unconditionally on a builtin name through round 9, and the shorthand arm's own pre-round-10 bug (a silent, unproven non-escaping vote) is still fixed, just via unconditional escape rather than via a shadow-aware guard. Crediting a genuinely unshadowed builtin (imports included) as safe remains a real, unclaimed recall opportunity — filed as its own follow-up, to be designed and reviewed as its own round — #2627.
  - **(round 12, #2088 finding 1) No new exclusion — closes ANOTHER detection gap in round 10's own #2625 exclusion, the same way round 11 did for the for-in case.** #2625 already discloses that ANY shadowing scope, once detected, makes `resolveIdentifierValueThisReference` fail safe unconditionally rather than resolving into it; round 11 widened which scopes `findResolvingScopeNode` can detect to include a `for...of`/`for...in` loop head, and this round widens it once more to include a bare, unparenthesized single-identifier arrow-function parameter (`run => {…}`) — a shape `introducesShadowedBinding`'s existing, plural-only `parameters` field read cannot see. Pre-round-12, this shadow was not a disclosed conservative exclusion — it was invisible to the check entirely, producing a confidently WRONG answer, the same failure class finding 1 originally named. No new issue: it makes #2625's own disclosed scope wider still, rather than disclosing a new one. `introducesShadowedBinding`'s own blind spot to this same field — which affects `allReferencesTracked`'s reference walk too, safely (over-inclusion only) — is a pre-existing gap in a primitive this round deliberately does not widen; filed separately as #2629.
  - `OVER-escape`. **(round 13, #2088 finding 1) A NEW exclusion, the SAME shape as round 10 finding 1's — implementation-simplicity, not an unavoidable safety boundary.** Once `resolveIdentifierValueThisReference` finds that the resolved, unshadowed declaration is reassigned anywhere in the file (via `subtreeContainsReassignmentOf`), it fails safe UNCONDITIONALLY rather than resolving what every reassignment actually assigns and checking whether EVERY one of those values is itself `this`-free. A binding reassigned only to OTHER provably `this`-free values would, under a fuller fix, still correlate via T1; under this one it always escapes and falls to T2 the moment any write is found, because resolving every write's own right-hand side would add a THIRD AST-search-and-resolve shape (beyond the module-level declaration search and the ancestor shadow walk) to keep correct in both engines, for a case the `#1771`/`#1784` precedent was never asked to cover — the identical trade-off round 10 already made for a shadowing declaration, applied here to a reassigned one instead. Filed as a follow-up rather than silently accepted — #2631.
  - **(round 14, #2088 finding 1) No new exclusion — closes a DETECTION gap in round 13's own #2631 exclusion, the same way round 11/12 closed detection gaps in round 10's #2625.** #2631 already discloses that ANY detected reassignment, however it is detected, makes `resolveIdentifierValueThisReference` fail safe unconditionally rather than resolving what it assigns; this round only widens WHICH writes `subtreeContainsReassignmentOf`'s assignment-expression branch can detect — routing it through `patternBindsName` so a destructuring target (`[name] = […]`, `({ name } = …)`) is caught, not only a bare identifier — without changing that already-disclosed unconditional-fail-safe behaviour itself. Pre-round-14, a destructuring write was not merely "conservatively excluded" the way #2631 describes — it was invisible to the scan entirely, producing a confidently WRONG "safe" vote, the same failure class round 13 itself closed for the pre-round-13 code. No new issue: it makes #2631's own disclosed scope wider, rather than disclosing a new one. A parenthesized assignment target (`(name) = …`) remains invisible — `patternBindsName` itself has no case for one — tracked at the pre-existing #2630, whose scope this round extends to name this arm (not only the `for_in_statement` arm already named there) as a fourth affected consumer.
  - `OVER-escape`. **(round 14, #2088 finding 2) A NEW exclusion, the SAME shape as round 10 finding 1's and round 13 finding 1's — implementation-simplicity, not an unavoidable safety boundary.** Once `findTopLevelFunctionNodeByName` finds more than one top-level declaration of `name`, it returns `null` (fail safe) UNCONDITIONALLY rather than determining which declaration the runtime actually uses (always the LAST) and checking whether THAT one is itself `this`-free. A name declared more than once at module level, where the last declaration alone is what runs and is itself provably `this`-free, would, under a fuller fix, still correlate via T1; under this one it always escapes and falls to T2 the moment a second declaration is found, because determining "the last one wins" correctly — and not misfiring on a harmless, no-initializer `var name;` restatement — would add scope to a resolution chain already found and fixed across rounds 7 through 14, for a redeclaration pattern the `#1771`/`#1784` precedent was never asked to cover. Filed as a follow-up rather than silently accepted — #2633.
  - `OVER-escape`. **(round 15, #2088 finding 1) The COUNT this fix widens is itself a soundness fix, not a new exclusion — round 14's own text incorrectly claimed the count was already exhaustive (corrected in the Testing Strategy section's round-15 note); making it actually exhaustive over the module's own var scope narrows nothing the design ever soundly claimed.** But the FIX ITSELF introduces two NEW exclusions, the same shape as round 10 finding 1's, round 13 finding 1's, and round 14 finding 2's — implementation-simplicity, not an unavoidable safety boundary. First: when the widened count is exactly one — a SOLE declaration reachable only by hoisting through a nested block, with no direct-child declaration at all — `findTopLevelFunctionNodeByName` still returns `null` rather than resolving to that sole declaration and checking it for `this`-freedom, because `result` (unlike `declarationCount`) is only ever assigned from a direct-child match. Second: the Annex-B `function_declaration` branch of the count does not gate on the file's own strict/sloppy/module parse goal, so it over-counts (costing recall, never soundness) in a strict-mode/ESM file where Annex B could not actually apply and a block-level function of the same name is therefore already a distinct, block-scoped binding handled correctly by the shadow axis instead. Both would, under a fuller fix, let more sites correlate via T1; under this one they always escape or fail safe, because resolving either one precisely would add scope to a resolution chain already found and fixed across fifteen rounds, for a redeclaration/hoisting pattern the `#1771`/`#1784` precedent was never asked to cover. Filed as a follow-up rather than silently accepted — #2635. (A pre-existing detection gap surfaced while verifying this round's own reuse of the `function_declaration` test — a generator function DECLARATION, `generator_function_declaration`, was invisible to both round 14's original direct-children loop and this round's hoisted extension alike — was filed at #2636 and, through round 15, narrated here as merely "fail-safe-already." **Round 16 found that framing false the moment the redeclaration is MIXED rather than all-generator, closed the gap, and moved it out of this exclusion list entirely — see the round-16 contract bullet below, not this one.**)
  - `OVER-escape`. **(round 18, #2088, U2) A NEW exclusion, the same shape as round 9's `spread_element`/pair-value one — a shape this function now refuses to reason about further, rather than an unavoidable safety boundary.** A `get`-flavoured `method_definition` now escapes UNCONDITIONALLY, regardless of what `subtreeContainsThisKeyword` finds in its own body, because a getter's danger lies in what it RETURNS (which can be called with `this` bound to the receiver, per ordinary member-expression-callee semantics) and not merely in what its own body references — see `literalHasUnmodeledThisReference`'s own doc comment for the counter-example. An entirely harmless getter (`get value(){ return 42; }`) now also makes its literal escape, since resolving what a getter returns to any bounded number of hops would still be incomplete — a returned call expression, inline function, or further-nested property read could each independently be `this`-using, unlike the identifier-valued `pair`/`shorthand` arms' own single, positively-enumerable resolution target. Filed as a follow-up rather than silently accepted — #2638. A plain method's and a setter's own existing checks are unaffected: a setter's return value is never called (assignment expressions evaluate to the assigned value, never to what the setter itself returns), so `subtreeContainsThisKeyword` remains sound for it, exactly as it always was.
  - `OVER-escape`. **(round 20, #2088, B1) A NEW exclusion, the same shape as round 18's getter one — a narrowing this check now accepts rather than building a full resolver for.** The backslash fail-safe added to close the unicode-escape `__proto__` evasion (see `literalHasUnmodeledThisReference`'s own round-20 doc comment) fires on ANY backslash in a non-computed key's own raw text, not only one that actually cooks to `__proto__` — an object literal with a perfectly ordinary key that happens to contain an unrelated escape sequence (`{ "a\nb": fn }`) now also escapes, even though it obviously isn't `__proto__`. Resolving the cooked value precisely would require a bounded string/identifier unescaper this design does not otherwise need, for a check whose only job is detecting nine characters. Filed as a follow-up rather than silently accepted — #2641.
  - **(round 20, #2088, B2) No new exclusion — a soundness fix to boundary-widening machinery rounds 18/19 already introduced, not a narrowing of anything the design claims.** Widening the rebinding-alias and for-of-loop-variable recursions' own `declaringScope` to the enclosing function-shape node's `body`, rather than to that node itself, closes a self-shadow gap the pre-round-20 widening (rounds 18/19) reopened one level up — it does not shrink what either recursion was already meant to cover; it makes the widening correct for every shape it was already supposed to handle. See `allReferencesTracked`'s own round-20 essay for the full argument and the counter-example this closes.
  - **(round 20, #2088, B3/B4) No new exclusion — corrections to round 19's OWN correlation shapes 23 and 25, found vacuous by applying round 19's own newly-written ablation standing rule to round 19's own new fixtures.** Neither correction narrows anything the design claims: shape 23 is rebuilt with an escaped computed key (still `escapes = 0`, as round 19 always intended); shape 25 needed no source change at all, only the B2 fix above, after which its existing `escapes = 0` assertion is finally load-bearing. See each shape's own rebuilt commentary in WU-10.
  - **(round 20, #2088, B5) No new exclusion — closes #2640 (a previously-flagged departure from this very standing rule) rather than filing a new one.** `allReferencesTracked`'s candidate-matching walk gains a third, structural way to recognise a reference — a `member_expression`/`subscript_expression` matching `isGlobalObjectQualifiedWrite`, reused verbatim from its existing write-side role — closing a genuine `UNDER-escape` gap this design's own round-19 review found and, at explicit orchestrator direction, carried rather than fixed. See the Out of Scope section, above, for the closure, and `allReferencesTracked`'s own round-20 essay for the fix.
  - **(round 20, #2088, G1/UE-C, non-blocking) No new exclusions — soundness/consistency fixes to already-shipped machinery, closing gaps that were never disclosed as accepted trade-offs to begin with.** G1 (Greptile-flagged) unwraps a parenthesized subscript INDEX in `isGlobalObjectQualifiedWrite`, the index-side counterpart of round 18's own object-side paren fix. UE-C rejects a `call`/`apply`/`bind`-named member call in `isTrackedReferencePosition`, since the pre-existing, general call extractor already strips the receiver from any such call regardless of context, making it structurally incapable of producing T1 (or T2) evidence for any property — accepting it as tracked would credit a correlation that can never materialise. Neither shrinks a capability this design ever claimed to have.
- [ ] **(round 9, #2088 finding 1 — the fail-closed contract, generalised).** Every predicate `computeObjectLiteralSiteEscapes` consults returns "escaping" for any shape it does not positively recognise as safe — not just `allReferencesTracked`'s own coverage (round 8's standing rule, above), and not just condition 4's enumerated `this`-free shapes (`isPositivelyThisFreeLiteral`, an `arrow_function`, an inline function/method whose subtree was searched, or an identifier/shorthand-property resolved in-file to a non-arrow, NEVER-REASSIGNED `this`-free function (round 13, #2088 finding 1 — reassignment is not merely another shape to enumerate here; it is the caller's own precondition on trusting this enumeration at all, checked separately by `subtreeContainsReassignmentOf` before this list is ever consulted)). This is a standing contract on `computeObjectLiteralSiteEscapes`'s own return value, not a one-off patch to condition 4: any predicate this function gains in a future round — a hypothetical condition 5, or a further refinement of conditions 1–3 — inherits it automatically, the same way round 8's non-vacuous-coverage requirement binds every future change to `allReferencesTracked` specifically. Verified by WU-10 correlation shape 6 (a mixed data/handler table does NOT over-escape) and escape-fallback cases (q)–(u) (the five shapes named in the bullet above DO escape, across module, function, and block scope).
- [ ] **(round 9, #2088 finding 2 — the pass-ordering contract).** `collectInvokedPropertySites` never resolves a call's receiver against any file's points-to map other than the one for the file that call is declared in — enforced by the revised signature (`ReadonlyMap<string, Iterable<Call>>` plus a `relPath`-aware `resolveReceiverSites`, WU-5(a)/WU-8), not merely by caller discipline. Verified by WU-10 correlation shape 7, a two-file fixture built specifically because a single-file fixture cannot distinguish "resolved against the right file's map" from "resolved against the only map there is."
- [ ] **(round 10, #2088 finding 1 — the identifier-resolution shadow contract; extended round 11 and round 12, #2088 finding 1).** `resolveIdentifierValueThisReference` never resolves an identifier-valued pair/shorthand property against a declaration OUTSIDE the one actually in lexical scope at the object literal's own position — enforced structurally by checking `findResolvingScopeNode(objectNode, name)` (round 8's `findDeclaringScopeNode`, itself unchanged, through round 10; a thin resolution-only wrapper around it as of round 11, additionally covering a `for...of`/`for...in` loop-head binding, and, as of round 12, a bare single-identifier arrow-function parameter too) before ever consulting `findTopLevelFunctionNodeByName`'s module-level-only search, not merely by caller discipline or by that search's own (previously mis-stated) fail-safe backstop. Verified by WU-10 escape-fallback cases (v)–(w) (a function- and a block-scoped shadow of a `this`-free module-level sibling must escape), round 11's case (aa) (a `for...of` loop-head shadow must escape too), and, round 12, case (ad) (a bare arrow-parameter shadow must escape too) — none may silently resolve to the wrong, harmless declaration.
- [ ] **(round 11, #2088 finding 2 — the unconditional builtin-escape contract, SUPERSEDING round 10's shared builtin-guard contract).** Both the `pair`-value and `shorthand_property_identifier` arms of `literalHasUnmodeledThisReference` escape UNCONDITIONALLY on any `BUILTIN_GLOBALS`-member name, with no `definitionNames` lookup and no identifier resolution attempted — enforced by one identical `BUILTIN_GLOBALS.has(name)` check inlined at both call sites, not by a shared helper that (round 10's `isUnshadowedBuiltinGlobal`) could, and did, silently mistake a builtin-named IMPORT for a genuine, unshadowed global. Verified by WU-10 escape-fallback cases (x)–(z) (a builtin-named property shadowed by a same-file, `this`-using declaration must escape at module, function, and block scope alike — still true, now for a simpler reason) and, round 11, cases (ab)–(ac) (a builtin-named property populated by an IMPORTED, `this`-using declaration must escape too, in both the `pair` and `shorthand_property_identifier` arms).
- [ ] **(round 13, #2088 finding 1 — the reassignment contract; round 14 widens what it detects, and corrects how it was stated).** `resolveIdentifierValueThisReference` never trusts a resolved, unshadowed, in-file declaration's own `this`-freedom without first checking, via `subtreeContainsReassignmentOf(root, name, 0)` — checked immediately after `findTopLevelFunctionNodeByName` resolves a node and before the arrow-function/`this`-body branches ever run — whether any of the write shapes that function recognises appears anywhere else in the file: a plain/augmented assignment or update expression binding/targeting the name (round 14: through `patternBindsName` for the assignment case, so a destructuring target — `[name] = […]`, `({ name } = …)` — counts too, not only a bare identifier), or a declaration-less `for...in`/`for...of` loop-head target. **This is a recognised-shape guarantee, not the unqualified claim the round-13 text above originally made** ("is never REASSIGNED elsewhere in the file... enforced structurally") — that wording overstated what a bounded AST scan can prove; a write reaching the same identifier through a `parenthesized_expression` target remains invisible, since `patternBindsName` itself has no case for one, and is tracked, left open, at #2630. Verified by WU-10 escape-fallback case (ae) (a module-level `let`-bound arrow, reassigned via a plain statement to a `this`-using function before the object literal using it is constructed, must escape) and, round 14, cases (af)/(ag) (the identical reassignment via an array- and an object-destructuring target respectively, must escape too) — none may silently resolve to the declaration's own, now-stale initial value.
- [ ] **(round 14, #2088 finding 2 — the single-declaration contract; extended round 15, #2088 finding 1, to the module's own VAR SCOPE, not merely `root`'s direct children; corrected round 16, #2636, to state what "a declaration" actually means for this count).** `findTopLevelFunctionNodeByName` never returns a top-level declaration of `name` with confidence when a SECOND (or later) declaration of the identical name also exists ANYWHERE in the module's own var scope — enforced structurally by counting every direct-child declaration encountered (a `function_declaration` match, a `generator_function_declaration` match — round 16; see below for why this addition is scoped to direct children only — or a `variable_declarator` match, regardless of its own value's shape) PLUS every `var` declarator or block-level `function_declaration` reachable from the module root without crossing a function boundary (`countHoistedVarScopeDeclarations`, reusing `functionScopeDeclaresVar`'s own traversal rule, round 15) — and returning `null` once the combined total exceeds one, not merely by returning whichever direct-child declaration the scan happens to reach first. **This bullet, through round 15, said "a SECOND declaration of the identical name" without stating that a `generator_function_declaration` is one — an omission round 16 found was not merely imprecise but FALSE AS ENFORCED**: pre-round-16, a direct-child `function_declaration` followed by a direct-child `generator_function_declaration` of the same name left the count at 1 (the generator matched neither the `function_declaration` branch nor, reached via the hoisted-count fallback, `countHoistedVarScopeDeclarations`'s own test), so this function confidently returned the FIRST, possibly-stale declaration — precisely the "returns a top-level declaration... with confidence when a SECOND... also exists" outcome this bullet's own contract forbids. Closed by giving `generator_function_declaration` its own branch in the direct-children loop, parallel to `function_declaration` in every respect. **Deliberately excludes a `lexical_declaration` (`let`/`const`) from the round-15 hoisted count, AND (round 16) deliberately does NOT extend the round-16 generator fix to that same hoisted count**: a `let`/`const` in a nested block is a distinct, block-scoped binding, not a redeclaration, and so is a NESTED `generator_function_declaration` — verified empirically against real Node that Annex B §B.3.3 hoisting never covers a generator declaration, so unlike `function_declaration`, a nested one does not redeclare the outer binding at all — both are already the shadow axis's own concern (`findResolvingScopeNode`/`introducesShadowedBinding`'s own `statement_block` case, which already recognises `generator_function_declaration` there) — verified by WU-10's new correlation shape 8 (the `let`/`const` exclusion) and case 10 (the round-16 `using_declaration` guard, a different exclusion on the same shadow axis). Verified by WU-10 escape-fallback cases (ah)/(ai) (a direct-child `var`/`function` redeclaration must escape, round 14), (aj)/(ak) (a hoisted `var`/Annex-B redeclaration must escape too, round 15), and (aq) (a MIXED plain-then-generator direct-child redeclaration must escape too, round 16) — none may silently resolve to a superseded declaration's own value, whether the redeclaration sits at module top level, is reachable only by hoisting through a nested block, or is shaped as a generator rather than a plain function.
- [ ] **(round 16, #2088, #2630/#2632/#2634 — the parenthesized-target, `using`-declaration, and global-object-write contract).** Condition 4's identifier-resolution chain never resolves an identifier-valued pair/shorthand property, and its write-scan never trusts a resolved declaration's own initial value, on the basis of a shape three independent gaps left invisible: (1) `subtreeContainsReassignmentOf`'s assignment/augmented-assignment branch and (2) its own for-in branch, and (3) `findResolvingScopeNode`'s for-in disjunct, each ORIGINALLY resolved their `left` field through `patternBindsName` alone, which has no case for a `parenthesized_expression` — `(name) = …`, `for ((name) of iter)` as a write, and the identical shape as an ancestor loop-head shadow, were each confidently treated as "no write"/"no shadow found" instead of failing safe (#2630); and (4) `findResolvingScopeNode` had no disjunct at all for a block-scoped `using`/`await using` declaration, since `introducesShadowedBinding`'s `statement_block` case has no case for it either (#2632). All four are closed by unwrapping `left` through a new local `unwrapParens` helper before the three `patternBindsName` calls, and by a fourth `findResolvingScopeNode` disjunct recognising a `using_declaration` via the existing, unmodified `declarationDeclaresName` — enforced structurally at the three/four call sites, **not** by widening `patternBindsName` or `introducesShadowedBinding` themselves, which stay exactly as narrow as `blockContainsIdentifierExcluding`'s and `killsBinding`'s own already-verified-sound uses of them require. Separately, (5) `subtreeContainsReassignmentOf`'s write-scan had no case for a script-scope `var` reassigned through the global object (`globalThis.name = …`/`global`/`self`/`window`) rather than the bare identifier — a `member_expression` target neither `patternBindsName` nor this function's own pre-round-16 branches recognised as writing to `name` at all (#2634) — closed by a new `isGlobalObjectQualifiedWrite` check ORed onto the existing branch, deliberately not gated on the resolved declaration's own kind (costing recall only, in the direction this whole design already accepts elsewhere, never soundness). Verified by WU-10 escape-fallback cases (al)/(am) (a parenthesized write-scan target must escape, #2630, findings 1/2 above), (an) (a parenthesized loop-head shadow must escape too, #2630, finding 3 above), (ao) (a block-scoped `using` shadow must escape too, #2632), and (ap) (a `globalThis`-qualified write must escape too, #2634), and by correlation shapes 9–11 (the guard cases proving none of the four fixes over-escapes the legitimate neighbouring shape: an unparenthesized binding, a `using` declaration for an unrelated name, and a non-global object's own property write, respectively).
- [ ] **(round 17, #2637 / finding 1 / finding 2 / finding 3 — the `switch_body`/`for_statement`, `var`-kind-for-in, bracket-subscript, and `with`-statement contract).** Condition 4's identifier-resolution chain never resolves an identifier-valued pair/shorthand property, and its write-scan and redeclaration-count never trust a resolved declaration's own initial value or uniqueness, on the basis of a shape any of four further independent gaps left invisible: (1) `findResolvingScopeNode` had no `switch_body` disjunct, so a shadow-equivalent `using` declaration inside an unbraced `switch` case was as invisible as the `statement_block` case was before round 16 (#2637) — closed by a disjunct mirroring the existing `statement_block` one's shape exactly; auditing every OTHER `SCOPE_NODE_TYPES` member for the identical gap, rather than stopping at `switch_body` alone, surfaced ONE more instance (a C-style `for` loop's own init clause, also #2637) — closed the same way, completing the audit of every member; (2) `countHoistedVarScopeDeclarations` had no case recognising a `var`-kind for-of/for-in loop head as a hoisted declaration site, since the grammar places its `kind`/`left` fields directly under `for_in_statement`, never wrapped in a `variable_declaration` node, and (3) `subtreeContainsReassignmentOf`'s own for-in gate excluded any head carrying a `kind` field at all, conflating "carries a `kind` token" with "declares a genuinely new binding" — true of `let`/`const`/`using`, false of `var` (finding 1) — both closed independently, neither relying on the other alone; and (4) `isGlobalObjectQualifiedWrite` recognised only the `member_expression` (dot) spelling of a global-object-qualified write, leaving the `subscript_expression` (bracket) spelling exactly as invisible as the dot spelling itself was before round 16 (finding 2) — closed by a new `subscript_expression` arm reusing `isTrackedReferencePosition`'s own static-key normalisation verbatim. All are closed WITHOUT widening `introducesShadowedBinding`, `patternBindsName`, or `SCOPE_NODE_TYPES` themselves. Separately, (5) `findResolvingScopeNode` gained a further, UNCONDITIONAL disjunct: any `with_statement` ancestor makes resolution unknowable regardless of `name` (finding 3), correcting the Risks table's own prior conflation of `with`'s undecidable RESOLUTION target with its perfectly detectable mere PRESENCE. Verified by WU-10 escape-fallback cases (ar) (a `switch_body` `using` shadow must escape, #2637), (as) (a `var`-kind for-of rebind must escape too, finding 1), (at) (a bracket-subscript global write must escape too, finding 2), (au) (a `with` block must escape too, finding 3), and (av) (the `for_statement` `using` shadow must escape too, #2637), and by correlation shapes 13–15 (the guard cases proving three of the five fixes do not over-escape the legitimate neighbouring shape: a `using` for a different name in the same switch clause, a `let`-kind for-of head reusing the same name, and a non-global object's own bracket-subscript write, respectively). Shapes 16 and 17, guarding the remaining two (`with_statement` and `for_statement`) fixes, were themselves round-18 findings — see the round-18 bullet below for why their round-17 originals were no-ops and what replaced them. A sixth item, flagged by Greptile — `subtreeContainsReassignmentOf`'s `update_expression` arm lacked the same `unwrapParens` routing its two siblings gained in round 16 — is fixed for consistency and guarded by correlation shape 18, but gains no escape-fallback case of its own: verified empirically that an update expression's own numeric-coercion semantics mean no construction through this arm alone can reassign a handler to a new function value, so unlike every fix above, no soundness repro exists to fixture.
- [ ] **(round 18, #2637 reopened / U2 / U3 / U4 / Greptile — the fixture-verification standing rule, the getter-return-value contract, the `method_definition` spurious-shadow contract, the parenthesized-global-write contract, and the var-alias boundary contract).** Round 17's own `switch_body`/`for_statement` bullet, immediately above, closed #2637 for BOTH the `switch_body` and `for_statement` cases — but the `for_statement` half was never actually closed: `findResolvingScopeNode`'s round-17 disjunct scanned for a `using_declaration` node that `tree-sitter-javascript@0.25.0`'s grammar cannot produce as a `for_statement` initializer at all (verified against `grammar.js:375-390`, `node-types.json`'s own field schema, and the real parser directly — the broken text surfaces as an `ERROR` node instead), so the scan could never match anything; #2637 is reopened. **This establishes a standing rule: every fixture in this plan must be parsed with the real `tree-sitter-javascript` grammar, and the node type(s) a fix keys on must be confirmed present in the resulting tree — a claim that a snippet "runs under Node" is a claim about V8's own parser, never tree-sitter's, and both facts must be verified independently, never one inferred from the other** (see `findResolvingScopeNode`'s own doc comment). Re-closed by keying `findResolvingScopeNode`'s `for_statement` disjunct on the actual `ERROR` shape (both the plain and `await using` spellings, the latter nesting one level deeper) and failing safe UNCONDITIONALLY, mirroring `with_statement`'s own shape — which is also why correlation shapes 16 and 17 (round 17's own originals for these two disjuncts) are REBUILT this round, not merely reused: both were no-ops, neither ever putting the disjunct's own ancestor node on a table's chain at all, and are replaced with fixtures proving each disjunct fires on the ancestor's mere presence regardless of whether that specific ancestor could plausibly shadow anything (see the Naming convention note in WU-10 for why their own assertions read `escapes = 1`, not `escapes = 0`). Separately: (U2) `literalHasUnmodeledThisReference`'s `method_definition` arm proved safety only via `subtreeContainsThisKeyword`, sound for a plain method but not a GETTER, whose danger lies in what it RETURNS, not what its own body contains — closed by escaping unconditionally on a `get`-flavoured `method_definition`; (U3) `allReferencesTracked` reused `introducesShadowedBinding`'s shared function-shape case, whose `method_definition` alternative treats the node's bare property NAME as a binding — it is not one, and a nested method merely named the same as the tracked binding spuriously pruned its own body, hiding a genuine reference — closed entirely in this consumer, re-deriving `introducesShadowedBinding`'s own two genuine sub-checks (parameter, hoisted `var`) for this one node kind without touching the shared primitive; and (U4) `isGlobalObjectQualifiedWrite` required `object.type === 'identifier'` in both arms, so a single paren layer around the global-object identifier defeated it entirely — closed by routing `object` through the existing `unwrapParens` in both arms and at the function's own call site (this same call-site fix also closes Greptile's own, separately-flagged whole-target-parenthesized repro, `(globalThis.run) = …`). All four are closed WITHOUT widening `introducesShadowedBinding`, `patternBindsName`, or `SCOPE_NODE_TYPES` themselves. **Separately, a fifth, Greptile-flagged finding on condition 3's own walk (not condition 4's resolution chain): `allReferencesTracked`'s rebinding recursion reused the outer call's `declaringScope` unconditionally for a recursive alias check — sound only when the alias is lexically (`let`/`const`) scoped, since a `var`-declared alias is function-scoped and can be genuinely referenced past whatever narrower block the table itself sits in, a region the reused boundary never reaches** — closed by widening the recursive call's own boundary to the alias's nearest enclosing function (or root) specifically when its declarator is `var`-kind. Verified by WU-10 escape-fallback cases (av) (corrected) and (aw) (the `for_statement`/malformed-`using` gap, both spellings), (ax) (a getter's return value must escape, U2), (ay) (a `method_definition` name collision must escape, U3), (az) (a parenthesized global-object write must escape, U4, extended in-fixture for Greptile's own whole-target-paren repro), and (ba) (a `var`-aliased block-scoped table referenced outside its block must escape, Greptile), and by correlation shapes 16/17 (rebuilt, proving the two unconditional disjuncts fire regardless of plausible shadowing), 19 (ROUND 19 CORRECTION: a co-located, unrelated getter still makes the WHOLE site escape, since `literalHasUnmodeledThisReference` is a whole-literal predicate — this shape's own pre-round-19 EXPECT and framing claimed the opposite and are corrected in WU-10; U2), 20 (a method's own GENUINE parameter shadow must still prune correctly, U3), 21 (a parenthesized write to a non-global object must not be mistaken for one, U4), and 22 (a `var` alias needing no boundary widening must still correlate, Greptile).
- [ ] **(round 19, #2088 findings 1/2/3 — the `__proto__`-key contract, the `allReferencesTracked` node-type-completeness contract, the for-of `var`-boundary contract, and the ablation-verification standing rule).** `literalHasUnmodeledThisReference` never treats a non-computed `__proto__` pair as safe on the strength of its VALUE's own shape (`isPositivelyThisFreeLiteral`'s `object`/`array` arms), since ECMA-262 Annex B.3.1 gives that one KEY special, receiver-preserving meaning no value-shape reasoning accounts for — enforced by a caller-side check on the `pair`'s own `key` field, escaping unconditionally on a non-computed `__proto__` key regardless of `value`, with a COMPUTED `['__proto__']` key deliberately excluded (finding 1). `allReferencesTracked`'s reference-matching walk never silently skips a genuine reference merely because it is spelled as a `shorthand_property_identifier` rather than a plain `identifier` — enforced by widening the walk's own node-type filter to match both kinds, with an object-literal `property_identifier` KEY deliberately excluded, since a key is never itself a value-producing reference (finding 3). The for-of recursion inside `allReferencesTracked` never reuses the outer call's `declaringScope` unconditionally for a `var`-kind loop variable — enforced by widening its own boundary to the loop variable's nearest enclosing function the identical way round 18 widens the REBINDING recursion's, correcting round 18's own essay, which asserted without checking that a for-of loop variable was "always block-scoped" (finding 2). Verified by WU-10 escape-fallback cases (bb) (a non-computed `__proto__` pair must escape, finding 1), (bc) (a shorthand-property forward into an imported function must escape, finding 3), and (bd) (a `var`-kind for-of loop variable referenced outside its block must escape, finding 2), and by correlation shapes 23 (a computed `__proto__` key must not be mistaken for the dangerous spelling), 24 (an unrelated object literal's own key sharing the tracked binding's name must not be mistaken for a reference to it), and 25 (a `let`-kind for-of loop variable must keep its un-widened boundary and must not be confused by an unrelated, wider-scoped binding of the identical name). **Separately, this round adds a standing rule, alongside the existing fail-closed (round 9), DIRECTION-label (round 16/17), and fixture-parse (round 18) rules: every fix in this plan must be shown load-bearing by ABLATION — remove the fix, and its own escape-fallback case must flip from `escapes = 1` back to `escapes = 0`; every guard/correlation-shape case must flip in the OPPOSITE direction when the fix it guards is ablated. A fixture that still passes with its own fix ablated proves nothing and must be rebuilt** — this is how round 19 itself found that shape 17 (round 18's own rebuild) was still vacuous (ablating the `for_statement`/malformed-`using` disjunct left it at `escapes = 1` regardless, since its OTHER property independently failed safe) and that shape 19's own EXPECT was wrong (it asserted `escapes = 0` for a literal this design's own U2 rule makes escape unconditionally) — both found by applying this exact discipline to round 18's own fixtures, not merely to round 19's new ones. Shape 17 is rebuilt a second time (see WU-10's own commentary) so the disjunct is the only remaining thing able to make it escape; shape 19's EXPECT is corrected to `escapes = 1`.
- [ ] **(round 20, #2088, B1–B5/#2640, G1, UE-C — the escaped-`__proto__`-key contract, the var-boundary-widening-granularity contract, the round-19-ablation-retroactivity contract, the `globalThis`-qualified-read contract, and two non-blocking consistency contracts).** `literalHasUnmodeledThisReference`'s `pair`-key check never trusts a raw, quote-stripped text comparison alone to rule out the ECMA-262 Annex B.3.1 `__proto__` spelling — enforced by additionally fail-safing on any backslash in a non-computed key's own raw text, alongside the existing stripped-text equality (B1). Neither of `allReferencesTracked`'s var-boundary-widening recursions (the rebinding alias's, round 18; the for-of loop variable's, round 19) ever targets the enclosing function-shape node itself as the widened `declaringScope` — enforced by targeting that node's own `body` field instead, reusing round 8's existing declaringScope-exemption mechanism unchanged rather than adding a second, node-kind-specific one (B2). Round 19's OWN ablation-verification standing rule (immediately above) is retroactively satisfied against round 19's OWN fixtures, not only against fixtures added in later rounds — enforced by re-running that exact discipline against every existing correlation shape and escape-fallback case while implementing this round, which is what surfaced shapes 23 and 25's own vacuousness (B3/B4). `allReferencesTracked`'s candidate-matching walk never treats a `globalThis`-qualified read of a script-scope binding as if no reference exists at all, merely because neither existing node-matching case (round 19's `identifier`/`shorthand_property_identifier` text-match) recognises it — enforced by a third, structural node-matching case reusing `isGlobalObjectQualifiedWrite` verbatim, always classified untracked (B5, closes #2640). Separately (non-blocking): `isGlobalObjectQualifiedWrite`'s `subscript_expression` arm never trusts an un-unwrapped INDEX field the way its pre-round-18 `object` field once was (G1); `isTrackedReferencePosition` never accepts a member call whose property is `call`/`apply`/`bind` as a genuine correlation candidate, since the pre-existing general call extractor already strips its receiver regardless of context (UE-C). Verified by new WU-10 escape-fallback cases (be) (B1), (bf)/(bg) (B2, one per recursion), (bh) (B5), (bi) (G1), and (bj) (UE-C, non-blocking), by rebuilt correlation shapes 23/25 (B3/B4, now genuinely discriminating rather than vacuous), and by new correlation shape 26 (B5's own non-global-lookalike guard). Every fix in this round was ablated BEFORE this doc was written, per round 19's own standing rule, applied for the first time to a round's own fixtures as they were being built rather than discovered missing after the fact.
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
