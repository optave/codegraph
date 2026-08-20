/**
 * Community detection via native Rust Leiden or vendored TS Leiden.
 * Maintains backward-compatible API: { assignments: Map<string, number>, modularity: number }
 *
 * Both the native path and the JS fallback run the same algorithm — Leiden
 * (always undirected, `directed: false`, modularity quality). Before issue
 * #1804, the native path ran classic Louvain while the JS fallback ran
 * Leiden: two genuinely different algorithms with different guarantees
 * (Leiden avoids Louvain's disconnected-community defect), so `codegraph
 * communities`/`--drift` reported different partitions purely based on
 * whether the native addon loaded. `crates/codegraph-core/src/graph/algorithms/leiden.rs`
 * is a faithful Rust port of `./leiden/*` covering exactly the option
 * surface `LouvainOptions` exposes below (undirected, modularity-only,
 * "neighbors" candidate strategy, refine always on) — see that file's module
 * doc for the precise (deliberately narrower) subset ported and the
 * follow-up issue tracking the rest.
 *
 * Because that subset is narrower than what the JS reference accepts,
 * `nativeParityBlocker` below inspects the graph before choosing the native
 * path and defers to the JS reference for any input native cannot represent
 * faithfully -- see its doc comment. Without that check the two engines would
 * silently disagree on weighted graphs rather than erroring, which is the
 * failure mode this module exists to prevent.
 */

import { debug } from '../../infrastructure/logger.js';
import { loadNative } from '../../infrastructure/native.js';
import type { CodeGraph } from '../model.js';
import type { DetectClustersResult } from './leiden/index.js';
import { detectClusters } from './leiden/index.js';

/** Default random seed for deterministic community detection. */
const DEFAULT_RANDOM_SEED = 42;

export interface LouvainOptions {
  resolution?: number;
  maxLevels?: number;
  maxLocalPasses?: number;
  refinementTheta?: number;
  capacityGrowthFactor?: number;
}

export interface LouvainResult {
  assignments: Map<string, number>;
  modularity: number;
}

/**
 * Report the first graph attribute the JS reference honors but the native
 * binding cannot see, or `null` when both engines would optimize the same
 * weighted graph.
 *
 * `louvainCommunities` hands native `graph.toEdgeArray()`, which yields
 * `{ source, target }` only -- every edge attribute is dropped at the FFI
 * boundary -- and passes no node attributes at all, so `leiden.rs` assumes a
 * uniform weight of 1.0 per edge and size of 1.0 per node. The JS reference
 * instead resolves both from attributes (`adapter.ts`'s default
 * `linkWeight`/`nodeSize`: `attrs.weight` / `attrs.size` when numeric, else
 * 1). On a graph carrying either attribute the two engines therefore
 * optimize *different* weighted graphs and can return different partitions
 * -- exactly the engine-dependent output #1804 exists to eliminate, except
 * silent, since nothing errors and both answers look plausible.
 *
 * No in-tree builder attaches `weight`/`size` today (`buildTemporalGraph`
 * stores its Jaccard score under a `jaccard` key, which neither engine reads,
 * and `buildDependencyGraph` sets only `kind`), so this is a trap for the
 * *next* caller rather than a live divergence. Routing such a graph to the JS
 * reference keeps the result correct-by-definition instead of engine-
 * dependent; issue #1936 tracks teaching native to read these directly.
 *
 * A value of exactly 1 is not a blocker: it is what native already assumes,
 * so both engines agree. Non-numeric values are not blockers either -- the JS
 * defaults fall back to 1 for those, matching native.
 *
 * Exported so tests can assert the *negative* case directly: an over-eager
 * blocker would quietly route every graph to the (slower) JS reference while
 * every parity assertion still passed, since the two engines agree on
 * everything this predicate lets through.
 */
export function nativeParityBlocker(graph: CodeGraph): string | null {
  for (const [source, target, attrs] of graph.edges()) {
    if (typeof attrs.weight === 'number' && attrs.weight !== 1) {
      return `edge ${source}->${target} carries weight=${attrs.weight}`;
    }
  }
  for (const [id, attrs] of graph.nodes()) {
    if (typeof attrs.size === 'number' && attrs.size !== 1) {
      return `node ${id} carries size=${attrs.size}`;
    }
  }
  return null;
}

export function louvainCommunities(graph: CodeGraph, opts: LouvainOptions = {}): LouvainResult {
  if (graph.nodeCount === 0 || graph.edgeCount === 0) {
    return { assignments: new Map(), modularity: 0 };
  }

  const resolution: number = opts.resolution ?? 1.0;

  const native = loadNative();
  const blocker = native?.leidenCommunities ? nativeParityBlocker(graph) : null;
  if (blocker) {
    debug(
      `louvainCommunities: using the JS Leiden reference instead of the native ` +
        `binding -- native cannot represent this graph faithfully (${blocker})`,
    );
  }
  if (native?.leidenCommunities && !blocker) {
    const edges = graph.toEdgeArray();
    const nodeIds = graph.nodeIds();
    const result = native.leidenCommunities(
      edges,
      nodeIds,
      resolution,
      DEFAULT_RANDOM_SEED,
      opts.maxLevels,
      opts.maxLocalPasses,
      opts.refinementTheta,
      opts.capacityGrowthFactor,
    );
    const assignments = new Map<string, number>();
    for (const entry of result.assignments) {
      assignments.set(entry.node, entry.community);
    }
    return { assignments, modularity: result.modularity };
  }

  return louvainJS(graph, opts, resolution);
}

/** JS fallback using the vendored Leiden algorithm. */
function louvainJS(graph: CodeGraph, opts: LouvainOptions, resolution: number): LouvainResult {
  const result: DetectClustersResult = detectClusters(graph, {
    resolution,
    randomSeed: DEFAULT_RANDOM_SEED,
    directed: false,
    ...(opts.maxLevels != null && { maxLevels: opts.maxLevels }),
    ...(opts.maxLocalPasses != null && { maxLocalPasses: opts.maxLocalPasses }),
    ...(opts.refinementTheta != null && { refinementTheta: opts.refinementTheta }),
    ...(opts.capacityGrowthFactor != null && { capacityGrowthFactor: opts.capacityGrowthFactor }),
  });

  const assignments = new Map<string, number>();
  for (const [id] of graph.nodes()) {
    const cls = result.getClass(id);
    if (cls != null) assignments.set(id, cls);
  }

  return { assignments, modularity: result.quality() };
}
