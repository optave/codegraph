/**
 * Native/JS Leiden parity tests (issue #1804).
 *
 * Before this fix, the native path ran classic Louvain while the JS
 * fallback ran Leiden — two genuinely different algorithms, so
 * `codegraph communities`/`--drift` reported different partitions purely
 * based on whether the native addon loaded. Both engines now run Leiden
 * (`crates/codegraph-core/src/graph/algorithms/leiden.rs` is a Rust port of
 * `../leiden/*`), so this suite asserts they produce byte-identical
 * community assignments and modularity scores — not just "similar" ones —
 * across a variety of graph shapes, seeds, and resolutions.
 *
 * Skipped entirely when the native addon isn't available in this
 * environment (nothing to compare against).
 */

import { describe, expect, it } from 'vitest';
import { resolveEdgeWeight } from '../../../src/graph/algorithms/leiden/adapter.js';
import { detectClusters } from '../../../src/graph/algorithms/leiden/index.js';
import { louvainCommunities, nativeParityBlocker } from '../../../src/graph/algorithms/louvain.js';
import { CodeGraph } from '../../../src/graph/model.js';
import { getNative, isNativeAvailable } from '../../../src/infrastructure/native.js';

// Guards against a stale/cached native addon that loads but predates the
// `leidenCommunities` binding (#1804 review): without the export check,
// assertParity would silently degrade to a JS-vs-JS comparison and
// runNativeDirect's non-null assertion would throw a confusing TypeError.
const hasNative =
  isNativeAvailable() &&
  typeof getNative()?.leidenCommunities === 'function' &&
  typeof getNative()?.leidenWeightedCommunities === 'function';

/** Sorted "node:community" pairs — stable snapshot for deep-equal comparison. */
function snapshot(assignments: Map<string, number>): string[] {
  return [...assignments.entries()].map(([node, community]) => `${node}:${community}`).sort();
}

/** Run the JS Leiden path directly (bypassing louvainCommunities' native preference). */
function runJS(
  graph: CodeGraph,
  opts: { resolution?: number; randomSeed?: number } = {},
): { assignments: Map<string, number>; modularity: number } {
  const result = detectClusters(graph, {
    resolution: opts.resolution ?? 1.0,
    randomSeed: opts.randomSeed ?? 42,
    directed: false,
  });
  const assignments = new Map<string, number>();
  for (const [id] of graph.nodes()) {
    const cls = result.getClass(id);
    if (cls != null) assignments.set(id, cls);
  }
  return { assignments, modularity: result.quality() };
}

/**
 * Run the native weighted Leiden binding directly, bypassing
 * louvainCommunities' hardcoded seed. Resolves weights exactly as the public
 * API does, so weighted fixtures reach the binding as real weights rather than
 * being flattened to 1.0.
 */
function runNativeDirect(
  graph: CodeGraph,
  opts: { resolution?: number; randomSeed?: number } = {},
): { assignments: Map<string, number>; modularity: number } {
  const native = getNative();
  const edges = [...graph.edges()].map(([source, target, attrs]) => ({
    source,
    target,
    weight: resolveEdgeWeight(attrs),
  }));
  const result = native.leidenWeightedCommunities!(
    edges,
    graph.nodeIds(),
    opts.resolution ?? 1.0,
    opts.randomSeed ?? 42,
  );
  const assignments = new Map<string, number>();
  for (const entry of result.assignments) assignments.set(entry.node, entry.community);
  return { assignments, modularity: result.modularity };
}

/**
 * Run the pre-#1936 unweighted binding, still exported for version skew (a
 * newer addon loaded by JS that only knows the old name). Kept under test so
 * that path cannot rot silently.
 */
function runNativeUnweightedDirect(
  graph: CodeGraph,
  opts: { resolution?: number; randomSeed?: number } = {},
): { assignments: Map<string, number>; modularity: number } {
  const native = getNative();
  const result = native.leidenCommunities!(
    graph.toEdgeArray(),
    graph.nodeIds(),
    opts.resolution ?? 1.0,
    opts.randomSeed ?? 42,
  );
  const assignments = new Map<string, number>();
  for (const entry of result.assignments) assignments.set(entry.node, entry.community);
  return { assignments, modularity: result.modularity };
}

/**
 * Assert parity through the *public* `louvainCommunities` API (which prefers
 * native and hardcodes randomSeed=42 for both engines — matching real
 * `codegraph communities` usage). Only `resolution` is a real caller-facing
 * knob here.
 */
