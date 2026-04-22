export function clampValue(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function doubleValue(v) {
  return v * 2;
}
