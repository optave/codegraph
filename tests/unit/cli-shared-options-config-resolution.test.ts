/**
 * Regression tests for issue #2137: `src/cli/shared/options.ts`'s
 * `resolveNoTests()` (and everything that calls it — `resolveQueryOpts()`,
 * plus every command using `applyQueryOpts()`, ~38 call sites) read
 * `query.excludeTests` from a process-wide `config` singleton resolved
 * exactly once from `process.cwd()`. A command invoked with `--db
 * /other/project/.codegraph/graph.db` from a different cwd silently read
 * the WRONG project's `.codegraphrc.json` (or none at all) for this value,
 * changing which rows a query returns — not just display formatting.
 *
 * The fix: `resolveNoTests()` now derives config via
 * `resolveDbConfig(opts.db)`, mirroring the pattern already used at the
 * data-query layer for issues #1881/#2017, so it reads the *target*
 * project's config regardless of the invoking directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveNoTests } from '../../src/cli/shared/options.js';

const CUSTOM_EXCLUDE_TESTS = true;

let projectDir: string;
let cwdDir: string;
let dbPath: string;

beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-options-project-'));
  fs.mkdirSync(path.join(projectDir, '.git'));
  fs.mkdirSync(path.join(projectDir, '.codegraph'));
  dbPath = path.join(projectDir, '.codegraph', 'graph.db');
  fs.writeFileSync(dbPath, '');
  fs.writeFileSync(
    path.join(projectDir, '.codegraphrc.json'),
    JSON.stringify({ query: { excludeTests: CUSTOM_EXCLUDE_TESTS } }),
  );

  // cwd is a different, config-less directory — resolveNoTests() reading
  // config from process.cwd() instead of opts.db would silently miss the
  // custom value above and fall back to the false default.
  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-options-cwd-'));
});

afterAll(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(cwdDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveNoTests (#2137)', () => {
  it('reads query.excludeTests from the opts.db project, not process.cwd()', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    expect(resolveNoTests({ db: dbPath })).toBe(true);
  });

  it('falls back to process.cwd() config when no opts.db is given (commands with no --db target)', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    expect(resolveNoTests({})).toBe(true);
  });

  it('--no-tests (opts.tests === false) always wins regardless of config', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    expect(resolveNoTests({ db: dbPath, tests: false })).toBe(true);
  });

  it('--include-tests always wins over a project config with excludeTests: true', () => {
    expect(resolveNoTests({ db: dbPath, includeTests: true })).toBe(false);
  });

  it('defaults to false when neither a flag nor a project config sets excludeTests', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    expect(resolveNoTests({})).toBe(false);
  });
});
