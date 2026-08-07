import type { ComplexityRules, HalsteadRules } from '../../types.js';

// ─── R Complexity ─────────────────────────────────────────────────────────
//
// Mirrors the native `R_RULES` in `crates/codegraph-core/src/ast_analysis/complexity.rs`.
//
// Confirmed against tree-sitter-r 1.2.0's `src/node-types.json` and by parsing
// sample R control flow (`if`/`else if`/`else`, `for`, `while`, `repeat`).
//
// `if_statement` carries `consequence`/`alternative` fields directly — there is
// no `else_clause` wrapper node, so an else-if chain is a nested `if_statement`
// reachable via the `alternative` field (Pattern C, same as Go/Java).
//
// R has no `switch` statement — `switch(x, ...)` is an ordinary function call
// (`call`), not special syntax, so there is no case/switch construct to model.
//
// `repeat` (unconditional loop, `break`-terminated) is a branch/nesting node,
// the same treatment Rust's `loop_expression` gets.

export const complexity: ComplexityRules = {
  branchNodes: new Set(['if_statement', 'for_statement', 'while_statement', 'repeat_statement']),
  caseNodes: new Set([]),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeTypes: new Set(['binary_operator']),
  optionalChainType: null,
  nestingNodes: new Set(['if_statement', 'for_statement', 'while_statement', 'repeat_statement']),
  functionNodes: new Set(['function_definition']),
  ifNodeType: 'if_statement',
  elseNodeType: null,
  elifNodeType: null,
  elseViaAlternative: true,
  switchLikeNodes: new Set([]),
};

// ─── R Halstead ──────────────────────────────────────────────────────────
//
// Mirrors the native `R_HALSTEAD`. All infix operators (`+`, `<-`, `&&`, `$`,
// `::`, ...) share the generic `binary_operator`/`extract_operator`/
// `namespace_operator` node types with the operator itself as an anonymous
// leaf child, confirmed by parsing — so the operator *text* is the node
// *type* for these, same pattern as most other languages here.
//
// User-defined infix operators (`%%`, `%in%`, `%o%`, ...) all collapse onto
// one generic `special` leaf type in this grammar (confirmed by parsing
// `x %% y` and `x %in% y`) — they bucket together for Halstead's unique-
// operator count, a minor precision loss the grammar itself imposes.
//
// `integer` (`1L`) and `complex` (`2i`) literals wrap only their suffix
// (`L`/`i`) as a child — the numeric digits are unlabeled text in the parent
// span, not a separate node (confirmed by parsing) — so the suffix leaf is
// used as the operand token; this collapses all typed-integer/complex
// literals onto one value per suffix, another minor precision loss inherent
// to the grammar rather than something this config can recover.
export const halstead: HalsteadRules = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '^',
    'special',
    '&',
    '&&',
    '|',
    '||',
    '!',
    '<',
    '>',
    '<=',
    '>=',
    '==',
    '!=',
    '<-',
    '<<-',
    '->',
    '->>',
    '=',
    ':=',
    '~',
    '?',
    ':',
    '::',
    ':::',
    '@',
    '$',
    '|>',
    'in',
    'if',
    'else',
    'for',
    'while',
    'repeat',
    'function',
    '\\',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'float',
    'string_content',
    'NA',
    'NA_character_',
    'NA_integer_',
    'NA_real_',
    'NA_complex_',
    'NULL',
    'Inf',
    'NaN',
    'TRUE',
    'FALSE',
    'L',
    'i',
    'dots',
    'dot_dot_i',
  ]),
  compoundOperators: new Set(['call', 'subset', 'subset2']),
  skipTypes: new Set([]),
};
