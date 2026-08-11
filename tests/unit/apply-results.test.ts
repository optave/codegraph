/**
 * Unit tests for the shared, DB-free result-merging logic extracted to
 * `src/ast-analysis/apply-results.ts` (issue #1850). Both `ast-analysis/engine.ts`
 * and `domain/wasm-worker-entry.ts` now import these functions instead of
 * maintaining independent copies — this file exercises the merge logic
 * directly, and guards against the CFG-derived cyclomatic override
 * regression (#1743) at the unit level.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasFuncBody,
  indexByLine,
  matchResultToDef,
  storeCfgResults,
  storeComplexityResults,
} from '../../src/ast-analysis/apply-results.js';
import type { Definition, TreeSitterNode, WalkResults } from '../../src/types.js';

/** Minimal fake tree-sitter node satisfying only what the merge functions read. */
function fakeFuncNode(
  row: number,
  name: string | null,
  text = 'function f() {}',
  column = 0,
): TreeSitterNode {
  return {
    startPosition: { row, column },
    text,
    childForFieldName: (field: string) => (field === 'name' && name ? { text: name } : null),
  } as unknown as TreeSitterNode;
}

function fakeDef(overrides: Partial<Definition> = {}): Definition {
  return {
    name: 'foo',
    kind: 'function',
    line: 5,
    endLine: 10,
    ...overrides,
  } as Definition;
}

describe('hasFuncBody', () => {
  it('is true for a function/method with a real multi-line body', () => {
    expect(hasFuncBody({ kind: 'function', line: 5, endLine: 10 })).toBe(true);
    expect(hasFuncBody({ kind: 'method', line: 5, endLine: 10 })).toBe(true);
  });

  it('is false for non-function/method kinds', () => {
    expect(hasFuncBody({ kind: 'class', line: 5, endLine: 10 })).toBe(false);
  });

  it('is true for a genuinely bodied single-line function/method regardless of endLine (issue #2285)', () => {
    // A prior version required `endLine > line`, treating line span as a
    // proxy for "has a body" — wrong for a getter, guard return, or C#
    // expression-bodied member (`bool IsPositive(int x) => x > 0;`) whose
    // entire body fits on one line. `endLine` is no longer part of this
    // check at all: `bodyless` (issue #1922) is the sole, reliable signal.
    expect(hasFuncBody({ kind: 'function', line: 5, endLine: 5 })).toBe(true);
    expect(hasFuncBody({ kind: 'method', line: 5, endLine: 5 })).toBe(true);
    expect(hasFuncBody({ kind: 'function', line: 5 })).toBe(true);
  });

  it('is false when line is missing/zero', () => {
    expect(hasFuncBody({ kind: 'function', line: 0 })).toBe(false);
  });

  it('is true for a dotted name with a real body (Class.method, module-table function, receiver method) — issue #1922', () => {
    // A dotted name alone must never disqualify a real, bodied function: it's the normal
    // qualified name for class/struct/impl methods (`Class.method`) and module-table
    // functions (Lua's `M.foo`, Go/Java/C#/PHP/Rust receiver or impl methods) across every
    // extractor. Regression guard for the bug where the file-level "does this file need
    // complexity" gate (`defs.some(hasFuncBody)`) went false for an entire file when every
    // function in it happened to have a dotted name. `hasFuncBody` no longer takes `name`
    // at all (it relies on `bodyless` instead), so a single non-bodyless method definition
    // covers every dotted-name shape mentioned above — there's no name-shaped input left to
    // vary across cases.
    expect(hasFuncBody({ kind: 'method', line: 5, endLine: 10 })).toBe(true);
  });

  it('is false when the extractor marks the definition bodyless (interface/trait/abstract signature)', () => {
    expect(hasFuncBody({ kind: 'method', line: 5, endLine: 10, bodyless: true })).toBe(false);
    // Even a non-dotted signature-only declaration is excluded via `bodyless`.
    expect(hasFuncBody({ kind: 'function', line: 5, endLine: 10, bodyless: true })).toBe(false);
  });
});

