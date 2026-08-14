// Hybrid file at the exact tie boundary (issue #2339): exactly one reexport
// and exactly one own definition. Under the old `reexports >= ownDefs`
// heuristic this was misclassified as barrel-only, so its own outgoing call
// edge to helper.js was silently dropped whenever this file got reparsed as
// a Stage 6b barrel candidate on an incremental rebuild.
export { Named } from './other.js';

import { helperFn } from './helper.js';

export function doWork(input) {
  return helperFn(input);
}
