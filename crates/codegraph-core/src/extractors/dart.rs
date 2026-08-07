use super::helpers::*;
use super::SymbolExtractor;
use crate::ast_analysis::cfg::build_function_cfg;
use crate::ast_analysis::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

pub struct DartExtractor;

impl SymbolExtractor for DartExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_dart_node);
        walk_ast_nodes_with_config(
            &tree.root_node(),
            source,
            &mut symbols.ast_nodes,
            &DART_AST_CONFIG,
        );
        symbols
    }
}

fn match_dart_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        // tree-sitter-dart 0.0.4 uses `class_definition`; 0.2 renamed it to
        // `class_declaration`. Accept both so the extractor works across crate
        // versions and during any transition period.
        "class_definition" | "class_declaration" => handle_dart_class(node, source, symbols),
        "enum_declaration" => handle_dart_enum(node, source, symbols),
        "mixin_declaration" => handle_dart_mixin(node, source, symbols),
        "extension_declaration" => handle_dart_extension(node, source, symbols),
        "function_signature" => {
            if !is_inside_class(node) {
                handle_dart_function_sig(node, source, symbols);
            }
        }
        "library_import" => handle_dart_import(node, source, symbols),
        "constructor_invocation" | "new_expression" => {
            handle_dart_constructor_call(node, source, symbols)
        }
        "type_alias" => handle_dart_type_alias(node, source, symbols),
        "selector" => handle_dart_selector(node, source, symbols),
        "call_expression" => handle_dart_call_expression(node, source, symbols),
        _ => {}
    }
}