describe('indexByLine / matchResultToDef', () => {
  it('indexes results by 1-based start line and matches by name when multiple share a line', () => {
    const results = [{ funcNode: fakeFuncNode(4, 'a') }, { funcNode: fakeFuncNode(4, 'b') }];
    const byLine = indexByLine(results);
    expect(byLine.get(5)).toHaveLength(2);

    expect(matchResultToDef(byLine.get(5), 'b')).toBe(results[1]);
    // Falls back to the first candidate when no name matches.
    expect(matchResultToDef(byLine.get(5), 'nonexistent')).toBe(results[0]);
  });

  it('returns undefined when there are no candidates at all', () => {
    expect(matchResultToDef(undefined, 'a')).toBeUndefined();
  });

  describe('column disambiguation (#2265)', () => {
    // Anonymous functions (arrow functions, most function expressions) have
    // no `name` field at all, so the name-based fallback can never
    // disambiguate them — these regression-guard the column-based tier that
    // now runs before it.
    it('prefers an exact column match over the name fallback for two anonymous candidates sharing a line', () => {
      const results = [
        { funcNode: fakeFuncNode(2, null, 'x => x', 10) },
        { funcNode: fakeFuncNode(2, null, 'y => y', 40) },
      ];
      const byLine = indexByLine(results);
      expect(matchResultToDef(byLine.get(3), 'b', 40)).toBe(results[1]);
      expect(matchResultToDef(byLine.get(3), 'b', 10)).toBe(results[0]);
    });

    it('falls back to the name/first-candidate tiers when defColumn is not provided', () => {
      const results = [
        { funcNode: fakeFuncNode(2, null, 'x => x', 10) },
        { funcNode: fakeFuncNode(2, null, 'y => y', 40) },
      ];
      const byLine = indexByLine(results);
      expect(matchResultToDef(byLine.get(3), 'nonexistent')).toBe(results[0]);
    });

    it('falls back to the name/first-candidate tiers when no candidate column matches', () => {
      const results = [
        { funcNode: fakeFuncNode(2, 'named', 'function named() {}', 10) },
        { funcNode: fakeFuncNode(2, null, 'y => y', 40) },
      ];
      const byLine = indexByLine(results);
      // defColumn (99) matches nothing — falls through to the name match.
      expect(matchResultToDef(byLine.get(3), 'named', 99)).toBe(results[0]);
    });
  });
});

describe('storeComplexityResults', () => {
  it('applies AST-derived complexity metrics to the matching definition', () => {
    const def = fakeDef();
    const results: WalkResults = {
      complexity: [
        {
          funcNode: fakeFuncNode(4, 'foo', 'function foo() {\n  return 1;\n}'),
          funcName: 'foo',
          metrics: { cognitive: 3, cyclomatic: 26, maxNesting: 2 },
        },
      ],
    };

    storeComplexityResults(results, [def], 'javascript');

    expect(def.complexity).toBeDefined();
    expect(def.complexity?.cyclomatic).toBe(26);
    expect(def.complexity?.cognitive).toBe(3);
    expect(def.complexity?.maxNesting).toBe(2);
    expect(def.complexity?.loc).toBeDefined();
  });

  it('does not overwrite a definition that already has complexity', () => {
    const def = fakeDef({ complexity: { cognitive: 1, cyclomatic: 1, maxNesting: 0 } });
    const results: WalkResults = {
      complexity: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          funcName: 'foo',
          metrics: { cognitive: 9, cyclomatic: 9, maxNesting: 9 },
        },
      ],
    };

    storeComplexityResults(results, [def], 'javascript');

    expect(def.complexity?.cyclomatic).toBe(1);
  });

  it('does not attach a result to a bodyless definition even when the visitor computed one for that line (#2055)', () => {
    // The visitor walks by node-TYPE membership in functionNodes, which for
    // C#/Java shares one node type (method_declaration) between a bodied
    // class method and a bodyless interface/abstract signature — so the
    // visitor produces a trivial-but-real result for the bodyless one too.
    // Without checking `bodyless`, this would fabricate a meaningless
    // complexity entry that native's csharp.rs/java.rs explicitly skip.
    // endLine (10) > line (5) deliberately, so this exercises the `bodyless`
    // exclusion itself, not the endLine-heuristic (see the test below for why
    // that heuristic must NOT be used here).
    const def = fakeDef({ bodyless: true });
    const results: WalkResults = {
      complexity: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          funcName: 'foo',
          metrics: { cognitive: 0, cyclomatic: 1, maxNesting: 0 },
        },
      ],
    };

    storeComplexityResults(results, [def], 'csharp');

    expect(def.complexity).toBeUndefined();
  });

  it('attaches a result to a genuinely bodied single-line function (#2055 fix-of-a-fix)', () => {
    // Regression guard: an earlier version of the #2055 fix gated this merge
    // on `hasFuncBody(def)`, which ALSO requires `endLine > line` — wrongly
    // discarding a real, already-computed visitor result for any function
    // whose entire body fits on one line (`bool IsPositive(int x) { return
    // x > 0; }`, a C# expression-bodied member, etc.), even though it is not
    // bodyless at all. Caught by Greptile review before merge. The gate must
    // check `bodyless` alone, never the line span.
    const def = fakeDef({ bodyless: false, line: 5, endLine: 5 });
    const results: WalkResults = {
      complexity: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          funcName: 'foo',
          metrics: { cognitive: 0, cyclomatic: 1, maxNesting: 0 },
        },
      ],
    };

    storeComplexityResults(results, [def], 'csharp');

    expect(def.complexity).toBeDefined();
    expect(def.complexity?.cyclomatic).toBe(1);
  });
});

