//! Native role classification via rusqlite.
//!
//! Replaces the JS `classifyNodeRolesFull` / `classifyNodeRolesIncremental`
//! functions: runs fan-in/fan-out queries, computes medians, classifies roles,
//! and batch-updates nodes — all in a single Rust function with one DB
//! connection, eliminating JS<->SQLite round-trips.

use std::collections::HashMap;

use napi_derive::napi;
use rusqlite::Connection;

// ── Constants ────────────────────────────────────────────────────────

pub(crate) const FRAMEWORK_ENTRY_PREFIXES: &[&str] = &["route:", "event:", "command:"];

const LEAF_KINDS: &[&str] = &["parameter", "property", "constant"];

/// Type definition kinds consumed via type annotations and struct literals, not calls.
/// These never get inbound call edges by design — no call edge is emitted for type usage.
/// If the same file has active callables, these types are almost certainly live.
const TYPE_DEF_KINDS: &[&str] = &["struct", "enum", "trait", "type", "interface", "record"];

/// All kinds that are consumed via references or type-annotations rather than call edges.
/// Equals `TYPE_DEF_KINDS` ∪ `{"constant"}`.
/// Used by `compute_active_files` to exclude annotation-only nodes when deciding whether
/// a file has any actively-called symbols — mirrors `ANNOTATION_ONLY_KINDS` in the TS classifier.
const ANNOTATION_ONLY_KINDS: &[&str] = &[
    "constant",
    "struct",
    "enum",
    "trait",
    "type",
    "interface",
    "record",
];

/// Path patterns indicating framework-dispatched entry points (matches JS
/// `ENTRY_PATH_PATTERNS` in `graph/classifiers/roles.ts`).
const ENTRY_PATH_PATTERNS: &[&str] = &[
    "cli/commands/",
    "cli\\commands\\",
    "mcp/",
    "mcp\\",
    "routes/",
    "routes\\",
    "route/",
    "route\\",
    "handlers/",
    "handlers\\",
    "handler/",
    "handler\\",
    "middleware/",
    "middleware\\",
];

/// Well-known Commander.js dispatch method names.
/// When a method with one of these names lives in a file matching
/// ENTRY_PATH_PATTERNS it is the actual framework entry point — not merely a
/// candidate — so it is classified as `entry` rather than `dead-entry`.
/// Mirrors `COMMANDER_DISPATCH_NAMES` in `graph/classifiers/roles.ts`.
const COMMANDER_DISPATCH_NAMES: &[&str] = &["execute", "validate"];

// ── Output types ─────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct RoleSummary {
    pub entry: u32,
    pub core: u32,
    pub utility: u32,
    pub adapter: u32,
    pub dead: u32,
    #[napi(js_name = "deadLeaf")]
    pub dead_leaf: u32,
    #[napi(js_name = "deadEntry")]
    pub dead_entry: u32,
    #[napi(js_name = "deadFfi")]
    pub dead_ffi: u32,
    #[napi(js_name = "deadUnresolved")]
    pub dead_unresolved: u32,
    #[napi(js_name = "testOnly")]
    pub test_only: u32,
    pub leaf: u32,
}

// ── Public napi entry points ─────────────────────────────────────────

// NOTE: The standalone `classify_roles_full` and `classify_roles_incremental`
// napi exports were removed in Phase 6.17. All callers now use the corresponding
// NativeDatabase methods which reuse the persistent connection, eliminating the
// double-connection antipattern.

// ── Shared helpers ───────────────────────────────────────────────────

fn median(sorted: &[u32]) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let mid = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] as f64 + sorted[mid] as f64) / 2.0
    } else {
        sorted[mid] as f64
    }
}

/// Compute, per file, the set of symbol names that are `TYPE_DEF_KINDS`-kind
/// declarations (interface/type/struct/enum/trait/record). Mirrors JS
/// `computeTypeDefNamesByFile` in `graph/classifiers/roles.ts`.
fn compute_type_def_names_by_file(
    rows: &[(i64, String, String, String, u32, u32)],
) -> HashMap<String, std::collections::HashSet<String>> {
    let mut by_file: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    for (_id, name, kind, file, _fan_in, _fan_out) in rows {
        if TYPE_DEF_KINDS.contains(&kind.as_str()) {
            by_file
                .entry(file.clone())
                .or_default()
                .insert(name.clone());
        }
    }
    by_file
}

/// True when `name`/`kind` is a `method`/`property` member of an interface/type
/// declared in the same file — e.g. TS `interface Foo { bar: string }` extracts
/// `bar` as a top-level `method`-kind definition named `Foo.bar` (#1723). Every
/// language extractor qualifies interface/type members as `Owner.member`
/// (mirroring class method qualification), so the owner name is recovered from
/// the prefix before the first `.` and looked up against same-file
/// `TYPE_DEF_KINDS` declarations. Class methods use the identical `Owner.member`
/// convention but are unaffected here because `class` is not in `TYPE_DEF_KINDS`
/// — they remain subject to normal dead-code detection.
///
/// These members can never gain inbound call edges by construction, so a
/// `fan_in == 0` reading carries zero dead-code signal for them, unlike a real
/// function/method where it does. Mirrors JS `isTypeDeclarationMember`.
fn is_type_declaration_member(
    name: &str,
    kind: &str,
    file: &str,
    type_def_names_by_file: &HashMap<String, std::collections::HashSet<String>>,
) -> bool {
    if kind != "method" && kind != "property" {
        return false;
    }
    let Some(dot_idx) = name.find('.') else {
        return false;
    };
    let owner_name = &name[..dot_idx];
    type_def_names_by_file
        .get(file)
        .is_some_and(|names| names.contains(owner_name))
}

/// Filter raw `kind = 'property'` rows down to interface/type
/// property-signature members (#1809) — the only property rows that receive a
/// role (`leaf`). Property rows never reach `classify_rows` (they're excluded
/// from the `rows` query), so `is_type_declaration_member` must be applied to
/// them here explicitly — otherwise every property-kind interface member
/// would be misclassified instead of `leaf`, the same bug #1723 fixed for
/// `method`-kind members.
///
/// Genuine (non-interface) class/struct/object fields are deliberately left
/// out of the returned ids — they get no role at all (`NULL`), the same
/// treatment `parameter` receives (#1723). A field's liveness is a question
/// of whether it's read/written anywhere in its owning class, which is a
/// dataflow question this crate has no property-access/write edge tracking
/// to answer, so "zero inbound `calls` edges" (guaranteed by construction)
/// carries zero dead-code signal for it (#1810).
fn filter_type_member_property_rows(
    leaf_rows: Vec<(i64, String, String)>,
    type_def_names_by_file: &HashMap<String, std::collections::HashSet<String>>,
) -> Vec<i64> {
    leaf_rows
        .into_iter()
        .filter(|(_, name, file)| {
            is_type_declaration_member(name, "property", file, type_def_names_by_file)
        })
        .map(|(id, _, _)| id)
        .collect()
}

/// Dead sub-role classification matching JS `classifyDeadSubRole`.
fn classify_dead_sub_role(_name: &str, kind: &str, file: &str) -> &'static str {
    // Leaf kinds
    if LEAF_KINDS.contains(&kind) {
        return "dead-leaf";
    }
    // FFI boundary (checked before dead-entry — an FFI boundary is a more
    // fundamental classification than a path-based hint, matching JS priority)
    let ffi_exts = [".rs", ".c", ".cpp", ".h", ".go", ".java", ".cs"];
    if ffi_exts.iter().any(|ext| file.ends_with(ext)) {
        return "dead-ffi";
    }
    // Framework-dispatched entry points (CLI commands, MCP tools, routes)
    if ENTRY_PATH_PATTERNS.iter().any(|p| file.contains(p)) {
        return "dead-entry";
    }
    "dead-unresolved"
}

