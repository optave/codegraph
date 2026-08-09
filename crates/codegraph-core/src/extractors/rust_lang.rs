use super::helpers::*;
use super::SymbolExtractor;
use crate::ast_analysis::cfg::build_function_cfg;
use crate::ast_analysis::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

pub struct RustExtractor;

impl SymbolExtractor for RustExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_rust_node);
        walk_ast_nodes_with_config(
            &tree.root_node(),
            source,
            &mut symbols.ast_nodes,
            &RUST_AST_CONFIG,
        );
        walk_tree(&tree.root_node(), source, &mut symbols, match_rust_type_map);
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            match_rust_return_type_map,
        );
        // Must run after type_map is populated — resolves `receiver.method()` call
        // assignments against locally-typed receivers (mirrors javascript.rs's ordering).
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            match_rust_call_assignments,
        );
        dedup_type_map(&mut symbols.type_map);
        dedup_type_map(&mut symbols.return_type_map);
        symbols
    }
}

fn find_current_impl<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "impl_item" {
            return named_child_text(&parent, "type", source).map(|s| s.to_string());
        }
        current = parent.parent();
    }
    None
}

fn match_rust_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_item" => handle_function_item(node, source, symbols),
        "struct_item" => handle_struct_item(node, source, symbols),
        "enum_item" => handle_enum_item(node, source, symbols),
        "const_item" => handle_const_item(node, source, symbols),
        "trait_item" => handle_trait_item(node, source, symbols),
        "impl_item" => handle_impl_item(node, source, symbols),
        "use_declaration" => handle_use_decl(node, source, symbols),
        "call_expression" => handle_call_expr(node, source, symbols),
        "macro_invocation" => handle_macro_invocation(node, source, symbols),
        _ => {}
    }
}

// ── Per-node-kind handlers for walk_node_depth ───────────────────────────────

