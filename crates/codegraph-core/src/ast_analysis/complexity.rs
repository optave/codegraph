use tree_sitter::Node;

use crate::shared::constants::MAX_WALK_DEPTH;
use crate::types::ComplexityMetrics;

// ─── Language-Configurable Complexity Rules ───────────────────────────────

/// Language-specific AST node type rules for complexity analysis.
/// Mirrors `COMPLEXITY_RULES` from `src/complexity.js`.
pub struct LangRules {
    pub branch_nodes: &'static [&'static str],
    pub case_nodes: &'static [&'static str],
    pub logical_operators: &'static [&'static str],
    pub logical_node_types: &'static [&'static str],
    pub optional_chain_type: Option<&'static str>,
    pub nesting_nodes: &'static [&'static str],
    pub function_nodes: &'static [&'static str],
    pub if_node_type: Option<&'static str>,
    pub else_node_type: Option<&'static str>,
    pub elif_node_type: Option<&'static str>,
    pub else_via_alternative: bool,
    pub switch_like_nodes: &'static [&'static str],
    /// Compare a logical/binary operator token by its `.text` (the literal
    /// operator symbol) instead of its `.kind()` (grammar node type). Needed
    /// for grammars where every binary operator (`+`, `>`, `&&`, ...) shares
    /// one generic node kind (e.g. tree-sitter-julia's `operator`) and only
    /// the token TEXT distinguishes which operator it actually is. When
    /// false (every other language), behavior is byte-for-byte unchanged —
    /// `.kind()` already equals the operator's literal text.
    pub logical_operators_by_text: bool,
    /// Node kinds that transparently wrap a single meaningful child (e.g.
    /// Solidity's `statement`/`expression` supertype-alias wrapper nodes
    /// produced by ungrammar/ASDL-style grammar specs). Parent/sibling
    /// lookups used to detect else-if chains and logical-operator sequences
    /// walk THROUGH nodes of these kinds via [`effective_parent`] rather
    /// than stopping at the wrapper. Empty for every language without this
    /// grammar shape, in which case `effective_parent` degenerates to plain
    /// `.parent()`.
    pub transparent_wrapper_types: &'static [&'static str],
    /// Node kind of a bare `else` keyword token, for grammars where else has
    /// NO wrapping node (no `else_clause`, no `alternative` field) and the
    /// same field name is reused positionally for both the then- and
    /// else-branch bodies (Solidity: both reached via field `body`, the
    /// second occurrence only present when an `else` sibling precedes it).
    /// An else-if / plain-else is detected by checking whether the
    /// (wrapper-unwrapped) node's immediate parent's PRECEDING SIBLING is
    /// this keyword kind — see [`detect_else_if`]/[`is_pattern_d_else`].
    pub else_keyword_type: Option<&'static str>,
    /// Node kinds to skip when walking backward from a transparent-wrapper
    /// node looking for the preceding `else_keyword_type` sibling (e.g.
    /// Solidity's `comment` — `else /* note */ if (...)` still counts as an
    /// else-if even though a comment node sits between the `else` token and
    /// the wrapper). Empty for every language without `else_keyword_type` set.
    pub comment_types: &'static [&'static str],
}

impl LangRules {
    fn is_branch(&self, kind: &str) -> bool {
        self.branch_nodes.contains(&kind)
    }
    fn is_case(&self, kind: &str) -> bool {
        self.case_nodes.contains(&kind)
    }
    fn is_logical_op(&self, kind: &str) -> bool {
        self.logical_operators.contains(&kind)
    }
    fn is_nesting(&self, kind: &str) -> bool {
        self.nesting_nodes.contains(&kind)
    }
    fn is_function(&self, kind: &str) -> bool {
        self.function_nodes.contains(&kind)
    }
    fn is_switch_like(&self, kind: &str) -> bool {
        self.switch_like_nodes.contains(&kind)
    }
}

// ─── Per-Language Rules ───────────────────────────────────────────────────

