/**
 * Unit tests for isWasmAvailable() in src/parser.js
 */

import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeDeclarationHash,
  computeDeclarationHashes,
  isWasmAvailable,
  LANGUAGE_REGISTRY,
} from '../../src/domain/parser.js';
import type { Definition } from '../../src/types.js';

describe('isWasmAvailable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a boolean', () => {
    expect(typeof isWasmAvailable()).toBe('boolean');
  });

  it('returns true when all required grammar files exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(isWasmAvailable()).toBe(true);
  });

  it('returns false when any required grammar file is missing', () => {
    // First call returns true (JS), second returns false (TS missing)
    const mock = vi.spyOn(fs, 'existsSync');
    let callCount = 0;
    mock.mockImplementation(() => {
      callCount++;
      return callCount !== 2; // second required grammar "missing"
    });
    expect(isWasmAvailable()).toBe(false);
  });

  it('returns false when all required grammar files are missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(isWasmAvailable()).toBe(false);
  });

  it('only checks required grammars (JS, TS, TSX)', () => {
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    isWasmAvailable();

    const requiredEntries = LANGUAGE_REGISTRY.filter((e) => e.required);
    expect(requiredEntries.length).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);

    // Verify it checks the correct grammar files
    for (const entry of requiredEntries) {
      expect(spy).toHaveBeenCalledWith(expect.stringContaining(entry.grammarFile));
    }
  });

  it('checks files in the grammars/ directory', () => {
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    isWasmAvailable();

    for (const call of spy.mock.calls) {
      expect(call[0]).toContain('grammars');
    }
  });
});

// ─── computeDeclarationHash / computeDeclarationHashes (#2015) ──────────

function makeDefinition(overrides: Partial<Definition> = {}): Definition {
  return { name: 'f', kind: 'function', line: 1, ...overrides };
}

describe('computeDeclarationHash', () => {
  it('hashes identical body text identically', () => {
    const lines = ['fn a() {', '  1', '}', 'fn a() {', '  1', '}'];
    const hashA = computeDeclarationHash(lines, 1, 3);
    const hashB = computeDeclarationHash(lines, 4, 6);
    expect(hashA).toBeDefined();
    expect(hashA).toBe(hashB);
  });

  it('hashes different body text differently', () => {
    const lines = ['fn a() {', '  1', '}', 'fn b() {', '  2', '}'];
    const hashA = computeDeclarationHash(lines, 1, 3);
    const hashB = computeDeclarationHash(lines, 4, 6);
    expect(hashA).not.toBe(hashB);
  });

  it('returns undefined when endLine is unavailable', () => {
    expect(computeDeclarationHash(['fn a() {', '}'], 1, undefined)).toBeUndefined();
  });

  it('returns undefined for an out-of-range start line', () => {
    expect(computeDeclarationHash(['fn a() {', '}'], 99, 100)).toBeUndefined();
  });
});

describe('computeDeclarationHashes', () => {
  it('populates contentHash on top-level definitions and their children', () => {
    const source = 'function f() {\n  return 1;\n}\n';
    const defs: Definition[] = [
      makeDefinition({
        name: 'f',
        line: 1,
        endLine: 3,
        children: [{ name: 'child', kind: 'method', line: 1, endLine: 3 }],
      }),
    ];
    computeDeclarationHashes(defs, source);
    expect(defs[0]?.contentHash).toBeDefined();
    expect(defs[0]?.children?.[0]?.contentHash).toBeDefined();
  });

  it('does nothing for an empty or undefined definitions list', () => {
    expect(() => computeDeclarationHashes(undefined, 'code')).not.toThrow();
    expect(() => computeDeclarationHashes([], 'code')).not.toThrow();
  });
});
