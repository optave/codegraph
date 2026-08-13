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
        // #2319: seed typeMap from explicitly-typed field declarations and
        // `this.field` constructor-shorthand params, mirroring the two-pass
        // convention every other type-map-populating extractor in this file
        // uses (match_X_node then match_X_type_map, e.g. javascript.rs,
        // python.rs, swift.rs).
        walk_tree(&tree.root_node(), source, &mut symbols, match_dart_type_map);
        dedup_type_map(&mut symbols.type_map);
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

/// #2319: seed typeMap entries for call resolution — Dart's explicitly-typed
/// field declarations and `this.field` constructor-shorthand params. A
/// separate pass (rather than folding into `match_dart_node` above) mirrors
/// the two-pass convention every other type-map-populating extractor in this
/// crate uses (`match_X_node` then `match_X_type_map` — e.g. javascript.rs,
/// python.rs, swift.rs).
fn match_dart_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "declaration" => handle_dart_field_decl_type_map(node, source, symbols),
        "constructor_param" => handle_dart_constructor_param_type_map(node, source, symbols),
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

/// Seed a class-scoped typeMap entry for a Dart instance field, mirroring
/// `handle_field_def_type_map`'s convention in this crate's `javascript.rs`
/// (itself mirroring `handleFieldDefTypeMap` in `src/extractors/javascript.ts`):
/// a primary class-scoped key (`ClassName.field`, confidence 0.9) so two
/// classes with identically-named fields of different types don't overwrite
/// each other's entry, plus lower-confidence bare-name fallbacks (`field`,
/// `this.field`, confidence 0.6) for callers the resolver can't attribute to
/// a specific class at all.
///
/// Idiomatic Dart reads a field with a bare identifier — `_repo.findById()`
/// inside the SAME class means `this._repo` implicitly, unlike JS/TS, which
/// requires an explicit `this.` prefix for every field read. This crate's
/// receiver extraction (`find_dart_selector_receiver` / the `object` field
/// read in `handle_dart_call_expression`) normalises that implicit shape by
/// emitting the receiver text itself as `this.<name>` (matching the JS/TS
/// convention textually), so `resolve_call_targets_core` in
/// `build_edges.rs` treats a bare Dart field receiver exactly like a JS/TS
/// `this.field` one: it strips the `this.` prefix and tries the
/// class-scoped key (`ClassName.field`) FIRST, before ever falling back to
/// these bare/`this.`-prefixed keys. That is what actually prevents two
/// classes in the same file from cross-contaminating each other's
/// same-named field's method resolution (#2319 follow-up on PR #2477's
/// Greptile finding — see `find_dart_selector_receiver`'s and
/// `handle_dart_call_expression`'s own doc comments for the
/// extraction-side half of this fix). The bare/`this.`-prefixed keys seeded
/// here remain as the fallback for any caller the resolver can't scope to a
/// class at all. Mirrors `seedDartFieldTypeMapEntry` in
/// `src/extractors/dart.ts`.
fn seed_dart_field_type_map_entry(
    symbols: &mut FileSymbols,
    class_name: Option<&str>,
    field_name: &str,
    type_name: &str,
) {
    match class_name {
        Some(class_name) => {
            set_type_map_entry(
                symbols,
                format!("{}.{}", class_name, field_name),
                type_name.to_string(),
                0.9,
            );
            set_type_map_entry(symbols, field_name.to_string(), type_name.to_string(), 0.6);
            set_type_map_entry(
                symbols,
                format!("this.{}", field_name),
                type_name.to_string(),
                0.6,
            );
        }
        None => {
            // No enclosing class (shouldn't happen for a real Dart field —
            // members are always inside a class_body — kept for defensive
            // symmetry with handleFieldDefTypeMap's own "no enclosing class"
            // branch).
            set_type_map_entry(symbols, field_name.to_string(), type_name.to_string(), 0.9);
            set_type_map_entry(
                symbols,
                format!("this.{}", field_name),
                type_name.to_string(),
                0.9,
            );
        }
    }
}