pub static JS_TS_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "switch_statement",
        "for_statement",
        "for_in_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
    ],
    case_nodes: &["switch_case"],
    logical_operators: &["&&", "||", "??"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: Some("optional_chain_expression"),
    nesting_nodes: &[
        "if_statement",
        "switch_statement",
        "for_statement",
        "for_in_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
    ],
    function_nodes: &[
        "function_declaration",
        "function_expression",
        "arrow_function",
        "method_definition",
        "generator_function",
        "generator_function_declaration",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

pub static PYTHON_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "elif_clause",
        "else_clause",
        "for_statement",
        "while_statement",
        "except_clause",
        "conditional_expression",
        "match_statement",
    ],
    case_nodes: &["case_clause"],
    logical_operators: &["and", "or"],
    logical_node_types: &["boolean_operator"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "except_clause",
        "conditional_expression",
    ],
    function_nodes: &["function_definition", "lambda"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: Some("elif_clause"),
    else_via_alternative: false,
    switch_like_nodes: &["match_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

pub static GO_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "for_statement",
        "expression_switch_statement",
        "type_switch_statement",
        "select_statement",
    ],
    case_nodes: &[
        "expression_case",
        "type_case",
        "default_case",
        "communication_case",
    ],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "expression_switch_statement",
        "type_switch_statement",
        "select_statement",
    ],
    function_nodes: &["function_declaration", "method_declaration", "func_literal"],
    if_node_type: Some("if_statement"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &["expression_switch_statement", "type_switch_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

pub static RUST_LANG_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_expression",
        "else_clause",
        "for_expression",
        "while_expression",
        "loop_expression",
        "if_let_expression",
        "while_let_expression",
        "match_expression",
    ],
    case_nodes: &["match_arm"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_expression",
        "for_expression",
        "while_expression",
        "loop_expression",
        "if_let_expression",
        "while_let_expression",
        "match_expression",
    ],
    function_nodes: &["function_item", "closure_expression"],
    if_node_type: Some("if_expression"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["match_expression"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

pub static JAVA_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "for_statement",
        "enhanced_for_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
        "switch_expression",
    ],
    case_nodes: &["switch_label"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "enhanced_for_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
    ],
    function_nodes: &[
        "method_declaration",
        "constructor_declaration",
        "lambda_expression",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &["switch_expression"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

pub static CSHARP_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "for_statement",
        "for_each_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "conditional_expression",
        "switch_statement",
    ],
    case_nodes: &["switch_section"],
    logical_operators: &["&&", "||", "??"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: Some("conditional_access_expression"),
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "for_each_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "conditional_expression",
        "switch_statement",
    ],
    function_nodes: &[
        "method_declaration",
        "constructor_declaration",
        "lambda_expression",
        "local_function_statement",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

pub static RUBY_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if",
        "elsif",
        "else",
        "unless",
        "case",
        "for",
        "while",
        "until",
        "rescue",
        "conditional",
    ],
    case_nodes: &["when"],
    logical_operators: &["and", "or", "&&", "||"],
    logical_node_types: &["binary"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if",
        "unless",
        "case",
        "for",
        "while",
        "until",
        "rescue",
        "conditional",
    ],
    function_nodes: &["method", "singleton_method", "lambda", "do_block"],
    if_node_type: Some("if"),
    else_node_type: Some("else"),
    elif_node_type: Some("elsif"),
    else_via_alternative: false,
    switch_like_nodes: &["case"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

pub static PHP_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_if_clause",
        "else_clause",
        "for_statement",
        "foreach_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "conditional_expression",
        "switch_statement",
    ],
    case_nodes: &["case_statement", "default_statement"],
    logical_operators: &["&&", "||", "and", "or", "??"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: Some("nullsafe_member_access_expression"),
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "foreach_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "conditional_expression",
        "switch_statement",
    ],
    function_nodes: &[
        "function_definition",
        "method_declaration",
        "anonymous_function_creation_expression",
        "arrow_function",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: Some("else_if_clause"),
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// tree-sitter-c's if_statement wraps its else branch in a real `else_clause`
// node (`if_statement condition consequence else_clause(else [if_statement |
// <substatement>])`) — confirmed by parsing `if (..) {..} else if (..) {..}
// else {..}` and inspecting the S-expression. This is Pattern A (JS/C#/Rust
// style: an else_clause node wraps either a nested if_statement for
// `else if` or the plain else body), NOT Pattern C (Go/Java style, where the
// `alternative` field holds the substatement directly with no wrapper node).
// `walk()`'s node classification always returns after a `is_branch(kind)`
// match, so a type listed in BOTH branch_nodes and case_nodes is always
// treated as a generic branch — the case_nodes arm never fires (issue
// #2058). `switch_statement` (the container) belongs in branch_nodes +
// nesting_nodes (net-zero cyclomatic via switch_like_nodes, contributing
// nesting once, matching JS/Java/C#/PHP/Ruby/Bash); `case_statement` (each
// arm) belongs in case_nodes ONLY (flat `cyclomatic += 1`, no per-case
// cognitive/nesting weight) — not in branch_nodes.
pub static C_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "for_statement",
        "while_statement",
        "do_statement",
        "switch_statement",
        "conditional_expression",
    ],
    case_nodes: &["case_statement"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "do_statement",
        "switch_statement",
        "conditional_expression",
    ],
    function_nodes: &["function_definition"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// Mirrors C_RULES: tree-sitter-cpp's if_statement uses the same else_clause
// wrapper (Pattern A), confirmed by parsing the same if/else-if/else shape.
//
// CUDA (see `lang_rules` below) reuses this struct as-is: tree-sitter-cuda is
// a C++-superset grammar (only adding qualifier keywords and kernel-launch
// syntax), and parsing sample CUDA control flow confirms identical
// if_statement/else_clause/for_statement/while_statement/switch_statement/
// binary_expression node kinds to plain C++.
// Same branch_nodes/case_nodes fix as C_RULES (issue #2058) — see comment there.
pub static CPP_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "for_statement",
        "for_range_loop",
        "while_statement",
        "do_statement",
        "switch_statement",
        "conditional_expression",
        "catch_clause",
    ],
    case_nodes: &["case_statement"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "for_range_loop",
        "while_statement",
        "do_statement",
        "switch_statement",
        "catch_clause",
        "conditional_expression",
    ],
    function_nodes: &["function_definition"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// tree-sitter-objc extends tree-sitter-c: if_statement/for_statement/
// while_statement/do_statement/switch_statement/case_statement/
// conditional_expression/binary_expression are byte-identical to plain C
// (confirmed by parsing sample ObjC control flow and inspecting the
// S-expression), including the same else_clause wrapper (Pattern A). Two
// additions on top of C_RULES:
//   - `method_definition` (the `-`/`+` method body) joins `function_definition`
//     in function_nodes — its compound_statement body is a direct child
//     (unlike tree-sitter-dart's function_signature/function_body sibling
//     split, #2182), confirmed by parsing
//     `@implementation Foo - (void)bar { .. } @end`.
//   - `catch_clause` (from `@try`/`@catch`/`@finally`, which tree-sitter-objc
//     also models as a dedicated try_statement/catch_clause/finally_clause
//     shape) is a branch/nesting node, same treatment as CPP_RULES's
//     catch_clause.
// Same branch_nodes/case_nodes fix as C_RULES (issue #2058) — see comment
// there. Inherited the bug via copy from C_RULES when ObjC was added.
pub static OBJC_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "for_statement",
        "while_statement",
        "do_statement",
        "switch_statement",
        "conditional_expression",
        "catch_clause",
    ],
    case_nodes: &["case_statement"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "do_statement",
        "switch_statement",
        "catch_clause",
        "conditional_expression",
    ],
    function_nodes: &["function_definition", "method_definition"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// `when_entry` (each case arm) must NOT also be in branch_nodes — `walk()`
// always treats a branch_nodes match as a generic branch and never falls
// through to the case_nodes arm, so having it in both shadowed the
// intended flat case treatment with nesting-weighted branch treatment
// (issue #2058). `when_expression` (the container) already correctly sits
// in branch_nodes + nesting_nodes + switch_like_nodes.
pub static KOTLIN_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_expression",
        "for_statement",
        "while_statement",
        "do_while_statement",
        "catch_block",
        "when_expression",
    ],
    case_nodes: &["when_entry"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["conjunction_expression", "disjunction_expression"],
    optional_chain_type: Some("safe_navigation"),
    nesting_nodes: &[
        "if_expression",
        "for_statement",
        "while_statement",
        "do_while_statement",
        "catch_block",
        "when_expression",
    ],
    function_nodes: &["function_declaration"],
    if_node_type: Some("if_expression"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &["when_expression"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// tree-sitter-swift, like tree-sitter-kotlin, splits && / || into distinct
// node types (conjunction_expression / disjunction_expression) rather than
// sharing one generic binary node — confirmed by parsing `a && b || a` and
// inspecting the S-expression. `logical_node_types: &["binary_expression"]`
// never matches either operator, so Swift && / || were never counted.
// `switch_statement` (the container) was missing from branch_nodes AND
// nesting_nodes entirely — only switch_like_nodes, which is only consulted
// from inside the branch handler, so a Swift `switch` contributed zero
// nesting for its cases. `switch_entry` (each case arm) was also
// double-booked in branch_nodes + case_nodes, hitting the same shadowing
// bug as Kotlin's when_entry (issue #2058). Fixed to match the
// container-in-branch+nesting+switch_like / case-in-case_nodes-only
// pattern every other switch-having language in this file uses.
pub static SWIFT_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "for_in_statement",
        "while_statement",
        "repeat_while_statement",
        "catch_clause",
        "switch_statement",
        "ternary_expression",
        "guard_statement",
    ],
    case_nodes: &["switch_entry"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["conjunction_expression", "disjunction_expression"],
    optional_chain_type: Some("optional_chaining_expression"),
    nesting_nodes: &[
        "if_statement",
        "for_in_statement",
        "while_statement",
        "repeat_while_statement",
        "catch_clause",
        "switch_statement",
        "ternary_expression",
        "guard_statement",
    ],
    function_nodes: &["function_declaration", "init_declaration"],
    if_node_type: Some("if_statement"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &["switch_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// `case_clause` must NOT also be in branch_nodes — same shadowing bug as
// Kotlin's when_entry (issue #2058). `match_expression` (the container)
// already correctly sits in branch_nodes + nesting_nodes + switch_like_nodes.
pub static SCALA_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_expression",
        "for_expression",
        "while_expression",
        "do_while_expression",
        "catch_clause",
        "match_expression",
    ],
    case_nodes: &["case_clause"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["infix_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_expression",
        "for_expression",
        "while_expression",
        "do_while_expression",
        "catch_clause",
        "match_expression",
    ],
    function_nodes: &["function_definition"],
    if_node_type: Some("if_expression"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &["match_expression"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

pub static BASH_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "for_statement",
        "while_statement",
        "case_statement",
        "elif_clause",
    ],
    case_nodes: &["case_item"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "case_statement",
    ],
    function_nodes: &["function_definition"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: Some("elif_clause"),
    else_via_alternative: false,
    switch_like_nodes: &["case_statement"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// Lua's `if_statement` is flat, not nested: `elseif`/`else` are separate node
// kinds (`elseif_statement`, `else_statement`) attached to the *same*
// `if_statement` via repeated `alternative:` fields — confirmed by parsing
// `if a then .. elseif b then .. else .. end` with tree-sitter-lua and
// inspecting the S-expression. Structurally identical to Python's
// elif_clause/else_clause (Pattern B), not JS's nested else_clause>if_statement
// (Pattern A) or Go's alternative-holds-nested-if (Pattern C) — so
// else_via_alternative: false, and neither elseif_statement nor else_statement
// is in nesting_nodes (they're siblings of the primary if, not separately
// nested branches). Mirrors `complexityLua` in `src/ast-analysis/rules/b3.ts`.
//
// binary_expression is Lua's single generic binary-op node (arithmetic,
// comparison, concat, AND logical `and`/`or`) — same shared-type pattern as
// Ruby's `binary` node; handle_logical_op only fires when `node.child(1)` (the
// operator token) is in logical_operators, so comparisons/arithmetic sharing
// the same node kind are correctly ignored.
pub static LUA_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "elseif_statement",
        "else_statement",
        "for_statement",
        "while_statement",
        "repeat_statement",
    ],
    case_nodes: &[],
    logical_operators: &["and", "or"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "repeat_statement",
    ],
    // "function_declaration" covers named forms (`function f() end`,
    // `local function f() end`, `function M.foo() end`). "function_definition"
    // is the anonymous function *expression* node — the RHS of the common
    // module-table idiom `local M = {}; M.foo = function(...) end` (issue
    // #2036) as well as `local f = function() end` and any function literal
    // passed as a callback argument. Both node types have the same
    // `_function_body` shape (parameters/body fields), so every rule below
    // (branch/nesting/Halstead scope detection) applies identically to either.
    function_nodes: &["function_declaration", "function_definition"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_statement"),
    elif_node_type: Some("elseif_statement"),
    else_via_alternative: false,
    switch_like_nodes: &[],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// tree-sitter-zig's if_statement wraps its else branch in an `else_clause`
// node whose single named child is either a nested `if_statement` (else-if)
// or the terminal else body — confirmed by parsing `if (..) {..} else if
// (..) {..} else {..}` and inspecting the S-expression. Pattern A, same as
// JS/C#/Rust, even though the grammar internally tags that child with an
// `alternative` field name — the wrapper-node detection only checks the
// parent node's type, not field names, so that's immaterial.
//
// `and`/`or`/`orelse` are keyword operators sharing the single generic
// `binary_expression` node type (confirmed by parsing `a and b or c` and
// `a orelse b`) — same shared-type pattern as Lua's `and`/`or`.
//
// `catch_expression` (`expr catch fallback`, `expr catch |err| { .. }`) is
// a branch/nesting node, the same treatment C/C++/ObjC/C# give
// `catch_clause` — its fallback can be an arbitrary block with its own
// control flow, not just a coalescing value. `try_expression` (`try expr`)
// is NOT a branch — it propagates the error up rather than branching
// locally, mirroring how Rust's `?` operator is Halstead-only.
pub static ZIG_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "for_statement",
        "while_statement",
        "switch_expression",
        "catch_expression",
    ],
    case_nodes: &["switch_case"],
    logical_operators: &["and", "or", "orelse"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "switch_expression",
        "catch_expression",
    ],
    function_nodes: &["function_declaration"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["switch_expression"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

/// Mirrors the TS `complexity` export in `src/ast-analysis/rules/r.ts`.
///
/// Confirmed against tree-sitter-r 1.2.0's `src/node-types.json` and by
/// parsing sample R control flow. `if_statement` carries `consequence`/
/// `alternative` fields directly (no `else_clause` wrapper), so an else-if
/// chain is a nested `if_statement` reached via `alternative` — Pattern C,
/// same as Go/Java. R has no `switch` statement (`switch(x, ...)` is an
/// ordinary function call). `repeat` is an unconditional loop, the same
/// treatment Rust's `loop_expression` gets.
pub static R_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "repeat_statement",
    ],
    case_nodes: &[],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_operator"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "repeat_statement",
    ],
    function_nodes: &["function_definition"],
    if_node_type: Some("if_statement"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &[],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

/// Mirrors the TS `complexityGroovy` export in `src/ast-analysis/rules/b2.ts`.
///
/// tree-sitter-groovy extends tree-sitter-java's grammar, confirmed by
/// parsing sample if/else-if/else, classic and for-in loops, do-while,
/// switch/case, try/catch/finally, and ternary: node kinds and field names
/// are byte-identical to Java's (`alternative` field on `if_statement`, no
/// `else_clause` wrapper). The generic `closure` node type is deliberately
/// excluded from `function_nodes`: this grammar reuses `closure` ambiguously
/// for ordinary if/for/while/switch block bodies as well as real closure
/// literals, so treating it as a function boundary would fabricate a
/// spurious extra "function" for every such body.
pub static GROOVY_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "for_statement",
        "enhanced_for_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
        "switch_expression",
    ],
    case_nodes: &["switch_label"],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "enhanced_for_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
    ],
    function_nodes: &[
        "method_declaration",
        "constructor_definition",
        "constructor_declaration",
        "function_definition",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &["switch_expression"],
    logical_operators_by_text: false,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// tree-sitter-julia wraps EVERY binary operator token (`+`, `-`, `>`, `==`,
// `&&`, `||`, ...) in one generic `operator` leaf node — `binary_expression`
// is shared by arithmetic, comparison, AND logical expressions alike, and
// only the leaf's `.text` distinguishes which operator it actually is
// (confirmed by parsing `x > 0 && y > 0`). `logical_operators_by_text: true`
// makes `handle_logical_op` compare `.text` instead of `.kind()` for both
// the operator-token extraction AND the same-sequence parent check (issue
// #2312).
//
// `elseif_clause`/`else_clause` are genuine, distinctly-typed nodes reached
// via the SAME `alternative` field (repeated per elseif, terminal `else`) —
// confirmed by parsing `if a elseif b elseif c else d end`: this is
// structurally Pattern B (explicit elif node, same as Python/Ruby/PHP/Lua),
// NOT Solidity's transparent-wrapper shape — no `transparent_wrapper_types`
// needed here.
//
// `do_clause` (`map(xs) do x ... end`) is NOT in `function_nodes`: the JS/
// Rust extractor (`extractJuliaSymbols`/`JuliaExtractor`) does not treat it
// as a scope boundary either, so a do-block's body is walked as part of
// its enclosing function, matching existing extractor/dataflow behavior
// rather than introducing new scope-detection machinery in this PR.
//
// Short-form function definitions (`add(x, y) = x + y`) have LHS
// `call_expression` under a plain `assignment` node — the SAME node type
// used for ordinary variable assignment, with no distinct wrapper to key
// off. Adding `assignment` to `function_nodes` would misclassify every
// plain assignment statement as a function boundary. This mirrors the
// existing, accepted limitation of `dataflowJulia`/R's `binary_operator`
// dataflow config: the extractor calls `compute_all_metrics` directly on
// the node it already knows is a short-form function (see
// `handle_assignment` in `extractors/julia.rs`), independent of this
// generic `function_nodes` set, which is only consulted for NESTED
// function-boundary detection during a walk already in progress.
pub static JULIA_RULES: LangRules = LangRules {
    // `try_statement` itself is NOT a branch/nesting node, only
    // `catch_clause` is — mirrors every other try/catch language here (JS/
    // Java/C#/PHP/Ruby): `try` alone doesn't add a decision path.
    branch_nodes: &[
        "if_statement",
        "elseif_clause",
        "else_clause",
        "for_statement",
        "while_statement",
        "catch_clause",
        "ternary_expression",
    ],
    case_nodes: &[],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "catch_clause",
        "ternary_expression",
    ],
    function_nodes: &["function_definition"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: Some("elseif_clause"),
    else_via_alternative: false,
    switch_like_nodes: &[],
    logical_operators_by_text: true,
    transparent_wrapper_types: &[],
    else_keyword_type: None,
    comment_types: &[],
};

// tree-sitter-solidity's `if_statement` has NO `else_clause` wrapper node and
// NO `alternative` field (unlike Go/Java's Pattern C) — instead, BOTH the
// then- and else-branch bodies are reached via the SAME field name (`body`),
// each wrapped in a generic, single-named-child `statement` supertype-alias
// node, with the bare `else` keyword as an ordinary sibling token in
// between. Confirmed by parsing `if (x>0) {..} else if (y>0) {..} else {..}`
// and inspecting field names: `if_statement[if, (condition) expr, (body)
// statement, (else) else, (body) statement[if_statement | block_statement]]`.
// `transparent_wrapper_types`/`else_keyword_type` (Pattern D) detect an
// else-if / plain-else by walking through the `statement` wrapper and
// checking whether its preceding sibling is the bare `else` token (issue
// #2312) — see `is_pattern_d_else_if`/`is_pattern_d_else`.
//
// The condition (and other value positions: return values, ternary
// branches, call arguments) is ALSO wrapped in a generic `expression`
// node — this breaks `handle_logical_op`'s same-operator-sequence check for
// a chained `a && b && c` (the inner `binary_expression`'s parent is an
// `expression` wrapper, not the outer `binary_expression`), independently
// of the if/else-if bug above. `transparent_wrapper_types` includes
// `expression` too so `effective_parent` sees through it, restoring correct
// cognitive counting for chained logical operators.
//
// Every operator token (`>`, `&&`, `==`, ...) has its OWN distinct node kind
// here (unlike Julia) — confirmed by parsing the same snippet — so
// `logical_operators_by_text` is NOT needed for Solidity.
//
// `try_statement` itself is deliberately NOT a branch/nesting node — only
// each `catch_clause` is, mirroring every other language here (JS/Java/C#/
// PHP/Ruby): `try` alone doesn't add a decision path, only a catch arm
// does. Multiple `catch_clause` siblings on one `try` (Solidity commonly
// has `catch Error(...) {..} catch {..}`) are each counted individually,
// same as a multi-catch language would be.
pub static SOLIDITY_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "while_statement",
        "for_statement",
        "catch_clause",
        "ternary_expression",
    ],
    case_nodes: &[],
    logical_operators: &["&&", "||"],
    logical_node_types: &["binary_expression"],
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "while_statement",
        "for_statement",
        "catch_clause",
        "ternary_expression",
    ],
    function_nodes: &["function_definition", "modifier_definition"],
    if_node_type: Some("if_statement"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &[],
    logical_operators_by_text: false,
    transparent_wrapper_types: &["statement", "expression"],
    else_keyword_type: Some("else"),
    comment_types: &["comment"],
};

/// Look up complexity rules by language ID (matches `COMPLEXITY_RULES` keys in JS).
///
/// No "dart" arm yet (tracked by #1923's tier-2 rollout). When one is added:
/// tree-sitter-dart puts a function's body in a SIBLING node, not a child of
/// function_signature/method_signature (#2182 — see
/// `src/ast-analysis/rules/b2.ts`'s `dataflowDart` for the TS-side fix and
/// `crate::shared::ast_nodes::find_body_sibling_node` for the ready-to-use
/// Rust helper). `LangRules` will need a `body_sibling_types` field and
/// `walk()` below will need to call the helper additively, mirroring
/// `src/ast-analysis/visitor.ts`'s `bodySiblingTypes` handling.
pub fn lang_rules(lang_id: &str) -> Option<&'static LangRules> {
    match lang_id {
        "javascript" | "typescript" | "tsx" => Some(&JS_TS_RULES),
        "python" => Some(&PYTHON_RULES),
        "go" => Some(&GO_RULES),
        "rust" => Some(&RUST_LANG_RULES),
        "java" => Some(&JAVA_RULES),
        "csharp" => Some(&CSHARP_RULES),
        "ruby" => Some(&RUBY_RULES),
        "php" => Some(&PHP_RULES),
        "c" => Some(&C_RULES),
        "cpp" | "cuda" => Some(&CPP_RULES),
        "objc" => Some(&OBJC_RULES),
        "kotlin" => Some(&KOTLIN_RULES),
        "swift" => Some(&SWIFT_RULES),
        "scala" => Some(&SCALA_RULES),
        "bash" => Some(&BASH_RULES),
        "lua" => Some(&LUA_RULES),
        "zig" => Some(&ZIG_RULES),
        "r" => Some(&R_RULES),
        "groovy" => Some(&GROOVY_RULES),
        "julia" => Some(&JULIA_RULES),
        "solidity" => Some(&SOLIDITY_RULES),
        _ => None,
    }
}

// ─── Single-traversal DFS complexity computation ──────────────────────────

/// Compute cognitive complexity, cyclomatic complexity, and max nesting depth
/// for a function's AST subtree in a single DFS walk.
///
/// This is a faithful port of `computeFunctionComplexity()` from `src/complexity.js`.
/// `source` is only consulted when `rules.logical_operators_by_text` is set
/// (Julia) — every other language ignores it, same as before this parameter
/// was added.
pub fn compute_function_complexity(
    function_node: &Node,
    source: &[u8],
    rules: &LangRules,
) -> ComplexityMetrics {
    let mut cognitive: u32 = 0;
    let mut cyclomatic: u32 = 1; // McCabe starts at 1
    let mut max_nesting: u32 = 0;

    walk(
        function_node,
        source,
        0,
        true,
        rules,
        &mut cognitive,
        &mut cyclomatic,
        &mut max_nesting,
        0,
    );

    ComplexityMetrics::basic(cognitive, cyclomatic, max_nesting)
}

#[allow(clippy::too_many_arguments)]
fn walk_children(
    node: &Node,
    source: &[u8],
    nesting_level: u32,
    is_top_function: bool,
    rules: &LangRules,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
    max_nesting: &mut u32,
    depth: usize,
) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk(
                &child,
                source,
                nesting_level,
                is_top_function,
                rules,
                cognitive,
                cyclomatic,
                max_nesting,
                depth + 1,
            );
        }
    }
}

// ─── Shared complexity classification helpers ────────────────────────────

/// Detect whether this node is an else-if via Pattern A (JS/C#/Rust: if inside
/// else_clause), Pattern B (Python/Ruby/PHP: explicit elif node), or Pattern C
/// (Go/Java: if_statement as `alternative` of parent if).
///
/// Returns a `BranchAction` telling the caller what cognitive/cyclomatic
/// adjustments to make and what nesting delta to apply to children.
enum BranchAction {
    /// Node handled — walk children at the given nesting delta, then return.
    Handled {
        cognitive_delta: u32,
        cyclomatic_delta: u32,
        nesting_delta: u32,
    },
}

/// Classify a branch node (one where `rules.is_branch(kind)` is true).
fn classify_branch(node: &Node, kind: &str, rules: &LangRules, nesting_level: u32) -> BranchAction {
    // Pattern A: else clause wraps if (JS/C#/Rust)
    if let Some(else_type) = rules.else_node_type {
        if kind == else_type {
            let is_else_if = node.named_child(0).map_or(false, |c| {
                rules.if_node_type.map_or(false, |if_t| c.kind() == if_t)
            });
            if is_else_if {
                // else-if: the if_statement child handles its own increment
                return BranchAction::Handled {
                    cognitive_delta: 0,
                    cyclomatic_delta: 0,
                    nesting_delta: 0,
                };
            }
            // Plain else
            return BranchAction::Handled {
                cognitive_delta: 1,
                cyclomatic_delta: 0,
                nesting_delta: 0,
            };
        }
    }

    // Pattern B: explicit elif node (Python/Ruby/PHP)
    if let Some(elif_type) = rules.elif_node_type {
        if kind == elif_type {
            return BranchAction::Handled {
                cognitive_delta: 1,
                cyclomatic_delta: 1,
                nesting_delta: 0,
            };
        }
    }

    // Detect else-if via Pattern A or C
    if detect_else_if(node, kind, rules) {
        return BranchAction::Handled {
            cognitive_delta: 1,
            cyclomatic_delta: 1,
            nesting_delta: 0,
        };
    }

    // Regular branch node
    let mut cyc = 1u32;
    if rules.is_switch_like(kind) {
        cyc = 0; // Cases handle cyclomatic, not the switch itself
    }
    let nest = if rules.is_nesting(kind) { 1u32 } else { 0u32 };
    BranchAction::Handled {
        cognitive_delta: 1 + nesting_level,
        cyclomatic_delta: cyc,
        nesting_delta: nest,
    }
}

/// Effective parent: skip over consecutive nodes whose kind is in
/// `rules.transparent_wrapper_types` (e.g. Solidity's `statement`/
/// `expression` supertype-alias wrapper nodes) to find the nearest
/// structurally-meaningful ancestor. Degenerates to plain `.parent()` for
/// every language that leaves `transparent_wrapper_types` empty.
fn effective_parent<'a>(node: &Node<'a>, rules: &LangRules) -> Option<Node<'a>> {
    let mut p = node.parent();
    while let Some(ref candidate) = p {
        if rules.transparent_wrapper_types.contains(&candidate.kind()) {
            p = candidate.parent();
        } else {
            break;
        }
    }
    p
}

/// Detect Pattern D else-if: node's immediate parent is a transparent
/// wrapper (e.g. Solidity's `statement`, reached via the SAME field name —
/// `body` — for both the then- and else-branch, with no dedicated
/// `else_clause` node and no `alternative` field) whose preceding sibling is
/// the bare `else` keyword token. Mirrors Pattern A's role but for grammars
/// that dropped the wrapping node entirely (issue #2312).
fn is_pattern_d_else_if(node: &Node, rules: &LangRules) -> bool {
    if rules.transparent_wrapper_types.is_empty() {
        return false;
    }
    let Some(else_kw) = rules.else_keyword_type else {
        return false;
    };
    let Some(wrapper) = node.parent() else {
        return false;
    };
    if !rules.transparent_wrapper_types.contains(&wrapper.kind()) {
        return false;
    }
    // Skip comment nodes when walking backward: `else /* note */ if (...)`
    // still counts as an else-if even though a comment sibling sits between
    // the `else` token and the wrapper (Greptile review, PR #2472).
    let mut sib = wrapper.prev_sibling();
    while let Some(candidate) = sib {
        if rules.comment_types.contains(&candidate.kind()) {
            sib = candidate.prev_sibling();
        } else {
            break;
        }
    }
    sib.is_some_and(|s| s.kind() == else_kw)
}

/// Detect whether an if-node is actually an else-if (Pattern A, C, or D).
fn detect_else_if(node: &Node, kind: &str, rules: &LangRules) -> bool {
    if !rules.if_node_type.map_or(false, |if_t| kind == if_t) {
        return false;
    }
    if rules.else_via_alternative {
        // Pattern C (Go/Java): if_statement is the alternative of parent if_statement
        if let Some(parent) = node.parent() {
            if rules
                .if_node_type
                .map_or(false, |if_t| parent.kind() == if_t)
            {
                if let Some(alt) = parent.child_by_field_name("alternative") {
                    if alt.id() == node.id() {
                        return true;
                    }
                }
            }
        }
    } else if rules.else_node_type.is_some() {
        // Pattern A (JS/C#/Rust): if_statement inside else_clause
        if let Some(parent) = node.parent() {
            if rules
                .else_node_type
                .map_or(false, |else_t| parent.kind() == else_t)
            {
                return true;
            }
        }
    }
    // Pattern D (Solidity): if_statement reached via a transparent wrapper
    // whose preceding sibling is the bare else keyword.
    is_pattern_d_else_if(node, rules)
}

/// Detect Pattern C plain else: a non-if block that is the `alternative` of an
/// if_statement (Go/Java).
fn is_pattern_c_else(node: &Node, kind: &str, rules: &LangRules) -> bool {
    if !rules.else_via_alternative {
        return false;
    }
    if rules.if_node_type.map_or(false, |if_t| kind == if_t) {
        return false; // This is an if, not a plain else block
    }
    if let Some(parent) = node.parent() {
        if rules
            .if_node_type
            .map_or(false, |if_t| parent.kind() == if_t)
        {
            if let Some(alt) = parent.child_by_field_name("alternative") {
                return alt.id() == node.id();
            }
        }
    }
    false
}

/// Detect Pattern D plain else: a non-if block (e.g. `block_statement`) whose
/// immediate parent is a transparent wrapper preceded by the bare `else`
/// keyword — the Pattern-D counterpart to `is_pattern_c_else`, for grammars
/// with no `else_clause` node and no `alternative` field (Solidity).
fn is_pattern_d_else(node: &Node, kind: &str, rules: &LangRules) -> bool {
    if rules.if_node_type.map_or(false, |if_t| kind == if_t) {
        return false; // if_statement is handled by detect_else_if instead
    }
    is_pattern_d_else_if(node, rules)
}

/// Extract a logical/binary operator token's comparison key: `.text` when
/// `by_text` is set (grammars where every operator shares one generic node
/// kind, e.g. tree-sitter-julia's `operator`), otherwise `.kind()` (every
/// other grammar, where the node kind already equals the operator's literal
/// text — behavior is unchanged).
fn operator_key<'a>(op_node: &Node, source: &'a [u8], by_text: bool) -> &'a str {
    if by_text {
        op_node.utf8_text(source).unwrap_or("")
    } else {
        op_node.kind()
    }
}

/// Handle logical operator nodes: returns true if the node was a logical op
/// (caller should walk children and return).
fn handle_logical_op(
    node: &Node,
    kind: &str,
    source: &[u8],
    rules: &LangRules,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
) -> bool {
    if !rules.logical_node_types.contains(&kind) {
        return false;
    }
    let Some(op_node) = node.child(1) else {
        return false;
    };
    let op = operator_key(&op_node, source, rules.logical_operators_by_text);
    if !rules.is_logical_op(op) {
        return false;
    }

    *cyclomatic += 1;

    // Cognitive: +1 only when operator changes from the previous sibling
    // sequence. `effective_parent` walks through transparent wrapper nodes
    // (e.g. Solidity's `expression`) that would otherwise hide a
    // same-operator chain's real parent binary_expression (issue #2312).
    let same_sequence = effective_parent(node, rules).map_or(false, |parent| {
        rules.logical_node_types.contains(&parent.kind())
            && parent.child(1).map_or(false, |pop| {
                operator_key(&pop, source, rules.logical_operators_by_text) == op
            })
    });
    if !same_sequence {
        *cognitive += 1;
    }
    true
}

// ─── walk (complexity-only DFS) ─────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn walk(
    node: &Node,
    source: &[u8],
    nesting_level: u32,
    is_top_function: bool,
    rules: &LangRules,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
    max_nesting: &mut u32,
    depth: usize,
) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    let kind = node.kind();

    if nesting_level > *max_nesting {
        *max_nesting = nesting_level;
    }

    // Logical operators
    if handle_logical_op(node, kind, source, rules, cognitive, cyclomatic) {
        walk_children(
            node,
            source,
            nesting_level,
            false,
            rules,
            cognitive,
            cyclomatic,
            max_nesting,
            depth,
        );
        return;
    }

    // Optional chaining (cyclomatic only)
    if let Some(opt_type) = rules.optional_chain_type {
        if kind == opt_type {
            *cyclomatic += 1;
        }
    }

    // Branch/control flow nodes (skip keyword leaf tokens)
    if rules.is_branch(kind) && node.child_count() > 0 {
        let BranchAction::Handled {
            cognitive_delta,
            cyclomatic_delta,
            nesting_delta,
        } = classify_branch(node, kind, rules, nesting_level);
        *cognitive += cognitive_delta;
        *cyclomatic += cyclomatic_delta;
        walk_children(
            node,
            source,
            nesting_level + nesting_delta,
            false,
            rules,
            cognitive,
            cyclomatic,
            max_nesting,
            depth,
        );
        return;
    }

    // Pattern C plain else (Go/Java) / Pattern D plain else (Solidity)
    if is_pattern_c_else(node, kind, rules) || is_pattern_d_else(node, kind, rules) {
        *cognitive += 1;
        walk_children(
            node,
            source,
            nesting_level,
            false,
            rules,
            cognitive,
            cyclomatic,
            max_nesting,
            depth,
        );
        return;
    }

    // Case nodes (cyclomatic only, skip keyword leaves)
    if rules.is_case(kind) && node.child_count() > 0 {
        *cyclomatic += 1;
    }

    // Nested function definitions (increase nesting)
    if !is_top_function && rules.is_function(kind) {
        walk_children(
            node,
            source,
            nesting_level + 1,
            false,
            rules,
            cognitive,
            cyclomatic,
            max_nesting,
            depth,
        );
        return;
    }

    walk_children(
        node,
        source,
        nesting_level,
        false,
        rules,
        cognitive,
        cyclomatic,
        max_nesting,
        depth,
    );
}

