/**
 * CJS compatibility wrapper — delegates to ESM via dynamic import().
 *
 * This wrapper always returns a Promise on every Node version, because
 * import() is unconditionally async. You must always await the result:
 *
 *   const codegraph = await require('@optave/codegraph');
 *
 * // Named destructuring at require-time does NOT work — always await the full result first.
 * // BAD:  const { buildGraph } = require('@optave/codegraph');  // buildGraph is undefined
 * // GOOD: const { buildGraph } = await require('@optave/codegraph');
 */
module.exports = import('./index.js');
