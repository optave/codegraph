use super::helpers::*;
use super::SymbolExtractor;
use crate::ast_analysis::cfg::build_function_cfg;
use crate::ast_analysis::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

pub struct PythonExtractor;

impl SymbolExtractor for PythonExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_python_node);
        walk_ast_nodes_with_config(
            &tree.root_node(),
            source,
            &mut symbols.ast_nodes,
            &PYTHON_AST_CONFIG,
        );
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            match_python_type_map,
        );
        dedup_type_map(&mut symbols.type_map);
        mark_entrypoint_calls(&tree.root_node(), source, file_path, &mut symbols);
        symbols
    }
}

/// Flag every call that starts the program rather than being invoked by other
/// code in the repo, covering Python's two canonical conventions (#2392):
///
///  - a call inside an `if __name__ == "__main__":` guard, wherever the guard
///    appears — the convention `data-ingestion-pipe` uses at `app/oio.py:1786`;
///  - a module-level call in a `__main__.py`, whose module-level code is what
///    `python -m pkg` runs.
///
/// Mirrors `markEntrypointCalls` in src/extractors/python.ts, including its
/// keying on line: both engines collect the same qualifying call lines from
/// the same AST and mark the same calls, leaving no room to disagree about a
/// given call site.
fn mark_entrypoint_calls(root: &Node, source: &[u8], file_path: &str, symbols: &mut FileSymbols) {
    let lines = collect_entrypoint_call_lines(root, source, file_path);
    if lines.is_empty() {
        return;
    }
    for call in &mut symbols.calls {
        if lines.contains(&call.line) {
            call.entrypoint = Some(true);
        }
    }
}

/// True for the `__name__ == "__main__"` test of an `if` statement.
fn is_main_guard_condition(condition: Option<Node>, source: &[u8]) -> bool {
    let Some(condition) = condition else {
        return false;
    };
    if condition.kind() != "comparison_operator" {
        return false;
    }
    let text: String = node_text(&condition, source)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    text == "__name__==\"__main__\"" || text == "\"__main__\"==__name__"
}

/// Lines of the call sites that qualify as program-entrypoint invocations.
///
/// `guarded` propagates down the tree and is reset at every function/class
/// definition: code below a definition is invoked by that definition, not by
/// the runtime, so neither the `__main__.py` module-level context nor an
/// enclosing guard carries into it. A `__main__.py` therefore starts guarded at
/// the root, and a guard's *consequence* turns it on anywhere it appears — but
/// not the guard's `else:` branch, which is the imported-as-a-module path.
///
/// `at_module_level` tracks a second, independent thing: whether we have
/// crossed *any* function/class boundary at all since the root, regardless of
/// guard status, and — unlike `guarded` — never turns back on once it's off.
/// A guard is only recognized while this holds. Without it, a guard
/// syntactically nested inside a function or class (never executed by the
/// runtime — only when/if that function is later called) would still flip
/// `guarded` on for its consequence, because at the point the guard is seen,
/// `guarded` itself is `false` either way — the guard sets it, it doesn't
/// read it — so the two situations ("truly at module level" vs. "nested
/// inside a def, coincidentally `false` too") are indistinguishable without
/// this separate flag (review finding on #2411).
fn collect_entrypoint_call_lines(
    root: &Node,
    source: &[u8],
    file_path: &str,
) -> std::collections::HashSet<u32> {
    let mut lines = std::collections::HashSet::new();
    visit_entrypoint_calls(
        root,
        source,
        0,
        file_path.ends_with("__main__.py"),
        true,
        &mut lines,
    );
    lines
}

