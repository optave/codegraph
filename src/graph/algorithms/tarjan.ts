import type { CodeGraph } from '../model.js';

/**
 * Tarjan's strongly connected components algorithm.
 * Operates on a CodeGraph instance.
 *
 * @returns SCCs with length > 1 (cycles)
 */
export function tarjan(graph: CodeGraph): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongconnect(v: string): void {
    // Assign the next discovery index and initialise lowlink to self
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.successors(v)) {
      if (!indices.has(w)) {
        // Tree edge: recurse then propagate lowlink upward
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        // Back/cross edge to a node still on the stack: update lowlink via index
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    // v is the root of an SCC when its lowlink equals its own discovery index
    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      // Only report non-trivial SCCs (length > 1 = a real cycle)
      if (scc.length > 1) {
        // Canonicalize node order within the SCC — mirrors the native Rust
        // implementation (crates/codegraph-core/src/graph/algorithms/
        // tarjan.rs), whose HashMap-backed adjacency map makes its DFS entry
        // point (and therefore stack-pop order) non-deterministic across
        // separate calls on the same logical graph. Sorting makes the
        // returned array a deterministic function of SCC membership alone,
        // so both engines agree byte-for-byte. See issues #2064, #2067, #2076.
        scc.sort();
        sccs.push(scc);
      }
    }
  }

  for (const id of graph.nodeIds()) {
    if (!indices.has(id)) strongconnect(id);
  }

  return sccs;
}