// ─── Halstead Operator/Operand Classification ─────────────────────────────

/// Language-specific Halstead classification rules.
pub struct HalsteadRules {
    pub operator_leaf_types: &'static [&'static str],
    pub operand_leaf_types: &'static [&'static str],
    pub compound_operators: &'static [&'static str],
    pub skip_types: &'static [&'static str],
    /// Compare an operator LEAF node by its `.text` instead of its `.kind()`
    /// when classifying Halstead operators. Needed for grammars where every
    /// operator token shares one generic leaf kind (tree-sitter-julia's
    /// `operator`) — matching by `.kind()` alone would collapse every
    /// distinct operator (+, -, >, &&, ...) into a single vocabulary entry,
    /// corrupting n1 (distinct operator count). False for every other
    /// language, where behavior is unchanged.
    pub operator_leaf_types_by_text: bool,
}

pub static JS_TS_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+",
        "-",
        "*",
        "/",
        "%",
        "**",
        "=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "**=",
        "<<=",
        ">>=",
        ">>>=",
        "&=",
        "|=",
        "^=",
        "&&=",
        "||=",
        "??=",
        "==",
        "===",
        "!=",
        "!==",
        "<",
        ">",
        "<=",
        ">=",
        "&&",
        "||",
        "!",
        "??",
        "&",
        "|",
        "^",
        "~",
        "<<",
        ">>",
        ">>>",
        "++",
        "--",
        "typeof",
        "instanceof",
        "new",
        "return",
        "throw",
        "yield",
        "await",
        "if",
        "else",
        "for",
        "while",
        "do",
        "switch",
        "case",
        "break",
        "continue",
        "try",
        "catch",
        "finally",
        "=>",
        "...",
        "?",
        ":",
        ".",
        "?.",
        ",",
        ";",
    ],
    operand_leaf_types: &[
        "identifier",
        "property_identifier",
        "shorthand_property_identifier",
        "shorthand_property_identifier_pattern",
        "number",
        "string_fragment",
        "regex_pattern",
        "true",
        "false",
        "null",
        "undefined",
        "this",
        "super",
        "private_property_identifier",
    ],
    compound_operators: &[
        "call_expression",
        "subscript_expression",
        "new_expression",
        "template_substitution",
    ],
    skip_types: &[
        "type_annotation",
        "type_parameters",
        "return_type",
        "implements_clause",
    ],
    operator_leaf_types_by_text: false,
};

pub static PYTHON_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "**", "//", "=", "+=", "-=", "*=", "/=", "%=", "**=", "//=", "&=",
        "|=", "^=", "<<=", ">>=", "==", "!=", "<", ">", "<=", ">=", "and", "or", "not", "&", "|",
        "^", "~", "<<", ">>", "if", "else", "elif", "for", "while", "with", "try", "except",
        "finally", "raise", "return", "yield", "await", "pass", "break", "continue", "import",
        "from", "as", "in", "is", "lambda", "del", ".", ",", ":", "@", "->",
    ],
    operand_leaf_types: &[
        "identifier",
        "integer",
        "float",
        "string_content",
        "true",
        "false",
        "none",
    ],
    compound_operators: &["call", "subscript", "attribute"],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

