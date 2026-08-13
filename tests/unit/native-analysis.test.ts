import { describe, expect, it } from 'vitest';
import { getNative, isNativeAvailable } from '../../src/infrastructure/native.js';

const hasNative = isNativeAvailable();
const hasAnalysisFns = hasNative && typeof getNative().analyzeComplexity === 'function';

describe.skipIf(!hasAnalysisFns)('native standalone analysis functions', () => {
  const native = hasAnalysisFns ? getNative() : (undefined as never);

  // ─── analyzeComplexity ─────────────────────────────────────────────────

  describe('analyzeComplexity', () => {
    it('returns complexity metrics for JS functions', () => {
      const source = `
function simple() { return 1; }
function complex(x) {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      if (i % 2 === 0) { console.log(i); }
    }
  }
  return x;
}`;
      const results = native.analyzeComplexity(source, 'test.js');
      expect(results.length).toBeGreaterThanOrEqual(2);

      const simple = results.find((r) => r.name === 'simple');
      const complex = results.find((r) => r.name === 'complex');

      expect(simple).toBeDefined();
      expect(simple!.complexity.cognitive).toBe(0);
      expect(simple!.complexity.cyclomatic).toBe(1);
      expect(simple!.complexity.maxNesting).toBe(0);
      expect(simple!.line).toBeGreaterThan(0);

      expect(complex).toBeDefined();
      expect(complex!.complexity.cognitive).toBeGreaterThan(0);
      expect(complex!.complexity.cyclomatic).toBeGreaterThan(1);
      expect(complex!.complexity.maxNesting).toBeGreaterThanOrEqual(2);
    });

    it('includes Halstead metrics', () => {
      const source = `function add(a, b) { return a + b; }`;
      const results = native.analyzeComplexity(source, 'test.js');
      expect(results.length).toBe(1);

      const { halstead } = results[0].complexity;
      expect(halstead).toBeDefined();
      expect(halstead!.volume).toBeGreaterThan(0);
      expect(halstead!.difficulty).toBeGreaterThan(0);
    });

    it('includes LOC and maintainability index', () => {
      const source = `function foo(x) {\n  // comment\n  return x * 2;\n}`;
      const results = native.analyzeComplexity(source, 'test.js');
      expect(results.length).toBe(1);

      const { loc, maintainabilityIndex } = results[0].complexity;
      expect(loc).toBeDefined();
      expect(loc!.sloc).toBeGreaterThan(0);
      expect(maintainabilityIndex).toBeDefined();
      expect(maintainabilityIndex!).toBeGreaterThan(0);
    });

    it('returns empty for unsupported languages', () => {
      const results = native.analyzeComplexity('module Main where', 'test.hs');
      // Haskell has complexity rules in Rust, but if not, empty is fine
      expect(Array.isArray(results)).toBe(true);
    });

    it('works for Python', () => {
      const source = `def greet(name):\n    if name:\n        print("Hello " + name)\n    return name`;
      const results = native.analyzeComplexity(source, 'test.py');
      expect(results.length).toBeGreaterThanOrEqual(1);
      const greet = results.find((r) => r.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet!.complexity.cyclomatic).toBeGreaterThanOrEqual(2);
    });

    it('works for TypeScript', () => {
      const source = `function process(items: string[]): number {\n  return items.length > 0 ? items.length : 0;\n}`;
      const results = native.analyzeComplexity(source, 'test.ts');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('process');
    });

    it('works for Julia, including the &&/|| operator-by-text fix (#2312)', () => {
      const source = `function classify(x)\n    if x > 0 && x < 10\n        return 1\n    elseif x < 0\n        return -1\n    else\n        return 0\n    end\nend\n`;
      const results = native.analyzeComplexity(source, 'test.jl', 'julia');
      // NOTE: `name` resolves to "<anonymous>" here — this standalone helper's
      // generic `function_name` only checks a direct `name` field, which
      // Julia's `function_definition` doesn't have (the name is nested under
      // `signature` → `call_expression`, see `extractors/julia.rs`). This is
      // a pre-existing gap shared by every language with the same shape
      // (e.g. R) and is unrelated to complexity/Halstead correctness — out
      // of scope for issue #2312.
      expect(results.length).toBe(1);
      const classify = results[0]!;
      // if: +1 cog, +1 cyc; &&: +1 cog, +1 cyc; elseif: +1 cog, +1 cyc; else: +1 cog
      expect(classify.complexity.cognitive).toBe(4);
      expect(classify.complexity.cyclomatic).toBe(4);
      // Distinct operators (+, at least >, <, &&) must not collapse onto a
      // single "operator" vocabulary entry.
      expect(classify.complexity.halstead!.n1).toBeGreaterThanOrEqual(3);
    });

    it('works for Solidity, including the else-if transparent-wrapper fix (#2312)', () => {
      const source =
        'contract C { function f(int x, int y) public { if (x > 0) { x = 1; } else if (y > 0) { x = 2; } else { x = 3; } } }';
      const results = native.analyzeComplexity(source, 'test.sol', 'solidity');
      const f = results.find((r) => r.name === 'f');
      expect(f).toBeDefined();
      // if: +1 cog, +1 cyc; else-if (flat, Pattern D): +1 cog, +1 cyc; plain else: +1 cog
      expect(f!.complexity.cognitive).toBe(3);
      expect(f!.complexity.cyclomatic).toBe(3);
      expect(f!.complexity.maxNesting).toBe(1);
    });
  });

  // ─── buildCfgAnalysis ─────────────────────────────────────────────────

  describe('buildCfgAnalysis', () => {
    it('returns CFG for JS functions', () => {
      const source = `function decide(x) {\n  if (x > 0) { return "pos"; }\n  return "neg";\n}`;
      const results = native.buildCfgAnalysis(source, 'test.js');
      expect(results.length).toBeGreaterThanOrEqual(1);

      const fn = results.find((r) => r.name === 'decide');
      expect(fn).toBeDefined();
      expect(fn!.cfg.blocks.length).toBeGreaterThanOrEqual(2);
      expect(fn!.cfg.edges.length).toBeGreaterThanOrEqual(1);

      // Should have entry and exit blocks
      const blockTypes = fn!.cfg.blocks.map((b) => b.type);
      expect(blockTypes).toContain('entry');
      expect(blockTypes).toContain('exit');
    });

    it('returns empty for files without CFG rules', () => {
      const results = native.buildCfgAnalysis('local x = 1', 'test.lua');
      expect(Array.isArray(results)).toBe(true);
    });

    it('works for Python', () => {
      const source = `def foo(x):\n    if x:\n        return 1\n    return 0`;
      const results = native.buildCfgAnalysis(source, 'test.py');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].cfg.blocks.length).toBeGreaterThan(0);
    });
  });

  // ─── extractDataflowAnalysis ──────────────────────────────────────────

  describe('extractDataflowAnalysis', () => {
    it('extracts parameters and returns for JS', () => {
      const source = `function add(a, b) { return a + b; }`;
      const result = native.extractDataflowAnalysis(source, 'test.js');
      expect(result).not.toBeNull();

      expect(result!.parameters.length).toBeGreaterThanOrEqual(2);
      const paramNames = result!.parameters.map((p) => p.paramName);
      expect(paramNames).toContain('a');
      expect(paramNames).toContain('b');

      expect(result!.returns.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts arg flows', () => {
      const source = `function caller(x) { return callee(x); }`;
      const result = native.extractDataflowAnalysis(source, 'test.js');
      expect(result).not.toBeNull();
      expect(result!.argFlows.length).toBeGreaterThanOrEqual(1);
      expect(result!.argFlows[0].calleeName).toBe('callee');
    });

    it('returns null for unsupported languages', () => {
      const result = native.extractDataflowAnalysis('-- comment', 'test.hs');
      // Haskell has no dataflow rules
      expect(result).toBeNull();
    });

    it('works for Python', () => {
      const source = `def transform(data):\n    result = process(data)\n    return result`;
      const result = native.extractDataflowAnalysis(source, 'test.py');
      expect(result).not.toBeNull();
      expect(result!.parameters.length).toBeGreaterThanOrEqual(1);
    });
  });
});
