use super::helpers::*;
use super::SymbolExtractor;
use crate::types::*;
use tree_sitter::{Node, Tree};

pub struct HclExtractor;

impl SymbolExtractor for HclExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        symbols
    }
}

/// Collect identifier and string children from a block node.
fn collect_block_tokens(node: &Node, source: &[u8]) -> (Vec<String>, Vec<String>) {
    let mut identifiers = Vec::new();
    let mut strings = Vec::new();
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "identifier" => identifiers.push(node_text(&child, source).to_string()),
                "string_lit" => strings.push(node_text(&child, source).replace('"', "")),
                _ => {}
            }
        }
    }
    (identifiers, strings)
}

/// Resolve the definition name from a block type and its string labels.
fn resolve_block_name(block_type: &str, strings: &[String]) -> String {
    match block_type {
        "resource" if strings.len() >= 2 => format!("{}.{}", strings[0], strings[1]),
        "data" if strings.len() >= 2 => format!("data.{}.{}", strings[0], strings[1]),
        "variable" | "output" | "module" if !strings.is_empty() => {
            format!("{}.{}", block_type, strings[0])
        }
        "locals" => "locals".to_string(),
        "terraform" | "provider" if !strings.is_empty() => {
            format!("{}.{}", block_type, strings[0])
        }
        "terraform" | "provider" => block_type.to_string(),
        _ => String::new(),
    }
}

/// Extract module source imports from a module block's body.
fn extract_module_source(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let body = node.children(&mut node.walk()).find(|c| c.kind() == "body");
    let body = match body {
        Some(b) => b,
        None => return,
    };
    for i in 0..body.child_count() {
        let attr = match body.child(i) {
            Some(a) if a.kind() == "attribute" => a,
            _ => continue,
        };
        let key = attr.child_by_field_name("key").or_else(|| attr.child(0));
        let val = attr.child_by_field_name("val").or_else(|| attr.child(2));
        if let (Some(key), Some(val)) = (key, val) {
            if node_text(&key, source) == "source" {
                let src = node_text(&val, source).replace('"', "");
                if src.starts_with("./") || src.starts_with("../") {
                    symbols
                        .imports
                        .push(Import::new(src, vec![], start_line(&attr)));
                }
            }
        }
    }
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    walk_node_depth(node, source, symbols, 0);
}

fn walk_node_depth(node: &Node, source: &[u8], symbols: &mut FileSymbols, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    if node.kind() == "block" {
        let (identifiers, strings) = collect_block_tokens(node, source);
        if !identifiers.is_empty() {
            let block_type = &identifiers[0];
            let name = resolve_block_name(block_type, &strings);
            if !name.is_empty() {
                symbols.definitions.push(Definition {
                    name,
                    kind: block_type.clone(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                });
                if block_type == "module" {
                    extract_module_source(node, source, symbols);
                }
            }
        }
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_node_depth(&child, source, symbols, depth + 1);
        }
    }
}
