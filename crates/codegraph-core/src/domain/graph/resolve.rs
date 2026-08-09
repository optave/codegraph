use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rayon::prelude::*;

use crate::domain::parser::LanguageKind;
use crate::types::{ImportResolutionInput, PathAliases, ResolvedImport, WorkspacePackage};

/// Check file existence using known_files set when available, falling back to FS.
///
/// When `known_files` is provided, candidates may be absolute paths while
/// the set contains relative paths (normalized with forward slashes) — or,
/// via `normalize_known_files`, absolute paths that are themselves already
/// forward-slash normalized. `path` is normalized here (not just at the
/// handful of Rust crate-path call sites that already did their own
/// `.replace('\\', "/")`) so every caller — including the alias/exports/
/// js-to-ts-remap resolvers, which pass their candidate through unmodified —
/// gets a forward-slash-consistent comparison on Windows. We try both the
/// normalized path and the root-relative version so extension probing works
/// regardless of the path format (#804, #2216).
fn file_exists(path: &str, known: Option<&HashSet<String>>, root_dir: &str) -> bool {
    match known {
        Some(set) => {
            let normalized = path.replace('\\', "/");
            if set.contains(&normalized) {
                return true;
            }
            // Candidates are often absolute; known_files are relative — try stripping root
            let root_normalized = root_dir.replace('\\', "/");
            let root_prefix = if root_normalized.ends_with('/') {
                root_normalized
            } else {
                format!("{}/", root_normalized)
            };
            if let Some(rel) = normalized.strip_prefix(&root_prefix) {
                return set.contains(rel);
            }
            false
        }
        None => Path::new(path).exists(),
    }
}

/// Resolve `.` and `..` components in a path without touching the filesystem.
/// Unlike `PathBuf::components().collect()`, this properly collapses `..` by
/// popping the previous component from the result.
///
/// NOTE: if the path begins with more `..` components than there are preceding
/// components to pop (e.g. a purely relative `../../foo`), the excess `..`
/// components are silently dropped.  This function is therefore only correct
/// when called on paths that have already been joined to a base directory with
/// sufficient depth.
fn clean_path(p: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            _ => result.push(c),
        }
    }
    result
}

/// Normalize a path to use forward slashes and clean `.` / `..` segments
/// (cross-platform consistency).
fn normalize_path(p: &str) -> String {
    let cleaned = clean_path(Path::new(p));
    cleaned.display().to_string().replace('\\', "/")
}

/// Try resolving via path aliases (tsconfig/jsconfig paths).
fn resolve_via_alias(
    import_source: &str,
    aliases: &PathAliases,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    // baseUrl resolution
    if let Some(base_url) = &aliases.base_url {
        if !import_source.starts_with('.') && !import_source.starts_with('/') {
            let candidate = PathBuf::from(base_url).join(import_source);
            for ext in &[
                "",
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                "/index.ts",
                "/index.tsx",
                "/index.js",
            ] {
                let full = format!("{}{}", candidate.display(), ext);
                if file_exists(&full, known_files, root_dir) {
                    return Some(full);
                }
            }
        }
    }

    // Path pattern resolution
    for mapping in &aliases.paths {
        let prefix = mapping.pattern.trim_end_matches('*');
        if !import_source.starts_with(prefix) {
            continue;
        }
        let rest = &import_source[prefix.len()..];
        for target in &mapping.targets {
            let resolved = target.replace('*', rest);
            for ext in &[
                "",
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                "/index.ts",
                "/index.tsx",
                "/index.js",
            ] {
                let full = format!("{}{}", resolved, ext);
                if file_exists(&full, known_files, root_dir) {
                    return Some(full);
                }
            }
        }
    }

    None
}

// ── Monorepo workspace resolution ───────────────────────────────────
//
// Mirrors `resolveViaWorkspace()`/`setWorkspaces()`/`isWorkspaceResolved()`
// in `src/domain/graph/resolve.ts`. The JS side owns workspace *detection*
// (parsing pnpm-workspace.yaml / package.json / lerna.json — no equivalent
// exists in Rust, matching the established split documented in
// `infrastructure/config.rs`); this module only consumes the already-detected
// `{ packageName -> { dir, entry } }` map, passed in from JS on every call.

/// A single workspace package's resolution data. Mirrors the `WorkspaceEntry`
/// interface in `src/infrastructure/config.ts`. Plain (non-napi) struct built
/// from the napi-facing [`WorkspacePackage`] list.
#[derive(Debug, Clone)]
pub struct WorkspaceEntry {
    pub dir: String,
    pub entry: Option<String>,
}

/// Convert the napi-facing workspace package list into a lookup map, keyed
/// by package name.
pub fn workspaces_from_packages(packages: &[WorkspacePackage]) -> HashMap<String, WorkspaceEntry> {
    packages
        .iter()
        .map(|p| {
            (
                p.package_name.clone(),
                WorkspaceEntry {
                    dir: p.dir.clone(),
                    entry: p.entry.clone(),
                },
            )
        })
        .collect()
}

/// Parse a bare specifier into `(packageName, subpath)`. Mirrors
/// `parseBareSpecifier()` in resolve.ts.
/// Scoped:  `"@scope/pkg/sub"` → `("@scope/pkg", "./sub")`
/// Plain:   `"pkg/sub"`        → `("pkg", "./sub")`
/// No sub:  `"pkg"`            → `("pkg", ".")`
fn parse_bare_specifier(specifier: &str) -> Option<(String, String)> {
    let (package_name, rest) = if specifier.starts_with('@') {
        let parts: Vec<&str> = specifier.splitn(3, '/').collect();
        if parts.len() < 2 {
            return None;
        }
        let package_name = format!("{}/{}", parts[0], parts[1]);
        let rest = parts.get(2).copied().unwrap_or("").to_string();
        (package_name, rest)
    } else {
        match specifier.find('/') {
            None => (specifier.to_string(), String::new()),
            Some(idx) => (
                specifier[..idx].to_string(),
                specifier[idx + 1..].to_string(),
            ),
        }
    };
    let subpath = if rest.is_empty() {
        ".".to_string()
    } else {
        format!("./{rest}")
    };
    Some((package_name, subpath))
}

// ── package.json `exports` field resolution (issue #2060) ──────────────
//
// Mirrors `resolveViaExports()` in resolve.ts. Deliberately reads
// package.json directly from the filesystem (`std::fs`, not the
// `known_files`-aware `file_exists()` helper): `exports` resolution reaches
// into `node_modules`, which is never part of the project's tracked source
// file list, so there is nothing for `known_files` to short-circuit against.

/// Cache: packageDir → parsed `exports` field (`None` if absent/unreadable).
fn exports_cache() -> &'static Mutex<HashMap<String, Option<serde_json::Value>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<serde_json::Value>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clear the exports cache. Mirrors `clearExportsCache()`; call once per
/// build alongside `reset_workspace_resolved_paths()`.
pub fn clear_exports_cache() {
    let mut cache = exports_cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.clear();
}

/// Find the package directory for a given package name, starting from
/// `root_dir` and walking up through `node_modules` directories.
fn find_package_dir(package_name: &str, root_dir: &str) -> Option<String> {
    let mut dir = root_dir.to_string();
    loop {
        let candidate = format!(
            "{}/node_modules/{}",
            dir.trim_end_matches('/'),
            package_name
        );
        if Path::new(&candidate).join("package.json").exists() {
            return Some(candidate);
        }
        match Path::new(&dir).parent() {
            Some(parent) if parent != Path::new(&dir) => {
                dir = parent.to_string_lossy().to_string();
            }
            _ => return None,
        }
    }
}