/// Extract the declared type name from a class-field `declaration` node.
/// tree-sitter-dart 0.2 (crates.io, this native engine's pinned grammar)
/// nests the type under a NAMED field `type:` pointing to a `type` node,
/// which itself wraps the base `type_identifier` — `final UserRepository
/// _repo;` parses as `declaration type: (type (type_identifier))
/// (initialized_identifier_list ...)` (confirmed by parsing several field
/// variants — final/late/nullable/generic — with tree-sitter-dart 0.2;
/// #2319). This mirrors the SAME "intermediate `type` field" version
/// difference `handle_dart_constructor_call` already documents for
/// `new_expression`'s constructor name — npm's tree-sitter-dart 1.x (the
/// WASM engine's grammar) instead puts `type_identifier` DIRECTLY under
/// `declaration`, no wrapper at all (see `extractDartDeclaredTypeName` in
/// `src/extractors/dart.ts`). A generic's type arguments (`List<User>`) are
/// a separate `type_arguments` sibling INSIDE the `type` node, and a
/// nullable `?` a separate anonymous token, so reading only the
/// `type_identifier`'s own text already yields the simple base type name
/// with no further stripping needed. Returns `None` when there's no
/// explicit type at all (`var x = Foo();`) — inferring one from the
/// initializer is a separate, out-of-scope problem — or when `node` isn't
/// shaped like a field at all (a bodyless constructor/abstract-method
/// `declaration` has no `type` field either).
fn extract_dart_declared_type_name<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    let type_node = node
        .child_by_field_name("type")
        .or_else(|| find_child(node, "type"))?;
    find_child(&type_node, "type_identifier").map(|t| node_text(&t, source))
}

/// Nearest enclosing class name for class-scoped typeMap keys — walks the
/// node's ancestor chain looking for the nearest `class_definition` /
/// `class_declaration` (both crate-version node names, matching
/// `match_dart_node`'s own dual-version acceptance), mirroring
/// `enclosing_type_map_class` in this crate's `javascript.rs` and this
/// file's own existing `is_inside_class` ancestor-walk pattern. Mirrors
/// `findEnclosingDartClassName` in `src/extractors/dart.ts`.
fn find_enclosing_dart_class_name(node: &Node, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "class_definition" || parent.kind() == "class_declaration" {
            return parent
                .child_by_field_name("name")
                .map(|n| node_text(&n, source).to_string());
        }
        current = parent.parent();
    }
    None
}

/// Seed typeMap entries for every field name declared by a class-field
/// `declaration` node — `final Foo a, b;` declares BOTH `a` and `b` at type
/// `Foo` (comma-separated multi-identifier fields, confirmed by parsing with
/// tree-sitter-dart 0.2; #2319). No-ops when the declaration has no explicit
/// type (see `extract_dart_declared_type_name`) or isn't shaped like a field
/// at all — recognized by the absence of `initialized_identifier_list`,
/// which only a field declaration has (a bodyless constructor/abstract
/// method wraps a `constructor_signature`/`function_signature` instead).
/// Mirrors `handleDartFieldDeclTypeMap` in `src/extractors/dart.ts`.
fn handle_dart_field_decl_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(type_name) = extract_dart_declared_type_name(node, source) else {
        return;
    };
    let Some(list) = find_child(node, "initialized_identifier_list") else {
        return;
    };
    let class_name = find_enclosing_dart_class_name(node, source);
    for i in 0..list.child_count() {
        let Some(item) = list.child(i) else {
            continue;
        };
        if item.kind() != "initialized_identifier" {
            continue;
        }
        // tree-sitter-dart 0.2 exposes a NAMED field `name:` for the field's
        // own identifier (confirmed by parsing `final Foo a, b;`, whose sexp
        // shows `initialized_identifier name: (identifier)` for EACH of `a`
        // and `b`); fall back to a structural scan for defensive symmetry
        // with the WASM engine's equivalent helper, which has no such field.
        let name_node = item
            .child_by_field_name("name")
            .or_else(|| find_child(&item, "identifier"));
        if let Some(name_node) = name_node {
            seed_dart_field_type_map_entry(
                symbols,
                class_name.as_deref(),
                node_text(&name_node, source),
                type_name,
            );
        }
    }
}

