/**
 * Regression test for #2290: watch mode never refreshed the package.json
 * `exports` cache or the workspace-detection map during incremental
 * rebuilds, so a long-running `codegraph build --watch` session kept
 * resolving imports against stale data for its whole lifetime if a
 * dependency's or workspace package's `package.json` changed mid-session.
 *
 * `refreshWorkspaceAndExportsCaches()` (exported from watcher.ts for this
 * purpose) is the fix: re-run workspace detection and clear the exports
 * cache (both engines). Tested here as a black-box behavior check —
 * populate a resolution against the original `package.json`, change it on
 * disk, confirm the STALE result still comes back without a refresh
 * (locking in the exact bug), then confirm the FRESH result comes back
 * after calling `refreshWorkspaceAndExportsCaches()`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearExportsCache,
  clearWorkspaceCache,
  resolveViaExports,
  resolveViaWorkspace,
} from '../../src/domain/graph/resolve.js';
import { diffMtimes, refreshWorkspaceAndExportsCaches } from '../../src/domain/graph/watcher.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watcher-refresh-'));
});

afterEach(() => {
  clearWorkspaceCache();
  clearExportsCache();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('refreshWorkspaceAndExportsCaches (issue #2290)', () => {
  it('picks up a workspace package exports-field change without restarting the watcher', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    const coreDir = path.join(tmpDir, 'packages', 'core');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(
      path.join(coreDir, 'package.json'),
      JSON.stringify({ name: '@myorg/core', exports: './v1.js' }),
    );
    fs.writeFileSync(path.join(coreDir, 'v1.js'), 'export default 1;');
    fs.writeFileSync(path.join(coreDir, 'v2.js'), 'export default 2;');

    // Simulate the initial full build's own workspace-detection step.
    refreshWorkspaceAndExportsCaches(tmpDir);
    expect(resolveViaWorkspace('@myorg/core', tmpDir)).toBe(path.join(coreDir, 'v1.js'));

    // Change the exports field mid-session — nothing has refreshed yet.
    fs.writeFileSync(
      path.join(coreDir, 'package.json'),
      JSON.stringify({ name: '@myorg/core', exports: './v2.js' }),
    );

    // Locks in the exact bug: without a refresh, resolution stays stale.
    expect(resolveViaWorkspace('@myorg/core', tmpDir)).toBe(path.join(coreDir, 'v1.js'));

    // The fix: after refreshing, resolution picks up the new exports target.
    refreshWorkspaceAndExportsCaches(tmpDir);
    expect(resolveViaWorkspace('@myorg/core', tmpDir)).toBe(path.join(coreDir, 'v2.js'));
  });

  it('picks up a new workspace package added mid-session', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    refreshWorkspaceAndExportsCaches(tmpDir);
    expect(resolveViaWorkspace('@myorg/newpkg', tmpDir)).toBeNull();

    const newDir = path.join(tmpDir, 'packages', 'newpkg');
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(
      path.join(newDir, 'package.json'),
      JSON.stringify({ name: '@myorg/newpkg', exports: './index.js' }),
    );
    fs.writeFileSync(path.join(newDir, 'index.js'), 'export default 1;');

    // Still null without a refresh — the workspace map hasn't changed yet.
    expect(resolveViaWorkspace('@myorg/newpkg', tmpDir)).toBeNull();

    refreshWorkspaceAndExportsCaches(tmpDir);
    expect(resolveViaWorkspace('@myorg/newpkg', tmpDir)).toBe(path.join(newDir, 'index.js'));
  });

  it('drops a workspace package removed mid-session, including the last one (Greptile review, PR #2458)', () => {
    // detectWorkspaces() returning an empty map (the last workspace
    // package removed, or the root `workspaces` field itself deleted)
    // must still REPLACE the cached non-empty map — an earlier version of
    // this fix gated setWorkspaces() on `workspaces.size > 0`, leaving the
    // stale entries active forever once the last workspace was removed.
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    const coreDir = path.join(tmpDir, 'packages', 'core');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(
      path.join(coreDir, 'package.json'),
      JSON.stringify({ name: '@myorg/core', exports: './index.js' }),
    );
    fs.writeFileSync(path.join(coreDir, 'index.js'), 'export default 1;');

    refreshWorkspaceAndExportsCaches(tmpDir);
    expect(resolveViaWorkspace('@myorg/core', tmpDir)).toBe(path.join(coreDir, 'index.js'));

    // Remove the only workspace package's manifest entirely.
    fs.rmSync(coreDir, { recursive: true, force: true });

    refreshWorkspaceAndExportsCaches(tmpDir);
    expect(resolveViaWorkspace('@myorg/core', tmpDir)).toBeNull();
  });

  it('clears the exports cache for a plain (non-workspace) dependency too', () => {
    // No workspaces registered at all — exercises the branch where
    // detectWorkspaces() finds nothing, which must still clear the
    // exports cache (a plain dependency's exports field can change
    // independent of any workspace membership).
    const pkgDir = path.join(tmpDir, 'node_modules', 'some-lib');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'some-lib', exports: './v1.js' }),
    );
    fs.writeFileSync(path.join(pkgDir, 'v1.js'), 'export default 1;');
    fs.writeFileSync(path.join(pkgDir, 'v2.js'), 'export default 2;');

    expect(resolveViaExports('some-lib', tmpDir)).toBe(path.join(pkgDir, 'v1.js'));

    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'some-lib', exports: './v2.js' }),
    );
    expect(resolveViaExports('some-lib', tmpDir)).toBe(path.join(pkgDir, 'v1.js'));

    refreshWorkspaceAndExportsCaches(tmpDir);
    expect(resolveViaExports('some-lib', tmpDir)).toBe(path.join(pkgDir, 'v2.js'));
  });
});

describe('diffMtimes (issue #2290)', () => {
  it('reports added, changed, and removed files against a running mtime map', () => {
    const mtimeMap = new Map<string, number>();
    const changed: string[] = [];
    const onChanged = (f: string) => changed.push(f);

    const fileA = path.join(tmpDir, 'a.json');
    fs.writeFileSync(fileA, '{}');

    // First pass: everything is "added" (no prior entry in the map).
    diffMtimes([fileA], mtimeMap, onChanged);
    expect(changed).toEqual([fileA]);
    expect(mtimeMap.has(fileA)).toBe(true);

    // Second pass, unchanged: no callback fires.
    changed.length = 0;
    diffMtimes([fileA], mtimeMap, onChanged);
    expect(changed).toEqual([]);

    // Third pass: mtime changes (rewrite the file).
    changed.length = 0;
    fs.writeFileSync(fileA, '{"changed":true}');
    // Force a distinguishable mtime on filesystems with coarse mtime
    // resolution — a same-millisecond rewrite could otherwise report the
    // identical mtime and make this assertion flaky.
    fs.utimesSync(fileA, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    diffMtimes([fileA], mtimeMap, onChanged);
    expect(changed).toEqual([fileA]);

    // Fourth pass: file no longer present in `current` (removed).
    changed.length = 0;
    diffMtimes([], mtimeMap, onChanged);
    expect(changed).toEqual([fileA]);
    expect(mtimeMap.has(fileA)).toBe(false);
  });
});