fn handle_function_item(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Skip default-impl functions inside traits — already emitted by trait_item handler
    if node
        .parent()
        .and_then(|p| p.parent())
        .map_or(false, |gp| gp.kind() == "trait_item")
    {
        return;
    }
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let name = node_text(&name_node, source);
    let impl_type = find_current_impl(node, source);
    let (full_name, kind) = match &impl_type {
        Some(t) => (format!("{}.{}", t, name), "method".to_string()),
        None => (name.to_string(), "function".to_string()),
    };
    let children = extract_rust_parameters(node, source);
    symbols.definitions.push(Definition {
        name: full_name,
        kind,
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "rust"),
        cfg: build_function_cfg(node, "rust", source),
        children: opt_children(children),
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

fn handle_struct_item(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let struct_name = node_text(&name_node, source).to_string();
        let children = extract_rust_struct_fields(node, source);
        symbols.definitions.push(Definition {
            name: struct_name.clone(),
            kind: "struct".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: opt_children(children),
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
        seed_rust_struct_field_types(node, &struct_name, source, symbols);
    }
}

/// Seed `${StructName}.${fieldName}` → field-type entries in `symbols.type_map`
/// so `self.field.method()` inside the struct's own impl methods resolves via
/// the class-scoped receiver lookup — mirrors JS's `this.field` class-scoped
/// typing (issues #1323, #1458) and fixes #1876's `self.field` false negatives.
fn seed_rust_struct_field_types(
    node: &Node,
    struct_name: &str,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    let Some(body) = node.child_by_field_name("body") else {
        return;
    };
    for i in 0..body.child_count() {
        let Some(field) = body.child(i) else { continue };
        if field.kind() != "field_declaration" {
            continue;
        }
        let Some(field_name) = field.child_by_field_name("name") else {
            continue;
        };
        let Some(type_node) = field.child_by_field_name("type") else {
            continue;
        };
        let Some(type_name) = extract_rust_type_name(&type_node, source) else {
            continue;
        };
        push_type_map_entry(
            symbols,
            format!("{}.{}", struct_name, node_text(&field_name, source)),
            type_name,
        );
    }
}

fn handle_enum_item(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let children = extract_rust_enum_variants(node, source);
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "enum".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: opt_children(children),
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }
}

fn handle_const_item(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "constant".to_string(),
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

fn handle_trait_item(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let trait_name = node_text(&name_node, source).to_string();
    symbols.definitions.push(Definition {
        name: trait_name.clone(),
        kind: "trait".to_string(),
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
    if let Some(body) = node.child_by_field_name("body") {
        for i in 0..body.child_count() {
            let Some(child) = body.child(i) else { continue };
            if child.kind() != "function_signature_item" && child.kind() != "function_item" {
                continue;
            }
            if let Some(meth_name) = child.child_by_field_name("name") {
                // function_signature_item is a required trait method with no
                // default implementation (no body) — skip CFG and complexity
                // to mirror the WASM extractor and avoid fabricating a
                // trivial-but-meaningless complexity entry for a function
                // with no body. function_item (default impl) still gets full
                // metrics.
                let is_bodyless = child.kind() == "function_signature_item";
                symbols.definitions.push(Definition {
                    name: format!("{}.{}", trait_name, node_text(&meth_name, source)),
                    kind: "method".to_string(),
                    line: start_line(&child),
                    end_line: Some(end_line(&child)),
                    decorators: None,
                    complexity: if is_bodyless {
                        None
                    } else {
                        compute_all_metrics(&child, source, "rust")
                    },
                    cfg: if is_bodyless {
                        None
                    } else {
                        build_function_cfg(&child, "rust", source)
                    },
                    children: None,
                    bodyless: Some(is_bodyless),
                    content_hash: None,
                    accessor_kind: None,
                });
            }
        }
    }
}

fn handle_impl_item(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let type_node = node.child_by_field_name("type");
    let trait_node = node.child_by_field_name("trait");
    if let (Some(type_node), Some(trait_node)) = (type_node, trait_node) {
        symbols.classes.push(ClassRelation {
            name: node_text(&type_node, source).to_string(),
            extends: None,
            implements: Some(node_text(&trait_node, source).to_string()),
            line: start_line(node),
        });
    }
}

fn handle_use_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(arg_node) = node.child(1) {
        let use_paths = extract_rust_use_path(&arg_node, source);
        for (src, names) in use_paths {
            let mut imp = Import::new(src, names, start_line(node));
            imp.rust_use = Some(true);
            symbols.imports.push(imp);
        }
    }
}

fn handle_call_expr(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(fn_node) = node.child_by_field_name("function") else {
        return;
    };
    match fn_node.kind() {
        "identifier" => {
            symbols.calls.push(Call {
                name: node_text(&fn_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
                ..Default::default()
            });
        }
        "field_expression" => {
            if let Some(field) = fn_node.child_by_field_name("field") {
                let receiver = named_child_text(&fn_node, "value", source).map(|s| s.to_string());
                symbols.calls.push(Call {
                    name: node_text(&field, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver,
                    ..Default::default()
                });
            }
        }
        "scoped_identifier" => {
            if let Some(name) = fn_node.child_by_field_name("name") {
                let receiver = named_child_text(&fn_node, "path", source).map(|s| s.to_string());
                symbols.calls.push(Call {
                    name: node_text(&name, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver,
                    ..Default::default()
                });
            }
        }
        _ => {}
    }
}

fn handle_macro_invocation(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(macro_node) = node.child(0) {
        symbols.calls.push(Call {
            name: format!("{}!", node_text(&macro_node, source)),
            line: start_line(node),
            dynamic: None,
            receiver: None,
            ..Default::default()
        });
    }
    // Macro arguments (`println!("{}", user.display_name())`) are an opaque
    // `token_tree` to tree-sitter-rust — macros can have arbitrary token syntax, so
    // the grammar never parses their contents into call_expression/field_expression
    // nodes the way it does everywhere else. walk_tree's generic recursion still
    // visits every token inside, but none of them match `call_expression`, so a real
    // call embedded in a macro argument (the common `println!`/`format!`/`write!`/
    // `assert!` case) was silently invisible to call-edge resolution. Scan the flat
    // token sequence directly for the two call shapes tree-sitter still tokenizes
    // recognizably — bare `ident(...)` and single-hop method `ident.ident(...)` — and
    // record them the same way handle_call_expr would. Mirrors
    // `scanMacroTokensForCalls` in `src/extractors/rust.ts` (#2214).
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "token_tree" {
                scan_macro_tokens_for_calls(&child, source, symbols);
            }
        }
    }
}

fn scan_macro_tokens_for_calls(token_tree: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Index directly via `child(i)` rather than collecting into a `Vec` first —
    // every macro invocation in the file pays this cost (println!/format!/
    // assert_eq!/vec! are everywhere in real Rust code), so an allocation per
    // invocation was a measurable regression on the build-performance
    // benchmark (Pre-publish benchmark gate, PR #2371).
    let count = token_tree.child_count();
    let mut i = 0;
    while i < count {
        let Some(c) = token_tree.child(i) else {
            i += 1;
            continue;
        };
        if c.kind() == "token_tree" {
            scan_macro_tokens_for_calls(&c, source, symbols);
            i += 1;
            continue;
        }
        if c.kind() != "identifier" {
            i += 1;
            continue;
        }

        // `receiver . method ( ... )` — single-hop method call.
        if let (Some(dot), Some(method_name), Some(args_after_method)) = (
            token_tree.child(i + 1),
            token_tree.child(i + 2),
            token_tree.child(i + 3),
        ) {
            if dot.kind() == "."
                && method_name.kind() == "identifier"
                && args_after_method.kind() == "token_tree"
                && node_text(&args_after_method, source).starts_with('(')
            {
                symbols.calls.push(Call {
                    name: node_text(&method_name, source).to_string(),
                    line: start_line(&method_name),
                    receiver: Some(node_text(&c, source).to_string()),
                    ..Default::default()
                });
                i += 4;
                continue;
            }
        }

        // Bare `name ( ... )` — free-function call.
        if let Some(args_after_bare) = token_tree.child(i + 1) {
            if args_after_bare.kind() == "token_tree"
                && node_text(&args_after_bare, source).starts_with('(')
            {
                symbols.calls.push(Call {
                    name: node_text(&c, source).to_string(),
                    line: start_line(&c),
                    ..Default::default()
                });
                i += 2;
                continue;
            }
        }
        i += 1;
    }
}

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_rust_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters");
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                if child.kind() == "parameter" {
                    if let Some(pattern) = child.child_by_field_name("pattern") {
                        let name = node_text(&pattern, source);
                        // Skip self parameters
                        if name == "self"
                            || name == "&self"
                            || name == "&mut self"
                            || name == "mut self"
                        {
                            continue;
                        }
                        params.push(child_def(name.to_string(), "parameter", start_line(&child)));
                    }
                } else if child.kind() == "self_parameter" {
                    // Skip self
                    continue;
                }
            }
        }
    }
    params
}

fn extract_rust_struct_fields(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    let body = node
        .child_by_field_name("body")
        .or_else(|| find_child(node, "field_declaration_list"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "field_declaration" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        fields.push(child_def(
                            node_text(&name_node, source).to_string(),
                            "property",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    fields
}

fn extract_rust_enum_variants(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut variants = Vec::new();
    let body = node
        .child_by_field_name("body")
        .or_else(|| find_child(node, "enum_variant_list"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_variant" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        variants.push(child_def(
                            node_text(&name_node, source).to_string(),
                            "constant",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    variants
}

// ── Existing helpers ────────────────────────────────────────────────────────

fn extract_rust_use_path(node: &Node, source: &[u8]) -> Vec<(String, Vec<String>)> {
    match node.kind() {
        "use_list" => {
            let mut results = Vec::new();
            for i in 0..node.child_count() {
                let Some(child) = node.child(i) else { continue };
                results.extend(extract_rust_use_path(&child, source));
            }
            results
        }
        "scoped_use_list" => extract_scoped_use_list(node, source),
        "use_as_clause" => {
            let name = node
                .child_by_field_name("alias")
                .or_else(|| node.child_by_field_name("name"))
                .map(|n| node_text(&n, source).to_string());
            vec![(
                node_text(node, source).to_string(),
                name.into_iter().collect(),
            )]
        }
        "use_wildcard" => {
            let src = named_child_text(&node, "path", source)
                .map(|s| s.to_string())
                .unwrap_or_else(|| "*".to_string());
            vec![(src, vec!["*".to_string()])]
        }
        "scoped_identifier" | "identifier" => {
            let text = node_text(node, source).to_string();
            let last_name = text.split("::").last().unwrap_or("").to_string();
            vec![(text, vec![last_name])]
        }
        _ => vec![],
    }
}

fn extract_scoped_use_list(node: &Node, source: &[u8]) -> Vec<(String, Vec<String>)> {
    let prefix = named_child_text(&node, "path", source)
        .map(|s| s.to_string())
        .unwrap_or_default();
    let Some(list_node) = node.child_by_field_name("list") else {
        return vec![(prefix, vec![])];
    };
    let mut names = Vec::new();
    for i in 0..list_node.child_count() {
        let Some(child) = list_node.child(i) else {
            continue;
        };
        match child.kind() {
            "identifier" | "self" => {
                names.push(node_text(&child, source).to_string());
            }
            "use_as_clause" => {
                let name = child
                    .child_by_field_name("alias")
                    .or_else(|| child.child_by_field_name("name"))
                    .map(|n| node_text(&n, source).to_string());
                if let Some(name) = name {
                    names.push(name);
                }
            }
            _ => {}
        }
    }
    vec![(prefix, names)]
}

/// True if `name` matches a struct defined in this file (match_rust_node runs before this).
fn is_known_unit_struct(name: &str, symbols: &FileSymbols) -> bool {
    symbols
        .definitions
        .iter()
        .any(|d| d.kind == "struct" && d.name == name)
}

/// True when `base` names `Option`/`Result`, bare (`Option`) or fully qualified
/// (`std::option::Option`, `core::result::Result`) — both spellings are valid
/// Rust and equally common in a `-> ReturnType` position. Mirrors
/// `isOptionOrResultBase` in `src/extractors/rust.ts` and is checked identically
/// at unwrap time by `unwrap_option_result_type` in `pipeline.rs` (#2214, Greptile
/// review on PR #2371 — a qualified spelling was silently treated as an unrelated
/// generic, dropping the type argument a Some(x)/Ok(x) binding needs).
pub(crate) fn is_option_or_result_base(base: &str) -> bool {
    base == "Option" || base == "Result" || base.ends_with("::Option") || base.ends_with("::Result")
}

fn extract_rust_type_name<'a>(type_node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    match type_node.kind() {
        "type_identifier" | "identifier" | "scoped_type_identifier" => {
            Some(node_text(type_node, source))
        }
        // Reference: &MyType, &mut MyType, &Option<User> → recurse on the referent
        // via the `type` field (ignoring lifetime/mut modifiers, which aren't part
        // of it) rather than hand-matching type_identifier/scoped_type_identifier —
        // a referent that's itself generic (`&Option<User>`) previously matched
        // neither arm of the old child-loop and silently returned None, dropping
        // the return type before the Option/Result unwrap logic ever saw it
        // (Greptile review, PR #2371).
        "reference_type" => {
            let referent = type_node.child_by_field_name("type")?;
            extract_rust_type_name(&referent, source)
        }
        // For every OTHER generic type (Vec<T>, HashMap<K, V>, a user-defined
        // Container<T>, ...), keep the original nominal-base-name behavior — impl
        // blocks' own qualified names use the source-literal generic syntax too
        // (`impl<T> Container<T>` extracts as "Container<T>", not "Container"), so
        // a concretely-instantiated receiver ("Container<User>") could never match
        // it either way; but CHA/RTA's instantiated-types matching (buildChaContext
        // in cha.ts / build_cha_context) DOES compare bare type_map entries against
        // trait-implementor names, so keeping other generics parameterized here
        // would silently break that unrelated, currently-working nominal match
        // (Greptile review, PR #2371). Option/Result are the only shapes this fix
        // actually needs full text for — a Some(x)/Ok(x) if-let/while-let binding's
        // real type is the type ARGUMENT, not the wrapper, and unwrap_option_result_type()
        // below needs that argument text to compute it.
        "generic_type" => {
            let text = node_text(type_node, source);
            let base = text.split('<').next().unwrap_or(text).trim();
            if is_option_or_result_base(base) {
                Some(text)
            } else {
                Some(base)
            }
        }
        _ => None,
    }
}

/// Unwrap a single-argument `Some(x)`/`Ok(x)` tuple-struct pattern to its inner
/// `x` pattern, so `if let Some(x) = expr`/`if let Ok(x) = expr` (and the
/// `while let`/`let-else` equivalents) can be treated as a call-assignment
/// binding `x`, the same way `let x = expr;` already is. Returns `pattern`
/// unchanged for any other shape (a bare identifier, `None`, `Err(_)`, or any
/// other variant this isn't confident unwrapping).
/// Unwrap zero or more layers of `Some(...)`/`Ok(...)` wrapping — e.g.
/// `Some(Some(user))` for a `Option<Option<User>>`-returning call, not just
/// one layer — returning the innermost non-Some/Ok pattern and how many
/// layers were stripped. The caller unwraps the callee's declared return type
/// the same number of times (#2214, Greptile review on PR #2371 — a single
/// unwrap left a doubly-nested pattern's binding untyped entirely, since
/// `Some(Some(x))`'s inner pattern is itself a `tuple_struct_pattern`, not an
/// `identifier`, and the original single-pass version gave up on it).
fn unwrap_option_result_pattern<'a>(pattern: Node<'a>, source: &[u8]) -> (Node<'a>, u32) {
    let mut current = pattern;
    let mut depth = 0u32;
    loop {
        if current.kind() != "tuple_struct_pattern" {
            return (current, depth);
        }
        let Some(type_node) = current.child_by_field_name("type") else {
            return (current, depth);
        };
        let variant = node_text(&type_node, source);
        if variant != "Some" && variant != "Ok" {
            return (current, depth);
        }
        let mut cursor = current.walk();
        let inner = current
            .named_children(&mut cursor)
            .find(|c| c.id() != type_node.id());
        match inner {
            Some(next) => {
                current = next;
                depth += 1;
            }
            None => return (current, depth),
        }
    }
}

fn match_rust_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "let_declaration" => {
            if let Some(pattern) = node.child_by_field_name("pattern") {
                if pattern.kind() == "identifier" {
                    if let Some(type_node) = node.child_by_field_name("type") {
                        if let Some(type_name) = extract_rust_type_name(&type_node, source) {
                            symbols.type_map.push(TypeMapEntry {
                                name: node_text(&pattern, source).to_string(),
                                type_name: type_name.to_string(),
                                confidence: 0.9,
                            });
                        }
                    } else if let Some(value_node) = node.child_by_field_name("value") {
                        // let x = TypeName;  — a bare capitalized identifier value binds
                        // a unit-struct instance (e.g. `let v = NameValidator;` for
                        // `struct NameValidator;`), not a reference to another variable (#1876).
                        // Requiring a same-file `struct` definition excludes unit enum variants
                        // like `None`/`Ok` (Option/Result, always in scope) and any custom
                        // fieldless variant brought into scope via `use Enum::Variant` — those
                        // also parse as a bare capitalized identifier but are values, not types
                        // (Greptile review). A struct defined elsewhere in the crate is missed,
                        // same as every other same-file-only heuristic in this extractor.
                        if value_node.kind() == "identifier" {
                            let type_name = node_text(&value_node, source);
                            if type_name.starts_with(|c: char| c.is_uppercase())
                                && is_known_unit_struct(type_name, symbols)
                            {
                                symbols.type_map.push(TypeMapEntry {
                                    name: node_text(&pattern, source).to_string(),
                                    type_name: type_name.to_string(),
                                    confidence: 0.7,
                                });
                            }
                        }
                    }
                }
            }
        }
        "parameter" => {
            if let Some(pattern) = node.child_by_field_name("pattern") {
                if pattern.kind() == "identifier" {
                    let name = node_text(&pattern, source);
                    if name != "self"
                        && name != "&self"
                        && name != "&mut self"
                        && name != "mut self"
                    {
                        if let Some(type_node) = node.child_by_field_name("type") {
                            if let Some(type_name) = extract_rust_type_name(&type_node, source) {
                                symbols.type_map.push(TypeMapEntry {
                                    name: name.to_string(),
                                    type_name: type_name.to_string(),
                                    confidence: 0.9,
                                });
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

// ── Return-type map extraction (Phase 8.2 parity, #1876) ────────────────────

/// Populate `symbols.return_type_map` with declared `-> ReturnType` return
/// types for free functions and impl methods, resolving `Self` to the
/// enclosing impl's type name. Mirrors `extractRustReturnTypeMap` in
/// `src/extractors/rust.ts`. Consumed by `propagate_return_types_across_files`
/// (Phase 8.2) — the same generic cross-file mechanism the JS/TS extractor
/// feeds — so a local var typed from a cross-file call's return value
/// (`let service = build_service();`) resolves without any Rust-specific
/// propagation logic.
fn match_rust_return_type_map(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    _depth: usize,
) {
    if node.kind() != "function_item" {
        return;
    }
    // Skip default-impl functions inside traits, matching handle_function_item —
    // their return type is not tied to a concrete implementing type.
    if node
        .parent()
        .and_then(|p| p.parent())
        .map_or(false, |gp| gp.kind() == "trait_item")
    {
        return;
    }
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let Some(return_type_node) = node.child_by_field_name("return_type") else {
        return;
    };
    let Some(raw_type) = extract_rust_type_name(&return_type_node, source) else {
        return;
    };
    let impl_type = find_current_impl(node, source);
    // `-> Self` inside an impl block returns the concrete implementing type.
    let type_name = if raw_type == "Self" {
        impl_type.as_deref().unwrap_or(raw_type)
    } else {
        raw_type
    };
    let full_name = match &impl_type {
        Some(t) => format!("{}.{}", t, node_text(&name_node, source)),
        None => node_text(&name_node, source).to_string(),
    };
    let existing_confidence = symbols
        .return_type_map
        .iter()
        .find(|e| e.name == full_name)
        .map(|e| e.confidence);
    if existing_confidence.map_or(true, |c| c < 1.0) {
        symbols.return_type_map.push(TypeMapEntry {
            name: full_name,
            type_name: type_name.to_string(),
            confidence: 1.0,
        });
    }
}

// ── Call-assignment extraction (Phase 8.2 parity, #1876) ─────────────────────

/// Record `let x = callee(...);` bindings into `symbols.call_assignments` so
/// `propagate_return_types_across_files` can type `x` from `callee`'s
/// declared return type. Mirrors `extractRustCallAssignments` in
/// `src/extractors/rust.ts` — see that function's doc comment for the three
/// call shapes handled (bare function call, `Type::assoc_fn()`, and method
/// call on a locally-typed receiver).
fn match_rust_call_assignments(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    _depth: usize,
) {
    // `let_declaration` covers `let x = expr;` (and `let Some(x) = expr else {...};`
    // let-else); `let_condition` is the `if let`/`while let` condition node (#2214) —
    // both have `pattern`/`value` fields shaped identically.
    if node.kind() != "let_declaration" && node.kind() != "let_condition" {
        return;
    }
    let Some(pattern) = node.child_by_field_name("pattern") else {
        return;
    };
    let (unwrapped_pattern, unwrap_depth) = unwrap_option_result_pattern(pattern, source);
    if unwrapped_pattern.kind() != "identifier" {
        return;
    }
    // A bare fieldless-variant/unit-struct pattern (`if let None = expr`, `if let
    // NameValidator = expr`) is syntactically identical to a variable binding —
    // tree-sitter has no way to distinguish them by grammar alone. By Rust
    // convention a real binding is snake_case, so an uppercase-leading name is a
    // pattern match against a value, not a new variable — recording it as one
    // would fabricate a call-assignment for a variable that doesn't exist (#2214).
    if node_text(&unwrapped_pattern, source)
        .chars()
        .next()
        .is_some_and(|c| c.is_uppercase())
    {
        return;
    }
    let Some(value) = node.child_by_field_name("value") else {
        return;
    };
    if value.kind() != "call_expression" {
        return;
    }
    let Some(fn_node) = value.child_by_field_name("function") else {
        return;
    };
    let var_name = node_text(&unwrapped_pattern, source).to_string();

    match fn_node.kind() {
        "identifier" => {
            symbols.call_assignments.push(NativeCallAssignment {
                var_name,
                callee_name: node_text(&fn_node, source).to_string(),
                receiver_type_name: None,
                receiver_var_name: None,
                unwrap_depth,
            });
        }
        "scoped_identifier" => {
            let name = fn_node.child_by_field_name("name");
            let path = fn_node.child_by_field_name("path");
            if let (Some(name), Some(path)) = (name, path) {
                symbols.call_assignments.push(NativeCallAssignment {
                    var_name,
                    callee_name: node_text(&name, source).to_string(),
                    receiver_type_name: Some(node_text(&path, source).to_string()),
                    receiver_var_name: None,
                    unwrap_depth,
                });
            }
        }
        "field_expression" => {
            let field = fn_node.child_by_field_name("field");
            let receiver = fn_node.child_by_field_name("value");
            if let (Some(field), Some(receiver)) = (field, receiver) {
                if receiver.kind() == "identifier" {
                    let receiver_name = node_text(&receiver, source).to_string();
                    let receiver_type = symbols
                        .type_map
                        .iter()
                        .find(|e| e.name == receiver_name)
                        .map(|e| e.type_name.clone());
                    // Preserve the raw receiver identifier even when its type isn't
                    // known yet at extraction time (e.g. `service` in
                    // `service.get_user(1)`, whose type only becomes known via
                    // cross-file return-type propagation) so injection can retry
                    // resolution once the receiver's own call-assignment has itself
                    // been injected earlier in the same pass (#2214).
                    let receiver_var_name = if receiver_type.is_none() {
                        Some(receiver_name)
                    } else {
                        None
                    };
                    symbols.call_assignments.push(NativeCallAssignment {
                        var_name,
                        callee_name: node_text(&field, source).to_string(),
                        receiver_type_name: receiver_type,
                        receiver_var_name,
                        unwrap_depth,
                    });
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_rust(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_rust::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        RustExtractor.extract(&tree, code.as_bytes(), "test.rs")
    }

    // ── Extended kinds tests ────────────────────────────────────────────────

    #[test]
    fn extracts_function_parameters() {
        let s = parse_rust("fn add(a: i32, b: i32) -> i32 { a + b }");
        let add = s.definitions.iter().find(|d| d.name == "add").unwrap();
        let children = add.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "a");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "b");
    }

    /// Regression test for #1922: a trait's required method (`function_signature_item`,
    /// no default implementation) has no body and must be marked `bodyless`; a
    /// default-implemented trait method (`function_item`, has a body) must not be.
    #[test]
    fn trait_required_method_is_bodyless_default_method_is_not() {
        let s = parse_rust(
            "trait Repo {\n\
               fn save(&mut self, id: &str, value: i32) -> bool;\n\
               fn find(&self, id: &str) -> Option<i32> {\n\
                 if id.is_empty() { return None; }\n\
                 None\n\
               }\n\
             }\n",
        );
        let save = s
            .definitions
            .iter()
            .find(|d| d.name == "Repo.save")
            .unwrap();
        assert_eq!(save.bodyless, Some(true));

        let find = s
            .definitions
            .iter()
            .find(|d| d.name == "Repo.find")
            .unwrap();
        assert_ne!(find.bodyless, Some(true));
    }

    /// Regression test for #2053: a bodyless trait method must not get a
    /// fabricated complexity/CFG entry (WASM produces none for it, since
    /// `function_signature_item` is excluded from `functionNodes`); a
    /// default-implemented trait method must still get real metrics.
    #[test]
    fn trait_required_method_has_no_complexity_default_method_does() {
        let s = parse_rust(
            "trait Repo {\n\
               fn save(&mut self, id: &str, value: i32) -> bool;\n\
               fn find(&self, id: &str) -> Option<i32> {\n\
                 if id.is_empty() { return None; }\n\
                 for i in 0..3 { if i == 1 { return Some(i); } }\n\
                 None\n\
               }\n\
             }\n",
        );
        let save = s
            .definitions
            .iter()
            .find(|d| d.name == "Repo.save")
            .unwrap();
        assert!(save.complexity.is_none());
        assert!(save.cfg.is_none());

        let find = s
            .definitions
            .iter()
            .find(|d| d.name == "Repo.find")
            .unwrap();
        assert!(find.complexity.is_some());
        assert!(find.cfg.is_some());
    }

    #[test]
    fn extracts_struct_fields() {
        let s = parse_rust("struct User { name: String, age: u32 }");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "name");
        assert_eq!(children[0].kind, "property");
        assert_eq!(children[1].name, "age");
    }

    #[test]
    fn extracts_const_item() {
        let s = parse_rust("const MAX: i32 = 100;");
        let c = s.definitions.iter().find(|d| d.name == "MAX").unwrap();
        assert_eq!(c.kind, "constant");
    }

    #[test]
    fn extracts_enum_variants() {
        let s = parse_rust("enum Color { Red, Green, Blue }");
        let color = s.definitions.iter().find(|d| d.name == "Color").unwrap();
        let children = color.children.as_ref().unwrap();
        assert_eq!(children.len(), 3);
        assert_eq!(children[0].name, "Red");
        assert_eq!(children[0].kind, "constant");
        assert_eq!(children[1].name, "Green");
        assert_eq!(children[2].name, "Blue");
    }

    #[test]
    fn skips_self_parameter() {
        let s = parse_rust("struct Foo {}\nimpl Foo {\n  fn bar(&self, x: i32) {}\n}");
        let bar = s.definitions.iter().find(|d| d.name == "Foo.bar").unwrap();
        let children = bar.children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "x");
    }

    // ── #1876: receiver-typed locals + self.field type map ──────────────────

    #[test]
    fn seeds_struct_field_type_map() {
        let s = parse_rust("struct UserService { repo: UserRepository }");
        let entry = s
            .type_map
            .iter()
            .find(|e| e.name == "UserService.repo")
            .unwrap();
        assert_eq!(entry.type_name, "UserRepository");
    }

    #[test]
    fn seeds_unit_struct_value_type_map() {
        let s = parse_rust("struct NameValidator;\nfn f() { let v = NameValidator; }");
        let entry = s.type_map.iter().find(|e| e.name == "v").unwrap();
        assert_eq!(entry.type_name, "NameValidator");
    }

    #[test]
    fn does_not_type_unit_enum_variant_as_unit_struct() {
        // `None` (Option::None) parses identically to a unit-struct reference — a bare
        // capitalized identifier — but is an enum variant, not a struct. Without a same-file
        // `struct` definition for the name, it must not be typed (#1876 review).
        let s = parse_rust("fn f() { let x = None; }");
        assert!(s.type_map.iter().all(|e| e.name != "x"));
    }

    #[test]
    fn does_not_type_lowercase_bare_identifier_binding() {
        let s = parse_rust("fn f() { let a = 1; let b = a; }");
        assert!(s.type_map.iter().all(|e| e.name != "b"));
    }

    #[test]
    fn stores_return_type_for_free_function() {
        let s = parse_rust("fn build_service() -> UserService { todo!() }");
        let entry = s
            .return_type_map
            .iter()
            .find(|e| e.name == "build_service")
            .unwrap();
        assert_eq!(entry.type_name, "UserService");
        assert_eq!(entry.confidence, 1.0);
    }

    #[test]
    fn resolves_self_return_type_to_impl_type() {
        let s = parse_rust("struct UserRepository;\nimpl UserRepository {\n  fn new() -> Self { UserRepository }\n}");
        let entry = s
            .return_type_map
            .iter()
            .find(|e| e.name == "UserRepository.new")
            .unwrap();
        assert_eq!(entry.type_name, "UserRepository");
    }

    #[test]
    fn records_call_assignment_for_bare_function_call() {
        let s = parse_rust("fn f() { let service = build_service(); }");
        let ca = s
            .call_assignments
            .iter()
            .find(|c| c.var_name == "service")
            .unwrap();
        assert_eq!(ca.callee_name, "build_service");
        assert_eq!(ca.receiver_type_name, None);
    }

    #[test]
    fn records_call_assignment_for_associated_function_call() {
        let s = parse_rust("fn f() { let repo = UserRepository::new(); }");
        let ca = s
            .call_assignments
            .iter()
            .find(|c| c.var_name == "repo")
            .unwrap();
        assert_eq!(ca.callee_name, "new");
        assert_eq!(ca.receiver_type_name.as_deref(), Some("UserRepository"));
    }

    #[test]
    fn records_call_assignment_for_method_call_on_typed_receiver() {
        let s = parse_rust(
            "fn f() {\n  let repo: UserRepository = make();\n  let user = repo.find_by_id(1);\n}",
        );
        let ca = s
            .call_assignments
            .iter()
            .find(|c| c.var_name == "user")
            .unwrap();
        assert_eq!(ca.callee_name, "find_by_id");
        assert_eq!(ca.receiver_type_name.as_deref(), Some("UserRepository"));
    }

    // ── if-let/while-let pattern-binding call assignments (#2214) ────────────

    #[test]
    fn records_call_assignment_for_if_let_some_bound_method_call() {
        let s = parse_rust(
            "fn f() {\n  let service = build_service();\n  if let Some(user) = service.get_user(1) {}\n}",
        );
        let ca = s
            .call_assignments
            .iter()
            .find(|c| c.var_name == "user")
            .unwrap();
        assert_eq!(ca.callee_name, "get_user");
        // `service`'s type isn't known at extraction time (it only becomes known
        // via cross-file return-type propagation), so resolution defers to the
        // raw receiver name rather than a resolved type.
        assert_eq!(ca.receiver_type_name, None);
        assert_eq!(ca.receiver_var_name.as_deref(), Some("service"));
        assert_eq!(ca.unwrap_depth, 1);
    }

    #[test]
    fn records_call_assignment_for_if_let_ok_bound_bare_call() {
        let s = parse_rust("fn f() {\n  if let Ok(user) = build_user() {}\n}");
        let ca = s
            .call_assignments
            .iter()
            .find(|c| c.var_name == "user")
            .unwrap();
        assert_eq!(ca.callee_name, "build_user");
        assert_eq!(ca.unwrap_depth, 1);
    }

    #[test]
    fn while_let_some_bound_call_assignment_is_also_unwrapped() {
        let s = parse_rust("fn f() {\n  while let Some(item) = next_item() {}\n}");
        let ca = s
            .call_assignments
            .iter()
            .find(|c| c.var_name == "item")
            .unwrap();
        assert_eq!(ca.callee_name, "next_item");
        assert_eq!(ca.unwrap_depth, 1);
    }

    #[test]
    fn plain_let_binding_is_not_marked_as_unwrapped() {
        let s = parse_rust("fn f() {\n  let service = build_service();\n}");
        let ca = s
            .call_assignments
            .iter()
            .find(|c| c.var_name == "service")
            .unwrap();
        assert_eq!(ca.unwrap_depth, 0);
    }

    #[test]
    fn does_not_treat_none_or_err_pattern_as_a_call_assignment() {
        // `None`/`Err(_)` aren't Some/Ok — unwrapping a value out of them would be
        // wrong (there is no value), so these must not be recorded at all.
        let s = parse_rust("fn f() {\n  if let None = build_service() {}\n}");
        assert!(s.call_assignments.is_empty());
    }

    #[test]
    fn records_a_doubly_nested_some_pattern_with_depth_two() {
        // `Some(Some(x))` — destructuring a doubly-nested `Option<Option<T>>` in
        // a single pattern, the idiomatic way to do it, not two sequential
        // if-lets — must unwrap both layers, not give up after the first
        // (Greptile review, PR #2371).
        let s = parse_rust("fn f() {\n  if let Some(Some(user)) = get_nested_option() {}\n}");
        let ca = s
            .call_assignments
            .iter()
            .find(|c| c.var_name == "user")
            .unwrap();
        assert_eq!(ca.callee_name, "get_nested_option");
        assert_eq!(ca.unwrap_depth, 2);
    }

    // ── Full generic return types (#2214) ─────────────────────────────────────

    #[test]
    fn return_type_map_preserves_full_generic_return_type() {
        let s = parse_rust("fn get_user() -> Option<User> { None }");
        let entry = s
            .return_type_map
            .iter()
            .find(|e| e.name == "get_user")
            .unwrap();
        assert_eq!(entry.type_name, "Option<User>");
    }

    #[test]
    fn return_type_map_keeps_bare_base_name_for_non_option_result_generics() {
        // Only Option/Result need the type argument preserved (to unwrap a
        // Some(x)/Ok(x) binding) — every other generic keeps its original bare
        // name so CHA/RTA's instantiated-types matching against trait-implementor
        // names is unaffected (Greptile review, PR #2371).
        let s = parse_rust("fn get_users() -> Vec<User> { Vec::new() }");
        let entry = s
            .return_type_map
            .iter()
            .find(|e| e.name == "get_users")
            .unwrap();
        assert_eq!(entry.type_name, "Vec");
    }

    #[test]
    fn return_type_map_preserves_full_text_for_a_fully_qualified_option() {
        // `std::option::Option<User>` is just as valid as the bare `Option<User>`
        // spelling and must be recognized the same way (Greptile review, PR #2371).
        let s = parse_rust("fn get_user() -> std::option::Option<User> { None }");
        let entry = s
            .return_type_map
            .iter()
            .find(|e| e.name == "get_user")
            .unwrap();
        assert_eq!(entry.type_name, "std::option::Option<User>");
    }

    #[test]
    fn return_type_map_preserves_full_text_for_a_reference_wrapped_option() {
        // `Option<&User>` (a common shape for a cached-field getter) must
        // preserve the type argument, including the reference sigil, the same
        // way any other Option<T> does — pipeline.rs's unwrap_option_result_type
        // strips the `&` at injection time, not extraction time (Greptile
        // review, PR #2371).
        let s = parse_rust(
            "struct UserService { cached: User }\nimpl UserService {\n  pub fn get_user_ref(&self) -> Option<&User> { Some(&self.cached) }\n}",
        );
        let entry = s
            .return_type_map
            .iter()
            .find(|e| e.name == "UserService.get_user_ref")
            .unwrap();
        assert_eq!(entry.type_name, "Option<&User>");
    }

    #[test]
    fn return_type_map_preserves_a_reference_to_a_generic_option() {
        // `&Option<User>` (a reference TO the Option, not a reference stored
        // inside it) — the old reference_type handling only matched a bare
        // type_identifier/scoped_type_identifier child, never a generic_type
        // child, so this shape returned None entirely and the whole return
        // type was dropped (Greptile review, PR #2371).
        let s = parse_rust("fn get_user() -> &Option<User> { &None }");
        let entry = s
            .return_type_map
            .iter()
            .find(|e| e.name == "get_user")
            .unwrap();
        assert_eq!(entry.type_name, "Option<User>");
    }

    // ── Calls embedded in macro invocation arguments (#2214) ──────────────────

    #[test]
    fn scans_macro_arguments_for_a_method_call() {
        let s = parse_rust(r#"fn f(user: User) { println!("{}", user.display_name()); }"#);
        let call = s.calls.iter().find(|c| c.name == "display_name").unwrap();
        assert_eq!(call.receiver.as_deref(), Some("user"));
        // The macro invocation itself is still recorded alongside the call it wraps.
        assert!(s.calls.iter().any(|c| c.name == "println!"));
    }

    #[test]
    fn scans_macro_arguments_for_a_bare_function_call() {
        let s = parse_rust(r#"fn f() { println!("{}", compute_total()); }"#);
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "compute_total" && c.receiver.is_none()));
    }

    #[test]
    fn scans_nested_macro_arguments_recursively() {
        let s = parse_rust(r#"fn f() { assert_eq!(compute_total(), other.value()); }"#);
        assert!(s.calls.iter().any(|c| c.name == "compute_total"));
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "value" && c.receiver.as_deref() == Some("other")));
    }
}
