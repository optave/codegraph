/**
 * CJS compatibility wrapper — delegates to ESM via dynamic import().
 *
 * Usage (async):
 *   const codegraph = await require('@optave/codegraph');
 *
 * If you are on Node >= 22, synchronous require() of ESM may work
 * automatically. On older versions, await the result.
 */
module.exports = import('./index.js');