function assertParity(graph: CodeGraph, opts: { resolution?: number } = {}) {
  const native = louvainCommunities(graph, { resolution: opts.resolution });
  const js = runJS(graph, { resolution: opts.resolution });
  expect(snapshot(native.assignments)).toEqual(snapshot(js.assignments));
  expect(native.modularity).toBe(js.modularity);
}

/**
 * Assert parity by calling the native binding and the JS algorithm directly
 * with an explicit seed, bypassing `louvainCommunities`' hardcoded seed —
 * used to verify the underlying algorithms agree across seeds, independent
 * of what the current public wrapper happens to expose.
 */
function assertParityDirect(graph: CodeGraph, opts: { resolution?: number; randomSeed?: number }) {
  const native = runNativeDirect(graph, opts);
  const js = runJS(graph, opts);
  expect(snapshot(native.assignments)).toEqual(snapshot(js.assignments));
  expect(native.modularity).toBe(js.modularity);
}

function buildTwoClusterGraph(): CodeGraph {
  const g = new CodeGraph();
  g.addEdge('a', 'b');
  g.addEdge('b', 'c');
  g.addEdge('c', 'a');
  g.addEdge('x', 'y');
  g.addEdge('y', 'z');
  g.addEdge('z', 'x');
  g.addEdge('c', 'x');
  return g;
}

/** Deterministic pseudo-random clustered graph: numClusters loosely-connected
 * cliques plus sparse cross-links, large enough to force multi-level
 * coarsening (the code path that originally diverged — see leiden.rs's
 * `build_coarse_graph` doc). */
function buildClusteredGraph(
  numClusters: number,
  clusterSize: number,
  crossLinkProb: number,
  seedStr: string,
): CodeGraph {
  const g = new CodeGraph();
  let s = 0;
  for (let i = 0; i < seedStr.length; i++) s = (s * 31 + seedStr.charCodeAt(i)) & 0x7fffffff;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const clusters: string[][] = [];
  for (let c = 0; c < numClusters; c++) {
    const nodes: string[] = [];
    for (let i = 0; i < clusterSize; i++) {
      const id = `c${c}n${i}`;
      nodes.push(id);
      g.addNode(id);
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (rnd() < 0.5) g.addEdge(nodes[i]!, nodes[j]!);
      }
    }
    clusters.push(nodes);
  }
  for (let c1 = 0; c1 < numClusters; c1++) {
    for (let c2 = c1 + 1; c2 < numClusters; c2++) {
      for (const a of clusters[c1]!) {
        for (const b of clusters[c2]!) {
          if (rnd() < crossLinkProb) g.addEdge(a, b);
        }
      }
    }
  }
  return g;
}

