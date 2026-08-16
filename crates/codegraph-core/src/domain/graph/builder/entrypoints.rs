//! Python program-entrypoint attribution (#2392), stored as persisted
//! evidence plus a projection.
//!
//! ## Why evidence + projection, and not a directly-written flag
//!
//! The extractor flags a *call* (`Call.entrypoint`) rather than a
//! declaration, because the convention is a property of the call site: a
//! guard routinely invokes a `main` imported from another module, so nothing
//! about the declaration marks it. That makes the resulting
//! `nodes.entrypoint` flag cross-file derived state — and the two ends have
//! different lifecycles:
//!
//! - the evidence belongs to the *guard's* file, and dies when that file is
//!   reparsed or removed; but
//! - the flag sits on the *target's* node row, which is deleted and
//!   re-inserted (with a brand-new id) whenever the *target's* file is
//!   rebuilt — a file the guard's rebuild never touches, and vice versa.
//!
//! #2411 wrote the flag straight from the reparsed files' symbols, so any
//! build that reparsed only the target dropped it: `codegraph build
//! --incremental` after editing the callee, or the same edit under
//! `codegraph watch`. Nothing re-marked it, even though the guard's `calls`
//! edge was still in the graph, because the guard's file was not in that
//! build's symbol set.
//!
//! Persisting the evidence per file (`entrypoint_calls`) and re-projecting it
//! onto `nodes` at the end of every build makes both directions fall out for
//! free, whichever file changed:
//!
//! - guard edited or deleted → its evidence rows are purged with it, the
//!   projection finds nothing, the target clears;
//! - target rebuilt          → the guard's evidence is untouched, so the
//!   projection re-marks the target's new node row;
//! - guard added             → evidence appears, the projection marks.
//!
//! This is the same shape as `invoked_property_names` (#2087) and
//! `return_types` (#2138), which persist per-file evidence for exactly the
//! same reason: a build must be able to see facts contributed by files it did
//! not itself parse.
//!
//! Mirrors `src/domain/graph/builder/entrypoints.ts`.

use rusqlite::Connection;
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::domain::graph::resolve::resolve_pyproject_script_entrypoints;
use crate::types::FileSymbols;

/// Replace each reparsed Python file's persisted entrypoint-call evidence
/// with the calls the extractor just flagged.
///
/// Deletes first so a file that lost its guard (or whose guard moved to a
/// different callee) leaves nothing stale behind. The purge paths delete the
/// same rows when a file is removed outright, which is what makes deletion
/// work without a dedicated pre-purge step — see `purge_changed_files` in
/// `stages/detect_changes.rs`.
///
/// Non-Python files are skipped: `call.entrypoint` is only ever set by the
/// Python extractor (`mark_entrypoint_calls`), so their evidence set is empty
/// in this build and was empty in every earlier one.
///
/// Statements are hoisted out of the loop and the whole sweep runs in one
/// transaction, mirroring `persist_invoked_property_names` (import_edges.rs) —
/// a full build of a large Python tree would otherwise pay an autocommit per
/// file.
fn persist_entrypoint_calls(conn: &Connection, file_symbols: &BTreeMap<String, FileSymbols>) {
    let Ok(tx) = conn.unchecked_transaction() else {
        return;
    };
    {
        let Ok(mut delete) = tx.prepare("DELETE FROM entrypoint_calls WHERE file = ?1") else {
            return;
        };
        let Ok(mut insert) =
            tx.prepare("INSERT OR IGNORE INTO entrypoint_calls (file, name) VALUES (?1, ?2)")
        else {
            return;
        };

        for (rel_path, symbols) in file_symbols {
            if !rel_path.ends_with(".py") {
                continue;
            }
            let _ = delete.execute(rusqlite::params![rel_path]);
            let mut seen: HashSet<&str> = HashSet::new();
            for call in &symbols.calls {
                if !call.entrypoint.unwrap_or(false) || !seen.insert(call.name.as_str()) {
                    continue;
                }
                let _ = insert.execute(rusqlite::params![rel_path, call.name]);
            }
        }
    }
    let _ = tx.commit();
}