/// Classify a single node into a role.
#[allow(clippy::too_many_arguments)]
fn classify_node(
    name: &str,
    kind: &str,
    file: &str,
    fan_in: u32,
    fan_out: u32,
    is_exported: bool,
    is_entrypoint: bool,
    production_fan_in: u32,
    has_active_file_siblings: bool,
    is_type_member: bool,
    median_fan_in: f64,
    median_fan_out: f64,
) -> &'static str {
    // Interface/type members (#1723) — never subject to call-graph dead-code
    // detection, regardless of fan-in/fan-out/export status.
    if is_type_member {
        return "leaf";
    }

    // Framework entry
    if FRAMEWORK_ENTRY_PREFIXES.iter().any(|p| name.starts_with(p)) {
        return "entry";
    }

    // A confirmed program entrypoint (#2392) — the runtime invokes it, so its
    // in-repo fan-in shape says nothing about how it is reached. Checked
    // before the `fan_in == 0` gate, unlike the export-based rule: an
    // entrypoint invoked from its own module's `__main__` guard does have an
    // inbound call edge (the module-level call, attributed to the file node).
    if is_entrypoint {
        return "entry";
    }

    if fan_in == 0 && !is_exported {
        // Well-known Commander.js dispatch methods (execute, validate) in framework
        // directories are confirmed entry points, not candidates. Promote them to
        // `entry` so they don't appear in `--role dead` output.
        if COMMANDER_DISPATCH_NAMES.contains(&name)
            && ENTRY_PATH_PATTERNS.iter().any(|p| file.contains(p))
        {
            return "entry";
        }
        if has_active_file_siblings {
            // Constants consumed via identifier reference (not calls) have no
            // inbound call edges. If the same file has active callables, the
            // constant is almost certainly used locally — classify as leaf.
            if kind == "constant" {
                return "leaf";
            }
            // Type definitions (struct, enum, trait, type, interface, record) are
            // consumed via type annotations and struct literals — not calls — so they
            // never get inbound call edges. If the same file has active callables,
            // these types are almost certainly live — classify as leaf.
            if TYPE_DEF_KINDS.contains(&kind) {
                return "leaf";
            }
            // Methods implementing interfaces are dispatched via conditional property
            // access e.g. `if (v.enterFunction) v.enterFunction(...)`. Codegraph
            // resolves the call to the property accessor rather than to the concrete
            // method implementation, so the method has no inbound call edge. We
            // require `fan_out > 0` as evidence of non-triviality, mirroring the
            // function case — trivially-inert dead helper methods remain visible.
            if kind == "method" && fan_out > 0 {
                return "leaf";
            }
            // Functions referenced as logical-or fallback defaults — e.g.
            // `const fn = options._fetchLatest || fetchLatestVersion` — appear as
            // value references, not call sites, so no call edge is produced. We
            // require `fan_out > 0` as evidence that the function is non-trivial
            // (i.e. it calls something), ruling out truly inert dead helpers.
            //
            // NOTE (#1771): this used to also be the only thing rescuing functions
            // referenced as object-literal property values (dispatch tables, e.g.
            // `{ resolve: someFunction }`) — and only by coincidence, for whichever
            // of those functions happened to have fan_out > 0 themselves. That
            // pattern now gets a real `calls` edge (dynamic_kind "value-ref") at
            // extraction time, so it no longer depends on this heuristic. Kept
            // here as a fallback for value-reference shapes that still produce no
            // edge at all — the logical-or default above, and others (ternary
            // defaults, array-of-functions elements, default parameter values)
            // that aren't extracted as edges yet.
            if kind == "function" && fan_out > 0 {
                return "leaf";
            }
        }
        return classify_dead_sub_role(name, kind, file);
    }

    if fan_in == 0 && is_exported {
        // Exported, zero fan-in. A genuine entry point (CLI command handler,
        // exported API function called from outside the codebase, ESM loader
        // hook, MCP tool handler, etc.) is always a function or method. Every
        // other exported kind (interface/type/constant/class) is a live,
        // intentional part of the public surface — but a data shape or config
        // value, not something invoked from outside the codebase — so it's
        // `leaf`: never `dead-*` (#1583) and never `entry` (#1780), regardless
        // of whether the file has other active siblings. Mirrors JS
        // `classifyNodeRole`.
        return if kind == "function" || kind == "method" {
            "entry"
        } else {
            "leaf"
        };
    }

    // Test-only: has callers but all are in test files
    if fan_in > 0 && production_fan_in == 0 && !is_exported {
        return "test-only";
    }

    let high_in = fan_in as f64 >= median_fan_in && fan_in > 0;
    let high_out = fan_out as f64 >= median_fan_out && fan_out > 0;

    if high_in && !high_out {
        "core"
    } else if high_in && high_out {
        "utility"
    } else if !high_in && high_out {
        "adapter"
    } else {
        "leaf"
    }
}

fn increment_summary(summary: &mut RoleSummary, role: &str) {
    match role {
        "entry" => summary.entry += 1,
        "core" => summary.core += 1,
        "utility" => summary.utility += 1,
        "adapter" => summary.adapter += 1,
        "leaf" => summary.leaf += 1,
        "test-only" => summary.test_only += 1,
        "dead-leaf" => {
            summary.dead += 1;
            summary.dead_leaf += 1;
        }
        "dead-ffi" => {
            summary.dead += 1;
            summary.dead_ffi += 1;
        }
        "dead-entry" => {
            summary.dead += 1;
            summary.dead_entry += 1;
        }
        "dead-unresolved" => {
            summary.dead += 1;
            summary.dead_unresolved += 1;
        }
        _ => summary.leaf += 1,
    }
}

/// Batch UPDATE nodes SET role = ? WHERE id IN (...) using chunked statements.
fn batch_update_roles(
    tx: &rusqlite::Transaction,
    ids_by_role: &HashMap<&str, Vec<i64>>,
) -> rusqlite::Result<()> {
    const CHUNK: usize = 500;

    for (role, ids) in ids_by_role {
        for chunk in ids.chunks(CHUNK) {
            let placeholders: String = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("UPDATE nodes SET role = ?1 WHERE id IN ({})", placeholders);
            let mut stmt = tx.prepare_cached(&sql)?;
            // Bind role as param 1, then each id
            stmt.raw_bind_parameter(1, *role)?;
            for (i, id) in chunk.iter().enumerate() {
                stmt.raw_bind_parameter(i + 2, *id)?;
            }
            stmt.raw_execute()?;
        }
    }
    Ok(())
}

// ── Full classification ──────────────────────────────────────────────