pub static GO_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+",
        "-",
        "*",
        "/",
        "%",
        "=",
        ":=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        "==",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        "&&",
        "||",
        "!",
        "&",
        "|",
        "^",
        "~",
        "<<",
        ">>",
        "&^",
        "++",
        "--",
        "if",
        "else",
        "for",
        "switch",
        "select",
        "case",
        "default",
        "return",
        "break",
        "continue",
        "goto",
        "fallthrough",
        "go",
        "defer",
        "range",
        "chan",
        "func",
        "var",
        "const",
        "type",
        "struct",
        "interface",
        ".",
        ",",
        ";",
        ":",
        "<-",
    ],
    operand_leaf_types: &[
        "identifier",
        "field_identifier",
        "package_identifier",
        "type_identifier",
        "int_literal",
        "float_literal",
        "imaginary_literal",
        "rune_literal",
        "interpreted_string_literal",
        "raw_string_literal",
        "true",
        "false",
        "nil",
        "iota",
    ],
    compound_operators: &["call_expression", "index_expression", "selector_expression"],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

pub static RUST_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=", "&&", "||", "!", "&", "|", "^", "<<", ">>", "if", "else",
        "for", "while", "loop", "match", "return", "break", "continue", "let", "mut", "ref", "as",
        "in", "move", "fn", "struct", "enum", "trait", "impl", "pub", "mod", "use", ".", ",", ";",
        ":", "::", "=>", "->", "?",
    ],
    operand_leaf_types: &[
        "identifier",
        "field_identifier",
        "type_identifier",
        "integer_literal",
        "float_literal",
        "string_content",
        "char_literal",
        "true",
        "false",
        "self",
        "Self",
    ],
    compound_operators: &["call_expression", "index_expression", "field_expression"],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

pub static JAVA_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+",
        "-",
        "*",
        "/",
        "%",
        "=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        ">>>=",
        "==",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        "&&",
        "||",
        "!",
        "&",
        "|",
        "^",
        "~",
        "<<",
        ">>",
        ">>>",
        "++",
        "--",
        "instanceof",
        "new",
        "if",
        "else",
        "for",
        "while",
        "do",
        "switch",
        "case",
        "return",
        "throw",
        "break",
        "continue",
        "try",
        "catch",
        "finally",
        ".",
        ",",
        ";",
        ":",
        "?",
        "->",
    ],
    operand_leaf_types: &[
        "identifier",
        "type_identifier",
        "decimal_integer_literal",
        "hex_integer_literal",
        "octal_integer_literal",
        "binary_integer_literal",
        "decimal_floating_point_literal",
        "hex_floating_point_literal",
        "string_literal",
        "character_literal",
        "true",
        "false",
        "null",
        "this",
        "super",
    ],
    compound_operators: &[
        "method_invocation",
        "array_access",
        "object_creation_expression",
    ],
    skip_types: &["type_arguments", "type_parameters"],
    operator_leaf_types_by_text: false,
};

pub static CSHARP_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=", "&&", "||", "!", "??", "??=", "&", "|", "^", "~", "<<",
        ">>", "++", "--", "is", "as", "new", "typeof", "sizeof", "nameof", "if", "else", "for",
        "foreach", "while", "do", "switch", "case", "return", "throw", "break", "continue", "try",
        "catch", "finally", "await", "yield", ".", "?.", ",", ";", ":", "=>", "->",
    ],
    operand_leaf_types: &[
        "identifier",
        "integer_literal",
        "real_literal",
        "string_literal",
        "character_literal",
        "verbatim_string_literal",
        "interpolated_string_text",
        "true",
        "false",
        "null",
        "this",
        "base",
    ],
    compound_operators: &[
        "invocation_expression",
        "element_access_expression",
        "object_creation_expression",
    ],
    skip_types: &["type_argument_list", "type_parameter_list"],
    operator_leaf_types_by_text: false,
};

pub static RUBY_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "**", "=", "+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=",
        "<<=", ">>=", "==", "!=", "<", ">", "<=", ">=", "<=>", "===", "=~", "!~", "&&", "||", "!",
        "and", "or", "not", "&", "|", "^", "~", "<<", ">>", "if", "else", "elsif", "unless",
        "case", "when", "for", "while", "until", "do", "begin", "end", "return", "raise", "break",
        "next", "redo", "retry", "rescue", "ensure", "yield", "def", "class", "module", ".", ",",
        ":", "::", "=>", "->",
    ],
    operand_leaf_types: &[
        "identifier",
        "constant",
        "instance_variable",
        "class_variable",
        "global_variable",
        "integer",
        "float",
        "string_content",
        "symbol",
        "true",
        "false",
        "nil",
        "self",
    ],
    compound_operators: &["call", "element_reference"],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

pub static PHP_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+",
        "-",
        "*",
        "/",
        "%",
        "**",
        "=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "**=",
        ".=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        "==",
        "===",
        "!=",
        "!==",
        "<",
        ">",
        "<=",
        ">=",
        "<=>",
        "&&",
        "||",
        "!",
        "and",
        "or",
        "xor",
        "??",
        "&",
        "|",
        "^",
        "~",
        "<<",
        ">>",
        "++",
        "--",
        "instanceof",
        "new",
        "clone",
        "if",
        "else",
        "elseif",
        "for",
        "foreach",
        "while",
        "do",
        "switch",
        "case",
        "return",
        "throw",
        "break",
        "continue",
        "try",
        "catch",
        "finally",
        "echo",
        "print",
        "yield",
        ".",
        "->",
        "?->",
        "::",
        ",",
        ";",
        ":",
        "?",
        "=>",
    ],
    operand_leaf_types: &[
        "name",
        "variable_name",
        "integer",
        "float",
        "string_content",
        "true",
        "false",
        "null",
    ],
    compound_operators: &[
        "function_call_expression",
        "member_call_expression",
        "scoped_call_expression",
        "subscript_expression",
        "object_creation_expression",
    ],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

pub static C_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=", "&&", "||", "!", "&", "|", "^", "~", "<<", ">>", "++",
        "--", "sizeof", "if", "else", "for", "while", "do", "switch", "case", "return", "break",
        "continue", "goto", ".", "->", ",", ";", ":", "?",
    ],
    operand_leaf_types: &[
        "identifier",
        "type_identifier",
        "field_identifier",
        "number_literal",
        "string_literal",
        "char_literal",
        "true",
        "false",
        "null",
    ],
    compound_operators: &["call_expression", "subscript_expression"],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

pub static CPP_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=", "&&", "||", "!", "&", "|", "^", "~", "<<", ">>", "++",
        "--", "sizeof", "new", "delete", "throw", "if", "else", "for", "while", "do", "switch",
        "case", "return", "break", "continue", "try", "catch", ".", "->", "::", ",", ";", ":", "?",
    ],
    operand_leaf_types: &[
        "identifier",
        "type_identifier",
        "field_identifier",
        "namespace_identifier",
        "number_literal",
        "string_literal",
        "raw_string_literal",
        "char_literal",
        "true",
        "false",
        "nullptr",
        "this",
    ],
    compound_operators: &["call_expression", "subscript_expression", "new_expression"],
    skip_types: &["template_argument_list", "template_parameter_list"],
    operator_leaf_types_by_text: false,
};

// Extends C_HALSTEAD with ObjC's `@try`/`@catch`/`@finally`/`@throw`/
// `@synchronized` keyword tokens (each its own anonymous leaf node in
// tree-sitter-objc, confirmed by parsing) and treats `message_expression`
// (`[receiver selector:arg]`) and `selector_expression` (`@selector(...)`) as
// compound operators, the same way `call_expression` is already treated —
// their leaf children (receiver/selector/argument identifiers) fall through
// to the shared identifier operand rule below.
pub static OBJC_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+",
        "-",
        "*",
        "/",
        "%",
        "=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        "==",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        "&&",
        "||",
        "!",
        "&",
        "|",
        "^",
        "~",
        "<<",
        ">>",
        "++",
        "--",
        "sizeof",
        "if",
        "else",
        "for",
        "while",
        "do",
        "switch",
        "case",
        "return",
        "break",
        "continue",
        "goto",
        "@try",
        "@catch",
        "@finally",
        "@throw",
        "@synchronized",
        ".",
        "->",
        ",",
        ";",
        ":",
        "?",
    ],
    operand_leaf_types: &[
        "identifier",
        "type_identifier",
        "field_identifier",
        "number_literal",
        "string_literal",
        "char_literal",
        "true",
        "false",
        "null",
    ],
    compound_operators: &[
        "call_expression",
        "subscript_expression",
        "message_expression",
        "selector_expression",
    ],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

pub static KOTLIN_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "=", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<", ">", "<=",
        ">=", "===", "!==", "&&", "||", "!", "++", "--", "..", "?:", "?.", "is", "as", "as?", "in",
        "!in", "if", "else", "for", "while", "do", "when", "return", "throw", "break", "continue",
        "try", "catch", "finally", ".", ",", ";", ":", "?", "->",
    ],
    operand_leaf_types: &[
        "simple_identifier",
        "type_identifier",
        "integer_literal",
        "long_literal",
        "real_literal",
        "hex_literal",
        "bin_literal",
        "string_literal",
        "character_literal",
        "true",
        "false",
        "null",
        "this",
        "super",
    ],
    compound_operators: &["call_expression", "indexing_expression"],
    skip_types: &["type_arguments", "type_parameters"],
    operator_leaf_types_by_text: false,
};

pub static SWIFT_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "=", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<", ">", "<=",
        ">=", "===", "!==", "&&", "||", "!", "?", "??", "...", "..<", "is", "as", "as?", "as!",
        "if", "else", "for", "while", "repeat", "switch", "guard", "return", "throw", "break",
        "continue", "try", "catch", ".", ",", ";", ":", "->",
    ],
    operand_leaf_types: &[
        "simple_identifier",
        "type_identifier",
        "integer_literal",
        "real_literal",
        "hex_literal",
        "oct_literal",
        "bin_literal",
        "string_literal",
        "true",
        "false",
        "nil",
        "self",
        "super",
    ],
    compound_operators: &["call_expression", "subscript_expression"],
    skip_types: &["type_arguments", "type_parameters"],
    operator_leaf_types_by_text: false,
};

pub static SCALA_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "=", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<", ">", "<=",
        ">=", "&&", "||", "!", "::", "++", ":+", "+:", "if", "else", "for", "while", "do", "match",
        "case", "return", "throw", "yield", "try", "catch", "finally", ".", ",", ";", ":", "=>",
        "<-",
    ],
    operand_leaf_types: &[
        "identifier",
        "type_identifier",
        "integer_literal",
        "floating_point_literal",
        "string_literal",
        "character_literal",
        "symbol_literal",
        "true",
        "false",
        "null",
        "this",
        "super",
    ],
    compound_operators: &["call_expression", "field_expression"],
    skip_types: &["type_arguments", "type_parameters"],
    operator_leaf_types_by_text: false,
};

pub static BASH_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "=", "==", "!=", "-eq", "-ne", "-lt", "-gt", "-le", "-ge", "-z", "-n", "-f", "-d", "-e",
        "-r", "-w", "-x", "&&", "||", "!", "|", ">>", ">", "<", "<<", "if", "then", "else", "elif",
        "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "return", "exit",
        "break", "continue", ";", ";;",
    ],
    operand_leaf_types: &[
        "word",
        "variable_name",
        "string",
        "number",
        "raw_string",
        "simple_expansion",
        "expansion",
        "command_name",
    ],
    compound_operators: &["command", "command_substitution", "pipeline"],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

// Member/method access (`dot_index_expression` `.`, `method_index_expression`
// `:`) and invocation (`function_call`) are wrapper nodes without a dedicated
// "call happened" token, so they're counted as compound operators — mirrors
// Python's ["call", "subscript", "attribute"]. The '.'/':' separator tokens
// are ALSO in operator_leaf_types (matching Python counting both "attribute"
// and "."), so member access contributes two distinct operator kinds,
// consistent with the other languages above. Mirrors `halsteadLua` in
// `src/ast-analysis/rules/b3.ts`.
pub static LUA_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "//", "%", "^", "#", "..", "==", "~=", "<=", ">=", "<", ">", "=",
        "and", "or", "not", "&", "|", "~", "<<", ">>", ".", ",", ":", "::", ";", "if", "then",
        "else", "elseif", "end", "for", "while", "do", "repeat", "until", "function", "local",
        "return", "break", "goto", "in",
    ],
    operand_leaf_types: &[
        "identifier",
        "number",
        "string_content",
        "true",
        "false",
        "nil",
        "...",
    ],
    compound_operators: &[
        "function_call",
        "bracket_index_expression",
        "dot_index_expression",
        "method_index_expression",
    ],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

// Zig has no `++`/`--` (increments are `x += 1`) and no `case` keyword in
// switch arms (`1 => ..`, confirmed by parsing), so neither appears below.
// Literal wrapper nodes (`character`, `string`, `boolean`) have non-empty
// children, so their leaf *content* tokens (`character_content`,
// `string_content`, `true`/`false`) are the operand leaves — same split
// RUST_HALSTEAD already uses for `string_content`.
pub static ZIG_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+",
        "-",
        "*",
        "/",
        "%",
        "=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        "==",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        "!",
        "&",
        "|",
        "^",
        "~",
        "<<",
        ">>",
        "and",
        "or",
        "orelse",
        "try",
        "catch",
        "if",
        "else",
        "for",
        "while",
        "switch",
        "return",
        "break",
        "continue",
        "unreachable",
        "defer",
        "const",
        "var",
        "pub",
        "fn",
        "struct",
        "enum",
        "union",
        "error",
        "comptime",
        ".",
        "..",
        ".?",
        ".*",
        ",",
        ";",
        ":",
        "?",
        "=>",
        "->",
    ],
    operand_leaf_types: &[
        "identifier",
        "builtin_type",
        "integer",
        "float",
        "string_content",
        "character_content",
        "true",
        "false",
        "null",
        "undefined",
    ],
    compound_operators: &["call_expression", "field_expression", "index_expression"],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

