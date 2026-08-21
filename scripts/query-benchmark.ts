#!/usr/bin/env node

/**
 * Query benchmark runner — measures query depth scaling and diff-impact latency.
 *
 * Each engine (native / WASM) runs in a forked subprocess so that a segfault
 * in the native addon only kills the child — the parent survives and collects
 * partial results from whichever engines succeeded.
 *
 * Usage: node --experimental-strip-types --import ./scripts/ts-resolve-loader.js scripts/query-benchmark.ts > result.json
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolveBenchmarkExcludes, resolveBenchmarkSource, srcImport } from './lib/bench-config.js';
import { isWorker, workerEngine, workerTargets, forkEngines } from './lib/fork-engine.js';
import { round1, timeMedian } from './lib/bench-timing.js';
import { PINNED_HUB_CANDIDATES, selectHubTargets, type HubTargets } from './lib/hub-selection.js';

// ── Parent process: fork one child per engine, assemble final output ─────
if (!isWorker()) {
	const __parentDir = path.dirname(fileURLToPath(import.meta.url));
	const __parentRoot = path.resolve(__parentDir, '..');

	const { version, cleanup: versionCleanup } = await resolveBenchmarkSource();
	let wasm, native;
	try {
		({ wasm, native } = await forkEngines(import.meta.url, process.argv.slice(2)));
	} catch (err) {
		console.error(`Error: ${err.message}`);
		versionCleanup();
		process.exit(1);
	}

	// Safety net: if a worker was killed mid-benchDiffImpact, the git staging
	// area may be dirty.  Unstage any leftover changes so subsequent runs and
	// unrelated git operations aren't affected.
	try {
		const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
			cwd: __parentRoot, encoding: 'utf8',
		}).trim();
		if (staged) {
			console.error('[fork] Cleaning up leftover staged files from crashed worker');
			execFileSync('git', ['restore', '--staged', '.'], { cwd: __parentRoot, stdio: 'pipe' });
			execFileSync('git', ['checkout', '.'], { cwd: __parentRoot, stdio: 'pipe' });
		}
	} catch { /* git not available or no repo — safe to ignore */ }

	const primary = wasm || native;
	if (!primary) {
		console.error('Error: Both engines failed. No results to report.');
		versionCleanup();
		process.exit(1);
	}

	const result = {
		version,
		date: new Date().toISOString().slice(0, 10),
		wasm: wasm
			? {
					targets: wasm.targets,
					fnDeps: wasm.fnDeps,
					fnImpact: wasm.fnImpact,
					diffImpact: wasm.diffImpact,
				}
			: null,
		native: native
			? {
					targets: native.targets,
					fnDeps: native.fnDeps,
					fnImpact: native.fnImpact,
					diffImpact: native.diffImpact,
				}
			: null,
	};

	console.log(JSON.stringify(result, null, 2));
	versionCleanup();
	process.exit(0);
}

// ── Worker process: benchmark a single engine, write JSON to stdout ──────
const engine = workerEngine();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { srcDir, cleanup } = await resolveBenchmarkSource();
const dbPath = path.join(root, '.codegraph', 'graph.db');

const { buildGraph } = await import(srcImport(srcDir, 'domain/graph/builder.js'));
const queries = await import(srcImport(srcDir, 'domain/queries.js'));
const { fnDepsData, fnImpactData, diffImpactData } = queries;
// #2598: `runGitDiff` + `diffImpactData`'s `diffText` option let this
// benchmark hoist the `git` subprocess out of the timed region, so the metric
// measures graph work instead of process spawn (spawn was ~8ms of a ~9ms
// call). Older releases -- which this script also benchmarks, via
// resolveBenchmarkSource -- lack both, so fall back to timing the whole call
// there rather than failing. Numbers from the two modes are not comparable;
// see benchDiffImpact.
const runGitDiff = typeof queries.runGitDiff === 'function' ? queries.runGitDiff : null;
// v3.9.5+ parses WASM in a worker_thread that keeps the event loop alive until
// disposed. Older releases don't export disposeParsers — fall back to a no-op.
let disposeParsers = async () => {};
try {
	const parser = await import(srcImport(srcDir, 'domain/parser.js'));
	if (typeof parser.disposeParsers === 'function') disposeParsers = parser.disposeParsers;
} catch { /* older release — no worker pool to dispose */ }

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

const RUNS = 5;