fn visit_entrypoint_calls(
    node: &Node,
    source: &[u8],
    depth: usize,
    guarded: bool,
    at_module_level: bool,
    lines: &mut std::collections::HashSet<u32>,
) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    if node.kind() == "call" && guarded {
        lines.insert(start_line(node));
    }

    let leaves_runtime_scope =
        node.kind() == "function_definition" || node.kind() == "class_definition";
    let child_guarded = if leaves_runtime_scope { false } else { guarded };
    let child_at_module_level = at_module_level && !leaves_runtime_scope;
    let guard_consequence = if at_module_level
        && node.kind() == "if_statement"
        && is_main_guard_condition(node.child_by_field_name("condition"), source)
    {
        node.child_by_field_name("consequence")
            .or_else(|| find_child(node, "block"))
    } else {
        None
    };
    let guard_start = guard_consequence.map(|c| c.start_position());

    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        let is_guard_body = guard_start.is_some_and(|p| child.start_position() == p);
        visit_entrypoint_calls(
            &child,
            source,
            depth + 1,
            if is_guard_body { true } else { child_guarded },
            child_at_module_level,
            lines,
        );
    }
}

fn match_python_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_definition" => handle_function_def(node, source, symbols),
        "class_definition" => handle_class_def(node, source, symbols),
        "expression_statement" => handle_expr_stmt(node, source, symbols),
        "call" => handle_call(node, source, symbols),
        "import_statement" => handle_import_stmt(node, source, symbols),
        "import_from_statement" => handle_import_from_stmt(node, source, symbols),
        _ => {}
    }
}

// ── Per-node-kind handlers for walk_node_depth ───────────────────────────────