fn handle_dart_class(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };
    let class_name = node_text(&name_node, source).to_string();

    // Extract methods
    if let Some(body) = node
        .child_by_field_name("body")
        .or_else(|| find_child(node, "class_body"))
    {
        extract_dart_class_methods(&body, &class_name, source, symbols);
    }

    // Extract inheritance
    if let Some(superclass) = node.child_by_field_name("superclass") {
        if let Some(type_name) = find_child(&superclass, "type_identifier")
            .or_else(|| find_child(&superclass, "identifier"))
        {
            symbols.classes.push(ClassRelation {
                name: class_name.clone(),
                extends: Some(node_text(&type_name, source).to_string()),
                implements: None,
                line: start_line(node),
            });
        }
    }
    if let Some(interfaces) = node.child_by_field_name("interfaces") {
        for i in 0..interfaces.child_count() {
            if let Some(child) = interfaces.child(i) {
                let type_name = if child.kind() == "type_identifier" {
                    Some(child)
                } else {
                    find_child(&child, "type_identifier")
                        .or_else(|| find_child(&child, "identifier"))
                };
                if let Some(tn) = type_name {
                    symbols.classes.push(ClassRelation {
                        name: class_name.clone(),
                        extends: None,
                        implements: Some(node_text(&tn, source).to_string()),
                        line: start_line(node),
                    });
                }
            }
        }
    }

    symbols.definitions.push(Definition {
        name: class_name,
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

fn extract_dart_class_methods(
    body: &Node,
    class_name: &str,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    for i in 0..body.child_count() {
        if let Some(member) = body.child(i) {
            // Resolve the signature node from the various wrapper layers that
            // different tree-sitter-dart crate versions produce:
            //
            // 0.0.4 — class_body → class_member_definition → method_signature
            // 0.2   — class_body → class_member → method_declaration
            //                                     (field "signature" → method_signature)
            //
            // In all cases we ultimately want the `method_signature` /
            // `function_signature` node to extract the function name and
            // build CFG/complexity metrics.
            let sig = match member.kind() {
                "class_member_definition" => {
                    // 0.0.4 path: member wraps the signature directly
                    match find_dart_signature_child(&member) {
                        Some(s) => s,
                        None => continue,
                    }
                }
                "class_member" => {
                    // 0.2 path: member → method_declaration (field "signature")
                    // or member → declaration (variable/field — skip those)
                    let method_decl = find_child(&member, "method_declaration");
                    match method_decl {
                        Some(md) => {
                            // method_declaration has field "signature" → method_signature
                            match md
                                .child_by_field_name("signature")
                                .or_else(|| find_dart_signature_child(&md))
                            {
                                Some(s) => s,
                                None => continue,
                            }
                        }
                        None => {
                            // A bodyless (semicolon-only) member — `Foo();` (a
                            // constructor, the short form idiomatic Dart uses
                            // throughout) or `double area();` (an abstract
                            // method with no implementation) — wraps its
                            // constructor_signature/function_signature in a
                            // `declaration` node instead of the
                            // `method_declaration` a block-bodied member uses
                            // (confirmed by parsing both forms with
                            // tree-sitter-dart 0.2; #2082). Check for that
                            // shape before skipping — otherwise every
                            // fixture/codebase using this idiomatic form
                            // silently loses its constructors/abstract methods.
                            let bodyless_sig = find_child(&member, "declaration").and_then(|d| {
                                find_child(&d, "constructor_signature")
                                    .or_else(|| find_child(&d, "method_signature"))
                                    .or_else(|| find_child(&d, "function_signature"))
                            });
                            match bodyless_sig {
                                Some(s) => s,
                                None => continue,
                            }
                        }
                    }
                }
                // Direct signatures at the top of the class body (some grammar versions)
                _ => member,
            };
            match sig.kind() {
                "method_signature" | "function_signature" | "constructor_signature" => {
                    if let Some(fn_name) = extract_dart_fn_name(&sig, source) {
                        symbols.definitions.push(Definition {
                            name: format!("{}.{}", class_name, fn_name),
                            kind: "method".to_string(),
                            line: start_line(&sig),
                            end_line: Some(dart_function_end_line(&sig)),
                            decorators: None,
                            complexity: compute_all_metrics(&sig, source, "dart"),
                            cfg: build_function_cfg(&sig, "dart", source),
                            children: None,
                            bodyless: None,
                            content_hash: None,
                            accessor_kind: None,
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

fn find_dart_signature_child<'a>(node: &Node<'a>) -> Option<Node<'a>> {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if matches!(child.kind(), "method_signature" | "function_signature") {
                return Some(child);
            }
        }
    }
    None
}

/// Compute the true end line for a function/method whose grammar splits the
/// signature and body into SIBLING nodes — `function_signature`/
/// `method_signature` followed by a separate `function_body` sibling under
/// the SAME parent — rather than nesting the body inside the signature node
/// (confirmed by parsing multi-line top-level functions and class methods
/// with tree-sitter-dart 0.2; #2082, and the same root cause tracked for
/// complexity/dataflow purposes in #2182). Using the signature node's own
/// span alone truncates `end_line` to the signature line, so any call
/// inside a multi-line body falls outside `[line, end_line]` and
/// enclosing-function caller-attribution during graph build silently
/// misses it. Mirrors `dartFunctionEndLine` in `src/extractors/dart.ts`.
///
/// Falls back to the signature node's own span when the next sibling is a
/// bare `;` (an abstract/interface method signature with no body at all)
/// or doesn't exist.
fn dart_function_end_line(signature_node: &Node) -> u32 {
    if let Some(parent) = signature_node.parent() {
        for i in 0..parent.child_count() {
            if let Some(child) = parent.child(i) {
                if child.id() == signature_node.id() {
                    // A `comment` can appear as its own intervening sibling
                    // BETWEEN the signature and its body (confirmed by
                    // parsing a signature followed by a same-line-or-not
                    // `//` comment then `{ ... }` — Greptile review on
                    // #2082), since tree-sitter-dart's comment rule is an
                    // `extra` production that can surface anywhere in the
                    // tree, not just a token folded into an adjacent node.
                    // Skip past any number of them to find the real next
                    // sibling. Mirrors `dartFunctionEndLine` in
                    // `src/extractors/dart.ts`.
                    let mut j = i + 1;
                    let mut next = parent.child(j);
                    while let Some(n) = next {
                        if n.kind() != "comment" {
                            break;
                        }
                        j += 1;
                        next = parent.child(j);
                    }
                    if let Some(next) = next {
                        if next.kind() != ";" {
                            return end_line(&next);
                        }
                    }
                    break;
                }
            }
        }
    }
    end_line(signature_node)
}

fn extract_dart_fn_name(node: &Node, source: &[u8]) -> Option<String> {
    if let Some(name) = node.child_by_field_name("name") {
        return Some(node_text(&name, source).to_string());
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "function_signature"
                | "getter_signature"
                | "setter_signature"
                | "constructor_signature" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        return Some(node_text(&name, source).to_string());
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn handle_dart_enum(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "enum".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

fn handle_dart_mixin(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match find_child(node, "identifier") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

fn handle_dart_extension(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

fn handle_dart_function_sig(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(dart_function_end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "dart"),
        cfg: build_function_cfg(node, "dart", source),
        children: None,
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

fn handle_dart_import(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let spec = match find_child(node, "import_specification") {
        Some(s) => s,
        None => return,
    };

    let uri = find_child(&spec, "configurable_uri").or_else(|| find_child(&spec, "uri"));
    if let Some(uri) = uri {
        let raw = node_text(&uri, source);
        let source_path = raw.trim_matches(|c| c == '\'' || c == '"').to_string();
        symbols
            .imports
            .push(Import::new(source_path, vec![], start_line(node)));
    }
}

fn handle_dart_constructor_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // tree-sitter-dart crate versions structure the type name differently:
    // 0.2 (crates.io, current) nests it under an intermediate `type` field —
    // `new_expression type: (type (type_identifier)) arguments: (...)` —
    // while npm's tree-sitter-dart 1.x (used by the WASM engine, see
    // check-grammar-versions.mjs's tracked exception for this crate) puts it
    // directly under `new_expression` — `(new_expression (type_identifier)
    // (arguments))`. Try the direct shape first, then unwrap one `type` level.
    let name_node = find_child(node, "type_identifier")
        .or_else(|| find_child(node, "identifier"))
        .or_else(|| {
            node.child_by_field_name("type")
                .or_else(|| find_child(node, "type"))
                .and_then(|t| {
                    find_child(&t, "type_identifier").or_else(|| find_child(&t, "identifier"))
                })
        });
    if let Some(name) = name_node {
        symbols.calls.push(Call {
            name: node_text(&name, source).to_string(),
            line: start_line(node),
            dynamic: None,
            receiver: None,
            ..Default::default()
        });
    }
}

fn handle_dart_type_alias(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = find_child(node, "type_identifier").or_else(|| find_child(node, "identifier"));
    if let Some(name) = name_node {
        symbols.definitions.push(Definition {
            name: node_text(&name, source).to_string(),
            kind: "type".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }
}

fn handle_dart_selector(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // selector with argument_part represents a function call; mirrors handleDartSelector in dart.ts
    if find_child(node, "argument_part").is_none() {
        return;
    }
    let unconditional = match find_child(node, "unconditional_assignable_selector") {
        Some(n) => n,
        None => return,
    };
    let id = match find_child(&unconditional, "identifier") {
        Some(n) => n,
        None => return,
    };
    let method_name = node_text(&id, source);

    // Function.apply(fn, positionalArgs, namedArgs) — dynamic higher-order dispatch
    if method_name == "apply" {
        if let Some(parent) = node.parent() {
            for i in 0..parent.child_count() {
                if let Some(sibling) = parent.child(i) {
                    if sibling.id() != node.id() && node_text(&sibling, source) == "Function" {
                        symbols.calls.push(Call {
                            name: "<dynamic:unresolved>".to_string(),
                            line: start_line(node),
                            dynamic: Some(true),
                            dynamic_kind: Some("unresolved-dynamic".to_string()),
                            ..Default::default()
                        });
                        return;
                    }
                }
            }
        }
    }

    push_simple_call(symbols, node, method_name);
}

/// Handles `call_expression` nodes — the shape tree-sitter-dart 0.2
/// (crates.io, the native engine's grammar) uses for EVERY function/method
/// call, bare or chained (`helper()`, `Foo()`, `obj.method()`,
/// `obj.method1().method2()`), confirmed by parsing sample calls with this
/// crate version and inspecting `src/node-types.json`. This is a
/// structurally different (and simpler) shape than the `selector`/
/// `unconditional_assignable_selector` chain `handle_dart_selector` targets
/// for older grammar versions — a `call_expression` node never appeared in
/// the parse tree for any of these calls, so `handle_dart_selector` alone
/// left every native Dart call unextracted (#2082).
///
/// `function` field: `identifier` for a bare call (the callee's own name),
/// or `member_expression` for a chained/property call (`property` field is
/// the invoked method name — the chain's earlier `call_expression`s, e.g.
/// `obj.method1()` inside `obj.method1().method2()`, are visited separately
/// by the tree walk's own recursion, so no manual recursion is needed here).
fn handle_dart_call_expression(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(func) = node.child_by_field_name("function") else {
        return;
    };
    match func.kind() {
        "identifier" => {
            let name = node_text(&func, source).to_string();
            push_simple_call(symbols, node, name);
        }
        "member_expression" => {
            let Some(property) = func.child_by_field_name("property") else {
                return;
            };
            let method_name = node_text(&property, source).to_string();

            // Function.apply(fn, positionalArgs, namedArgs) — dynamic
            // higher-order dispatch, mirrors handle_dart_selector's own
            // Function.apply special case for the older grammar shape.
            if method_name == "apply" {
                if let Some(object) = func.child_by_field_name("object") {
                    if object.kind() == "identifier" && node_text(&object, source) == "Function" {
                        symbols.calls.push(Call {
                            name: "<dynamic:unresolved>".to_string(),
                            line: start_line(node),
                            dynamic: Some(true),
                            dynamic_kind: Some("unresolved-dynamic".to_string()),
                            ..Default::default()
                        });
                        return;
                    }
                }
            }

            push_simple_call(symbols, node, method_name);
        }
        _ => {}
    }
}

fn is_inside_class(node: &Node) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            // Accept both 0.0.4 (`class_definition`) and 0.2 (`class_declaration`)
            // node names to guard function_signature extraction from top-level scope.
            "class_body" | "class_definition" | "class_declaration" | "enum_body"
            | "mixin_declaration" => return true,
            _ => {}
        }
        current = parent.parent();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_dart(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_dart::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code, None).unwrap();
        DartExtractor.extract(&tree, code.as_bytes(), "test.dart")
    }

    // #2082: tree-sitter-dart 0.2 (the native engine's grammar) represents
    // EVERY function/method call — bare or chained — as a `call_expression`
    // node, a structurally different shape from the `selector`-based one
    // `handle_dart_selector` targets for older grammar versions. Without a
    // dispatch case for `call_expression`, no native Dart call was ever
    // extracted at all.
    mod call_expression_extraction {
        use super::*;

        #[test]
        fn extracts_a_bare_plain_function_call() {
            let s = parse_dart("void main() {\n  helper();\n}");
            assert!(
                s.calls.iter().any(|c| c.name == "helper"),
                "expected a call named 'helper'; got: {:?}",
                s.calls
            );
        }

        #[test]
        fn extracts_a_bare_constructor_call() {
            let s = parse_dart("void main() {\n  var w = Foo();\n}");
            assert!(
                s.calls.iter().any(|c| c.name == "Foo"),
                "expected a call named 'Foo'; got: {:?}",
                s.calls
            );
        }

        #[test]
        fn resolves_each_call_in_a_chained_sequence_to_its_own_name() {
            let s = parse_dart("void main() {\n  obj.method1().method2();\n}");
            let names: Vec<&str> = s.calls.iter().map(|c| c.name.as_str()).collect();
            assert!(
                names.contains(&"method1"),
                "missing method1; got: {:?}",
                names
            );
            assert!(
                names.contains(&"method2"),
                "missing method2; got: {:?}",
                names
            );
        }

        #[test]
        fn flags_function_apply_as_unresolved_dynamic() {
            let s = parse_dart("void g() {\n  var r = Function.apply(callback, []);\n}");
            assert!(
                s.calls
                    .iter()
                    .any(|c| c.name == "<dynamic:unresolved>" && c.dynamic == Some(true)),
                "expected an unresolved-dynamic call; got: {:?}",
                s.calls
            );
        }
    }

    // #2082: function_signature/method_signature and function_body are
    // SIBLING nodes in tree-sitter-dart, not parent-child, so end_line must
    // be measured through to the sibling body.
    mod end_line {
        use super::*;

        #[test]
        fn spans_a_multiline_top_level_function_through_its_closing_brace() {
            let s = parse_dart("Foo makeWaldo() {\n  return Foo();\n}");
            let def = s.definitions.iter().find(|d| d.name == "makeWaldo");
            assert!(
                def.is_some(),
                "missing makeWaldo definition; got: {:?}",
                s.definitions
            );
            let def = def.unwrap();
            assert_eq!(def.line, 1);
            assert_eq!(def.end_line, Some(3));
        }

        #[test]
        fn spans_a_multiline_class_method_through_its_closing_brace() {
            let s = parse_dart(
                "class UserService {\n  User getUser(String id) {\n    return User(id);\n  }\n}",
            );
            let def = s
                .definitions
                .iter()
                .find(|d| d.name == "UserService.getUser");
            assert!(
                def.is_some(),
                "missing UserService.getUser; got: {:?}",
                s.definitions
            );
            let def = def.unwrap();
            assert_eq!(def.line, 2);
            assert_eq!(def.end_line, Some(4));
        }

        #[test]
        fn does_not_extend_past_the_signature_for_an_abstract_method() {
            let s = parse_dart("abstract class Shape {\n  double area();\n}");
            let def = s.definitions.iter().find(|d| d.name == "Shape.area");
            assert!(
                def.is_some(),
                "missing Shape.area; got: {:?}",
                s.definitions
            );
            assert_eq!(def.unwrap().end_line, Some(2));
        }

        // Review finding: a comment between the signature and its body is
        // its own intervening SIBLING node (tree-sitter-dart's comment rule
        // is an `extra` production, not folded into an adjacent node),
        // which the naive "next sibling" lookup mistook for the body itself.
        #[test]
        fn skips_a_comment_between_the_signature_and_its_body() {
            let s = parse_dart(
                "Foo makeWaldo()\n// a comment between signature and body\n{\n  return Foo();\n}",
            );
            let def = s.definitions.iter().find(|d| d.name == "makeWaldo");
            assert!(def.is_some(), "missing makeWaldo; got: {:?}", s.definitions);
            let def = def.unwrap();
            assert_eq!(def.line, 1);
            assert_eq!(def.end_line, Some(5));
        }
    }

    // #2082: a bodyless (semicolon-only) constructor — `Foo();`, the short
    // form idiomatic Dart uses throughout — wraps its constructor_signature
    // in a `declaration` node instead of the `method_declaration` a
    // block-bodied constructor uses.
    mod bodyless_members {
        use super::*;

        #[test]
        fn extracts_a_semicolon_only_constructor() {
            let s = parse_dart("class Waldo {\n  Waldo();\n}");
            assert!(
                s.definitions
                    .iter()
                    .any(|d| d.name == "Waldo.Waldo" && d.kind == "method"),
                "missing Waldo.Waldo method; got: {:?}",
                s.definitions
            );
        }

        #[test]
        fn extracts_a_semicolon_only_constructor_with_this_shorthand_params() {
            let s = parse_dart("class User {\n  final String id;\n  User(this.id);\n}");
            assert!(
                s.definitions
                    .iter()
                    .any(|d| d.name == "User.User" && d.kind == "method"),
                "missing User.User method; got: {:?}",
                s.definitions
            );
        }

        #[test]
        fn still_extracts_a_block_bodied_constructor() {
            let s = parse_dart("class Waldo {\n  Waldo() {\n    print('hi');\n  }\n}");
            assert!(
                s.definitions
                    .iter()
                    .any(|d| d.name == "Waldo.Waldo" && d.kind == "method"),
                "missing Waldo.Waldo method; got: {:?}",
                s.definitions
            );
        }
    }
}
