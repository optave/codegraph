/**
 * Unit tests for src/complexity.js
 *
 * Hand-crafted code snippets parsed with tree-sitter to verify
 * exact cognitive/cyclomatic/nesting values.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers } from '../../src/domain/parser.js';
import {
  COMPLEXITY_RULES,
  computeAllMetrics,
  computeFunctionComplexity,
  computeHalsteadMetrics,
  computeLOCMetrics,
  computeMaintainabilityIndex,
  HALSTEAD_RULES,
} from '../../src/features/complexity.js';

let jsParser: any;

beforeAll(async () => {
  const parsers = await createParsers();
  jsParser = parsers.get('javascript');
});

function parse(code) {
  const tree = jsParser.parse(code);
  return tree.rootNode;
}

function getFunctionBody(root) {
  const rules = COMPLEXITY_RULES.get('javascript');
  function find(node) {
    if (rules.functionNodes.has(node.type)) return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = find(node.child(i));
      if (result) return result;
    }
    return null;
  }
  return find(root);
}

function analyze(code) {
  const root = parse(code);
  const funcNode = getFunctionBody(root);
  if (!funcNode) throw new Error('No function found in code snippet');
  return computeFunctionComplexity(funcNode, 'javascript');
}

describe('computeFunctionComplexity', () => {
  it('returns null for unsupported languages', () => {
    const result = computeFunctionComplexity({}, 'unknown_lang');
    expect(result).toBeNull();
  });

  it('simple function — no branching', () => {
    const result = analyze(`
      function simple(a, b) {
        return a + b;
      }
    `);
    expect(result).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if statement', () => {
    const result = analyze(`
      function check(x) {
        if (x > 0) {
          return true;
        }
        return false;
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('nested if', () => {
    const result = analyze(`
      function nested(x, y) {
        if (x > 0) {
          if (y > 0) {
            return true;
          }
        }
        return false;
      }
    `);
    expect(result).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('if / else-if / else chain', () => {
    const result = analyze(`
      function classify(x) {
        if (x > 0) {
          return 'positive';
        } else if (x < 0) {
          return 'negative';
        } else {
          return 'zero';
        }
      }
    `);
    expect(result).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('switch statement with cases', () => {
    const result = analyze(`
      function sw(x) {
        switch (x) {
          case 1: return 'one';
          case 2: return 'two';
          default: return 'other';
        }
      }
    `);
    expect(result.cognitive).toBe(1);
    expect(result.cyclomatic).toBe(3);
    expect(result.maxNesting).toBe(1);
  });

  it('logical operators — same operator sequence', () => {
    const result = analyze(`
      function check(a, b, c) {
        if (a && b && c) {
          return true;
        }
      }
    `);
    expect(result.cognitive).toBe(2);
    expect(result.cyclomatic).toBe(4);
  });

  it('logical operators — mixed operators', () => {
    const result = analyze(`
      function check(a, b, c) {
        if (a && b || c) {
          return true;
        }
      }
    `);
    expect(result.cognitive).toBe(3);
    expect(result.cyclomatic).toBe(4);
  });

  it('for loop with nested if', () => {
    const result = analyze(`
      function search(arr, target) {
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === target) {
            return i;
          }
        }
        return -1;
      }
    `);
    expect(result).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('try/catch', () => {
    const result = analyze(`
      function safeParse(str) {
        try {
          return JSON.parse(str);
        } catch (e) {
          return null;
        }
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('ternary expression', () => {
    const result = analyze(`
      function abs(x) {
        return x >= 0 ? x : -x;
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('nested lambda increases nesting', () => {
    const result = analyze(`
      function outer() {
        const inner = () => {
          if (true) {
            return 1;
          }
        };
      }
    `);
    expect(result.cognitive).toBe(2);
    expect(result.cyclomatic).toBe(2);
    expect(result.maxNesting).toBe(2);
  });

  it('while loop', () => {
    const result = analyze(`
      function countdown(n) {
        while (n > 0) {
          n--;
        }
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('do-while loop', () => {
    const result = analyze(`
      function atLeastOnce(n) {
        do {
          n--;
        } while (n > 0);
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('complex realistic function', () => {
    const result = analyze(`
      function processItems(items, options) {
        if (!items || items.length === 0) {
          return [];
        }
        const results = [];
        for (const item of items) {
          if (item.type === 'A') {
            if (item.value > 10) {
              results.push(item);
            }
          } else if (item.type === 'B') {
            try {
              results.push(transform(item));
            } catch (e) {
              if (options?.strict) {
                throw e;
              }
            }
          }
        }
        return results;
      }
    `);
    expect(result.cognitive).toBeGreaterThan(5);
    expect(result.cyclomatic).toBeGreaterThan(3);
    expect(result.maxNesting).toBeGreaterThanOrEqual(3);
  });
});

describe('COMPLEXITY_RULES', () => {
  it('supports javascript, typescript, tsx', () => {
    expect(COMPLEXITY_RULES.has('javascript')).toBe(true);
    expect(COMPLEXITY_RULES.has('typescript')).toBe(true);
    expect(COMPLEXITY_RULES.has('tsx')).toBe(true);
  });

  it('supports all 17 languages, not hcl', () => {
    for (const lang of [
      'python',
      'go',
      'rust',
      'java',
      'csharp',
      'ruby',
      'php',
      'c',
      'cpp',
      'kotlin',
      'swift',
      'scala',
      'bash',
      'lua',
    ]) {
      expect(COMPLEXITY_RULES.has(lang)).toBe(true);
    }
    expect(COMPLEXITY_RULES.has('hcl')).toBe(false);
  });
});

// ─── Halstead Metrics ─────────────────────────────────────────────────────

function analyzeHalstead(code) {
  const root = parse(code);
  const funcNode = getFunctionBody(root);
  if (!funcNode) throw new Error('No function found in code snippet');
  return computeHalsteadMetrics(funcNode, 'javascript');
}

describe('computeHalsteadMetrics', () => {
  it('returns null for unsupported language', () => {
    const result = computeHalsteadMetrics({}, 'unknown_lang');
    expect(result).toBeNull();
  });

  it('simple function has n1>0, n2>0, volume>0', () => {
    const result = analyzeHalstead(`
      function add(a, b) {
        return a + b;
      }
    `);
    expect(result).not.toBeNull();
    expect(result.n1).toBeGreaterThan(0);
    expect(result.n2).toBeGreaterThan(0);
    expect(result.volume).toBeGreaterThan(0);
    expect(result.difficulty).toBeGreaterThan(0);
    expect(result.effort).toBeGreaterThan(0);
    expect(result.bugs).toBeGreaterThan(0);
  });

  it('empty function body does not crash', () => {
    const result = analyzeHalstead(`
      function empty() {}
    `);
    expect(result).not.toBeNull();
    expect(result.vocabulary).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.volume)).toBe(true);
    expect(Number.isFinite(result.difficulty)).toBe(true);
  });

  it('complex function has greater volume than simple', () => {
    const simple = analyzeHalstead(`
      function add(a, b) { return a + b; }
    `);
    const complex = analyzeHalstead(`
      function process(items, options) {
        const results = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].type === 'A') {
            results.push(items[i].value * 2 + options.offset);
          } else if (items[i].type === 'B') {
            results.push(items[i].value / 3 - options.offset);
          }
        }
        return results;
      }
    `);
    expect(complex.volume).toBeGreaterThan(simple.volume);
  });

  it('repeated operands increase difficulty', () => {
    // Same identifier used many times vs distinct identifiers
    const repeated = analyzeHalstead(`
      function rep(x) {
        return x + x + x + x + x;
      }
    `);
    const distinct = analyzeHalstead(`
      function dist(a, b, c, d, e) {
        return a + b + c + d + e;
      }
    `);
    // With more distinct operands, difficulty per operand is lower
    expect(repeated.difficulty).toBeGreaterThan(distinct.difficulty);
  });
});

describe('HALSTEAD_RULES', () => {
  it('supports javascript, typescript, tsx', () => {
    expect(HALSTEAD_RULES.has('javascript')).toBe(true);
    expect(HALSTEAD_RULES.has('typescript')).toBe(true);
    expect(HALSTEAD_RULES.has('tsx')).toBe(true);
  });

  it('supports all 17 languages, not hcl', () => {
    for (const lang of [
      'python',
      'go',
      'rust',
      'java',
      'csharp',
      'ruby',
      'php',
      'c',
      'cpp',
      'kotlin',
      'swift',
      'scala',
      'bash',
      'lua',
    ]) {
      expect(HALSTEAD_RULES.has(lang)).toBe(true);
    }
    expect(HALSTEAD_RULES.has('hcl')).toBe(false);
  });
});

// ─── LOC Metrics ──────────────────────────────────────────────────────────

describe('computeLOCMetrics', () => {
  it('counts lines correctly', () => {
    const root = parse(`
      function multi(a, b) {
        // comment
        const x = a + b;

        return x;
      }
    `);
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    expect(result.loc).toBeGreaterThan(1);
    expect(result.sloc).toBeGreaterThan(0);
    expect(result.commentLines).toBeGreaterThanOrEqual(1);
  });

  it('detects comment lines', () => {
    const root = parse(`
      function commented() {
        // line comment
        /* block comment
         * continuation line
         */
        return 1;
      }
    `);
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    // // line comment, /* block comment, * continuation line, */ — 4 lines.
    expect(result.commentLines).toBeGreaterThanOrEqual(4);
  });

  it('does not treat a bare "*" line as a comment unless a real block comment is open (issue #2287)', () => {
    // A multiplication-operator continuation line is real JS code that
    // starts with a bare "*" — with no preceding, still-open `/*`, it must
    // not be misclassified as a Javadoc-style comment continuation. (The
    // Rust `loc()` test below covers the issue's own pointer-dereference
    // repro, which JS has no equivalent syntax for.)
    const root = parse(`
      function notAComment() {
        const x = 5
          * 2;
        return x;
      }
    `);
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    expect(result.commentLines).toBe(0);
  });

  it('SLOC excludes blanks and comments', () => {
    const root = parse(`
      function blank() {

        // comment

        return 1;
      }
    `);
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    expect(result.sloc).toBeLessThan(result.loc);
  });

  it('single-line function', () => {
    const root = parse('function one() { return 1; }');
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    expect(result.loc).toBe(1);
    expect(result.sloc).toBe(1);
    expect(result.commentLines).toBe(0);
  });
});

// ─── Maintainability Index ────────────────────────────────────────────────

describe('computeMaintainabilityIndex', () => {
  it('trivial function has high MI (>70)', () => {
    // Low volume, low cyclomatic, low SLOC → high MI
    const mi = computeMaintainabilityIndex(10, 1, 3);
    expect(mi).toBeGreaterThan(70);
  });

  it('complex function has low MI (<30)', () => {
    // High volume, high cyclomatic, high SLOC → low MI
    const mi = computeMaintainabilityIndex(5000, 30, 200);
    expect(mi).toBeLessThan(30);
  });

  it('comments improve MI', () => {
    const without = computeMaintainabilityIndex(500, 10, 50);
    const with_ = computeMaintainabilityIndex(500, 10, 50, 0.3);
    expect(with_).toBeGreaterThan(without);
  });

  it('normalized to 0-100 range', () => {
    // Very high values should clamp to 0
    const low = computeMaintainabilityIndex(100000, 100, 5000);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(100);

    // Very low values should clamp near 100
    const high = computeMaintainabilityIndex(1, 1, 1);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(100);
  });

  it('handles zero guards (no NaN/Infinity)', () => {
    const result = computeMaintainabilityIndex(0, 0, 0);
    expect(Number.isFinite(result)).toBe(true);
    expect(Number.isNaN(result)).toBe(false);

    const result2 = computeMaintainabilityIndex(0, 0, 0, 0);
    expect(Number.isFinite(result2)).toBe(true);
  });
});

// ─── Multi-Language Complexity Tests ─────────────────────────────────────

function makeHelpers(langId, parsersPromise) {
  const rules = COMPLEXITY_RULES.get(langId);
  let parser: any;
  let available = false;
  beforeAll(async () => {
    const parsers = await parsersPromise;
    parser = parsers.get(langId);
    available = !!parser;
  });
  beforeEach(({ skip }) => {
    if (!available) skip();
  });
  const parse = (code) => parser.parse(code).rootNode;
  const getFunction = (root) => {
    function find(node) {
      if (rules.functionNodes.has(node.type)) return node;
      for (let i = 0; i < node.childCount; i++) {
        const r = find(node.child(i));
        if (r) return r;
      }
      return null;
    }
    return find(root);
  };
  const analyze = (code) => {
    const funcNode = getFunction(parse(code));
    if (!funcNode) throw new Error(`No function found in ${langId} snippet`);
    return computeFunctionComplexity(funcNode, langId);
  };
  const halstead = (code) => {
    const funcNode = getFunction(parse(code));
    if (!funcNode) throw new Error(`No function found in ${langId} snippet`);
    return computeHalsteadMetrics(funcNode, langId);
  };
  const loc = (code) => {
    const funcNode = getFunction(parse(code));
    if (!funcNode) throw new Error(`No function found in ${langId} snippet`);
    return computeLOCMetrics(funcNode, langId);
  };
  return { parse, getFunction, analyze, halstead, loc };
}

// Shared parsers promise to avoid re-initializing per suite
let _parsersPromise: any;
function sharedParsers() {
  if (!_parsersPromise) _parsersPromise = createParsers();
  return _parsersPromise;
}

// ─── Python ──────────────────────────────────────────────────────────────

describe('Python complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('python', sharedParsers());

  it('simple function', () => {
    const r = analyze('def add(a, b):\n    return a + b\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze('def check(x):\n    if x > 0:\n        return True\n    return False\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/elif/else chain', () => {
    const r = analyze(
      'def classify(x):\n    if x > 0:\n        return "pos"\n    elif x < 0:\n        return "neg"\n    else:\n        return "zero"\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'def nested(x, y):\n    if x > 0:\n        if y > 0:\n            return True\n    return False\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('for loop with condition', () => {
    const r = analyze(
      'def search(arr, t):\n    for item in arr:\n        if item == t:\n            return True\n    return False\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('while loop', () => {
    const r = analyze('def countdown(n):\n    while n > 0:\n        n -= 1\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('try/except', () => {
    const r = analyze(
      'def safe(s):\n    try:\n        return int(s)\n    except ValueError:\n        return None\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators', () => {
    const r = analyze('def check(a, b):\n    if a and b:\n        return True\n');
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('def add(a, b):\n    return a + b\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: # comments detected', () => {
    const l = loc('def f():\n    # comment\n    return 1\n');
    expect(l.commentLines).toBeGreaterThanOrEqual(1);
  });
});

// ─── Go ──────────────────────────────────────────────────────────────────

describe('Go complexity', () => {
  const { analyze, halstead } = makeHelpers('go', sharedParsers());

  it('simple function', () => {
    const r = analyze('package main\nfunc add(a int, b int) int {\n\treturn a + b\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'package main\nfunc check(x int) bool {\n\tif x > 0 {\n\t\treturn true\n\t}\n\treturn false\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    const r = analyze(
      'package main\nfunc classify(x int) string {\n\tif x > 0 {\n\t\treturn "pos"\n\t} else if x < 0 {\n\t\treturn "neg"\n\t} else {\n\t\treturn "zero"\n\t}\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'package main\nfunc nested(x int, y int) bool {\n\tif x > 0 {\n\t\tif y > 0 {\n\t\t\treturn true\n\t\t}\n\t}\n\treturn false\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('for loop with condition', () => {
    const r = analyze(
      'package main\nfunc search(arr []int, t int) bool {\n\tfor _, v := range arr {\n\t\tif v == t {\n\t\t\treturn true\n\t\t}\n\t}\n\treturn false\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('switch', () => {
    const r = analyze(
      'package main\nfunc sw(x int) string {\n\tswitch x {\n\tcase 1:\n\t\treturn "one"\n\tcase 2:\n\t\treturn "two"\n\tdefault:\n\t\treturn "other"\n\t}\n}\n',
    );
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('logical operators', () => {
    const r = analyze(
      'package main\nfunc check(a bool, b bool) bool {\n\tif a && b {\n\t\treturn true\n\t}\n\treturn false\n}\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('package main\nfunc add(a int, b int) int {\n\treturn a + b\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Rust ────────────────────────────────────────────────────────────────

describe('Rust complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('rust', sharedParsers());

  it('simple function', () => {
    const r = analyze('fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'fn check(x: i32) -> bool {\n    if x > 0 {\n        return true;\n    }\n    false\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    const r = analyze(
      'fn classify(x: i32) -> &str {\n    if x > 0 {\n        "pos"\n    } else if x < 0 {\n        "neg"\n    } else {\n        "zero"\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'fn nested(x: i32, y: i32) -> bool {\n    if x > 0 {\n        if y > 0 {\n            return true;\n        }\n    }\n    false\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('loop with condition', () => {
    const r = analyze(
      'fn search(arr: &[i32], t: i32) -> bool {\n    for v in arr {\n        if *v == t {\n            return true;\n        }\n    }\n    false\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('match expression', () => {
    const r = analyze(
      'fn sw(x: i32) -> &str {\n    match x {\n        1 => "one",\n        2 => "two",\n        _ => "other",\n    }\n}\n',
    );
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('logical operators', () => {
    const r = analyze(
      'fn check(a: bool, b: bool) -> bool {\n    if a && b {\n        return true;\n    }\n    false\n}\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: does not misclassify pointer-dereference assignments as comment continuation lines (issue #2287)', () => {
    // A bare `*` prefix (trusted unconditionally by the old flat
    // comment-prefix list, to match Javadoc-style `* ...` continuation
    // lines) also opens a pointer-dereference assignment in Rust — this is
    // the issue's own exact repro.
    const l = loc(
      'fn deref_heavy(ptr: *mut i32) -> i32 {\n    unsafe {\n        *ptr = 5;\n        *ptr = *ptr + 1;\n        return *ptr;\n    }\n}\n',
    );
    expect(l.commentLines).toBe(0);
    expect(l.sloc).toBe(l.loc);
  });

  it('LOC: still tracks a genuine multi-line block comment inside the function body', () => {
    const l = loc(
      'fn documented() -> i32 {\n    /**\n     * Doc comment.\n     * More doc.\n     */\n    1\n}\n',
    );
    expect(l.commentLines).toBe(4);
  });

  it('LOC: does not close a nested Rust block comment at the inner closing marker (Greptile review, PR #2456)', () => {
    // Rust (unlike the other block-comment languages here) allows block
    // comments to nest. A boolean in/out-of-comment state closes at the
    // FIRST closing marker, wrongly ending the comment at the inner one and
    // counting the remaining outer-comment lines as SLOC.
    const l = loc(
      'fn documented() -> i32 {\n    /* outer\n     /* inner */\n     still outer\n     */\n    1\n}\n',
    );
    // /* outer, /* inner */, still outer, */ — all 4 lines are comment.
    expect(l.commentLines).toBe(4);
  });

  it('LOC: a single-line nested Rust block comment still closes fully', () => {
    const l = loc('fn f() -> i32 {\n    /* outer /* inner */ still outer */\n    1\n}\n');
    expect(l.commentLines).toBe(1);
    expect(l.sloc).toBe(l.loc - l.commentLines);
  });
});

