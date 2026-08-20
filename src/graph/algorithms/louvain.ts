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
import { resolveEdgeWeight } from './leiden/adapter.js';
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
 * The native binding receives a flat edge array across the FFI boundary and
 * no node attributes at all, so anything the JS reference derives from an
 * attribute native cannot see makes the two engines optimize *different*
 * graphs and return different partitions -- exactly the engine-dependent
 * output #1804 exists to eliminate, except silent, since nothing errors and
 * both answers look plausible.
 *
 * Two attributes are at stake. Per-edge `weight` is now understood natively
 * (`leidenWeightedCommunities`), so it is only a blocker when that newer
 * binding is missing -- an older published addon loaded by newer JS -- hence
 * the `weightsSupported` parameter. Per-node `size` is never understood
 * natively: nothing in-tree attaches it, so there is no caller to verify a
 * port against, and it is not inert (the JS reference sorts communities by
 * total size when assigning final IDs, so sizes change the labels even when
 * the grouping matches).
 *
 * Routing a graph native cannot represent to the JS reference keeps the
 * result correct-by-definition instead of engine-dependent.
 *
 * The predicate stays deliberately narrow. A value of exactly 1 is what
 * native already assumes, so both engines agree; non-numeric values hit the
 * JS defaults' own fallback to 1, which also matches. Neither is a blocker.
 *
 * Exported so tests can assert the *negative* case directly: an over-eager
 * blocker would quietly route every graph to the (slower) JS reference while
 * every parity assertion still passed, since the two engines agree on
 * everything this predicate lets through.
 */
export function nativeParityBlocker(
  graph: CodeGraph,
  { weightsSupported }: { weightsSupported: boolean },
): string | null {
  if (!weightsSupported) {
    for (const [source, target, attrs] of graph.edges()) {
      if (typeof attrs.weight === 'number' && attrs.weight !== 1) {
        return `edge ${source}->${target} carries weight=${attrs.weight}`;
      }
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
  // Prefer the weighted binding; `leidenCommunities` is the pre-#1936 export
  // kept for the case where an older published addon is loaded by newer JS.
  const weighted = native?.leidenWeightedCommunities;
  const unweighted = native?.leidenCommunities;
  const binding = weighted ?? unweighted;

  if (binding) {
    const blocker = nativeParityBlocker(graph, { weightsSupported: weighted != null });
    if (blocker) {
      debug(
        `louvainCommunities: using the JS Leiden reference instead of the native ` +
          `binding -- native cannot represent this graph faithfully (${blocker})`,
      );
    } else {
      const nodeIds = graph.nodeIds();
      const result = weighted
        ? weighted(
            toWeightedEdgeArray(graph),
            nodeIds,
            resolution,
            DEFAULT_RANDOM_SEED,
            opts.maxLevels,
            opts.maxLocalPasses,
            opts.refinementTheta,
            opts.capacityGrowthFactor,
          )
        : // biome-ignore lint/style/noNonNullAssertion: `binding` is non-null
          // and `weighted` is null here, so `unweighted` is the binding.
          unweighted!(
            graph.toEdgeArray(),
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
  }

  return louvainJS(graph, opts, resolution);
}

/**
 * Build the native weighted binding's edge array.
 *
 * Weight resolution happens here, via the same `resolveEdgeWeight` the JS
 * adapter uses, so both engines agree on what each edge weighs by
 * construction rather than by two matching implementations. `undefined` is
 * sent for the default so the wire format stays compact on the overwhelmingly
 * common unweighted graph -- native reads an absent weight as 1.0.
 */
function toWeightedEdgeArray(
  graph: CodeGraph,
): { source: string; target: string; weight?: number }[] {
  const edges: { source: string; target: string; weight?: number }[] = [];
  for (const [source, target, attrs] of graph.edges()) {
    const weight = resolveEdgeWeight(attrs);
    edges.push(weight === 1 ? { source, target } : { source, target, weight });
  }
  return edges;
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