describe.skipIf(!hasNative)('native/JS Leiden parity (issue #1804)', () => {
  it('matches on a small two-cluster graph', () => {
    assertParity(buildTwoClusterGraph());
  });

  it('matches on a graph with reciprocal (mutual-import-style) edges', () => {
    // Both directions present between several node pairs -- exercises the
    // undirected symmetrization/averaging path (adapter.ts's
    // aggregateUndirectedPairs), a second, independent source of
    // native/JS divergence pre-#1804 (classic Louvain summed reciprocal
    // edges instead of averaging them).
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'a');
    g.addEdge('b', 'c');
    g.addEdge('c', 'b');
    g.addEdge('c', 'd');
    g.addEdge('d', 'c');
    assertParity(g);
  });

  it('matches on a graph with self-loops', () => {
    // Guards the original regression: the classic Louvain implementation this
    // file replaces dropped self-loops entirely instead of counting them once
    // toward degree/modularity. (Weighted self-loops are covered in the
    // per-edge-weight block below.)
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'a');
    g.addEdge('a', 'a');
    assertParity(g);
  });

  it.runIf(hasNative)('the retained unweighted binding still agrees with JS', () => {
    // `leidenCommunities` is no longer what `louvainCommunities` calls, but it
    // stays exported for version skew, so it needs its own coverage — the
    // weighted path above would not catch it rotting.
    const g = buildClusteredGraph(8, 5, 0.03, 'unweighted-binding-seed');
    const native = runNativeUnweightedDirect(g, { randomSeed: 42 });
    const js = runJS(g, { randomSeed: 42 });
    expect(snapshot(native.assignments)).toEqual(snapshot(js.assignments));
    expect(native.modularity).toBe(js.modularity);
  });

  it('matches on a graph forcing multi-level coarsening', () => {
    const g = buildClusteredGraph(15, 4, 0.02, 'parity-seed-1');
    assertParity(g);
  });

  it('matches across multiple resolutions via the public API on a multi-level graph', () => {
    const g = buildClusteredGraph(10, 6, 0.03, 'parity-seed-2');
    for (const resolution of [0.5, 0.8, 1.0, 1.5, 2.0]) {
      assertParity(g, { resolution });
    }
  });

  it('matches across multiple seeds (direct engine calls) on a multi-level graph', () => {
    // louvainCommunities hardcodes randomSeed=42 for both engines (it is not
    // a caller-facing knob today), so this drives the native binding and
    // detectClusters directly to confirm the underlying algorithms agree
    // for any seed, not just the one value the current wrapper ever passes.
    const g = buildClusteredGraph(10, 6, 0.03, 'parity-seed-2');
    for (const randomSeed of [1, 7, 42, 999, 2026]) {
      assertParityDirect(g, { randomSeed });
    }
  });

  it('matches with maxLevels/maxLocalPasses/refinementTheta/capacityGrowthFactor overrides', () => {
    const g = buildClusteredGraph(8, 5, 0.03, 'parity-seed-3');
    const native = louvainCommunities(g, {
      resolution: 1.0,
      maxLevels: 3,
      maxLocalPasses: 5,
      refinementTheta: 0.5,
      capacityGrowthFactor: 1.2,
    });
    const jsResult = detectClusters(g, {
      resolution: 1.0,
      randomSeed: 42,
      directed: false,
      maxLevels: 3,
      maxLocalPasses: 5,
      refinementTheta: 0.5,
      capacityGrowthFactor: 1.2,
    });
    const jsAssignments = new Map<string, number>();
    for (const [id] of g.nodes()) {
      const cls = jsResult.getClass(id);
      if (cls != null) jsAssignments.set(id, cls);
    }
    expect(snapshot(native.assignments)).toEqual(snapshot(jsAssignments));
    expect(native.modularity).toBe(jsResult.quality());
  });
});

/**
 * Per-edge weights and the inputs native still cannot represent (issue #1936).
 *
 * Native reads per-edge weights through `leidenWeightedCommunities`, with the
 * attribute-to-number rule resolved once on the TS side (`resolveEdgeWeight`)
 * and shared with the JS adapter. Node `size` is still native-blind, so
 * `nativeParityBlocker` keeps routing size-bearing graphs to the JS reference.
 */