/// `this.field` constructor-shorthand parameter (`UserService(this._repo)`).
/// Normally needs no typeMap seeding of its own — the field's own
/// declaration (`handle_dart_field_decl_type_map`) already provides the
/// type, and the shorthand param only confirms initialization, not a new
/// type.
///
/// However, Dart's grammar permits an EXPLICIT inline type on a field-formal
/// parameter (`UserService(UserRepository this._repo)` — used e.g. to
/// narrow a covariant field's type at the constructor boundary; confirmed
/// parseable with tree-sitter-dart 0.2, producing a `type` node sibling
/// inside `constructor_param` that itself wraps `type_identifier`; #2319).
/// That IS a genuine explicit type annotation (not initializer-based
/// inference), and it's the ONLY source of type info when the field's own
/// declaration has none of its own (`var _repo;`) — so it gets the same
/// seeding treatment as a field declaration. `set_type_map_entry`'s
/// higher-confidence-wins merge makes this safe to call unconditionally
/// alongside the field declaration's own seeding. Mirrors
/// `handleDartConstructorParamTypeMap` in `src/extractors/dart.ts`.
fn handle_dart_constructor_param_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Unlike `declaration`'s `type:` field, tree-sitter-dart 0.2 does NOT
    // expose a named field for constructor_param's inline type (confirmed by
    // parsing `UserService(UserRepository this._repo)`, whose sexp shows
    // `(constructor_param (type (type_identifier)) (identifier))` with no
    // `type:` label) — a plain structural scan.
    let Some(type_node) = find_child(node, "type") else {
        return;
    };
    let Some(type_id) = find_child(&type_node, "type_identifier") else {
        return;
    };
    let Some(name_node) = find_child(node, "identifier") else {
        return;
    };
    let class_name = find_enclosing_dart_class_name(node, source);
    seed_dart_field_type_map_entry(
        symbols,
        class_name.as_deref(),
        node_text(&name_node, source),
        node_text(&type_id, source),
    );
}

fn handle_dart_selector(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // selector with argument_part represents a function call; mirrors handleDartSelector in dart.ts
    if find_child(node, "argument_part").is_none() {
        return;
    }
    let Some((method_name, receiver)) = resolve_dart_selector_call(node, source) else {
        return;
    };

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

    push_call(symbols, node, method_name, receiver, None);
}

/// Look for the identifier this selector belongs to, plus (for a genuine
/// `.method` access) its receiver, for typeMap-based call resolution
/// (#2319). Mirrors `resolveDartSelectorCall` in `src/extractors/dart.ts` —
/// see that function's doc comment for the three possible layouts (A/B/C)
/// this handles identically. Returns `(method_name, receiver)`; `receiver`
/// is `None` for a bare call (Layout C) or when the preceding token isn't a
/// plain identifier/type_identifier (a chained call's intermediate receiver
/// or a subscript-indexed receiver).
fn resolve_dart_selector_call(node: &Node, source: &[u8]) -> Option<(String, Option<String>)> {
    if let Some(unconditional) = find_child(node, "unconditional_assignable_selector") {
        let id = find_child(&unconditional, "identifier")?;
        let receiver = find_dart_selector_receiver(node, source);
        return Some((node_text(&id, source).to_string(), receiver));
    }

    let parent = node.parent()?;
    let mut prev_sibling: Option<Node> = None;
    for i in 0..parent.child_count() {
        if let Some(sibling) = parent.child(i) {
            if sibling.id() == node.id() {
                break;
            }
            prev_sibling = Some(sibling);
        }
    }
    let prev_sibling = prev_sibling?;

    if prev_sibling.kind() == "selector" {
        let unc2 = find_child(&prev_sibling, "unconditional_assignable_selector")?;
        let id2 = find_child(&unc2, "identifier")?;
        let receiver = find_dart_selector_receiver(&prev_sibling, source);
        return Some((node_text(&id2, source).to_string(), receiver));
    }

    if prev_sibling.kind() == "identifier" || prev_sibling.kind() == "type_identifier" {
        // Bare (keyword-less) call — the identifier IS the callee's own
        // name, not a receiver+method pair, so no receiver.
        return Some((node_text(&prev_sibling, source).to_string(), None));
    }

    None
}

