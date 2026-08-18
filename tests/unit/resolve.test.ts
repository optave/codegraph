/**
 * Unit tests for src/resolve.js
 *
 * Tests resolveImportPathJS, computeConfidenceJS, and convertAliasesForNative.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  clearCargoTargetOverridesCache,
  clearExportsCache,
  clearJsToTsCache,
  clearPythonImportRootsCache,
  clearWorkspaceCache,
  computeConfidence,
  computeConfidenceJS,
  convertAliasesForNative,
  isSameLanguageFamily,
  isWorkspaceResolved,
  parseBareSpecifier,
  resolveImportPathJS,
  resolveImportsBatch,
  resolvePyprojectScriptEntrypoints,
  resolvePythonSubmodule,
  resolveViaExports,
  resolveViaWorkspace,
  setWorkspaces,
} from '../../src/domain/graph/resolve.js';
import { normalizePath } from '../../src/shared/constants.js';

// ─── Temp project setup ──────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-'));

  // Create file structure:
  //   src/math.js
  //   src/math.ts     (for .js -> .ts remap)
  //   src/utils.tsx
  //   src/lib/index.js (for directory index resolution)
  //   src/lib/helper.ts
  //   shared/core.ts   (for alias resolution)
  //   src/esm/util.mts (for .mjs -> .mts remap, #2299)
  //   src/cjs/legacy.cts (for .cjs -> .cts remap, #2299)
  fs.mkdirSync(path.join(tmpDir, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src', 'esm'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src', 'cjs'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });

  fs.writeFileSync(path.join(tmpDir, 'src', 'math.js'), 'export const add = (a, b) => a + b;');
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'math.ts'),
    'export const add = (a: number, b: number) => a + b;',
  );
  fs.writeFileSync(path.join(tmpDir, 'src', 'utils.tsx'), 'export const Comp = () => <div/>;');
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'lib', 'index.js'),
    'export { helper } from "./helper";',
  );
  fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'helper.ts'), 'export function helper() {}');
  fs.writeFileSync(path.join(tmpDir, 'shared', 'core.ts'), 'export const x = 1;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'esm', 'util.mts'), 'export const greet = () => "hi";');
  fs.writeFileSync(path.join(tmpDir, 'src', 'cjs', 'legacy.cts'), 'export const x = 1;');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  clearJsToTsCache();
});

// ─── resolveImportPathJS ────────────────────────────────────────────

describe('resolveImportPathJS', () => {
  it('resolves relative ./math to .js extension', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, './math', tmpDir, null);
    expect(result).toContain('src/math');
    expect(result).toMatch(/\.ts$/);
  });

  it('resolves .js import to .ts file when .ts exists', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, './math.js', tmpDir, null);
    expect(result).toMatch(/math\.ts$/);
  });

  it('resolves .js import to .tsx when .tsx exists', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, './utils', tmpDir, null);
    expect(result).toMatch(/utils\.tsx$/);
  });

  it('resolves .mjs import to .mts file when .mts exists (#2299)', () => {
    // TypeScript's NodeNext/Node16 module resolution requires the *emitted*
    // extension in relative specifiers: a .mts source is imported via .mjs,
    // not .mts — mirroring the .js -> .ts remap above for the same reason.
    const fromFile = path.join(tmpDir, 'src', 'esm', 'index.mts');
    const result = resolveImportPathJS(fromFile, './util.mjs', tmpDir, null);
    expect(result).toMatch(/util\.mts$/);
  });

  it('resolves .cjs import to .cts file when .cts exists (#2299)', () => {
    const fromFile = path.join(tmpDir, 'src', 'cjs', 'index.cts');
    const result = resolveImportPathJS(fromFile, './legacy.cjs', tmpDir, null);
    expect(result).toMatch(/legacy\.cts$/);
  });

  it('resolves an extension-less specifier to a .mts file (#2464)', () => {
    // Distinct from the #2299 remap tests above: `./util` here carries no
    // extension at all, unlike `./util.mjs`, so it exercises the
    // extension-probing loop directly instead of EMIT_EXTENSION_REMAPS.
    const fromFile = path.join(tmpDir, 'src', 'esm', 'index.mts');
    const result = resolveImportPathJS(fromFile, './util', tmpDir, null);
    expect(result).toMatch(/util\.mts$/);
  });

  it('resolves an extension-less specifier to a .cts file (#2464)', () => {
    const fromFile = path.join(tmpDir, 'src', 'cjs', 'index.cts');
    const result = resolveImportPathJS(fromFile, './legacy', tmpDir, null);
    expect(result).toMatch(/legacy\.cts$/);
  });

  it('resolves directory to index.js', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, './lib', tmpDir, null);
    expect(result).toContain('lib/index.js');
  });

  it('passes through bare specifiers', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, 'lodash', tmpDir, null);
    expect(result).toBe('lodash');
  });

  it('resolves via baseUrl alias', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const aliases = {
      baseUrl: tmpDir,
      paths: {},
    };
    const result = resolveImportPathJS(fromFile, 'shared/core', tmpDir, aliases);
    expect(result).toContain('shared/core');
    expect(result).toMatch(/\.ts$/);
  });

  it('resolves via path alias pattern', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const aliases = {
      baseUrl: null,
      paths: {
        '@shared/*': [path.join(tmpDir, 'shared', '*')],
      },
    };
    const result = resolveImportPathJS(fromFile, '@shared/core', tmpDir, aliases);
    expect(result).toContain('shared/core');
  });

  it('falls through when alias does not match', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const aliases = {
      baseUrl: null,
      paths: {
        '@other/*': [path.join(tmpDir, 'other', '*')],
      },
    };
    const result = resolveImportPathJS(fromFile, 'lodash', tmpDir, aliases);
    expect(result).toBe('lodash');
  });
});

// ─── computeConfidenceJS ────────────────────────────────────────────

describe('computeConfidenceJS', () => {
  it('returns max confidence for same-file calls', () => {
    expect(computeConfidenceJS('src/a.js', 'src/a.js', undefined)).toBe(1.0);
  });

  it('returns max confidence when importedFrom matches target', () => {
    expect(computeConfidenceJS('src/a.js', 'src/b.js', 'src/b.js')).toBe(1.0);
  });

  it('returns higher confidence for same-directory than distant files', () => {
    const sameDir = computeConfidenceJS('src/a.js', 'src/b.js', undefined);
    const distant = computeConfidenceJS('src/deep/nested/a.js', 'lib/other/b.js', undefined);
    expect(sameDir).toBeGreaterThan(distant);
    expect(sameDir).toBeGreaterThan(0.5);
    expect(sameDir).toBeLessThanOrEqual(1.0);
  });

  it('returns higher confidence for sibling parents than distant files', () => {
    const siblingParent = computeConfidenceJS('src/foo/a.js', 'src/bar/b.js', undefined);
    const distant = computeConfidenceJS('src/deep/nested/a.js', 'lib/other/b.js', undefined);
    expect(siblingParent).toBeGreaterThan(distant);
  });

  it('returns lowest confidence for distant files', () => {
    const distant = computeConfidenceJS('src/deep/nested/a.js', 'lib/other/b.js', undefined);
    expect(distant).toBeGreaterThan(0);
    expect(distant).toBeLessThan(0.5);
  });

  it('returns low confidence when callerFile is null', () => {
    const result = computeConfidenceJS(null, 'src/b.js', undefined);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.5);
  });

  it('returns low confidence when targetFile is null', () => {
    const result = computeConfidenceJS('src/a.js', null, undefined);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.5);
  });

  it('confidence decreases with distance: same-dir > sibling-parent > distant', () => {
    const sameDir = computeConfidenceJS('src/a.js', 'src/b.js', undefined);
    const siblingParent = computeConfidenceJS('src/foo/a.js', 'src/bar/b.js', undefined);
    const distant = computeConfidenceJS('src/deep/nested/a.js', 'lib/other/b.js', undefined);
    expect(sameDir).toBeGreaterThan(siblingParent);
    expect(siblingParent).toBeGreaterThan(distant);
  });

  // Regression tests for #1769: a fixed-depth "grandparent equality" check used
  // to compare `dirname(dirname(callerFile))` to `dirname(dirname(targetFile))`,
  // which only matched when both files sat at the *same* depth. A file in a
  // subdirectory calling a method declared in its direct parent directory
  // (e.g. `graph/algorithms/bfs.ts` calling `graph/model.ts`) was scored as
  // maximally distant (0.3) purely because the two files were nested at
  // different depths — well below the 0.5 threshold used by the call-edge
  // resolver's typed-method lookup, silently dropping the call edge.
  describe('directory-nesting distance (#1769)', () => {
    it('scores a direct parent/child directory pair above the 0.5 resolver threshold', () => {
      // caller one level deeper than target — the exact bfs.ts -> model.ts shape.
      const conf = computeConfidenceJS(
        'src/graph/algorithms/bfs.ts',
        'src/graph/model.ts',
        undefined,
      );
      expect(conf).toBeGreaterThanOrEqual(0.5);
    });

    it('is symmetric: target one level deeper than caller scores the same as the reverse', () => {
      const callerDeeper = computeConfidenceJS(
        'src/graph/algorithms/bfs.ts',
        'src/graph/model.ts',
        undefined,
      );
      const targetDeeper = computeConfidenceJS(
        'src/graph/model.ts',
        'src/graph/algorithms/bfs.ts',
        undefined,
      );
      expect(targetDeeper).toBe(callerDeeper);
    });

    it('ranks direct parent/child nesting strictly between same-directory and sibling-directory', () => {
      const sameDir = computeConfidenceJS('src/graph/a.ts', 'src/graph/b.ts', undefined);
      const parentChild = computeConfidenceJS(
        'src/graph/algorithms/bfs.ts',
        'src/graph/model.ts',
        undefined,
      );
      // True siblings: both one level below `src`, at equal depth.
      const sibling = computeConfidenceJS('src/graph/a.ts', 'src/features/b.ts', undefined);
      expect(sameDir).toBeGreaterThan(parentChild);
      expect(parentChild).toBeGreaterThan(sibling);
    });

    it('scores a two-level-deep subdirectory calling into its grandparent at or above the sibling tier', () => {
      // the graph/algorithms/leiden/*.ts -> graph/model.ts shape from #1769.
      const conf = computeConfidenceJS(
        'src/graph/algorithms/leiden/cpm.ts',
        'src/graph/model.ts',
        undefined,
      );
      expect(conf).toBeGreaterThanOrEqual(0.5);
    });

    it('still scores unrelated deeply-nested files as distant', () => {
      const conf = computeConfidenceJS(
        'src/graph/algorithms/leiden/cpm.ts',
        'src/mcp/server.ts',
        undefined,
      );
      expect(conf).toBeLessThan(0.5);
    });
  });
});

// ─── computeConfidence (public API, dispatches to native or JS) ─────

describe('computeConfidence', () => {
  it('returns numeric confidence for same file', () => {
    const conf = computeConfidence('src/a.js', 'src/a.js', undefined);
    expect(conf).toBe(1.0);
  });
});

// ─── convertAliasesForNative ─────────────────────────────────────────

describe('convertAliasesForNative', () => {
  it('returns null for null input', () => {
    expect(convertAliasesForNative(null)).toBeNull();
  });

  it('converts JS alias format to native format', () => {
    const result = convertAliasesForNative({
      baseUrl: '/root',
      paths: { '@/*': ['src/*'] },
    });
    expect(result).toEqual({
      baseUrl: '/root',
      paths: [{ pattern: '@/*', targets: ['src/*'] }],
    });
  });

  it('handles missing baseUrl and paths', () => {
    const result = convertAliasesForNative({});
    expect(result).toEqual({ baseUrl: '', paths: [] });
  });
});

// ─── resolveImportsBatch ─────────────────────────────────────────────

describe('resolveImportsBatch', () => {
  it('returns null when native is not available (or a Map when it is)', () => {
    const result = resolveImportsBatch(
      [{ fromFile: path.join(tmpDir, 'src', 'index.js'), importSource: './math' }],
      tmpDir,
      null,
    );
    // native may or may not be available
    expect(result === null || result instanceof Map).toBe(true);
  });

  it('remaps .js → .ts in batch results when .ts file exists', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportsBatch([{ fromFile, importSource: './math.js' }], tmpDir, null);
    // Skip when native addon is not available
    if (result === null) return;
    const key = `${normalizePath(fromFile)}|./math.js`;
    const resolved = result.get(key);
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(/math\.ts$/);
  });
});

// ─── parseBareSpecifier ──────────────────────────────────────────────

describe('parseBareSpecifier', () => {
  it('parses plain package with no subpath', () => {
    expect(parseBareSpecifier('lodash')).toEqual({ packageName: 'lodash', subpath: '.' });
  });

  it('parses plain package with subpath', () => {
    expect(parseBareSpecifier('lodash/fp')).toEqual({ packageName: 'lodash', subpath: './fp' });
  });

  it('parses scoped package with no subpath', () => {
    expect(parseBareSpecifier('@scope/pkg')).toEqual({ packageName: '@scope/pkg', subpath: '.' });
  });

  it('parses scoped package with subpath', () => {
    expect(parseBareSpecifier('@scope/pkg/utils/deep')).toEqual({
      packageName: '@scope/pkg',
      subpath: './utils/deep',
    });
  });

  it('returns null for bare @ with no slash', () => {
    expect(parseBareSpecifier('@scope')).toBeNull();
  });
});

// ─── resolveViaExports ───────────────────────────────────────────────

describe('resolveViaExports', () => {
  let pkgRoot: string;

  beforeAll(() => {
    clearExportsCache();
    // Create a fake node_modules structure inside tmpDir
    pkgRoot = path.join(tmpDir, 'node_modules', 'test-pkg');
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, 'lib', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'index.mjs'), 'export default 1;');
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'index.cjs'), 'module.exports = 1;');
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'helpers.mjs'), 'export const h = 1;');
    fs.writeFileSync(path.join(pkgRoot, 'lib', 'utils', 'deep.js'), 'export const d = 1;');
  });

  afterEach(() => {
    clearExportsCache();
  });

  it('resolves string exports (shorthand)', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'test-pkg', exports: './dist/index.mjs' }),
    );
    const result = resolveViaExports('test-pkg', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'index.mjs'));
  });

  it('returns null for subpath when exports is a string', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'test-pkg', exports: './dist/index.mjs' }),
    );
    expect(resolveViaExports('test-pkg/helpers', tmpDir)).toBeNull();
  });

  it('resolves conditional exports (import/require/default)', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          '.': { import: './dist/index.mjs', require: './dist/index.cjs' },
        },
      }),
    );
    const result = resolveViaExports('test-pkg', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'index.mjs'));
  });

  it('falls back to require when import is absent', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          '.': { require: './dist/index.cjs' },
        },
      }),
    );
    const result = resolveViaExports('test-pkg', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'index.cjs'));
  });

  it('resolves subpath exports', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          '.': './dist/index.mjs',
          './helpers': './dist/helpers.mjs',
        },
      }),
    );
    const result = resolveViaExports('test-pkg/helpers', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'helpers.mjs'));
  });

  it('resolves subpath patterns with wildcard', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          '.': './dist/index.mjs',
          './lib/*': './lib/*.js',
        },
      }),
    );
    const result = resolveViaExports('test-pkg/lib/utils/deep', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'lib', 'utils', 'deep.js'));
  });

  it('resolves conditional subpath exports', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          './helpers': { import: './dist/helpers.mjs', default: './dist/helpers.mjs' },
        },
      }),
    );
    const result = resolveViaExports('test-pkg/helpers', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'helpers.mjs'));
  });

  it('resolves top-level conditions object (no . keys)', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: { import: './dist/index.mjs', require: './dist/index.cjs' },
      }),
    );
    const result = resolveViaExports('test-pkg', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'index.mjs'));
  });

  it('returns null when exports field is absent', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'test-pkg', main: './dist/index.mjs' }),
    );
    expect(resolveViaExports('test-pkg', tmpDir)).toBeNull();
  });

  it('returns null when package is not in node_modules', () => {
    expect(resolveViaExports('nonexistent-pkg', tmpDir)).toBeNull();
  });
});

// ─── resolveImportPathJS with exports ────────────────────────────────

describe('resolveImportPathJS with package.json exports', () => {
  let pkgRoot: string;

  beforeAll(() => {
    clearExportsCache();
    pkgRoot = path.join(tmpDir, 'node_modules', 'exports-pkg');
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'main.mjs'), 'export default 1;');
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'exports-pkg',
        exports: { '.': './dist/main.mjs' },
      }),
    );
  });

  afterEach(() => {
    clearExportsCache();
  });

  it('resolves bare specifier through exports field', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, 'exports-pkg', tmpDir, null);
    expect(result).toContain('node_modules/exports-pkg/dist/main.mjs');
  });

  it('still passes through bare specifiers without exports', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, 'lodash', tmpDir, null);
    expect(result).toBe('lodash');
  });
});

// ─── resolveViaWorkspace ─────────────────────────────────────────────

describe('resolveViaWorkspace', () => {
  let wsRoot: string;

  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ws-'));
    // Create a monorepo structure:
    //   packages/core/src/index.js
    //   packages/core/src/helpers.js
    //   packages/core/package.json  { name: "@myorg/core", main: "./src/index.js" }
    //   packages/utils/src/index.ts
    //   packages/utils/package.json { name: "@myorg/utils" }
    fs.mkdirSync(path.join(wsRoot, 'packages', 'core', 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'packages', 'utils', 'src'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'packages', 'core', 'src', 'index.js'), 'export default 1;');
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'core', 'src', 'helpers.js'),
      'export const h = 1;',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@myorg/core', main: './src/index.js' }),
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'utils', 'src', 'index.ts'),
      'export default 1;',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'utils', 'package.json'),
      JSON.stringify({ name: '@myorg/utils' }),
    );

    // Register workspaces
    setWorkspaces(
      wsRoot,
      new Map([
        [
          '@myorg/core',
          {
            dir: path.join(wsRoot, 'packages', 'core'),
            entry: path.join(wsRoot, 'packages', 'core', 'src', 'index.js'),
          },
        ],
        [
          '@myorg/utils',
          {
            dir: path.join(wsRoot, 'packages', 'utils'),
            entry: path.join(wsRoot, 'packages', 'utils', 'src', 'index.ts'),
          },
        ],
      ]),
    );
  });

  afterAll(() => {
    clearWorkspaceCache();
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    clearExportsCache();
  });

  it('resolves root import to workspace entry point', () => {
    const result = resolveViaWorkspace('@myorg/core', wsRoot);
    expect(result).toBe(path.join(wsRoot, 'packages', 'core', 'src', 'index.js'));
  });

  it('resolves root import for package without main (index fallback)', () => {
    const result = resolveViaWorkspace('@myorg/utils', wsRoot);
    expect(result).toBe(path.join(wsRoot, 'packages', 'utils', 'src', 'index.ts'));
  });

  it('resolves subpath import via filesystem probe', () => {
    const result = resolveViaWorkspace('@myorg/core/src/helpers', wsRoot);
    expect(result).toBe(path.join(wsRoot, 'packages', 'core', 'src', 'helpers.js'));
  });

  it('resolves subpath import via src/ convention', () => {
    const result = resolveViaWorkspace('@myorg/core/helpers', wsRoot);
    expect(result).toBe(path.join(wsRoot, 'packages', 'core', 'src', 'helpers.js'));
  });

  it('returns null for unknown package', () => {
    expect(resolveViaWorkspace('@myorg/unknown', wsRoot)).toBeNull();
  });

  it('returns null for non-existent subpath', () => {
    expect(resolveViaWorkspace('@myorg/core/nonexistent', wsRoot)).toBeNull();
  });
});

// ─── resolveViaWorkspace with exports-only packages (issue #2288) ─────

describe('resolveViaWorkspace with an exports-only package (issue #2288)', () => {
  let wsRoot: string;
  let realPkgDir: string;

  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ws-exports-'));

    // packages/core: the real, workspace-detected directory — has only an
    // `exports` field, no `main`.
    realPkgDir = path.join(wsRoot, 'packages', 'core');
    fs.mkdirSync(path.join(realPkgDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(realPkgDir, 'lib', 'index.js'), 'export default 1;');
    fs.writeFileSync(
      path.join(realPkgDir, 'package.json'),
      JSON.stringify({ name: '@myorg/core', exports: './lib/index.js' }),
    );

    // node_modules/@myorg/core: what a workspace tool's symlink resolves
    // through on disk — deliberately given a DIFFERENT exports target that
    // doesn't exist, so if resolution consulted this instead of the real
    // workspace dir, it would either resolve the wrong file or fail
    // entirely, not silently produce the correct result.
    const nmPkgDir = path.join(wsRoot, 'node_modules', '@myorg', 'core');
    fs.mkdirSync(nmPkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(nmPkgDir, 'package.json'),
      JSON.stringify({ name: '@myorg/core', exports: './wrong-target.js' }),
    );

    setWorkspaces(wsRoot, new Map([['@myorg/core', { dir: realPkgDir, entry: null }]]));
  });

  afterAll(() => {
    clearWorkspaceCache();
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    clearExportsCache();
  });

  it('resolves the root import via exports at the real workspace directory, not the node_modules symlink target', () => {
    const result = resolveViaWorkspace('@myorg/core', wsRoot);
    expect(result).toBe(path.join(realPkgDir, 'lib', 'index.js'));
  });
});

// ─── resolveImportPathJS with workspaces ─────────────────────────────

describe('resolveImportPathJS with workspace resolution', () => {
  let wsRoot: string;

  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ws-resolve-'));
    fs.mkdirSync(path.join(wsRoot, 'packages', 'lib', 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
      'export const add = (a, b) => a + b;',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: '@myorg/lib', main: './src/index.js' }),
    );
    fs.writeFileSync(
      path.join(wsRoot, 'apps', 'web', 'src', 'app.js'),
      'import { add } from "@myorg/lib";',
    );

    setWorkspaces(
      wsRoot,
      new Map([
        [
          '@myorg/lib',
          {
            dir: path.join(wsRoot, 'packages', 'lib'),
            entry: path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
          },
        ],
      ]),
    );
  });

  afterAll(() => {
    clearWorkspaceCache();
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('resolves workspace package import to source file', () => {
    const fromFile = path.join(wsRoot, 'apps', 'web', 'src', 'app.js');
    const result = resolveImportPathJS(fromFile, '@myorg/lib', wsRoot, null);
    expect(result).toBe('packages/lib/src/index.js');
  });

  it('marks workspace-resolved paths for confidence boost', () => {
    const fromFile = path.join(wsRoot, 'apps', 'web', 'src', 'app.js');
    clearWorkspaceCache();
    setWorkspaces(
      wsRoot,
      new Map([
        [
          '@myorg/lib',
          {
            dir: path.join(wsRoot, 'packages', 'lib'),
            entry: path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
          },
        ],
      ]),
    );
    resolveImportPathJS(fromFile, '@myorg/lib', wsRoot, null);
    expect(isWorkspaceResolved('packages/lib/src/index.js')).toBe(true);
  });
});

// ─── computeConfidenceJS with workspace boost ────────────────────────

describe('computeConfidenceJS workspace confidence', () => {
  let wsRoot: string;

  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ws-conf-'));
    fs.mkdirSync(path.join(wsRoot, 'packages', 'lib', 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
      'export const x = 1;',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: '@myorg/lib', main: './src/index.js' }),
    );
    fs.writeFileSync(path.join(wsRoot, 'apps', 'web', 'src', 'app.js'), 'import "@myorg/lib";');

    setWorkspaces(
      wsRoot,
      new Map([
        [
          '@myorg/lib',
          {
            dir: path.join(wsRoot, 'packages', 'lib'),
            entry: path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
          },
        ],
      ]),
    );

    // Trigger resolution to populate _workspaceResolvedPaths
    const fromFile = path.join(wsRoot, 'apps', 'web', 'src', 'app.js');
    resolveImportPathJS(fromFile, '@myorg/lib', wsRoot, null);
  });

  afterAll(() => {
    clearWorkspaceCache();
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('returns 0.95 confidence for workspace-resolved imports', () => {
    const conf = computeConfidenceJS(
      'apps/web/src/app.js',
      'packages/lib/src/utils.js',
      'packages/lib/src/index.js',
    );
    expect(conf).toBe(0.95);
  });

  it('returns normal confidence for non-workspace imports', () => {
    const conf = computeConfidenceJS(
      'apps/web/src/app.js',
      'some/distant/file.js',
      'some/other/import.js',
    );
    expect(conf).toBeLessThan(0.95);
  });
});

// ─── Cross-language fallback rejection (#1783) ───────────────────────

// Regression tests for #1783: the global-by-name call-resolution fallback
// had no language-consistency check at all, so a bare-name call with no
// import/receiver match could resolve against a same-named symbol in a
// completely unrelated language — e.g. a Ruby file's builtin `Kernel#load`
// call matched a JS ESM loader hook's unrelated `load` export purely because
// both files sat in the same directory (confidence 0.7 from proximity alone).
describe('isSameLanguageFamily (#1783)', () => {
  it('returns false for a Ruby file and a JS file', () => {
    expect(isSameLanguageFamily('tracer/ruby-tracer.rb', 'tracer/loader-hooks.mjs')).toBe(false);
  });

  it('returns false for a Python file and a Go file', () => {
    expect(isSameLanguageFamily('src/main.py', 'src/main.go')).toBe(false);
  });

  it('returns true for two files with the same extension', () => {
    expect(isSameLanguageFamily('src/a.rb', 'lib/b.rb')).toBe(true);
  });

  it('treats JavaScript and TypeScript as the same family', () => {
    expect(isSameLanguageFamily('src/a.ts', 'src/b.js')).toBe(true);
    expect(isSameLanguageFamily('src/a.tsx', 'src/b.mjs')).toBe(true);
    expect(isSameLanguageFamily('src/a.cjs', 'src/b.jsx')).toBe(true);
  });

  it('treats C and its own header extension as the same family', () => {
    expect(isSameLanguageFamily('src/a.c', 'src/a.h')).toBe(true);
  });

  it('treats .h as ambiguous with C++ (Greptile follow-up)', () => {
    // `.h` is real-world ambiguous between C and C++ (LANGUAGE_REGISTRY
    // assigns it to C alone for grammar-selection purposes), so a `.cpp`
    // file calling into its own project's `.h` header must not be rejected
    // as cross-language.
    expect(isSameLanguageFamily('src/widget.cpp', 'src/widget.h')).toBe(true);
  });

  it('treats C++ source and header extensions as the same family', () => {
    expect(isSameLanguageFamily('src/a.cpp', 'src/a.hpp')).toBe(true);
    expect(isSameLanguageFamily('src/a.cc', 'src/a.cxx')).toBe(true);
  });

  it('does not treat C and C++ as the same family', () => {
    expect(isSameLanguageFamily('src/a.c', 'src/a.cpp')).toBe(false);
  });

  it('returns true (does not reject) when either extension is unrecognised', () => {
    expect(isSameLanguageFamily('README', 'src/b.rb')).toBe(true);
    expect(isSameLanguageFamily('src/a.rb', 'Makefile')).toBe(true);
  });
});

describe('computeConfidenceJS — cross-language rejection (#1783)', () => {
  it('returns 0 for same-directory files in different languages (the #1783 repro shape)', () => {
    // ruby-tracer.rb's bare `load` call must never match loader-hooks.mjs's
    // `load` export just because both files live in the same directory.
    const conf = computeConfidenceJS(
      'tests/benchmarks/resolution/tracer/ruby-tracer.rb',
      'tests/benchmarks/resolution/tracer/loader-hooks.mjs',
      undefined,
    );
    expect(conf).toBe(0);
  });

  it('still returns same-directory confidence for a same-language pair', () => {
    const conf = computeConfidenceJS(
      'tests/benchmarks/resolution/tracer/ruby-tracer.rb',
      'tests/benchmarks/resolution/tracer/other-tracer.rb',
      undefined,
    );
    expect(conf).toBe(0.7);
  });

  it('does not regress same-project JS/TS cross-file resolution', () => {
    // A .ts caller resolving a same-directory .js target must be unaffected —
    // TS/JS are one family despite being different LANGUAGE_REGISTRY entries.
    const conf = computeConfidenceJS('src/graph/a.ts', 'src/graph/b.js', undefined);
    expect(conf).toBe(0.7);
  });

  it('rejects a cross-language match even when same-file/importedFrom shortcuts do not apply', () => {
    const conf = computeConfidenceJS('src/main.py', 'src/main.go', undefined);
    expect(conf).toBeLessThan(0.5);
    expect(conf).toBe(0);
  });

  it('does not reject when the target extension is unrecognised (falls through to distance scoring)', () => {
    const conf = computeConfidenceJS('src/a.rb', 'src/README', undefined);
    expect(conf).toBeGreaterThan(0);
  });
});

// ─── Rust crate::/self::/super:: module-path resolution (#2007) ────────

describe('resolveImportPathJS - Rust crate::/self::/super:: paths (#2007)', () => {
  let rustDir: string;
  const knownFiles = [
    'main.rs',
    'models.rs',
    'repository.rs',
    'service.rs',
    'validator.rs',
    'service/nested.rs',
    'service/helper.rs',
  ];

  beforeAll(() => {
    rustDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-rust-'));
    fs.mkdirSync(path.join(rustDir, 'service'), { recursive: true });
    for (const rel of knownFiles) {
      fs.writeFileSync(path.join(rustDir, rel), '');
    }
  });

  afterAll(() => {
    if (rustDir) fs.rmSync(rustDir, { recursive: true, force: true });
  });

  it('resolves crate:: single-item form (trailing item name, no file of its own) to its declaring file', () => {
    const fromFile = path.join(rustDir, 'main.rs');
    const result = resolveImportPathJS(
      fromFile,
      'crate::service::build_service',
      rustDir,
      null,
      knownFiles,
    );
    expect(result).toBe('service.rs');
  });

  it('resolves crate:: braced-list form (module path only, no trailing item) to its declaring file', () => {
    const fromFile = path.join(rustDir, 'main.rs');
    const result = resolveImportPathJS(fromFile, 'crate::models', rustDir, null, knownFiles);
    expect(result).toBe('models.rs');
  });

  it('resolves crate:: from a non-root file (crate-root lookup does not require fromFile === crate root)', () => {
    const fromFile = path.join(rustDir, 'service.rs');
    const result = resolveImportPathJS(
      fromFile,
      'crate::validator::validate_all',
      rustDir,
      null,
      knownFiles,
    );
    expect(result).toBe('validator.rs');
  });

  it('resolves self:: to a sibling submodule of the current file', () => {
    const fromFile = path.join(rustDir, 'service.rs');
    const result = resolveImportPathJS(fromFile, 'self::nested', rustDir, null, knownFiles);
    expect(result).toBe('service/nested.rs');
  });

  it('resolves super:: from a nested submodule back up to a sibling', () => {
    const fromFile = path.join(rustDir, 'service', 'nested.rs');
    const result = resolveImportPathJS(fromFile, 'super::helper', rustDir, null, knownFiles);
    expect(result).toBe('service/helper.rs');
  });

  it('resolves super:: from a top-level module to a crate-root sibling', () => {
    const fromFile = path.join(rustDir, 'service.rs');
    const result = resolveImportPathJS(fromFile, 'super::validator', rustDir, null, knownFiles);
    expect(result).toBe('validator.rs');
  });

  it('falls back to the raw specifier on a dead-end mid-path (no matching module)', () => {
    const fromFile = path.join(rustDir, 'main.rs');
    const result = resolveImportPathJS(
      fromFile,
      'crate::nonexistent::foo',
      rustDir,
      null,
      knownFiles,
    );
    expect(result).toBe('crate::nonexistent::foo');
  });

  it('falls back to the raw specifier when no knownFiles are provided', () => {
    const fromFile = path.join(rustDir, 'main.rs');
    const result = resolveImportPathJS(fromFile, 'crate::service::build_service', rustDir, null);
    expect(result).toBe('crate::service::build_service');
  });

  it('does not treat a non-.rs file importing a crate::-shaped string as a Rust path', () => {
    const fromFile = path.join(rustDir, 'main.ts');
    const result = resolveImportPathJS(
      fromFile,
      'crate::service::build_service',
      rustDir,
      null,
      knownFiles,
    );
    expect(result).toBe('crate::service::build_service');
  });

  it('resolves crate:: when knownFiles are absolute paths, not just root-relative ones (#2216)', () => {
    // ctx.allFiles (full-build path) and getKnownFilesForIncremental
    // (watch-mode path) both populate knownFiles with absolute paths —
    // the resolver must not assume the root-relative form used elsewhere
    // in this describe block is the only one callers pass.
    const absoluteKnownFiles = knownFiles.map((rel) => path.join(rustDir, rel));
    const fromFile = path.join(rustDir, 'main.rs');
    const result = resolveImportPathJS(
      fromFile,
      'crate::service::build_service',
      rustDir,
      null,
      absoluteKnownFiles,
    );
    expect(result).toBe('service.rs');
  });

  describe('standalone Cargo targets (src/bin/, examples/, tests/, benches/)', () => {
    let targetsDir: string;
    const targetKnownFiles = [
      'src/main.rs',
      'src/bin/tool.rs',
      'src/bin/helper.rs',
      'tests/integration.rs',
    ];

    beforeAll(() => {
      targetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-rust-targets-'));
      fs.mkdirSync(path.join(targetsDir, 'src', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(targetsDir, 'tests'), { recursive: true });
      for (const rel of targetKnownFiles) {
        fs.writeFileSync(path.join(targetsDir, rel), '');
      }
    });

    afterAll(() => {
      if (targetsDir) fs.rmSync(targetsDir, { recursive: true, force: true });
    });

    it('resolves crate:: from a standalone src/bin/ target to a sibling in the same target, not src/main.rs', () => {
      const fromFile = path.join(targetsDir, 'src', 'bin', 'tool.rs');
      const result = resolveImportPathJS(
        fromFile,
        'crate::helper',
        targetsDir,
        null,
        targetKnownFiles,
      );
      expect(result).toBe('src/bin/helper.rs');
    });

    it('returns the raw specifier for super:: from a standalone target (no parent module to walk up to)', () => {
      const fromFile = path.join(targetsDir, 'tests', 'integration.rs');
      const result = resolveImportPathJS(
        fromFile,
        'super::helper',
        targetsDir,
        null,
        targetKnownFiles,
      );
      expect(result).toBe('super::helper');
    });
  });
});

describe('resolveImportPathJS - Cargo.toml [[bin]]/[[example]]/[[test]]/[[bench]] path overrides (#2217)', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-cargo-toml-'));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'custom', 'location'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'main.rs'), '');
    fs.writeFileSync(path.join(projectDir, 'src', 'shared.rs'), '');
    fs.writeFileSync(path.join(projectDir, 'src', 'nested.rs'), '');
    fs.writeFileSync(path.join(projectDir, 'custom', 'location', 'tool.rs'), '');
    fs.writeFileSync(path.join(projectDir, 'custom', 'location', 'helper.rs'), '');
    fs.writeFileSync(
      path.join(projectDir, 'Cargo.toml'),
      `
[package]
name = "demo"

[[bin]]
name = "tool"
path = "custom/location/tool.rs"
`,
    );
  });

  afterAll(() => {
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  });

  afterEach(() => {
    clearCargoTargetOverridesCache();
  });

  const knownFiles = [
    'src/main.rs',
    'src/shared.rs',
    'src/nested.rs',
    'custom/location/tool.rs',
    'custom/location/helper.rs',
  ];

  it('treats a Cargo.toml [[bin]] path override as its own crate root, not a submodule of src/main.rs', () => {
    const fromFile = path.join(projectDir, 'custom', 'location', 'tool.rs');
    const result = resolveImportPathJS(fromFile, 'crate::helper', projectDir, null, knownFiles);
    expect(result).toBe('custom/location/helper.rs');
  });

  it('does not let the override crate root see src/main.rs-relative modules via crate::', () => {
    // src/nested.rs exists in the OTHER crate's module tree — if the override
    // crate root wrongly fell back to walking up to src/main.rs, this would
    // resolve to src/nested.rs instead of falling through to the raw specifier.
    const fromFile = path.join(projectDir, 'custom', 'location', 'tool.rs');
    const result = resolveImportPathJS(
      fromFile,
      'crate::nested::something',
      projectDir,
      null,
      knownFiles,
    );
    expect(result).toBe('crate::nested::something');
  });

  it('src/main.rs is unaffected by an override declared for a different target', () => {
    const fromFile = path.join(projectDir, 'src', 'main.rs');
    const result = resolveImportPathJS(fromFile, 'crate::shared', projectDir, null, knownFiles);
    expect(result).toBe('src/shared.rs');
  });

  it('falls through gracefully when Cargo.toml is malformed TOML', () => {
    fs.writeFileSync(path.join(projectDir, 'Cargo.toml'), '[[bin\nnot valid toml');
    const fromFile = path.join(projectDir, 'custom', 'location', 'tool.rs');
    const result = resolveImportPathJS(fromFile, 'crate::helper', projectDir, null, knownFiles);
    expect(result).toBe('crate::helper');
    // Restore valid Cargo.toml for any subsequent test run against this fixture.
    fs.writeFileSync(
      path.join(projectDir, 'Cargo.toml'),
      `
[package]
name = "demo"

[[bin]]
name = "tool"
path = "custom/location/tool.rs"
`,
    );
  });

  it('recognizes an override target literally named mod.rs at a custom path', () => {
    // The basename guard exists to defer to the ordinary main.rs/lib.rs
    // search for the CONVENTIONAL crate root — it must not also reject a
    // legitimate override target that happens to share that name. mod.rs
    // specifically discriminates the bug: unlike main.rs/lib.rs, the
    // ordinary crate-root walk-up never looks for a file named mod.rs, so
    // there's no coincidental fallback to mask an incorrectly-rejected
    // override here.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-cargo-toml-basename-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'custom', 'location'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'main.rs'), '');
      fs.writeFileSync(path.join(dir, 'custom', 'location', 'mod.rs'), '');
      fs.writeFileSync(path.join(dir, 'custom', 'location', 'helper.rs'), '');
      fs.writeFileSync(
        path.join(dir, 'Cargo.toml'),
        `
[package]
name = "demo"

[[bin]]
name = "tool"
path = "custom/location/mod.rs"
`,
      );
      const overrideKnownFiles = [
        'src/main.rs',
        'custom/location/mod.rs',
        'custom/location/helper.rs',
      ];
      const fromFile = path.join(dir, 'custom', 'location', 'mod.rs');
      const result = resolveImportPathJS(fromFile, 'crate::helper', dir, null, overrideKnownFiles);
      expect(result).toBe('custom/location/helper.rs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks up a Cargo.toml override added after the cache was already populated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-cargo-toml-stale-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'custom', 'location'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'main.rs'), '');
      fs.writeFileSync(path.join(dir, 'src', 'nested.rs'), '');
      fs.writeFileSync(path.join(dir, 'custom', 'location', 'tool.rs'), '');
      fs.writeFileSync(path.join(dir, 'custom', 'location', 'helper.rs'), '');
      // No Cargo.toml yet — populate the cache with "no overrides" first.
      const knownFilesForStaleTest = [
        'src/main.rs',
        'src/nested.rs',
        'custom/location/tool.rs',
        'custom/location/helper.rs',
      ];
      const fromFile = path.join(dir, 'custom', 'location', 'tool.rs');
      const before = resolveImportPathJS(
        fromFile,
        'crate::helper',
        dir,
        null,
        knownFilesForStaleTest,
      );
      expect(before).toBe('crate::helper'); // no override yet — cache now holds "none"

      fs.writeFileSync(
        path.join(dir, 'Cargo.toml'),
        `
[package]
name = "demo"

[[bin]]
name = "tool"
path = "custom/location/tool.rs"
`,
      );
      clearCargoTargetOverridesCache();

      const after = resolveImportPathJS(
        fromFile,
        'crate::helper',
        dir,
        null,
        knownFilesForStaleTest,
      );
      expect(after).toBe('custom/location/helper.rs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveImportPathJS - Python module paths (#2387)', () => {
  // PyPA "src layout": the package root is `src/`, but imports are written
  // `from pipeline…` — the exact shape that resolved zero imports on
  // data-analytics-pipeline-svc.
  let pyDir: string;
  const knownFiles = [
    'src/pipeline/__init__.py',
    'src/pipeline/util.py',
    'src/pipeline/main.py',
    'src/pipeline/stages/__init__.py',
    'src/pipeline/stages/extract.py',
    'src/pipeline/stages/load.py',
    'scripts/tool.py',
    'flat.py',
  ];

  beforeAll(() => {
    pyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-py-'));
    for (const rel of knownFiles) {
      fs.mkdirSync(path.join(pyDir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(pyDir, rel), '');
    }
    clearPythonImportRootsCache();
  });

  afterAll(() => {
    if (pyDir) fs.rmSync(pyDir, { recursive: true, force: true });
    clearPythonImportRootsCache();
  });

  const resolveFrom = (relFrom: string, source: string): string =>
    resolveImportPathJS(path.join(pyDir, relFrom), source, pyDir, null, knownFiles);

  it('resolves an absolute dotted import against the layout-derived package root (src layout)', () => {
    expect(resolveFrom('src/pipeline/main.py', 'pipeline.util')).toBe('src/pipeline/util.py');
  });

  it('resolves a dotted import to a nested module', () => {
    expect(resolveFrom('src/pipeline/main.py', 'pipeline.stages.extract')).toBe(
      'src/pipeline/stages/extract.py',
    );
  });

  it('resolves a package import to its __init__.py', () => {
    expect(resolveFrom('src/pipeline/main.py', 'pipeline.stages')).toBe(
      'src/pipeline/stages/__init__.py',
    );
  });

  it('resolves a single-dot relative import to a sibling module', () => {
    expect(resolveFrom('src/pipeline/stages/load.py', '.extract')).toBe(
      'src/pipeline/stages/extract.py',
    );
  });

  it('resolves a double-dot relative import to the parent package', () => {
    expect(resolveFrom('src/pipeline/stages/load.py', '..util')).toBe('src/pipeline/util.py');
  });

  it('resolves a bare-dot relative import to the current package __init__.py', () => {
    expect(resolveFrom('src/pipeline/stages/load.py', '.')).toBe('src/pipeline/stages/__init__.py');
  });

  it('resolves an import from a file outside the package tree via the src/ convention', () => {
    expect(resolveFrom('scripts/tool.py', 'pipeline.util')).toBe('src/pipeline/util.py');
  });

  it('resolves a flat-layout import against the repo root', () => {
    expect(resolveFrom('flat.py', 'flat')).toBe('flat.py');
  });

  it('leaves a stdlib/third-party module unresolved so it is treated as external', () => {
    // Falls through to the bare-specifier fallback, which echoes the specifier.
    expect(resolveFrom('src/pipeline/main.py', 'os.path')).toBe('os.path');
    expect(resolveFrom('src/pipeline/main.py', 'numpy')).toBe('numpy');
  });

  it('does not escape the repo root when a relative import climbs past the package', () => {
    // `...` from src/pipeline/stages/ would land above pyDir — must not resolve.
    const result = resolveFrom('src/pipeline/stages/load.py', '...escape');
    expect(result.startsWith('..')).toBe(false);
  });

  it('honours a pyproject.toml pythonpath entry that no layout convention implies', () => {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-pycfg-'));
    try {
      const cfgFiles = ['lib/vendored/helper.py', 'app/run.py'];
      for (const rel of cfgFiles) {
        fs.mkdirSync(path.join(cfgDir, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(cfgDir, rel), '');
      }
      fs.writeFileSync(
        path.join(cfgDir, 'pyproject.toml'),
        '[tool.pytest.ini_options]\npythonpath = ["lib"]\n',
      );
      clearPythonImportRootsCache();

      const result = resolveImportPathJS(
        path.join(cfgDir, 'app/run.py'),
        'vendored.helper',
        cfgDir,
        null,
        cfgFiles,
      );
      expect(result).toBe('lib/vendored/helper.py');
    } finally {
      fs.rmSync(cfgDir, { recursive: true, force: true });
      clearPythonImportRootsCache();
    }
  });
});

describe('resolvePyprojectScriptEntrypoints (#2408)', () => {
  let scriptDir: string;

  afterEach(() => {
    if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true });
    clearPythonImportRootsCache();
  });

  function writeScriptFixture(pyproject: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-pyscript-'));
    fs.mkdirSync(path.join(dir, 'src/pipeline'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/pipeline/__init__.py'), '');
    fs.writeFileSync(path.join(dir, 'src/pipeline/cli.py'), 'def main():\n    pass\n');
    fs.writeFileSync(path.join(dir, 'src/pipeline/gui.py'), 'def launch():\n    pass\n');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), pyproject);
    return dir;
  }

  it('resolves a console-script target via a src-layout package root', () => {
    scriptDir = writeScriptFixture(
      '[project.scripts]\ningest = "pipeline.cli:main"\n\n' +
        '[tool.setuptools.package-dir]\n"" = "src"\n',
    );
    clearPythonImportRootsCache();

    const resolved = resolvePyprojectScriptEntrypoints(scriptDir);

    expect(resolved).toEqual([{ file: 'src/pipeline/cli.py', attr: 'main' }]);
  });

  it('resolves gui-scripts and poetry scripts alongside console scripts', () => {
    scriptDir = writeScriptFixture(
      '[project.scripts]\ncli = "pipeline.cli:main"\n' +
        '[project.gui-scripts]\ngui = "pipeline.gui:launch"\n' +
        '[tool.poetry.scripts]\npoetry-cli = "pipeline.cli:main"\n\n' +
        '[tool.setuptools.package-dir]\n"" = "src"\n',
    );
    clearPythonImportRootsCache();

    const resolved = resolvePyprojectScriptEntrypoints(scriptDir);
    const files = resolved.map((e) => `${e.file}:${e.attr}`).sort();

    // The poetry entry duplicates the console-script target, so it dedupes
    // away rather than producing a second identical entry.
    expect(files).toEqual(['src/pipeline/cli.py:main', 'src/pipeline/gui.py:launch']);
  });

  it('skips a table-shaped poetry script entry', () => {
    // Poetry's extras-conditional shape: `{ callable = "...", extras = [...] }`.
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-pyscript-table-'));
    fs.writeFileSync(
      path.join(scriptDir, 'pyproject.toml'),
      '[tool.poetry.scripts]\nfoo = { callable = "pipeline.cli:main", extras = ["x"] }\n',
    );
    clearPythonImportRootsCache();

    expect(resolvePyprojectScriptEntrypoints(scriptDir)).toEqual([]);
  });

  it('returns empty when pyproject.toml is missing or declares no scripts', () => {
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-pyscript-missing-'));
    clearPythonImportRootsCache();
    expect(resolvePyprojectScriptEntrypoints(scriptDir)).toEqual([]);

    fs.writeFileSync(path.join(scriptDir, 'pyproject.toml'), '[project]\nname = "pipeline"\n');
    clearPythonImportRootsCache();
    expect(resolvePyprojectScriptEntrypoints(scriptDir)).toEqual([]);
  });

  it('drops a script entry whose module does not resolve under any root', () => {
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-pyscript-unresolved-'));
    fs.writeFileSync(
      path.join(scriptDir, 'pyproject.toml'),
      '[project.scripts]\ningest = "nonexistent.cli:main"\n',
    );
    clearPythonImportRootsCache();

    expect(resolvePyprojectScriptEntrypoints(scriptDir)).toEqual([]);
  });
});

describe('resolvePythonSubmodule (#2387)', () => {
  let subDir: string;
  const knownFiles = [
    'pkg/__init__.py',
    'pkg/stages/__init__.py',
    'pkg/stages/extract.py',
    'pkg/util.py',
    'pkg/main.py',
  ];

  beforeAll(() => {
    subDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-pysub-'));
    for (const rel of knownFiles) {
      fs.mkdirSync(path.join(subDir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(subDir, rel), '');
    }
    clearPythonImportRootsCache();
  });

  afterAll(() => {
    if (subDir) fs.rmSync(subDir, { recursive: true, force: true });
    clearPythonImportRootsCache();
  });

  it('resolves `from pkg.stages import extract` to the submodule file', () => {
    expect(
      resolvePythonSubmodule(
        path.join(subDir, 'pkg/main.py'),
        'pkg.stages',
        'extract',
        subDir,
        knownFiles,
      ),
    ).toBe('pkg/stages/extract.py');
  });

  it('returns null when the imported name is an ordinary symbol, not a submodule', () => {
    expect(
      resolvePythonSubmodule(
        path.join(subDir, 'pkg/main.py'),
        'pkg.util',
        'shared_helper',
        subDir,
        knownFiles,
      ),
    ).toBeNull();
  });

  it('returns null for a wildcard import and for non-Python callers', () => {
    expect(
      resolvePythonSubmodule(path.join(subDir, 'pkg/main.py'), 'pkg', '*', subDir, knownFiles),
    ).toBeNull();
    expect(
      resolvePythonSubmodule(path.join(subDir, 'main.ts'), 'pkg', 'stages', subDir, knownFiles),
    ).toBeNull();
  });
});
