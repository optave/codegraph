import { describe, expect, it } from 'vitest';
import { compareByCodePoint } from '../../src/shared/compare.js';

describe('compareByCodePoint', () => {
  it('orders plain ASCII strings the same as the default comparator', () => {
    const input = ['banana', 'apple', 'cherry'];
    expect([...input].sort(compareByCodePoint)).toEqual([...input].sort());
  });

  it('orders a supplementary-plane character after a BMP character near the surrogate range', () => {
    // U+FFFF (BMP, single UTF-16 code unit 0xFFFF) vs U+1F600 (supplementary
    // plane, surrogate pair 0xD83D 0xDE00). By code point, U+FFFF (65535) <
    // U+1F600 (128512). By UTF-16 code unit (the default Array.sort() comparator),
    // the high surrogate 0xD83D (55357) < 0xFFFF, so the default comparator gets
    // this backwards relative to code-point order — exactly the divergence from
    // Rust's UTF-8-byte-order string sort that issue #2292's Greptile review
    // flagged for the un-comparatored `.sort()` calls this fix replaces.
    const bmp = '\uFFFF';
    const supplementary = '\u{1F600}';
    expect(compareByCodePoint(bmp, supplementary)).toBeLessThan(0);
    expect(compareByCodePoint(supplementary, bmp)).toBeGreaterThan(0);
    expect([supplementary, bmp].sort(compareByCodePoint)).toEqual([bmp, supplementary]);
    // The default comparator gets this pair backwards — proof the two disagree.
    expect([supplementary, bmp].sort()).toEqual([supplementary, bmp]);
  });

  it('returns 0 for identical strings, including identical supplementary-plane strings', () => {
    expect(compareByCodePoint('abc', 'abc')).toBe(0);
    expect(compareByCodePoint('\u{1F600}', '\u{1F600}')).toBe(0);
  });

  it('orders a prefix before a longer string that extends it', () => {
    expect(compareByCodePoint('ab', 'abc')).toBeLessThan(0);
    expect(compareByCodePoint('abc', 'ab')).toBeGreaterThan(0);
  });
});
