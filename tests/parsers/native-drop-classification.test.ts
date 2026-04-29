import { describe, expect, it } from 'vitest';
import { classifyNativeDrops, NATIVE_SUPPORTED_EXTENSIONS } from '../../src/domain/parser.js';

describe('classifyNativeDrops', () => {
  it('groups WASM-only languages under unsupported-by-native', () => {
    const { byReason, totals } = classifyNativeDrops([
      'src/a.fs',
      'src/b.gleam',
      'src/c.clj',
      'src/d.jl',
      'src/e.R',
      'src/f.erl',
      'src/g.sol',
      'src/h.cu',
      'src/i.groovy',
      'src/j.v',
      'src/k.m',
    ]);
    expect(totals['unsupported-by-native']).toBe(11);
    expect(totals['native-extractor-failure']).toBe(0);
    expect(byReason['unsupported-by-native'].get('.fs')).toEqual(['src/a.fs']);
    expect(byReason['unsupported-by-native'].get('.gleam')).toEqual(['src/b.gleam']);
    expect(byReason['unsupported-by-native'].get('.r')).toEqual(['src/e.R']);
  });

  it('flags natively-supported extensions as native-extractor-failure', () => {
    const { byReason, totals } = classifyNativeDrops([
      'src/a.ts',
      'src/b.py',
      'src/c.go',
      'src/d.rs',
    ]);
    expect(totals['native-extractor-failure']).toBe(4);
    expect(totals['unsupported-by-native']).toBe(0);
    expect(byReason['native-extractor-failure'].get('.ts')).toEqual(['src/a.ts']);
    expect(byReason['native-extractor-failure'].get('.py')).toEqual(['src/b.py']);
  });

  it('handles a mix of supported and unsupported extensions', () => {
    const { byReason, totals } = classifyNativeDrops([
      'src/a.ts',
      'src/b.fs',
      'src/c.fs',
      'src/d.gleam',
    ]);
    expect(totals['native-extractor-failure']).toBe(1);
    expect(totals['unsupported-by-native']).toBe(3);
    expect(byReason['unsupported-by-native'].get('.fs')).toEqual(['src/b.fs', 'src/c.fs']);
    expect(byReason['unsupported-by-native'].get('.gleam')).toEqual(['src/d.gleam']);
  });

  it('lowercases extensions so .R and .r share a bucket', () => {
    const { byReason, totals } = classifyNativeDrops(['scripts/a.R', 'scripts/b.r']);
    expect(totals['unsupported-by-native']).toBe(2);
    expect(byReason['unsupported-by-native'].get('.r')).toEqual(['scripts/a.R', 'scripts/b.r']);
  });

  it('returns empty buckets when no files are passed', () => {
    const { byReason, totals } = classifyNativeDrops([]);
    expect(totals['native-extractor-failure']).toBe(0);
    expect(totals['unsupported-by-native']).toBe(0);
    expect(byReason['native-extractor-failure'].size).toBe(0);
    expect(byReason['unsupported-by-native'].size).toBe(0);
  });

  it('exposes the native-supported extension set for callers', () => {
    expect(NATIVE_SUPPORTED_EXTENSIONS.has('.ts')).toBe(true);
    expect(NATIVE_SUPPORTED_EXTENSIONS.has('.py')).toBe(true);
    expect(NATIVE_SUPPORTED_EXTENSIONS.has('.fs')).toBe(false);
    expect(NATIVE_SUPPORTED_EXTENSIONS.has('.gleam')).toBe(false);
  });
});
