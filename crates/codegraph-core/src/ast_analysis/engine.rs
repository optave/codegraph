//! Standalone analysis functions exposed via napi-rs.
//!
//! These allow the JS engine to call Rust for individual analysis passes
//! (complexity, CFG, dataflow) without going through the full parse pipeline.
//! Each function parses the source internally, finds function nodes, and
//! returns per-function results that the JS engine matches to definitions by line.

use tree_sitter::{Node, Parser};

use crate::ast_analysis::cfg::{build_function_cfg, get_cfg_rules};
use crate::ast_analysis::complexity::{compute_all_metrics, lang_rules};
use crate::ast_analysis::dataflow::extract_dataflow;
use crate::domain::parser::LanguageKind;
use crate::extractors::julia::signature_call;
use crate::extractors::r_lang::assigned_function_name;
use crate::shared::constants::MAX_WALK_DEPTH;
use crate::types::{DataflowResult, FunctionCfgResult, FunctionComplexityResult};

/// Fallback name lookup via the node's own direct `name` field, for
/// languages whose function nodes actually carry one.
fn generic_function_name(node: &Node, source: &[u8]) -> String {
    node.child_by_field_name("name")
        .map(|n| n.utf8_text(source).unwrap_or("<anonymous>").to_string())
        .unwrap_or_else(|| "<anonymous>".to_string())
}

/// Extract the name of a function/method node.
///
/// Most languages' function nodes carry a direct `name` field, but Julia and
/// R do not (issue #2471) — their real extractors (`extractors/julia.rs`,
/// `extractors/r_lang.rs`) already resolve names correctly for these
/// languages; this reuses that exact logic instead of re-deriving it, so the
/// two can't silently drift apart on what counts as a function's name.
///
/// R is never allowed to fall through to `generic_function_name`: confirmed
/// by direct inspection that tree-sitter-r's grammar *does* define a `name`
/// field on `function_definition` — but it points at the literal `function`
/// keyword token, not an identifier (R has no named-function-definition
/// syntax at all; every function is an anonymous expression that only
/// acquires a name via assignment). Falling through there wouldn't report
/// "<anonymous>" as this issue originally assumed — it would report the
/// literal string "function" for every unnamed R function, which is a more
/// actively misleading result than a missing name.
fn function_name(node: &Node, source: &[u8], lang_id: &str) -> String {
    match lang_id {
        "julia" => signature_call(node)
            .and_then(|call_sig| call_sig.child(0))
            .and_then(|name_node| name_node.utf8_text(source).ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| generic_function_name(node, source)),
        "r" => assigned_function_name(node, source).unwrap_or_else(|| "<anonymous>".to_string()),
        _ => generic_function_name(node, source),
    }
}

/// Collect all function/method nodes from the AST using a DFS walk.
/// Uses the complexity rules' `function_nodes` list to identify function node types.
fn collect_function_nodes<'a>(
    root: Node<'a>,
    function_types: &[&str],
    depth: usize,
) -> Vec<Node<'a>> {
    let mut result = Vec::new();
    if depth >= MAX_WALK_DEPTH {
        return result;
    }
    if function_types.contains(&root.kind()) {
        result.push(root);
    }
    for i in 0..root.child_count() {
        if let Some(child) = root.child(i) {
            result.extend(collect_function_nodes(child, function_types, depth + 1));
        }
    }
    result
}

/// Parse source code and return a tree + language kind, or None if unsupported.
/// When `lang_id` is provided, it is used as the primary language hint (supports
/// files whose language is inferred by content rather than extension, e.g. `.vue`
/// files tagged as `"javascript"` or extension-less files with a shebang).
/// Falls back to extension detection when `lang_id` is `None`.
fn parse_source(
    source: &str,
    file_path: &str,
    lang_id: Option<&str>,
) -> Option<(tree_sitter::Tree, LanguageKind)> {
    let lang = lang_id
        .and_then(LanguageKind::from_lang_id)
        .or_else(|| LanguageKind::from_extension(file_path))?;
    let mut parser = Parser::new();
    parser.set_language(&lang.tree_sitter_language()).ok()?;
    let tree = parser.parse(source.as_bytes(), None)?;
    Some((tree, lang))
}

/// Analyze complexity metrics for all functions in the given source.
/// Returns per-function results with name, line, and full complexity metrics.
pub fn analyze_complexity_standalone(
    source: &str,
    file_path: &str,
    lang_id: Option<&str>,
) -> Vec<FunctionComplexityResult> {
    let (tree, lang) = match parse_source(source, file_path, lang_id) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let lang_id = lang.lang_id_str();
    let rules = match lang_rules(lang_id) {
        Some(r) => r,
        None => return Vec::new(),
    };

    let root = tree.root_node();
    let func_nodes = collect_function_nodes(root, rules.function_nodes, 0);
    let source_bytes = source.as_bytes();

    func_nodes
        .into_iter()
        .filter_map(|node| {
            let metrics = compute_all_metrics(&node, source_bytes, lang_id)?;
            let name = function_name(&node, source_bytes, lang_id);
            let line = node.start_position().row as u32 + 1;
            let column = Some(node.start_position().column as u32);
            let end_line = Some(node.end_position().row as u32 + 1);
            Some(FunctionComplexityResult {
                name,
                line,
                column,
                end_line,
                complexity: metrics,
            })
        })
        .collect()
}