// The first 2-3 native calls into a given query path per process pay a
// cold-start cost (rusqlite statement-cache warmup, OS page cache for the DB
// file, NAPI-side static init from tree-sitter's transitive crates linked
// into the .node binary). On Linux x86_64 CI, that pulled median(5) into
// cold-start territory once tree-sitter 0.25 grew the binary's init footprint
// (#1076), even though steady-state per-call latency is unchanged. Discard
// the first WARMUP_RUNS before timing so the metric reflects warm-call
// latency, not cold-start.
//
// This applies per query path, not just once per process: fnDeps, fnImpact and
// diffImpact each run different code over different DB pages, so warming one
// does not warm the next (#2590). Which specific cold-start costs a warmup
// removes differs by path, though -- the list above describes the native
// fnDeps/fnImpact path; see benchDiffImpact for the JS/better-sqlite3 case,
// where the statement cache does not outlive a single call.
const WARMUP_RUNS = 3;

async function benchDepths(fn, name, depths) {
	const result = {};
	for (const depth of depths) {
		for (let i = 0; i < WARMUP_RUNS; i++) {
			fn(name, dbPath, { depth, noTests: true });
		}
		result[`depth${depth}Ms`] = round1(
			await timeMedian(() => fn(name, dbPath, { depth, noTests: true }), RUNS),
		);
	}
	return result;
}

/**
 * Resolve a file path from the DB to an absolute path.
 * Handles relative paths (normal) and absolute-like paths without leading '/'
 * (observed on CI when the npm-installed buildGraph stores full paths).
 */
function resolveDbFile(rootDir: string, dbFile: string): string | null {
	if (path.isAbsolute(dbFile)) return fs.existsSync(dbFile) ? dbFile : null;
	const joined = path.join(rootDir, dbFile);
	if (fs.existsSync(joined)) return joined;
	// DB may store an absolute path without the leading '/'
	const withSlash = '/' + dbFile;
	if (fs.existsSync(withSlash)) return withSlash;
	return null;
}

/**
 * Apply the probe edit whose impact this benchmark measures.
 *
 * The edit is placed *inside* the resolved hub function's body, so the changed
 * line range intersects a real definition and `diffImpactData` runs its actual
 * analysis — BFS to `depth: 3`, co-change lookup, ownership, boundary checks.
 *
 * Before #2598 the probe was appended after the file's last line, which lands
 * outside every function: `findAffectedFunctions` returned empty and the call
 * short-circuited, so the metric timed the short-circuit (plus a `git`
 * subprocess) rather than the traversal. Measured on this repo, that made the
 * whole call ~0.5ms of analysis inside a ~9ms measurement.
 *
 * Falls back to appending at end-of-file when the graph recorded no usable
 * line range for the hub, so the benchmark still runs (with the old, weaker
 * semantics) rather than failing.
 */
function probeEdit(original: string, targets: HubTargets): string {
	const { hubLine, hubEndLine } = targets;
	const lines = original.split('\n');
	if (
		hubLine == null ||
		hubEndLine == null ||
		hubEndLine <= hubLine + 1 ||
		hubEndLine > lines.length
	) {
		console.error(
			`[benchDiffImpact] no usable hub line range (${hubLine}..${hubEndLine}); appending probe at EOF`,
		);
		return original + '\n// benchmark-probe\n';
	}
	// Midpoint of the body, converted from the 1-based line range to a 0-based
	// splice index. Strictly inside (hubLine, hubEndLine), so it cannot land on
	// the signature or the closing brace.
	const insertAt = Math.floor((hubLine + hubEndLine) / 2);
	lines.splice(insertAt, 0, '\t// benchmark-probe');
	return lines.join('\n');
}