/// Read and cache the `exports` field from a package's package.json.
fn get_package_exports(package_dir: &str) -> Option<serde_json::Value> {
    {
        let cache = exports_cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(cached) = cache.get(package_dir) {
            return cached.clone();
        }
    }
    let result = std::fs::read_to_string(format!("{package_dir}/package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|pkg| pkg.get("exports").cloned());
    exports_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(package_dir.to_string(), result.clone());
    result
}

/// Condition names to try, in priority order. Mirrors `CONDITION_ORDER`.
const EXPORTS_CONDITION_ORDER: &[&str] = &["import", "require", "default"];

/// Resolve a conditional exports value (string, array fallback, or
/// conditions object) to a single string target.
fn resolve_export_condition(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(items) => items.iter().find_map(resolve_export_condition),
        serde_json::Value::Object(map) => {
            for cond in EXPORTS_CONDITION_ORDER {
                if let Some(v) = map.get(*cond) {
                    return resolve_export_condition(v);
                }
            }
            None
        }
        _ => None,
    }
}

/// Match a subpath against an exports map key that uses a wildcard pattern.
/// Key `"./lib/*"` matches subpath `"./lib/foo/bar"` → substitution `"foo/bar"`.
fn match_subpath_pattern(pattern: &str, subpath: &str) -> Option<String> {
    let star_idx = pattern.find('*')?;
    let prefix = &pattern[..star_idx];
    let suffix = &pattern[star_idx + 1..];
    if !subpath.starts_with(prefix) {
        return None;
    }
    if !suffix.is_empty() && !subpath.ends_with(suffix) {
        return None;
    }
    let end = if suffix.is_empty() {
        subpath.len()
    } else {
        subpath.len() - suffix.len()
    };
    if suffix.is_empty() && subpath.len() <= prefix.len() {
        return None;
    }
    Some(subpath[prefix.len()..end].to_string())
}

/// Try resolving a condition target (always package-relative, e.g. `"./index.js"`)
/// to an existing absolute file path.
fn try_resolve_export_target(target: Option<&str>, package_dir: &str) -> Option<String> {
    let target = target?;
    let resolved = normalize_path(&format!("{package_dir}/{target}"));
    Path::new(&resolved).exists().then_some(resolved)
}

/// Resolve subpath against a subpath map (object with `.`-prefixed keys):
/// exact match first, then wildcard pattern keys.
fn resolve_subpath_map(
    exports: &serde_json::Map<String, serde_json::Value>,
    subpath: &str,
    package_dir: &str,
) -> Option<String> {
    if let Some(value) = exports.get(subpath) {
        return try_resolve_export_target(resolve_export_condition(value).as_deref(), package_dir);
    }
    for (pattern, value) in exports.iter() {
        if !pattern.contains('*') {
            continue;
        }
        let Some(matched) = match_subpath_pattern(pattern, subpath) else {
            continue;
        };
        let Some(raw_target) = resolve_export_condition(value) else {
            continue;
        };
        if let Some(resolved) =
            try_resolve_export_target(Some(&raw_target.replace('*', &matched)), package_dir)
        {
            return Some(resolved);
        }
    }
    None
}

/// Resolve a bare specifier through the package.json `exports` field.
/// Mirrors `resolveViaExports()` in resolve.ts.
fn resolve_via_exports(specifier: &str, root_dir: &str) -> Option<String> {
    let (package_name, subpath) = parse_bare_specifier(specifier)?;
    let package_dir = find_package_dir(&package_name, root_dir)?;
    let exports = get_package_exports(&package_dir)?;

    match &exports {
        // Simple string exports: "exports": "./index.js"
        serde_json::Value::String(target) => {
            if subpath != "." {
                return None;
            }
            try_resolve_export_target(Some(target), &package_dir)
        }
        // Array form at top level (condition fallback list)
        serde_json::Value::Array(_) => {
            if subpath != "." {
                return None;
            }
            try_resolve_export_target(resolve_export_condition(&exports).as_deref(), &package_dir)
        }
        serde_json::Value::Object(map) => {
            let is_subpath_map = map.keys().any(|k| k.starts_with('.'));
            if !is_subpath_map {
                if subpath != "." {
                    return None;
                }
                return try_resolve_export_target(
                    resolve_export_condition(&exports).as_deref(),
                    &package_dir,
                );
            }
            resolve_subpath_map(map, &subpath, &package_dir)
        }
        _ => None,
    }
}

/// Extensions probed when resolving a workspace subpath import against the
/// filesystem. Mirrors the extension list in `resolveViaWorkspace()`.
const WORKSPACE_PROBE_EXTENSIONS: &[&str] = &[
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    "/index.ts",
    "/index.tsx",
    "/index.js",
];

/// Resolve a bare specifier through monorepo workspace packages.
///
/// For `"@myorg/utils"` → finds the workspace package dir → tries the
/// `exports` field, falling back to its entry point. For
/// `"@myorg/utils/sub"` → finds the package dir → tries `exports`, then
/// filesystem probes `dir/sub` then `dir/src/sub`. Mirrors
/// `resolveViaWorkspace()` in resolve.ts (issue #2060).
fn resolve_via_workspace(
    specifier: &str,
    workspaces: &HashMap<String, WorkspaceEntry>,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    if workspaces.is_empty() {
        return None;
    }
    let (package_name, subpath) = parse_bare_specifier(specifier)?;
    let info = workspaces.get(&package_name)?;

    if subpath == "." {
        // Try the exports field first (reuses existing exports logic),
        // matching resolveViaWorkspace()'s root-import branch.
        if let Some(exports_result) = resolve_via_exports(specifier, root_dir) {
            return Some(exports_result);
        }
        return info.entry.clone();
    }

    // Subpath import — try exports, then filesystem probe.
    if let Some(exports_result) = resolve_via_exports(specifier, root_dir) {
        return Some(exports_result);
    }

    let sub_rel = &subpath[2..]; // strip leading "./"

    let base = format!("{}/{}", info.dir.trim_end_matches('/'), sub_rel);
    for ext in WORKSPACE_PROBE_EXTENSIONS {
        let candidate = format!("{base}{ext}");
        if file_exists(&candidate, known_files, root_dir) {
            return Some(candidate);
        }
    }

    let src_base = format!("{}/src/{}", info.dir.trim_end_matches('/'), sub_rel);
    for ext in WORKSPACE_PROBE_EXTENSIONS {
        let candidate = format!("{src_base}{ext}");
        if file_exists(&candidate, known_files, root_dir) {
            return Some(candidate);
        }
    }

    None
}

/// Process-lifetime cache of root-relative paths resolved via a workspace
/// import. Mirrors `_workspaceResolvedPaths` in resolve.ts — read by
/// `compute_confidence()` to grant workspace-resolved imports a 0.95
/// confidence floor regardless of directory distance.
///
/// Populated as a side effect of `resolve_import_path`/`resolve_imports_batch`
/// and reset once per build by the callers that own "start of build" timing:
/// `resolve_imports` (the per-call FFI entry point, called exactly once per
/// JS-driven build by `resolveImportsBatch()`) and `pipeline_setup` (the Rust
/// orchestrator's once-per-build setup stage). Later same-build calls (e.g.
/// the barrel re-parse loop, which calls `resolve_imports_batch` repeatedly)
/// only add to the set, matching `setWorkspaces()`'s clear-once-then-accumulate
/// contract on the JS side.
fn workspace_resolved_cache() -> &'static Mutex<HashSet<String>> {
    static CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Clear the workspace-resolved-paths cache. Call once per build, before any
/// resolution runs, mirroring `_workspaceResolvedPaths.clear()` inside
/// `setWorkspaces()`.
///
/// Recovers the inner data via `unwrap_or_else` instead of silently no-op'ing
/// on a poisoned lock (`if let Ok(...)`): if a thread ever panics while
/// holding this mutex, a silent skip here would leave workspace-resolved
/// paths from the panicking build in the cache forever — every subsequent
/// build's `.lock()` call keeps returning `Err`, so `compute_confidence`
/// would keep awarding the 0.95 floor to paths that are no longer
/// workspace-resolved (Greptile review).
pub fn reset_workspace_resolved_paths() {
    let mut set = workspace_resolved_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    set.clear();
}

fn mark_workspace_resolved(path: &str) {
    let mut set = workspace_resolved_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    set.insert(path.to_string());
}

fn is_workspace_resolved(path: &str) -> bool {
    workspace_resolved_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(path)
}

/// Normalize each `known_files` entry to forward slashes.
///
/// Callers across the NAPI boundary (`resolve_import`/`resolve_imports` in
/// `lib.rs`) may pass either the root-relative form (as stored in the
/// `nodes` table) or the absolute form (as JS's `ctx.allFiles` /
/// `getKnownFilesForIncremental` populate it) — and on Windows, an absolute
/// path arrives with backslashes while `file_exists` always forward-slash
/// normalizes the *candidate* paths it checks against this set before
/// comparing. Without normalizing the set's own entries the same way, an
/// absolute Windows candidate could never exact-match a set built from raw,
/// backslash-separated JS strings — the in-process pipeline caller
/// (`resolve_pipeline_imports`) doesn't need this because it builds
/// `known_files` from `relative_path()`, which already normalizes.
pub fn normalize_known_files(files: Vec<String>) -> HashSet<String> {
    files.into_iter().map(|f| f.replace('\\', "/")).collect()
}

/// Resolve a single import path, mirroring `resolveImportPath()` in builder.js.
///
/// `known_files` enables Rust `crate::`/`self::`/`super::` module-path
/// resolution (issue #2007) — without it, those paths fall through to the
/// unresolved bare-specifier fallback. Callers that already have a project
/// file list (e.g. `ImportEdgeContext`'s batch-cache-miss fallback) should
/// pass it; `None` preserves the old behavior for callers that don't.
pub fn resolve_import_path(
    from_file: &str,
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
    workspaces: Option<&HashMap<String, WorkspaceEntry>>,
) -> String {
    resolve_import_path_inner(
        from_file,
        import_source,
        root_dir,
        aliases,
        known_files,
        workspaces,
    )
}

/// Inner implementation with optional known_files cache.
/// Convert an absolute path candidate into a root-relative, normalized
/// path string. Used as the success exit of every probe in
/// `resolve_import_path_inner`.
fn relativize_to_root(candidate: &str, root_dir: &str) -> String {
    let root = Path::new(root_dir);
    if let Ok(rel) = Path::new(candidate).strip_prefix(root) {
        normalize_path(&rel.display().to_string())
    } else {
        normalize_path(candidate)
    }
}

// ── Rust `crate::`/`self::`/`super::` module-path resolution ────────
// Mirrors resolve.ts's resolveRustUsePath and its helpers (issue #2007).

/// True if `import_source` is a Rust path-qualified `use` path
/// (`crate::...`, `self::...`, or `super::...`) — the only import syntax
/// Rust's module system produces (Rust has no relative-import syntax). No
/// other supported language emits this exact `::`-delimited
/// keyword-prefixed shape, so this signal alone is enough to gate
/// Rust-specific resolution without needing a language/extension parameter
/// threaded through.
fn is_rust_qualified_path(import_source: &str) -> bool {
    import_source == "crate"
        || import_source.starts_with("crate::")
        || import_source == "self"
        || import_source.starts_with("self::")
        || import_source == "super"
        || import_source.starts_with("super::")
}

/// Directory where `file`'s own submodules would live, per Rust convention:
/// mod.rs/lib.rs/main.rs's submodules live in the same directory as the
/// file itself; any other foo.rs's submodules live in a sibling foo/
/// directory.
fn rust_module_dir(file: &str) -> String {
    let path = Path::new(file);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let dir = path.parent().unwrap_or_else(|| Path::new(""));
    if stem == "mod" || stem == "lib" || stem == "main" {
        dir.display().to_string()
    } else {
        dir.join(stem).display().to_string()
    }
}

/// Cargo directory names whose direct .rs children are each their own,
/// independent crate root — a separate binary/example/test/bench target,
/// never sharing a `crate::` module tree with `src/main.rs`/`src/lib.rs` or
/// with each other. `foo/main.rs` nested one level inside one of these
/// (a multi-file binary/example) is already handled by the ordinary
/// main.rs/lib.rs search below and doesn't need this special case.
const CARGO_STANDALONE_TARGET_DIRS: [&str; 4] = ["bin", "examples", "tests", "benches"];

/// A Cargo.toml `[[bin]]`/`[[example]]`/`[[test]]`/`[[bench]]` array-of-table
/// entry may declare an explicit `path = "..."` override to a custom target
/// file (issue #2217) — each such target compiles as its own independent
/// crate, same as a conventional `src/bin/foo.rs`.
#[derive(serde::Deserialize)]
struct CargoTargetEntry {
    path: Option<String>,
}

#[derive(serde::Deserialize, Default)]
struct CargoManifestTargets {
    #[serde(default)]
    bin: Vec<CargoTargetEntry>,
    #[serde(default)]
    example: Vec<CargoTargetEntry>,
    #[serde(default)]
    test: Vec<CargoTargetEntry>,
    #[serde(default)]
    bench: Vec<CargoTargetEntry>,
}

impl CargoManifestTargets {
    fn arrays(&self) -> [&Vec<CargoTargetEntry>; 4] {
        [&self.bin, &self.example, &self.test, &self.bench]
    }
}

/// Cache: root_dir → set of absolute file paths that are independent Cargo
/// targets declared via an explicit Cargo.toml path override (issue #2217).
/// Populated lazily on first Rust crate-root lookup for a given root_dir.
fn cargo_target_overrides_cache() -> &'static Mutex<HashMap<String, HashSet<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, HashSet<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clear the Cargo target-override cache (for testing).
pub fn clear_cargo_target_overrides_cache() {
    let mut cache = cargo_target_overrides_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.clear();
}

/// Find every Cargo.toml under root_dir. A Cargo workspace can have one at
/// the root plus one per member crate, and a target-path override always
/// resolves relative to the manifest that declares it, not to root_dir.
/// Skips the same directories as the ordinary file-collection walk (plus
/// `target`, Cargo's own build-output directory — see issue #2374).
fn find_cargo_manifests(root_dir: &str) -> Vec<PathBuf> {
    let mut manifests = Vec::new();
    let mut stack = vec![PathBuf::from(root_dir)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let entry_path = entry.path();
            if file_type.is_dir() {
                let name = entry.file_name();
                let is_ignored = name
                    .to_str()
                    .map(|n| {
                        n == "target"
                            || crate::domain::graph::builder::stages::collect_files::DEFAULT_IGNORE_DIRS
                                .contains(&n)
                    })
                    .unwrap_or(false);
                if is_ignored {
                    continue;
                }
                stack.push(entry_path);
            } else if entry.file_name() == "Cargo.toml" {
                manifests.push(entry_path);
            }
        }
    }
    manifests
}