/// Mirrors the TS `halstead` export in `src/ast-analysis/rules/r.ts`.
///
/// User-defined infix operators (`%%`, `%in%`, `%o%`, ...) all collapse onto
/// one generic `special` leaf type in this grammar (confirmed by parsing
/// `x %% y` and `x %in% y`) — a minor unique-operator precision loss the
/// grammar itself imposes. `integer` (`1L`) and `complex` (`2i`) literals
/// wrap only their suffix (`L`/`i`) as a child — the numeric digits are
/// unlabeled text in the parent span, not a separate node — so the suffix
/// leaf is used as the operand token, another minor precision loss inherent
/// to the grammar.
pub static R_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "^", "special", "&", "&&", "|", "||", "!", "<", ">", "<=", ">=", "==",
        "!=", "<-", "<<-", "->", "->>", "=", ":=", "~", "?", ":", "::", ":::", "@", "$", "|>",
        "in", "if", "else", "for", "while", "repeat", "function", "\\",
    ],
    operand_leaf_types: &[
        "identifier",
        "float",
        "string_content",
        "NA",
        "NA_character_",
        "NA_integer_",
        "NA_real_",
        "NA_complex_",
        "NULL",
        "Inf",
        "NaN",
        "TRUE",
        "FALSE",
        "L",
        "i",
        "dots",
        "dot_dot_i",
    ],
    compound_operators: &["call", "subset", "subset2"],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

/// Mirrors the TS `halsteadGroovy` export in `src/ast-analysis/rules/b2.ts`.
pub static GROOVY_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+",
        "-",
        "*",
        "/",
        "%",
        "=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        ">>>=",
        "==",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        "&&",
        "||",
        "!",
        "&",
        "|",
        "^",
        "~",
        "<<",
        ">>",
        ">>>",
        "++",
        "--",
        "instanceof",
        "new",
        "as",
        "in",
        "def",
        "if",
        "else",
        "for",
        "while",
        "do",
        "switch",
        "case",
        "default",
        "return",
        "throw",
        "break",
        "continue",
        "try",
        "catch",
        "finally",
        ".",
        ",",
        ";",
        ":",
        "?",
        "->",
    ],
    operand_leaf_types: &[
        "identifier",
        "type_identifier",
        "decimal_integer_literal",
        "hex_integer_literal",
        "octal_integer_literal",
        "binary_integer_literal",
        "decimal_floating_point_literal",
        "string_fragment",
        "character_literal",
        "true",
        "false",
        "null",
        "this",
        "super",
    ],
    compound_operators: &[
        "method_invocation",
        "array_access",
        "object_creation_expression",
    ],
    skip_types: &["type_arguments", "type_parameters"],
    operator_leaf_types_by_text: false,
};

// See JULIA_RULES for the generic-`operator`-leaf-kind rationale.
// `operator_leaf_types_by_text: true` makes leaf classification compare
// `.text` instead of `.kind()` — without it, EVERY distinct Julia operator
// (+, -, >, &&, ...) would collapse onto one vocabulary entry keyed by the
// literal string `"operator"`, corrupting n1 (issue #2312). Keyword tokens
// (`if`, `end`, `return`, ...) already have their own distinct kind equal to
// their text, so by-text comparison is a no-op for them.
//
// `content` (a string literal's body, confirmed by parsing `s = "hello"`) is
// a genuine leaf — unlike Solidity, Julia's grammar DOES expose string body
// text as its own node, so no precision loss here.
pub static JULIA_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "÷", "%", "^", "\\", "=", "+=", "-=", "*=", "/=", "%=", "^=", "&=",
        "|=", "<<=", ">>=", "==", "!=", "<", "<=", ">", ">=", "===", "!==", "&&", "||", "!", "&",
        "|", "~", "<<", ">>", "<:", ">:", "...", "->", "::", ".", ",", ";", ":", "?", "@", "if",
        "elseif", "else", "for", "while", "try", "catch", "finally", "return", "break", "continue",
        "end", "function", "do", "local", "global", "const", "struct", "module", "import", "using",
        "in", "where", "macro",
    ],
    operand_leaf_types: &[
        "identifier",
        "integer_literal",
        "float_literal",
        "content",
        "true",
        "false",
    ],
    compound_operators: &[
        "call_expression",
        "macrocall_expression",
        "field_expression",
    ],
    skip_types: &[],
    operator_leaf_types_by_text: true,
};

// tree-sitter-solidity gives every operator token its OWN distinct node kind
// (confirmed by parsing `a && b && c`: the `&&` leaf's kind is literally
// `"&&"`, not a generic wrapper) — `operator_leaf_types_by_text` stays false;
// Solidity does not have Julia's Bug-1 problem.
//
// Plain `string_literal`/`string` nodes are deliberately NOT in
// `operand_leaf_types`: confirmed by parsing `s = "hello world"` and
// inspecting byte ranges, the grammar exposes ONLY the two quote-character
// tokens as children — the string body itself (`hello world`) is unnamed
// text with no node of its own, so there is no leaf to key an operand on.
// This is a minor, documented precision loss (string literals under-counted
// as Halstead operands), not a bug this PR introduces — `hex_string_literal`
// / `unicode_string_literal` ARE proper leaves (no exposed sub-structure in
// node-types.json) and are counted normally.
pub static SOLIDITY_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "**", "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=",
        ">>=", "==", "!=", "<", "<=", ">", ">=", "&&", "||", "!", "&", "|", "^", "~", "<<", ">>",
        "++", "--", "if", "else", "while", "for", "try", "catch", "return", "revert", "break",
        "continue", "delete", "new", "emit", "function", "modifier", ".", ",", ";", ":", "?", "=>",
    ],
    operand_leaf_types: &[
        "identifier",
        "number_literal",
        "true",
        "false",
        "hex_string_literal",
        "unicode_string_literal",
    ],
    compound_operators: &[
        "call_expression",
        "function_call",
        "member_expression",
        "new_expression",
    ],
    skip_types: &[],
    operator_leaf_types_by_text: false,
};

/// Look up Halstead rules by language ID.
pub fn halstead_rules(lang_id: &str) -> Option<&'static HalsteadRules> {
    match lang_id {
        "javascript" | "typescript" | "tsx" => Some(&JS_TS_HALSTEAD),
        "python" => Some(&PYTHON_HALSTEAD),
        "go" => Some(&GO_HALSTEAD),
        "rust" => Some(&RUST_HALSTEAD),
        "java" => Some(&JAVA_HALSTEAD),
        "csharp" => Some(&CSHARP_HALSTEAD),
        "ruby" => Some(&RUBY_HALSTEAD),
        "php" => Some(&PHP_HALSTEAD),
        "c" => Some(&C_HALSTEAD),
        "cpp" | "cuda" => Some(&CPP_HALSTEAD),
        "objc" => Some(&OBJC_HALSTEAD),
        "kotlin" => Some(&KOTLIN_HALSTEAD),
        "swift" => Some(&SWIFT_HALSTEAD),
        "scala" => Some(&SCALA_HALSTEAD),
        "bash" => Some(&BASH_HALSTEAD),
        "lua" => Some(&LUA_HALSTEAD),
        "zig" => Some(&ZIG_HALSTEAD),
        "r" => Some(&R_HALSTEAD),
        "groovy" => Some(&GROOVY_HALSTEAD),
        "julia" => Some(&JULIA_HALSTEAD),
        "solidity" => Some(&SOLIDITY_HALSTEAD),
        _ => None,
    }
}

/// Single-line comment prefixes per language, used for LOC metrics.
///
/// Deliberately excludes `/*`/`*/`/a bare `*` continuation marker: a bare
/// `*` also opens a pointer-dereference assignment (`*ptr = 5;`) in every
/// block-comment language below that supports one, so trusting it as a
/// standalone comment signal misclassified real code as a comment (issue
/// #2287). Block-comment lines are instead recognized via explicit
/// `/* ... */` state tracking in `compute_all_metrics`, scoped to languages
/// where [`is_block_comment_lang`] returns true.
pub fn line_comment_prefixes(lang_id: &str) -> &'static [&'static str] {
    match lang_id {
        "python" | "ruby" | "r" | "julia" => &["#"],
        "php" => &["//", "#"],
        "bash" => &["#"],
        "lua" => &["--"],
        _ => &["//"],
    }
}

/// Languages using `/** ... */`-style block comments (issue #2058, #2287).
///
/// Julia is excluded: its block-comment delimiters are `#=`/`=#`, not `/*`/
/// `*/` — the shared `scan_block_comment_depth` below only recognizes the
/// latter. Treating Julia as a block-comment language would therefore never
/// actually close a block (no `*/` ever appears), leaving every subsequent
/// line wrongly marked as a comment continuation. Excluding it here instead
/// means `#=...=#` block comments are undercounted as SLOC rather than
/// comment lines — a documented, minor precision loss (issue #2312), not a
/// silent miscount of unrelated code.
pub fn is_block_comment_lang(lang_id: &str) -> bool {
    !matches!(
        lang_id,
        "python" | "ruby" | "r" | "bash" | "lua" | "zig" | "julia"
    )
}

/// Languages whose block comments can nest (`/* outer /* inner */ still
/// outer */`) — Rust and Swift, unlike the other block-comment languages
/// here, where an inner opening marker inside an already-open comment is
/// inert text and the FIRST closing marker ends the whole thing.
pub fn is_nestable_block_comment_lang(lang_id: &str) -> bool {
    matches!(lang_id, "rust" | "swift")
}

/// Scan `text` for block-comment opening/closing markers, returning the
/// nesting depth after the scan (0 = not in a comment). `start_depth` is
/// the depth entering `text`. For a non-nestable language, depth never
/// exceeds 1 under this scan (an inner opener while already at depth 1 is
/// ignored, matching how those languages' own parsers treat it), so the
/// first closer always fully closes it — nesting support only changes
/// whether an inner opener is allowed to push depth past 1 (Greptile
/// review, PR #2456: the original boolean-state version closed a
/// Rust/Swift nested comment at its first, inner closing marker instead of
/// its outer one).
fn scan_block_comment_depth(text: &str, start_depth: u32, nestable: bool) -> u32 {
    let bytes = text.as_bytes();
    let mut depth = start_depth;
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'/' && bytes[i + 1] == b'*' && (depth == 0 || nestable) {
            depth += 1;
            i += 2;
        } else if bytes[i] == b'*' && bytes[i + 1] == b'/' && depth > 0 {
            depth -= 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    depth
}

// ─── Merged Single-Pass: Complexity + Halstead + LOC + MI ─────────────────

use crate::types::{HalsteadMetrics, LocMetrics};
use std::collections::HashMap;

/// Compute all metrics (complexity + Halstead + LOC + MI) in a single DFS walk.
///
/// This is the primary entry point for extractors. It merges complexity and
/// Halstead classification into one tree traversal, then computes LOC (text-based)
/// and Maintainability Index from the collected data.
///
/// Returns `None` if no complexity rules exist for the given language.
pub fn compute_all_metrics(
    function_node: &Node,
    source: &[u8],
    lang_id: &str,
) -> Option<ComplexityMetrics> {
    let c_rules = lang_rules(lang_id)?;
    let h_rules = halstead_rules(lang_id);

    // ── Complexity state ──
    let mut cognitive: u32 = 0;
    let mut cyclomatic: u32 = 1; // McCabe starts at 1
    let mut max_nesting: u32 = 0;

    // ── Halstead state ──
    let mut operators: HashMap<String, u32> = HashMap::new();
    let mut operands: HashMap<String, u32> = HashMap::new();

    walk_all(
        function_node,
        source,
        0,
        true,
        false,
        c_rules,
        h_rules,
        &mut cognitive,
        &mut cyclomatic,
        &mut max_nesting,
        &mut operators,
        &mut operands,
    );

    // ── Build Halstead metrics ──
    let halstead = if h_rules.is_some() {
        let n1 = operators.len() as u32;
        let n2 = operands.len() as u32;
        let big_n1: u32 = operators.values().sum();
        let big_n2: u32 = operands.values().sum();

        let vocabulary = n1 + n2;
        let length = big_n1 + big_n2;
        let volume = if vocabulary > 0 {
            (length as f64) * (vocabulary as f64).log2()
        } else {
            0.0
        };
        let difficulty = if n2 > 0 {
            (n1 as f64 / 2.0) * (big_n2 as f64 / n2 as f64)
        } else {
            0.0
        };
        let effort = difficulty * volume;
        let bugs = volume / 3000.0;

        Some(HalsteadMetrics {
            n1,
            n2,
            big_n1,
            big_n2,
            vocabulary,
            length,
            volume: round_f64(volume, 2),
            difficulty: round_f64(difficulty, 2),
            effort: round_f64(effort, 2),
            bugs: round_f64(bugs, 4),
        })
    } else {
        None
    };

    // ── LOC metrics (text-based) ──
    let start = function_node.start_byte();
    let end = function_node.end_byte().min(source.len());
    let func_source = &source[start..end];
    let func_text = String::from_utf8_lossy(func_source);
    let lines: Vec<&str> = func_text.split('\n').collect();
    let loc_total = lines.len() as u32;
    let line_prefixes = line_comment_prefixes(lang_id);
    let supports_block_comments = is_block_comment_lang(lang_id);
    let nestable = is_nestable_block_comment_lang(lang_id);

    let mut comment_lines: u32 = 0;
    let mut blank_lines: u32 = 0;
    let mut block_depth: u32 = 0;
    for line in &lines {
        let trimmed = line.trim();

        if block_depth > 0 {
            comment_lines += 1;
            block_depth = scan_block_comment_depth(trimmed, block_depth, nestable);
            continue;
        }

        if trimmed.is_empty() {
            blank_lines += 1;
            continue;
        }

        if line_prefixes.iter().any(|p| trimmed.starts_with(p)) {
            comment_lines += 1;
            continue;
        }

        if supports_block_comments && trimmed.starts_with("/*") {
            comment_lines += 1;
            block_depth = scan_block_comment_depth(trimmed, 0, nestable);
        }
    }
    let sloc = (loc_total
        .saturating_sub(blank_lines)
        .saturating_sub(comment_lines))
    .max(1);

    let loc_metrics = LocMetrics {
        loc: loc_total,
        sloc,
        comment_lines,
    };

    // ── Maintainability Index ──
    let volume = halstead.as_ref().map_or(0.0, |h| h.volume);
    let safe_volume = if volume > 1.0 { volume } else { 1.0 };
    let safe_sloc = if sloc > 1 { sloc as f64 } else { 1.0 };
    let comment_ratio = if loc_total > 0 {
        comment_lines as f64 / loc_total as f64
    } else {
        0.0
    };

    let mut mi =
        171.0 - 5.2 * safe_volume.ln() - 0.23 * (cyclomatic as f64) - 16.2 * safe_sloc.ln();
    if comment_ratio > 0.0 {
        mi += 50.0 * (2.4 * comment_ratio).sqrt().sin();
    }
    let normalized = (mi * 100.0 / 171.0).clamp(0.0, 100.0);
    let maintainability_index = round_f64(normalized, 1);

    Some(ComplexityMetrics {
        cognitive,
        cyclomatic,
        max_nesting,
        halstead: halstead.or(Some(HalsteadMetrics {
            n1: 0,
            n2: 0,
            big_n1: 0,
            big_n2: 0,
            vocabulary: 0,
            length: 0,
            volume: 0.0,
            difficulty: 0.0,
            effort: 0.0,
            bugs: 0.0,
        })),
        loc: Some(loc_metrics),
        maintainability_index: Some(maintainability_index),
    })
}

/// Round f64 to `decimals` decimal places.
fn round_f64(value: f64, decimals: u32) -> f64 {
    let factor = 10_f64.powi(decimals as i32);
    (value * factor).round() / factor
}

#[allow(clippy::too_many_arguments)]
fn walk_all_children(
    node: &Node,
    source: &[u8],
    nesting_level: u32,
    is_top_function: bool,
    halstead_skip: bool,
    c_rules: &LangRules,
    h_rules: Option<&HalsteadRules>,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
    max_nesting: &mut u32,
    operators: &mut HashMap<String, u32>,
    operands: &mut HashMap<String, u32>,
) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_all(
                &child,
                source,
                nesting_level,
                is_top_function,
                halstead_skip,
                c_rules,
                h_rules,
                cognitive,
                cyclomatic,
                max_nesting,
                operators,
                operands,
            );
        }
    }
}

