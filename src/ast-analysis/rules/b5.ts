import type { ComplexityRules, DataflowRulesConfig, HalsteadRules } from '../../types.js';
import { makeDataflowRules } from '../shared.js';

// ─── Zig ──────────────────────────────────────────────────────────────────────
//
// Zig function_declaration: name via `childForFieldName('name')` (confirmed in extractor line 68).
// Parameters: `childForFieldName('parameters')` (confirmed in extractor extractZigParams line 84).
// Each parameter is a `parameter` node; identifier child is the name (extractor line 89-90).
// return_statement: Zig has explicit return (confirmed in extractor + language spec).
// variable_declaration: name is first `identifier` child (extractor handleZigVariable line 99).
// call_expression: `childForFieldName('function')` (confirmed in extractor handleZigCallExpression line 209).
// field_expression/field_access: `childForFieldName('field')` or `childForFieldName('member')` (extractor line 215).
// member object: `childForFieldName('value')` or `funcNode.child(0)` (extractor line 216).

export const dataflowZig: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_declaration']),
  nameField: 'name',

  paramListField: 'parameters',
  paramWrapperTypes: new Set(['parameter']),
  // Zig parameter: identifier child for the name (extractZigParams uses findChild(param, 'identifier'))
  paramIdentifier: 'identifier',

  returnNode: 'return_statement',

  varDeclaratorNode: 'variable_declaration',
  varNameField: 'name',

  callNode: 'call_expression',
  callFunctionField: 'function',
  callArgsField: 'arguments',

  memberNode: 'field_expression',
  memberObjectField: 'value',
  memberPropertyField: 'field',
});

// ─── Solidity ─────────────────────────────────────────────────────────────────
//
// Solidity function_definition: name via `childForFieldName('name')` (confirmed in extractor line 232).
// Parameters: `childForFieldName('parameters')` or findChild('parameter_list') (extractor line 355-357).
// Each parameter is a `parameter` node (extractor uses extractSimpleParameters with paramTypes: ['parameter']).
// return_statement: Solidity has explicit return.
// call_expression / function_call: both confirmed in extractor walkSolidityNode line 71-72.
// call_expression handler: `childForFieldName('function')` or `childForFieldName('callee')` (extractor line 336).
// member_expression: `childForFieldName('property')` (extractor line 342), `childForFieldName('object')` (line 343).

export const dataflowSolidity: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_definition', 'modifier_definition']),
  nameField: 'name',

  paramListField: 'parameters',
  paramWrapperTypes: new Set(['parameter']),
  paramIdentifier: 'identifier',

  returnNode: 'return_statement',

  callNodes: new Set(['call_expression', 'function_call']),
  callFunctionField: 'function',
  callArgsField: 'arguments',

  memberNode: 'member_expression',
  memberObjectField: 'object',
  memberPropertyField: 'property',
});