/// Parse a single Cargo.toml's `[[bin]]`/`[[example]]`/`[[test]]`/
/// `[[bench]]` sections for an explicit `path = "..."` field, returning each
/// resolved absolute file path. Malformed TOML or an unreadable file yields
/// no overrides rather than failing the whole resolution — this is a
/// best-effort enrichment, not a required input.
fn parse_cargo_target_overrides(manifest_path: &Path) -> Vec<PathBuf> {
    let Ok(content) = std::fs::read_to_string(manifest_path) else {
        return Vec::new();
    };
    let Ok(parsed) = toml::from_str::<CargoManifestTargets>(&content) else {
        return Vec::new();
    };
    let manifest_dir = manifest_path.parent().unwrap_or_else(|| Path::new(""));
    let mut overrides = Vec::new();
    for entries in parsed.arrays() {
        for entry in entries {
            let Some(target_path) = entry.path.as_deref().filter(|p| !p.is_empty()) else {
                continue;
            };
            let mut full = manifest_dir.to_path_buf();
            for segment in target_path.split('/') {
                full.push(segment);
            }
            overrides.push(full);
        }
    }
    overrides
}

fn get_cargo_target_overrides(root_dir: &str) -> HashSet<String> {
    let mut cache = cargo_target_overrides_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = cache.get(root_dir) {
        return existing.clone();
    }
    let mut overrides = HashSet::new();
    for manifest in find_cargo_manifests(root_dir) {
        for target in parse_cargo_target_overrides(&manifest) {
            overrides.insert(target.display().to_string());
        }
    }
    cache.insert(root_dir.to_string(), overrides.clone());
    overrides
}

/// True if `file` is a standalone Cargo target root — either by directory
/// convention (a `.rs` file directly inside `src/bin/`, `examples/`,
/// `tests/`, or `benches/`, not itself named main.rs/lib.rs) or by an
/// explicit Cargo.toml `path = "..."` override at a non-conventional
/// location (issue #2217).
fn is_rust_cargo_target_root(file: &str, root_dir: &str) -> bool {
    let path = Path::new(file);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if stem == "main" || stem == "lib" || stem == "mod" {
        return false;
    }
    if let Some(dir_name) = path.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()) {
        if CARGO_STANDALONE_TARGET_DIRS.contains(&dir_name) {
            return true;
        }
    }
    get_cargo_target_overrides(root_dir).contains(file)
}

/// Find the crate-root .rs file whose directory is an ancestor of
/// `from_file`, walking up from `from_file`'s directory and stopping at
/// `root_dir`. Returns the absolute path, or `None` if no crate root is
/// found among `known_files` — scoping to the nearest ancestor crate root
/// (rather than a project-wide search) correctly handles a Cargo workspace
/// with several crates, each resolving `crate::` relative to its own root.
///
/// A standalone Cargo target file (`src/bin/foo.rs`, `examples/foo.rs`,
/// `tests/foo.rs`, `benches/foo.rs`) is its own crate root regardless of
/// whatever `main.rs`/`lib.rs` exists elsewhere in the ancestor chain —
/// each such file compiles as an independent crate, so walking further up
/// would wrongly attribute its `crate::` paths to an unrelated crate.
fn find_rust_crate_root(
    from_file: &str,
    root_dir: &str,
    known_files: &HashSet<String>,
) -> Option<String> {
    if is_rust_cargo_target_root(from_file, root_dir) {
        return Some(from_file.to_string());
    }
    let mut dir = Path::new(from_file).parent()?.to_path_buf();
    loop {
        for name in ["main.rs", "lib.rs"] {
            let candidate = dir.join(name).display().to_string().replace('\\', "/");
            if file_exists(&candidate, Some(known_files), root_dir) {
                return Some(candidate);
            }
        }
        if !dir.starts_with(root_dir) {
            return None;
        }
        let parent = dir.parent()?;
        if parent == dir {
            return None;
        }
        dir = parent.to_path_buf();
    }
}

/// The file representing `file`'s parent module (one level up the module
/// tree), or `None` if `file` is already a crate root (including a
/// standalone Cargo target) or no parent file is known among `known_files`.
fn rust_parent_module_file(
    file: &str,
    root_dir: &str,
    known_files: &HashSet<String>,
) -> Option<String> {
    let path = Path::new(file);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if stem == "main" || stem == "lib" || is_rust_cargo_target_root(file, root_dir) {
        return None;
    }
    let dir = path.parent()?;
    let search_dir = if stem == "mod" { dir.parent()? } else { dir };

    for candidate in [
        format!("{}.rs", search_dir.display()).replace('\\', "/"),
        search_dir
            .join("mod.rs")
            .display()
            .to_string()
            .replace('\\', "/"),
    ] {
        if file_exists(&candidate, Some(known_files), root_dir) {
            return Some(candidate);
        }
    }
    for name in ["main.rs", "lib.rs"] {
        let candidate = search_dir
            .join(name)
            .display()
            .to_string()
            .replace('\\', "/");
        if file_exists(&candidate, Some(known_files), root_dir) {
            return Some(candidate);
        }
    }
    None
}

/// Walk `segments` (module-path components after the crate::/self::/super::
/// prefix) from `start_dir`, treating each as a submodule file (`seg.rs` or
/// `seg/mod.rs`) if one exists among `known_files`. The final segment may
/// instead be a leaf item name (function/type/const) rather than a module —
/// if it doesn't match a real file, resolution stops one level early and
/// returns the last successfully resolved module file (mirroring how
/// `crate::service::build_service` resolves to service.rs even though
/// build_service itself has no file of its own — the Rust extractor's
/// single-item `use` shape appends the item name to `source`, while the
/// braced-list shape doesn't, so this must handle both).
fn walk_rust_module_segments(
    start_dir: &str,
    start_file: &str,
    segments: &[&str],
    root_dir: &str,
    known_files: &HashSet<String>,
) -> Option<String> {
    let mut current_dir = PathBuf::from(start_dir);
    let mut current_file = start_file.to_string();

    for (i, seg) in segments.iter().enumerate() {
        let file_candidate = current_dir
            .join(format!("{seg}.rs"))
            .display()
            .to_string()
            .replace('\\', "/");
        let mod_candidate = current_dir
            .join(seg)
            .join("mod.rs")
            .display()
            .to_string()
            .replace('\\', "/");

        if file_exists(&file_candidate, Some(known_files), root_dir) {
            current_file = file_candidate;
            current_dir = current_dir.join(seg);
            continue;
        }
        if file_exists(&mod_candidate, Some(known_files), root_dir) {
            current_file = mod_candidate;
            current_dir = current_dir.join(seg);
            continue;
        }
        if i == segments.len() - 1 {
            break;
        }
        return None;
    }
    Some(current_file)
}

/// Resolve a Rust `use crate::a::b::c` / `self::a::b` / `super::a` path to
/// the real file that declares its target module (or, for the trailing
/// item-name case, the module file that item is declared in), by walking
/// the project's directory tree per Rust's module-file conventions (issue
/// #2007), including a Cargo.toml `[[bin]]`/`[[example]]`/`[[test]]`/
/// `[[bench]]` section declaring a target at a custom, non-conventional path
/// (issue #2217). Returns `None` (falls through to the bare-specifier
/// fallback) when `known_files` isn't available or no match is found — e.g.
/// a `#[path]` attribute override, which this convention-and-manifest-based,
/// known-files-only resolver still doesn't model.
fn resolve_rust_use_path(
    from_file: &str,
    import_source: &str,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    let known_files = known_files?;
    let segments: Vec<&str> = import_source.split("::").collect();
    if segments.is_empty() {
        return None;
    }

    let (start_dir, start_file, rest): (String, String, &[&str]) = match segments[0] {
        "crate" => {
            let root_file = find_rust_crate_root(from_file, root_dir, known_files)?;
            let dir = Path::new(&root_file).parent()?.display().to_string();
            (dir, root_file, &segments[1..])
        }
        "self" => {
            let dir = rust_module_dir(from_file);
            (dir, from_file.to_string(), &segments[1..])
        }
        "super" => {
            let mut cur = from_file.to_string();
            let mut i = 0;
            while i < segments.len() && segments[i] == "super" {
                cur = rust_parent_module_file(&cur, root_dir, known_files)?;
                i += 1;
            }
            let dir = rust_module_dir(&cur);
            (dir, cur, &segments[i..])
        }
        _ => return None,
    };

    let resolved = walk_rust_module_segments(&start_dir, &start_file, rest, root_dir, known_files)?;
    Some(relativize_to_root(&resolved, root_dir))
}

