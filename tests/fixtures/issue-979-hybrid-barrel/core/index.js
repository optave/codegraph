// Hybrid barrel: re-exports from helpers.js AND has local definitions that call helpers.
export { doubleValue } from './helpers.js';

import { clampValue, doubleValue } from './helpers.js';

export function processValue(v) {
  return doubleValue(clampValue(v, 0, 100));
}

export function processAll(values) {
  return values.map((v) => processValue(v));
}
