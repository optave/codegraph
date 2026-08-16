/**
 * Regression tests for #2391: the native (Rust) build orchestrator's file
 * collector set `.hidden(true)` on its `ignore::WalkBuilder`, which blanket-
 * skips both hidden directories AND hidden files. Dotfile-named source files
 * are common and legitimate — `.terraform.lock.hcl` (Terraform's dependency
 * lock file) and `.pa11yci.authed.cjs` (a pa11y config) both matched this and
 * were silently dropped by native, triggering a misleading "likely a Rust
 * extractor bug" warning and a WASM backfill, even though the real bug was
 * file *discovery*, not extraction. The JS/TS collector (`shouldIgnore` in
 * `shared/constants.ts`) only ever skips hidden directories, never files —
 * the fix aligns the Rust collector with that existing asymmetry.
 *
 * A second, related defect from the same issue is fixed in
 * `native-orchestrator.ts` but not covered here: the build-completion log
 * line's file count reflected only the files the native orchestrator itself
 * collected, captured before any WASM backfill inserted additional file
 * nodes. No isolated regression test was constructible for it — the only
 * known real-world trigger for "native's own file collector misses a file
 * WASM would find" is the hidden-file bug fixed above, so once that's fixed
 * there is no remaining scenario in this codebase where the two file counts
 * can diverge. Verified manually instead: reproduced the exact issue scenario
 * (a project with `.terraform.lock.hcl`) against the pre-fix binary, saw the
 * completion log undercount relative to the DB's true file-node count, then
 * confirmed the fix corrects it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const hasNative = isNativeAvailable();
const requireParity = !!process.env.CODEGRAPH_PARITY;
const describeOrSkip = requireParity || hasNative ? describe : describe.skip;

function readFileNodeRow(dbPath: string, file: string) {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT name, kind, file FROM nodes WHERE kind='file' AND file = ?")
    .get(file) as { name: string; kind: string; file: string } | undefined;
  db.close();
  return row;
}

describeOrSkip('Native orchestrator no longer drops hidden dotfile source files (#2391)', () => {
  let tmpBase: string;
  let projectDir: string;
  let dbPath: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2391-'));
    projectDir = path.join(tmpBase, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    dbPath = path.join(projectDir, '.codegraph', 'graph.db');

    // A dotfile-named HCL source file — mirrors Terraform's real
    // `.terraform.lock.hcl` convention exactly (leading dot, multiple
    // embedded dots, a nested `provider { ... }` block with a hashes array).
    fs.writeFileSync(
      path.join(projectDir, '.terraform.lock.hcl'),
      [
        '# This file is maintained automatically by "terraform init".',
        'provider "registry.terraform.io/hashicorp/aws" {',
        '  version     = "5.31.0"',
        '  constraints = "~> 5.0"',
        '  hashes = [',
        '    "h1:abcdefghijklmnopqrstuvwxyz1234567890abcdefg=",',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(projectDir, 'main.tf'),
      'provider "aws" {\n  region = "us-east-1"\n}\n',
    );

    // A dotfile-named CommonJS source file — mirrors the issue's
    // `.pa11yci.authed.cjs` example.
    fs.writeFileSync(
      path.join(projectDir, '.pa11yci.authed.cjs'),
      "function greet(name) {\n  return 'Hello ' + name;\n}\nmodule.exports = { greet };\ngreet('world');\n",
    );

    // A file inside a hidden DIRECTORY — must remain excluded; the fix only
    // changes file-level behavior, not the existing directory-level skip.
    fs.mkdirSync(path.join(projectDir, '.hidden_dir'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.hidden_dir', 'should_be_excluded.py'),
      'def hidden_func():\n    return 1\n',
    );

    stderrChunks = [];
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(chunk.toString());
        return true;
      });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('natively parses a dotfile-named .hcl file without a WASM backfill warning', async () => {
    await buildGraph(projectDir, { engine: 'native', incremental: false, skipRegistry: true });

    const log = stderrChunks.join('');
    expect(log).not.toContain('likely a Rust extractor bug');
    expect(log).not.toContain('.terraform.lock.hcl');

    const row = readFileNodeRow(dbPath, '.terraform.lock.hcl');
    expect(row).toBeDefined();

    const db = new Database(dbPath, { readonly: true });
    const symbols = db
      .prepare('SELECT name FROM nodes WHERE file = ? AND kind != ?')
      .all('.terraform.lock.hcl', 'file') as { name: string }[];
    db.close();
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.some((s) => s.name.includes('hashicorp/aws'))).toBe(true);
  }, 60_000);

  it('natively parses a dotfile-named .cjs file without a WASM backfill warning', async () => {
    await buildGraph(projectDir, { engine: 'native', incremental: false, skipRegistry: true });

    const log = stderrChunks.join('');
    expect(log).not.toContain('.pa11yci.authed.cjs');

    const row = readFileNodeRow(dbPath, '.pa11yci.authed.cjs');
    expect(row).toBeDefined();

    const db = new Database(dbPath, { readonly: true });
    const symbols = db
      .prepare('SELECT name FROM nodes WHERE file = ? AND kind != ?')
      .all('.pa11yci.authed.cjs', 'file') as { name: string }[];
    db.close();
    expect(symbols.some((s) => s.name === 'greet')).toBe(true);
  }, 60_000);

  it('still excludes files inside hidden directories', async () => {
    await buildGraph(projectDir, { engine: 'native', incremental: false, skipRegistry: true });

    const row = readFileNodeRow(dbPath, '.hidden_dir/should_be_excluded.py');
    expect(row).toBeUndefined();
  }, 60_000);
});