/// Resolve a non-relative (alias, Rust module-path, workspace, or bare)
/// import source. Returns the resolved path or the raw source if nothing
/// matches (bare specifier).
///
/// Order mirrors `resolveImportPathJS()`: aliases take priority (tsconfig/
/// jsconfig path mappings), then Rust `crate::`/`self::`/`super::` paths
/// (unambiguous keyword-prefixed signal, checked before the npm-oriented
/// workspace/bare-specifier fallbacks), then workspace packages ("workspace
/// packages take priority over node_modules" — resolve.ts), then the raw
/// specifier is returned unresolved.
fn resolve_non_relative_import(
    from_file: &str,
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
    workspaces: Option<&HashMap<String, WorkspaceEntry>>,
) -> String {
    if let Some(alias_resolved) = resolve_via_alias(import_source, aliases, root_dir, known_files) {
        return relativize_to_root(&alias_resolved, root_dir);
    }
    if is_rust_qualified_path(import_source) && from_file.ends_with(".rs") {
        if let Some(rust_resolved) =
            resolve_rust_use_path(from_file, import_source, root_dir, known_files)
        {
            return rust_resolved;
        }
    }
    if let Some(workspaces) = workspaces {
        if let Some(ws_resolved) =
            resolve_via_workspace(import_source, workspaces, root_dir, known_files)
        {
            let rel = relativize_to_root(&ws_resolved, root_dir);
            mark_workspace_resolved(&rel);
            return rel;
        }
    }
    // Plain node_modules bare specifiers whose package only exposes an entry
    // via `exports` (no matching `main`/index-file convention) — matching
    // resolveImportPathJS()'s fallback order (issue #2060).
    if let Some(exports_resolved) = resolve_via_exports(import_source, root_dir) {
        return relativize_to_root(&exports_resolved, root_dir);
    }
    import_source.to_string()
}

/// Probe the `.js → .ts/.tsx` remap candidates and return the first
/// existing file's root-relative path, if any.
/// Skips candidates that exist but lie outside `root_dir` (strip_prefix
/// would fail), preserving the original fall-through behaviour.
fn probe_js_to_ts_remap(
    resolved_str: &str,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    if !resolved_str.ends_with(".js") {
        return None;
    }
    let root = Path::new(root_dir);
    for replacement in [".ts", ".tsx"] {
        let candidate = resolved_str.replace(".js", replacement);
        if file_exists(&candidate, known_files, root_dir) {
            if let Ok(rel) = Path::new(&candidate).strip_prefix(root) {
                return Some(normalize_path(&rel.display().to_string()));
            }
            // candidate exists but is outside root_dir — keep probing
        }
    }
    None
}

/// Probe known extensions (TS/JS/Python plus index files) for an existing
/// match against the normalized relative path stem.
/// Skips candidates that exist but lie outside `root_dir` (strip_prefix
/// would fail), preserving the original fall-through behaviour.
fn probe_known_extensions(
    resolved_str: &str,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    const EXTENSIONS: &[&str] = &[
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".py",
        ".pyi",
        "/index.ts",
        "/index.tsx",
        "/index.js",
        "/__init__.py",
    ];
    let root = Path::new(root_dir);
    for ext in EXTENSIONS {
        let candidate = format!("{resolved_str}{ext}");
        if file_exists(&candidate, known_files, root_dir) {
            if let Ok(rel) = Path::new(&candidate).strip_prefix(root) {
                return Some(normalize_path(&rel.display().to_string()));
            }
            // candidate exists but is outside root_dir — keep probing
        }
    }
    None
}

fn resolve_import_path_inner(
    from_file: &str,
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
    workspaces: Option<&HashMap<String, WorkspaceEntry>>,
) -> String {
    if !import_source.starts_with('.') {
        return resolve_non_relative_import(
            from_file,
            import_source,
            root_dir,
            aliases,
            known_files,
            workspaces,
        );
    }

    let dir = Path::new(from_file).parent().unwrap_or(Path::new(""));
    let resolved = clean_path(&dir.join(import_source));
    let resolved_str = resolved.display().to_string().replace('\\', "/");

    if let Some(p) = probe_js_to_ts_remap(&resolved_str, root_dir, known_files) {
        return p;
    }
    if let Some(p) = probe_known_extensions(&resolved_str, root_dir, known_files) {
        return p;
    }
    if file_exists(&resolved_str, known_files, root_dir) {
        return relativize_to_root(&resolved_str, root_dir);
    }
    relativize_to_root(&resolved.display().to_string().replace('\\', "/"), root_dir)
}

/// All ancestor directories of `dir`, starting with `dir` itself, walking up to the root.
fn ancestor_chain(dir: &str) -> Vec<String> {
    let mut chain = vec![dir.to_string()];
    let mut cur = dir.to_string();
    while let Some(parent) = Path::new(&cur).parent() {
        let parent_str = parent.display().to_string();
        chain.push(parent_str.clone());
        cur = parent_str;
    }
    chain
}

// directory_distance is on the hot path for every call-edge confidence
// score, invoked from inside compute_confidence's rayon `.par_iter()` caller
// (line ~330 below). The same directory pairs recur constantly across a
// build, so memoizing avoids rebuilding both ancestor chains and the lookup
// map every call. Thread-local (not a shared Mutex/DashMap) because rayon's
// worker pool is reused across the whole build — each worker accumulates its
// own useful cache with zero lock contention, at the cost of some redundant
// computation the first time a given pair is seen on each thread.
// distance(a, b) === distance(b, a) (symmetric tree distance), so the key is
// order-independent to halve the effective cache size per thread (#1769
// perf regression).
thread_local! {
    static DIRECTORY_DISTANCE_CACHE: std::cell::RefCell<std::collections::HashMap<(String, String), usize>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Directory-tree distance between two directories: hops up from `a` to the
/// nearest ancestor shared with `b`, plus hops down from there to `b`.
///
/// Symmetric and depth-independent — unlike a fixed-depth equality check
/// (e.g. comparing the parent-of-parent of `a` to the parent-of-parent of
/// `b`, as `compute_confidence` used to), this correctly scores both sibling
/// directories (common parent) and direct ancestor/descendant directories
/// (one nested inside the other) regardless of how deep either path is. The
/// fixed-depth check only matched when both files sat at the *same* depth,
/// so e.g. a file in `graph/algorithms/*.rs` calling a method declared in
/// the shallower `graph/model.rs` was scored as maximally distant (issue #1769).
fn directory_distance(a: &str, b: &str) -> usize {
    let key = if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    };
    if let Some(cached) = DIRECTORY_DISTANCE_CACHE.with(|c| c.borrow().get(&key).copied()) {
        return cached;
    }

    let chain_a = ancestor_chain(a);
    let chain_b = ancestor_chain(b);
    let index_in_b: std::collections::HashMap<&str, usize> = chain_b
        .iter()
        .enumerate()
        .map(|(j, d)| (d.as_str(), j))
        .collect();
    let mut dist = usize::MAX;
    for (i, dir_a) in chain_a.iter().enumerate() {
        if let Some(&j) = index_in_b.get(dir_a.as_str()) {
            dist = i + j;
            break;
        }
    }
    DIRECTORY_DISTANCE_CACHE.with(|c| c.borrow_mut().insert(key, dist));
    dist
}

/// Coarse "language family" for a file, derived from its extension via
/// `LanguageKind::from_extension`. Collapses TypeScript/Tsx into the same
/// family as JavaScript: despite being distinct `LanguageKind` variants (one
/// per tree-sitter grammar), `.ts`/`.tsx` files routinely import from and
/// call into `.js` files and vice versa within the same project (this
/// codebase's own `src/` tree does this throughout) — treating them as
/// separate families would reject huge amounts of legitimate same-project
/// resolution. Every other `LanguageKind` variant keeps its own family,
/// preserving `from_extension`'s existing per-language extension groupings
/// (e.g. C's `.c`+`.h`, C++'s `.cpp`/`.cc`/`.cxx`/`.hpp`) — EXCEPT `.h`,
/// treated as ambiguous (returns `None`) rather than inheriting
/// `from_extension`'s C-only mapping: `from_extension` needs one canonical
/// grammar per extension, but a `.h` header is real-world ambiguous between
/// C and C++, and the extremely common case of a `.cpp` file calling into
/// its own project's `.h` header would otherwise be misclassified as
/// cross-language and rejected outright — a real regression from the
/// pre-#1783 same-directory score of 0.7 (Greptile review). This keeps the
/// C/C++-header case working without merging C and C++ source-file families
/// wholesale (`.c` vs `.cpp` intentionally do NOT merge — see
/// is_same_language_family_does_not_merge_c_and_cpp).
fn language_family(file: &str) -> Option<LanguageKind> {
    if file.to_ascii_lowercase().ends_with(".h") {
        return None;
    }
    match LanguageKind::from_extension(file) {
        Some(LanguageKind::TypeScript) | Some(LanguageKind::Tsx) => Some(LanguageKind::JavaScript),
        other => other,
    }
}