// ─── Java ────────────────────────────────────────────────────────────────

describe('Java complexity', () => {
  const { analyze, halstead } = makeHelpers('java', sharedParsers());

  it('simple method', () => {
    const r = analyze('class C {\n    int add(int a, int b) {\n        return a + b;\n    }\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'class C {\n    boolean check(int x) {\n        if (x > 0) {\n            return true;\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    const r = analyze(
      'class C {\n    String classify(int x) {\n        if (x > 0) {\n            return "pos";\n        } else if (x < 0) {\n            return "neg";\n        } else {\n            return "zero";\n        }\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'class C {\n    boolean nested(int x, int y) {\n        if (x > 0) {\n            if (y > 0) {\n                return true;\n            }\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('for loop with condition', () => {
    const r = analyze(
      'class C {\n    int search(int[] arr, int t) {\n        for (int i = 0; i < arr.length; i++) {\n            if (arr[i] == t) {\n                return i;\n            }\n        }\n        return -1;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('try/catch', () => {
    const r = analyze(
      'class C {\n    int safe(String s) {\n        try {\n            return Integer.parseInt(s);\n        } catch (Exception e) {\n            return 0;\n        }\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators', () => {
    const r = analyze(
      'class C {\n    boolean check(boolean a, boolean b) {\n        if (a && b) {\n            return true;\n        }\n        return false;\n    }\n}\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('class C {\n    int add(int a, int b) {\n        return a + b;\n    }\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── C# ──────────────────────────────────────────────────────────────────

describe('C# complexity', () => {
  const { analyze, halstead } = makeHelpers('csharp', sharedParsers());

  it('simple method', () => {
    const r = analyze('class C {\n    int Add(int a, int b) {\n        return a + b;\n    }\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'class C {\n    bool Check(int x) {\n        if (x > 0) {\n            return true;\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    const r = analyze(
      'class C {\n    string Classify(int x) {\n        if (x > 0) {\n            return "pos";\n        } else if (x < 0) {\n            return "neg";\n        } else {\n            return "zero";\n        }\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'class C {\n    bool Nested(int x, int y) {\n        if (x > 0) {\n            if (y > 0) {\n                return true;\n            }\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('foreach with condition', () => {
    const r = analyze(
      'class C {\n    bool Search(int[] arr, int t) {\n        foreach (var v in arr) {\n            if (v == t) {\n                return true;\n            }\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('switch', () => {
    const r = analyze(
      'class C {\n    string Sw(int x) {\n        switch (x) {\n            case 1: return "one";\n            case 2: return "two";\n            default: return "other";\n        }\n    }\n}\n',
    );
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('try/catch', () => {
    const r = analyze(
      'class C {\n    int Safe(string s) {\n        try {\n            return int.Parse(s);\n        } catch (Exception e) {\n            return 0;\n        }\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('class C {\n    int Add(int a, int b) {\n        return a + b;\n    }\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Ruby ────────────────────────────────────────────────────────────────

describe('Ruby complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('ruby', sharedParsers());

  it('simple method', () => {
    const r = analyze('def add(a, b)\n  a + b\nend\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze('def check(x)\n  if x > 0\n    return true\n  end\n  false\nend\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/elsif/else chain', () => {
    const r = analyze(
      'def classify(x)\n  if x > 0\n    "pos"\n  elsif x < 0\n    "neg"\n  else\n    "zero"\n  end\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'def nested(x, y)\n  if x > 0\n    if y > 0\n      return true\n    end\n  end\n  false\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('while loop', () => {
    const r = analyze('def countdown(n)\n  while n > 0\n    n -= 1\n  end\nend\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('case/when', () => {
    const r = analyze(
      'def sw(x)\n  case x\n  when 1\n    "one"\n  when 2\n    "two"\n  else\n    "other"\n  end\nend\n',
    );
    expect(r.cognitive).toBe(2); // case + else
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('logical operators', () => {
    const r = analyze('def check(a, b)\n  if a && b\n    return true\n  end\n  false\nend\n');
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('def add(a, b)\n  a + b\nend\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: # comments detected', () => {
    const l = loc('def f()\n  # comment\n  1\nend\n');
    expect(l.commentLines).toBeGreaterThanOrEqual(1);
  });
});

// ─── PHP ─────────────────────────────────────────────────────────────────

describe('PHP complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('php', sharedParsers());

  it('simple function', () => {
    const r = analyze('<?php\nfunction add($a, $b) {\n    return $a + $b;\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      '<?php\nfunction check($x) {\n    if ($x > 0) {\n        return true;\n    }\n    return false;\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/elseif/else chain', () => {
    const r = analyze(
      '<?php\nfunction classify($x) {\n    if ($x > 0) {\n        return "pos";\n    } elseif ($x < 0) {\n        return "neg";\n    } else {\n        return "zero";\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      '<?php\nfunction nested($x, $y) {\n    if ($x > 0) {\n        if ($y > 0) {\n            return true;\n        }\n    }\n    return false;\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('foreach with condition', () => {
    const r = analyze(
      '<?php\nfunction search($arr, $t) {\n    foreach ($arr as $v) {\n        if ($v == $t) {\n            return true;\n        }\n    }\n    return false;\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('switch', () => {
    const r = analyze(
      '<?php\nfunction sw($x) {\n    switch ($x) {\n        case 1: return "one";\n        case 2: return "two";\n        default: return "other";\n    }\n}\n',
    );
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('try/catch', () => {
    const r = analyze(
      '<?php\nfunction safe($s) {\n    try {\n        return intval($s);\n    } catch (Exception $e) {\n        return 0;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators', () => {
    const r = analyze(
      '<?php\nfunction check($a, $b) {\n    if ($a && $b) {\n        return true;\n    }\n    return false;\n}\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('<?php\nfunction add($a, $b) {\n    return $a + $b;\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: # and // comments detected', () => {
    const l = loc(
      '<?php\nfunction f() {\n    # hash comment\n    // slash comment\n    return 1;\n}\n',
    );
    expect(l.commentLines).toBeGreaterThanOrEqual(2);
  });
});

// ─── Lua (#1782) ─────────────────────────────────────────────────────────

describe('Lua complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('lua', sharedParsers());

  it('simple function', () => {
    const r = analyze('local function add(a, b)\n  return a + b\nend\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'local function check(x)\n  if x > 0 then\n    return true\n  end\n  return false\nend\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/elseif/else chain', () => {
    // elseif_statement/else_statement are flat siblings of if_statement
    // (repeated `alternative:` fields), not nested — same shape as Python's
    // elif_clause/else_clause.
    const r = analyze(
      'local function classify(x)\n  if x > 0 then\n    return "pos"\n  elseif x < 0 then\n    return "neg"\n  else\n    return "zero"\n  end\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'local function nested(x, y)\n  if x > 0 then\n    if y > 0 then\n      return true\n    end\n  end\n  return false\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('numeric for loop with condition', () => {
    const r = analyze(
      'local function search(arr, t)\n  for i = 1, #arr do\n    if arr[i] == t then\n      return true\n    end\n  end\n  return false\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('generic for-in loop', () => {
    const r = analyze(
      'local function search(t, target)\n  for k, v in pairs(t) do\n    if v == target then\n      return k\n    end\n  end\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('while loop', () => {
    const r = analyze('local function countdown(n)\n  while n > 0 do\n    n = n - 1\n  end\nend\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('repeat/until loop', () => {
    const r = analyze(
      'local function countdown(n)\n  repeat\n    n = n - 1\n  until n <= 0\nend\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators', () => {
    const r = analyze(
      'local function check(a, b)\n  if a and b then\n    return true\n  end\nend\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('method declaration (colon syntax) is recognized as a function', () => {
    const r = analyze(
      'local Obj = {}\nfunction Obj:method(x)\n  if x > 0 then\n    return x\n  end\nend\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('local function add(a, b)\n  return a + b\nend\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: -- comments detected', () => {
    const l = loc('local function f()\n  -- comment\n  return 1\nend\n');
    expect(l.commentLines).toBeGreaterThanOrEqual(1);
  });
});

// ─── C (#1923) ────────────────────────────────────────────────────────────

describe('C complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('c', sharedParsers());

  it('simple function', () => {
    const r = analyze('int add(int a, int b) {\n  return a + b;\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze('int check(int x) {\n  if (x > 0) {\n    return 1;\n  }\n  return 0;\n}\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    // tree-sitter-c wraps the else branch in a real else_clause node
    // (Pattern A, like JS/C#/Rust) — NOT Go/Java's alternative-field
    // pattern, confirmed by parsing and inspecting the S-expression.
    const r = analyze(
      'int classify(int x) {\n  if (x > 0) {\n    return 1;\n  } else if (x < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'int nested(int x, int y) {\n  if (x > 0) {\n    if (y > 0) {\n      return 1;\n    }\n  }\n  return 0;\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('logical operators', () => {
    const r = analyze('int check(int a, int b) {\n  return a && b;\n}\n');
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBe(2);
  });

  it('switch with a multi-value case (issue #2058)', () => {
    // Regression guard: switch_statement (the container) must be in
    // branchNodes + nestingNodes (net-zero cyclomatic, contributing nesting
    // once), and case_statement (each arm) must be in caseNodes ONLY (flat
    // cyclomatic += 1, no per-case cognitive/nesting weight) — not also in
    // branchNodes, which previously shadowed the case treatment with a
    // nesting-weighted generic branch treatment for every arm.
    const r = analyze(
      'int classify(int x) {\n  switch (x) {\n    case 1:\n      return 1;\n    case 2:\n    case 3:\n      return 2;\n    default:\n      return 0;\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 5, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('int add(int a, int b) {\n  return a + b;\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: // and /* comments detected', () => {
    const l = loc('int f() {\n  // slash comment\n  return 1;\n}\n');
    expect(l.commentLines).toBeGreaterThanOrEqual(1);
  });

  it('LOC: /** ... */ continuation lines counted as comments (issue #2058)', () => {
    // Regression guard: c/cpp/objc/kotlin/swift/scala previously used a
    // 2-entry ["//", "/*"] prefix list that missed bare `*`/`*/`
    // continuation lines, undercounting commentLines for any multi-line
    // Javadoc-style comment.
    const l = loc(
      'int f() {\n  /**\n   * Multi-line comment.\n   * Second line.\n   */\n  return 1;\n}\n',
    );
    expect(l.commentLines).toBe(4);
  });
});

// ─── C++ (#1923) ──────────────────────────────────────────────────────────

describe('C++ complexity', () => {
  const { analyze, halstead } = makeHelpers('cpp', sharedParsers());

  it('if/else-if/else chain', () => {
    // Uses the same else_clause wrapper (Pattern A) as C, confirmed by
    // parsing the same shape with tree-sitter-cpp.
    const r = analyze(
      'int classify(int x) {\n  if (x > 0) {\n    return 1;\n  } else if (x < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('for-range loop', () => {
    const r = analyze('void f(int xs[]) {\n  for (int x : xs) {\n    use(x);\n  }\n}\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('switch with a multi-value case (issue #2058)', () => {
    // Same branchNodes/caseNodes fix as C's equivalent test — see comment there.
    const r = analyze(
      'int classify(int x) {\n  switch (x) {\n    case 1:\n      return 1;\n    case 2:\n    case 3:\n      return 2;\n    default:\n      return 0;\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 5, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('int add(int a, int b) {\n  return a + b;\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── CUDA (#1923) ─────────────────────────────────────────────────────────
//
// tree-sitter-cuda is a C++-superset grammar (only adding qualifier keywords
// like __global__/__device__ and kernel-launch syntax) — confirmed by
// parsing sample CUDA control flow that its if_statement/else_clause/
// for_statement/while_statement/switch_statement/binary_expression node
// kinds are identical to plain C++, so CUDA reuses complexityCpp/halsteadCpp
// as-is rather than a separate rule set.

describe('CUDA complexity', () => {
  const { analyze, halstead } = makeHelpers('cuda', sharedParsers());

  it('__global__ kernel with if/else-if/else chain', () => {
    // The __global__ qualifier is a leading anonymous token on
    // function_definition and does not disrupt function-body detection.
    const r = analyze(
      '__global__ void classify(int *a) {\n  if (a[0] > 0) {\n    a[0] = 1;\n  } else if (a[0] < 0) {\n    a[0] = -1;\n  } else {\n    a[0] = 0;\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('for loop with logical operator condition', () => {
    const r = analyze(
      '__global__ void kernel(int *a, int n) {\n  for (int i = 0; i < n && a[i] > 0; i++) {\n    a[i]++;\n  }\n}\n',
    );
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('__device__ int add(int a, int b) {\n  return a + b;\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Objective-C (#1923) ──────────────────────────────────────────────────
//
// tree-sitter-objc extends tree-sitter-c: if/else/for/while/switch/case/
// logical-operator node kinds are identical to plain C (confirmed by parsing
// sample ObjC control flow and inspecting the S-expression), so complexityObjC
// reuses the same shapes as C's rules, plus `method_definition` in
// functionNodes and `catch_clause` (from `@try`/`@catch`) as a branch/nesting
// node — mirroring how C++'s catch_clause is already treated.

describe('ObjC complexity', () => {
  const { analyze, halstead } = makeHelpers('objc', sharedParsers());

  it('method with if/else-if/else chain', () => {
    // method_definition's compound_statement body is a direct child (unlike
    // tree-sitter-dart's function_signature/function_body sibling split,
    // #2182) — confirmed by parsing this fixture.
    const r = analyze(
      '@implementation Calculator\n- (NSInteger)classify:(NSInteger)value {\n  if (value > 0) {\n    return 1;\n  } else if (value < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}\n@end\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('method with logical operators and for loop', () => {
    const r = analyze(
      '@implementation Calculator\n- (NSInteger)sum:(NSInteger)n withFlag:(BOOL)flag {\n  NSInteger result = 0;\n  for (NSInteger i = 0; i < n && flag; i++) {\n    result += i;\n  }\n  return result;\n}\n@end\n',
    );
    expect(r.cyclomatic).toBe(3);
    expect(r.maxNesting).toBe(1);
  });

  it('method with @try/@catch', () => {
    const r = analyze(
      '@implementation Calculator\n- (NSInteger)risky {\n  @try {\n    return 1;\n  } @catch (NSException *ex) {\n    return -1;\n  }\n}\n@end\n',
    );
    // catch_clause: +1 cog, +1 cyc, +1 nesting (mirrors C++'s/JS's catch_clause treatment)
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('plain C-style function still works', () => {
    const r = analyze(
      'NSInteger plainFunction(NSInteger a, NSInteger b) {\n  if (a > b) {\n    return a;\n  }\n  return b;\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('switch with a multi-value case (issue #2058)', () => {
    // Same branchNodes/caseNodes fix as C's equivalent test (see comment
    // there) — inherited the bug via copy from C's rules when ObjC was added.
    const r = analyze(
      '@implementation Calculator\n- (NSInteger)classify:(NSInteger)x {\n  switch (x) {\n    case 1:\n      return 1;\n    case 2:\n    case 3:\n      return 2;\n    default:\n      return 0;\n  }\n}\n@end\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 5, maxNesting: 1 });
  });

  it('halstead: message send and positive volume', () => {
    const h = halstead(
      '@implementation Calculator\n- (NSInteger)sum {\n  return [self compute];\n}\n@end\n',
    );
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Zig (#1923) ──────────────────────────────────────────────────────────
//
// tree-sitter-zig wraps its else branch in an else_clause node (Pattern A,
// same as JS/C#/Rust/ObjC), confirmed by parsing if/else-if/else and
// inspecting the S-expression. and/or/orelse are keyword operators sharing
// the generic binary_expression node type (same shared-type pattern as
// Lua's and/or). catch_expression is a branch/nesting node (its fallback
// can be an arbitrary block with its own control flow); try_expression is
// Halstead-only, mirroring Rust's `?` operator.

describe('Zig complexity', () => {
  const { analyze, halstead } = makeHelpers('zig', sharedParsers());

  it('function with if/else-if/else chain', () => {
    const r = analyze(
      'pub fn classify(value: i32) i32 {\n    if (value > 0) {\n        return 1;\n    } else if (value < 0) {\n        return -1;\n    } else {\n        return 0;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('while loop with orelse', () => {
    const r = analyze(
      'pub fn sum(n: i32, opt: ?i32) i32 {\n    var result: i32 = opt orelse 0;\n    var i: i32 = 0;\n    while (i < n) {\n        result += i;\n        i += 1;\n    }\n    return result;\n}\n',
    );
    expect(r).toEqual({ cognitive: 2, cyclomatic: 3, maxNesting: 1 });
  });

  it('for-range loop with switch (multi-value case)', () => {
    const r = analyze(
      'pub fn tally(n: i32) i32 {\n    var total: i32 = 0;\n    for (0..n) |i| {\n        switch (i) {\n            0 => total += 1,\n            1, 2 => total += 2,\n            else => total += 0,\n        }\n    }\n    return total;\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 5, maxNesting: 2 });
  });

  it('catch with error-payload block is a branch', () => {
    const r = analyze(
      'pub fn risky() i32 {\n    const v = mayFail() catch |err| {\n        _ = err;\n        return -1;\n    };\n    return v;\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it("try is Halstead-only, not a branch (mirrors Rust's ?)", () => {
    const r = analyze('pub fn wrapper() !i32 {\n    const v = try mayFail();\n    return v;\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('pub fn add(a: i32, b: i32) i32 {\n    return a + b;\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// tree-sitter-r's if_statement carries consequence/alternative fields
// directly — there is no else_clause wrapper node, so an else-if chain is a
// nested if_statement reached via the alternative field (Pattern C, same as
// Go/Java), confirmed by parsing. R has no switch statement (`switch(x, ...)`
// is an ordinary function call). `repeat` is an unconditional loop, the same
// treatment Rust's `loop` gets.

describe('R complexity (#1923)', () => {
  const { analyze, halstead } = makeHelpers('r', sharedParsers());

  it('function with if/else-if/else chain', () => {
    const r = analyze(
      'f <- function(x) {\n  if (x > 0) {\n    return(1)\n  } else if (x < 0) {\n    return(-1)\n  } else {\n    return(0)\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('for loop', () => {
    const r = analyze('f <- function() {\n  for (i in 1:10) {\n    print(i)\n  }\n}\n');
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBe(2);
  });

  it('repeat loop is a branch/nesting node', () => {
    const r = analyze('f <- function() {\n  repeat {\n    break\n  }\n}\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('mixed && / || logical operators', () => {
    const r = analyze('f <- function(a, b, c) {\n  if (a && b || c) {\n    return(1)\n  }\n}\n');
    expect(r.cognitive).toBe(3);
    expect(r.cyclomatic).toBe(4);
  });

  it('halstead: positive volume', () => {
    const h = halstead('f <- function(a, b) {\n  return(a + b)\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// tree-sitter-groovy extends tree-sitter-java's grammar, confirmed by
// parsing sample if/else-if/else, do-while, and switch/case: node kinds and
// field names are byte-identical to Java's (alternative field on
// if_statement, no else_clause wrapper).

describe('Groovy complexity (#1923)', () => {
  const { analyze, halstead } = makeHelpers('groovy', sharedParsers());

  it('function with if/else-if/else chain', () => {
    const r = analyze(
      'def f(x) {\n    if (x > 0) {\n        return 1\n    } else if (x < 0) {\n        return -1\n    } else {\n        return 0\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('do-while loop', () => {
    const r = analyze('def f(x) {\n    do {\n        x = x - 1\n    } while (x > 0)\n}\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('switch with multi-value case', () => {
    const r = analyze(
      'def f(x) {\n    switch (x) {\n        case 1:\n            break\n        case 2:\n        case 3:\n            break\n        default:\n            break\n    }\n}\n',
    );
    expect(r.cyclomatic).toBe(5);
  });

  it('mixed && / || logical operators', () => {
    const r = analyze('def f(a, b, c) {\n    if (a && b || c) {\n        return 1\n    }\n}\n');
    expect(r.cognitive).toBe(3);
    expect(r.cyclomatic).toBe(4);
  });

  it('halstead: positive volume', () => {
    const h = halstead('def f(a, b) {\n    return a + b\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Kotlin (#1923) ───────────────────────────────────────────────────────

describe('Kotlin complexity', () => {
  const { analyze, halstead } = makeHelpers('kotlin', sharedParsers());

  it('simple function', () => {
    const r = analyze('fun add(a: Int, b: Int): Int {\n  return a + b\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'fun check(x: Int): Int {\n  if (x > 0) {\n    return 1\n  }\n  return 0\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators (conjunction_expression / disjunction_expression)', () => {
    // Kotlin's grammar splits && / || into distinct node types rather than
    // sharing one generic binary node — both are in logicalNodeTypes.
    const r = analyze('fun check(a: Boolean, b: Boolean): Boolean {\n  return a && b || a\n}\n');
    expect(r.cyclomatic).toBe(3);
  });

  it('when expression', () => {
    // Regression guard (issue #2058): when_entry (each case arm) must not
    // also be in branchNodes — that shadowed the flat case treatment with
    // nesting-weighted branch treatment, inflating cognitive from 1 to 7 for
    // this fixture even though cyclomatic happened to stay 4 either way
    // (each arm contributes +1 via either code path).
    const r = analyze(
      'fun classify(x: Int): Int {\n  return when (x) {\n    1 -> 1\n    2 -> 2\n    else -> 0\n  }\n}\n',
    );
    // base 1 + when container (0, switch-like) + 3 when_entry cases (+1 each) = 4
    expect(r).toEqual({ cognitive: 1, cyclomatic: 4, maxNesting: 1 });
  });

  it('when expression with a multi-value case (issue #2058)', () => {
    const r = analyze(
      'fun classify(x: Int): Int {\n  return when (x) {\n    1 -> 1\n    2, 3 -> 2\n    else -> 0\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 4, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('fun add(a: Int, b: Int): Int {\n  return a + b\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Swift (#1923) ────────────────────────────────────────────────────────

describe('Swift complexity', () => {
  const { analyze, halstead } = makeHelpers('swift', sharedParsers());

  it('simple function', () => {
    const r = analyze('func add(_ a: Int, _ b: Int) -> Int {\n  return a + b\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'func check(_ x: Int) -> Int {\n  if x > 0 {\n    return 1\n  }\n  return 0\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators (conjunction_expression)', () => {
    // Like Kotlin, Swift splits && / || into conjunction_expression /
    // disjunction_expression rather than a generic binary node.
    const r = analyze('func check(_ a: Bool, _ b: Bool) -> Bool {\n  return a && b\n}\n');
    expect(r.cyclomatic).toBe(2);
  });

  it('switch with a multi-value case (issue #2058)', () => {
    // Regression guard: switch_statement (the container) was missing from
    // branchNodes AND nestingNodes entirely — a Swift switch contributed
    // ZERO nesting/cognitive from its own container, and switch_entry (each
    // case arm) was double-booked in branchNodes + caseNodes, hitting the
    // same shadowing bug as Kotlin's when_entry.
    const r = analyze(
      'func classify(_ x: Int) -> Int {\n  switch x {\n  case 1:\n    return 1\n  case 2, 3:\n    return 2\n  default:\n    return 0\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 4, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('func add(_ a: Int, _ b: Int) -> Int {\n  return a + b\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Scala (#1923) ────────────────────────────────────────────────────────

describe('Scala complexity', () => {
  const { analyze, halstead } = makeHelpers('scala', sharedParsers());

  it('simple function', () => {
    const r = analyze('def add(a: Int, b: Int): Int = {\n  a + b\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('if/else-if/else chain', () => {
    // tree-sitter-scala's if_expression exposes a real `alternative` field
    // holding either a nested if_expression or a block — Pattern C
    // (Go/Java style) applies cleanly here, unlike Kotlin/Swift.
    const r = analyze(
      'def classify(x: Int): Int = {\n  if (x > 0) {\n    1\n  } else if (x < 0) {\n    -1\n  } else {\n    0\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('match expression', () => {
    // Regression guard (issue #2058): case_clause (each case arm) must not
    // also be in branchNodes — that shadowed the flat case treatment with
    // nesting-weighted branch treatment, inflating cognitive from 1 to 7 for
    // this fixture even though cyclomatic happened to stay 4 either way
    // (each arm contributes +1 via either code path).
    const r = analyze(
      'def classify(x: Int): Int = {\n  x match {\n    case 1 => 1\n    case 2 => 2\n    case _ => 0\n  }\n}\n',
    );
    // base 1 + match container (0, switch-like) + 3 case_clause cases (+1 each) = 4
    expect(r).toEqual({ cognitive: 1, cyclomatic: 4, maxNesting: 1 });
  });

  it('match expression with an alternative-pattern case (issue #2058)', () => {
    const r = analyze(
      'def classify(x: Int): Int = {\n  x match {\n    case 1 => 1\n    case 2 | 3 => 2\n    case _ => 0\n  }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 4, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('def add(a: Int, b: Int): Int = {\n  a + b\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Bash (#1923) ─────────────────────────────────────────────────────────

describe('Bash complexity', () => {
  const { analyze, halstead } = makeHelpers('bash', sharedParsers());

  it('simple function', () => {
    const r = analyze('f() {\n  echo hi\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze('f() {\n  if [ "$1" -gt 0 ]; then\n    echo pos\n  fi\n}\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/elif/else chain', () => {
    // elif_clause/else_clause are flat siblings of if_statement, matching
    // Python's elif_clause/else_clause pattern (Pattern B).
    const r = analyze(
      'f() {\n  if [ "$1" -gt 0 ]; then\n    echo pos\n  elif [ "$1" -lt 0 ]; then\n    echo neg\n  else\n    echo zero\n  fi\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('logical operators inside [[ ]] extended test', () => {
    // `&&` inside `[[ ... ]]` parses as a real binary_expression node
    // (matching logicalNodeTypes). `&&` chaining separate `[ ] && [ ]`
    // commands is a different grammar category (a `list` node joining two
    // test_commands) and is not counted — confirmed by parsing both forms.
    const r = analyze('f() {\n  if [[ "$1" && "$2" ]]; then\n    echo yes\n  fi\n}\n');
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('f() {\n  echo hi\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Julia (#2312) ────────────────────────────────────────────────────────
//
// tree-sitter-julia wraps EVERY binary operator token (`+`, `-`, `>`, `==`,
// `&&`, `||`, ...) in one generic `operator` leaf node — only the leaf's
// `.text` distinguishes which operator it actually is (confirmed by parsing
// `x > 0 && y > 0`). `elseif_clause`/`else_clause` are genuine, distinctly-
// typed nodes reached via the repeated `alternative` field (Pattern B, same
// as Python's elif/else) — no transparent-wrapper involvement.

describe('Julia complexity (#2312)', () => {
  const { analyze, halstead } = makeHelpers('julia', sharedParsers());

  it('function with if/elseif/else chain', () => {
    const r = analyze(
      'function classify(x)\n    if x > 0\n        return 1\n    elseif x < 0\n        return -1\n    else\n        return 0\n    end\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('logical operators — same operator sequence (Bug 1 regression)', () => {
    // Without logicalOperatorsByText, `&&` is unrecognizable (every operator
    // shares the generic `operator` leaf type) — cyclomatic/cognitive would
    // silently miss both `&&` contributions entirely, not just mis-adjust
    // the same-sequence check.
    const r = analyze(
      'function check(a, b, c)\n    if a && b && c\n        return 1\n    end\nend\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(4);
  });

  it('logical operators — mixed operators', () => {
    const r = analyze(
      'function check(a, b, c)\n    if a && b || c\n        return 1\n    end\nend\n',
    );
    expect(r.cognitive).toBe(3);
    expect(r.cyclomatic).toBe(4);
  });

  it('while loop', () => {
    const r = analyze(
      'function s(n)\n    total = 0\n    i = 0\n    while i < n\n        total += i\n        i += 1\n    end\n    return total\nend\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('try/catch', () => {
    const r = analyze(
      'function risky()\n    try\n        return 1\n    catch e\n        return -1\n    end\nend\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('halstead: operator vocabulary is not collapsed (Bug 1 Halstead regression)', () => {
    // Without operatorLeafTypesByText, every distinct operator below would
    // collapse onto a single vocabulary entry keyed by the literal string
    // "operator" (n1 === 1) regardless of how many distinct operators
    // actually appear.
    const h = halstead('function f(a, b, c)\n    return a + b - c * 2\nend\n');
    expect(h).not.toBeNull();
    expect(h.n1).toBeGreaterThanOrEqual(4);
  });
});

// ─── Solidity (#2312) ───────────────────────────────────────────────────────
//
// tree-sitter-solidity's `if_statement` has NO `else_clause` wrapper node and
// NO `alternative` field — both the then- and else-branch bodies are
// reached via the SAME field name (`body`), each wrapped in a generic,
// single-named-child `statement` supertype-alias node, with the bare `else`
// keyword as an ordinary sibling token in between (confirmed by parsing
// `if (x>0) {..} else if (y>0) {..} else {..}` and inspecting field names).
// The condition (and other value positions) is ALSO wrapped in a generic
// `expression` node, which independently breaks the same-operator-sequence
// check for a chained `a && b && c`.

describe('Solidity complexity (#2312)', () => {
  const { analyze, halstead } = makeHelpers('solidity', sharedParsers());

  it('plain if/else', () => {
    const r = analyze(
      'contract C { function f(int x) public { if (x > 0) { x = 1; } else { x = 2; } } }',
    );
    expect(r).toEqual({ cognitive: 2, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else does not double-count nesting (Bug 2 regression)', () => {
    // Without the transparent-wrapper (Pattern D) fix, the nested
    // if_statement's parent is seen as the generic `statement` wrapper
    // rather than recognized as an else-if, and cognitive complexity is
    // inflated to 4/maxNesting to 2 — scoring it as a fresh nested branch
    // instead of the flat +1 every other else-if pattern in this file gets.
    const r = analyze(
      'contract C { function f(int x, int y) public { if (x > 0) { x = 1; } else if (y > 0) { x = 2; } else { x = 3; } } }',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('if/else-if/else with a comment between `else` and its branch still scores flat (Greptile review, PR #2472)', () => {
    // A comment sibling between the `else` token and the transparent
    // wrapper (`else /* note */ if (...)`) would make `wrapper.previousSibling`
    // the comment, not `else` — commentTypes must be skipped over when
    // walking backward, or this scores identically to the uncommented Bug-2
    // regression case above (cognitive 4/maxNesting 2) instead of matching it
    // (cognitive 3/maxNesting 1).
    const r = analyze(
      'contract C { function f(int x, int y) public { if (x > 0) { x = 1; } else /* note */ if (y > 0) { x = 2; } else { x = 3; } } }',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('plain else with a line comment before its block still scores as a flat else (Greptile review, PR #2472)', () => {
    const r = analyze(
      'contract C { function f(int x) public { if (x > 0) { x = 1; } else // note\n { x = 2; } } }',
    );
    expect(r).toEqual({ cognitive: 2, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators — same operator sequence through the `expression` wrapper', () => {
    // Each operator token has its own distinct node type here (unlike
    // Julia) — this exercises effectiveParent's wrapper-unwrapping, not
    // logicalOperatorsByText.
    const r = analyze(
      'contract C { function f(bool a, bool b, bool c) public { if (a && b && c) { a = false; } } }',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(4);
  });

  it('while/for loops', () => {
    const r = analyze(
      'contract C { function f(int x) public { while (x > 0) { x -= 1; } for (uint i = 0; i < 10; i++) { x += 1; } } }',
    );
    expect(r).toEqual({ cognitive: 2, cyclomatic: 3, maxNesting: 1 });
  });

  it('try/catch with multiple catch arms', () => {
    const r = analyze(
      'contract C { function f() public { try other.doThing() returns (uint x) { y = x; } catch Error(string memory reason) { y = 0; } catch { y = 1; } } }',
    );
    expect(r).toEqual({ cognitive: 2, cyclomatic: 3, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead(
      'contract C { function f(int a, int b) public returns (int) { return a + b; } }',
    );
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Parity: standalone DFS vs visitor-based computeAllMetrics ──────────

describe('DFS vs visitor parity', () => {
  // Compares computeFunctionComplexity (standalone DFS, mirrors Rust walk)
  // with computeAllMetrics (visitor-based, used by WASM builds).
  // Both must produce identical cognitive, cyclomatic, and maxNesting values.

  function analyzeViaBoth(code: string) {
    const root = parse(code);
    const funcNode = getFunctionBody(root);
    if (!funcNode) throw new Error('No function found in code snippet');
    const dfs = computeFunctionComplexity(funcNode, 'javascript');
    const visitor = computeAllMetrics(funcNode, 'javascript');
    return { dfs, visitor };
  }

  it('simple function — identical', () => {
    const { dfs, visitor } = analyzeViaBoth(`
      function simple(a, b) { return a + b; }
    `);
    expect(visitor.cognitive).toBe(dfs.cognitive);
    expect(visitor.cyclomatic).toBe(dfs.cyclomatic);
    expect(visitor.maxNesting).toBe(dfs.maxNesting);
  });

  it('branches and nesting — identical', () => {
    const { dfs, visitor } = analyzeViaBoth(`
      function complex(x, y) {
        if (x > 0) {
          for (let i = 0; i < y; i++) {
            if (i % 2 === 0) {
              console.log(i);
            }
          }
        } else if (x < 0) {
          while (y > 0) { y--; }
        } else {
          return 0;
        }
        return x;
      }
    `);
    expect(visitor.cognitive).toBe(dfs.cognitive);
    expect(visitor.cyclomatic).toBe(dfs.cyclomatic);
    expect(visitor.maxNesting).toBe(dfs.maxNesting);
  });

  it('nested function — identical nesting', () => {
    const { dfs, visitor } = analyzeViaBoth(`
      function outer(x) {
        const inner = (y) => {
          if (y > 0) return y;
          return 0;
        };
        if (x > 0) return inner(x);
        return -1;
      }
    `);
    expect(visitor.cognitive).toBe(dfs.cognitive);
    expect(visitor.cyclomatic).toBe(dfs.cyclomatic);
    expect(visitor.maxNesting).toBe(dfs.maxNesting);
  });

  it('double-nested function — identical nesting', () => {
    const { dfs, visitor } = analyzeViaBoth(`
      function top() {
        function mid() {
          function deep() {
            if (true) return 1;
            return 0;
          }
          if (true) return deep();
          return 0;
        }
        return mid();
      }
    `);
    expect(visitor.cognitive).toBe(dfs.cognitive);
    expect(visitor.cyclomatic).toBe(dfs.cyclomatic);
    expect(visitor.maxNesting).toBe(dfs.maxNesting);
  });

  it('switch + ternary + logical — identical', () => {
    const { dfs, visitor } = analyzeViaBoth(`
      function mixed(x, a, b) {
        switch (x) {
          case 1: return a && b ? 'yes' : 'no';
          case 2: return a || b;
          default: return null;
        }
      }
    `);
    expect(visitor.cognitive).toBe(dfs.cognitive);
    expect(visitor.cyclomatic).toBe(dfs.cyclomatic);
    expect(visitor.maxNesting).toBe(dfs.maxNesting);
  });
});

// ─── Parity: elseViaAlternative languages (Go) ─────────────────────────

describe('DFS vs visitor parity — Go (elseViaAlternative)', () => {
  let goParser: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    goParser = parsers.get('go');
  });

  function findGoFunc(node: any): any {
    const rules = COMPLEXITY_RULES.get('go');
    if (!rules) return null;
    if (rules.functionNodes.has(node.type)) return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = findGoFunc(node.child(i));
      if (result) return result;
    }
    return null;
  }

  function analyzeGoBoth(code: string) {
    if (!goParser) throw new Error('Go parser not available');
    const tree = goParser.parse(code);
    const funcNode = findGoFunc(tree.rootNode);
    if (!funcNode) throw new Error('No function found in Go snippet');
    const dfs = computeFunctionComplexity(funcNode, 'go');
    const visitor = computeAllMetrics(funcNode, 'go');
    return { dfs, visitor };
  }

  it('else-if chain — identical (elseViaAlternative)', () => {
    const { dfs, visitor } = analyzeGoBoth(`
      package main
      func classify(x int) string {
        if x > 100 {
          return "big"
        } else if x > 50 {
          return "medium"
        } else if x > 0 {
          return "small"
        } else {
          return "non-positive"
        }
      }
    `);
    expect(visitor!.cognitive).toBe(dfs!.cognitive);
    expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
    expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
  });

  it('nested if with else-if — identical nesting', () => {
    const { dfs, visitor } = analyzeGoBoth(`
      package main
      func process(x int, y int) int {
        if x > 0 {
          if y > 0 {
            return x + y
          } else if y == 0 {
            return x
          } else {
            return -1
          }
        } else if x == 0 {
          return 0
        }
        return -2
      }
    `);
    expect(visitor!.cognitive).toBe(dfs!.cognitive);
    expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
    expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
  });
});

// computeFunctionComplexity is the standalone DFS reference (mirrors the
// Rust walk); computeAllMetrics is the visitor-based path WASM builds
// actually use. ObjC gets its own dedicated block (rather than folding into
// the tier-1 dict below) because it introduces a genuinely new rule set
// (method_definition in functionNodes, catch_clause as a branch/nesting
// node) rather than reusing an existing one — both walk paths must agree on
// method-body detection and @try/@catch handling.
describe('DFS vs visitor parity — ObjC (#1923)', () => {
  let objcParser: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    objcParser = parsers.get('objc');
  });

  function findObjCFunc(node: any): any {
    const rules = COMPLEXITY_RULES.get('objc');
    if (!rules) return null;
    if (rules.functionNodes.has(node.type)) return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = findObjCFunc(node.child(i));
      if (result) return result;
    }
    return null;
  }

  function analyzeObjCBoth(code: string) {
    if (!objcParser) throw new Error('ObjC parser not available');
    const tree = objcParser.parse(code);
    const funcNode = findObjCFunc(tree.rootNode);
    if (!funcNode) throw new Error('No function found in ObjC snippet');
    const dfs = computeFunctionComplexity(funcNode, 'objc');
    const visitor = computeAllMetrics(funcNode, 'objc');
    return { dfs, visitor };
  }

  it('method if/else-if/else chain — identical', () => {
    const { dfs, visitor } = analyzeObjCBoth(
      '@implementation Calculator\n- (NSInteger)classify:(NSInteger)value {\n  if (value > 0) {\n    return 1;\n  } else if (value < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}\n@end\n',
    );
    expect(visitor!.cognitive).toBe(dfs!.cognitive);
    expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
    expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
  });

  it('method @try/@catch — identical', () => {
    const { dfs, visitor } = analyzeObjCBoth(
      '@implementation Calculator\n- (NSInteger)risky {\n  @try {\n    return 1;\n  } @catch (NSException *ex) {\n    return -1;\n  }\n}\n@end\n',
    );
    expect(visitor!.cognitive).toBe(dfs!.cognitive);
    expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
    expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
  });
});

// ─── Parity: DFS vs visitor for the #1923 tier-1 languages ───────────────
//
// computeFunctionComplexity is the standalone DFS reference (mirrors the
// Rust walk); computeAllMetrics is the visitor-based path WASM builds
// actually use. Both must agree for every newly-wired language, including
// Kotlin (multiple logicalNodeTypes) which exercises the
// logicalNodeType → logicalNodeTypes plural refactor.

describe('DFS vs visitor parity — #1923 tier-1 languages', () => {
  const snippets: Record<string, string> = {
    c: 'int classify(int x) {\n  if (x > 0) {\n    return 1;\n  } else if (x < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}\n',
    cpp: 'int classify(int x) {\n  if (x > 0) {\n    return 1;\n  } else if (x < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}\n',
    kotlin:
      'fun classify(x: Int): String {\n  if (x > 0) {\n    return "pos"\n  } else if (x < 0) {\n    return "neg"\n  }\n  return when (x) {\n    0 -> "zero"\n    else -> "other"\n  }\n}\n',
    swift:
      'func classify(_ x: Int) -> String {\n  if x > 0 {\n    return "pos"\n  } else if x < 0 {\n    return "neg"\n  }\n  return "zero"\n}\n',
    scala:
      'def classify(x: Int): String = {\n  if (x > 0) {\n    "pos"\n  } else if (x < 0) {\n    "neg"\n  } else {\n    "zero"\n  }\n}\n',
    bash: 'f() {\n  if [ "$1" -gt 0 ]; then\n    echo pos\n  elif [ "$1" -lt 0 ]; then\n    echo neg\n  else\n    echo zero\n  fi\n}\n',
  };

  let parsers: any;
  beforeAll(async () => {
    parsers = await createParsers();
  });

  function findFunc(langId: string, node: any): any {
    const rules = COMPLEXITY_RULES.get(langId);
    if (!rules) return null;
    if (rules.functionNodes.has(node.type)) return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = findFunc(langId, node.child(i));
      if (result) return result;
    }
    return null;
  }

  for (const [langId, code] of Object.entries(snippets)) {
    it(`${langId}: dfs and visitor agree`, () => {
      const parser = parsers.get(langId);
      if (!parser) throw new Error(`${langId} parser not available`);
      const tree = parser.parse(code);
      const funcNode = findFunc(langId, tree.rootNode);
      if (!funcNode) throw new Error(`No function found in ${langId} snippet`);
      const dfs = computeFunctionComplexity(funcNode, langId);
      const visitor = computeAllMetrics(funcNode, langId);
      expect(visitor!.cognitive).toBe(dfs!.cognitive);
      expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
      expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
    });
  }
});

// computeFunctionComplexity is the standalone DFS reference (mirrors the
// Rust walk); computeAllMetrics is the visitor-based path WASM builds
// actually use. Julia gets its own dedicated block (rather than folding
// into the tier-1 dict above) because its logicalOperatorsByText fix must
// agree identically between the two independent TS implementations — both
// duplicate the logical-operator classification inline rather than sharing
// one helper (issue #2312).
describe('DFS vs visitor parity — Julia (#2312, logicalOperatorsByText)', () => {
  let juliaParser: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    juliaParser = parsers.get('julia');
  });

  function findJuliaFunc(node: any): any {
    const rules = COMPLEXITY_RULES.get('julia');
    if (!rules) return null;
    if (rules.functionNodes.has(node.type)) return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = findJuliaFunc(node.child(i));
      if (result) return result;
    }
    return null;
  }

  function analyzeJuliaBoth(code: string) {
    if (!juliaParser) throw new Error('Julia parser not available');
    const tree = juliaParser.parse(code);
    const funcNode = findJuliaFunc(tree.rootNode);
    if (!funcNode) throw new Error('No function found in Julia snippet');
    const dfs = computeFunctionComplexity(funcNode, 'julia');
    const visitor = computeAllMetrics(funcNode, 'julia');
    return { dfs, visitor };
  }

  it('if/elseif/else — identical', () => {
    const { dfs, visitor } = analyzeJuliaBoth(
      'function classify(x)\n    if x > 0\n        return 1\n    elseif x < 0\n        return -1\n    else\n        return 0\n    end\nend\n',
    );
    expect(visitor!.cognitive).toBe(dfs!.cognitive);
    expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
    expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
  });

  it('chained && (same operator sequence) — identical', () => {
    const { dfs, visitor } = analyzeJuliaBoth(
      'function check(a, b, c)\n    if a && b && c\n        return 1\n    end\nend\n',
    );
    expect(visitor!.cognitive).toBe(dfs!.cognitive);
    expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
    expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
  });
});

// Solidity gets its own dedicated block for the same reason: its
// transparentWrapperTypes/elseKeywordType (Pattern D) fix must agree
// identically between the two independent TS implementations (issue #2312).
describe('DFS vs visitor parity — Solidity (#2312, transparent wrapper)', () => {
  let solidityParser: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    solidityParser = parsers.get('solidity');
  });

  function findSolidityFunc(node: any): any {
    const rules = COMPLEXITY_RULES.get('solidity');
    if (!rules) return null;
    if (rules.functionNodes.has(node.type)) return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = findSolidityFunc(node.child(i));
      if (result) return result;
    }
    return null;
  }

  function analyzeSolidityBoth(code: string) {
    if (!solidityParser) throw new Error('Solidity parser not available');
    const tree = solidityParser.parse(code);
    const funcNode = findSolidityFunc(tree.rootNode);
    if (!funcNode) throw new Error('No function found in Solidity snippet');
    const dfs = computeFunctionComplexity(funcNode, 'solidity');
    const visitor = computeAllMetrics(funcNode, 'solidity');
    return { dfs, visitor };
  }

  it('if/else-if/else through the `statement` wrapper — identical', () => {
    const { dfs, visitor } = analyzeSolidityBoth(
      'contract C { function f(int x, int y) public { if (x > 0) { x = 1; } else if (y > 0) { x = 2; } else { x = 3; } } }',
    );
    expect(visitor!.cognitive).toBe(dfs!.cognitive);
    expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
    expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
  });

  it('chained && through the `expression` wrapper — identical', () => {
    const { dfs, visitor } = analyzeSolidityBoth(
      'contract C { function f(bool a, bool b, bool c) public { if (a && b && c) { a = false; } } }',
    );
    expect(visitor!.cognitive).toBe(dfs!.cognitive);
    expect(visitor!.cyclomatic).toBe(dfs!.cyclomatic);
    expect(visitor!.maxNesting).toBe(dfs!.maxNesting);
  });
});
