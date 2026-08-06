import { describe, expect, it } from 'vitest';
import { tarjan } from '../../../src/graph/algorithms/tarjan.js';
import { CodeGraph } from '../../../src/graph/model.js';

function sortCycles(cycles) {
  return cycles.map((c) => [...c].sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

describe('tarjan', () => {
  it('returns empty for acyclic graph', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    expect(tarjan(g)).toHaveLength(0);
  });

  it('detects 2-node cycle', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'a');
    const sccs = tarjan(g);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(['a', 'b']);
  });

  it('detects 3-node cycle', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'a');
    const sccs = tarjan(g);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(['a', 'b', 'c']);
  });

  it('detects multiple independent cycles', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'a');
    g.addEdge('x', 'y');
    g.addEdge('y', 'z');
    g.addEdge('z', 'x');
    g.addEdge('p', 'q'); // non-cyclic

    const sccs = sortCycles(tarjan(g));
    expect(sccs).toHaveLength(2);
    expect(sccs[0]).toEqual(['a', 'b']);
    expect(sccs[1]).toEqual(['x', 'y', 'z']);
  });

  it('handles empty graph', () => {
    const g = new CodeGraph();
    expect(tarjan(g)).toHaveLength(0);
  });

  it('ignores self-loops (single-node SCCs are filtered)', () => {
    const g = new CodeGraph();
    g.addNode('a');
    expect(tarjan(g)).toHaveLength(0);
  });

  it('returns byte-identical node order within a cycle across repeated calls (#2064, #2067, #2076)', () => {
    // Regression coverage: SCC node order must be a deterministic function of
    // the cycle's member set alone, not of incidental traversal order. Mirrors
    // the same guarantee added to the native Rust implementation
    // (crates/codegraph-core/src/graph/algorithms/tarjan.rs) and to the
    // edge-list-based JS fallback (src/domain/graph/cycles.ts).
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'a');
    const first = tarjan(g);
    for (let i = 0; i < 25; i++) {
      expect(tarjan(g)).toEqual(first);
    }
  });

  it('sorts supplementary-plane Unicode node labels by code point, not UTF-16 code unit (#2292)', () => {
    // U+FFFF (BMP) vs U+1F600 (supplementary plane, surrogate pair). By code
    // point, U+FFFF < U+1F600 — matching Rust's UTF-8-byte-order string sort.
    // The default Array.sort() comparator (UTF-16 code unit order) gets this
    // pair backwards, which is exactly the cross-engine divergence Greptile
    // flagged when this fix's `.sort()` calls had no comparator.
    const bmp = '\uFFFF';
    const supplementary = '\u{1F600}';
    const g = new CodeGraph();
    g.addEdge(supplementary, bmp);
    g.addEdge(bmp, supplementary);
    const sccs = tarjan(g);
    expect(sccs).toEqual([[bmp, supplementary]]);
  });
});
