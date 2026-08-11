import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { debug } from '../../infrastructure/logger.js';
import { loadNative } from '../../infrastructure/native.js';
import { IGNORE_DIRS, normalizePath } from '../../shared/constants.js';
import { toErrorMessage } from '../../shared/errors.js';
import type {
  BareSpecifier,
  BatchResolvedMap,
  ImportBatchItem,
  NativeWorkspacePackage,
  PathAliases,
} from '../../types.js';
import { LANGUAGE_REGISTRY } from '../parser.js';

// ── package.json exports resolution ─────────────────────────────────

/** Cache: packageDir → parsed exports field (or null) */
const _exportsCache: Map<string, any> = new Map();

/**
 * Parse a bare specifier into { packageName, subpath }.
 * Scoped: "@scope/pkg/sub" → { packageName: "@scope/pkg", subpath: "./sub" }
 * Plain:  "pkg/sub"        → { packageName: "pkg", subpath: "./sub" }
 * No sub: "pkg"            → { packageName: "pkg", subpath: "." }
 */
export function parseBareSpecifier(specifier: string): BareSpecifier | null {
  let packageName: string, rest: string;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length < 2) return null;
    packageName = `${parts[0]}/${parts[1]}`;
    rest = parts.slice(2).join('/');
  } else {
    const slashIdx = specifier.indexOf('/');
    if (slashIdx === -1) {
      packageName = specifier;
      rest = '';
    } else {
      packageName = specifier.slice(0, slashIdx);
      rest = specifier.slice(slashIdx + 1);
    }
  }
  return { packageName, subpath: rest ? `./${rest}` : '.' };
}

/**
 * Find the package directory for a given package name, starting from rootDir.
 * Walks up node_modules directories.
 */
function findPackageDir(packageName: string, rootDir: string): string | null {
  let dir = rootDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', packageName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read and cache the exports field from a package's package.json.
 * Returns the exports value or null.
 */
function getPackageExports(packageDir: string): any {
  if (_exportsCache.has(packageDir)) return _exportsCache.get(packageDir);
  try {
    const raw = fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const exports = pkg.exports ?? null;
    _exportsCache.set(packageDir, exports);
    return exports;
  } catch (e) {
    debug(`readPackageExports: failed to read package.json in ${packageDir}: ${toErrorMessage(e)}`);
    _exportsCache.set(packageDir, null);
    return null;
  }
}

/** Condition names to try, in priority order. */
const CONDITION_ORDER: readonly string[] = ['import', 'require', 'default'];

/**
 * Resolve a conditional exports value (string, object with conditions, or array).
 * Returns a string target or null.
 */
function resolveCondition(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = resolveCondition(item);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const cond of CONDITION_ORDER) {
      if (cond in (value as Record<string, unknown>))
        return resolveCondition((value as Record<string, unknown>)[cond]);
    }
    return null;
  }
  return null;
}

/**
 * Match a subpath against an exports map key that uses a wildcard pattern.
 * Key: "./lib/*" matches subpath "./lib/foo/bar" → substitution "foo/bar"
 */
function matchSubpathPattern(pattern: string, subpath: string): string | null {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return null;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!subpath.startsWith(prefix)) return null;
  if (suffix && !subpath.endsWith(suffix)) return null;
  const matched = subpath.slice(prefix.length, suffix ? -suffix.length || undefined : undefined);
  if (!suffix && subpath.length <= prefix.length) return null;
  return matched;
}

/**
 * Resolve a bare specifier through the package.json exports field.
 * Returns an absolute path or null.
 */
/** Try to resolve a condition target to a file path in packageDir. */
function tryResolveTarget(target: string | null, packageDir: string): string | null {
  if (!target) return null;
  const resolved = path.resolve(packageDir, target);
  return fs.existsSync(resolved) ? resolved : null;
}

/** Resolve subpath against a subpath map (object with "." keys). */
function resolveSubpathMap(
  exports: Record<string, unknown>,
  subpath: string,
  packageDir: string,
): string | null {
  // Exact match first
  if (subpath in exports) {
    return tryResolveTarget(resolveCondition(exports[subpath]), packageDir);
  }
  // Pattern matching (keys with *)
  for (const [pattern, value] of Object.entries(exports)) {
    if (!pattern.includes('*')) continue;
    const matched = matchSubpathPattern(pattern, subpath);
    if (matched == null) continue;
    const rawTarget = resolveCondition(value);
    if (!rawTarget) continue;
    return tryResolveTarget(rawTarget.replace(/\*/g, matched), packageDir);
  }
  return null;
}

/**
 * Resolve `parsed` through whatever `exports` field lives at `packageDir`.
 * Shared by `resolveViaExports()` (node_modules-discovered packageDir) and
 * `resolveExportsViaDir()` (a directory the caller already knows, e.g. a
 * workspace package's own real directory — see that function's doc
 * comment for why the two must not both go through `findPackageDir()`).
 */
function resolveExportsInPackageDir(parsed: BareSpecifier, packageDir: string): string | null {
  const exports = getPackageExports(packageDir);
  if (exports == null) return null;

  const { subpath } = parsed;

  // Simple string exports: "exports": "./index.js"
  if (typeof exports === 'string') {
    return subpath === '.' ? tryResolveTarget(exports, packageDir) : null;
  }

  // Array form at top level
  if (Array.isArray(exports)) {
    return subpath === '.' ? tryResolveTarget(resolveCondition(exports), packageDir) : null;
  }

  if (typeof exports !== 'object') return null;

  // Determine if exports is a conditions object or a subpath map
  const keys = Object.keys(exports);
  const isSubpathMap = keys.length > 0 && keys.some((k) => k.startsWith('.'));

  if (!isSubpathMap) {
    return subpath === '.' ? tryResolveTarget(resolveCondition(exports), packageDir) : null;
  }

  return resolveSubpathMap(exports as Record<string, unknown>, subpath, packageDir);
}

export function resolveViaExports(specifier: string, rootDir: string): string | null {
  const parsed = parseBareSpecifier(specifier);
  if (!parsed) return null;

  const packageDir = findPackageDir(parsed.packageName, rootDir);
  if (!packageDir) return null;

  return resolveExportsInPackageDir(parsed, packageDir);
}