pub(crate) fn do_classify_full(conn: &Connection) -> rusqlite::Result<RoleSummary> {
    let tx = conn.unchecked_transaction()?;
    let mut summary = RoleSummary::default();

    // 1. Property kind (class/struct/object fields). Interface/type
    // property-signature members (#1809) are filtered out below via
    // `is_type_declaration_member` once `type_def_names_by_file` is available
    // and classified `leaf`. Genuine (non-interface) fields get no role at
    // all (#1810) — see `filter_type_member_property_rows`.
    // `parameter` is deliberately NOT included here (#1723): a parameter's liveness
    // is a local dataflow question, not a call-graph reachability question, so
    // "no incoming call edges" carries zero dead-code signal for it. Parameters are
    // also excluded from the main rows query below, so they never receive a role
    // at all — the same treatment as `file`/`directory` nodes.
    let leaf_rows: Vec<(i64, String, String)> = {
        let mut stmt = tx.prepare("SELECT id, name, file FROM nodes WHERE kind = 'property'")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 2. Fan-in/fan-out for callable nodes (uses JOIN approach for full scan)
    //    Fan-in includes 'imports-type' edges to match JS classification.
    let rows: Vec<(i64, String, String, String, u32, u32)> = {
        let mut stmt = tx.prepare(
            "SELECT n.id, n.name, n.kind, n.file,
                COALESCE(fi.cnt, 0) AS fan_in,
                COALESCE(fo.cnt, 0) AS fan_out
             FROM nodes n
             LEFT JOIN (
                SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind IN ('calls', 'imports-type') GROUP BY target_id
             ) fi ON n.id = fi.target_id
             LEFT JOIN (
                SELECT source_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY source_id
             ) fo ON n.id = fo.source_id
             WHERE n.kind NOT IN ('file', 'directory', 'parameter', 'property')",
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, u32>(5)?,
            ))
        })?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    if rows.is_empty() && leaf_rows.is_empty() {
        tx.commit()?;
        return Ok(summary);
    }

    // 2b. Program-entrypoint IDs (#2392) — set by `mark_entrypoint_targets`
    // from an extractor-flagged call site (Python's `__main__` guard and
    // `__main__.py` module level). Mirrors the `entrypoint` column read by
    // `buildClassifierInput` in features/structure.ts.
    let entrypoint_ids: std::collections::HashSet<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM nodes WHERE entrypoint = 1")?;
        let mapped = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    // 3. Exported IDs (cross-file callers including imports-type)
    let mut exported_ids: std::collections::HashSet<i64> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT e.target_id
             FROM edges e
             JOIN nodes caller ON e.source_id = caller.id
             JOIN nodes target ON e.target_id = target.id
             WHERE e.kind IN ('calls', 'imports-type') AND caller.file != target.file",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 3b. Mark symbols as exported when their files are targets of reexport edges
    // from production-reachable barrels (traces through multi-level chains) (#837).
    //
    // The recursive CTE works in two stages:
    //   Base case: find all file nodes directly imported by production (non-test) files.
    //   Recursive step: follow 'reexports' edges outward to discover barrel chains
    //     (e.g. index.ts re-exports from internal.ts which re-exports from core.ts).
    // Then: any symbol whose file is a reexport target of a prod-reachable barrel
    // is considered exported (prevents false dead-code classification).
    //
    // `method` is excluded (#1780): a `reexports` edge only ever concerns
    // top-level module bindings (functions, classes, types, constants, ...) —
    // a class/interface method can never be an independently re-exportable
    // binding on its own, so inheriting "exported" status from a co-located
    // top-level re-export is a category error. Without this exclusion, e.g. an
    // abstract base class's zero-fan-in method declarations were promoted to
    // `entry` merely because some other symbol in the same file was re-exported
    // through a barrel.
    //
    // `public_surface_ids` mirrors the TS `publicSurfaceIds` narrower "genuinely
    // public" set for #2032's reachability roots (explicit `export` + confirmed
    // reexport chains only, excluding `exported_ids`'s cross-file-caller
    // component above) — see `is_live_root`'s doc comment for why that
    // component must not grant automatic root status.
    //
    // Deliberately NOT reusing the whole-file `exported_ids` query above
    // (Greptile review): that query treats ANY `reexports` edge — whether
    // from `export { specificThing } from './b'` (which only re-exports
    // `specificThing`) or `export * from './b'` (which genuinely re-exports
    // everything) — as "every symbol in the target file is exported". For a
    // named reexport that over-broadly marks every OTHER private symbol in
    // that file as a public-surface root too, letting an unreachable private
    // call chain sharing a file with one re-exported symbol evade the whole
    // check. A named reexport gets its own symbol-level `reexports` edge
    // (target = the specific symbol node, not the file) — use that directly;
    // only a genuine wildcard reexport (kind `reexports-wildcard`) justifies
    // marking the whole file.
    let mut public_surface_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    {
        let sql = format!(
            "WITH RECURSIVE prod_reachable(file_id) AS (
                SELECT DISTINCT e.target_id
                FROM edges e
                JOIN nodes src ON e.source_id = src.id
                WHERE e.kind IN ('imports', 'dynamic-imports', 'imports-type')
                  AND src.kind = 'file'
                  {}
                UNION
                SELECT e.target_id
                FROM edges e
                JOIN prod_reachable pr ON e.source_id = pr.file_id
                WHERE e.kind = 'reexports'
              )
              SELECT DISTINCT n.id
              FROM nodes n
              JOIN nodes f ON f.file = n.file AND f.kind = 'file'
              WHERE f.id IN (
                SELECT e.target_id FROM edges e
                WHERE e.kind = 'reexports'
                  AND e.source_id IN (SELECT file_id FROM prod_reachable)
              )
              AND n.kind NOT IN ('file', 'directory', 'parameter', 'property', 'method')",
            test_file_filter_col("src.file")
        );
        let mut stmt = tx.prepare(&sql)?;
        let reexport_rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for r in reexport_rows.flatten() {
            exported_ids.insert(r);
        }
    }
    {
        let sql = format!(
            "WITH RECURSIVE prod_reachable(file_id) AS (
                SELECT DISTINCT e.target_id
                FROM edges e
                JOIN nodes src ON e.source_id = src.id
                WHERE e.kind IN ('imports', 'dynamic-imports', 'imports-type')
                  AND src.kind = 'file'
                  {}
                UNION
                SELECT e.target_id
                FROM edges e
                JOIN prod_reachable pr ON e.source_id = pr.file_id
                WHERE e.kind = 'reexports'
              )
              SELECT DISTINCT e.target_id AS id
              FROM edges e
              JOIN nodes n ON n.id = e.target_id
              WHERE e.kind = 'reexports' AND n.kind != 'file'
                AND e.source_id IN (SELECT file_id FROM prod_reachable)
              UNION
              SELECT DISTINCT n.id AS id
              FROM nodes n
              JOIN nodes f ON f.file = n.file AND f.kind = 'file'
              WHERE f.id IN (
                SELECT e.target_id FROM edges e
                WHERE e.kind = 'reexports-wildcard'
                  AND e.source_id IN (SELECT file_id FROM prod_reachable)
              )
              AND n.kind NOT IN ('file', 'directory', 'parameter', 'property', 'method')",
            test_file_filter_col("src.file")
        );
        let mut stmt = tx.prepare(&sql)?;
        let public_surface_rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for r in public_surface_rows.flatten() {
            public_surface_ids.insert(r);
        }
    }

    // 3c. Mark symbols with exported=1 as exported — the extractor sets this flag when the
    // author writes `export interface Foo { }` / `export type Bar = ...` / `export function`.
    // Cross-file edge inference misses these when the symbol is only used as a type annotation
    // within the same file (no calls/imports-type edge is produced for same-file type usage).
    // This fixes false dead-unresolved classification for exported interfaces (#1583).
    {
        let mut stmt = tx.prepare(
            "SELECT id FROM nodes
             WHERE exported = 1
               AND kind NOT IN ('file', 'directory', 'parameter', 'property')",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for r in rows.flatten() {
            exported_ids.insert(r);
            public_surface_ids.insert(r);
        }
    }

    // 4. Production fan-in (excluding test files, including imports-type)
    let prod_fan_in: HashMap<i64, u32> = {
        let sql = format!(
            "SELECT e.target_id, COUNT(*) AS cnt
             FROM edges e
             JOIN nodes caller ON e.source_id = caller.id
             WHERE e.kind IN ('calls', 'imports-type') {}
             GROUP BY e.target_id",
            test_file_filter()
        );
        let mut stmt = tx.prepare(&sql)?;
        let mapped =
            stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, u32>(1)?)))?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    // 5. Compute medians from non-zero values
    let mut fan_in_vals: Vec<u32> = rows.iter().map(|r| r.4).filter(|&v| v > 0).collect();
    let mut fan_out_vals: Vec<u32> = rows.iter().map(|r| r.5).filter(|&v| v > 0).collect();
    fan_in_vals.sort_unstable();
    fan_out_vals.sort_unstable();
    let median_fan_in = median(&fan_in_vals);
    let median_fan_out = median(&fan_out_vals);

    // 5b. Compute active files (files with non-constant callables connected to the graph)
    let (active_files, called_active_files) = compute_active_files(&rows);

    // 5c. Compute interface/type owner names per file (#1723) — used to recognize
    // method/property members of type-level declarations, which must never be
    // judged dead by call-graph reachability.
    let type_def_names_by_file = compute_type_def_names_by_file(&rows);

    // 6. Classify and collect IDs by role
    let mut ids_by_role: HashMap<&str, Vec<i64>> = HashMap::new();

    let type_member_leaf_ids = filter_type_member_property_rows(leaf_rows, &type_def_names_by_file);
    if !type_member_leaf_ids.is_empty() {
        summary.leaf += type_member_leaf_ids.len() as u32;
        ids_by_role
            .entry("leaf")
            .or_default()
            .extend(type_member_leaf_ids);
    }

    let mut role_by_id = classify_rows(
        &rows,
        &exported_ids,
        &entrypoint_ids,
        &prod_fan_in,
        &active_files,
        &called_active_files,
        &type_def_names_by_file,
        median_fan_in,
        median_fan_out,
    );

    // 6b. Transitive-reachability dead-code downgrade (#2032). This path
    // needs the FULL graph's `calls`-edge adjacency (not just `rows`, which
    // already spans every callable node on this path) to compute reachability
    // correctly — a single indexed full-table scan, consistent with the other
    // full-graph scans this function already performs.
    //
    // `do_classify_incremental` runs its own version of this
    // (`run_incremental_reachability_downgrade`, issue #2255) rather than
    // reusing this exact call: reachability is a whole-graph property that a
    // changed-files-plus-one-hop-neighbour window cannot answer correctly by
    // just widening `rows`, and re-running a full scan on every incremental
    // build the way this path does would reintroduce exactly the cost this
    // path's neighbour-scoping was built to avoid (#1855) — see that
    // function's doc comment for the conservative-approximation design that
    // avoids it.
    let call_edges: Vec<(i64, i64)> = {
        let mut stmt = tx.prepare("SELECT source_id, target_id FROM edges WHERE kind = 'calls'")?;
        let mapped =
            stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?;
        mapped.filter_map(|r| r.ok()).collect()
    };
    apply_reachability_downgrade(
        &rows,
        &public_surface_ids,
        &called_active_files,
        &type_def_names_by_file,
        &entrypoint_ids,
        &call_edges,
        &mut role_by_id,
    );

    finalize_roles(&role_by_id, &mut ids_by_role, &mut summary);

    // 7. Batch UPDATE: reset all roles then set per-role
    tx.execute("UPDATE nodes SET role = NULL", [])?;
    batch_update_roles(&tx, &ids_by_role)?;

    tx.commit()?;
    Ok(summary)
}

/// Build the test-file exclusion filter for SQL queries (default column: `caller.file`).
fn test_file_filter() -> String {
    test_file_filter_col("caller.file")
}

/// Build the test-file exclusion filter for an arbitrary column name. Delegates to the
/// shared `infrastructure::test_filter` module (single source of truth, #2256).
fn test_file_filter_col(column: &str) -> String {
    crate::infrastructure::test_filter::test_file_filter_col(column)
}

/// Compute two active-files sets from callable rows.
///
/// Returns `(active_files, called_active_files)`:
/// - `active_files`: files with at least one non-annotation-only callable with
///   `fan_in > 0 || fan_out > 0`. Used for annotation-only kinds (constants,
///   type defs) which have no callers by design.
/// - `called_active_files`: files with at least one non-annotation-only callable
///   with `fan_in > 0` (strictly called). Used for method/function kinds to
///   prevent a self-sibling false negative: a function with `fan_in=0, fan_out>0`
///   as the sole callable in its file must NOT count itself as an "active sibling"
///   and thereby promote itself to `leaf`.
fn compute_active_files(
    rows: &[(i64, String, String, String, u32, u32)],
) -> (
    std::collections::HashSet<String>,
    std::collections::HashSet<String>,
) {
    let mut active = std::collections::HashSet::new();
    let mut called_active = std::collections::HashSet::new();
    for (_id, _name, kind, file, fan_in, fan_out) in rows {
        if !ANNOTATION_ONLY_KINDS.contains(&kind.as_str()) {
            if *fan_in > 0 || *fan_out > 0 {
                active.insert(file.clone());
            }
            if *fan_in > 0 {
                called_active.insert(file.clone());
            }
        }
    }
    (active, called_active)
}

/// Compute global median fan-in and fan-out from the edge distribution.
/// Fan-in includes 'imports-type' edges to match JS classification.
fn compute_global_medians(tx: &rusqlite::Transaction) -> rusqlite::Result<(f64, f64)> {
    let median_fan_in = {
        let mut stmt = tx
            .prepare("SELECT COUNT(*) AS cnt FROM edges WHERE kind IN ('calls', 'imports-type') GROUP BY target_id")?;
        let mut vals: Vec<u32> = stmt
            .query_map([], |row| row.get::<_, u32>(0))?
            .filter_map(|r| r.ok())
            .collect();
        vals.sort_unstable();
        median(&vals)
    };
    let median_fan_out = {
        let mut stmt = tx
            .prepare("SELECT COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY source_id")?;
        let mut vals: Vec<u32> = stmt
            .query_map([], |row| row.get::<_, u32>(0))?
            .filter_map(|r| r.ok())
            .collect();
        vals.sort_unstable();
        median(&vals)
    };
    Ok((median_fan_in, median_fan_out))
}

/// Execute a query with bound file parameters and collect i64 results into a HashSet.
fn query_id_set(
    tx: &rusqlite::Transaction,
    sql: &str,
    files: &[&str],
) -> rusqlite::Result<std::collections::HashSet<i64>> {
    let mut stmt = tx.prepare(sql)?;
    for (i, f) in files.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, *f)?;
    }
    let mut rows = stmt.raw_query();
    let mut result = std::collections::HashSet::new();
    while let Some(row) = rows.next()? {
        result.insert(row.get::<_, i64>(0)?);
    }
    Ok(result)
}

/// Execute a query with bound file parameters and collect (id, count) into a HashMap.
fn query_id_counts(
    tx: &rusqlite::Transaction,
    sql: &str,
    files: &[&str],
) -> rusqlite::Result<HashMap<i64, u32>> {
    let mut stmt = tx.prepare(sql)?;
    for (i, f) in files.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, *f)?;
    }
    let mut rows = stmt.raw_query();
    let mut result = HashMap::new();
    while let Some(row) = rows.next()? {
        result.insert(row.get::<_, i64>(0)?, row.get::<_, u32>(1)?);
    }
    Ok(result)
}