/// Classify a single node for Halstead operator/operand counting.
///
/// When `hr.operator_leaf_types_by_text` is set (Julia), an operator LEAF is
/// matched — and bucketed — by its `.text` rather than its `.kind()`: every
/// distinct operator (`+`, `-`, `>`, `&&`, ...) shares tree-sitter-julia's
/// one generic `operator` leaf kind, so matching/bucketing by `.kind()` alone
/// would collapse them all into a single vocabulary entry keyed `"operator"`,
/// corrupting n1 (distinct operator count). False for every other language,
/// where `.kind()` already equals the operator's literal text.
fn classify_halstead(
    node: &Node,
    kind: &str,
    source: &[u8],
    hr: &HalsteadRules,
    operators: &mut HashMap<String, u32>,
    operands: &mut HashMap<String, u32>,
) {
    // Compound operators (non-leaf): count node type as operator
    if hr.compound_operators.contains(&kind) {
        *operators.entry(kind.to_string()).or_insert(0) += 1;
    }
    // Leaf nodes: classify as operator or operand
    if node.child_count() == 0 {
        let op_key = operator_key(node, source, hr.operator_leaf_types_by_text);
        if hr.operator_leaf_types.contains(&op_key) {
            *operators.entry(op_key.to_string()).or_insert(0) += 1;
        } else if hr.operand_leaf_types.contains(&kind) {
            let start = node.start_byte();
            let end = node.end_byte().min(source.len());
            let text = String::from_utf8_lossy(&source[start..end]).to_string();
            *operands.entry(text).or_insert(0) += 1;
        }
    }
}

// ─── walk_all (merged complexity + Halstead DFS) ────────────────────────

