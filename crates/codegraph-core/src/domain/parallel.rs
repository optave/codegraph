use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::fs;
use tree_sitter::Parser;

use crate::ast_analysis::dataflow::extract_dataflow;
use crate::extractors::extract_symbols_with_opts;
use crate::domain::parser::LanguageKind;
use crate::types::{Definition, FileSymbols};

/// SHA-256 hash of a declaration's own source text (1-based, inclusive
/// `start_line..=end_line`), or `None` when `end_line` is unavailable — a
/// declaration with no reliable body range has nothing meaningful to hash.
/// Gives reverse-dep-edge reconnection during incremental rebuilds a true
/// identity signal beyond line position (issue #2015).
fn compute_declaration_hash(lines: &[&str], start_line: u32, end_line: Option<u32>) -> Option<String> {
    let end_line = end_line?;
    if start_line == 0 || end_line < start_line {
        return None;
    }
    let start_idx = (start_line - 1) as usize;
    let end_idx = (end_line - 1) as usize;
    if start_idx >= lines.len() {
        return None;
    }
    let end_idx = end_idx.min(lines.len().saturating_sub(1));
    let body = lines[start_idx..=end_idx].join("\n");
    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    Some(format!("{:x}", hasher.finalize()))
}

/// Recursively populates `content_hash` on every definition (and nested
/// child) in `symbols`, using the already-in-scope raw `source` before it's
/// discarded — computed once, centrally, here rather than per-extractor,
/// since every extractor already populates `line`/`end_line` uniformly.
/// `pub(crate)`: also used by `ParseTreeCache::parse_file`
/// (`domain/graph/builder/incremental.rs`), the primary incremental-rebuild
/// parse path, which calls `extract_symbols` directly rather than through
/// this module's own `parse_file`/`parse_files_parallel*`.
pub(crate) fn compute_declaration_hashes(definitions: &mut [Definition], lines: &[&str]) {
    for def in definitions.iter_mut() {
        def.content_hash = compute_declaration_hash(lines, def.line, def.end_line);
        if let Some(children) = def.children.as_mut() {
            compute_declaration_hashes(children, lines);
        }
    }
}

/// Parse multiple files in parallel using rayon.
/// Each thread creates its own Parser (cheap; Language objects are Send+Sync).
/// Failed files are silently skipped (matches WASM behavior).
/// All analysis data (symbols, AST nodes, complexity, CFG, dataflow) is always
/// extracted in a single parse pass — no separate re-parse needed downstream.
/// When `include_dataflow` is false, dataflow extraction is skipped for performance.
/// When `include_ast_nodes` is false, AST node walking is skipped for performance.
pub fn parse_files_parallel(
    file_paths: &[String],
    _root_dir: &str,
    include_dataflow: bool,
    include_ast_nodes: bool,
) -> Vec<FileSymbols> {
    file_paths
        .par_iter()
        .filter_map(|file_path| {
            let lang = LanguageKind::from_extension(file_path)?;
            let source = fs::read(file_path).ok()?;
            let line_count = source.iter().filter(|&&b| b == b'\n').count() as u32 + 1;

            let mut parser = Parser::new();
            parser.set_language(&lang.tree_sitter_language()).ok()?;

            let tree = parser.parse(&source, None)?;
            let mut symbols =
                extract_symbols_with_opts(lang, &tree, &source, file_path, include_ast_nodes);
            if include_dataflow {
                symbols.dataflow = extract_dataflow(&tree, &source, lang.lang_id_str());
            }
            symbols.line_count = Some(line_count);
            let source_text = String::from_utf8_lossy(&source);
            let lines: Vec<&str> = source_text.lines().collect();
            compute_declaration_hashes(&mut symbols.definitions, &lines);
            Some(symbols)
        })
        .collect()
}