/// Classify every row into a role. Returns a per-id role map rather than
/// accumulating directly into `ids_by_role`/`summary` so that, on the
/// full-classification path, `apply_reachability_downgrade` can reconsider
/// individual verdicts before final bucketing/counting via `finalize_roles`.
#[allow(clippy::too_many_arguments)]
fn classify_rows(
    rows: &[(i64, String, String, String, u32, u32)],
    exported_ids: &std::collections::HashSet<i64>,
    entrypoint_ids: &std::collections::HashSet<i64>,
    prod_fan_in: &HashMap<i64, u32>,
    active_files: &std::collections::HashSet<String>,
    called_active_files: &std::collections::HashSet<String>,
    type_def_names_by_file: &HashMap<String, std::collections::HashSet<String>>,
    median_fan_in: f64,
    median_fan_out: f64,
) -> HashMap<i64, &'static str> {
    let mut role_by_id: HashMap<i64, &'static str> = HashMap::with_capacity(rows.len());
    for (id, name, kind, file, fan_in, fan_out) in rows {
        let is_exported = exported_ids.contains(id);
        let prod_fi = prod_fan_in.get(id).copied().unwrap_or(0);
        let is_annotation_only = kind == "constant" || TYPE_DEF_KINDS.contains(&kind.as_str());
        // Set has_active_siblings for annotation-only kinds AND for method/function —
        // the latter two can have fan_in == 0 due to untraced call-site patterns
        // (interface dispatch, logical-or defaults). The classifier interprets this
        // field differently per kind (see classify_node).
        //
        // IMPORTANT: method/function use called_active_files (fan_in > 0 only) to
        // prevent a self-sibling false negative: a function with fan_in=0, fan_out>0
        // as the sole callable in its file must NOT see its own file as "active" and
        // thereby promote itself to leaf.
        let has_active_siblings = if is_annotation_only {
            active_files.contains(file)
        } else if kind == "method" || kind == "function" {
            called_active_files.contains(file)
        } else {
            false
        };
        let is_type_member = is_type_declaration_member(name, kind, file, type_def_names_by_file);
        let role = classify_node(
            name,
            kind,
            file,
            *fan_in,
            *fan_out,
            is_exported,
            entrypoint_ids.contains(id),
            prod_fi,
            has_active_siblings,
            is_type_member,
            median_fan_in,
            median_fan_out,
        );
        role_by_id.insert(*id, role);
    }
    role_by_id
}

/// Bucket a finalized per-id role map into `ids_by_role`/`summary`. Split from
/// `classify_rows` so the full-classification path can run
/// `apply_reachability_downgrade` on the role map first.
fn finalize_roles(
    role_by_id: &HashMap<i64, &'static str>,
    ids_by_role: &mut HashMap<&'static str, Vec<i64>>,
    summary: &mut RoleSummary,
) {
    for (id, role) in role_by_id {
        increment_summary(summary, role);
        ids_by_role.entry(role).or_default().push(*id);
    }
}

/// Roles produced by `classify_node`'s `fan_in > 0` branch (the
/// `high_in`/`high_out` shape decision) — the only verdicts eligible for the
/// reachability downgrade below. Mirrors TS `FAN_SHAPE_ROLES`.
fn is_fan_shape_role(role: &str) -> bool {
    matches!(role, "core" | "utility" | "adapter" | "leaf")
}

/// True when (name, kind, file, is_public_surface) is a confirmed-live
/// reachability root for the transitive dead-code pass (#2032) — mirrors TS
/// `isLiveRoot`. Only covers roots that are themselves `function`/`method`
/// rows; `apply_reachability_downgrade` separately seeds additional roots
/// directly from `call_edges` for non-function/method call sources.
///
/// Deliberately takes `is_public_surface`, NOT the broader `is_exported` that
/// `classify_node`'s own `entry` branch uses — `is_exported` also considers a
/// node "exported" merely because SOME caller in a different file calls it,
/// regardless of whether that caller is itself reachable. Using that signal
/// here would let a symbol called only by an unreachable cross-file caller
/// become an automatic root, defeating #2032's fix for exactly the cross-file
/// case it's meant to catch. `is_public_surface` is narrower: only the
/// explicit `export` keyword and confirmed production-reachable reexport
/// chains — see its computation at the `do_classify_full` call site.
fn is_live_root(
    name: &str,
    kind: &str,
    file: &str,
    is_public_surface: bool,
    is_entrypoint: bool,
    is_type_member: bool,
) -> bool {
    if is_type_member {
        return false;
    }
    if FRAMEWORK_ENTRY_PREFIXES.iter().any(|p| name.starts_with(p)) {
        return true;
    }
    // A program entrypoint is live by definition, so everything it calls is
    // reachable — without this, a `main()` invoked only from its module's
    // `__main__` guard would seed no BFS root and its whole call tree would be
    // eligible for the transitive dead-code downgrade (#2392).
    if is_entrypoint {
        return true;
    }
    if kind != "function" && kind != "method" {
        return false;
    }
    if is_public_surface {
        return true;
    }
    COMMANDER_DISPATCH_NAMES.contains(&name) && ENTRY_PATH_PATTERNS.iter().any(|p| file.contains(p))
}

/// Compute the set of bare (owner-prefix-stripped) member names declared by
/// ANY interface/type-level declaration across `rows` — e.g. TS `interface
/// Visitor { enter_node?(...): ...; exit_node?(...): ...; }` contributes
/// `"enterNode"`/`"exitNode"`. Used by `is_interface_dispatch_method_root` to
/// require that a candidate dispatch method's name corresponds to an actual
/// declared interface contract SOMEWHERE in the codebase, rather than merely
/// "any method with fan_out > 0 in a file that also has other active code" —
/// the latter is indistinguishable from a genuinely-dead, ordinary class
/// method that happens to call a helper. Mirrors TS `computeInterfaceMemberBareNames`.
fn compute_interface_member_bare_names(
    rows: &[(i64, String, String, String, u32, u32)],
    type_def_names_by_file: &HashMap<String, std::collections::HashSet<String>>,
) -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();
    for (_id, name, kind, file, _fan_in, _fan_out) in rows {
        if !is_type_declaration_member(name, kind, file, type_def_names_by_file) {
            continue;
        }
        let bare = match name.find('.') {
            Some(dot_idx) => &name[dot_idx + 1..],
            None => name.as_str(),
        };
        names.insert(bare.to_string());
    }
    names
}

/// True when (kind, fan_in, fan_out, has_active_siblings, is_type_member,
/// name) is a `method`-kind interface-dispatch implementation rescued by
/// `classify_node`'s Pattern-2 heuristic (fan_in == 0, fan_out > 0,
/// has_active_siblings) AND whose bare name corresponds to an actual
/// interface/type declaration member somewhere in the codebase (matched via
/// `interface_member_bare_names`) — e.g. `enter_node`/`exit_node` on a
/// Visitor-shaped object, invoked only via generic property-access dispatch
/// that codegraph cannot trace to a concrete implementation. Such a method
/// can never be the TARGET of a `calls` edge by construction, so it must be
/// an unconditional root — otherwise everything it calls would be wrongly
/// treated as unreachable merely because the dispatch mechanism itself
/// leaves no edge.
///
/// The name-match requirement exists specifically because the
/// fan_in/fan_out/has_active_siblings shape ALONE is too broad: an ordinary,
/// genuinely-dead class method that happens to call a helper and share its
/// file with another called symbol satisfies that shape too. Tying the
/// rescue to an actual declared contract elsewhere in the codebase makes an
/// "ordinary unused method" false positive require a coincidental name
/// collision with some unrelated interface's member, rather than being the
/// default outcome for any such method.
///
/// Deliberately narrower than the sibling rescue for `function`-kind
/// logical-or-fallback values in `classify_node` — that heuristic is an
/// explicitly acknowledged, imprecise last-resort fallback, not a structural
/// certainty like interface dispatch. Promoting it to root status would
/// silently rescue genuinely-dead intermediate functions (the exact #2032
/// pattern) merely because they happen to call something in an active file.
/// Mirrors TS `isInterfaceDispatchMethodRoot`.
fn is_interface_dispatch_method_root(
    name: &str,
    kind: &str,
    fan_in: u32,
    fan_out: u32,
    has_active_siblings: bool,
    is_type_member: bool,
    interface_member_bare_names: &std::collections::HashSet<String>,
) -> bool {
    if kind != "method" || fan_in != 0 || fan_out == 0 || !has_active_siblings || is_type_member {
        return false;
    }
    let bare = match name.find('.') {
        Some(dot_idx) => &name[dot_idx + 1..],
        None => name,
    };
    interface_member_bare_names.contains(bare)
}

/// Forward BFS over `calls` edges starting from `roots`, using a single
/// index-walked `Vec` queue (no repeated front-removal) so the whole
/// traversal is O(V+E) — safe on graphs with tens of thousands of nodes/edges
/// (this repo's own self-build). Mirrors TS `computeReachableIds`.
fn compute_reachable_ids(
    roots: &std::collections::HashSet<i64>,
    call_edges: &[(i64, i64)],
) -> std::collections::HashSet<i64> {
    let mut adjacency: HashMap<i64, Vec<i64>> = HashMap::new();
    for (source, target) in call_edges {
        adjacency.entry(*source).or_default().push(*target);
    }

    let mut visited: std::collections::HashSet<i64> = roots.clone();
    let mut queue: Vec<i64> = visited.iter().copied().collect();
    let mut head = 0;
    while head < queue.len() {
        let current = queue[head];
        head += 1;
        if let Some(outs) = adjacency.get(&current) {
            for next in outs {
                if visited.insert(*next) {
                    queue.push(*next);
                }
            }
        }
    }
    visited
}

