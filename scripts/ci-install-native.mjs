#!/usr/bin/env node
/**
 * Copy the PR-built `.node` artifact (produced by the `native-host-build` CI
 * job and downloaded into `crates/codegraph-core/`) over the published
 * platform binary installed in `node_modules`.
 *
 * Used by the CI `test` and `parity` jobs so they exercise the native engine
 * built from the PR's Rust source rather than the last-published binary,
 * which lags behind PR changes and causes false parity failures.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLATFORM_PACKAGES = {
  'linux-x64-gnu': '@optave/codegraph-linux-x64-gnu',
  'linux-x64-musl': '@optave/codegraph-linux-x64-musl',
  'linux-arm64-gnu': '@optave/codegraph-linux-arm64-gnu',
  'linux-arm64-musl': '@optave/codegraph-linux-arm64-musl',
  'darwin-arm64': '@optave/codegraph-darwin-arm64',
  'darwin-x64': '@optave/codegraph-darwin-x64',
  'win32-x64': '@optave/codegraph-win32-x64-msvc',
};

function detectLibc() {
  if (os.platform() !== 'linux') return '';
  try {
    const files = fs.readdirSync('/lib');
    return files.some((f) => f.startsWith('ld-musl-') && f.endsWith('.so.1')) ? 'musl' : 'gnu';
  } catch {
    return 'gnu';
  }
}

function resolvePackage() {
  const plat = os.platform();
  const arch = os.arch();
  const libc = detectLibc();
  const key = libc ? `${plat}-${arch}-${libc}` : `${plat}-${arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) throw new Error(`No native package mapped for ${key}`);
  return pkg;
}

const crateDir = path.join('crates', 'codegraph-core');

const built = fs
  .readdirSync(crateDir)
  .filter((f) => f.endsWith('.node'))
  .map((f) => path.join(crateDir, f));

if (built.length === 0) {
  throw new Error(`No .node artifact found in ${crateDir}`);
}
if (built.length > 1) {
  console.warn(`[ci-install-native] multiple .node artifacts found, using ${built[0]}`);
}

const src = built[0];
const pkg = resolvePackage();
const dest = path.join('node_modules', pkg, 'codegraph-core.node');

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[ci-install-native] copied ${src} -> ${dest}`);
