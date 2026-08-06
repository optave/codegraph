/**
 * Unit tests for traceBarrelTarget (#2071).
 *
 * `traceBarrelTarget` is the single shared implementation of "resolve a name
 * through a possible barrel hop to the file and declared name that actually
 * own it" — extracted so `buildImportedNamesMap` (ESM imports) and
 * `buildImportArtifactNames` (CJS `require()` destructuring), both in
 * build-edges.ts, can no longer maintain divergent private copies.
 *
 * Before this fix, `buildImportArtifactNames`'s own copy of this logic kept
 * only the resolved file and silently dropped the resolved *name*, so a CJS
 * `require()` binding traced through a barrel that renames on re-export
 * (`export { realName as friendlyName } from './underlying'`) would report
 * the barrel's external alias instead of the name actually declared in the
 * underlying file — asymmetric with the ESM import path, which always got
 * this right. No current consumer reads that value (only key presence via
 * `.has()`), which is exactly why the divergence went unnoticed; these tests
 * pin the shared helper's behavior directly so it can't regress silently
 * again, for either caller.
 */
import { describe, expect, it } from 'vitest';
import { PipelineContext } from '../../src/domain/graph/builder/context.js';
import { traceBarrelTarget } from '../../src/domain/graph/builder/stages/resolve-imports.js';
import type { ExtractorOutput, Import } from '../../src/types.js';

function makeCtx(): PipelineContext {
  const ctx = new PipelineContext();
  ctx.fileSymbols = new Map();
  ctx.reexportMap = new Map();
  return ctx;
}

function stubSymbols(overrides: Partial<ExtractorOutput> = {}): ExtractorOutput {
  return {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
    ...overrides,
  };
}

function reexportImport(source: string, names: string[]): Import {
  return { source, names, line: 1, reexport: true };
}

describe('traceBarrelTarget (#2071)', () => {
  it('returns the path/name unchanged when the target is not a barrel file', () => {
    const ctx = makeCtx();
    // Not registered in fileSymbols at all — isBarrelFile treats that as "not a barrel".
    expect(traceBarrelTarget(ctx, 'plain.js', 'x')).toEqual({ file: 'plain.js', name: 'x' });
  });

  it('traces through a barrel re-export with no rename', () => {
    const ctx = makeCtx();
    ctx.fileSymbols.set(
      'underlying.js',
      stubSymbols({ definitions: [{ name: 'realName', kind: 'function', line: 1 }] }),
    );
    ctx.fileSymbols.set(
      'barrel.js',
      stubSymbols({ imports: [reexportImport('underlying.js', ['realName'])] }),
    );
    ctx.reexportMap.set('barrel.js', [
      { source: 'underlying.js', names: ['realName'], wildcardReexport: false, renames: [] },
    ]);

    expect(traceBarrelTarget(ctx, 'barrel.js', 'realName')).toEqual({
      file: 'underlying.js',
      name: 'realName',
    });
  });

  it('traces through a barrel-renamed re-export to the name actually declared in the underlying file (#2071)', () => {
    const ctx = makeCtx();
    ctx.fileSymbols.set(
      'underlying.js',
      stubSymbols({ definitions: [{ name: 'realName', kind: 'function', line: 1 }] }),
    );
    ctx.fileSymbols.set(
      'barrel.js',
      stubSymbols({ imports: [reexportImport('underlying.js', ['realName'])] }),
    );
    // `export { realName as friendlyName } from './underlying'`.
    ctx.reexportMap.set('barrel.js', [
      {
        source: 'underlying.js',
        names: ['realName'],
        wildcardReexport: false,
        renames: [{ local: 'friendlyName', imported: 'realName' }],
      },
    ]);

    // A CJS consumer does `const { friendlyName } = require('./barrel')` — the
    // requested name is the barrel's external alias. The resolved name must be
    // the underlying declaration ('realName'), never the alias itself.
    expect(traceBarrelTarget(ctx, 'barrel.js', 'friendlyName')).toEqual({
      file: 'underlying.js',
      name: 'realName',
    });
  });

  it('falls back to the barrel file/name unchanged when barrel resolution finds nothing', () => {
    const ctx = makeCtx();
    ctx.fileSymbols.set(
      'barrel.js',
      stubSymbols({ imports: [reexportImport('missing.js', ['other'])] }),
    );
    // No matching reexportMap entry for 'barrel.js'.

    expect(traceBarrelTarget(ctx, 'barrel.js', 'nonexistent')).toEqual({
      file: 'barrel.js',
      name: 'nonexistent',
    });
  });
});