async function benchDiffImpact(targets: HubTargets) {
	// Reuse the exact physical node selectHubTargets already resolved for
	// `targets.hub` instead of re-querying `nodes` by name — a second,
	// independently unfiltered query can disagree with the first about which
	// same-named node "the hub" is (#1904).
	//
	// targets.hubFile is normally relative (e.g. 'src/domain/builder.ts'), but
	// some environments store absolute-like paths without the leading '/'.
	// Handle both cases so the benchmark works regardless of DB path format.
	const hubFile = resolveDbFile(root, targets.hubFile);
	if (!hubFile) {
		console.error(`[benchDiffImpact] Cannot find hub file for hubFile=${targets.hubFile}`);
		return { latencyMs: 0, affectedFunctions: 0, affectedFiles: 0 };
	}
	const original = fs.readFileSync(hubFile, 'utf8');

	try {
		fs.writeFileSync(hubFile, probeEdit(original, targets));
		execFileSync('git', ['add', hubFile], { cwd: root, stdio: 'pipe' });

		// Capture the diff once, outside the timed region, using the very
		// function diffImpactData would have called — so the measurement covers
		// parse + graph analysis over exactly the same input, minus the spawn.
		const captured = runGitDiff
			? runGitDiff(root, { staged: true }, 1 << 26)
			: null;
		if (captured && 'error' in captured && captured.error) {
			console.error(`[benchDiffImpact] runGitDiff failed: ${captured.error}`);
		}
		const opts =
			captured && captured.output != null
				? { depth: 3, noTests: true, diffText: captured.output }
				: { staged: true, depth: 3, noTests: true };

		// Warm the diffImpact path before timing, exactly as benchDepths does for
		// fnDeps/fnImpact (#2591). diffImpactData is a distinct query path from
		// those -- its own DB handle and its own pages -- so the warmup those
		// calls already paid does not carry over.
		//
		// What these calls warm is narrower than on the native fnDeps path, and it
		// is deliberately not the statement cache: diffImpactData opens its own
		// readonly better-sqlite3 handle and closes it in a `finally`, so its
		// prepared statements are discarded per call and no timed run ever reuses
		// one. What does carry into the timed runs is process- and OS-wide state:
		// loadConfig's per-root cache (resolveDbConfig re-reads .codegraphrc.json
		// only on the first call), the OS page cache for the DB file, and V8
		// tiering up the diff parsing and BFS code that only this path exercises.
		//
		// #2591's rationale also counted warming the `.git` data read by the
		// staged-diff subprocess. That no longer applies here: the subprocess now
		// runs once above, outside the timed region, so no timed run reads `.git`
		// at all (#2598).
		//
		// Without this, diffImpact was the only query metric measured cold: the
		// same defect #2584 fixed for benchmark.ts's Full build, and that #2436
		// traced part of the gate's non-determinism to (#2590).

		let lastResult = null;
		const call = () => {
			lastResult = diffImpactData(dbPath, opts);
		};
		for (let i = 0; i < WARMUP_RUNS; i++) call();
		const latencyMs = round1(await timeMedian(call, RUNS));

		return {
			latencyMs,
			affectedFunctions: lastResult?.affectedFunctions?.length || 0,
			affectedFiles: lastResult?.affectedFiles?.length || 0,
			// Records which mode produced `latencyMs`, so a baseline comparison
			// can tell "analysis only" numbers from legacy spawn-inclusive ones
			// instead of reading the drop as a huge improvement.
			excludesGitSpawn: Boolean(captured && captured.output != null),
		};
	} finally {
		execFileSync('git', ['restore', '--staged', hubFile], { cwd: root, stdio: 'pipe' });
		fs.writeFileSync(hubFile, original);
	}
}

// Build graph for this engine
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
await buildGraph(root, { engine, incremental: false, exclude: [...resolveBenchmarkExcludes()] });

const targets: HubTargets = workerTargets() || selectHubTargets(dbPath, PINNED_HUB_CANDIDATES);
console.error(`Targets: hub=${targets.hub}, mid=${targets.mid}, leaf=${targets.leaf}`);

const fnDeps = {};
const fnImpact = {};

fnDeps.depth1Ms = (await benchDepths(fnDepsData, targets.hub, [1])).depth1Ms;
fnDeps.depth3Ms = (await benchDepths(fnDepsData, targets.hub, [3])).depth3Ms;
fnDeps.depth5Ms = (await benchDepths(fnDepsData, targets.hub, [5])).depth5Ms;

fnImpact.depth1Ms = (await benchDepths(fnImpactData, targets.hub, [1])).depth1Ms;
fnImpact.depth3Ms = (await benchDepths(fnImpactData, targets.hub, [3])).depth3Ms;
fnImpact.depth5Ms = (await benchDepths(fnImpactData, targets.hub, [5])).depth5Ms;

const diffImpact = await benchDiffImpact(targets);

// Restore console.log for JSON output
console.log = origLog;

const workerResult = { targets, fnDeps, fnImpact, diffImpact };
console.log(JSON.stringify(workerResult));

await disposeParsers();
cleanup();
process.exit(0);