/// Receiver for a `.method` access: the sibling immediately preceding the
/// selector node that itself carries the `.method` access
/// (`method_selector`), ONLY when that sibling is a plain
/// identifier/type_identifier — e.g. `_repo` in `_repo.findById(id)`.
/// Deliberately conservative, mirroring `findDartSelectorReceiver` in
/// `src/extractors/dart.ts` — see that function's doc comment for the
/// chained-call and subscript-indexed cases this intentionally leaves
/// unresolved rather than guessing, and for why a plain `identifier`
/// sibling is returned as `this.<name>` rather than the bare name (#2319
/// follow-up on PR #2477's Greptile finding: prevents same-named fields on
/// different classes in the same file from colliding on the resolver's bare
/// fallback key). A `type_identifier` sibling (a static-call receiver, e.g.
/// `MyClass.staticMethod()`) is left unprefixed — it never denotes a field
/// access.
///
/// NOTE: this function backs `handle_dart_selector`, which targets the
/// `selector`-based call shape tree-sitter-dart 0.0.4 (and older) produces.
/// The pinned crates.io grammar (0.2) instead represents every call as a
/// `call_expression` node (see `handle_dart_call_expression` below, which
/// duplicates this same `this.`-prefixing decision inline for that shape) —
/// kept mirrored here for parity should the pinned grammar ever regress to
/// (or a caller re-parses with) the older shape.
fn find_dart_selector_receiver(method_selector: &Node, source: &[u8]) -> Option<String> {
    let parent = method_selector.parent()?;
    let mut prev_sibling: Option<Node> = None;
    for i in 0..parent.child_count() {
        if let Some(sibling) = parent.child(i) {
            if sibling.id() == method_selector.id() {
                break;
            }
            prev_sibling = Some(sibling);
        }
    }
    let prev_sibling = prev_sibling?;
    match prev_sibling.kind() {
        "identifier" => Some(format!("this.{}", node_text(&prev_sibling, source))),
        "type_identifier" => Some(node_text(&prev_sibling, source).to_string()),
        _ => None,
    }
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
            let object = func.child_by_field_name("object");

            // Function.apply(fn, positionalArgs, namedArgs) — dynamic
            // higher-order dispatch, mirrors handle_dart_selector's own
            // Function.apply special case for the older grammar shape.
            if method_name == "apply" {
                if let Some(object) = &object {
                    if object.kind() == "identifier" && node_text(object, source) == "Function" {
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

            // Receiver for typeMap-based call resolution (#2319): the
            // `object` field, but ONLY when it's a plain identifier — e.g.
            // `_repo` in `_repo.findById(id)`. A chained call's intermediate
            // receiver (`obj.method1().method2()` — `method2`'s object is
            // `method1()`'s OWN call_expression, not a plain identifier)
            // yields no receiver, mirroring `handleDartSelector`'s identical
            // conservatism in `src/extractors/dart.ts`.
            //
            // Returned as `this.<name>`, NOT the bare name: this is the
            // ACTUAL live receiver-extraction path for the pinned crates.io
            // 0.2 grammar (unlike `find_dart_selector_receiver` above, which
            // only backs the older, currently-dead `selector`-based shape),
            // so the `this.`-prefixing fix for #2319's cross-class field
            // collision (see `seed_dart_field_type_map_entry`'s doc comment)
            // must live HERE for the native engine to actually benefit from
            // it. Mirrors `findDartSelectorReceiver` in `src/extractors/dart.ts`.
            let receiver = object.and_then(|obj| {
                if obj.kind() == "identifier" {
                    Some(format!("this.{}", node_text(&obj, source)))
                } else {
                    None
                }
            });

            push_call(symbols, node, method_name, receiver, None);
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

    // #2319: Dart never populated typeMap at all, so receiver-typed method
    // calls (`_repo.findById(id)`, where `_repo`'s type comes from a typed
    // field declaration or a `this.field` constructor-shorthand param) could
    // never resolve. Mirrors the `type_map_seeding` coverage in
    // `src/extractors/dart.ts`'s own test suite.
    mod type_map_seeding {
        use super::*;

        #[test]
        fn seeds_class_scoped_and_bare_keys_for_a_typed_final_field() {
            let s = parse_dart(
                "class UserService {\n  final UserRepository _repo;\n  UserService(this._repo);\n}",
            );
            let class_scoped = s.type_map.iter().find(|e| e.name == "UserService._repo");
            assert!(
                class_scoped.is_some(),
                "missing UserService._repo class-scoped key; got: {:?}",
                s.type_map
            );
            assert_eq!(class_scoped.unwrap().type_name, "UserRepository");
            assert_eq!(class_scoped.unwrap().confidence, 0.9);

            let bare = s.type_map.iter().find(|e| e.name == "_repo");
            assert!(bare.is_some(), "missing bare _repo fallback key");
            assert_eq!(bare.unwrap().type_name, "UserRepository");
            assert_eq!(bare.unwrap().confidence, 0.6);

            let this_prefixed = s.type_map.iter().find(|e| e.name == "this._repo");
            assert!(this_prefixed.is_some(), "missing this._repo fallback key");
            assert_eq!(this_prefixed.unwrap().confidence, 0.6);
        }

        #[test]
        fn seeds_a_non_final_field_declaration_the_same_way() {
            let s = parse_dart("class A {\n  UserRepository repo;\n}");
            let entry = s.type_map.iter().find(|e| e.name == "A.repo");
            assert!(entry.is_some(), "missing A.repo; got: {:?}", s.type_map);
            assert_eq!(entry.unwrap().type_name, "UserRepository");
        }

        #[test]
        fn seeds_a_late_field_declaration() {
            let s = parse_dart("class A {\n  late UserRepository _repo;\n}");
            let entry = s.type_map.iter().find(|e| e.name == "A._repo");
            assert!(entry.is_some(), "missing A._repo; got: {:?}", s.type_map);
            assert_eq!(entry.unwrap().type_name, "UserRepository");
        }

        #[test]
        fn strips_no_extra_characters_for_a_nullable_field_type() {
            let s = parse_dart("class A {\n  UserRepository? _repo;\n}");
            let entry = s.type_map.iter().find(|e| e.name == "A._repo");
            assert!(entry.is_some(), "missing A._repo; got: {:?}", s.type_map);
            assert_eq!(
                entry.unwrap().type_name,
                "UserRepository",
                "nullable `?` must not leak into the seeded type name"
            );
        }

        #[test]
        fn seeds_the_generic_base_type_for_a_generic_field() {
            let s = parse_dart("class A {\n  List<User>? users;\n}");
            let entry = s.type_map.iter().find(|e| e.name == "A.users");
            assert!(entry.is_some(), "missing A.users; got: {:?}", s.type_map);
            assert_eq!(entry.unwrap().type_name, "List");
        }

        #[test]
        fn seeds_every_identifier_in_a_comma_separated_multi_field_declaration() {
            let s = parse_dart("class A {\n  final Foo a, b;\n}");
            let a = s.type_map.iter().find(|e| e.name == "A.a");
            let b = s.type_map.iter().find(|e| e.name == "A.b");
            assert!(a.is_some(), "missing A.a; got: {:?}", s.type_map);
            assert!(b.is_some(), "missing A.b; got: {:?}", s.type_map);
            assert_eq!(a.unwrap().type_name, "Foo");
            assert_eq!(b.unwrap().type_name, "Foo");
        }

        #[test]
        fn does_not_seed_a_field_with_no_explicit_type() {
            // `var x = Foo();` has no explicit type annotation on the
            // declaration itself — inferring one from the initializer is a
            // separate, out-of-scope problem (#2319).
            let s = parse_dart("class A {\n  var x = Foo();\n}");
            assert!(
                s.type_map.iter().all(|e| e.name != "A.x" && e.name != "x"),
                "should not have seeded a typeMap entry for `var x = Foo();`; got: {:?}",
                s.type_map
            );
        }

        #[test]
        fn seeds_from_an_inline_typed_constructor_shorthand_param() {
            // `UserRepository this._repo` — an explicit inline type on a
            // field-formal parameter is a genuine type annotation (not
            // initializer inference), and here it's the ONLY source of type
            // info since the class declares no field for `_repo` at all.
            let s = parse_dart("class UserService {\n  UserService(UserRepository this._repo);\n}");
            let entry = s.type_map.iter().find(|e| e.name == "UserService._repo");
            assert!(
                entry.is_some(),
                "missing UserService._repo from inline-typed this-param; got: {:?}",
                s.type_map
            );
            assert_eq!(entry.unwrap().type_name, "UserRepository");
        }

        #[test]
        fn plain_this_shorthand_param_needs_no_separate_seeding_beyond_the_field() {
            // UserService(this._repo) with NO inline type carries no type
            // info of its own — the field declaration is the sole source.
            let s = parse_dart(
                "class UserService {\n  final UserRepository _repo;\n  UserService(this._repo);\n}",
            );
            let matches: Vec<_> = s
                .type_map
                .iter()
                .filter(|e| e.name == "UserService._repo")
                .collect();
            assert_eq!(
                matches.len(),
                1,
                "expected exactly one UserService._repo entry (from the field decl, deduped); got: {:?}",
                s.type_map
            );
            assert_eq!(matches[0].type_name, "UserRepository");
        }

        #[test]
        fn sets_receiver_on_a_bare_field_access_method_call() {
            let s = parse_dart(
                "class UserService {\n  final UserRepository _repo;\n  UserService(this._repo);\n  User? getUser(String id) {\n    return _repo.findById(id);\n  }\n}",
            );
            let call = s.calls.iter().find(|c| c.name == "findById");
            assert!(call.is_some(), "missing findById call; got: {:?}", s.calls);
            // Emitted as `this._repo`, not the bare `_repo` text Dart itself
            // uses at the call site — normalises the implicit-`this` field
            // access to the same shape JS/TS's explicit `this.field` already
            // uses, so the resolver's existing class-scoped-key-first lookup
            // applies to Dart too (#2319 follow-up on PR #2477's Greptile
            // finding: prevents cross-class same-named-field collisions).
            assert_eq!(call.unwrap().receiver.as_deref(), Some("this._repo"));
        }

        #[test]
        fn sets_receiver_on_a_local_variable_method_call() {
            let s = parse_dart("void f() {\n  var w = Foo();\n  w.doSomething();\n}");
            let call = s.calls.iter().find(|c| c.name == "doSomething");
            assert!(
                call.is_some(),
                "missing doSomething call; got: {:?}",
                s.calls
            );
            // Also `this.`-prefixed even though `w` is a local, not a field:
            // the extractor cannot tell the two apart from a bare identifier
            // alone, and prefixing is harmless here — the class-scoped
            // lookup it enables just finds no entry for a non-field name and
            // falls through to the same bare-key lookup as before.
            assert_eq!(call.unwrap().receiver.as_deref(), Some("this.w"));
        }

        #[test]
        fn does_not_attribute_a_receiver_to_the_second_call_in_a_chain() {
            let s = parse_dart("void f() {\n  obj.method1().method2();\n}");
            let m1 = s.calls.iter().find(|c| c.name == "method1").unwrap();
            let m2 = s.calls.iter().find(|c| c.name == "method2").unwrap();
            assert_eq!(m1.receiver.as_deref(), Some("this.obj"));
            assert_eq!(
                m2.receiver, None,
                "method2's receiver is method1()'s return value, not a plain identifier — must not guess `obj`"
            );
        }

        #[test]
        fn bare_call_has_no_receiver() {
            let s = parse_dart("void f() {\n  helper();\n}");
            let call = s.calls.iter().find(|c| c.name == "helper").unwrap();
            assert_eq!(call.receiver, None);
        }
    }
}