/// A node row the projection wants flagged.
struct DesiredRow {
    file: String,
    source_file: String,
}

/// Recompute `nodes.entrypoint` / `nodes.entrypoint_source_file` from the
/// persisted evidence and the committed `calls` edges, returning the files
/// whose flag set actually changed so the caller can seed incremental role
/// reclassification for them.
///
/// Must run after every edge-insert path for the build has completed — it
/// identifies targets from committed edges, not by re-resolving. An
/// entrypoint call is module-level by construction (see
/// `collect_entrypoint_call_lines`), so its `calls` edge is always sourced
/// from the file node, and matching that edge's target by the called name
/// identifies it.
///
/// The returned files matter because a target frequently lives in a file this
/// build never rebuilt, and `find_neighbour_files`' live-edge join cannot
/// discover it either — the connecting edge may have just been deleted.
/// Without seeding it explicitly, `nodes.entrypoint` updates correctly but
/// the cached `nodes.role` on the same row is left stale at `"entry"`.
///
/// Attribution is single-owner: one `entrypoint_source_file` per target. If
/// two files both call the same target as their entrypoint, the
/// lexicographically first wins deterministically (rather than "whichever
/// marked last", as in #2411) and the target stays correctly flagged while
/// either survives. Tracked as #2419.
fn project_entrypoint_attribution(conn: &Connection) -> HashSet<String> {
    let mut touched_files: HashSet<String> = HashSet::new();

    // Cheap exit for the overwhelmingly common case — no Python entrypoint
    // evidence anywhere and nothing currently flagged. Both probes are O(1):
    // `entrypoint_calls` is keyed on (file, name), and `nodes.entrypoint` has
    // a partial index covering exactly `entrypoint = 1`. Running the real
    // work unconditionally is what caused the 66% full-build regression
    // measured on a 954-file, effectively-Python-free tree during #2411's
    // review.
    let has_evidence = conn
        .query_row("SELECT 1 FROM entrypoint_calls LIMIT 1", [], |_| Ok(()))
        .is_ok();
    let has_flags = conn
        .query_row(
            "SELECT 1 FROM nodes WHERE entrypoint = 1 LIMIT 1",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !has_evidence && !has_flags {
        return touched_files;
    }

    // Suffix matching is an exact `.`-qualified comparison rather than a
    // `LIKE '%.' || name`: a Python identifier may contain `_`, which LIKE
    // treats as a single-character wildcard, so `main_run` would also match
    // `Owner.mainXrun`. A method entrypoint (`Runner().start()`) is declared
    // as `Owner.start`, hence the qualified form at all.
    //
    // First writer wins, and the ORDER BY makes "first" the lexicographically
    // smallest source file — stable across rebuilds, unlike iteration order
    // over a changed-file set.
    let mut desired: HashMap<i64, DesiredRow> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT e.target_id, tgt.file, ec.file
         FROM entrypoint_calls ec
         JOIN nodes src ON src.kind = 'file' AND src.file = ec.file
         JOIN edges e ON e.source_id = src.id AND e.kind = 'calls'
         JOIN nodes tgt ON tgt.id = e.target_id
         WHERE tgt.name = ec.name
            OR (length(tgt.name) > length(ec.name)
                AND substr(tgt.name, length(tgt.name) - length(ec.name)) = '.' || ec.name)
         ORDER BY ec.file",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for (id, file, source_file) in rows.flatten() {
                desired
                    .entry(id)
                    .or_insert(DesiredRow { file, source_file });
            }
        }
    }

    let mut current: Vec<(i64, String, Option<String>)> = Vec::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT id, file, entrypoint_source_file FROM nodes WHERE entrypoint = 1")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        }) {
            current.extend(rows.flatten());
        }
    }

    // One transaction for the whole write phase, mirroring the TS path's
    // `db.transaction` — a first full build of a Python tree can flip many
    // rows at once, and each autocommit is an fsync.
    let Ok(tx) = conn.unchecked_transaction() else {
        return touched_files;
    };
    {
        let Ok(mut clear) = tx.prepare(
            "UPDATE nodes SET entrypoint = 0, entrypoint_source_file = NULL WHERE id = ?1",
        ) else {
            return touched_files;
        };
        let Ok(mut mark) = tx
            .prepare("UPDATE nodes SET entrypoint = 1, entrypoint_source_file = ?1 WHERE id = ?2")
        else {
            return touched_files;
        };

        let mut current_ids: HashSet<i64> = HashSet::new();
        for (id, file, source_file) in &current {
            current_ids.insert(*id);
            match desired.get(id) {
                None => {
                    let _ = clear.execute(rusqlite::params![id]);
                    touched_files.insert(file.clone());
                }
                // Still an entrypoint, only the attributing file changed. The
                // role is `entry` either way, so this needs no role
                // reclassification.
                Some(want) if Some(&want.source_file) != source_file.as_ref() => {
                    let _ = mark.execute(rusqlite::params![want.source_file, id]);
                }
                Some(_) => {}
            }
        }
        for (id, want) in &desired {
            if current_ids.contains(id) {
                continue;
            }
            let _ = mark.execute(rusqlite::params![want.source_file, id]);
            touched_files.insert(want.file.clone());
        }
    }
    let _ = tx.commit();

    touched_files
}