/// Downgrade fan-in-based "not dead" verdicts to dead when the node is not
/// transitively reachable from any confirmed-live root via `calls` edges
/// (#2032) — "has at least one inbound `calls` edge" is not sufficient
/// evidence of liveness when that edge's source is itself unreachable.
/// Mirrors TS `applyReachabilityDowngrade` — see its doc comment (in
/// `src/graph/classifiers/roles.ts`) for the full rationale, including why:
///
///  - roots come from `is_live_root` (confirmed `function`/`method` entry
///    points), `is_interface_dispatch_method_root` (Visitor-pattern-style
///    `method`-kind dispatch implementations, which can never be the TARGET
///    of a `calls` edge by construction), AND every `calls`-edge source that
///    is NOT itself a `function`/`method` row (module-top-level `constant`
///    declarations, bare top-level assignments attributed to the enclosing
///    `file`, and other structural kinds) — those represent code that runs
///    unconditionally once their containing scope is parsed, with no
///    genuine "was this invoked" question the way a function/method body has;
///  - this only reconsiders `function`/`method` rows with `fan_in > 0` whose
///    current verdict is a `classify_by_fan_shape`-derived role
///    (`core`/`utility`/`adapter`/`leaf`) — never `test-only`, `entry`, or any
///    verdict from the `fan_in == 0` branch (interface members,
///    `has_active_siblings` rescues, exported zero-fan-in entries), which
///    already correctly resolve liveness through signals reachability
///    doesn't apply to.
#[allow(clippy::too_many_arguments)]
fn apply_reachability_downgrade(
    rows: &[(i64, String, String, String, u32, u32)],
    public_surface_ids: &std::collections::HashSet<i64>,
    called_active_files: &std::collections::HashSet<String>,
    type_def_names_by_file: &HashMap<String, std::collections::HashSet<String>>,
    entrypoint_ids: &std::collections::HashSet<i64>,
    call_edges: &[(i64, i64)],
    role_by_id: &mut HashMap<i64, &'static str>,
) {
    let mut kind_by_id: HashMap<i64, &str> = HashMap::with_capacity(rows.len());
    for (id, _name, kind, _file, _fan_in, _fan_out) in rows {
        kind_by_id.insert(*id, kind.as_str());
    }
    let interface_member_bare_names =
        compute_interface_member_bare_names(rows, type_def_names_by_file);

    let mut roots: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for (id, name, kind, file, fan_in, fan_out) in rows {
        let is_public_surface = public_surface_ids.contains(id);
        let is_type_member = is_type_declaration_member(name, kind, file, type_def_names_by_file);
        if is_live_root(
            name,
            kind,
            file,
            is_public_surface,
            entrypoint_ids.contains(id),
            is_type_member,
        ) {
            roots.insert(*id);
            continue;
        }
        let has_active_siblings = called_active_files.contains(file);
        if is_interface_dispatch_method_root(
            name,
            kind,
            *fan_in,
            *fan_out,
            has_active_siblings,
            is_type_member,
            &interface_member_bare_names,
        ) {
            roots.insert(*id);
        }
    }
    for (source, _target) in call_edges {
        let source_kind = kind_by_id.get(source).copied();
        if source_kind != Some("function") && source_kind != Some("method") {
            roots.insert(*source);
        }
    }

    let reachable = compute_reachable_ids(&roots, call_edges);

    for (id, name, kind, file, fan_in, _fan_out) in rows {
        if kind != "function" && kind != "method" {
            continue;
        }
        if *fan_in == 0 {
            continue;
        }
        // is_type_declaration_member returns "leaf" unconditionally,
        // independent of fan_in — an interface/type method-signature member
        // can have fan_in > 0 (real call sites resolve to it by name) and
        // still land on "leaf", indistinguishable from
        // classify_by_fan_shape's "leaf" by role string alone. Must be
        // excluded explicitly, or a widely-referenced interface method (e.g.
        // a native-binding surface like `NativeDatabase` in `types.ts`) gets
        // wrongly reconsidered here.
        if is_type_declaration_member(name, kind, file, type_def_names_by_file) {
            continue;
        }
        let Some(role) = role_by_id.get(id).copied() else {
            continue;
        };
        if !is_fan_shape_role(role) {
            continue;
        }
        if reachable.contains(id) {
            continue;
        }
        role_by_id.insert(*id, classify_dead_sub_role(name, kind, file));
    }
}

/// Direct barrels: files that directly re-export (one hop) into any of the
/// given target files. Used by `do_classify_incremental`'s scoped
/// alternative to the full `prod_reachable` recursive CTE — see
/// `is_barrel_prod_reachable`.
fn find_direct_reexport_barrels(
    tx: &rusqlite::Transaction,
    affected_ph: &str,
    all_affected: &[&str],
) -> rusqlite::Result<Vec<String>> {
    let sql = format!(
        "SELECT DISTINCT n1.file FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'reexports' AND n2.file IN ({affected_ph})"
    );
    let mut stmt = tx.prepare(&sql)?;
    for (i, f) in all_affected.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, *f)?;
    }
    let mut rows = stmt.raw_query();
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(row.get::<_, String>(0)?);
    }
    Ok(result)
}

/// True when `barrel_file` is production-reachable — i.e. a member of the
/// same `prod_reachable` set `do_classify_full`'s recursive CTE computes
/// globally (a non-test file directly imports it, or reaches it transitively
/// through a chain of `reexports` edges) — but answered for one specific
/// file instead of materializing the whole graph's closure.
///
/// `do_classify_incremental`'s old approach ran that same global CTE (seeded
/// from every non-test file's imports — 442 rows on this repo's own
/// codebase, closing over 703 total) on every incremental role
/// classification, regardless of how few files actually changed. Once
/// `find_neighbour_files` legitimately widens the affected set for a
/// barrel/re-export file (as it must, correctly, since #1849 — see that
/// function's doc comment), this pre-existing global recursion became a
/// major cost: ~18-21ms measured on this repo (#1855), because SQLite's
/// query planner stops being able to short-circuit the CTE once enough
/// affected-file candidates are in play.
///
/// Reachability is symmetric either direction: "is B reachable from any
/// production import" is answered equivalently by walking *backward* from B
/// through `reexports` edges (who re-exports into B, transitively) and
/// checking whether *any* of those backward-ancestors (including B itself)
/// is directly imported by production — bounded by B's own chain depth
/// (typically 1-3 hops) rather than the whole graph. Measured ~1.6ms total
/// (find barrels + per-barrel check + final symbol lookup) for the same
/// probe that cost ~18-21ms via the global closure.
fn is_barrel_prod_reachable(
    tx: &rusqlite::Transaction,
    barrel_file: &str,
) -> rusqlite::Result<bool> {
    // Fast path: barrel_file itself is directly imported by a non-test file
    // (the base case of the original `prod_reachable` definition).
    let direct_sql = format!(
        "SELECT EXISTS(
           SELECT 1 FROM edges e
             JOIN nodes src ON e.source_id = src.id
             JOIN nodes tgt ON e.target_id = tgt.id
           WHERE e.kind IN ('imports', 'dynamic-imports', 'imports-type')
             AND src.kind = 'file' AND tgt.kind = 'file' AND tgt.file = ?1
             {}
         )",
        test_file_filter_col("src.file")
    );
    // prepare_cached: `direct_sql` is the same text on every call (the
    // interpolated test-file filter is a fixed set of LIKE patterns keyed
    // only by column name), so the statement cache turns every call after
    // the first into a lookup instead of a fresh parse/plan — worthwhile
    // even at the small 1-3-barrels-per-build cardinality this runs at.
    let direct: bool = tx
        .prepare_cached(&direct_sql)?
        .query_row(rusqlite::params![barrel_file], |row| row.get(0))?;
    if direct {
        return Ok(true);
    }

    // Slow path: walk `reexports` edges backward from barrel_file (who
    // re-exports INTO barrel_file, transitively) looking for an ancestor
    // that's directly imported by production. `UNION` (not `UNION ALL`)
    // dedupes on `file`, which both bounds the search to barrel_file's own
    // chain and guarantees termination if the chain contains a cycle.
    let backward_sql = format!(
        "WITH RECURSIVE ancestors(file) AS (
           SELECT ?1
           UNION
           SELECT DISTINCT n1.file FROM edges e
             JOIN nodes n1 ON e.source_id = n1.id
             JOIN nodes n2 ON e.target_id = n2.id
             JOIN ancestors a ON n2.file = a.file
           WHERE e.kind = 'reexports'
         )
         SELECT EXISTS(
           SELECT 1 FROM ancestors a
             JOIN nodes af ON af.file = a.file AND af.kind = 'file'
             JOIN edges e2 ON e2.target_id = af.id
             JOIN nodes src2 ON e2.source_id = src2.id
           WHERE e2.kind IN ('imports', 'dynamic-imports', 'imports-type')
             AND src2.kind = 'file'
             {}
         )",
        test_file_filter_col("src2.file")
    );
    tx.prepare_cached(&backward_sql)?
        .query_row(rusqlite::params![barrel_file], |row| row.get(0))
}