describe('storeCfgResults', () => {
  it('stores CFG blocks/edges without touching complexity.cyclomatic (regression guard for #1743)', () => {
    const def = fakeDef();
    // AST-derived cyclomatic (correctly counts &&/||/??/nested closures).
    const complexityResults: WalkResults = {
      complexity: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          funcName: 'foo',
          metrics: { cognitive: 3, cyclomatic: 26, maxNesting: 2 },
        },
      ],
    };
    storeComplexityResults(complexityResults, [def], 'javascript');
    expect(def.complexity?.cyclomatic).toBe(26);

    // CFG block/edge count that, if wrongly applied as McCabe's `edges - blocks + 2`,
    // would collapse cyclomatic to 1 (the exact #1743 symptom).
    const results: WalkResults = {
      cfg: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          blocks: [{ id: 0, label: 'entry', startLine: 5, endLine: 10 }],
          edges: [],
        },
      ],
    };

    storeCfgResults(results, [def]);

    expect(def.cfg?.blocks).toHaveLength(1);
    // The AST-derived cyclomatic must survive the CFG merge untouched.
    expect(def.complexity?.cyclomatic).toBe(26);
  });

  it('does not overwrite a definition that already has CFG blocks', () => {
    const existingCfg = {
      blocks: [{ id: 0, label: 'entry', startLine: 5, endLine: 10 }],
      edges: [],
    };
    const def = fakeDef({ cfg: existingCfg });
    const results: WalkResults = {
      cfg: [{ funcNode: fakeFuncNode(4, 'foo'), blocks: [], edges: [] }],
    };

    storeCfgResults(results, [def]);

    expect(def.cfg).toBe(existingCfg);
  });

  it('does not attach CFG blocks to a bodyless definition even when the visitor computed one for that line (#2055)', () => {
    const def = fakeDef({ bodyless: true });
    const results: WalkResults = {
      cfg: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          blocks: [{ id: 0, label: 'entry', startLine: 5, endLine: 5 }],
          edges: [],
        },
      ],
    };

    storeCfgResults(results, [def]);

    expect(def.cfg).toBeUndefined();
  });

  it('attaches CFG blocks to a genuinely bodied single-line function (#2055 fix-of-a-fix)', () => {
    // Same regression as storeComplexityResults' equivalent test above: the
    // gate must check `bodyless` alone, never `endLine > line`.
    const def = fakeDef({ bodyless: false, line: 5, endLine: 5 });
    const results: WalkResults = {
      cfg: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          blocks: [{ id: 0, label: 'entry', startLine: 5, endLine: 5 }],
          edges: [],
        },
      ],
    };

    storeCfgResults(results, [def]);

    expect(def.cfg?.blocks).toHaveLength(1);
  });
});

describe('shared module is actually used by both call sites (drift guard, #1850)', () => {
  it('ast-analysis/engine.ts imports the merge functions from apply-results.ts instead of redefining them', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/ast-analysis/engine.ts'), 'utf-8');
    expect(src).toMatch(/from ['"]\.\/apply-results\.js['"]/);
    expect(src).not.toMatch(/^function storeCfgResults/m);
    expect(src).not.toMatch(/^function storeComplexityResults/m);
    expect(src).not.toMatch(/^function hasFuncBody/m);
  });

  it('domain/wasm-worker-entry.ts imports the merge functions from apply-results.ts instead of redefining them', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/domain/wasm-worker-entry.ts'),
      'utf-8',
    );
    expect(src).toMatch(/from ['"]\.\.\/ast-analysis\/apply-results\.js['"]/);
    expect(src).not.toMatch(/^function storeCfgResults/m);
    expect(src).not.toMatch(/^function storeComplexityResults/m);
    expect(src).not.toMatch(/^function hasFuncBody/m);
  });
});