describe('Leiden native/JS parity — per-edge weights (#1936)', () => {
  /**
   * Two triangles joined by a single bridge edge whose weight dominates every
   * intra-triangle edge. Unweighted, the triangles are the obvious partition;
   * weighted, the bridge is by far the strongest tie in the graph, so weights
   * are load-bearing for both the partition and the modularity score.
   */
  function buildWeightedBridgeGraph(bridgeWeight: number | undefined): CodeGraph {
    const g = new CodeGraph();
    for (const [a, b] of [
      ['a1', 'a2'],
      ['a2', 'a3'],
      ['a3', 'a1'],
      ['b1', 'b2'],
      ['b2', 'b3'],
      ['b3', 'b1'],
    ] as const) {
      g.addEdge(a, b, { weight: 1 });
    }
    g.addEdge('a1', 'b1', bridgeWeight == null ? {} : { weight: bridgeWeight });
    return g;
  }

  describe('nativeParityBlocker', () => {
    it('does not flag weighted edges once the weighted binding is available', () => {
      expect(
        nativeParityBlocker(buildWeightedBridgeGraph(25), { weightsSupported: true }),
      ).toBeNull();
    });

    it('flags weighted edges when only the pre-#1936 unweighted binding exists', () => {
      // Version skew: an addon published before the weighted export, loaded by
      // this (newer) JS. Silently sending the weights to a binding that cannot
      // read them is the exact failure this predicate exists to prevent.
      expect(
        nativeParityBlocker(buildWeightedBridgeGraph(25), { weightsSupported: false }),
      ).toMatch(/weight=25/);
    });

    it('stays narrow: weight === 1 and absent weights are never blockers', () => {
      for (const weightsSupported of [true, false]) {
        expect(nativeParityBlocker(buildWeightedBridgeGraph(1), { weightsSupported })).toBeNull();
        expect(
          nativeParityBlocker(buildWeightedBridgeGraph(undefined), { weightsSupported }),
        ).toBeNull();
      }
    });

    it('does not flag non-numeric weight/size attrs (JS falls back to 1 for those too)', () => {
      const g = new CodeGraph();
      g.addEdge('a', 'b', { weight: 'heavy' });
      g.addNode('a', { size: null });
      expect(nativeParityBlocker(g, { weightsSupported: false })).toBeNull();
    });

    it('flags node size attrs regardless of weight support', () => {
      // Sizes are not inert under modularity: the JS reference sorts
      // communities by total size when assigning final IDs, so a size-bearing
      // graph can get different community *labels* even when the grouping
      // matches. Nothing in-tree sets `size`, so there is no caller to verify
      // a native port against — the JS reference stays authoritative.
      const g = new CodeGraph();
      g.addEdge('a', 'b');
      g.addNode('a', { size: 4 });
      for (const weightsSupported of [true, false]) {
        expect(nativeParityBlocker(g, { weightsSupported })).toMatch(/size=4/);
      }
    });
  });

  it.runIf(hasNative)('exposes the weighted binding', () => {
    // If this fails the suite below silently degrades to JS-vs-JS: the public
    // API would fall back rather than error, and every assertion would still
    // pass. Rebuild the addon (`napi build --release`) if it does.
    expect(typeof getNative()?.leidenWeightedCommunities).toBe('function');
  });

  it.runIf(hasNative)('weights change the answer, so parity below is meaningful', () => {
    // Pins that the weighted fixture is actually weight-sensitive. Without
    // this, a binding that ignored weights entirely would still pass every
    // parity assertion in this block.
    const weighted = runJS(buildWeightedBridgeGraph(25));
    const unweighted = runJS(buildWeightedBridgeGraph(undefined));
    expect(weighted.modularity).not.toBe(unweighted.modularity);
  });

  it('matches the JS reference on a weighted graph via the public API', () => {
    for (const bridgeWeight of [0.25, 1, 2, 7, 25, 1000]) {
      const g = buildWeightedBridgeGraph(bridgeWeight);
      const viaPublicApi = louvainCommunities(g);
      const js = runJS(g);
      expect(snapshot(viaPublicApi.assignments)).toEqual(snapshot(js.assignments));
      expect(viaPublicApi.modularity).toBe(js.modularity);
    }
  });

  it('matches on weighted reciprocal edges (undirected averaging path)', () => {
    // adapter.ts sums both directions then divides by how many were seen, so
    // asymmetric reciprocal weights exercise that averaging with a non-unit
    // numerator on both sides of the FFI boundary.
    const g = new CodeGraph();
    g.addEdge('a', 'b', { weight: 5 });
    g.addEdge('b', 'a', { weight: 1 });
    g.addEdge('b', 'c', { weight: 3 });
    g.addEdge('c', 'b', { weight: 3 });
    g.addEdge('c', 'd', { weight: 0.5 });
    assertParity(g);
  });

  it('matches on a weighted self-loop', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b', { weight: 2 });
    g.addEdge('b', 'c', { weight: 2 });
    g.addEdge('c', 'a', { weight: 2 });
    g.addEdge('a', 'a', { weight: 9 });
    assertParity(g);
  });

  it('matches on zero and NaN weights (both drop the edge)', () => {
    // `resolveEdgeWeight`'s `+w || 0` coercion maps both to 0, which the
    // adapter drops. Native must agree rather than treating the edge as 1.0 or
    // propagating NaN through every modularity sum.
    for (const weight of [0, Number.NaN]) {
      const g = new CodeGraph();
      g.addEdge('a', 'b', { weight: 4 });
      g.addEdge('b', 'c', { weight: 4 });
      g.addEdge('c', 'a', { weight: 4 });
      g.addEdge('a', 'd', { weight });
      g.addEdge('d', 'e', { weight: 4 });
      g.addEdge('e', 'a', { weight: 4 });
      assertParity(g);
    }
  });

  it('matches on a weighted multi-level graph across seeds and resolutions', () => {
    const g = buildClusteredGraph(10, 6, 0.03, 'weighted-seed-1');
    // Deterministic pseudo-weights derived from the endpoint ids, so the
    // fixture is weighted without needing a second RNG in the test.
    let i = 0;
    for (const [src, tgt] of [...g.edges()].map(([a, b]) => [a, b] as const)) {
      i += 1;
      g.addEdge(src, tgt, { weight: 1 + (i % 7) * 0.5 });
    }
    for (const resolution of [0.5, 1.0, 2.0]) {
      assertParity(g, { resolution });
    }
    for (const randomSeed of [1, 42, 2026]) {
      assertParityDirect(g, { randomSeed });
    }
  });
});