#[allow(clippy::too_many_arguments)]
fn walk_all(
    node: &Node,
    source: &[u8],
    nesting_level: u32,
    is_top_function: bool,
    halstead_skip: bool,
    c_rules: &LangRules,
    h_rules: Option<&HalsteadRules>,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
    max_nesting: &mut u32,
    operators: &mut HashMap<String, u32>,
    operands: &mut HashMap<String, u32>,
) {
    let kind = node.kind();

    // ── Halstead classification ──
    let skip_h = halstead_skip || h_rules.map_or(false, |hr| hr.skip_types.contains(&kind));

    if let Some(hr) = h_rules {
        if !skip_h {
            classify_halstead(node, kind, source, hr, operators, operands);
        }
    }

    // ── Complexity: track nesting depth ──
    if nesting_level > *max_nesting {
        *max_nesting = nesting_level;
    }

    // Logical operators
    if handle_logical_op(node, kind, source, c_rules, cognitive, cyclomatic) {
        walk_all_children(
            node,
            source,
            nesting_level,
            false,
            skip_h,
            c_rules,
            h_rules,
            cognitive,
            cyclomatic,
            max_nesting,
            operators,
            operands,
        );
        return;
    }

    // Optional chaining (cyclomatic only)
    if let Some(opt_type) = c_rules.optional_chain_type {
        if kind == opt_type {
            *cyclomatic += 1;
        }
    }

    // Branch/control flow nodes (skip keyword leaf tokens)
    if c_rules.is_branch(kind) && node.child_count() > 0 {
        let BranchAction::Handled {
            cognitive_delta,
            cyclomatic_delta,
            nesting_delta,
        } = classify_branch(node, kind, c_rules, nesting_level);
        *cognitive += cognitive_delta;
        *cyclomatic += cyclomatic_delta;
        walk_all_children(
            node,
            source,
            nesting_level + nesting_delta,
            false,
            skip_h,
            c_rules,
            h_rules,
            cognitive,
            cyclomatic,
            max_nesting,
            operators,
            operands,
        );
        return;
    }

    // Pattern C plain else (Go/Java) / Pattern D plain else (Solidity)
    if is_pattern_c_else(node, kind, c_rules) || is_pattern_d_else(node, kind, c_rules) {
        *cognitive += 1;
        walk_all_children(
            node,
            source,
            nesting_level,
            false,
            skip_h,
            c_rules,
            h_rules,
            cognitive,
            cyclomatic,
            max_nesting,
            operators,
            operands,
        );
        return;
    }

    // Case nodes (cyclomatic only, skip keyword leaves)
    if c_rules.is_case(kind) && node.child_count() > 0 {
        *cyclomatic += 1;
    }

    // Nested function definitions (increase nesting)
    if !is_top_function && c_rules.is_function(kind) {
        walk_all_children(
            node,
            source,
            nesting_level + 1,
            false,
            skip_h,
            c_rules,
            h_rules,
            cognitive,
            cyclomatic,
            max_nesting,
            operators,
            operands,
        );
        return;
    }

    walk_all_children(
        node,
        source,
        nesting_level,
        false,
        skip_h,
        c_rules,
        h_rules,
        cognitive,
        cyclomatic,
        max_nesting,
        operators,
        operands,
    );
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    #[test]
    fn is_block_comment_lang_covers_c_family_and_jvm_langs() {
        // Regression guard (issue #2058): c/cpp/cuda/objc/kotlin/swift/scala
        // all use the same `/** ... */` block-comment style as JS/Java/C#.
        for lang in [
            "c", "cpp", "cuda", "objc", "kotlin", "swift", "scala", "groovy",
        ] {
            assert!(
                is_block_comment_lang(lang),
                "{lang} should support /* ... */ block comments"
            );
        }
    }

    #[test]
    fn is_block_comment_lang_excludes_hash_and_dash_comment_langs() {
        for lang in ["python", "ruby", "r", "bash", "lua", "zig"] {
            assert!(
                !is_block_comment_lang(lang),
                "{lang} should not support /* ... */ block comments"
            );
        }
    }

    fn compute_rust(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_rust::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &RUST_LANG_RULES).expect("no function found");
        compute_all_metrics(&func, code.as_bytes(), "rust").expect("no metrics computed")
    }

    #[test]
    fn loc_metrics_does_not_misclassify_pointer_dereference_as_a_comment_continuation() {
        // Issue #2287: a bare `*` prefix (trusted unconditionally by the old
        // flat comment-prefix list, to match Javadoc-style `* ...`
        // continuation lines) also opens a pointer-dereference assignment in
        // Rust/C/C#/Go, wrongly counting real code as a comment line.
        let metrics = compute_rust(
            "fn deref_heavy(ptr: *mut i32) -> i32 {\n    unsafe {\n        *ptr = 5;\n        *ptr = *ptr + 1;\n        return *ptr;\n    }\n}",
        );
        let loc = metrics.loc.expect("loc metrics missing");
        assert_eq!(loc.comment_lines, 0, "no line here is a real comment");
        assert_eq!(loc.sloc, loc.loc, "every non-blank line is real code");
    }

    #[test]
    fn loc_metrics_still_tracks_a_genuine_multiline_block_comment() {
        // Regression guard for #2058's own fix: a real Javadoc-style
        // continuation line (opened by an actual `/*`) must still count as
        // a comment under the new block-tracking state machine. The comment
        // must be INSIDE the function body: a leading doc comment before the
        // function signature is a sibling AST node, not part of the
        // function node's own text span, so it would never reach this loop
        // regardless of the prefix logic being tested here.
        let metrics = compute_rust(
            "fn documented() -> i32 {\n    /**\n     * Doc comment.\n     * More doc.\n     */\n    return 1;\n}",
        );
        let loc = metrics.loc.expect("loc metrics missing");
        assert_eq!(
            loc.comment_lines, 4,
            "the 4-line doc comment must be fully counted"
        );
    }

    #[test]
    fn loc_metrics_closes_a_single_line_block_comment_without_entering_block_state() {
        let metrics = compute_rust("fn f() -> i32 {\n    /* inline */\n    return 1;\n}");
        let loc = metrics.loc.expect("loc metrics missing");
        assert_eq!(loc.comment_lines, 1);
        assert_eq!(loc.sloc, loc.loc - loc.comment_lines);
    }

    #[test]
    fn loc_metrics_does_not_close_a_nested_rust_block_comment_at_the_inner_closer() {
        // Greptile review, PR #2456: Rust (unlike the other block-comment
        // languages here) allows /* ... */ to nest. A boolean in/out-of-comment
        // state closes at the FIRST */, wrongly ending the comment at the
        // inner one and counting the remaining outer-comment lines as SLOC.
        let metrics = compute_rust(
            "fn documented() -> i32 {\n    /* outer\n     /* inner */\n     still outer\n     */\n    1\n}",
        );
        let loc = metrics.loc.expect("loc metrics missing");
        // /* outer, /* inner */, still outer, */ — all 4 lines are comment.
        assert_eq!(
            loc.comment_lines, 4,
            "the whole nested comment must be counted, not just up to the inner closer"
        );
    }

    #[test]
    fn loc_metrics_single_line_nested_rust_block_comment_still_closes() {
        let metrics =
            compute_rust("fn f() -> i32 {\n    /* outer /* inner */ still outer */\n    1\n}");
        let loc = metrics.loc.expect("loc metrics missing");
        assert_eq!(loc.comment_lines, 1);
        assert_eq!(loc.sloc, loc.loc - loc.comment_lines);
    }

    fn compute_js(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_javascript::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func =
            find_first_function(&root, &JS_TS_RULES).expect("no function found in test code");
        compute_function_complexity(&func, code.as_bytes(), &JS_TS_RULES)
    }

    fn find_first_function<'a>(node: &Node<'a>, rules: &LangRules) -> Option<Node<'a>> {
        if rules.is_function(node.kind()) {
            return Some(*node);
        }
        // For variable declarations with arrow functions
        if node.kind() == "variable_declarator" {
            if let Some(value) = node.child_by_field_name("value") {
                if rules.is_function(value.kind()) {
                    return Some(value);
                }
            }
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if let Some(found) = find_first_function(&child, rules) {
                    return Some(found);
                }
            }
        }
        None
    }

    #[test]
    fn empty_function() {
        let m = compute_js("function f() {}");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
        assert_eq!(m.max_nesting, 0);
    }

    #[test]
    fn single_if() {
        let m = compute_js("function f(x) { if (x) { return 1; } }");
        assert_eq!(m.cognitive, 1); // +1 structural
        assert_eq!(m.cyclomatic, 2); // 1 base + 1 if
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn if_else() {
        let m = compute_js("function f(x) { if (x) { return 1; } else { return 0; } }");
        assert_eq!(m.cognitive, 2); // +1 if, +1 else
        assert_eq!(m.cyclomatic, 2); // 1 base + 1 if
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn if_else_if_else() {
        let m = compute_js(
            "function f(x) { if (x > 0) { return 1; } else if (x < 0) { return -1; } else { return 0; } }",
        );
        // if (+1 cog, +1 cyc), else-if (+1 cog, +1 cyc), plain else (+1 cog)
        // cognitive = 3, cyclomatic = 3
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
    }

    #[test]
    fn nested_if() {
        let m = compute_js("function f(x, y) { if (x) { if (y) { return 1; } } }");
        // Outer if: cognitive +1 (nesting 0), cyclomatic +1
        // Inner if: cognitive +1+1 (nesting 1), cyclomatic +1
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 2);
    }

    #[test]
    fn for_loop() {
        let m = compute_js(
            "function f(arr) { for (let i = 0; i < arr.length; i++) { process(arr[i]); } }",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn logical_operators_same() {
        let m = compute_js("function f(a, b, c) { if (a && b && c) { return 1; } }");
        // if: cognitive +1, cyclomatic +1
        // &&: cyclomatic +1 each (2 operators), cognitive +1 for first && (sequence start)
        // second && is same sequence, no cognitive
        assert_eq!(m.cognitive, 2); // 1 (if) + 1 (&&)
        assert_eq!(m.cyclomatic, 4); // 1 base + 1 if + 2 &&
    }

    #[test]
    fn logical_operators_mixed() {
        let m = compute_js("function f(a, b, c) { if (a && b || c) { return 1; } }");
        // if: cognitive +1, cyclomatic +1
        // The AST is: (a && b) || c
        // || at top: cyclomatic +1, cognitive +1 (new sequence)
        // && nested: cyclomatic +1, cognitive +1 (different from parent ||)
        assert_eq!(m.cognitive, 3); // 1 (if) + 1 (&&) + 1 (||)
        assert_eq!(m.cyclomatic, 4); // 1 base + 1 if + 1 && + 1 ||
    }

    #[test]
    fn switch_case() {
        let m = compute_js(
            "function f(x) { switch(x) { case 1: return 'a'; case 2: return 'b'; default: return 'c'; } }",
        );
        // switch: cognitive +1, cyclomatic undone
        // case 1: cyclomatic +1
        // case 2: cyclomatic +1
        // default is not switch_case, so no cyclomatic
        assert_eq!(m.cognitive, 1); // switch structural
        assert_eq!(m.cyclomatic, 3); // 1 base + 2 cases
    }

    #[test]
    fn ternary() {
        let m = compute_js("function f(x) { return x ? 1 : 0; }");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn nested_function() {
        let m = compute_js("function f(x) { const inner = () => { if (x) { return 1; } }; }");
        // Nested arrow function increases nesting
        // if inside nested: cognitive +1+1 (nesting=1 from nested fn), cyclomatic +1
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 2);
    }

    #[test]
    fn catch_clause() {
        let m = compute_js("function f() { try { doSomething(); } catch(e) { handleError(e); } }");
        // catch: cognitive +1 (nesting 0), cyclomatic +1
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn while_loop() {
        let m = compute_js("function f() { while (true) { doSomething(); } }");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn do_while_loop() {
        let m = compute_js("function f() { do { doSomething(); } while (true); }");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    // ─── Python tests ─────────────────────────────────────────────────────

    fn compute_python(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &PYTHON_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &PYTHON_RULES)
    }

    #[test]
    fn python_empty_function() {
        let m = compute_python("def f():\n    pass");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
    }

    #[test]
    fn python_if_elif_else() {
        let m = compute_python("def f(x):\n    if x > 0:\n        return 1\n    elif x < 0:\n        return -1\n    else:\n        return 0");
        // if: +1 cog, +1 cyc; elif: +1 cog, +1 cyc; else: +1 cog
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
    }

    #[test]
    fn python_for_loop() {
        let m = compute_python("def f(xs):\n    for x in xs:\n        print(x)");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    // ─── Go tests ─────────────────────────────────────────────────────────

    fn compute_go(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_go::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &GO_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &GO_RULES)
    }

    #[test]
    fn go_empty_function() {
        let m = compute_go("package main\nfunc f() {}");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
    }

    #[test]
    fn go_if_else() {
        let m = compute_go("package main\nfunc f(x int) int {\n    if x > 0 {\n        return 1\n    } else {\n        return 0\n    }\n}");
        // if: +1 cog, +1 cyc; else (via alternative): +1 cog
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn go_for_loop() {
        let m = compute_go(
            "package main\nfunc f() {\n    for i := 0; i < 10; i++ {\n        println(i)\n    }\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    // ─── Lua tests (issue #1782) ────────────────────────────────────────────

    fn compute_lua(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_lua::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &LUA_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &LUA_RULES)
    }

    #[test]
    fn lua_empty_function() {
        let m = compute_lua("local function f() end");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
        assert_eq!(m.max_nesting, 0);
    }

    #[test]
    fn lua_single_if() {
        let m = compute_lua("local function f(x)\n  if x > 0 then\n    return 1\n  end\nend");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn lua_if_elseif_else() {
        // elseif_statement/else_statement are siblings of if_statement via
        // repeated `alternative:` fields (Pattern B, like Python's elif/else).
        let m = compute_lua(
            "local function f(x)\n  if x > 0 then\n    return 1\n  elseif x < 0 then\n    return -1\n  else\n    return 0\n  end\nend",
        );
        // if: +1 cog, +1 cyc; elseif: +1 cog, +1 cyc; else: +1 cog
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn lua_numeric_for_loop() {
        let m = compute_lua("local function f()\n  for i = 1, 10 do\n    print(i)\n  end\nend");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn lua_while_loop() {
        let m = compute_lua("local function f(n)\n  while n > 0 do\n    n = n - 1\n  end\nend");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn lua_repeat_until_loop() {
        let m = compute_lua("local function f(n)\n  repeat\n    n = n - 1\n  until n <= 0\nend");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn lua_logical_operators() {
        let m = compute_lua("local function f(a, b)\n  if a and b then\n    return 1\n  end\nend");
        // if: +1 cog, +1 cyc; and: +1 cog, +1 cyc
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 3);
    }

    #[test]
    fn lua_method_declaration() {
        // Greptile follow-up to #1782: colon-syntax method declarations
        // (`function Obj:method(x)`) have a `method_index_expression` name
        // field but are still `function_declaration` nodes, so `function_nodes`
        // already covers them — this pins that native/TS parity explicitly.
        // Mirrors the TS test 'method declaration (colon syntax) is
        // recognized as a function'.
        let m = compute_lua(
            "local Obj = {}\nfunction Obj:method(x)\n  if x > 0 then\n    return x\n  end\nend",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn lua_nested_if() {
        let m = compute_lua(
            "local function f(x, y)\n  if x > 0 then\n    if y > 0 then\n      return 1\n    end\n  end\nend",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 2);
    }

    // ─── C/C++ tests (issue #1923) ──────────────────────────────────────────

    fn compute_c(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_c::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &C_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &C_RULES)
    }

    fn compute_cpp(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_cpp::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &CPP_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &CPP_RULES)
    }

    #[test]
    fn c_empty_function() {
        let m = compute_c("int f(void) { return 0; }");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
        assert_eq!(m.max_nesting, 0);
    }

    #[test]
    fn c_single_if() {
        let m = compute_c("int f(int x) {\n  if (x > 0) {\n    return 1;\n  }\n  return 0;\n}");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn c_if_elseif_else() {
        // tree-sitter-c wraps the else branch in a real else_clause node
        // (Pattern A, like JS/C#/Rust) — NOT Go/Java's alternative-field
        // pattern. Confirmed by parsing and inspecting the S-expression.
        let m = compute_c(
            "int f(int x) {\n  if (x > 0) {\n    return 1;\n  } else if (x < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}",
        );
        // if: +1 cog, +1 cyc; else-if: +1 cog, +1 cyc; plain else: +1 cog
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn c_nested_if() {
        let m = compute_c(
            "int f(int x, int y) {\n  if (x > 0) {\n    if (y > 0) {\n      return 1;\n    }\n  }\n  return 0;\n}",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 2);
    }

    #[test]
    fn c_logical_operators() {
        let m = compute_c("int f(int a, int b) { return a && b; }");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn c_switch_with_multi_value_case() {
        // Regression guard (issue #2058): switch_statement (the container)
        // must be in branch_nodes + nesting_nodes (net-zero cyclomatic,
        // contributing nesting once), and case_statement (each arm) must be
        // in case_nodes ONLY (flat cyclomatic += 1, no per-case
        // cognitive/nesting weight) — not also in branch_nodes, which
        // previously shadowed the case treatment with a nesting-weighted
        // generic branch treatment for every arm.
        let m = compute_c(
            "int f(int x) {\n  switch (x) {\n    case 1:\n      return 1;\n    case 2:\n    case 3:\n      return 2;\n    default:\n      return 0;\n  }\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 5);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn cpp_if_elseif_else() {
        let m = compute_cpp(
            "int f(int x) {\n  if (x > 0) {\n    return 1;\n  } else if (x < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn cpp_for_range_loop() {
        let m = compute_cpp("void f(int xs[]) {\n  for (int x : xs) {\n    use(x);\n  }\n}");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn cpp_switch_with_multi_value_case() {
        // Same branch_nodes/case_nodes fix as C's equivalent test — see comment there.
        let m = compute_cpp(
            "int f(int x) {\n  switch (x) {\n    case 1:\n      return 1;\n    case 2:\n    case 3:\n      return 2;\n    default:\n      return 0;\n  }\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 5);
        assert_eq!(m.max_nesting, 1);
    }

    // ─── CUDA tests (issue #1923) ────────────────────────────────────────────
    //
    // tree-sitter-cuda is a C++-superset grammar (only adding qualifier
    // keywords like __global__/__device__ and kernel-launch syntax) —
    // confirmed by parsing sample CUDA control flow that its if_statement/
    // else_clause/for_statement/while_statement/switch_statement/
    // binary_expression node kinds are identical to plain C++, so CUDA
    // reuses CPP_RULES/CPP_HALSTEAD as-is.

    fn compute_cuda(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_cuda::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &CPP_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &CPP_RULES)
    }

    #[test]
    fn cuda_global_kernel_if_elseif_else() {
        // The __global__ qualifier is a leading anonymous token on
        // function_definition and does not disrupt function-body detection.
        let m = compute_cuda(
            "__global__ void classify(int *a) {\n  if (a[0] > 0) {\n    a[0] = 1;\n  } else if (a[0] < 0) {\n    a[0] = -1;\n  } else {\n    a[0] = 0;\n  }\n}",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn cuda_for_loop_with_logical_operator() {
        let m = compute_cuda(
            "__global__ void kernel(int *a, int n) {\n  for (int i = 0; i < n && a[i] > 0; i++) {\n    a[i]++;\n  }\n}",
        );
        assert_eq!(m.cyclomatic, 3);
    }

    // ─── ObjC tests (issue #1923) ────────────────────────────────────────────
    //
    // tree-sitter-objc extends tree-sitter-c: if/else/for/while/switch/case/
    // logical-operator node kinds are identical to plain C (confirmed by
    // parsing sample ObjC control flow), so OBJC_RULES reuses the same shapes
    // as C_RULES, plus `method_definition` in function_nodes and
    // `catch_clause` (from `@try`/`@catch`) as a branch/nesting node.

    fn compute_objc(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_objc::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &OBJC_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &OBJC_RULES)
    }

    #[test]
    fn objc_method_if_elseif_else() {
        // method_definition's compound_statement body is a direct child
        // (unlike tree-sitter-dart's function_signature/function_body
        // sibling split, #2182) — confirmed by parsing this fixture.
        let m = compute_objc(
            "@implementation Calculator\n- (NSInteger)classify:(NSInteger)value {\n  if (value > 0) {\n    return 1;\n  } else if (value < 0) {\n    return -1;\n  } else {\n    return 0;\n  }\n}\n@end",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn objc_method_logical_operators_and_for_loop() {
        let m = compute_objc(
            "@implementation Calculator\n- (NSInteger)sum:(NSInteger)n withFlag:(BOOL)flag {\n  NSInteger result = 0;\n  for (NSInteger i = 0; i < n && flag; i++) {\n    result += i;\n  }\n  return result;\n}\n@end",
        );
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn objc_method_try_catch() {
        let m = compute_objc(
            "@implementation Calculator\n- (NSInteger)risky {\n  @try {\n    return 1;\n  } @catch (NSException *ex) {\n    return -1;\n  }\n}\n@end",
        );
        // catch_clause: +1 cog, +1 cyc (mirrors CPP_RULES's catch_clause treatment)
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn objc_plain_c_function_still_works() {
        // Plain C-style functions (not ObjC methods) inside an .m file still
        // use function_definition, unchanged from C_RULES's shape.
        let m = compute_objc(
            "NSInteger plainFunction(NSInteger a, NSInteger b) {\n  if (a > b) {\n    return a;\n  }\n  return b;\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn objc_switch_with_multi_value_case() {
        // Same branch_nodes/case_nodes fix as C's equivalent test (see
        // comment there) — inherited the bug via copy from C's rules when
        // ObjC was added.
        let m = compute_objc(
            "@implementation Calculator\n- (NSInteger)classify:(NSInteger)x {\n  switch (x) {\n    case 1:\n      return 1;\n    case 2:\n    case 3:\n      return 2;\n    default:\n      return 0;\n  }\n}\n@end",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 5);
        assert_eq!(m.max_nesting, 1);
    }

    // ─── Zig tests (issue #1923) ─────────────────────────────────────────────
    //
    // tree-sitter-zig wraps its else branch in an else_clause node (Pattern
    // A, same as JS/C#/Rust/ObjC). and/or/orelse share the generic
    // binary_expression node type. catch_expression is a branch/nesting
    // node; try_expression is Halstead-only (mirrors Rust's `?`).

    fn compute_zig(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_zig::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &ZIG_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &ZIG_RULES)
    }

    #[test]
    fn zig_if_elseif_else() {
        let m = compute_zig(
            "pub fn classify(value: i32) i32 {\n    if (value > 0) {\n        return 1;\n    } else if (value < 0) {\n        return -1;\n    } else {\n        return 0;\n    }\n}",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn zig_while_with_orelse() {
        let m = compute_zig(
            "pub fn sum(n: i32, opt: ?i32) i32 {\n    var result: i32 = opt orelse 0;\n    var i: i32 = 0;\n    while (i < n) {\n        result += i;\n        i += 1;\n    }\n    return result;\n}",
        );
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn zig_for_range_with_switch() {
        let m = compute_zig(
            "pub fn tally(n: i32) i32 {\n    var total: i32 = 0;\n    for (0..n) |i| {\n        switch (i) {\n            0 => total += 1,\n            1, 2 => total += 2,\n            else => total += 0,\n        }\n    }\n    return total;\n}",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 5);
        assert_eq!(m.max_nesting, 2);
    }

    #[test]
    fn zig_catch_with_error_payload_block_is_a_branch() {
        let m = compute_zig(
            "pub fn risky() i32 {\n    const v = mayFail() catch |err| {\n        _ = err;\n        return -1;\n    };\n    return v;\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn zig_try_is_not_a_branch() {
        let m =
            compute_zig("pub fn wrapper() !i32 {\n    const v = try mayFail();\n    return v;\n}");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
        assert_eq!(m.max_nesting, 0);
    }

    // ─── R tests (issue #1923) ──────────────────────────────────────────────

    fn compute_r(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &R_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &R_RULES)
    }

    #[test]
    fn r_if_elseif_else() {
        let m = compute_r(
            "f <- function(x) {\n  if (x > 0) {\n    return(1)\n  } else if (x < 0) {\n    return(-1)\n  } else {\n    return(0)\n  }\n}",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn r_for_loop() {
        let m = compute_r("f <- function() {\n  for (i in 1:10) {\n    print(i)\n  }\n}");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn r_repeat_loop() {
        let m = compute_r("f <- function() {\n  repeat {\n    break\n  }\n}");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn r_logical_operators_mixed() {
        let m = compute_r("f <- function(a, b, c) {\n  if (a && b || c) {\n    return(1)\n  }\n}");
        // if: +1 cog, +1 cyc; && nested: +1 cog, +1 cyc; || top: +1 cog, +1 cyc
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 4);
    }

    // ─── Groovy tests (issue #1923) ─────────────────────────────────────────

    fn compute_groovy(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_groovy::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &GROOVY_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &GROOVY_RULES)
    }

    #[test]
    fn groovy_if_elseif_else() {
        let m = compute_groovy(
            "def f(x) {\n    if (x > 0) {\n        return 1\n    } else if (x < 0) {\n        return -1\n    } else {\n        return 0\n    }\n}",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn groovy_do_while_loop() {
        let m = compute_groovy("def f(x) {\n    do {\n        x = x - 1\n    } while (x > 0)\n}");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn groovy_switch_with_multi_value_case() {
        let m = compute_groovy(
            "def f(x) {\n    switch (x) {\n        case 1:\n            break\n        case 2:\n        case 3:\n            break\n        default:\n            break\n    }\n}",
        );
        // switch container: +1 cyc, then -1 via switch_like_nodes offset (net 0);
        // 4 switch_label nodes (case 1, case 2, case 3, default): +1 cyc each
        assert_eq!(m.cyclomatic, 5);
    }

    #[test]
    fn groovy_logical_operators_mixed() {
        let m =
            compute_groovy("def f(a, b, c) {\n    if (a && b || c) {\n        return 1\n    }\n}");
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 4);
    }

    // ─── Kotlin tests (issue #1923) ─────────────────────────────────────────

    fn compute_kotlin(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_kotlin_sg::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &KOTLIN_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &KOTLIN_RULES)
    }

    #[test]
    fn kotlin_single_if() {
        let m = compute_kotlin(
            "fun f(x: Int): Int {\n  if (x > 0) {\n    return 1\n  }\n  return 0\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn kotlin_logical_operators() {
        // Kotlin's grammar splits && / || into distinct node types
        // (conjunction_expression / disjunction_expression) rather than
        // sharing one generic binary node — both are listed in
        // logical_node_types.
        let m = compute_kotlin("fun f(a: Boolean, b: Boolean): Boolean {\n  return a && b || a\n}");
        assert_eq!(m.cyclomatic, 3);
    }

    #[test]
    fn kotlin_when_expression() {
        // Regression guard (issue #2058): when_entry (each case arm) must
        // not also be in branch_nodes — that shadowed the flat case
        // treatment with nesting-weighted branch treatment, inflating
        // cognitive from 1 to 7 for this fixture even though cyclomatic
        // happened to stay 4 either way (each arm contributes +1 via
        // either code path).
        let m = compute_kotlin(
            "fun f(x: Int): Int {\n  return when (x) {\n    1 -> 1\n    2 -> 2\n    else -> 0\n  }\n}",
        );
        // base 1 + when container (0, switch-like) + 3 when_entry cases (+1
        // each) = 4.
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 4);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn kotlin_when_expression_with_multi_value_case() {
        let m = compute_kotlin(
            "fun f(x: Int): Int {\n  return when (x) {\n    1 -> 1\n    2, 3 -> 2\n    else -> 0\n  }\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 4);
        assert_eq!(m.max_nesting, 1);
    }

    // ─── Swift tests (issue #1923) ──────────────────────────────────────────

    fn compute_swift(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_swift::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &SWIFT_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &SWIFT_RULES)
    }

    #[test]
    fn swift_single_if() {
        let m = compute_swift(
            "func f(_ x: Int) -> Int {\n  if x > 0 {\n    return 1\n  }\n  return 0\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn swift_logical_operators() {
        let m = compute_swift("func f(_ a: Bool, _ b: Bool) -> Bool {\n  return a && b\n}");
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn swift_switch_with_multi_value_case() {
        // Regression guard (issue #2058): switch_statement (the container)
        // was missing from branch_nodes AND nesting_nodes entirely — a
        // Swift switch contributed ZERO nesting/cognitive from its own
        // container, and switch_entry (each case arm) was double-booked in
        // branch_nodes + case_nodes, hitting the same shadowing bug as
        // Kotlin's when_entry.
        let m = compute_swift(
            "func f(_ x: Int) -> Int {\n  switch x {\n  case 1:\n    return 1\n  case 2, 3:\n    return 2\n  default:\n    return 0\n  }\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 4);
        assert_eq!(m.max_nesting, 1);
    }

    // ─── Scala tests (issue #1923) ──────────────────────────────────────────

    fn compute_scala(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_scala::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &SCALA_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &SCALA_RULES)
    }

    #[test]
    fn scala_if_elseif_else() {
        // tree-sitter-scala's if_expression exposes a real `alternative`
        // field holding either a nested if_expression or a block — Pattern C
        // (Go/Java style) applies cleanly here, unlike Kotlin/Swift.
        let m = compute_scala(
            "def f(x: Int): Int = {\n  if (x > 0) {\n    1\n  } else if (x < 0) {\n    -1\n  } else {\n    0\n  }\n}",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn scala_match_expression() {
        // Regression guard (issue #2058): case_clause (each case arm) must
        // not also be in branch_nodes — that shadowed the flat case
        // treatment with nesting-weighted branch treatment, inflating
        // cognitive from 1 to 7 for this fixture even though cyclomatic
        // happened to stay 4 either way (each arm contributes +1 via
        // either code path).
        let m = compute_scala(
            "def f(x: Int): Int = {\n  x match {\n    case 1 => 1\n    case 2 => 2\n    case _ => 0\n  }\n}",
        );
        // base 1 + match container (0, switch-like) + 3 case_clause cases
        // (+1 each) = 4.
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 4);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn scala_match_expression_with_alternative_pattern_case() {
        let m = compute_scala(
            "def f(x: Int): Int = {\n  x match {\n    case 1 => 1\n    case 2 | 3 => 2\n    case _ => 0\n  }\n}",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 4);
        assert_eq!(m.max_nesting, 1);
    }

    // ─── Bash tests (issue #1923) ───────────────────────────────────────────

    fn compute_bash(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &BASH_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &BASH_RULES)
    }

    #[test]
    fn bash_single_if() {
        let m = compute_bash("f() {\n  if [ \"$1\" -gt 0 ]; then\n    echo pos\n  fi\n}");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn bash_if_elif_else() {
        // elif_clause/else_clause are flat siblings of if_statement, matching
        // Python's elif_clause/else_clause pattern (Pattern B).
        let m = compute_bash(
            "f() {\n  if [ \"$1\" -gt 0 ]; then\n    echo pos\n  elif [ \"$1\" -lt 0 ]; then\n    echo neg\n  else\n    echo zero\n  fi\n}",
        );
        // if: +1 cog, +1 cyc; elif: +1 cog, +1 cyc; else: +1 cog
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn bash_logical_operators() {
        // `&&` inside a `[[ ... ]]` extended test expression parses as a real
        // binary_expression node (matching logical_node_types). `&&` used to
        // chain separate `[ ] && [ ]` commands is a different grammar
        // category (a `list` node joining two `test_command`s, not a
        // binary_expression) and is not counted here — confirmed by parsing
        // both forms and inspecting the S-expression.
        let m = compute_bash("f() {\n  if [[ \"$1\" && \"$2\" ]]; then\n    echo yes\n  fi\n}");
        assert_eq!(m.cyclomatic, 3);
    }

    // ─── Julia tests (issue #2312) ────────────────────────────────────────

    fn compute_julia(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_julia::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &JULIA_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &JULIA_RULES)
    }

    #[test]
    fn julia_if_elseif_else() {
        // elseif_clause/else_clause are genuine, distinctly-typed nodes
        // reached via the repeated `alternative` field (Pattern B, like
        // Python's elif/else) — no transparent-wrapper involvement here.
        let m = compute_julia(
            "function classify(x)\n    if x > 0\n        return 1\n    elseif x < 0\n        return -1\n    else\n        return 0\n    end\nend",
        );
        // if: +1 cog, +1 cyc; elseif: +1 cog, +1 cyc; else: +1 cog
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn julia_logical_operators_same_sequence() {
        // Regression guard for issue #2312 Bug 1: every Julia binary operator
        // (+, -, >, ==, &&, ||, ...) shares tree-sitter-julia's one generic
        // `operator` leaf kind — without `logical_operators_by_text: true`,
        // `&&`/`||` would never be recognized as logical operators at all
        // (is_logical_op("operator") never matches "&&"/"||"), silently
        // undercounting cyclomatic/cognitive for every Julia function using
        // them, not merely mis-adjusting the same-sequence check.
        let m = compute_julia(
            "function check(a, b, c)\n    if a && b && c\n        return 1\n    end\nend",
        );
        // if: +1 cog, +1 cyc; first &&: +1 cog, +1 cyc; second && (same
        // operator sequence): +0 cog, +1 cyc
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 4);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn julia_logical_operators_mixed() {
        let m = compute_julia(
            "function check(a, b, c)\n    if a && b || c\n        return 1\n    end\nend",
        );
        // if: +1 cog, +1 cyc; && nested: +1 cog, +1 cyc; || top: +1 cog, +1 cyc
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 4);
    }

    #[test]
    fn julia_while_loop() {
        let m = compute_julia(
            "function s(n)\n    total = 0\n    i = 0\n    while i < n\n        total += i\n        i += 1\n    end\n    return total\nend",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn julia_try_catch() {
        let m = compute_julia(
            "function risky()\n    try\n        return 1\n    catch e\n        return -1\n    end\nend",
        );
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn julia_halstead_operator_vocabulary_is_not_collapsed() {
        // Regression guard for issue #2312 Bug 1's Halstead half: without
        // `operator_leaf_types_by_text`, every distinct operator below would
        // collapse onto a single vocabulary entry keyed by the literal
        // string "operator" (n1 == 1), no matter how many distinct operators
        // actually appear.
        let code = "function f(a, b, c)\n    return a + b - c * 2\nend";
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_julia::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &JULIA_RULES).expect("no function found");
        let metrics = compute_all_metrics(&func, code.as_bytes(), "julia").expect("julia rules");
        let halstead = metrics.halstead.expect("halstead metrics present");
        // Distinct operators here: +, -, *, return (at least 4) — nowhere
        // near collapsing to n1 == 1.
        assert!(
            halstead.n1 >= 4,
            "expected at least 4 distinct operators, got n1={}",
            halstead.n1
        );
    }

    // ─── Solidity tests (issue #2312) ───────────────────────────────────────

    fn compute_solidity(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_solidity::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &SOLIDITY_RULES).expect("no function found");
        compute_function_complexity(&func, code.as_bytes(), &SOLIDITY_RULES)
    }

    #[test]
    fn solidity_if_else_no_wrapper_issue() {
        let m = compute_solidity(
            "contract C { function f(int x) public { if (x > 0) { x = 1; } else { x = 2; } } }",
        );
        // if: +1 cog, +1 cyc; plain else (Pattern D): +1 cog
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn solidity_if_elseif_else_does_not_double_count_nesting() {
        // Regression guard for issue #2312 Bug 2: Solidity's grammar has NO
        // `else_clause` node and NO `alternative` field — both the then- and
        // else-branch bodies are wrapped in a generic, single-child
        // `statement` node reached via the SAME field (`body`), with the
        // nested if_statement for an else-if a GRANDCHILD of the outer
        // if_statement (through that wrapper), not a direct child. Without
        // Pattern D (`transparent_wrapper_types` + `else_keyword_type`), the
        // nested if_statement's parent is seen as the wrapper, never
        // recognized as an else-if, and cognitive complexity is inflated by
        // scoring it as a fresh nested branch (cognitive 1+nesting instead
        // of the flat +1 every other else-if pattern here gets).
        let m = compute_solidity(
            "contract C { function f(int x, int y) public { if (x > 0) { x = 1; } else if (y > 0) { x = 2; } else { x = 3; } } }",
        );
        // if: +1 cog, +1 cyc; else-if (Pattern D, flat): +1 cog, +1 cyc;
        // plain else (Pattern D): +1 cog. Matches the canonical
        // if/elseif/else numbers every other language section in this file
        // asserts (e.g. `zig_if_elseif_else`, `r_if_elseif_else`).
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn solidity_else_if_with_comment_before_branch_still_scores_flat() {
        // Regression guard (Greptile review, PR #2472): a comment sibling
        // between the `else` token and the transparent wrapper would make
        // `wrapper.prev_sibling()` the comment, not `else`. `comment_types`
        // must be skipped over when walking backward, or this scores
        // cognitive 4/max_nesting 2 (a fresh nested branch) instead of
        // matching the uncommented case above (cognitive 3/max_nesting 1).
        let m = compute_solidity(
            "contract C { function f(int x, int y) public { if (x > 0) { x = 1; } else /* note */ if (y > 0) { x = 2; } else { x = 3; } } }",
        );
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn solidity_plain_else_with_line_comment_still_scores_flat() {
        let m = compute_solidity(
            "contract C { function f(int x) public { if (x > 0) { x = 1; } else // note\n { x = 2; } } }",
        );
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn solidity_logical_operators_same_sequence_through_expression_wrapper() {
        // Regression guard for the `expression`-wrapper variant of the same
        // bug: the condition (and every other value position) is ALSO
        // wrapped in a generic `expression` node, including a chained
        // logical operator's own operand positions — so the inner
        // `binary_expression`'s real parent (the outer binary_expression) is
        // hidden behind an `expression` wrapper. Without `effective_parent`
        // unwrapping it, `a && b && c` would score as two independent
        // sequences (cognitive 3) instead of recognizing the repeated `&&`
        // as one sequence (cognitive 2), even though each operator has its
        // own distinct node kind (no by-text fix needed here).
        let m = compute_solidity(
            "contract C { function f(bool a, bool b, bool c) public { if (a && b && c) { a = false; } } }",
        );
        // if: +1 cog, +1 cyc; outer &&: +1 cog, +1 cyc; inner && (same
        // sequence through the `expression` wrapper): +0 cog, +1 cyc
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 4);
    }

    #[test]
    fn solidity_while_for_loops() {
        let m = compute_solidity(
            "contract C { function f(int x) public { while (x > 0) { x -= 1; } for (uint i = 0; i < 10; i++) { x += 1; } } }",
        );
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn solidity_try_catch() {
        let m = compute_solidity(
            "contract C { function f() public { try other.doThing() returns (uint x) { y = x; } catch Error(string memory reason) { y = 0; } catch { y = 1; } } }",
        );
        // Two independent catch_clause arms on the same try, each its own
        // branch — mirrors how a multi-catch language would be counted.
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 1);
    }
}