/// Build control-flow graphs for all functions in the given source.
/// Returns per-function results with name, line, and CFG data.
pub fn build_cfg_standalone(
    source: &str,
    file_path: &str,
    lang_id: Option<&str>,
) -> Vec<FunctionCfgResult> {
    let (tree, lang) = match parse_source(source, file_path, lang_id) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let lang_id = lang.lang_id_str();
    if get_cfg_rules(lang_id).is_none() {
        return Vec::new();
    }

    // Use complexity rules' function_nodes to find functions (CFG rules don't list them)
    let func_types = match lang_rules(lang_id) {
        Some(r) => r.function_nodes,
        None => return Vec::new(),
    };

    let root = tree.root_node();
    let func_nodes = collect_function_nodes(root, func_types, 0);
    let source_bytes = source.as_bytes();

    func_nodes
        .into_iter()
        .filter_map(|node| {
            let cfg = build_function_cfg(&node, lang_id, source_bytes)?;
            let name = function_name(&node, source_bytes, lang_id);
            let line = node.start_position().row as u32 + 1;
            let column = Some(node.start_position().column as u32);
            let end_line = Some(node.end_position().row as u32 + 1);
            Some(FunctionCfgResult {
                name,
                line,
                column,
                end_line,
                cfg,
            })
        })
        .collect()
}

/// Extract dataflow analysis for the given source.
/// Returns file-level dataflow result (parameters, returns, assignments, arg flows, mutations).
pub fn extract_dataflow_standalone(
    source: &str,
    file_path: &str,
    lang_id: Option<&str>,
) -> Option<DataflowResult> {
    let (tree, lang) = parse_source(source, file_path, lang_id)?;
    extract_dataflow(&tree, source.as_bytes(), lang.lang_id_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Issue #2265: `matchNativeResult` (JS side, engine.ts) needs each
    /// standalone result's own column to disambiguate two anonymous
    /// functions that share a line — confirms the native standalone
    /// analysis functions actually populate it.
    #[test]
    fn analyze_complexity_standalone_populates_column() {
        let results = analyze_complexity_standalone(
            "const a = (x) => x, b = (x) => x;",
            "test.js",
            Some("javascript"),
        );
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].column, Some(10));
        assert_eq!(results[1].column, Some(24));
        assert_ne!(results[0].column, results[1].column);
    }

    #[test]
    fn build_cfg_standalone_populates_column() {
        let results = build_cfg_standalone(
            "function outer() { if (true) {} }\nconst a = (x) => x, b = (x) => x;",
            "test.js",
            Some("javascript"),
        );
        let a = results.iter().find(|r| r.line == 2 && r.column == Some(10));
        let b = results.iter().find(|r| r.line == 2 && r.column == Some(24));
        assert!(a.is_some(), "expected a result at line 2, column 10");
        assert!(b.is_some(), "expected a result at line 2, column 25");
    }

    // #2471: Julia and R function_definition nodes carry no direct `name`
    // field, unlike most other languages this crate supports — the generic
    // function_name() fallback used to silently report a wrong name for
    // every function in these two languages (Julia: "<anonymous>"; R:
    // actively worse — the literal string "function", since tree-sitter-r's
    // grammar happens to define a `name` field pointing at the keyword
    // token itself, not an identifier).
    //
    // Only `analyze_complexity_standalone` is exercised here for Julia/R —
    // `get_cfg_rules` (ast_analysis/cfg.rs) has no entry for either language
    // at all, so `build_cfg_standalone` correctly returns zero results for
    // both regardless of this fix; that's a separate, pre-existing, and
    // out-of-scope gap (CFG support for Julia/R hasn't been built yet), not
    // something this issue's name-resolution fix touches.
    #[test]
    fn analyze_complexity_standalone_resolves_julia_function_name() {
        let results = analyze_complexity_standalone(
            "function greet(name)\n    return \"hello, \" * name\nend",
            "test.jl",
            Some("julia"),
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "greet");
    }

    #[test]
    fn analyze_complexity_standalone_resolves_r_function_name() {
        let results = analyze_complexity_standalone(
            "greet <- function(name) {\n  return(paste(\"hello,\", name))\n}",
            "test.r",
            Some("r"),
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "greet");
    }

    #[test]
    fn analyze_complexity_standalone_r_anonymous_function_reports_anonymous_not_the_function_keyword(
    ) {
        // A function_definition with no enclosing name-assigning
        // binary_operator (an inline callback) has no name to resolve — must
        // report "<anonymous>", NOT fall through to generic_function_name's
        // child_by_field_name("name") lookup, which for R returns the
        // literal "function" keyword token rather than None (confirmed by
        // direct AST inspection — R's grammar defines that field, just not
        // with the meaning this generic fallback assumes).
        let results =
            analyze_complexity_standalone("lapply(x, function(y) y + 1)", "test.r", Some("r"));
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "<anonymous>");
    }
}