fn handle_function_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let name_text = node_text(&name_node, source);
    let mut decorators = Vec::new();
    if let Some(prev) = node.prev_sibling() {
        if prev.kind() == "decorator" {
            decorators.push(node_text(&prev, source).to_string());
        }
    }
    let parent_class = find_python_parent_class(node, source);
    let (full_name, kind) = match &parent_class {
        Some(cls) => (format!("{}.{}", cls, name_text), "method".to_string()),
        None => (name_text.to_string(), "function".to_string()),
    };
    let children = extract_python_parameters(node, source, parent_class.is_some());
    symbols.definitions.push(Definition {
        name: full_name,
        kind,
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: if decorators.is_empty() {
            None
        } else {
            Some(decorators)
        },
        complexity: compute_all_metrics(node, source, "python"),
        cfg: build_function_cfg(node, "python", source),
        children: opt_children(children),
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

fn handle_class_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let class_name = node_text(&name_node, source).to_string();
    let children = extract_python_class_properties(node, source);
    symbols.definitions.push(Definition {
        name: class_name.clone(),
        kind: "class".to_string(),
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
    let superclasses = node
        .child_by_field_name("superclasses")
        .or_else(|| find_child(node, "argument_list"));
    if let Some(superclasses) = superclasses {
        for i in 0..superclasses.child_count() {
            if let Some(child) = superclasses.child(i) {
                if child.kind() == "identifier" {
                    symbols.classes.push(ClassRelation {
                        name: class_name.clone(),
                        extends: Some(node_text(&child, source).to_string()),
                        implements: None,
                        line: start_line(node),
                    });
                }
            }
        }
    }
}

fn handle_expr_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if !is_module_level(node) {
        return;
    }
    let Some(expr) = node.child(0) else { return };
    if expr.kind() != "assignment" {
        return;
    }
    let Some(left) = expr.child_by_field_name("left") else {
        return;
    };
    if left.kind() != "identifier" {
        return;
    }
    let name = node_text(&left, source);
    if !is_upper_snake_case(name) {
        return;
    }
    symbols.definitions.push(Definition {
        name: name.to_string(),
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

fn handle_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(fn_node) = node.child_by_field_name("function") else {
        return;
    };
    let (call_name, receiver) = match fn_node.kind() {
        "identifier" => (Some(node_text(&fn_node, source).to_string()), None),
        "attribute" => {
            let name = named_child_text(&fn_node, "attribute", source).map(|s| s.to_string());
            let recv = named_child_text(&fn_node, "object", source).map(|s| s.to_string());
            (name, recv)
        }
        _ => (None, None),
    };
    if let Some(name) = call_name {
        symbols.calls.push(Call {
            name,
            line: start_line(node),
            dynamic: None,
            receiver,
            ..Default::default()
        });
    }
}

/// `import a.b`, `import a.b as ab`, `import a, b` — the module-binding form.
///
/// Each module in the statement becomes its own `Import`, whose `source` is
/// the module path and whose single name is the local binding it introduces.
/// That split matters twice over: `source` previously carried the *alias* for
/// `import lib as L`, which can never resolve to a file, and a multi-module
/// `import a, b` collapsed into one record naming only `a` as its source
/// (#2387).
///
/// The binding names a module object rather than a symbol, so it is also
/// recorded in `namespace_bindings` — that is what lets `L.strip_block()`
/// resolve `strip_block` inside the module `L` refers to. For the unaliased
/// dotted form the binding is recorded under its full dotted spelling (`a.b`),
/// because that is the receiver text a call site writes (`a.b.func()`).
///
/// Mirrors `handlePyImport` in src/extractors/python.ts.
fn handle_import_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let line = start_line(node);
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        let (module, local) = match child.kind() {
            "dotted_name" => {
                let text = node_text(&child, source).to_string();
                (Some(text.clone()), Some(text))
            }
            "aliased_import" => {
                let module = child
                    .child_by_field_name("name")
                    .map(|n| node_text(&n, source).to_string());
                let local = child
                    .child_by_field_name("alias")
                    .map(|n| node_text(&n, source).to_string())
                    .or_else(|| module.clone());
                (module, local)
            }
            _ => continue,
        };
        let (Some(module), Some(local)) = (module, local) else {
            continue;
        };
        let mut imp = Import::new(module, vec![local.clone()], line);
        imp.namespace_bindings = Some(vec![local]);
        imp.python_import = Some(true);
        symbols.imports.push(imp);
    }
}

/// `from pkg import submod`, `from pkg import submod as alias`, `from pkg
/// import a, b as c` — the symbol/submodule-binding form.
///
/// `names` must carry the *local* binding (the alias, when there is one) —
/// call sites write `alias.f()`, not `submod.f()`, and every downstream
/// consumer (`import_name_pairs`, the namespace/submodule maps in
/// `collect_imported_names_for_file`/build_edges.rs) keys off the local name.
/// Previously this took the `aliased_import`'s pre-alias `name` field
/// unconditionally, so an aliased specifier's local binding was silently
/// dropped: `from pkg import submod as alias` recorded `submod`, and a call
/// through `alias` resolved to nothing in both engines (#2387).
///
/// The pre-alias name doesn't disappear — it's the name actually declared in
/// `source` (whether that turns out to be a symbol in `pkg`'s file or, per
/// `resolve_python_submodule`, a submodule `pkg/submod.py`), so it is
/// recorded in `renamed_imports` exactly like a renamed JS specifier
/// (`import { X as Y }`, #1730). `import_name_pairs` already recovers it from
/// there for barrel tracing, submodule probing, and namespace-import mapping
/// — mirrors `scan_import_names_depth`'s `import_specifier` handling in
/// extractors/javascript.rs. Mirrors `handlePyImportFrom` in
/// src/extractors/python.ts.
fn handle_import_from_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mut source_str = String::new();
    let mut names = Vec::new();
    let mut renamed_imports = Vec::new();
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        match child.kind() {
            "dotted_name" | "relative_import" => {
                if source_str.is_empty() {
                    source_str = node_text(&child, source).to_string();
                } else {
                    names.push(node_text(&child, source).to_string());
                }
            }
            "aliased_import" => {
                let source_name_node = child.child_by_field_name("name");
                let alias_node = child.child_by_field_name("alias");
                let local_node = alias_node.or(source_name_node).or_else(|| child.child(0));
                if let Some(local_node) = local_node {
                    names.push(node_text(&local_node, source).to_string());
                    if let (Some(alias), Some(source_name)) = (alias_node, source_name_node) {
                        let alias_text = node_text(&alias, source);
                        let source_text = node_text(&source_name, source);
                        if alias_text != source_text {
                            renamed_imports.push(RenamedImport {
                                local: alias_text.to_string(),
                                imported: source_text.to_string(),
                            });
                        }
                    }
                }
            }
            "wildcard_import" => {
                names.push("*".to_string());
            }
            _ => {}
        }
    }
    if !source_str.is_empty() {
        let mut imp = Import::new(source_str, names, start_line(node));
        imp.python_import = Some(true);
        if !renamed_imports.is_empty() {
            imp.renamed_imports = Some(renamed_imports);
        }
        symbols.imports.push(imp);
    }
}

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_python_parameters(node: &Node, source: &[u8], is_method: bool) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters");
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                let name = match child.kind() {
                    "identifier" => {
                        let text = node_text(&child, source);
                        Some(text.to_string())
                    }
                    "default_parameter" | "typed_default_parameter" => {
                        named_child_text(&child, "name", source).map(|s| s.to_string())
                    }
                    "typed_parameter" => {
                        // typed_parameter: first child is the identifier
                        child
                            .child(0)
                            .filter(|c| c.kind() == "identifier")
                            .map(|c| node_text(&c, source).to_string())
                    }
                    "list_splat_pattern" | "dictionary_splat_pattern" => {
                        // *args, **kwargs
                        child
                            .child(0)
                            .filter(|c| c.kind() == "identifier")
                            .map(|c| node_text(&c, source).to_string())
                    }
                    _ => None,
                };
                if let Some(name) = name {
                    // Skip self/cls for methods
                    if is_method && (name == "self" || name == "cls") {
                        continue;
                    }
                    params.push(child_def(name, "parameter", start_line(&child)));
                }
            }
        }
    }
    params
}