/// Persist this build's entrypoint evidence and re-project it, returning the
/// files whose flag changed. The single entry point the pipeline calls.
pub fn apply_entrypoint_attribution(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
) -> HashSet<String> {
    persist_entrypoint_calls(conn, file_symbols);
    project_entrypoint_attribution(conn)
}

/// Flag pyproject.toml-declared console/GUI/Poetry script entrypoints
/// (#2408) directly on their target nodes. Mirrors TS
/// `applyPyprojectScriptAttribution` exactly, including the precedence over
/// guard-call attribution and the "clear stale, scoped to rows this function
/// itself set" safety property — see the TS doc comment for the full
/// rationale. `pyproject.toml` is re-parsed fresh on every call (no evidence
/// table needed): it is a single, cheap-to-reread file, so there is no
/// cross-file lifecycle problem to solve the way there is for guard calls.
pub fn apply_pyproject_script_attribution(
    conn: &Connection,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> HashSet<String> {
    let desired = resolve_pyproject_script_entrypoints(root_dir, known_files);

    let mut current: HashMap<i64, String> = HashMap::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT id, file FROM nodes WHERE entrypoint_source_file = 'pyproject.toml'")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        }) {
            current.extend(rows.flatten());
        }
    }

    if desired.is_empty() && current.is_empty() {
        return HashSet::new();
    }

    let mut touched_files = HashSet::new();
    let mut desired_ids: HashSet<i64> = HashSet::new();

    let Ok(tx) = conn.unchecked_transaction() else {
        return touched_files;
    };
    {
        let Ok(mut find_candidates) = tx.prepare(
            "SELECT id, name FROM nodes WHERE file = ?1 AND kind IN ('function', 'method')",
        ) else {
            return touched_files;
        };
        let Ok(mut mark_stmt) = tx.prepare(
            "UPDATE nodes SET entrypoint = 1, entrypoint_source_file = 'pyproject.toml' WHERE id = ?1",
        ) else {
            return touched_files;
        };

        for entry in &desired {
            let mut candidates: Vec<(i64, String)> = Vec::new();
            if let Ok(rows) = find_candidates.query_map(rusqlite::params![entry.file], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            }) {
                candidates.extend(rows.flatten());
            }
            let target = candidates
                .iter()
                .find(|(_, name)| *name == entry.attr)
                .or_else(|| {
                    candidates.iter().find(|(_, name)| {
                        name.len() > entry.attr.len() && name.ends_with(&format!(".{}", entry.attr))
                    })
                });
            let Some((id, _)) = target else { continue };
            desired_ids.insert(*id);
            let _ = mark_stmt.execute(rusqlite::params![id]);
            if !current.contains_key(id) {
                touched_files.insert(entry.file.clone());
            }
        }
    }
    {
        let Ok(mut clear_stmt) = tx.prepare(
            "UPDATE nodes SET entrypoint = 0, entrypoint_source_file = NULL WHERE id = ?1",
        ) else {
            return touched_files;
        };
        for (id, file) in &current {
            if !desired_ids.contains(id) {
                let _ = clear_stmt.execute(rusqlite::params![id]);
                touched_files.insert(file.clone());
            }
        }
    }
    let _ = tx.commit();

    touched_files
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal schema: just what the projection joins over.
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT, kind TEXT, file TEXT, line INTEGER,
                entrypoint INTEGER DEFAULT 0,
                entrypoint_source_file TEXT
             );
             CREATE TABLE edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER, target_id INTEGER, kind TEXT
             );
             CREATE TABLE entrypoint_calls (
                file TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (file, name)
             );",
        )
        .unwrap();
        conn
    }

    /// `run.py` (file node) --calls--> `lib.py:target_name`, with `run.py`
    /// recorded as making an entrypoint call named `call_name`.
    fn seed(conn: &Connection, target_name: &str, call_name: Option<&str>) -> i64 {
        conn.execute(
            "INSERT INTO nodes (name, kind, file, line) VALUES ('run.py', 'file', 'run.py', 0)",
            [],
        )
        .unwrap();
        let src_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO nodes (name, kind, file, line) VALUES (?1, 'function', 'lib.py', 1)",
            rusqlite::params![target_name],
        )
        .unwrap();
        let tgt_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO edges (source_id, target_id, kind) VALUES (?1, ?2, 'calls')",
            rusqlite::params![src_id, tgt_id],
        )
        .unwrap();
        if let Some(name) = call_name {
            conn.execute(
                "INSERT INTO entrypoint_calls (file, name) VALUES ('run.py', ?1)",
                rusqlite::params![name],
            )
            .unwrap();
        }
        tgt_id
    }

    fn flag_of(conn: &Connection, id: i64) -> (i64, Option<String>) {
        conn.query_row(
            "SELECT entrypoint, entrypoint_source_file FROM nodes WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn marks_a_cross_file_target_from_persisted_evidence() {
        let conn = test_conn();
        let tgt = seed(&conn, "shared_main", Some("shared_main"));

        let touched = project_entrypoint_attribution(&conn);

        assert_eq!(flag_of(&conn, tgt), (1, Some("run.py".to_string())));
        assert!(touched.contains("lib.py"));
    }

    #[test]
    fn marks_a_method_target_by_dot_qualified_suffix() {
        // `Runner().start()` is declared as `Owner.start`.
        let conn = test_conn();
        let tgt = seed(&conn, "Owner.start", Some("start"));

        project_entrypoint_attribution(&conn);

        assert_eq!(flag_of(&conn, tgt).0, 1);
    }

    #[test]
    fn does_not_treat_an_underscore_as_a_wildcard() {
        // The `LIKE '%.' || name` form this replaced would match here,
        // because LIKE reads `_` as "any single character".
        let conn = test_conn();
        let tgt = seed(&conn, "Owner.mainXrun", Some("main_run"));

        project_entrypoint_attribution(&conn);

        assert_eq!(flag_of(&conn, tgt).0, 0);
    }

    #[test]
    fn clears_a_target_whose_evidence_is_gone() {
        // What a deleted or edited-away guard leaves behind: the flag is set,
        // but purging the guard file took its evidence with it.
        let conn = test_conn();
        let tgt = seed(&conn, "shared_main", None);
        conn.execute(
            "UPDATE nodes SET entrypoint = 1, entrypoint_source_file = 'run.py' WHERE id = ?1",
            rusqlite::params![tgt],
        )
        .unwrap();

        let touched = project_entrypoint_attribution(&conn);

        assert_eq!(flag_of(&conn, tgt), (0, None));
        assert!(touched.contains("lib.py"));
    }

    #[test]
    fn reports_no_touched_files_when_the_flag_is_unchanged() {
        // A re-projection that changes nothing must not drag the target's file
        // into role reclassification on every build.
        let conn = test_conn();
        seed(&conn, "shared_main", Some("shared_main"));
        project_entrypoint_attribution(&conn);

        assert!(project_entrypoint_attribution(&conn).is_empty());
    }

    #[test]
    fn short_circuits_with_no_evidence_and_no_flags() {
        let conn = test_conn();
        seed(&conn, "shared_main", None);

        assert!(project_entrypoint_attribution(&conn).is_empty());
    }

    #[test]
    fn attribution_is_deterministic_when_two_guards_share_a_target() {
        // Lexicographically first source file wins, regardless of insert order.
        let conn = test_conn();
        let tgt = seed(&conn, "shared_main", Some("shared_main"));
        conn.execute(
            "INSERT INTO nodes (name, kind, file, line) VALUES ('a_run.py', 'file', 'a_run.py', 0)",
            [],
        )
        .unwrap();
        let other_src = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO edges (source_id, target_id, kind) VALUES (?1, ?2, 'calls')",
            rusqlite::params![other_src, tgt],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entrypoint_calls (file, name) VALUES ('a_run.py', 'shared_main')",
            [],
        )
        .unwrap();

        project_entrypoint_attribution(&conn);

        assert_eq!(flag_of(&conn, tgt), (1, Some("a_run.py".to_string())));
    }

    /// Schema plus fixtures for `apply_pyproject_script_attribution`: a
    /// `src/pipeline/cli.py` file with `main` and `helper` functions, matching
    /// the shape a `[project.scripts]` entry actually resolves against — the
    /// resolver returns paths relative to `root_dir`, so this must match
    /// `write_pyproject`'s `src/pipeline/cli.py` layout exactly.
    fn script_test_conn() -> Connection {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO nodes (name, kind, file, line) VALUES ('main', 'function', 'src/pipeline/cli.py', 5)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes (name, kind, file, line) VALUES ('helper', 'function', 'src/pipeline/cli.py', 1)",
            [],
        )
        .unwrap();
        conn
    }

    fn write_pyproject(dir: &std::path::Path, body: &str) {
        std::fs::create_dir_all(dir.join("src/pipeline")).unwrap();
        std::fs::write(dir.join("src/pipeline/__init__.py"), "").unwrap();
        std::fs::write(
            dir.join("src/pipeline/cli.py"),
            "def helper():\n    pass\n\n\ndef main():\n    pass\n",
        )
        .unwrap();
        std::fs::write(dir.join("pyproject.toml"), body).unwrap();
    }

    fn node_id_by_name(conn: &Connection, name: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM nodes WHERE name = ?1",
            rusqlite::params![name],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn marks_a_console_script_target_as_an_entrypoint() {
        let tmp = std::env::temp_dir().join(format!(
            "codegraph-pyproject-script-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        write_pyproject(
            &tmp,
            "[project.scripts]\ningest = \"pipeline.cli:main\"\n\n[tool.setuptools.package-dir]\n\"\" = \"src\"\n",
        );

        let conn = script_test_conn();
        let touched = apply_pyproject_script_attribution(&conn, tmp.to_str().unwrap(), None);

        let main_id = node_id_by_name(&conn, "main");
        assert_eq!(
            flag_of(&conn, main_id),
            (1, Some("pyproject.toml".to_string()))
        );
        assert_eq!(flag_of(&conn, node_id_by_name(&conn, "helper")).0, 0);
        assert!(touched.contains("src/pipeline/cli.py"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clears_a_stale_script_attribution_when_the_script_is_removed() {
        let tmp = std::env::temp_dir().join(format!(
            "codegraph-pyproject-script-test-clear-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        write_pyproject(
            &tmp,
            "[project.scripts]\ningest = \"pipeline.cli:main\"\n\n[tool.setuptools.package-dir]\n\"\" = \"src\"\n",
        );

        let conn = script_test_conn();
        apply_pyproject_script_attribution(&conn, tmp.to_str().unwrap(), None);
        let main_id = node_id_by_name(&conn, "main");
        assert_eq!(flag_of(&conn, main_id).0, 1);

        // The script entry is removed from pyproject.toml on a later build.
        // Every real rebuild clears the pyproject-scripts cache before calling
        // this function (see incremental.ts's clearPythonImportRootsCache()
        // call ahead of refreshEntrypointAttribution on its common path), so
        // this test must too — without it, the cache keyed on `tmp` would
        // still hold the first write's parsed scripts.
        crate::domain::graph::resolve::clear_python_import_roots_cache();
        write_pyproject(&tmp, "[project]\nname = \"pipeline\"\n");
        let touched = apply_pyproject_script_attribution(&conn, tmp.to_str().unwrap(), None);

        assert_eq!(flag_of(&conn, main_id), (0, None));
        assert!(touched.contains("src/pipeline/cli.py"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn does_not_clobber_a_guard_attributed_entrypoint() {
        // A target already flagged by guard-call evidence (project_entrypoint_attribution)
        // must survive a pyproject.toml pass that declares no scripts at all —
        // the "clear stale" step is scoped to entrypoint_source_file = 'pyproject.toml'.
        let tmp = std::env::temp_dir().join(format!(
            "codegraph-pyproject-script-test-noclobber-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        write_pyproject(&tmp, "[project]\nname = \"pipeline\"\n");

        let conn = script_test_conn();
        let main_id = node_id_by_name(&conn, "main");
        conn.execute(
            "UPDATE nodes SET entrypoint = 1, entrypoint_source_file = 'guard.py' WHERE id = ?1",
            rusqlite::params![main_id],
        )
        .unwrap();

        let touched = apply_pyproject_script_attribution(&conn, tmp.to_str().unwrap(), None);

        assert_eq!(flag_of(&conn, main_id), (1, Some("guard.py".to_string())));
        assert!(touched.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn takes_precedence_over_an_existing_guard_attribution_on_the_same_target() {
        let tmp = std::env::temp_dir().join(format!(
            "codegraph-pyproject-script-test-precedence-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        write_pyproject(
            &tmp,
            "[project.scripts]\ningest = \"pipeline.cli:main\"\n\n[tool.setuptools.package-dir]\n\"\" = \"src\"\n",
        );

        let conn = script_test_conn();
        let main_id = node_id_by_name(&conn, "main");
        conn.execute(
            "UPDATE nodes SET entrypoint = 1, entrypoint_source_file = 'guard.py' WHERE id = ?1",
            rusqlite::params![main_id],
        )
        .unwrap();

        apply_pyproject_script_attribution(&conn, tmp.to_str().unwrap(), None);

        assert_eq!(
            flag_of(&conn, main_id),
            (1, Some("pyproject.toml".to_string()))
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn returns_empty_and_touches_nothing_when_no_scripts_and_no_prior_attribution() {
        let tmp = std::env::temp_dir().join(format!(
            "codegraph-pyproject-script-test-empty-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        write_pyproject(&tmp, "[project]\nname = \"pipeline\"\n");

        let conn = script_test_conn();
        let touched = apply_pyproject_script_attribution(&conn, tmp.to_str().unwrap(), None);

        assert!(touched.is_empty());
        assert_eq!(flag_of(&conn, node_id_by_name(&conn, "main")).0, 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
