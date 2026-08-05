import type { ComplexityRules, HalsteadRules } from '../../types.js';

// ─── Zig Complexity ───────────────────────────────────────────────────────
//
// Mirrors the native `ZIG_RULES` in `crates/codegraph-core/src/ast_analysis/complexity.rs`.
//
// tree-sitter-zig's if_statement wraps its else branch in an `else_clause`
// node whose single named child is either a nested `if_statement` (else-if)
// or the terminal else body — confirmed by parsing `if (..) {..} else if
// (..) {..} else {..}` and inspecting the S-expression. This is Pattern A
// (JS/C#/Rust-style wrapper), even though the grammar internally tags that
// child with an `alternative` field name — the wrapper-node detection below
// only checks `node.parent?.type`, not field names, so that's immaterial.
//
// `and`/`or`/`orelse` are keyword operators sharing the single generic
// `binary_expression` node type (confirmed by parsing `a and b or c` and
// `a orelse b`) — same shared-type pattern as Lua's `and`/`or`.
//
// `catch_expression` (`expr catch fallback`, `expr catch |err| { .. }`) is
// treated as a branch/nesting node, the same treatment C/C++/ObjC/C# give
// `catch_clause` — its fallback can be an arbitrary block with its own
// control flow, not just a coalescing value. `try_expression` (`try expr`)
// is NOT a branch — it propagates the error up rather than branching
// locally, mirroring how Rust's `?` operator is Halstead-only (rust.ts).

export const complexity: ComplexityRules = {
  branchNodes: new Set([
    'if_statement',
    'else_clause',
    'for_statement',
    'while_statement',
    'switch_expression',
    'catch_expression',
  ]),
  caseNodes: new Set(['switch_case']),
  logicalOperators: new Set(['and', 'or', 'orelse']),
  logicalNodeTypes: new Set(['binary_expression']),
  optionalChainType: null,
  nestingNodes: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'switch_expression',
    'catch_expression',
  ]),
  functionNodes: new Set(['function_declaration']),
  ifNodeType: 'if_statement',
  elseNodeType: 'else_clause',
  elifNodeType: null,
  elseViaAlternative: false,
  switchLikeNodes: new Set(['switch_expression']),
};

// ─── Zig Halstead ──────────────────────────────────────────────────────────
//
// Mirrors the native `ZIG_HALSTEAD`. Zig has no `++`/`--` (increments are
// `x += 1`) and no `case` keyword in switch arms (`1 => ..`, confirmed by
// parsing), so neither appears below. Literal wrapper nodes (`character`,
// `string`, `boolean`) have non-zero childCount, so their leaf *content*
// tokens (`character_content`, `string_content`, `true`/`false`) are the
// operand leaves — same split rust.ts already uses for `string_content`.

export const halstead: HalsteadRules = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '!',
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    'and',
    'or',
    'orelse',
    'try',
    'catch',
    'if',
    'else',
    'for',
    'while',
    'switch',
    'return',
    'break',
    'continue',
    'unreachable',
    'defer',
    'const',
    'var',
    'pub',
    'fn',
    'struct',
    'enum',
    'union',
    'error',
    'comptime',
    '.',
    '..',
    '.?',
    '.*',
    ',',
    ';',
    ':',
    '?',
    '=>',
    '->',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'builtin_type',
    'integer',
    'float',
    'string_content',
    'character_content',
    'true',
    'false',
    'null',
    'undefined',
  ]),
  compoundOperators: new Set(['call_expression', 'field_expression', 'index_expression']),
  skipTypes: new Set([]),
};