/// True when `file_a` and `file_b` belong to the same language family, or
/// when either extension is unrecognised (ambiguous cases are not rejected —
/// they fall through to normal scoring). False only when both extensions are
/// recognised AND resolve to different families.
///
/// Guards the global-by-name call-resolution fallback against matching a
/// same-named symbol across unrelated languages — e.g. a Ruby file's bare
/// `load` call has no static relationship to a same-named `load` export in a
/// JS file, even when both happen to live in the same directory (issue
/// #1783). Mirrors `isSameLanguageFamily()` in resolve.ts.
pub fn is_same_language_family(file_a: &str, file_b: &str) -> bool {
    match (language_family(file_a), language_family(file_b)) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

/// Compute proximity-based confidence for call resolution.
/// Mirrors `computeConfidence()` in resolve.ts.
pub fn compute_confidence(
    caller_file: &str,
    target_file: &str,
    imported_from: Option<&str>,
) -> f64 {
    if target_file.is_empty() || caller_file.is_empty() {
        return 0.3;
    }
    if caller_file == target_file {
        return 1.0;
    }
    if let Some(imp) = imported_from {
        if imp == target_file {
            return 1.0;
        }
        // Workspace-resolved imports get high confidence even across package
        // boundaries — mirrors the `_workspaceResolvedPaths` check in
        // `computeConfidenceJS()` (resolve.ts), backed here by the
        // process-lifetime cache populated by `resolve_import_path`/
        // `resolve_imports_batch` (issue #1927).
        if is_workspace_resolved(imp) {
            return 0.95;
        }
    }
    // Cross-language candidates are never legitimate call targets (#1783) —
    // reject before scoring proximity so a same-directory, same-named symbol
    // in an unrelated language can never pass the resolver's 0.5 threshold.
    if !is_same_language_family(caller_file, target_file) {
        return 0.0;
    }

    let caller_dir = Path::new(caller_file)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let target_dir = Path::new(target_file)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    match directory_distance(&caller_dir, &target_dir) {
        0 => 0.7, // same directory
        1 => 0.6, // direct parent/child directory
        2 => 0.5, // sibling directories, or a grandparent/grandchild pair
        _ => 0.3,
    }
}

/// Batch resolve multiple imports (parallelized with rayon).
pub fn resolve_imports_batch(
    inputs: &[ImportResolutionInput],
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
    workspaces: Option<&HashMap<String, WorkspaceEntry>>,
) -> Vec<ResolvedImport> {
    inputs
        .par_iter()
        .map(|input| {
            let resolved = resolve_import_path_inner(
                &input.from_file,
                &input.import_source,
                root_dir,
                aliases,
                known_files,
                workspaces,
            );
            ResolvedImport {
                from_file: input.from_file.clone(),
                import_source: input.import_source.clone(),
                resolved_path: resolved,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn clean_path_collapses_parent_dirs() {
        assert_eq!(
            clean_path(Path::new("src/cli/commands/../../domain/graph/builder.js")),
            PathBuf::from("src/domain/graph/builder.js")
        );
    }

    #[test]
    fn clean_path_skips_cur_dir() {
        assert_eq!(
            clean_path(Path::new("src/./foo.ts")),
            PathBuf::from("src/foo.ts")
        );
    }

    #[test]
    fn clean_path_handles_absolute_root() {
        assert_eq!(
            clean_path(Path::new("/src/../foo.ts")),
            PathBuf::from("/foo.ts")
        );
    }

    #[test]
    fn clean_path_mixed_segments() {
        assert_eq!(
            clean_path(Path::new("a/b/../c/./d/../e.js")),
            PathBuf::from("a/c/e.js")
        );
    }

    #[test]
    fn clean_path_excess_parent_dirs_silently_dropped() {
        // Documents the known limitation: excess leading `..` are dropped
        assert_eq!(clean_path(Path::new("../../foo")), PathBuf::from("foo"));
    }

    #[test]
    fn file_exists_matches_absolute_against_relative_known_files() {
        // Regression test for #804: known_files contains relative paths but
        // extension-probing candidates are absolute. file_exists must strip
        // root_dir to find the match.
        let mut known = HashSet::new();
        known.insert("src/domain/parser.ts".to_string());
        known.insert("src/index.ts".to_string());

        let root = "/project";

        // Absolute candidate should match relative known_files entry
        assert!(file_exists(
            "/project/src/domain/parser.ts",
            Some(&known),
            root
        ));
        assert!(file_exists("/project/src/index.ts", Some(&known), root));

        // Non-matching paths should still return false
        assert!(!file_exists(
            "/project/src/nonexistent.ts",
            Some(&known),
            root
        ));

        // Relative candidate should still match directly
        assert!(file_exists("src/domain/parser.ts", Some(&known), root));
    }

    #[test]
    fn file_exists_matches_unnormalized_backslash_candidate_against_absolute_known_files() {
        // Regression test for #2216: on Windows, callers like
        // resolve_via_alias build their candidate via PathBuf::display()
        // without normalizing it — and known_files may be the absolute
        // convention (ctx.allFiles / getKnownFilesForIncremental, normalized
        // via normalize_known_files). Simulating that with a literal
        // backslash-separated candidate string, on a Set already containing
        // the forward-slash form, must still match — file_exists normalizes
        // the query path itself rather than relying on the caller to have
        // done so.
        let mut known = HashSet::new();
        known.insert("C:/project/src/index.ts".to_string());

        assert!(file_exists(
            "C:\\project\\src\\index.ts",
            Some(&known),
            "C:/project"
        ));
    }

    #[test]
    fn resolve_with_known_files_probes_extensions() {
        // Regression test for #804: when from_file is absolute and known_files
        // are relative, extension probing should still resolve ./bar to src/bar.ts
        let mut known = HashSet::new();
        known.insert("src/bar.ts".to_string());

        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };

        let result = resolve_import_path_inner(
            "/project/src/foo.ts",
            "./bar",
            "/project",
            &aliases,
            Some(&known),
            None,
        );
        assert_eq!(result, "src/bar.ts");
    }

    #[test]
    fn resolve_js_to_ts_remap_with_known_files() {
        // .js → .ts remap should also work with absolute/relative mismatch
        let mut known = HashSet::new();
        known.insert("src/utils.ts".to_string());

        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };

        let result = resolve_import_path_inner(
            "/project/src/index.ts",
            "./utils.js",
            "/project",
            &aliases,
            Some(&known),
            None,
        );
        assert_eq!(result, "src/utils.ts");
    }

    // Regression tests for #1769: a fixed-depth "grandparent equality" check
    // used to compare the parent of `caller_dir` to the parent of `target_dir`,
    // which only matched when both files sat at the *same* depth. A file in a
    // subdirectory calling a method declared in its direct parent directory
    // (e.g. `graph/algorithms/bfs.rs` calling `graph/model.rs`) was scored as
    // maximally distant (0.3) purely because the two files were nested at
    // different depths — well below the 0.5 threshold used by the call-edge
    // resolver's typed-method lookup, silently dropping the call edge.

    #[test]
    fn compute_confidence_scores_parent_child_dirs_above_resolver_threshold() {
        let conf = compute_confidence("src/graph/algorithms/bfs.rs", "src/graph/model.rs", None);
        assert!(conf >= 0.5, "expected >= 0.5, got {conf}");
    }

    #[test]
    fn compute_confidence_is_symmetric_for_parent_child_dirs() {
        let caller_deeper =
            compute_confidence("src/graph/algorithms/bfs.rs", "src/graph/model.rs", None);
        let target_deeper =
            compute_confidence("src/graph/model.rs", "src/graph/algorithms/bfs.rs", None);
        assert_eq!(caller_deeper, target_deeper);
    }

    #[test]
    fn compute_confidence_ranks_parent_child_between_same_dir_and_sibling() {
        let same_dir = compute_confidence("src/graph/a.rs", "src/graph/b.rs", None);
        let parent_child =
            compute_confidence("src/graph/algorithms/bfs.rs", "src/graph/model.rs", None);
        // True siblings: both one level below `src`, at equal depth.
        let sibling = compute_confidence("src/graph/a.rs", "src/features/b.rs", None);
        assert!(same_dir > parent_child);
        assert!(parent_child > sibling);
    }

    #[test]
    fn compute_confidence_scores_two_level_nesting_at_or_above_sibling_tier() {
        // the graph/algorithms/leiden/*.rs -> graph/model.rs shape from #1769.
        let conf = compute_confidence(
            "src/graph/algorithms/leiden/cpm.rs",
            "src/graph/model.rs",
            None,
        );
        assert!(conf >= 0.5, "expected >= 0.5, got {conf}");
    }

    #[test]
    fn compute_confidence_still_scores_unrelated_deep_files_as_distant() {
        let conf = compute_confidence(
            "src/graph/algorithms/leiden/cpm.rs",
            "src/mcp/server.rs",
            None,
        );
        assert!(conf < 0.5, "expected < 0.5, got {conf}");
    }

    #[test]
    fn directory_distance_same_dir_is_zero() {
        assert_eq!(directory_distance("src/graph", "src/graph"), 0);
    }

    #[test]
    fn directory_distance_direct_parent_child_is_one() {
        assert_eq!(directory_distance("src/graph/algorithms", "src/graph"), 1);
        assert_eq!(directory_distance("src/graph", "src/graph/algorithms"), 1);
    }

    #[test]
    fn directory_distance_siblings_is_two() {
        // Both dirs are one level below `src` — true siblings at equal depth.
        assert_eq!(directory_distance("src/graph", "src/features"), 2);
    }

    #[test]
    fn directory_distance_unequal_depth_non_siblings_is_three() {
        // `algorithms` is nested inside `graph`, which is a sibling of `features` —
        // not a direct sibling pair despite sharing the `src` ancestor.
        assert_eq!(
            directory_distance("src/graph/algorithms", "src/features"),
            3
        );
    }

    // Regression tests for #1783: the global-by-name call-resolution fallback
    // had no language-consistency check at all, so a bare-name call with no
    // import/receiver match could resolve against a same-named symbol in a
    // completely unrelated language — e.g. a Ruby file's builtin `Kernel#load`
    // call matched a JS ESM loader hook's unrelated `load` export purely
    // because both files sat in the same directory (confidence 0.7 from
    // proximity alone, well above the resolver's 0.5 threshold).

    #[test]
    fn is_same_language_family_rejects_ruby_and_js() {
        assert!(!is_same_language_family(
            "tracer/ruby-tracer.rb",
            "tracer/loader-hooks.mjs"
        ));
    }

    #[test]
    fn is_same_language_family_rejects_python_and_go() {
        assert!(!is_same_language_family("src/main.py", "src/main.go"));
    }

    #[test]
    fn is_same_language_family_accepts_same_extension() {
        assert!(is_same_language_family("src/a.rb", "lib/b.rb"));
    }

    #[test]
    fn is_same_language_family_merges_javascript_and_typescript() {
        assert!(is_same_language_family("src/a.ts", "src/b.js"));
        assert!(is_same_language_family("src/a.tsx", "src/b.mjs"));
        assert!(is_same_language_family("src/a.cjs", "src/b.jsx"));
    }

    #[test]
    fn is_same_language_family_merges_c_source_and_header() {
        assert!(is_same_language_family("src/a.c", "src/a.h"));
    }

    #[test]
    fn is_same_language_family_treats_h_as_ambiguous_with_cpp() {
        // Greptile follow-up to #1783: `.h` is real-world ambiguous between C
        // and C++ (LANGUAGE_REGISTRY/from_extension assigns it to C alone for
        // grammar-selection purposes), so a `.cpp` file calling into its own
        // project's `.h` header must not be rejected as cross-language.
        assert!(is_same_language_family("src/widget.cpp", "src/widget.h"));
    }

    #[test]
    fn is_same_language_family_merges_cpp_source_and_header_variants() {
        assert!(is_same_language_family("src/a.cpp", "src/a.hpp"));
        assert!(is_same_language_family("src/a.cc", "src/a.cxx"));
    }

    #[test]
    fn is_same_language_family_does_not_merge_c_and_cpp() {
        assert!(!is_same_language_family("src/a.c", "src/a.cpp"));
    }

    #[test]
    fn is_same_language_family_does_not_reject_unrecognised_extensions() {
        // Ambiguous (unrecognised) extensions fall through rather than being rejected.
        assert!(is_same_language_family("README", "src/b.rb"));
        assert!(is_same_language_family("src/a.rb", "Makefile"));
    }

    #[test]
    fn compute_confidence_rejects_cross_language_same_directory_match() {
        // The exact #1783 repro shape: same directory, different languages.
        let conf = compute_confidence(
            "tests/benchmarks/resolution/tracer/ruby-tracer.rb",
            "tests/benchmarks/resolution/tracer/loader-hooks.mjs",
            None,
        );
        assert_eq!(conf, 0.0);
    }

    #[test]
    fn compute_confidence_still_scores_same_language_same_directory_pair() {
        let conf = compute_confidence(
            "tests/benchmarks/resolution/tracer/ruby-tracer.rb",
            "tests/benchmarks/resolution/tracer/other-tracer.rb",
            None,
        );
        assert_eq!(conf, 0.7);
    }

    #[test]
    fn compute_confidence_does_not_regress_same_project_js_ts_resolution() {
        // A .ts caller resolving a same-directory .js target must be unaffected —
        // TS/JS are one family despite being different LanguageKind variants.
        let conf = compute_confidence("src/graph/a.ts", "src/graph/b.js", None);
        assert_eq!(conf, 0.7);
    }

    // Regression tests for #1927: `resolve_import_path_inner` had no
    // workspace-awareness at all, so a bare monorepo-package specifier (e.g.
    // `import "@myorg/lib"`) fell straight through to `resolve_non_relative_import`'s
    // raw-specifier fallback under the native engine, unlike the WASM/JS engine's
    // `resolveViaWorkspace()`.

    fn make_workspaces(entries: &[(&str, &str, Option<&str>)]) -> HashMap<String, WorkspaceEntry> {
        entries
            .iter()
            .map(|(name, dir, entry)| {
                (
                    name.to_string(),
                    WorkspaceEntry {
                        dir: dir.to_string(),
                        entry: entry.map(|e| e.to_string()),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn parse_bare_specifier_scoped_package_root() {
        assert_eq!(
            parse_bare_specifier("@myorg/core"),
            Some(("@myorg/core".to_string(), ".".to_string()))
        );
    }

    #[test]
    fn parse_bare_specifier_scoped_package_subpath() {
        assert_eq!(
            parse_bare_specifier("@myorg/core/src/helpers"),
            Some(("@myorg/core".to_string(), "./src/helpers".to_string()))
        );
    }

    #[test]
    fn parse_bare_specifier_plain_package() {
        assert_eq!(
            parse_bare_specifier("lodash"),
            Some(("lodash".to_string(), ".".to_string()))
        );
        assert_eq!(
            parse_bare_specifier("lodash/fp"),
            Some(("lodash".to_string(), "./fp".to_string()))
        );
    }

    #[test]
    fn parse_bare_specifier_rejects_malformed_scoped_specifier() {
        assert_eq!(parse_bare_specifier("@myorg"), None);
    }

    #[test]
    fn resolve_via_workspace_resolves_root_import_to_entry() {
        let workspaces = make_workspaces(&[(
            "@myorg/core",
            "packages/core",
            Some("packages/core/src/index.js"),
        )]);
        let result = resolve_via_workspace("@myorg/core", &workspaces, "/project", None);
        assert_eq!(result, Some("packages/core/src/index.js".to_string()));
    }

    #[test]
    fn resolve_via_workspace_returns_none_when_entry_missing() {
        let workspaces = make_workspaces(&[("@myorg/broken", "packages/broken", None)]);
        let result = resolve_via_workspace("@myorg/broken", &workspaces, "/project", None);
        assert_eq!(result, None);
    }

    #[test]
    fn resolve_via_workspace_resolves_subpath_via_known_files_probe() {
        let mut known = HashSet::new();
        known.insert("packages/core/src/helpers.js".to_string());
        let workspaces = make_workspaces(&[("@myorg/core", "packages/core", None)]);
        let result = resolve_via_workspace(
            "@myorg/core/src/helpers",
            &workspaces,
            "/project",
            Some(&known),
        );
        assert_eq!(result, Some("packages/core/src/helpers.js".to_string()));
    }

    #[test]
    fn resolve_via_workspace_resolves_subpath_via_src_convention() {
        let mut known = HashSet::new();
        known.insert("packages/core/src/helpers.js".to_string());
        let workspaces = make_workspaces(&[("@myorg/core", "packages/core", None)]);
        let result =
            resolve_via_workspace("@myorg/core/helpers", &workspaces, "/project", Some(&known));
        assert_eq!(result, Some("packages/core/src/helpers.js".to_string()));
    }

    #[test]
    fn resolve_via_workspace_returns_none_for_unknown_package() {
        let workspaces = make_workspaces(&[("@myorg/core", "packages/core", None)]);
        assert_eq!(
            resolve_via_workspace("@myorg/unknown", &workspaces, "/project", None),
            None
        );
    }

    #[test]
    fn resolve_via_workspace_returns_none_when_no_workspaces_registered() {
        let workspaces: HashMap<String, WorkspaceEntry> = HashMap::new();
        assert_eq!(
            resolve_via_workspace("@myorg/core", &workspaces, "/project", None),
            None
        );
    }

    #[test]
    fn resolve_non_relative_import_prefers_workspace_over_raw_specifier() {
        let workspaces = make_workspaces(&[(
            "@myorg/lib",
            "packages/lib",
            Some("/project/packages/lib/src/index.js"),
        )]);
        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };
        let resolved = resolve_non_relative_import(
            "/project/src/main.js",
            "@myorg/lib",
            "/project",
            &aliases,
            None,
            Some(&workspaces),
        );
        assert_eq!(resolved, "packages/lib/src/index.js");
    }

    #[test]
    fn resolve_non_relative_import_falls_back_to_raw_specifier_without_workspace_match() {
        let workspaces = make_workspaces(&[("@myorg/lib", "packages/lib", None)]);
        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };
        let resolved = resolve_non_relative_import(
            "/project/src/main.js",
            "lodash",
            "/project",
            &aliases,
            None,
            Some(&workspaces),
        );
        assert_eq!(resolved, "lodash");
    }

    // Serializes access to the process-lifetime workspace-resolved-paths
    // cache: `cargo test` runs tests in parallel threads within one process,
    // and `reset_workspace_resolved_paths()` would otherwise race with
    // concurrent assertions in other tests below.
    static WORKSPACE_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_workspace_cache_lock<F: FnOnce()>(f: F) {
        let guard = WORKSPACE_CACHE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_workspace_resolved_paths();
        f();
        reset_workspace_resolved_paths();
        drop(guard);
    }

    #[test]
    fn resolve_import_path_marks_workspace_resolved_paths() {
        with_workspace_cache_lock(|| {
            let workspaces = make_workspaces(&[(
                "@myorg/lib",
                "packages/lib",
                Some("/project/packages/lib/src/index.js"),
            )]);
            let aliases = PathAliases {
                base_url: None,
                paths: vec![],
            };
            let resolved = resolve_import_path(
                "/project/apps/web/src/app.js",
                "@myorg/lib",
                "/project",
                &aliases,
                None,
                Some(&workspaces),
            );
            assert_eq!(resolved, "packages/lib/src/index.js");
            assert!(is_workspace_resolved("packages/lib/src/index.js"));
        });
    }

    #[test]
    fn compute_confidence_returns_0_95_for_workspace_resolved_import() {
        with_workspace_cache_lock(|| {
            mark_workspace_resolved("packages/lib/src/index.js");
            let conf = compute_confidence(
                "apps/web/src/app.js",
                "packages/lib/src/utils.js",
                Some("packages/lib/src/index.js"),
            );
            assert_eq!(conf, 0.95);
        });
    }

    #[test]
    fn compute_confidence_does_not_boost_non_workspace_imports() {
        with_workspace_cache_lock(|| {
            let conf = compute_confidence(
                "apps/web/src/app.js",
                "some/distant/file.js",
                Some("some/other/import.js"),
            );
            assert!(conf < 0.95);
        });
    }

    #[test]
    fn reset_workspace_resolved_paths_clears_previously_marked_entries() {
        with_workspace_cache_lock(|| {
            mark_workspace_resolved("packages/lib/src/index.js");
            assert!(is_workspace_resolved("packages/lib/src/index.js"));
            reset_workspace_resolved_paths();
            assert!(!is_workspace_resolved("packages/lib/src/index.js"));
        });
    }

    // Regression tests for #2007: `crate::`/`self::`/`super::` Rust module
    // paths previously fell through resolve_non_relative_import's bare
    // fallback, returning the literal unresolved path string. Fixture
    // mirrors tests/benchmarks/resolution/fixtures/rust/ (main.rs at the
    // crate root, mod models/repository/service/validator declared there).

    fn rust_fixture_known_files() -> HashSet<String> {
        [
            "main.rs",
            "models.rs",
            "repository.rs",
            "service.rs",
            "validator.rs",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn normalize_known_files_converts_backslashes_to_forward_slashes() {
        // Regression test for #2216: on Windows, JS callers across the NAPI
        // boundary (ctx.allFiles / getKnownFilesForIncremental) pass absolute
        // paths with backslashes, while file_exists always forward-slash
        // normalizes the candidate it checks against this set — without this
        // normalization those two could never exact-match.
        let input = vec![
            "C:\\project\\main.rs".to_string(),
            "C:\\project\\service\\nested.rs".to_string(),
        ];
        let normalized = normalize_known_files(input);
        assert!(normalized.contains("C:/project/main.rs"));
        assert!(normalized.contains("C:/project/service/nested.rs"));
    }

    #[test]
    fn normalize_known_files_is_a_no_op_for_already_forward_slash_paths() {
        let input = vec!["/project/main.rs".to_string(), "service.rs".to_string()];
        let normalized = normalize_known_files(input);
        assert!(normalized.contains("/project/main.rs"));
        assert!(normalized.contains("service.rs"));
    }

    #[test]
    fn is_rust_qualified_path_recognizes_all_three_prefixes() {
        assert!(is_rust_qualified_path("crate::service::build_service"));
        assert!(is_rust_qualified_path("self::helper"));
        assert!(is_rust_qualified_path("super::validator"));
        assert!(is_rust_qualified_path("crate"));
        assert!(!is_rust_qualified_path("./relative"));
        assert!(!is_rust_qualified_path("lodash"));
        assert!(!is_rust_qualified_path("std::collections::HashMap"));
    }

    #[test]
    fn crate_use_path_resolves_single_item_form_to_declaring_file() {
        // `use crate::service::build_service;` — source includes the
        // trailing item name (build_service has no file of its own).
        let known = rust_fixture_known_files();
        let resolved = resolve_rust_use_path(
            "/project/main.rs",
            "crate::service::build_service",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, Some("service.rs".to_string()));
    }

    #[test]
    fn crate_use_path_resolves_braced_list_form_to_declaring_file() {
        // `use crate::models::{create_user, Repository};` — source is the
        // module path alone, no trailing item name.
        let known = rust_fixture_known_files();
        let resolved = resolve_rust_use_path(
            "/project/main.rs",
            "crate::models",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, Some("models.rs".to_string()));
    }

    #[test]
    fn crate_use_path_resolves_from_a_non_root_file() {
        // service.rs itself resolves `crate::validator::validate_all`,
        // proving crate-root lookup doesn't depend on from_file being the
        // crate root.
        let known = rust_fixture_known_files();
        let resolved = resolve_rust_use_path(
            "/project/service.rs",
            "crate::validator::validate_all",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, Some("validator.rs".to_string()));
    }

    #[test]
    fn self_use_path_resolves_sibling_submodule() {
        let mut known = rust_fixture_known_files();
        known.insert("service/nested.rs".to_string());
        let resolved = resolve_rust_use_path(
            "/project/service.rs",
            "self::nested",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, Some("service/nested.rs".to_string()));
    }

    #[test]
    fn super_use_path_resolves_from_nested_submodule_to_sibling() {
        let mut known = rust_fixture_known_files();
        known.insert("service/nested.rs".to_string());
        known.insert("service/helper.rs".to_string());
        let resolved = resolve_rust_use_path(
            "/project/service/nested.rs",
            "super::helper",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, Some("service/helper.rs".to_string()));
    }

    #[test]
    fn super_use_path_resolves_from_top_level_module_to_crate_root_sibling() {
        let known = rust_fixture_known_files();
        let resolved = resolve_rust_use_path(
            "/project/service.rs",
            "super::validator",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, Some("validator.rs".to_string()));
    }

    #[test]
    fn is_rust_cargo_target_root_recognizes_standalone_target_directories() {
        assert!(is_rust_cargo_target_root("/project/src/bin/tool.rs", "/project"));
        assert!(is_rust_cargo_target_root("/project/examples/demo.rs", "/project"));
        assert!(is_rust_cargo_target_root(
            "/project/tests/integration.rs",
            "/project"
        ));
        assert!(is_rust_cargo_target_root("/project/benches/bench1.rs", "/project"));
        // main.rs/lib.rs/mod.rs are found by the ordinary search, not this path.
        assert!(!is_rust_cargo_target_root(
            "/project/src/bin/tool/main.rs",
            "/project"
        ));
        assert!(!is_rust_cargo_target_root("/project/src/main.rs", "/project"));
        assert!(!is_rust_cargo_target_root("/project/src/lib.rs", "/project"));
        assert!(!is_rust_cargo_target_root("/project/src/foo/mod.rs", "/project"));
        // Not one of the special directory names.
        assert!(!is_rust_cargo_target_root("/project/src/service.rs", "/project"));
    }

    #[test]
    fn crate_use_path_resolves_from_a_standalone_bin_target_to_itself() {
        // src/bin/tool.rs is its own crate root — must NOT walk up and
        // wrongly attribute crate:: to an unrelated src/main.rs or src/lib.rs
        // elsewhere in the project.
        let mut known = HashSet::new();
        known.insert("src/main.rs".to_string());
        known.insert("src/bin/tool.rs".to_string());
        known.insert("src/bin/helper.rs".to_string());
        let resolved = resolve_rust_use_path(
            "/project/src/bin/tool.rs",
            "crate::helper",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, Some("src/bin/helper.rs".to_string()));
    }

    #[test]
    fn super_use_path_returns_none_from_a_standalone_cargo_target_root() {
        // A standalone target file has no parent module to walk up to.
        let mut known = HashSet::new();
        known.insert("tests/integration.rs".to_string());
        let resolved = resolve_rust_use_path(
            "/project/tests/integration.rs",
            "super::helper",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, None);
    }

    /// Build `<tmp>/Cargo.toml` plus a `custom/location/tool.rs` and
    /// `custom/location/helper.rs` and `src/{main,shared,nested}.rs`, where
    /// Cargo.toml declares `custom/location/tool.rs` as a `[[bin]]` path
    /// override (issue #2217). Returns the project root.
    fn make_cargo_toml_override_fixture(tmp_name: &str, manifest_body: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(tmp_name);
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();
        fs::create_dir_all(tmp.join("custom").join("location")).unwrap();
        fs::write(tmp.join("Cargo.toml"), manifest_body).unwrap();
        fs::write(tmp.join("src").join("main.rs"), "").unwrap();
        fs::write(tmp.join("src").join("shared.rs"), "").unwrap();
        fs::write(tmp.join("src").join("nested.rs"), "").unwrap();
        fs::write(tmp.join("custom").join("location").join("tool.rs"), "").unwrap();
        fs::write(tmp.join("custom").join("location").join("helper.rs"), "").unwrap();
        tmp
    }

    const CARGO_TOML_BIN_OVERRIDE: &str = r#"
[package]
name = "demo"

[[bin]]
name = "tool"
path = "custom/location/tool.rs"
"#;

    #[test]
    fn crate_use_path_treats_a_cargo_toml_bin_override_as_its_own_crate_root() {
        let tmp = make_cargo_toml_override_fixture(
            "codegraph_cargo_toml_bin_override_test",
            CARGO_TOML_BIN_OVERRIDE,
        );
        clear_cargo_target_overrides_cache();

        let mut known = HashSet::new();
        for rel in [
            "src/main.rs",
            "src/shared.rs",
            "src/nested.rs",
            "custom/location/tool.rs",
            "custom/location/helper.rs",
        ] {
            known.insert(rel.to_string());
        }
        let from_file = tmp.join("custom").join("location").join("tool.rs");
        let resolved = resolve_rust_use_path(
            from_file.to_str().unwrap(),
            "crate::helper",
            tmp.to_str().unwrap(),
            Some(&known),
        );
        assert_eq!(resolved, Some("custom/location/helper.rs".to_string()));
    }

    #[test]
    fn crate_use_path_from_a_cargo_toml_override_does_not_see_the_other_crates_module_tree() {
        // src/nested.rs exists in the OTHER crate's module tree — if the
        // override crate root wrongly fell back to walking up to src/main.rs,
        // this would resolve instead of returning None.
        let tmp = make_cargo_toml_override_fixture(
            "codegraph_cargo_toml_bin_override_isolation_test",
            CARGO_TOML_BIN_OVERRIDE,
        );
        clear_cargo_target_overrides_cache();

        let mut known = HashSet::new();
        for rel in [
            "src/main.rs",
            "src/nested.rs",
            "custom/location/tool.rs",
            "custom/location/helper.rs",
        ] {
            known.insert(rel.to_string());
        }
        let from_file = tmp.join("custom").join("location").join("tool.rs");
        let resolved = resolve_rust_use_path(
            from_file.to_str().unwrap(),
            "crate::nested::something",
            tmp.to_str().unwrap(),
            Some(&known),
        );
        assert_eq!(resolved, None);
    }

    #[test]
    fn crate_use_path_from_src_main_is_unaffected_by_an_unrelated_cargo_toml_override() {
        let tmp = make_cargo_toml_override_fixture(
            "codegraph_cargo_toml_bin_override_unaffected_test",
            CARGO_TOML_BIN_OVERRIDE,
        );
        clear_cargo_target_overrides_cache();

        let mut known = HashSet::new();
        for rel in [
            "src/main.rs",
            "src/shared.rs",
            "custom/location/tool.rs",
            "custom/location/helper.rs",
        ] {
            known.insert(rel.to_string());
        }
        let from_file = tmp.join("src").join("main.rs");
        let resolved = resolve_rust_use_path(
            from_file.to_str().unwrap(),
            "crate::shared",
            tmp.to_str().unwrap(),
            Some(&known),
        );
        assert_eq!(resolved, Some("src/shared.rs".to_string()));
    }

    #[test]
    fn crate_use_path_falls_through_gracefully_on_malformed_cargo_toml() {
        let tmp = make_cargo_toml_override_fixture(
            "codegraph_cargo_toml_malformed_test",
            "[[bin\nnot valid toml",
        );
        clear_cargo_target_overrides_cache();

        let mut known = HashSet::new();
        for rel in ["src/main.rs", "custom/location/tool.rs"] {
            known.insert(rel.to_string());
        }
        let from_file = tmp.join("custom").join("location").join("tool.rs");
        let resolved = resolve_rust_use_path(
            from_file.to_str().unwrap(),
            "crate::helper",
            tmp.to_str().unwrap(),
            Some(&known),
        );
        assert_eq!(resolved, None);
    }

    #[test]
    fn crate_use_path_returns_none_on_dead_end_mid_path() {
        let known = rust_fixture_known_files();
        let resolved = resolve_rust_use_path(
            "/project/main.rs",
            "crate::nonexistent::foo",
            "/project",
            Some(&known),
        );
        assert_eq!(resolved, None);
    }

    #[test]
    fn crate_use_path_returns_none_without_known_files() {
        let resolved = resolve_rust_use_path(
            "/project/main.rs",
            "crate::service::build_service",
            "/project",
            None,
        );
        assert_eq!(resolved, None);
    }

    #[test]
    fn resolve_non_relative_import_resolves_rust_crate_path_end_to_end() {
        let known = rust_fixture_known_files();
        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };
        let resolved = resolve_non_relative_import(
            "/project/main.rs",
            "crate::service::build_service",
            "/project",
            &aliases,
            Some(&known),
            None,
        );
        assert_eq!(resolved, "service.rs");
    }

    #[test]
    fn resolve_import_path_resolves_rust_crate_path_via_known_files() {
        // Regression test for #2007: the public single-import entry point
        // used to hardcode known_files to None, making Rust crate::/self::/
        // super:: resolution structurally impossible on this path even when
        // the caller (e.g. ImportEdgeContext's batch-cache-miss fallback)
        // has a real known_files set available.
        let known = rust_fixture_known_files();
        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };
        let resolved = resolve_import_path(
            "/project/main.rs",
            "crate::service::build_service",
            "/project",
            &aliases,
            Some(&known),
            None,
        );
        assert_eq!(resolved, "service.rs");
    }

    #[test]
    fn resolve_non_relative_import_does_not_treat_non_rust_files_as_rust_paths() {
        // A `.ts` file importing a literal string that happens to look like
        // a Rust path must not be hijacked by the Rust resolver — falls
        // through to the ordinary bare-specifier fallback.
        let known = rust_fixture_known_files();
        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };
        let resolved = resolve_non_relative_import(
            "/project/main.ts",
            "crate::service::build_service",
            "/project",
            &aliases,
            Some(&known),
            None,
        );
        assert_eq!(resolved, "crate::service::build_service");
    }

    // ── package.json `exports` field resolution (issue #2060) ──────────

    /// `resolve_via_exports`/`resolve_via_workspace` always return a
    /// forward-slash-normalized path (via `normalize_path`'s
    /// `.replace('\\', "/")`), but `PathBuf::join` on Windows renders its
    /// OS-native temp-dir portion with backslashes while any forward slashes
    /// already present in a joined literal (e.g. `"node_modules/pkg/x.js"`)
    /// pass through unchanged — producing a MIXED-separator string that
    /// never equals the function's fully-normalized output. Apply the same
    /// normalization to test expectations so assertions compare
    /// like-for-like on every OS.
    fn normalized(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    /// Build `<tmp>/node_modules/<package_name>/package.json` with the given
    /// exports value and other package.json fields, plus any extra files
    /// (relative to the package dir) the exports targets should resolve to.
    fn make_exports_fixture(
        tmp_name: &str,
        package_name: &str,
        package_json_body: &str,
        extra_files: &[(&str, &str)],
    ) -> PathBuf {
        let tmp = std::env::temp_dir().join(tmp_name);
        let _ = fs::remove_dir_all(&tmp);
        let pkg_dir = tmp.join("node_modules").join(package_name);
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(pkg_dir.join("package.json"), package_json_body).unwrap();
        for (rel_path, contents) in extra_files {
            let file_path = pkg_dir.join(rel_path);
            fs::create_dir_all(file_path.parent().unwrap()).unwrap();
            fs::write(file_path, contents).unwrap();
        }
        tmp
    }

    #[test]
    fn resolve_via_exports_resolves_simple_string_exports_with_no_main_field() {
        let tmp = make_exports_fixture(
            "codegraph_exports_simple_string_test",
            "some-pkg",
            r#"{"name": "some-pkg", "exports": "./dist/index.js"}"#,
            &[("dist/index.js", "module.exports = {};")],
        );
        clear_exports_cache();

        let resolved = resolve_via_exports("some-pkg", tmp.to_str().unwrap());
        assert_eq!(
            resolved,
            Some(normalized(&tmp.join("node_modules/some-pkg/dist/index.js")))
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_via_exports_resolves_subpath_via_wildcard_pattern() {
        let tmp = make_exports_fixture(
            "codegraph_exports_wildcard_test",
            "some-pkg",
            r#"{"name": "some-pkg", "exports": {".": "./index.js", "./lib/*": "./dist/lib/*.js"}}"#,
            &[
                ("index.js", "module.exports = {};"),
                ("dist/lib/sub.js", "module.exports = {};"),
            ],
        );
        clear_exports_cache();

        let resolved = resolve_via_exports("some-pkg/lib/sub", tmp.to_str().unwrap());
        assert_eq!(
            resolved,
            Some(normalized(
                &tmp.join("node_modules/some-pkg/dist/lib/sub.js")
            ))
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_via_exports_wildcard_selection_follows_manifest_declaration_order() {
        // Regression guard (issue #2060, caught by Greptile review):
        // resolveSubpathMap()/resolve_subpath_map() must check overlapping
        // wildcard keys in the manifest's DECLARATION order (matching
        // JS's Object.entries()), not sorted-by-key order. "./lib/zeta-*" is
        // declared FIRST here but sorts AFTER "./lib/*" lexicographically
        // ('*' < 'z' in ASCII) — so a subpath matching both must resolve via
        // the first-declared pattern regardless of key sort order. Requires
        // serde_json's `preserve_order` feature (Cargo.toml); without it,
        // serde_json::Map iterates as a sorted BTreeMap and this test fails.
        let tmp = make_exports_fixture(
            "codegraph_exports_wildcard_order_test",
            "some-pkg",
            r#"{"name": "some-pkg", "exports": {"./lib/zeta-*": "./dist/zeta/*.js", "./lib/*": "./dist/generic/*.js"}}"#,
            &[
                ("dist/zeta/foo.js", "module.exports = {};"),
                ("dist/generic/zeta-foo.js", "module.exports = {};"),
            ],
        );
        clear_exports_cache();

        let resolved = resolve_via_exports("some-pkg/lib/zeta-foo", tmp.to_str().unwrap());
        assert_eq!(
            resolved,
            Some(normalized(
                &tmp.join("node_modules/some-pkg/dist/zeta/foo.js")
            ))
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_via_exports_resolves_conditional_exports_preferring_import_over_require() {
        let tmp = make_exports_fixture(
            "codegraph_exports_conditional_test",
            "some-pkg",
            r#"{"name": "some-pkg", "exports": {"import": "./esm/index.js", "require": "./cjs/index.js"}}"#,
            &[
                ("esm/index.js", "export default {};"),
                ("cjs/index.js", "module.exports = {};"),
            ],
        );
        clear_exports_cache();

        let resolved = resolve_via_exports("some-pkg", tmp.to_str().unwrap());
        assert_eq!(
            resolved,
            Some(normalized(&tmp.join("node_modules/some-pkg/esm/index.js")))
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_via_exports_returns_none_when_package_has_no_exports_field() {
        let tmp = make_exports_fixture(
            "codegraph_exports_no_exports_field_test",
            "some-pkg",
            r#"{"name": "some-pkg", "main": "./index.js"}"#,
            &[("index.js", "module.exports = {};")],
        );
        clear_exports_cache();

        assert_eq!(resolve_via_exports("some-pkg", tmp.to_str().unwrap()), None);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_non_relative_import_resolves_via_package_exports_when_no_main_field() {
        // End-to-end regression test for #2060: a package that only exposes
        // its entry via `exports` (no `main` field, no index.js convention)
        // must resolve identically to the JS/WASM engine's resolveImportPathJS().
        let tmp = make_exports_fixture(
            "codegraph_exports_e2e_test",
            "exports-only-pkg",
            r#"{"name": "exports-only-pkg", "exports": "./dist/entry.js"}"#,
            &[("dist/entry.js", "module.exports = {};")],
        );
        clear_exports_cache();

        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };
        let resolved = resolve_non_relative_import(
            &tmp.join("src/main.js").to_string_lossy(),
            "exports-only-pkg",
            tmp.to_str().unwrap(),
            &aliases,
            None,
            None,
        );
        assert_eq!(resolved, "node_modules/exports-only-pkg/dist/entry.js");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_via_workspace_prefers_exports_field_over_registered_entry() {
        // A workspace package whose `exports` field points somewhere other
        // than its registered entry — exports must win, matching
        // resolveViaWorkspace()'s root-import branch. Workspace tools
        // (npm/yarn/pnpm workspaces) symlink workspace packages into
        // node_modules, which is what find_package_dir()'s node_modules
        // walk (used by resolve_via_exports) actually discovers — so only
        // the node_modules copy needs to exist for this test; the
        // WorkspaceEntry's own `dir`/`entry` are deliberately bogus paths to
        // prove they're never consulted when exports resolves successfully.
        let tmp = std::env::temp_dir().join("codegraph_workspace_exports_test");
        let _ = fs::remove_dir_all(&tmp);
        let pkg_dir = tmp.join("node_modules/@myorg/core");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{"name": "@myorg/core", "exports": "./dist/index.js"}"#,
        )
        .unwrap();
        fs::create_dir_all(pkg_dir.join("dist")).unwrap();
        fs::write(pkg_dir.join("dist/index.js"), "module.exports = {};").unwrap();
        clear_exports_cache();

        let mut workspaces = HashMap::new();
        workspaces.insert(
            "@myorg/core".to_string(),
            WorkspaceEntry {
                dir: "/nonexistent/packages/core".to_string(),
                entry: Some("/nonexistent/packages/core/some-other-entry.js".to_string()),
            },
        );

        let resolved =
            resolve_via_workspace("@myorg/core", &workspaces, tmp.to_str().unwrap(), None);
        assert_eq!(resolved, Some(normalized(&pkg_dir.join("dist/index.js"))));

        let _ = fs::remove_dir_all(&tmp);
    }
}