/// Parse multiple files in parallel, always extracting ALL analysis data:
/// symbols, AST nodes, complexity, CFG, and dataflow in a single parse pass.
/// This eliminates the need for any downstream re-parse (WASM or native standalone).
pub fn parse_files_parallel_full(
    file_paths: &[String],
    _root_dir: &str,
) -> Vec<FileSymbols> {
    file_paths
        .par_iter()
        .filter_map(|file_path| {
            let lang = LanguageKind::from_extension(file_path)?;
            let source = fs::read(file_path).ok()?;
            let line_count = source.iter().filter(|&&b| b == b'\n').count() as u32 + 1;

            let mut parser = Parser::new();
            parser.set_language(&lang.tree_sitter_language()).ok()?;

            let tree = parser.parse(&source, None)?;
            // Always include AST nodes
            let mut symbols =
                extract_symbols_with_opts(lang, &tree, &source, file_path, true);
            // Always extract dataflow
            symbols.dataflow = extract_dataflow(&tree, &source, lang.lang_id_str());
            symbols.line_count = Some(line_count);
            let source_text = String::from_utf8_lossy(&source);
            let lines: Vec<&str> = source_text.lines().collect();
            compute_declaration_hashes(&mut symbols.definitions, &lines);
            Some(symbols)
        })
        .collect()
}

/// Parse a single file and return its symbols.
/// When `include_dataflow` is false, dataflow extraction is skipped for performance.
/// When `include_ast_nodes` is false, AST node walking is skipped for performance.
pub fn parse_file(
    file_path: &str,
    source: &str,
    include_dataflow: bool,
    include_ast_nodes: bool,
) -> Option<FileSymbols> {
    let lang = LanguageKind::from_extension(file_path)?;
    let source_bytes = source.as_bytes();

    let mut parser = Parser::new();
    parser.set_language(&lang.tree_sitter_language()).ok()?;

    let tree = parser.parse(source_bytes, None)?;
    let line_count = source_bytes.iter().filter(|&&b| b == b'\n').count() as u32 + 1;
    let mut symbols =
        extract_symbols_with_opts(lang, &tree, source_bytes, file_path, include_ast_nodes);
    if include_dataflow {
        symbols.dataflow = extract_dataflow(&tree, source_bytes, lang.lang_id_str());
    }
    symbols.line_count = Some(line_count);
    let lines: Vec<&str> = source.lines().collect();
    compute_declaration_hashes(&mut symbols.definitions, &lines);
    Some(symbols)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(name: &str, line: u32, end_line: Option<u32>) -> Definition {
        Definition {
            name: name.to_string(),
            kind: "function".to_string(),
            line,
            end_line,
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
            bodyless: None,
            content_hash: None,
        }
    }

    #[test]
    fn compute_declaration_hash_is_deterministic_for_identical_content() {
        let lines = vec!["fn a() {", "  1", "}", "fn a() {", "  1", "}"];
        let hash_a = compute_declaration_hash(&lines, 1, Some(3));
        let hash_b = compute_declaration_hash(&lines, 4, Some(6));
        assert!(hash_a.is_some());
        assert_eq!(hash_a, hash_b, "identical body text must hash identically");
    }

    #[test]
    fn compute_declaration_hash_differs_for_different_content() {
        let lines = vec!["fn a() {", "  1", "}", "fn b() {", "  2", "}"];
        let hash_a = compute_declaration_hash(&lines, 1, Some(3));
        let hash_b = compute_declaration_hash(&lines, 4, Some(6));
        assert_ne!(hash_a, hash_b, "different body text must hash differently");
    }

    #[test]
    fn compute_declaration_hash_returns_none_without_end_line() {
        let lines = vec!["fn a() {", "  1", "}"];
        assert_eq!(compute_declaration_hash(&lines, 1, None), None);
    }

    #[test]
    fn compute_declaration_hash_returns_none_for_out_of_range_start() {
        let lines = vec!["fn a() {", "  1", "}"];
        assert_eq!(compute_declaration_hash(&lines, 99, Some(100)), None);
    }

    #[test]
    fn compute_declaration_hashes_recurses_into_children() {
        let lines = vec!["fn a() {", "  1", "}"];
        let mut defs = vec![Definition {
            children: Some(vec![def("child", 1, Some(3))]),
            ..def("parent", 1, Some(3))
        }];
        compute_declaration_hashes(&mut defs, &lines);
        assert!(defs[0].content_hash.is_some());
        assert!(defs[0].children.as_ref().unwrap()[0].content_hash.is_some());
    }
}