/// Find neighbouring files connected by call/imports-type/reexports edges to the changed files.
///
/// Written as a UNION of two directional joins rather than a single
/// OR-based self-join (`JOIN nodes n1 ON (e.source_id = n1.id OR
/// e.target_id = n1.id)`, likewise for `n2`). The OR-join can't be served
/// by an index on either side of the OR, so SQLite falls back to scanning
/// every edge matching `e.kind IN (...)` and probing both endpoints per
/// row. Each directional half below is a plain equi-join on `source_id`/
/// `target_id`, letting the planner drive the scan from
/// `idx_edges_kind_source`/`idx_edges_kind_target` directly. `UNION` (not
/// `UNION ALL`) dedupes the combined result the same way the original
/// query's `DISTINCT` did. Same result set, measured ~2.4x faster
/// (#1855 — this query's cost, compounded by the symbol-level
/// `reexports` edges added in #1849, was a major contributor to the
/// "1-file rebuild" benchmark regression when the changed file is itself a
/// barrel/re-export hub).
fn find_neighbour_files(
    tx: &rusqlite::Transaction,
    changed_files: &[String],
) -> rusqlite::Result<Vec<String>> {
    let seed_ph: String = changed_files
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT n2.file AS file FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind IN ('calls', 'imports-type', 'reexports')
             AND n1.file IN ({seed_ph}) AND n2.file NOT IN ({seed_ph})
             AND n2.kind NOT IN ('file', 'directory')
         UNION
         SELECT n1.file AS file FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind IN ('calls', 'imports-type', 'reexports')
             AND n2.file IN ({seed_ph}) AND n1.file NOT IN ({seed_ph})
             AND n1.kind NOT IN ('file', 'directory')"
    );
    let mut stmt = tx.prepare(&sql)?;
    let mut idx = 1;
    // Bound 4 times: (n1 IN, n2 NOT IN) for the first half, then
    // (n2 IN, n1 NOT IN) for the second half.
    for _ in 0..4 {
        for f in changed_files {
            stmt.raw_bind_parameter(idx, f.as_str())?;
            idx += 1;
        }
    }
    let mut rows = stmt.raw_query();
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(row.get::<_, String>(0)?);
    }
    Ok(result)
}

/// `(id, name, file)` row for a `kind = 'property'` node.
type LeafRow = (i64, String, String);

/// `(id, name, kind, file, fan_in, fan_out)` row for a callable node.
type CallableRow = (i64, String, String, String, u32, u32);

/// Query leaf kind node rows and callable node rows for a set of files.
/// `parameter` is intentionally excluded from the leaf query (#1723) — see
/// `do_classify_full`'s leaf_rows comment for the rationale. Leaf rows carry
/// `name`/`file` (not just `id`) so callers can filter down to interface/type
/// property-signature members (#1809) via `filter_type_member_property_rows`.
fn query_nodes_for_files(
    tx: &rusqlite::Transaction,
    files: &[&str],
) -> rusqlite::Result<(Vec<LeafRow>, Vec<CallableRow>)> {
    let ph: String = files.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    let leaf_sql = format!(
        "SELECT id, name, file FROM nodes WHERE kind = 'property' AND file IN ({})",
        ph
    );
    let leaf_rows: Vec<(i64, String, String)> = {
        let mut stmt = tx.prepare(&leaf_sql)?;
        for (i, f) in files.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut rows = stmt.raw_query();
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ));
        }
        result
    };

    let rows_sql = format!(
        "SELECT n.id, n.name, n.kind, n.file,
            (SELECT COUNT(*) FROM edges WHERE kind IN ('calls', 'imports-type') AND target_id = n.id) AS fan_in,
            (SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND source_id = n.id) AS fan_out
         FROM nodes n
         WHERE n.kind NOT IN ('file', 'directory', 'parameter', 'property')
           AND n.file IN ({})",
        ph
    );
    let rows: Vec<(i64, String, String, String, u32, u32)> = {
        let mut stmt = tx.prepare(&rows_sql)?;
        for (i, f) in files.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut qrows = stmt.raw_query();
        let mut result = Vec::new();
        while let Some(row) = qrows.next()? {
            result.push((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, u32>(5)?,
            ));
        }
        result
    };

    Ok((leaf_rows, rows))
}

