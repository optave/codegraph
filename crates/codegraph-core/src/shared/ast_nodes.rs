use tree_sitter::Node;

/// Find a node's next sibling whose kind is in `body_types`, skipping over
/// intervening `comment` nodes. Mirrors `src/shared/ast-nodes.ts`'s
/// `findBodySiblingNode` — needed for grammars (e.g. tree-sitter-dart's
/// function_signature/function_body split, #2082/#2182) where a function's
/// body lives as a SIBLING of its signature/declaration node rather than as
/// a child of it — every consumer that walks only a matched node's own
/// subtree would otherwise silently see zero body content.
///
/// Returns `None` if no sibling exists, or if the next non-comment
/// sibling's kind isn't in `body_types` (e.g. tree-sitter-dart's bare `;`
/// for an abstract method signature with no body at all).
pub fn find_body_sibling_node<'a>(node: &Node<'a>, body_types: &[&str]) -> Option<Node<'a>> {
    let parent = node.parent()?;
    for i in 0..parent.child_count() {
        let child = parent.child(i)?;
        if child.id() != node.id() {
            continue;
        }
        let mut j = i + 1;
        let mut next = parent.child(j);
        while let Some(n) = next {
            if n.kind() != "comment" {
                break;
            }
            j += 1;
            next = parent.child(j);
        }
        return next.filter(|n| body_types.contains(&n.kind()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_dart(code: &str) -> tree_sitter::Tree {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_dart::LANGUAGE.into())
            .unwrap();
        parser.parse(code, None).unwrap()
    }

    #[test]
    fn finds_the_sibling_body_of_a_top_level_function_signature() {
        // (source_file (function_declaration signature: (function_signature ...)
        //   body: (function_body ...))) — function_signature and function_body
        // are both direct children of function_declaration, i.e. siblings of
        // each other, not parent/child.
        let tree = parse_dart("int add(int a, int b) {\n  return a + b;\n}\n");
        let decl = tree.root_node().child(0).unwrap();
        assert_eq!(decl.kind(), "function_declaration");
        let sig = decl.child_by_field_name("signature").unwrap();
        assert_eq!(sig.kind(), "function_signature");

        let body = find_body_sibling_node(&sig, &["function_body"]);
        assert!(body.is_some(), "expected to find a function_body sibling");
        assert_eq!(body.unwrap().kind(), "function_body");
    }

    #[test]
    fn returns_none_for_a_bodyless_abstract_signature() {
        // An abstract method's function_signature has NO next sibling at
        // all (its parent, `declaration`, has only the signature as a
        // child) — must not panic or false-positive.
        let tree = parse_dart("abstract class Foo {\n  int bar();\n}\n");
        let class_body = tree
            .root_node()
            .child(0)
            .unwrap()
            .child_by_field_name("body")
            .unwrap();
        // Walk down: class_body -> class_member -> declaration -> function_signature
        let class_member = class_body.named_child(0).unwrap();
        assert_eq!(class_member.kind(), "class_member");
        let declaration = class_member.named_child(0).unwrap();
        assert_eq!(declaration.kind(), "declaration");
        let sig = declaration.named_child(0).unwrap();
        assert_eq!(sig.kind(), "function_signature");

        assert!(find_body_sibling_node(&sig, &["function_body"]).is_none());
    }

    #[test]
    fn skips_an_intervening_comment_node_between_signature_and_body() {
        let tree = parse_dart("int add(int a, int b) // trailing comment\n{\n  return a + b;\n}\n");
        let decl = tree.root_node().child(0).unwrap();
        assert_eq!(decl.kind(), "function_declaration");
        let sig = decl.child_by_field_name("signature").unwrap();
        assert_eq!(sig.kind(), "function_signature");

        let body = find_body_sibling_node(&sig, &["function_body"]);
        assert_eq!(body.map(|n| n.kind()), Some("function_body"));
    }
}
