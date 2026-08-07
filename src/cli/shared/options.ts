import type { Command } from 'commander';
import { resolveDbConfig } from '../../db/index.js';
import { loadConfig } from '../../infrastructure/config.js';
import type { CodegraphConfig } from '../../types.js';
import type { CommandOpts } from '../types.js';

// Deferred so global --user-config / --no-user-config flags are parsed
// before config is first accessed (Commander parses flags before any command
// action runs, but module-level code executes at import time).
//
// This singleton is only correct for commands with no project-specific
// `dir`/`--db` target (e.g. `models`) — it is pinned to process.cwd() once
// and never revisited. Any command that receives its own target directory
// or `--db` path must resolve config via resolveDbConfig(opts.db) instead,
// the way resolveNoTests() below does, so `codegraph <cmd> /other/project`
// invoked from a different cwd reads *that* project's .codegraphrc.json
// rather than the invoking directory's (issue #2137).
let _config: CodegraphConfig | undefined;
const config: CodegraphConfig = new Proxy({} as CodegraphConfig, {
  get(_t, prop: string) {
    if (_config === undefined) _config = loadConfig(process.cwd());
    return _config[prop as keyof CodegraphConfig];
  },
}) as CodegraphConfig;

/**
 * Attach the common query options shared by most analysis commands.
 */
export function applyQueryOpts(cmd: Command): Command {
  return cmd
    .option('-d, --db <path>', 'Path to graph.db')
    .option('-T, --no-tests', 'Exclude test/spec files from results')
    .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
    .option('-j, --json', 'Output as JSON')
    .option('-n, --limit <number>', 'Max results to return')
    .option('--offset <number>', 'Skip N results (default: 0)')
    .option('--ndjson', 'Newline-delimited JSON output')
    .option('--table', 'Output as aligned table')
    .option('--csv', 'Output as CSV');
}

/**
 * Resolve the effective noTests value: CLI flag > config > false.
 * Commander sets opts.tests to false when --no-tests is passed.
 * When --include-tests is passed, always return false (include tests).
 * Otherwise, fall back to the target project's query.excludeTests — derived
 * from opts.db (issue #2137) rather than the process.cwd()-pinned `config`
 * singleton, so `codegraph <cmd> --db /other/project/.codegraph/graph.db`
 * reads that project's own config instead of the invoking directory's.
 */
export function resolveNoTests(opts: CommandOpts): boolean {
  if (opts.includeTests) return false;
  if (opts.tests === false) return true;
  return resolveDbConfig(opts.db).query?.excludeTests || false;
}

/**
 * Extract the common query option fields shared by most analysis commands.
 *
 * Spreads cleanly into per-command option objects:
 *   `{ ...resolveQueryOpts(opts), depth: parseInt(opts.depth, 10) }`
 */
export function resolveQueryOpts(opts: CommandOpts): CommandOpts {
  return {
    noTests: resolveNoTests(opts),
    json: opts.json,
    ndjson: opts.ndjson,
    table: opts.table,
    csv: opts.csv,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { config };