/**
 * Resolve `specifier` through the `exports` field at a directory the
 * caller already knows — bypassing `findPackageDir()`'s `node_modules`
 * walk entirely. For a workspace package, `findPackageDir()` would find
 * `node_modules/<pkg>` (a symlink workspace tools create), and resolving
 * `exports` against THAT path string produces a `node_modules/...`-shaped
 * absolute path — one that resolves fine on disk (Node's `fs` follows
 * symlinks) but, once relativized against the project root, never matches
 * the tracked file node at its real, glob-detected location
 * (`packages/...`), since `node_modules` is itself excluded from file
 * collection. `resolveViaWorkspace()` already knows the package's real
 * directory (`info.dir`, from workspace *detection*, not a `node_modules`
 * lookup) — passing it here directly is what keeps the resolved path
 * inside the tree the graph actually tracks (issue #2288).
 */
export function resolveExportsViaDir(specifier: string, packageDir: string): string | null {
  const parsed = parseBareSpecifier(specifier);
  if (!parsed) return null;

  return resolveExportsInPackageDir(parsed, packageDir);
}

/**
 * Clear the package.json `exports` cache, in both this (TypeScript)
 * resolver and the native one if available — a long-lived process
 * (`codegraph watch`, the MCP server) can outlive edits to a package's
 * `exports` field, so watch mode's package.json-change detection calls
 * this to force a fresh manifest read (issue #2290). Also exported
 * directly for testing.
 */
export function clearExportsCache(): void {
  _exportsCache.clear();
  loadNative()?.clearExportsCache?.();
}

// ── Monorepo workspace resolution ───────────────────────────────────

/** Cache: rootDir → Map<packageName, { dir, entry }> */
const _workspaceCache: Map<string, Map<string, { dir: string; entry: string | null }>> = new Map();

/** Set of resolved relative paths that came from workspace resolution. */
const _workspaceResolvedPaths: Set<string> = new Set();

/**
 * Set the workspace map for a given rootDir.
 * Called by the build pipeline after detecting workspaces.
 */
export function setWorkspaces(
  rootDir: string,
  map: Map<string, { dir: string; entry: string | null }>,
): void {
  _workspaceCache.set(rootDir, map);
  _workspaceResolvedPaths.clear();
  _exportsCache.clear();
}

/**
 * Get workspace packages for a rootDir. Returns empty map if not set.
 */
function getWorkspaces(rootDir: string): Map<string, { dir: string; entry: string | null }> {
  return _workspaceCache.get(rootDir) || new Map();
}

/**
 * Convert the workspace map registered for `rootDir` into the array shape
 * the native FFI boundary expects (`resolve_import`/`resolve_imports` in
 * crates/codegraph-core/src/lib.rs). The native engine has no workspace
 * *detection* of its own — see `resolveViaWorkspace()`'s doc comment — so
 * every native resolve call must carry the already-detected map explicitly
 * (issue #1927).
 */
export function getWorkspacesForNative(rootDir: string): NativeWorkspacePackage[] {
  return [...getWorkspaces(rootDir).entries()].map(([packageName, info]) => ({
    packageName,
    dir: info.dir,
    entry: info.entry,
  }));
}

/**
 * Resolve a bare specifier through monorepo workspace packages.
 *
 * For "@myorg/utils" → finds the workspace package dir → resolves entry point.
 * For "@myorg/utils/sub" → finds package dir → tries exports field → filesystem probe.
 *
 * @returns Absolute path to resolved file, or null.
 */
