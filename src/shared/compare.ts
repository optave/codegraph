/**
 * Compare two strings by Unicode code point, not UTF-16 code unit — the
 * ordering `Array.prototype.sort()` uses with no comparator. For
 * supplementary-plane characters (code point > U+FFFF, encoded in UTF-16 as
 * a surrogate pair), code-unit order can diverge from code-point order,
 * which in turn diverges from Rust's `str`/`String` ordering (UTF-8 byte
 * order, which always matches code-point order). Use this wherever a JS/TS
 * sort result must agree byte-for-byte with the native engine's Rust string
 * sort on identical input (e.g. Tarjan SCC node arrays, issue #2292).
 */
export function compareByCodePoint(a: string, b: string): number {
  const aIter = a[Symbol.iterator]();
  const bIter = b[Symbol.iterator]();
  while (true) {
    const aNext = aIter.next();
    const bNext = bIter.next();
    if (aNext.done && bNext.done) return 0;
    if (aNext.done) return -1;
    if (bNext.done) return 1;
    const aCp = aNext.value.codePointAt(0) as number;
    const bCp = bNext.value.codePointAt(0) as number;
    if (aCp !== bCp) return aCp - bCp;
  }
}