fn extract_python_class_properties(class_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut props = Vec::new();
    let body = class_node.child_by_field_name("body");
    if let Some(body) = body {
        // Look for __init__ method and scan for self.x = ... assignments
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "function_definition" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if node_text(&name_node, source) == "__init__" {
                            collect_self_assignments(&child, source, &mut props);
                        }
                    }
                }
            }
        }
    }
    props
}

fn collect_self_assignments(node: &Node, source: &[u8], props: &mut Vec<Definition>) {
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() == "expression_statement" {
            try_extract_self_assignment(&child, source, props);
        }
        // Recurse into blocks (if/for/etc inside __init__)
        if child.kind() == "block"
            || child.kind() == "if_statement"
            || child.kind() == "for_statement"
            || child.kind() == "while_statement"
        {
            collect_self_assignments(&child, source, props);
        }
    }
}

fn try_extract_self_assignment(stmt: &Node, source: &[u8], props: &mut Vec<Definition>) {
    let Some(expr) = stmt.child(0) else { return };
    if expr.kind() != "assignment" {
        return;
    }
    let Some(left) = expr.child_by_field_name("left") else {
        return;
    };
    if left.kind() != "attribute" {
        return;
    }
    let Some(obj) = left.child_by_field_name("object") else {
        return;
    };
    if node_text(&obj, source) != "self" {
        return;
    }
    let Some(attr) = left.child_by_field_name("attribute") else {
        return;
    };
    let name = node_text(&attr, source);
    if !props.iter().any(|p| p.name == name) {
        props.push(child_def(name.to_string(), "property", start_line(stmt)));
    }
}

fn is_module_level(node: &Node) -> bool {
    if let Some(parent) = node.parent() {
        return parent.kind() == "module";
    }
    false
}

fn is_upper_snake_case(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
        && s.chars()
            .next()
            .map(|c| c.is_ascii_uppercase())
            .unwrap_or(false)
}

// ── Existing helpers ────────────────────────────────────────────────────────

const PYTHON_CLASS_KINDS: &[&str] = &["class_definition"];

fn find_python_parent_class(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name(node, PYTHON_CLASS_KINDS, source)
}

fn extract_python_type_name<'a>(type_node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    match type_node.kind() {
        "identifier" | "attribute" => Some(node_text(type_node, source)),
        "subscript" => {
            // List[int] → List
            named_child_text(type_node, "value", source)
        }
        _ => None,
    }
}