// tree-sitter-solidity's `if_statement` has NO `else_clause` wrapper node and
// NO `alternative` field (unlike Go/Java's Pattern C) — instead, BOTH the
// then- and else-branch bodies are reached via the SAME field name (`body`),
// each wrapped in a generic, single-named-child `statement` supertype-alias
// node, with the bare `else` keyword as an ordinary sibling token in
// between. Confirmed by parsing `if (x>0) {..} else if (y>0) {..} else {..}`
// and inspecting field names: `if_statement[if, (condition) expr, (body)
// statement, (else) else, (body) statement[if_statement | block_statement]]`.
// `transparentWrapperTypes`/`elseKeywordType` (Pattern D) detect an else-if
// / plain-else by walking through the `statement` wrapper and checking
// whether its preceding sibling is the bare `else` token (issue #2312) —
// see `isPatternDElseIf` in complexity-visitor.ts / features/complexity.ts.
//
// The condition (and other value positions: return values, ternary
// branches, call arguments) is ALSO wrapped in a generic `expression`
// node — this breaks `classifyLogicalOp`'s same-operator-sequence check for
// a chained `a && b && c` (the inner `binary_expression`'s parent is an
// `expression` wrapper, not the outer `binary_expression`), independently
// of the if/else-if bug above. `transparentWrapperTypes` includes
// `expression` too so `effectiveParent` sees through it, restoring correct
// cognitive counting for chained logical operators.
//
// Every operator token (`>`, `&&`, `==`, ...) has its OWN distinct node type
// here (unlike Julia) — confirmed by parsing the same snippet — so
// `logicalOperatorsByText` is NOT needed for Solidity.
//
// `try_statement` itself is deliberately NOT a branch/nesting node — only
// each `catch_clause` is, mirroring every other language here (JS/Java/C#/
// PHP/Ruby): `try` alone doesn't add a decision path, only a catch arm
// does. Multiple `catch_clause` siblings on one `try` (Solidity commonly
// has `catch Error(...) {..} catch {..}`) are each counted individually,
// same as a multi-catch language would be.
export const complexitySolidity: ComplexityRules = {
  branchNodes: new Set([
    'if_statement',
    'while_statement',
    'for_statement',
    'catch_clause',
    'ternary_expression',
  ]),
  caseNodes: new Set([]),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeTypes: new Set(['binary_expression']),
  optionalChainType: null,
  nestingNodes: new Set([
    'if_statement',
    'while_statement',
    'for_statement',
    'catch_clause',
    'ternary_expression',
  ]),
  functionNodes: new Set(['function_definition', 'modifier_definition']),
  ifNodeType: 'if_statement',
  elseNodeType: null,
  elifNodeType: null,
  elseViaAlternative: false,
  switchLikeNodes: new Set([]),
  transparentWrapperTypes: new Set(['statement', 'expression']),
  elseKeywordType: 'else',
  // A comment can sit between the `else` token and its branch wrapper
  // (`else /* note */ if (...)` or `else\n  // note\n  if (...)`) — both
  // line and block comments share this one node type in the grammar
  // (confirmed by parsing each form). Skipped when walking backward for
  // the else keyword so a commented else-if/plain-else isn't misclassified
  // as a fresh nested branch (Greptile review, PR #2472).
  commentTypes: new Set(['comment']),
};

// tree-sitter-solidity gives every operator token its OWN distinct node type
// (confirmed by parsing `a && b && c`: the `&&` leaf's type is literally
// `"&&"`, not a generic wrapper) — `operatorLeafTypesByText` stays unset;
// Solidity does not have Julia's Bug-1 problem.
//
// Plain `string_literal`/`string` nodes are deliberately NOT in
// `operandLeafTypes`: confirmed by parsing `s = "hello world"` and
// inspecting byte ranges, the grammar exposes ONLY the two quote-character
// tokens as children — the string body itself (`hello world`) is unnamed
// text with no node of its own, so there is no leaf to key an operand on.
// This is a minor, documented precision loss (string literals under-counted
// as Halstead operands), not a bug this PR introduces — `hex_string_literal`
// / `unicode_string_literal` ARE proper leaves (no exposed sub-structure)
// and are counted normally.
export const halsteadSolidity: HalsteadRules = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '**',
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
    '<=',
    '>',
    '>=',
    '&&',
    '||',
    '!',
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    '++',
    '--',
    'if',
    'else',
    'while',
    'for',
    'try',
    'catch',
    'return',
    'revert',
    'break',
    'continue',
    'delete',
    'new',
    'emit',
    'function',
    'modifier',
    '.',
    ',',
    ';',
    ':',
    '?',
    '=>',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'number_literal',
    'true',
    'false',
    'hex_string_literal',
    'unicode_string_literal',
  ]),
  compoundOperators: new Set([
    'call_expression',
    'function_call',
    'member_expression',
    'new_expression',
  ]),
  skipTypes: new Set([]),
};