export function resolveViaWorkspace(specifier: string, rootDir: string): string | null {
  const parsed = parseBareSpecifier(specifier);
  if (!parsed) return null;

  const workspaces = getWorkspaces(rootDir);
  if (workspaces.size === 0) return null;

  const info = workspaces.get(parsed.packageName);
  if (!info) return null;

  // Root import ("@myorg/utils") — use the entry point
  if (parsed.subpath === '.') {
    // Try exports field first, resolved against the workspace-detected real
    // directory (info.dir) rather than a node_modules walk — see
    // resolveExportsViaDir()'s doc comment (issue #2288).
    const exportsResult = resolveExportsViaDir(specifier, info.dir);
    if (exportsResult) return exportsResult;
    // Fall back to workspace entry
    return info.entry;
  }

  // Subpath import ("@myorg/utils/helpers") — try exports, then filesystem probe
  const exportsResult = resolveExportsViaDir(specifier, info.dir);
  if (exportsResult) return exportsResult;

  // Filesystem probe within the package directory
  const subRel = parsed.subpath.slice(2); // strip "./"
  const base = path.resolve(info.dir, subRel);
  for (const ext of [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '/index.ts',
    '/index.tsx',
    '/index.js',
  ]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }

  // Try src/ subdirectory (common monorepo convention)
  const srcBase = path.resolve(info.dir, 'src', subRel);
  for (const ext of [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '/index.ts',
    '/index.tsx',
    '/index.js',
  ]) {
    const candidate = srcBase + ext;
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Check if a resolved relative path was resolved via workspace detection.
 * Used by computeConfidence to assign high confidence (0.95) to workspace imports.
 */
export function isWorkspaceResolved(resolvedPath: string): boolean {
  return _workspaceResolvedPaths.has(resolvedPath);
}

/** Clear workspace caches (for testing). */
export function clearWorkspaceCache(): void {
  _workspaceCache.clear();
  _workspaceResolvedPaths.clear();
}

// ── JS → TS extension remap cache ───────────────────────────────────

/** Cache: absolute .js path → remapped .ts/.tsx relative path (or null if no TS file exists). */
const _jsToTsCache: Map<string, string | null> = new Map();

/**
 * If `resolved` ends with `.js`, check whether a `.ts` or `.tsx` counterpart
 * exists on disk and return its relative path from `rootDir`.  Results are
 * cached for the lifetime of the process to avoid repeated stat calls in the
 * batch hot path.
 *
 * The cache stores **absolute** `.ts`/`.tsx` paths (or `null`) so that the
 * same cached entry is correct regardless of which `rootDir` is passed — the
 * relative path is computed on every cache hit.  This is important for MCP
 * `--multi-repo` mode where the same absolute `.js` file may be resolved with
 * different `rootDir` values.
 *
 * Always returns a normalised relative path from `rootDir` — both the remap
 * branch and the fallback compute `path.relative(rootDir, abs)` to ensure a
 * consistent format regardless of whether the native resolver returned an
 * absolute or relative path.
 */
function remapJsToTs(resolved: string, rootDir: string): string {
  if (!resolved.endsWith('.js')) return resolved;
  const abs = path.resolve(rootDir, resolved);
  if (_jsToTsCache.has(abs)) {
    const cachedAbs = _jsToTsCache.get(abs);
    return cachedAbs
      ? normalizePath(path.relative(rootDir, cachedAbs))
      : normalizePath(path.relative(rootDir, abs));
  }
  const tsAbs = abs.replace(/\.js$/, '.ts');
  if (fs.existsSync(tsAbs)) {
    _jsToTsCache.set(abs, tsAbs);
    return normalizePath(path.relative(rootDir, tsAbs));
  }
  const tsxAbs = abs.replace(/\.js$/, '.tsx');
  if (fs.existsSync(tsxAbs)) {
    _jsToTsCache.set(abs, tsxAbs);
    return normalizePath(path.relative(rootDir, tsxAbs));
  }
  _jsToTsCache.set(abs, null);
  // Normalise fallback to relative to stay consistent with the remap branch —
  // avoids a format mismatch if the native resolver ever returns an absolute path.
  return normalizePath(path.relative(rootDir, abs));
}

/** Clear the .js → .ts remap cache (for testing). */
export function clearJsToTsCache(): void {
  _jsToTsCache.clear();
}

// ── Alias format conversion ─────────────────────────────────────────

/**
 * Convert JS alias format { baseUrl, paths: { pattern: [targets] } }
 * to native format { baseUrl, paths: [{ pattern, targets }] }.
 */
export function convertAliasesForNative(
  aliases: PathAliases | null | undefined,
): { baseUrl: string; paths: { pattern: string; targets: string[] }[] } | null {
  if (!aliases) return null;
  return {
    baseUrl: aliases.baseUrl || '',
    paths: Object.entries(aliases.paths || {}).map(([pattern, targets]) => ({
      pattern,
      targets,
    })),
  };
}

// ── JS fallback implementations ─────────────────────────────────────

function resolveViaAlias(
  importSource: string,
  aliases: PathAliases,
  _rootDir: string,
): string | null {
  if (aliases.baseUrl && !importSource.startsWith('.') && !importSource.startsWith('/')) {
    const candidate = path.resolve(aliases.baseUrl, importSource);
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      const full = candidate + ext;
      if (fs.existsSync(full)) return full;
    }
  }

  for (const [pattern, targets] of Object.entries(aliases.paths || {})) {
    const prefix = pattern.replace(/\*$/, '');
    if (!importSource.startsWith(prefix)) continue;
    const rest = importSource.slice(prefix.length);
    for (const target of targets) {
      const resolved = target.replace(/\*$/, rest);
      for (const ext of [
        '',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '/index.ts',
        '/index.tsx',
        '/index.js',
      ]) {
        const full = resolved + ext;
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return null;
}

// ── Rust `crate::`/`self::`/`super::` module-path resolution ────────

/**
 * True if `importSource` is a Rust path-qualified `use` path (`crate::...`,
 * `self::...`, or `super::...`) — the only import syntax Rust's module
 * system produces (Rust has no relative-import syntax). No other supported
 * language emits this exact `::`-delimited keyword-prefixed shape, so this
 * signal alone is enough to gate Rust-specific resolution without needing a
 * language/extension parameter threaded through resolveImportPathJS.
 */
function isRustQualifiedPath(importSource: string): boolean {
  return (
    importSource === 'crate' ||
    importSource.startsWith('crate::') ||
    importSource === 'self' ||
    importSource.startsWith('self::') ||
    importSource === 'super' ||
    importSource.startsWith('super::')
  );
}

/**
 * Directory where `file`'s own submodules would live, per Rust convention:
 * mod.rs/lib.rs/main.rs's submodules live in the same directory as the file
 * itself; any other foo.rs's submodules live in a sibling foo/ directory.
 */
function rustModuleDir(file: string): string {
  const base = path.basename(file, '.rs');
  const dir = path.dirname(file);
  if (base === 'mod' || base === 'lib' || base === 'main') return dir;
  return path.join(dir, base);
}

/**
 * Cargo directory names whose direct .rs children are each their own,
 * independent crate root — a separate binary/example/test/bench target,
 * never sharing a `crate::` module tree with `src/main.rs`/`src/lib.rs` or
 * with each other. `foo/main.rs` nested one level inside one of these
 * (a multi-file binary/example) is already handled by the ordinary
 * main.rs/lib.rs search below and doesn't need this special case.
 */
const CARGO_STANDALONE_TARGET_DIRS = new Set(['bin', 'examples', 'tests', 'benches']);

/**
 * Array-of-table keys in Cargo.toml whose entries may declare an explicit
 * `path = "..."` override to a custom target file (issue #2217) — each such
 * target compiles as its own independent crate, same as a conventional
 * `src/bin/foo.rs`.
 */
const CARGO_TARGET_ARRAY_KEYS = ['bin', 'example', 'test', 'bench'] as const;

/**
 * Cache: rootDir → set of absolute file paths that are independent Cargo
 * targets declared via an explicit Cargo.toml path override (issue #2217).
 * Populated lazily on first Rust crate-root lookup for a given rootDir —
 * scanning every Cargo.toml in the project is wasted work for non-Rust
 * projects and for repos with no path overrides at all.
 */
const _cargoTargetOverridesCache: Map<string, Set<string>> = new Map();

/**
 * Directories to skip while searching for Cargo.toml manifests — reuses the
 * project-wide IGNORE_DIRS plus `target` (Cargo's own build-output
 * directory, which isn't part of IGNORE_DIRS itself — see issue #2374 — but
 * which this Cargo-specific walk must never descend into regardless).
 */
const CARGO_MANIFEST_IGNORE_DIRS = new Set([...IGNORE_DIRS, 'target']);

/**
 * Find every Cargo.toml under rootDir. A Cargo workspace can have one at
 * the root plus one per member crate, and a target-path override always
 * resolves relative to the manifest that declares it, not to rootDir.
 */
function findCargoManifests(rootDir: string): string[] {
  const manifests: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      debug(`findCargoManifests: cannot read directory ${dir}: ${toErrorMessage(e)}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (CARGO_MANIFEST_IGNORE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name === 'Cargo.toml') {
        manifests.push(path.join(dir, entry.name));
      }
    }
  };
  walk(rootDir);
  return manifests;
}

/**
 * Parse a single Cargo.toml's `[[bin]]`/`[[example]]`/`[[test]]`/`[[bench]]`
 * sections for an explicit `path = "..."` field, returning each resolved
 * absolute file path. Malformed TOML or an unreadable file yields no
 * overrides rather than failing the whole resolution — this is a best-
 * effort enrichment, not a required input.
 */
function parseCargoTargetOverrides(manifestPath: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseToml(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    debug(`parseCargoTargetOverrides: failed to parse ${manifestPath}: ${toErrorMessage(e)}`);
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const manifestDir = path.dirname(manifestPath);
  const overrides: string[] = [];
  for (const key of CARGO_TARGET_ARRAY_KEYS) {
    const entries = (parsed as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const targetPath = (entry as Record<string, unknown> | null | undefined)?.path;
      if (typeof targetPath === 'string' && targetPath.length > 0) {
        overrides.push(path.join(manifestDir, ...targetPath.split('/')));
      }
    }
  }
  return overrides;
}

function getCargoTargetOverrides(rootDir: string): Set<string> {
  const cached = _cargoTargetOverridesCache.get(rootDir);
  if (cached) return cached;
  const overrides = new Set<string>();
  for (const manifest of findCargoManifests(rootDir)) {
    for (const target of parseCargoTargetOverrides(manifest)) {
      overrides.add(target);
    }
  }
  _cargoTargetOverridesCache.set(rootDir, overrides);
  return overrides;
}

/**
 * Clear the Cargo target-override cache, in both this (TypeScript) resolver
 * and the native one if available — a long-lived process (`codegraph
 * watch`, the MCP server) can outlive edits to Cargo.toml itself, so
 * `rebuildFile` calls this once per rebuild to force a fresh manifest scan
 * (issue #2217) — also exported directly for testing.
 */
export function clearCargoTargetOverridesCache(): void {
  _cargoTargetOverridesCache.clear();
  loadNative()?.clearCargoTargetOverridesCache?.();
}

/**
 * True if `file` is a standalone Cargo target root — either by an explicit
 * Cargo.toml `path = "..."` override at a non-conventional location (issue
 * #2217, checked first since an override is authoritative regardless of the
 * target's basename) or by directory convention (a `.rs` file directly
 * inside `src/bin/`, `examples/`, `tests/`, or `benches/`, not itself named
 * main.rs/lib.rs).
 */
function isRustCargoTargetRoot(file: string, rootDir: string): boolean {
  if (getCargoTargetOverrides(rootDir).has(file)) return true;
  const base = path.basename(file, '.rs');
  if (base === 'main' || base === 'lib' || base === 'mod') return false;
  return CARGO_STANDALONE_TARGET_DIRS.has(path.basename(path.dirname(file)));
}

/**
 * True if `knownFiles` contains `candidate` (an absolute path) — checking
 * both the absolute form (as populated by `ctx.allFiles` on the full-build
 * path and `getKnownFilesForIncremental` on the watch-mode path) and the
 * root-relative, forward-slash-normalized form (as stored in the `nodes`
 * table), mirroring the native resolver's `file_exists` dual check. Callers
 * of `resolveImportPath` are not required to agree on one convention, so
 * this must accept either.
 */
function knownFilesHasFile(knownFiles: Set<string>, candidate: string, rootDir: string): boolean {
  if (knownFiles.has(candidate)) return true;
  return knownFiles.has(normalizePath(path.relative(rootDir, candidate)));
}

/**
 * Find the crate-root .rs file whose directory is an ancestor of
 * `fromFile`, walking up from fromFile's directory and stopping at
 * `rootDir`. Returns the absolute path, or null if none is found among
 * `knownFiles` — scoping to the nearest ancestor crate root (rather than a
 * project-wide search) correctly handles a Cargo workspace with several
 * crates, each resolving `crate::` relative to its own root.
 *
 * A standalone Cargo target file (`src/bin/foo.rs`, `examples/foo.rs`,
 * `tests/foo.rs`, `benches/foo.rs`) is its own crate root regardless of
 * whatever `main.rs`/`lib.rs` exists elsewhere in the ancestor chain —
 * each such file compiles as an independent crate, so walking further up
 * would wrongly attribute its `crate::` paths to an unrelated crate.
 */
function findRustCrateRoot(
  fromFile: string,
  rootDir: string,
  knownFiles: Set<string>,
): string | null {
  if (isRustCargoTargetRoot(fromFile, rootDir)) return fromFile;
  let dir = path.dirname(fromFile);
  for (;;) {
    for (const name of ['main.rs', 'lib.rs']) {
      const candidate = path.join(dir, name);
      if (knownFilesHasFile(knownFiles, candidate, rootDir)) return candidate;
    }
    if (!dir.startsWith(rootDir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The file representing `file`'s parent module (one level up the module
 * tree), or null if `file` is already a crate root (including a standalone
 * Cargo target) or no parent file is known among `knownFiles`.
 */
function rustParentModuleFile(
  file: string,
  rootDir: string,
  knownFiles: Set<string>,
): string | null {
  const base = path.basename(file, '.rs');
  if (base === 'main' || base === 'lib' || isRustCargoTargetRoot(file, rootDir)) return null;
  const dir = path.dirname(file);
  const searchDir = base === 'mod' ? path.dirname(dir) : dir;

  for (const candidate of [`${searchDir}.rs`, path.join(searchDir, 'mod.rs')]) {
    if (knownFilesHasFile(knownFiles, candidate, rootDir)) return candidate;
  }
  for (const name of ['main.rs', 'lib.rs']) {
    const candidate = path.join(searchDir, name);
    if (knownFilesHasFile(knownFiles, candidate, rootDir)) return candidate;
  }
  return null;
}

/**
 * Walk `segments` (module-path components after the crate::/self::/super::
 * prefix) from `startDir`, treating each as a submodule file (`seg.rs` or
 * `seg/mod.rs`) if one exists among `knownFiles`. The final segment may
 * instead be a leaf item name (function/type/const) rather than a module —
 * if it doesn't match a real file, resolution stops one level early and
 * returns the last successfully resolved module file (mirroring how
 * `crate::service::build_service` resolves to service.rs even though
 * build_service itself has no file of its own — the Rust extractor's
 * single-item `use` shape appends the item name to `source`, while the
 * braced-list shape doesn't, so this must handle both).
 */
function walkRustModuleSegments(
  startDir: string,
  startFile: string,
  segments: string[],
  rootDir: string,
  knownFiles: Set<string>,
): string | null {
  let currentDir = startDir;
  let currentFile = startFile;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const fileCandidate = path.join(currentDir, `${seg}.rs`);
    const modCandidate = path.join(currentDir, seg, 'mod.rs');

    if (knownFilesHasFile(knownFiles, fileCandidate, rootDir)) {
      currentFile = fileCandidate;
      currentDir = path.join(currentDir, seg);
      continue;
    }
    if (knownFilesHasFile(knownFiles, modCandidate, rootDir)) {
      currentFile = modCandidate;
      currentDir = path.join(currentDir, seg);
      continue;
    }
    if (i === segments.length - 1) break;
    return null;
  }
  return currentFile;
}

/**
 * Resolve a Rust `use crate::a::b::c` / `self::a::b` / `super::a` path to
 * the real file that declares its target module (or, for the trailing
 * item-name case, the module file that item is declared in), by walking the
 * project's directory tree per Rust's module-file conventions (issue
 * #2007), including a Cargo.toml `[[bin]]`/`[[example]]`/`[[test]]`/
 * `[[bench]]` section declaring a target at a custom, non-conventional path
 * (issue #2217). Returns null (falls through to the bare-specifier
 * fallback) when no match is found — e.g. a `#[path]` attribute override,
 * which this convention-and-manifest-based, known-files-only resolver still
 * doesn't model.
 */
function resolveRustUsePath(
  fromFile: string,
  importSource: string,
  rootDir: string,
  knownFiles: Set<string>,
): string | null {
  const segments = importSource.split('::');
  if (segments.length === 0) return null;

  let startDir: string;
  let startFile: string;
  let rest: string[];

  if (segments[0] === 'crate') {
    const rootFile = findRustCrateRoot(fromFile, rootDir, knownFiles);
    if (!rootFile) return null;
    startDir = path.dirname(rootFile);
    startFile = rootFile;
    rest = segments.slice(1);
  } else if (segments[0] === 'self') {
    startDir = rustModuleDir(fromFile);
    startFile = fromFile;
    rest = segments.slice(1);
  } else if (segments[0] === 'super') {
    let cur = fromFile;
    let i = 0;
    while (i < segments.length && segments[i] === 'super') {
      const parent = rustParentModuleFile(cur, rootDir, knownFiles);
      if (!parent) return null;
      cur = parent;
      i++;
    }
    startDir = rustModuleDir(cur);
    startFile = cur;
    rest = segments.slice(i);
  } else {
    return null;
  }

  const resolved = walkRustModuleSegments(startDir, startFile, rest, rootDir, knownFiles);
  return resolved ? normalizePath(path.relative(rootDir, resolved)) : null;
}

// ── Python module-path resolution (#2387) ───────────────────────────────

/**
 * True if `file` is Python source. Both engines resolve Python imports by
 * module path rather than by filesystem path, so this gates the whole
 * Python branch of `resolveImportPathJS`.
 */
function isPythonFile(file: string): boolean {
  return file.endsWith('.py') || file.endsWith('.pyi');
}

/**
 * File-existence probe with the same semantics as the native resolver's
 * `file_exists`: consult `knownFiles` when the caller supplied one (accepting
 * either the absolute or the root-relative convention), and fall back to a
 * real filesystem check when it did not. Keeping the two engines on identical
 * semantics matters here — a probe that answered differently would make the
 * native and WASM graphs disagree about which imports resolve.
 */
function pythonCandidateExists(
  candidate: string,
  knownFiles: Set<string> | null,
  rootDir: string,
): boolean {
  if (knownFiles) return knownFilesHasFile(knownFiles, candidate, rootDir);
  return fs.existsSync(candidate);
}

/**
 * Extra import roots declared by `pyproject.toml`, as absolute directories.
 *
 * Layout conventions cover most projects (see `pythonPackageRoot`), but a
 * root that is neither the repo root nor derivable from `__init__.py`
 * placement can only be known from configuration — `pythonpath = ["src",
 * "scripts"]` being the case observed on `data-analytics-pipeline-svc`
 * (#2387), where `scripts/` is importable but contains no package marker.
 *
 * Best-effort: unreadable or malformed TOML contributes no roots rather than
 * failing resolution, matching `parseCargoTargetOverrides`'s precedent.
 */
function parsePyprojectImportRoots(rootDir: string): string[] {
  const manifest = path.join(rootDir, 'pyproject.toml');
  let parsed: unknown;
  try {
    parsed = parseToml(fs.readFileSync(manifest, 'utf8'));
  } catch (e) {
    debug(`parsePyprojectImportRoots: cannot read ${manifest}: ${toErrorMessage(e)}`);
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const tool = (parsed as Record<string, any>).tool;
  if (typeof tool !== 'object' || tool === null) return [];

  const roots: string[] = [];
  const addRoot = (value: unknown): void => {
    // `package-dir` maps an import prefix to a directory; only the directory
    // half is an import root. An empty-string value means "the repo root",
    // which is already probed unconditionally.
    if (typeof value === 'string' && value.length > 0) roots.push(path.join(rootDir, value));
  };

  // [tool.pytest.ini_options] pythonpath = ["src", "scripts"]
  const pythonpath = tool.pytest?.ini_options?.pythonpath;
  if (Array.isArray(pythonpath)) for (const entry of pythonpath) addRoot(entry);

  // [tool.setuptools] package-dir = { "" = "src" }
  const packageDir = tool.setuptools?.['package-dir'];
  if (typeof packageDir === 'object' && packageDir !== null) {
    for (const value of Object.values(packageDir)) addRoot(value);
  }

  // [tool.setuptools.packages.find] where = ["src"]
  const where = tool.setuptools?.packages?.find?.where;
  if (Array.isArray(where)) for (const entry of where) addRoot(entry);

  // [tool.poetry] packages = [{ include = "pipeline", from = "src" }]
  const poetryPackages = tool.poetry?.packages;
  if (Array.isArray(poetryPackages)) {
    for (const entry of poetryPackages) addRoot((entry as Record<string, unknown> | null)?.from);
  }

  return roots;
}

/**
 * Cache: rootDir → configured import roots. Populated lazily on the first
 * Python import resolved for a given rootDir, so non-Python projects never
 * pay for the manifest read.
 */
const _pythonConfiguredRootsCache: Map<string, string[]> = new Map();

function getPythonConfiguredRoots(rootDir: string): string[] {
  let roots = _pythonConfiguredRootsCache.get(rootDir);
  if (!roots) {
    roots = parsePyprojectImportRoots(rootDir);
    _pythonConfiguredRootsCache.set(rootDir, roots);
  }
  return roots;
}

/**
 * Clear the pyproject import-root cache, in both this (TypeScript) resolver
 * and the native one — a long-lived process (`codegraph watch`, the MCP
 * server) can outlive edits to pyproject.toml itself. Mirrors
 * `clearCargoTargetOverridesCache`; also exported directly for testing.
 */
export function clearPythonImportRootsCache(): void {
  _pythonConfiguredRootsCache.clear();
  _pythonPackageRootCache.clear();
  loadNative()?.clearPythonImportRootsCache?.();
}

/** Cache: file directory → its derived package root. */
const _pythonPackageRootCache: Map<string, string> = new Map();

/**
 * The directory an absolute Python import from `fromFile` resolves against,
 * derived from package layout: walk up from the file's own directory for as
 * long as each level is a package (contains `__init__.py`), and stop at the
 * first ancestor that is not.
 *
 * That ancestor is the directory that would be on `sys.path` at runtime, so
 * this handles the PyPA-endorsed "src layout" (`src/pipeline/…`, imported as
 * `from pipeline…`) and a flat layout with the same rule and no
 * configuration — the src-layout case being precisely what made
 * `data-analytics-pipeline-svc` resolve zero imports (#2387).
 *
 * Never walks above `rootDir`: a stray `__init__.py` at the repo root must
 * not send resolution outside the project.
 */
function pythonPackageRoot(
  fromFile: string,
  rootDir: string,
  knownFiles: Set<string> | null,
): string {
  const startDir = path.dirname(fromFile);
  const cached = _pythonPackageRootCache.get(startDir);
  if (cached !== undefined) return cached;

  let dir = startDir;
  for (;;) {
    if (dir === rootDir) break;
    if (!pythonCandidateExists(path.join(dir, '__init__.py'), knownFiles, rootDir)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _pythonPackageRootCache.set(startDir, dir);
  return dir;
}

/**
 * Candidate import roots for `fromFile`, most specific first: the layout-derived
 * package root, then the conventional `src/` directory, then the repo root,
 * then anything `pyproject.toml` declares.
 */
function pythonImportRoots(
  fromFile: string,
  rootDir: string,
  knownFiles: Set<string> | null,
): string[] {
  const roots = [pythonPackageRoot(fromFile, rootDir, knownFiles), path.join(rootDir, 'src')];
  roots.push(rootDir, ...getPythonConfiguredRoots(rootDir));
  return roots;
}

/**
 * Resolve dotted module `segments` beneath `baseDir` to the file that declares
 * that module: `a/b/c.py`, then the package form `a/b/c/__init__.py`, then the
 * stub `a/b/c.pyi`. Empty `segments` means the package itself (`from . import
 * x`), which only ever resolves to its `__init__.py`.
 *
 * Returns a root-relative path, or null when nothing matches — including when
 * a candidate would land outside `rootDir`, which a relative import with more
 * leading dots than there are package levels can otherwise do.
 */
function resolvePythonModuleUnder(
  baseDir: string,
  segments: string[],
  rootDir: string,
  knownFiles: Set<string> | null,
): string | null {
  const target = segments.length > 0 ? path.join(baseDir, ...segments) : baseDir;
  const candidates =
    segments.length > 0
      ? [`${target}.py`, path.join(target, '__init__.py'), `${target}.pyi`]
      : [path.join(target, '__init__.py')];
  for (const candidate of candidates) {
    if (!pythonCandidateExists(candidate, knownFiles, rootDir)) continue;
    const rel = normalizePath(path.relative(rootDir, candidate));
    if (rel.startsWith('..')) continue;
    return rel;
  }
  return null;
}

/**
 * Resolve a Python `import a.b.c` / `from a.b import c` / `from .. import c`
 * module path to the file that declares it (#2387).
 *
 * Returns null for anything not found under a project import root — standard
 * library and third-party modules included — so the caller falls through to
 * the bare-specifier behaviour that treats them as external.
 */
function resolvePythonImportPath(
  fromFile: string,
  importSource: string,
  rootDir: string,
  knownFiles: Set<string> | null,
): string | null {
  let dots = 0;
  while (dots < importSource.length && importSource[dots] === '.') dots++;

  if (dots > 0) {
    // Relative import: one dot is the current package, each extra dot climbs
    // one level further up before the remaining segments are walked down.
    const rest = importSource.slice(dots);
    let dir = path.dirname(fromFile);
    for (let i = 1; i < dots; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    const segments = rest.length > 0 ? rest.split('.') : [];
    return resolvePythonModuleUnder(dir, segments, rootDir, knownFiles);
  }

  const segments = importSource.split('.');
  if (segments.some((s) => s.length === 0)) return null;
  for (const root of pythonImportRoots(fromFile, rootDir, knownFiles)) {
    const resolved = resolvePythonModuleUnder(root, segments, rootDir, knownFiles);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Resolve `from <source> import <name>` where `name` is itself a submodule
 * rather than a symbol (`from pipeline.stages import extract`) — Python's two
 * readings of that statement are indistinguishable without knowing which
 * files exist, so this is decided here rather than in the extractor.
 *
 * Returns the submodule's root-relative path, or null when `name` is an
 * ordinary symbol declared inside the source module.
 */
export function resolvePythonSubmodule(
  fromFile: string,
  importSource: string,
  name: string,
  rootDir: string,
  knownFiles?: readonly string[] | null,
): string | null {
  if (!isPythonFile(fromFile) || name === '*') return null;
  const combined = importSource.endsWith('.')
    ? `${importSource}${name}`
    : `${importSource}.${name}`;
  return resolvePythonImportPath(fromFile, combined, rootDir, toKnownFilesSet(knownFiles));
}

/** Cache: knownFiles array identity → Set, so repeated resolutions against
 * the same project file list (e.g. every Rust `use` statement in a build)
 * don't each rebuild the Set from scratch. */
const _knownFilesSetCache = new WeakMap<readonly string[], Set<string>>();

function toKnownFilesSet(knownFiles: readonly string[] | null | undefined): Set<string> | null {
  if (!knownFiles) return null;
  let set = _knownFilesSetCache.get(knownFiles);
  if (!set) {
    set = new Set(knownFiles);
    _knownFilesSetCache.set(knownFiles, set);
  }
  return set;
}

function resolveImportPathJS(
  fromFile: string,
  importSource: string,
  rootDir: string,
  aliases: PathAliases | null,
  knownFiles?: readonly string[] | null,
): string {
  // Python resolves by module path, not filesystem path, in both the absolute
  // (`import a.b.c`) and relative (`from ..pkg import x`) forms — the latter
  // shares JS's leading-dot spelling but means "climb the package tree", not
  // "a path relative to this directory", so this must run before the generic
  // relative branch below ever sees it (#2387).
  if (isPythonFile(fromFile)) {
    const pyResolved = resolvePythonImportPath(
      fromFile,
      importSource,
      rootDir,
      toKnownFilesSet(knownFiles),
    );
    if (pyResolved) return pyResolved;
  }
  if (!importSource.startsWith('.') && aliases) {
    const aliasResolved = resolveViaAlias(importSource, aliases, rootDir);
    if (aliasResolved) return normalizePath(path.relative(rootDir, aliasResolved));
  }
  if (!importSource.startsWith('.')) {
    if (isRustQualifiedPath(importSource) && fromFile.endsWith('.rs')) {
      const knownFilesSet = toKnownFilesSet(knownFiles);
      if (knownFilesSet) {
        const rustResolved = resolveRustUsePath(fromFile, importSource, rootDir, knownFilesSet);
        if (rustResolved) return rustResolved;
      }
    }
    // Workspace packages take priority over node_modules
    const wsResolved = resolveViaWorkspace(importSource, rootDir);
    if (wsResolved) {
      const rel = normalizePath(path.relative(rootDir, wsResolved));
      _workspaceResolvedPaths.add(rel);
      return rel;
    }
    const exportsResolved = resolveViaExports(importSource, rootDir);
    if (exportsResolved) return normalizePath(path.relative(rootDir, exportsResolved));
    return importSource;
  }
  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, importSource);

  if (resolved.endsWith('.js')) {
    const tsCandidate = resolved.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsCandidate)) return normalizePath(path.relative(rootDir, tsCandidate));
    const tsxCandidate = resolved.replace(/\.js$/, '.tsx');
    if (fs.existsSync(tsxCandidate)) return normalizePath(path.relative(rootDir, tsxCandidate));
  }

  for (const ext of [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.py',
    '.pyi',
    '/index.ts',
    '/index.tsx',
    '/index.js',
    '/__init__.py',
  ]) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      return normalizePath(path.relative(rootDir, candidate));
    }
  }
  if (fs.existsSync(resolved)) return normalizePath(path.relative(rootDir, resolved));
  return normalizePath(path.relative(rootDir, resolved));
}

/** All ancestor directories of `dir`, starting with `dir` itself, walking up to the root. */
function ancestorChain(dir: string): string[] {
  const chain = [dir];
  let cur = dir;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return chain; // reached root ('.', '/', or a drive root)
    chain.push(parent);
    cur = parent;
  }
}

/**
 * Directory-tree distance between two directories: hops up from `a` to the
 * nearest ancestor shared with `b`, plus hops down from there to `b`.
 *
 * Symmetric and depth-independent — unlike a fixed-depth equality check
 * (e.g. comparing `dirname(dirname(a))` to `dirname(dirname(b))`, as this
 * function used to), this correctly scores both sibling directories (common
 * parent) and direct ancestor/descendant directories (one nested inside the
 * other) regardless of how deep either path is. The fixed-depth check only
 * matched when both files sat at the *same* depth, so e.g. a file in
 * `graph/algorithms/*.ts` calling a method declared in the shallower
 * `graph/model.ts` was scored as maximally distant (issue #1769).
 */
// directoryDistance is on the hot path for every call-edge confidence score
// (computeConfidence runs per candidate during ranking/filtering, not just
// once per emitted edge — see call-resolver.ts, resolver/strategy.ts,
// stages/build-edges.ts). The same directory pairs recur constantly across a
// build, so memoizing avoids rebuilding both ancestor chains and the lookup
// map on every call. distance(a, b) === distance(b, a) (symmetric tree
// distance), so the key is order-independent to halve the effective cache
// size. Never cleared: purely a function of two path strings, so a stale
// entry can't exist, and even a large repo's directory count keeps this
// bounded (#1769 perf regression — see PR discussion).
const directoryDistanceCache = new Map<string, number>();

function directoryDistance(a: string, b: string): number {
  const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
  const cached = directoryDistanceCache.get(key);
  if (cached !== undefined) return cached;

  const chainA = ancestorChain(a);
  const chainB = ancestorChain(b);
  const indexInB = new Map<string, number>(chainB.map((d, idx) => [d, idx]));
  let dist = Infinity;
  for (let i = 0; i < chainA.length; i++) {
    const j = indexInB.get(chainA[i]!);
    if (j !== undefined) {
      dist = i + j;
      break;
    }
  }
  directoryDistanceCache.set(key, dist);
  return dist;
}

// ── Language-family scoping for global-by-name fallback resolution ─────────

/**
 * LANGUAGE_REGISTRY ids that must be treated as one family for cross-file
 * call resolution. TypeScript/TSX compile to and interoperate directly with
 * JavaScript — a `.ts` file routinely imports from and calls into a `.js`
 * file and vice versa (this codebase's own `src/` tree does this
 * throughout) — despite being three separate grammar entries in
 * LANGUAGE_REGISTRY. Every other registry id keeps its own family, which
 * preserves LANGUAGE_REGISTRY's existing per-language extension groupings
 * (e.g. C's `.c`+`.h`, C++'s `.cpp`/`.cc`/`.cxx`/`.hpp`).
 */
const JS_FAMILY_REGISTRY_IDS = new Set(['javascript', 'typescript', 'tsx']);

/**
 * Extensions excluded from the family map entirely, so `languageFamily`
 * returns null for them and they fall through to the ambiguous-extension
 * path (ordinary distance-based scoring, never rejected outright).
 *
 * `.h` is real-world ambiguous between C and C++: LANGUAGE_REGISTRY assigns
 * it to the `c` entry alone (grammar selection needs one canonical parser),
 * but the extremely common case of a `.cpp` file calling into its own
 * project's `.h` header would otherwise be misclassified as cross-language
 * and rejected outright (confidence 0) — a real regression from the
 * pre-#1783 same-directory score of 0.7 (Greptile review). Treating `.h` as
 * ambiguous — like an unrecognised extension — keeps the C/C++-header case
 * working without merging C and C++ source-file families wholesale (`.c`
 * vs `.cpp` intentionally do NOT merge — see
 * is_same_language_family_does_not_merge_c_and_cpp).
 */
const AMBIGUOUS_EXTENSIONS = new Set(['.h']);

/**
 * extension → language-family lookup, derived from LANGUAGE_REGISTRY (the
 * single source of truth for language definitions) so newly-added languages
 * are automatically covered without a second hand-maintained extension list.
 */
const _extToLanguageFamily: Map<string, string> = new Map();
for (const entry of LANGUAGE_REGISTRY) {
  const family = JS_FAMILY_REGISTRY_IDS.has(entry.id) ? 'javascript' : entry.id;
  for (const ext of entry.extensions) {
    if (AMBIGUOUS_EXTENSIONS.has(ext)) continue;
    _extToLanguageFamily.set(ext, family);
  }
}

/**
 * Resolve a file's coarse language family from its extension. Returns null
 * for extensionless or unrecognised files so ambiguous cases fall through to
 * ordinary distance-based scoring rather than being rejected outright.
 */
function languageFamily(file: string): string | null {
  const dot = file.lastIndexOf('.');
  if (dot === -1) return null;
  return _extToLanguageFamily.get(file.slice(dot).toLowerCase()) ?? null;
}

/**
 * True when `fileA` and `fileB` belong to the same language family, or when
 * either extension is unrecognised (ambiguous cases are not rejected — they
 * fall through to normal scoring). False only when both extensions are
 * recognised AND resolve to different families.
 *
 * Guards the global-by-name call-resolution fallback against matching a
 * same-named symbol across unrelated languages — e.g. a Ruby file's bare
 * `load` call has no static relationship to a same-named `load` export in a
 * JS file, even when both happen to live in the same directory (issue
 * #1783). This codebase has no cross-language static-call mechanism its
 * resolvers legitimately model (the `dead-ffi` role classifier only
 * suppresses false dead-code flags for compiled-language files consumed via
 * FFI — it never creates call edges), so rejecting cross-family candidates
 * is a strict precision improvement with no legitimate resolution to
 * regress.
 */
export function isSameLanguageFamily(fileA: string, fileB: string): boolean {
  const famA = languageFamily(fileA);
  const famB = languageFamily(fileB);
  if (!famA || !famB) return true;
  return famA === famB;
}

function computeConfidenceJS(
  callerFile: string,
  targetFile: string,
  importedFrom: string | null,
): number {
  if (!targetFile || !callerFile) return 0.3;
  if (callerFile === targetFile) return 1.0;
  if (importedFrom === targetFile) return 1.0;
  // Workspace-resolved imports get high confidence even across package boundaries
  if (importedFrom && _workspaceResolvedPaths.has(importedFrom)) return 0.95;
  // Cross-language candidates are never legitimate call targets (#1783) — reject
  // before scoring proximity so a same-directory, same-named symbol in an
  // unrelated language can never pass the resolver's 0.5 confidence threshold.
  if (!isSameLanguageFamily(callerFile, targetFile)) return 0;
  const dist = directoryDistance(path.dirname(callerFile), path.dirname(targetFile));
  if (dist === 0) return 0.7; // same directory
  if (dist === 1) return 0.6; // direct parent/child directory
  if (dist === 2) return 0.5; // sibling directories, or a grandparent/grandchild pair
  return 0.3;
}

// ── Public API with native dispatch ─────────────────────────────────

/**
 * Resolve a single import path.
 * Tries native, falls back to JS.
 */
export function resolveImportPath(
  fromFile: string,
  importSource: string,
  rootDir: string,
  aliases: PathAliases | null,
  knownFiles?: readonly string[] | null,
): string {
  const native = loadNative();
  if (native) {
    try {
      const result = native.resolveImport(
        fromFile,
        importSource,
        rootDir,
        convertAliasesForNative(aliases),
        getWorkspacesForNative(rootDir),
        knownFiles || null,
      );
      const normalized = normalizePath(path.normalize(result));
      // The native resolver's .js → .ts remap fails when paths contain
      // unresolved ".." components (PathBuf::components().collect() doesn't
      // collapse parent refs). Apply the remap on the JS side as a fallback.
      return remapJsToTs(normalized, rootDir);
    } catch (e) {
      debug(
        `resolveImportPath: native resolution failed, falling back to JS: ${toErrorMessage(e)}`,
      );
    }
  }
  return resolveImportPathJS(fromFile, importSource, rootDir, aliases, knownFiles);
}

/**
 * Compute proximity-based confidence for call resolution.
 * Tries native, falls back to JS.
 */
export function computeConfidence(
  callerFile: string,
  targetFile: string,
  importedFrom: string | null,
): number {
  const native = loadNative();
  if (native) {
    try {
      return native.computeConfidence(callerFile, targetFile, importedFrom || null);
    } catch (e) {
      debug(
        `computeConfidence: native computation failed, falling back to JS: ${toErrorMessage(e)}`,
      );
    }
  }
  return computeConfidenceJS(callerFile, targetFile, importedFrom);
}

/**
 * Batch resolve multiple imports in a single native call.
 * Returns Map<"fromFile|importSource", resolvedPath> or null when native unavailable.
 */
export function resolveImportsBatch(
  inputs: ImportBatchItem[],
  rootDir: string,
  aliases: PathAliases | null,
  knownFiles?: string[] | null,
): BatchResolvedMap | null {
  const native = loadNative();
  if (!native) return null;

  try {
    const nativeInputs = inputs.map(({ fromFile, importSource }) => ({
      fromFile,
      importSource,
    }));
    const results = native.resolveImports(
      nativeInputs,
      rootDir,
      convertAliasesForNative(aliases),
      knownFiles || null,
      getWorkspacesForNative(rootDir),
    );
    const map: BatchResolvedMap = new Map();
    for (const r of results) {
      const normalized = normalizePath(path.normalize(r.resolvedPath));
      // Native resolver's .js → .ts remap fails on unnormalized paths —
      // apply JS-side fallback (same fix as resolveImportPath).
      const resolved = remapJsToTs(normalized, rootDir);
      map.set(`${normalizePath(r.fromFile)}|${r.importSource}`, resolved);
    }
    return map;
  } catch (e) {
    debug(`batchResolve: native batch resolution failed: ${toErrorMessage(e)}`);
    return null;
  }
}

// ── Exported for testing ────────────────────────────────────────────

export { computeConfidenceJS, resolveImportPathJS };