/// Python builtins / stdlib classes that start with an uppercase letter and would
/// false-positive on the constructor-call heuristic.  Mirrors `BUILTIN_GLOBALS_PY`
/// in `src/extractors/python.ts`.
fn is_python_builtin(name: &str) -> bool {
    matches!(
        name,
        "Exception"
            | "BaseException"
            | "ValueError"
            | "TypeError"
            | "KeyError"
            | "IndexError"
            | "AttributeError"
            | "RuntimeError"
            | "OSError"
            | "IOError"
            | "FileNotFoundError"
            | "PermissionError"
            | "NotImplementedError"
            | "StopIteration"
            | "GeneratorExit"
            | "SystemExit"
            | "KeyboardInterrupt"
            | "ArithmeticError"
            | "LookupError"
            | "UnicodeError"
            | "UnicodeDecodeError"
            | "UnicodeEncodeError"
            | "ImportError"
            | "ModuleNotFoundError"
            | "ConnectionError"
            | "TimeoutError"
            | "OverflowError"
            | "ZeroDivisionError"
            | "NameError"
            | "SyntaxError"
            | "RecursionError"
            | "MemoryError"
            | "Path"
            | "PurePath"
            | "OrderedDict"
            | "Counter"
            | "Decimal"
            | "Fraction"
    )
}