/// Mirrors TS `runIncrementalReachabilityDowngrade` (`src/features/structure.ts`)
/// — see its doc comment for the full safety rationale (issue #2255).
/// `do_classify_incremental` only classifies nodes in `all_affected` (changed
/// files plus their one-hop neighbours), but #2032's reachability downgrade is
/// a whole-graph property: a window node can be reachable only through a root
/// that lives entirely outside the window. This widens the node set used for
/// the downgrade's root/BFS computation only — `role_by_id` (already keyed by
/// window-node ids from `classify_rows`) is never widened, and
/// `apply_reachability_downgrade`'s own `role_by_id.get(id)` lookup silently
/// no-ops for every outside-window id, so only nodes already in the window can
/// ever be mutated by this pass.
///
/// Outside-window nodes use the plain `exported` column as a deliberately
/// OVER-INCLUSIVE approximation of "public surface" (real fan-in/fan-out are
/// still read per node, since those matter for `is_interface_dispatch_method_root`)
/// instead of `do_classify_full`'s expensive whole-graph `prod_reachable`
/// recursive CTE, and every outside file is unconditionally added to the
/// active-siblings set. This is safe in only one direction: more roots can
/// only make the reachable set bigger, which can only prevent a downgrade,
/// never cause a wrong one — a node that would have been correctly downgraded
/// with the exact computation might be missed here (matching the pre-#2032
/// status quo for such nodes until the next full build), but a live node can
/// never be wrongly marked dead by this approximation. Window nodes reuse the
/// EXACT `public_surface_ids`/`called_active_files` already computed by the
/// caller (the backward-scoped barrel check `do_classify_full` cannot
/// exploit, since it has no smaller scope to restrict to).
#[allow(clippy::too_many_arguments)]
fn run_incremental_reachability_downgrade(
    tx: &rusqlite::Transaction,
    all_affected: &[&str],
    affected_ph: &str,
    window_rows: &[(i64, String, String, String, u32, u32)],
    window_public_surface_ids: &std::collections::HashSet<i64>,
    window_called_active_files: &std::collections::HashSet<String>,
    entrypoint_ids: &std::collections::HashSet<i64>,
    role_by_id: &mut HashMap<i64, &'static str>,
) -> rusqlite::Result<()> {
    let outside_sql = format!(
        "SELECT n.id, n.name, n.kind, n.file, n.exported,
            COALESCE(fi.cnt, 0) AS fan_in,
            COALESCE(fo.cnt, 0) AS fan_out
         FROM nodes n
         LEFT JOIN (
           SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind IN ('calls', 'imports-type') GROUP BY target_id
         ) fi ON n.id = fi.target_id
         LEFT JOIN (
           SELECT source_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY source_id
         ) fo ON n.id = fo.source_id
         WHERE n.kind NOT IN ('file', 'directory', 'parameter', 'property')
           AND n.file NOT IN ({affected_ph})"
    );

    let mut outside_rows: Vec<(i64, String, String, String, u32, u32)> = Vec::new();
    let mut public_surface_ids = window_public_surface_ids.clone();
    let mut called_active_files_wide = window_called_active_files.clone();
    {
        let mut stmt = tx.prepare(&outside_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut rows_iter = stmt.raw_query();
        while let Some(row) = rows_iter.next()? {
            let id: i64 = row.get(0)?;
            let name: String = row.get(1)?;
            let kind: String = row.get(2)?;
            let file: String = row.get(3)?;
            let exported: i64 = row.get(4)?;
            let fan_in: i64 = row.get(5)?;
            let fan_out: i64 = row.get(6)?;
            if exported == 1 {
                public_surface_ids.insert(id);
            }
            called_active_files_wide.insert(file.clone());
            outside_rows.push((id, name, kind, file, fan_in as u32, fan_out as u32));
        }
    }

    let mut wider_rows: Vec<(i64, String, String, String, u32, u32)> =
        Vec::with_capacity(window_rows.len() + outside_rows.len());
    wider_rows.extend_from_slice(window_rows);
    wider_rows.extend(outside_rows);

    let type_def_names_by_file = compute_type_def_names_by_file(&wider_rows);

    let call_edges: Vec<(i64, i64)> = {
        let mut stmt = tx.prepare("SELECT source_id, target_id FROM edges WHERE kind = 'calls'")?;
        let mapped =
            stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    apply_reachability_downgrade(
        &wider_rows,
        &public_surface_ids,
        &called_active_files_wide,
        &type_def_names_by_file,
        entrypoint_ids,
        &call_edges,
        role_by_id,
    );
    Ok(())
}

// ── Incremental classification ───────────────────────────────────────

pub(crate) fn do_classify_incremental(
    conn: &Connection,
    changed_files: &[String],
) -> rusqlite::Result<RoleSummary> {
    let tx = conn.unchecked_transaction()?;
    let mut summary = RoleSummary::default();

    let neighbour_files = find_neighbour_files(&tx, changed_files)?;

    let mut all_affected: Vec<&str> = changed_files.iter().map(|s| s.as_str()).collect();
    for f in &neighbour_files {
        all_affected.push(f.as_str());
    }
    let affected_ph: String = all_affected
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");

    let (median_fan_in, median_fan_out) = compute_global_medians(&tx)?;

    let (leaf_rows, rows) = query_nodes_for_files(&tx, &all_affected)?;

    // Program-entrypoint IDs (#2392) — see the full-classification path for
    // the rationale. Scoped to the affected rows, like every other set on
    // this path.
    let entrypoint_ids: std::collections::HashSet<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM nodes WHERE entrypoint = 1")?;
        let mapped = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    if rows.is_empty() && leaf_rows.is_empty() {
        tx.commit()?;
        return Ok(summary);
    }

    let exported_sql = format!(
        "SELECT DISTINCT e.target_id
         FROM edges e
         JOIN nodes caller ON e.source_id = caller.id
         JOIN nodes target ON e.target_id = target.id
         WHERE e.kind IN ('calls', 'imports-type') AND caller.file != target.file
           AND target.file IN ({})",
        affected_ph
    );
    let mut exported_ids = query_id_set(&tx, &exported_sql, &all_affected)?;

    // Mark symbols as exported when their files are targets of reexport edges
    // from production-reachable barrels (traces through multi-level chains) (#837).
    //
    // do_classify_full's step 3b answers this by materializing the global
    // `prod_reachable` closure (every file reachable from any production
    // import, extended through reexports chains) because it has no smaller
    // scope to exploit — it's already processing every file. Here, only
    // `all_affected` (the changed files plus their one-hop neighbours) can
    // possibly be reexport targets we care about, so instead: find the
    // small set of barrels that directly reexport into `all_affected`
    // (typically 1-3 files), then answer "is this specific barrel
    // production-reachable" with a backward-scoped check instead of the
    // whole-graph forward closure (see `is_barrel_prod_reachable`).
    //
    // `method` is excluded (#1780) — see the full-classify path for rationale.
    //
    // `public_surface_ids` mirrors TS `runIncrementalReachabilityDowngrade`'s
    // narrower "genuinely public" set for #2032's reachability roots (issue
    // #2255) — explicit `export` + confirmed reexport chains only, excluding
    // `exported_ids`'s broader cross-file-caller/whole-file-reexport
    // components. See `do_classify_full`'s own `public_surface_ids` block for
    // why a named reexport must not mark every OTHER symbol in that file too.
    let mut public_surface_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    {
        let barrels = find_direct_reexport_barrels(&tx, &affected_ph, &all_affected)?;
        let mut reachable_barrels: Vec<&str> = Vec::with_capacity(barrels.len());
        for b in &barrels {
            if is_barrel_prod_reachable(&tx, b)? {
                reachable_barrels.push(b.as_str());
            }
        }

        if !reachable_barrels.is_empty() {
            let barrel_ph: String = reachable_barrels
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT DISTINCT n.id
                 FROM nodes n
                 JOIN nodes f ON f.file = n.file AND f.kind = 'file'
                 JOIN edges e ON e.target_id = f.id
                 JOIN nodes b ON e.source_id = b.id
                 WHERE e.kind = 'reexports' AND b.file IN ({barrel_ph})
                   AND n.kind NOT IN ('file', 'directory', 'parameter', 'property', 'method')
                   AND n.file IN ({affected_ph})"
            );
            let mut stmt = tx.prepare(&sql)?;
            let mut idx = 1;
            for b in &reachable_barrels {
                stmt.raw_bind_parameter(idx, *b)?;
                idx += 1;
            }
            for f in &all_affected {
                stmt.raw_bind_parameter(idx, *f)?;
                idx += 1;
            }
            let mut rrows = stmt.raw_query();
            while let Some(row) = rrows.next()? {
                exported_ids.insert(row.get::<_, i64>(0)?);
            }

            let named_sql = format!(
                "SELECT DISTINCT e.target_id AS id
                 FROM edges e
                 JOIN nodes n ON n.id = e.target_id
                 JOIN nodes b ON b.id = e.source_id
                 WHERE e.kind = 'reexports' AND n.kind != 'file' AND b.file IN ({barrel_ph})
                   AND n.file IN ({affected_ph})"
            );
            let mut stmt = tx.prepare(&named_sql)?;
            let mut idx = 1;
            for b in &reachable_barrels {
                stmt.raw_bind_parameter(idx, *b)?;
                idx += 1;
            }
            for f in &all_affected {
                stmt.raw_bind_parameter(idx, *f)?;
                idx += 1;
            }
            let mut nrows = stmt.raw_query();
            while let Some(row) = nrows.next()? {
                public_surface_ids.insert(row.get::<_, i64>(0)?);
            }

            let wildcard_sql = format!(
                "SELECT DISTINCT n.id AS id
                 FROM nodes n
                 JOIN nodes f ON f.file = n.file AND f.kind = 'file'
                 JOIN edges e ON e.target_id = f.id
                 JOIN nodes b ON e.source_id = b.id
                 WHERE e.kind = 'reexports-wildcard' AND b.file IN ({barrel_ph})
                   AND n.kind NOT IN ('file', 'directory', 'parameter', 'property', 'method')
                   AND n.file IN ({affected_ph})"
            );
            let mut stmt = tx.prepare(&wildcard_sql)?;
            let mut idx = 1;
            for b in &reachable_barrels {
                stmt.raw_bind_parameter(idx, *b)?;
                idx += 1;
            }
            for f in &all_affected {
                stmt.raw_bind_parameter(idx, *f)?;
                idx += 1;
            }
            let mut wrows = stmt.raw_query();
            while let Some(row) = wrows.next()? {
                public_surface_ids.insert(row.get::<_, i64>(0)?);
            }
        }
    }

    // 3c. Mark symbols with exported=1 as exported — scoped to affected files only.
    // Same rationale as the full-classify path: the extractor's exported flag is
    // authoritative for same-file-only type annotations that produce no edges (#1583).
    {
        let explicit_sql = format!(
            "SELECT id FROM nodes
             WHERE exported = 1
               AND kind NOT IN ('file', 'directory', 'parameter', 'property')
               AND file IN ({})",
            affected_ph
        );
        let mut stmt = tx.prepare(&explicit_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut erows = stmt.raw_query();
        while let Some(row) = erows.next()? {
            let id = row.get::<_, i64>(0)?;
            exported_ids.insert(id);
            public_surface_ids.insert(id);
        }
    }

    let prod_sql = format!(
        "SELECT e.target_id, COUNT(*) AS cnt
         FROM edges e
         JOIN nodes caller ON e.source_id = caller.id
         JOIN nodes target ON e.target_id = target.id
         WHERE e.kind IN ('calls', 'imports-type')
           AND target.file IN ({})
           {}
         GROUP BY e.target_id",
        affected_ph,
        test_file_filter()
    );
    let prod_fan_in = query_id_counts(&tx, &prod_sql, &all_affected)?;

    let (active_files, called_active_files) = compute_active_files(&rows);

    // Compute interface/type owner names per file (#1723) — see do_classify_full.
    let type_def_names_by_file = compute_type_def_names_by_file(&rows);

    let mut ids_by_role: HashMap<&str, Vec<i64>> = HashMap::new();

    // Filter property rows: interface/type members (#1809) -> leaf; genuine
    // class/struct/object fields get no role at all (#1810). See
    // do_classify_full/`filter_type_member_property_rows`.
    let type_member_leaf_ids = filter_type_member_property_rows(leaf_rows, &type_def_names_by_file);
    if !type_member_leaf_ids.is_empty() {
        summary.leaf += type_member_leaf_ids.len() as u32;
        ids_by_role
            .entry("leaf")
            .or_default()
            .extend(type_member_leaf_ids);
    }

    let mut role_by_id = classify_rows(
        &rows,
        &exported_ids,
        &entrypoint_ids,
        &prod_fan_in,
        &active_files,
        &called_active_files,
        &type_def_names_by_file,
        median_fan_in,
        median_fan_out,
    );

    // Transitive-reachability dead-code downgrade (#2032) — issue #2255
    // closes the incremental path's gap here. See
    // `run_incremental_reachability_downgrade`'s doc comment for why this
    // needs its own root/BFS computation distinct from `do_classify_full`'s.
    run_incremental_reachability_downgrade(
        &tx,
        &all_affected,
        &affected_ph,
        &rows,
        &public_surface_ids,
        &called_active_files,
        &entrypoint_ids,
        &mut role_by_id,
    )?;

    finalize_roles(&role_by_id, &mut ids_by_role, &mut summary);

    // Reset roles for affected files only, then update
    let reset_sql = format!(
        "UPDATE nodes SET role = NULL WHERE file IN ({}) AND kind NOT IN ('file', 'directory')",
        affected_ph
    );
    {
        let mut stmt = tx.prepare(&reset_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        stmt.raw_execute()?;
    }
    batch_update_roles(&tx, &ids_by_role)?;

    tx.commit()?;
    Ok(summary)
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::NativeDatabase;

    /// In-memory DB with the full migration chain applied — mirrors the
    /// pattern used by `db::connection::tests`.
    fn setup_db() -> NativeDatabase {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema().expect("init_schema should succeed");
        db
    }

    fn insert_node(conn: &Connection, id: i64, name: &str, kind: &str, file: &str, exported: i64) {
        conn.execute(
            "INSERT INTO nodes (id, name, kind, file, exported) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, name, kind, file, exported],
        )
        .expect("insert node should succeed");
    }

    fn insert_edge(conn: &Connection, source: i64, target: i64, kind: &str, dynamic: i64) {
        conn.execute(
            "INSERT INTO edges (source_id, target_id, kind, dynamic) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![source, target, kind, dynamic],
        )
        .expect("insert edge should succeed");
    }

    fn role_of(conn: &Connection, id: i64) -> Option<String> {
        conn.query_row("SELECT role FROM nodes WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .expect("query role should succeed")
    }

    // ── Transitive-reachability dead-code downgrade (#2032) ─────────────

    #[test]
    fn downgrades_function_whose_only_caller_is_itself_unreachable() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // computeHelper is called only by deadIntermediate, which is never
        // itself called by anything reachable from the confirmed-live root
        // (useThing). Direct fan-in alone would call computeHelper live.
        insert_node(conn, 1, "computeHelper", "function", "a.ts", 0);
        insert_node(conn, 2, "deadIntermediate", "function", "a.ts", 0);
        insert_node(conn, 3, "useThing", "function", "a.ts", 1);
        insert_edge(conn, 2, 1, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_eq!(role_of(conn, 1).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn does_not_downgrade_when_reachable_via_a_real_call_chain() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        insert_node(conn, 1, "helper", "function", "a.ts", 0);
        insert_node(conn, 2, "useThing", "function", "a.ts", 1);
        insert_edge(conn, 2, 1, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_ne!(role_of(conn, 1).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn downgrades_mutually_recursive_pair_with_no_confirmed_live_root() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        insert_node(conn, 1, "fn1", "function", "a.ts", 0);
        insert_node(conn, 2, "fn2", "function", "a.ts", 0);
        insert_edge(conn, 1, 2, "calls", 0);
        insert_edge(conn, 2, 1, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_eq!(role_of(conn, 1).as_deref(), Some("dead-unresolved"));
        assert_eq!(role_of(conn, 2).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn constant_sourced_value_ref_is_an_unconditional_root() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Mirrors the real dispatch-table shape (#1771): a top-level `const
        // HANDLERS = [{ resolve: resolveA }]` gets a value-ref `calls` edge
        // sourced from the constant declaration itself, not from a function.
        insert_node(conn, 1, "resolveA", "function", "dispatch.js", 0);
        insert_node(conn, 2, "HANDLERS", "constant", "dispatch.js", 0);
        insert_edge(conn, 2, 1, "calls", 1);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_ne!(role_of(conn, 1).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn file_sourced_value_ref_is_an_unconditional_root() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Mirrors Lua's builtin-reassignment pattern (#1776): `require =
        // tracedFn` has no LHS binding to attach to, so the value-ref edge is
        // sourced from the enclosing file/module scope. `file`-kind nodes are
        // entirely excluded from `rows`/classification, so this source id
        // never appears there — it must still act as an unconditional root.
        insert_node(conn, 1, "tracedFn", "function", "main.lua", 0);
        insert_node(conn, 2, "main.lua", "file", "main.lua", 0);
        insert_edge(conn, 2, 1, "calls", 1);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_ne!(role_of(conn, 1).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn does_not_downgrade_test_only_node_despite_unreachable_caller() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Same file for both: a cross-file caller would separately mark the
        // target "exported" (see `exported_ids`'s cross-file heuristic),
        // which is orthogonal to what this test checks — that a test-only
        // verdict is never revisited by the reachability downgrade.
        insert_node(conn, 1, "helperForTests", "function", "a.test.ts", 0);
        insert_node(conn, 2, "someTest", "function", "a.test.ts", 0);
        insert_edge(conn, 2, 1, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_eq!(role_of(conn, 1).as_deref(), Some("test-only"));
    }

    #[test]
    fn does_not_downgrade_interface_method_signature_member_despite_fan_in_and_unreachable_caller()
    {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Regression: is_type_declaration_member returns "leaf"
        // unconditionally, independent of fan_in — indistinguishable from
        // classify_by_fan_shape's "leaf" by role string alone unless the
        // downgrade pass explicitly re-checks it. A widely-referenced
        // interface method (e.g. a native-binding surface like
        // `NativeDatabase` in `types.ts`) has real fan_in > 0 from call sites
        // resolving to it by name, and must never be reconsidered here.
        insert_node(conn, 1, "NativeDatabase", "interface", "types.ts", 0);
        insert_node(
            conn,
            2,
            "NativeDatabase.countNodes",
            "method",
            "types.ts",
            0,
        );
        insert_node(conn, 3, "unreachableCaller", "function", "a.ts", 0);
        insert_edge(conn, 3, 2, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_eq!(role_of(conn, 2).as_deref(), Some("leaf"));
    }

    #[test]
    fn interface_dispatch_method_is_an_unconditional_root_for_what_it_calls() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Mirrors ast-analysis visitors' Visitor pattern: enterNode is
        // dispatched generically (`if (v.enterNode) v.enterNode(node)`) so it
        // can never be the TARGET of a `calls` edge — fan_in stays 0
        // forever, yet it's rescued to "leaf" by classify_node's Pattern-2
        // heuristic. Whatever it calls must be reachable through it.
        //
        // The declared `Visitor` interface (mirroring src/types.ts) is
        // required: is_interface_dispatch_method_root only promotes a method
        // to root when its bare name matches an actual interface/type member
        // somewhere in the codebase, not merely from the
        // fan_in/fan_out/has_active_siblings shape alone.
        insert_node(conn, 1, "enterNode", "method", "visitor.ts", 0);
        insert_node(conn, 2, "classifyHalstead", "function", "visitor.ts", 0);
        insert_node(conn, 3, "Visitor", "interface", "types.ts", 1);
        insert_node(conn, 4, "Visitor.enterNode", "method", "types.ts", 0);
        insert_edge(conn, 1, 2, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_ne!(role_of(conn, 2).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn does_not_treat_ordinary_unused_class_method_as_interface_dispatch_root() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Regression for a Greptile-flagged gap: without the interface-member
        // name-match requirement, ANY method with fan_in=0, fan_out>0, and an
        // active sibling in its file would be promoted to root — including a
        // genuinely-dead class method that happens to call a helper. No
        // interface/type declares a "deadMethod" member anywhere here.
        insert_node(conn, 1, "MyClass.deadMethod", "method", "a.ts", 0);
        insert_node(conn, 2, "helper", "function", "a.ts", 0);
        insert_edge(conn, 1, 2, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_eq!(role_of(conn, 2).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn does_not_treat_a_symbol_as_root_merely_because_of_an_unreachable_cross_file_caller() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Regression for a Greptile-flagged gap: exported_ids' cross-file-
        // caller heuristic also marks a symbol "exported" merely because SOME
        // caller in a different file calls it — regardless of whether that
        // caller is itself reachable. is_live_root must key off the narrower
        // public_surface_ids (explicit export / confirmed reexport chain),
        // not that broader signal, or a cross-file dead call chain would
        // evade #2032's fix entirely.
        insert_node(conn, 1, "unreachableCrossFileCaller", "function", "a.ts", 0);
        insert_node(conn, 2, "calleeInAnotherFile", "function", "b.ts", 0);
        insert_edge(conn, 1, 2, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_eq!(role_of(conn, 2).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn function_kind_logical_or_fallback_rescue_is_not_treated_as_a_root() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Unlike the method/interface-dispatch case above, a plain
        // `function` rescued via the (explicitly acknowledged as imprecise)
        // logical-or fallback heuristic must NOT be promoted to root —
        // otherwise almost any genuinely-dead intermediate function in an
        // active file would silently rescue whatever it calls, the exact
        // #2032 pattern this fix targets.
        insert_node(conn, 1, "deadIntermediate", "function", "a.ts", 0);
        insert_node(conn, 2, "computeHelper", "function", "a.ts", 0);
        insert_edge(conn, 1, 2, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_eq!(role_of(conn, 2).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn named_reexport_does_not_leak_public_surface_status_to_unreachable_siblings() {
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        // Regression for a Greptile-flagged gap: the whole-file `exported_ids`
        // query treats ANY 'reexports' edge as "every symbol in the target
        // file is exported" — but `export { publicThing } from './lib'` only
        // re-exports `publicThing`. public_surface_ids must not let
        // deadHelper (whose only caller, deadIntermediate, is itself
        // unreachable) evade the reachability check merely because it shares
        // a file with the one actually re-exported symbol.
        insert_node(conn, 1, "src/lib.ts", "file", "src/lib.ts", 0);
        insert_node(conn, 2, "src/index.ts", "file", "src/index.ts", 0);
        insert_node(conn, 3, "src/app.ts", "file", "src/app.ts", 0);
        insert_node(conn, 4, "publicThing", "function", "src/lib.ts", 0);
        insert_node(conn, 5, "deadIntermediate", "function", "src/lib.ts", 0);
        insert_node(conn, 6, "deadHelper", "function", "src/lib.ts", 0);

        // Generic file-to-file 'reexports' edge (emitted regardless of
        // named/wildcard) plus the symbol-level edge targeting publicThing
        // specifically — NOT a 'reexports-wildcard' marker.
        insert_edge(conn, 2, 1, "reexports", 0);
        insert_edge(conn, 2, 4, "reexports", 0);
        insert_edge(conn, 3, 2, "imports", 0);

        insert_edge(conn, 5, 6, "calls", 0);

        do_classify_full(conn).expect("do_classify_full should succeed");

        assert_ne!(role_of(conn, 4).as_deref(), Some("dead-unresolved"));
        assert_eq!(role_of(conn, 6).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn incremental_path_applies_the_reachability_downgrade() {
        // Issue #2255: the incremental path used to classify via direct
        // fan-in only, missing #2032's reachability downgrade entirely — a
        // node whose only caller is itself unreachable stayed at its
        // fan-shape verdict instead of being downgraded to dead. Same
        // fixture shape as `downgrades_function_whose_only_caller_is_itself_unreachable`
        // above, run through `do_classify_incremental` instead of
        // `do_classify_full`.
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        insert_node(conn, 1, "computeHelper", "function", "a.ts", 0);
        insert_node(conn, 2, "deadIntermediate", "function", "a.ts", 0);
        insert_edge(conn, 2, 1, "calls", 0);

        do_classify_incremental(conn, &["a.ts".to_string()])
            .expect("do_classify_incremental should succeed");

        assert_eq!(role_of(conn, 1).as_deref(), Some("dead-unresolved"));
    }

    #[test]
    fn incremental_reachability_downgrade_is_safe_across_the_affected_files_window_boundary() {
        // Issue #2255: `run_incremental_reachability_downgrade` widens the
        // node set for the downgrade's root/BFS computation beyond the
        // changed-files-plus-one-hop-neighbour window, using the plain
        // `exported` column as an over-inclusive root approximation for
        // nodes outside that window. This test proves that approximation
        // never wrongly downgrades a live window node: `publicEntry` (in
        // entry.ts, exported) calls `helperA` (in helpers.ts, the one-hop
        // neighbour and thus inside the window), which calls `helperB` (in
        // deep.ts, the only file actually passed as "changed"). entry.ts
        // itself stays OUTSIDE the window, yet must still count as a root.
        let db = setup_db();
        let conn = db.conn().expect("connection should still be open");

        insert_node(conn, 1, "publicEntry", "function", "entry.ts", 1);
        insert_node(conn, 2, "helperA", "function", "helpers.ts", 0);
        insert_node(conn, 3, "helperB", "function", "deep.ts", 0);
        insert_edge(conn, 1, 2, "calls", 0);
        insert_edge(conn, 2, 3, "calls", 0);

        do_classify_incremental(conn, &["deep.ts".to_string()])
            .expect("do_classify_incremental should succeed");

        assert_ne!(role_of(conn, 2).as_deref(), Some("dead-unresolved"));
        assert_ne!(role_of(conn, 3).as_deref(), Some("dead-unresolved"));
    }
}