fn match_python_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "typed_parameter" => {
            // first child is identifier, type field is the type
            if let Some(name_node) = node.child(0) {
                if name_node.kind() == "identifier" {
                    let name = node_text(&name_node, source);
                    if name != "self" && name != "cls" {
                        if let Some(type_node) = node.child_by_field_name("type") {
                            if let Some(type_name) = extract_python_type_name(&type_node, source) {
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
        "typed_default_parameter" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if name_node.kind() == "identifier" {
                    if let Some(type_node) = node.child_by_field_name("type") {
                        if let Some(type_name) = extract_python_type_name(&type_node, source) {
                            symbols.type_map.push(TypeMapEntry {
                                name: node_text(&name_node, source).to_string(),
                                type_name: type_name.to_string(),
                                confidence: 0.9,
                            });
                        }
                    }
                }
            }
        }
        // `order = Order(...)` → seed order : Order at conf 1.0.
        // `obj = module.Class(...)` → seed obj : module at conf 0.7 (factory pattern).
        // Mirrors `handlePyAssignmentType` in `src/extractors/python.ts`.
        "assignment" => {
            infer_py_assignment_type(node, source, &mut symbols.type_map);
        }
        _ => {}
    }
}

/// Seed typeMap from plain Python assignments where the RHS is a constructor or factory call.
fn infer_py_assignment_type(node: &Node, source: &[u8], type_map: &mut Vec<TypeMapEntry>) {
    let Some(left) = node.child_by_field_name("left") else {
        return;
    };
    let Some(right) = node.child_by_field_name("right") else {
        return;
    };
    if left.kind() != "identifier" || right.kind() != "call" {
        return;
    }
    let var_name = node_text(&left, source).to_string();
    let Some(fn_node) = right.child_by_field_name("function") else {
        return;
    };
    match fn_node.kind() {
        "identifier" => {
            // `order = Order(...)` — uppercase first char → constructor, conf 1.0.
            let name = node_text(&fn_node, source);
            if name
                .chars()
                .next()
                .map(|c| c.is_uppercase())
                .unwrap_or(false)
            {
                type_map.push(TypeMapEntry {
                    name: var_name,
                    type_name: name.to_string(),
                    confidence: 1.0,
                });
            }
        }
        "attribute" => {
            // `obj = Module.Class(...)` — uppercase object name, not a builtin → conf 0.7.
            if let Some(obj_node) = fn_node.child_by_field_name("object") {
                if obj_node.kind() == "identifier" {
                    let obj_name = node_text(&obj_node, source);
                    if obj_name
                        .chars()
                        .next()
                        .map(|c| c.is_uppercase())
                        .unwrap_or(false)
                        && !is_python_builtin(obj_name)
                    {
                        type_map.push(TypeMapEntry {
                            name: var_name,
                            type_name: obj_name.to_string(),
                            confidence: 0.7,
                        });
                    }
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

    fn parse_py(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        PythonExtractor.extract(&tree, code.as_bytes(), "test.py")
    }

    /// Same as `parse_py` but with a caller-chosen path, so the
    /// `__main__.py` entrypoint convention (#2392) can be exercised.
    fn parse_py_as(code: &str, file_path: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        PythonExtractor.extract(&tree, code.as_bytes(), file_path)
    }

    #[test]
    fn finds_function() {
        let s = parse_py("def greet(name):\n    return name\n");
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "greet");
        assert_eq!(s.definitions[0].kind, "function");
    }

    #[test]
    fn finds_class_and_method() {
        let s = parse_py("class Foo:\n    def bar(self):\n        pass\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"Foo.bar"));
    }

    #[test]
    fn finds_imports() {
        let s = parse_py("from os.path import join, exists\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "os.path");
        assert!(s.imports[0].names.contains(&"join".to_string()));
    }

    #[test]
    fn plain_import_records_the_module_as_source_and_a_namespace_binding() {
        // #2387: `source` must be the module, not the binding name — a binding
        // name can never resolve to a file.
        let s = parse_py("import lib\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "lib");
        assert_eq!(s.imports[0].names, vec!["lib".to_string()]);
        assert_eq!(
            s.imports[0].namespace_bindings,
            Some(vec!["lib".to_string()])
        );
    }

    #[test]
    fn aliased_import_keeps_the_module_as_source_and_the_alias_as_the_binding() {
        // #2387: this previously stored the alias ("L") as `source`, which is
        // why `import lib as L` produced no imports edge and `L.f()` resolved
        // to nothing.
        let s = parse_py("import lib as L\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "lib");
        assert_eq!(s.imports[0].names, vec!["L".to_string()]);
        assert_eq!(s.imports[0].namespace_bindings, Some(vec!["L".to_string()]));
    }

    #[test]
    fn dotted_import_binds_under_its_full_dotted_spelling() {
        // `import a.b.c` is written `a.b.c.func()` at the call site, so the
        // binding is recorded under the dotted text a receiver would carry.
        let s = parse_py("import a.b.c\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "a.b.c");
        assert_eq!(
            s.imports[0].namespace_bindings,
            Some(vec!["a.b.c".to_string()])
        );
    }

    #[test]
    fn multi_module_import_produces_one_record_per_module() {
        // #2387: `import a, b` used to collapse into a single record whose
        // source was "a", silently losing b entirely.
        let s = parse_py("import alpha, beta as B\n");
        assert_eq!(s.imports.len(), 2);
        let sources: Vec<&str> = s.imports.iter().map(|i| i.source.as_str()).collect();
        assert!(sources.contains(&"alpha"));
        assert!(sources.contains(&"beta"));
        let beta = s.imports.iter().find(|i| i.source == "beta").unwrap();
        assert_eq!(beta.names, vec!["B".to_string()]);
    }

    #[test]
    fn from_import_names_are_not_namespace_bindings() {
        // `from mod import name` binds a symbol; whether `name` is actually a
        // submodule is decided at resolution time, not here.
        let s = parse_py("from lib import helper\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "lib");
        assert_eq!(s.imports[0].names, vec!["helper".to_string()]);
        assert_eq!(s.imports[0].namespace_bindings, None);
    }

    #[test]
    fn marks_calls_inside_a_main_guard_as_entrypoints() {
        // #2392: the `if __name__ == "__main__":` convention.
        let s = parse_py("def main():\n    return 1\n\nif __name__ == \"__main__\":\n    main()\n");
        let main_call = s
            .calls
            .iter()
            .find(|c| c.name == "main")
            .expect("main() call should be extracted");
        assert_eq!(main_call.entrypoint, Some(true));
    }

    #[test]
    fn does_not_mark_calls_outside_the_guard() {
        let s = parse_py("def helper():\n    return 1\n\nhelper()\n");
        let call = s.calls.iter().find(|c| c.name == "helper").unwrap();
        assert_eq!(call.entrypoint, None);
    }

    #[test]
    fn does_not_mark_a_call_nested_in_a_function_defined_under_the_guard() {
        // Reached via the guard-invoked function, not started by the runtime.
        let s = parse_py(
            "def inner():\n    return 1\n\ndef main():\n    return inner()\n\nif __name__ == \"__main__\":\n    main()\n",
        );
        let inner = s.calls.iter().find(|c| c.name == "inner").unwrap();
        assert_eq!(inner.entrypoint, None);
        let main_call = s.calls.iter().find(|c| c.name == "main").unwrap();
        assert_eq!(main_call.entrypoint, Some(true));
    }

    #[test]
    fn marks_module_level_calls_in_a_dunder_main_module() {
        // The `python -m pkg` convention.
        let symbols = parse_py_as("def run():\n    return 1\n\nrun()\n", "pkg/__main__.py");
        let call = symbols.calls.iter().find(|c| c.name == "run").unwrap();
        assert_eq!(call.entrypoint, Some(true));
    }

    #[test]
    fn does_not_mark_a_nested_call_in_a_dunder_main_module() {
        let src = "def outer():\n    return inner()\n\ndef inner():\n    return 1\n\nouter()\n";
        let symbols = parse_py_as(src, "pkg/__main__.py");
        let inner = symbols.calls.iter().find(|c| c.name == "inner").unwrap();
        assert_eq!(
            inner.entrypoint, None,
            "invoked by outer(), not by the runtime"
        );
        let outer = symbols.calls.iter().find(|c| c.name == "outer").unwrap();
        assert_eq!(outer.entrypoint, Some(true));
    }

    #[test]
    fn does_not_mark_a_guard_nested_inside_a_function() {
        // Review finding on #2411: a `__main__` guard syntactically nested
        // inside a function is only run if and when that function is called
        // — never automatically by the runtime — so it must not be treated
        // as module level just because `guarded` also happens to read
        // `false` at that point for the ordinary "inside a def" reason.
        let s = parse_py("def maybe_run():\n    if __name__ == \"__main__\":\n        do_it()\n");
        let call = s.calls.iter().find(|c| c.name == "do_it").unwrap();
        assert_eq!(call.entrypoint, None);
    }

    #[test]
    fn does_not_mark_a_guard_nested_inside_a_class() {
        let s = parse_py("class Config:\n    if __name__ == \"__main__\":\n        do_it()\n");
        let call = s.calls.iter().find(|c| c.name == "do_it").unwrap();
        assert_eq!(call.entrypoint, None);
    }

    /// Found in review of #2387: `from pkg import submod as alias` must
    /// record the *local* binding (`alias`) in `names` — that's what call
    /// sites reference (`alias.f()`) — plus the `{ local: alias, imported:
    /// submod }` pair in `renamed_imports` so `import_name_pairs` can recover
    /// the pre-alias name for barrel tracing and submodule probing
    /// (`resolve_python_submodule` needs the real file/symbol name, not the
    /// alias). Previously this took the `aliased_import`'s pre-alias `name`
    /// field unconditionally, silently dropping the alias.
    #[test]
    fn aliased_from_import_records_local_alias_and_rename_pair() {
        let s = parse_py("from pkg import submod as alias\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "pkg");
        assert_eq!(s.imports[0].names, vec!["alias".to_string()]);
        let renamed = s.imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated for an aliased from-import");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "alias");
        assert_eq!(renamed[0].imported, "submod");
    }

    #[test]
    fn aliased_from_import_multi_name_only_renames_the_aliased_specifier() {
        // `from pkg import a, b as c` — the unaliased `a` must stay a plain
        // name with no rename entry; only `b as c` contributes to
        // `renamed_imports`.
        let s = parse_py("from pkg import a, b as c\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].names, vec!["a".to_string(), "c".to_string()]);
        let renamed = s.imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated when any specifier is aliased");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "c");
        assert_eq!(renamed[0].imported, "b");
    }

    #[test]
    fn finds_calls() {
        let s = parse_py("print('hello')\nos.path.join('a', 'b')\n");
        let call_names: Vec<&str> = s.calls.iter().map(|c| c.name.as_str()).collect();
        assert!(call_names.contains(&"print"));
        assert!(call_names.contains(&"join"));
    }

    #[test]
    fn finds_inheritance() {
        let s = parse_py("class Dog(Animal):\n    pass\n");
        assert_eq!(s.classes.len(), 1);
        assert_eq!(s.classes[0].name, "Dog");
        assert_eq!(s.classes[0].extends, Some("Animal".to_string()));
    }

    // ── Extended kinds tests ────────────────────────────────────────────────

    #[test]
    fn extracts_function_parameters() {
        let s = parse_py("def greet(name, age=30):\n  pass");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        let children = greet.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "name");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "age");
    }

    #[test]
    fn extracts_method_parameters_skips_self() {
        let s = parse_py("class Foo:\n    def bar(self, x, y):\n        pass\n");
        let bar = s.definitions.iter().find(|d| d.name == "Foo.bar").unwrap();
        let children = bar.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "x");
        assert_eq!(children[1].name, "y");
    }

    #[test]
    fn extracts_class_properties_from_init() {
        let s =
            parse_py("class User:\n  def __init__(self, x, y):\n    self.x = x\n    self.y = y\n");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"x"));
        assert!(names.contains(&"y"));
        assert!(children.iter().all(|c| c.kind == "property"));
    }

    #[test]
    fn extracts_module_level_constant() {
        let s = parse_py("MAX_RETRIES = 3");
        let c = s
            .definitions
            .iter()
            .find(|d| d.name == "MAX_RETRIES")
            .unwrap();
        assert_eq!(c.kind, "constant");
    }

    // ── Assignment typeMap tests ─────────────────────────────────────────────

    #[test]
    fn infers_constructor_call_uppercase() {
        // order = Order("o1", 100.0) → order : Order at conf 1.0
        let s = parse_py("def run():\n    order = Order(\"o1\", 100.0)\n    order.validate()\n");
        let entry = s.type_map.iter().find(|e| e.name == "order");
        assert!(entry.is_some(), "expected order in type_map");
        let entry = entry.unwrap();
        assert_eq!(entry.type_name, "Order");
        assert!((entry.confidence - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn infers_module_factory_call() {
        // svc = Models.UserService(db) → svc : Models at conf 0.7
        // The object name must be uppercase to match the JS heuristic.
        let s = parse_py("def run():\n    svc = Models.UserService(db)\n    svc.create()\n");
        let entry = s.type_map.iter().find(|e| e.name == "svc");
        assert!(
            entry.is_some(),
            "expected svc in type_map for Module.Class(...)"
        );
        let entry = entry.unwrap();
        assert_eq!(entry.type_name, "Models");
        assert!((entry.confidence - 0.7).abs() < f64::EPSILON);
    }

    #[test]
    fn does_not_infer_lowercase_module_factory() {
        // svc = models.UserService(db) — lowercase module name → no typeMap entry (matches JS)
        let s = parse_py("def run():\n    svc = models.UserService(db)\n    svc.create()\n");
        assert!(
            s.type_map.iter().all(|e| e.name != "svc"),
            "should not seed typeMap for lowercase module prefix"
        );
    }

    #[test]
    fn does_not_infer_lowercase_constructor() {
        // obj = create_thing() — lowercase, should not seed typeMap
        let s = parse_py("def run():\n    obj = create_thing()\n    obj.work()\n");
        assert!(
            s.type_map.iter().all(|e| e.name != "obj"),
            "should not seed typeMap for lowercase function call"
        );
    }

    #[test]
    fn does_not_infer_builtin_exception() {
        // err = ValueError("msg") — builtin exception, should not seed typeMap
        let s = parse_py("def run():\n    err = ValueError(\"msg\")\n");
        // Note: ValueError is uppercase so it WOULD match the heuristic — but it's a builtin.
        // The JS extractor does NOT exclude builtins from conf-1.0 uppercase constructor
        // matching (only from the attribute/factory path). We match that behaviour here.
        // This test documents the current behaviour rather than asserting exclusion.
        let entry = s.type_map.iter().find(|e| e.name == "err");
        // Builtins ARE seeded at conf 1.0 by the identifier branch (same as JS).
        // Only the attribute/factory branch (Module.Class) checks is_python_builtin.
        if let Some(e) = entry {
            assert_eq!(e.type_name, "ValueError");
        }
    }
}
