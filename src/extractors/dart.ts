import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Dart files.
 */
export function extractDartSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkDartNode(tree.rootNode, ctx);
  return ctx;
}

function walkDartNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_definition':
      handleDartClass(node, ctx);
      break;
    case 'enum_declaration':
      handleDartEnum(node, ctx);
      break;
    case 'mixin_declaration':
      handleDartMixin(node, ctx);
      break;
    case 'extension_declaration':
      handleDartExtension(node, ctx);
      break;
    case 'function_signature':
      handleDartFunction(node, ctx);
      break;
    case 'method_signature':
      handleDartMethodSig(node, ctx);
      break;
    case 'library_import':
      handleDartImport(node, ctx);
      break;
    case 'constructor_invocation':
    case 'new_expression':
      handleDartConstructorCall(node, ctx);
      break;
    case 'type_alias':
      handleDartTypeAlias(node, ctx);
      break;
    case 'selector':
      handleDartSelector(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkDartNode(child, ctx);
  }
}

function handleDartClass(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;
  const children: SubDeclaration[] = [];

  const body = node.childForFieldName('body') || findChild(node, 'class_body');
  if (body) {
    extractDartClassMembers(body, name, ctx, children);
  }

  ctx.definitions.push({
    name,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  extractDartInheritance(node, name, ctx);
}

function extractDartClassMembers(
  body: TreeSitterNode,
  className: string,
  ctx: ExtractorOutput,
  children: SubDeclaration[],
): void {
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member) continue;

    if (member.type === 'method_signature' || member.type === 'function_signature') {
      const fnName = extractDartFunctionName(member);
      if (fnName) {
        ctx.definitions.push({
          name: `${className}.${fnName}`,
          kind: 'method',
          line: member.startPosition.row + 1,
          endLine: dartFunctionEndLine(member),
        });
      }
    } else if (member.type === 'declaration') {
      // A bodyless (semicolon-only) member — `Foo();` (a constructor, the
      // short form idiomatic Dart uses throughout) or `double area();` (an
      // abstract method with no implementation) — wraps its
      // constructor_signature/function_signature/method_signature in a
      // `declaration` node instead of the `method_signature` a block-bodied
      // member uses (confirmed by parsing both forms with tree-sitter-dart;
      // #2082). Check for that shape before falling back to plain
      // field-declaration detection, which would otherwise silently find no
      // `identifier` child here and drop the member entirely.
      const bodylessSig =
        findChild(member, 'constructor_signature') ||
        findChild(member, 'method_signature') ||
        findChild(member, 'function_signature');
      if (bodylessSig) {
        const fnName = extractDartFunctionName(member);
        if (fnName) {
          ctx.definitions.push({
            name: `${className}.${fnName}`,
            kind: 'method',
            line: member.startPosition.row + 1,
            endLine: nodeEndLine(member),
          });
        }
        continue;
      }
      // Field declarations
      for (let j = 0; j < member.childCount; j++) {
        const decl = member.child(j);
        if (decl?.type === 'identifier') {
          children.push({
            name: decl.text,
            kind: 'property',
            line: member.startPosition.row + 1,
          });
          break;
        }
      }
    }
  }
}

/**
 * Compute the true end line for a function/method whose grammar splits the
 * signature and body into SIBLING nodes — `function_signature`/
 * `method_signature` followed by a separate `function_body` sibling under
 * the SAME parent — rather than nesting the body inside the signature node
 * (confirmed by parsing multi-line top-level functions and class methods
 * with tree-sitter-dart; #2082). Using the signature node's own span alone
 * truncates `endLine` to the signature line, so any call inside a
 * multi-line body falls outside `[line, endLine]` and enclosing-function
 * caller-attribution during graph build silently misses it.
 *
 * Falls back to the signature node's own span when the next sibling is a
 * bare `;` (an abstract/interface method signature with no body at all) or
 * doesn't exist.
 */
function dartFunctionEndLine(signatureNode: TreeSitterNode): number {
  const parent = signatureNode.parent;
  if (parent) {
    for (let i = 0; i < parent.childCount; i++) {
      if (parent.child(i)?.id === signatureNode.id) {
        const next = parent.child(i + 1);
        if (next && next.type !== ';') return nodeEndLine(next);
        break;
      }
    }
  }
  return nodeEndLine(signatureNode);
}

function extractDartFunctionName(node: TreeSitterNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // Walk children for function_signature inside method_signature
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'function_signature' ||
      child.type === 'getter_signature' ||
      child.type === 'setter_signature' ||
      child.type === 'constructor_signature'
    ) {
      const name = child.childForFieldName('name');
      if (name) return name.text;
    }
  }
  return null;
}

function handleDartEnum(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDartMixin(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDartExtension(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDartFunction(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip methods already emitted by class handler
  if (isInsideDartClass(node)) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: dartFunctionEndLine(node),
  });
}

function handleDartMethodSig(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (isInsideDartClass(node)) return;
  const fnName = extractDartFunctionName(node);
  if (!fnName) return;

  ctx.definitions.push({
    name: fnName,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: dartFunctionEndLine(node),
  });
}

function isInsideDartClass(node: TreeSitterNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'class_body' ||
      current.type === 'class_definition' ||
      current.type === 'enum_body' ||
      current.type === 'mixin_declaration'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function handleDartImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const spec = findChild(node, 'import_specification');
  if (!spec) return;

  const uri = findChild(spec, 'configurable_uri') || findChild(spec, 'uri');
  if (!uri) return;

  const source = uri.text.replace(/^['"]|['"]$/g, '');
  const names: string[] = [];

  // Check for `as` alias
  const alias = findChild(spec, 'identifier');
  if (alias) names.push(alias.text);

  ctx.imports.push({
    source,
    names: names.length > 0 ? names : [source.split('/').pop() || source],
    line: node.startPosition.row + 1,
  });
}

function handleDartConstructorCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // tree-sitter-dart crate versions structure the type name differently:
  // 0.2 (crates.io, used by the native engine — see check-grammar-versions.mjs's
  // tracked exception for this crate) nests it under an intermediate `type`
  // field — `new_expression type: (type (type_identifier)) arguments: (...)` —
  // while npm's tree-sitter-dart 1.x (this WASM engine's grammar) puts it
  // directly under `new_expression` — `(new_expression (type_identifier)
  // (arguments))`. Try the direct shape first, then unwrap one `type` level,
  // so both engines resolve identically once the crates.io release catches up.
  const nameNode =
    findChild(node, 'type_identifier') ||
    findChild(node, 'identifier') ||
    (() => {
      const typeWrapper = node.childForFieldName('type') || findChild(node, 'type');
      return (
        typeWrapper &&
        (findChild(typeWrapper, 'type_identifier') || findChild(typeWrapper, 'identifier'))
      );
    })();
  if (!nameNode) return;

  ctx.calls.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
  });
}

function handleDartSelector(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // selector with argument_part represents a function call
  const argPart = findChild(node, 'argument_part');
  if (!argPart) return;

  const line = node.startPosition.row + 1;
  const methodName = resolveDartSelectorMethodName(node);
  if (!methodName) return;

  // Function.apply(fn, positionalArgs, namedArgs) — dynamic higher-order dispatch
  if (methodName === 'apply' && isDartFunctionApplyCall(node)) {
    ctx.calls.push({
      name: '<dynamic:unresolved>',
      line,
      dynamic: true,
      dynamicKind: 'unresolved-dynamic',
    });
    return;
  }

  ctx.calls.push({ name: methodName, line });
}

// Look for the identifier this selector belongs to.
// Three layouts are possible depending on grammar version and call shape:
//   A) selector has both unconditional_assignable_selector + argument_part (same node)
//   B) one selector node holds unconditional_assignable_selector (.method),
//      the next holds argument_part (the call args) — method name is in the previous sibling
//   C) a bare (keyword-less) call — `helper()`, `Foo()` — has no preceding
//      `.method`-style selector at all; the callee is a plain identifier
//      (or type_identifier, for a bare constructor call) sitting directly
//      before this selector in the SAME parent (confirmed by parsing
//      `helper();` and `var w = Foo();` with tree-sitter-dart: the tree is
//      `identifier "helper"` followed by a SIBLING `selector` node, not a
//      wrapping call_expression — #2082).
function resolveDartSelectorMethodName(node: TreeSitterNode): string | null {
  const unconditional = findChild(node, 'unconditional_assignable_selector');
  if (unconditional) {
    const id = findChild(unconditional, 'identifier');
    return id ? id.text : null;
  }

  const parent = node.parent;
  if (!parent) return null;

  // Find the sibling immediately preceding this selector node — Dart's
  // grammar places exactly the callee there, whether that's another
  // `selector` in a chained-access call (Layout B) or a bare identifier
  // (Layout C). Compares by `.id`, not `===`: web-tree-sitter returns a
  // fresh wrapper object from every `.child()` call, so two accessors for
  // the SAME underlying node are never reference-equal — only `.id` is
  // stable (confirmed empirically; `.child(i) === .child(i)` is false but
  // `.child(i).id === .child(i).id` is true). A `===` comparison here would
  // never break the loop, silently falling through to the LAST sibling in
  // the parent instead of the one immediately before this selector (#2082).
  let prevSibling: TreeSitterNode | null = null;
  for (let i = 0; i < parent.childCount; i++) {
    const sibling = parent.child(i);
    if (sibling?.id === node.id) break;
    prevSibling = sibling;
  }
  if (!prevSibling) return null;

  if (prevSibling.type === 'selector') {
    const unc2 = findChild(prevSibling, 'unconditional_assignable_selector');
    return unc2 ? (findChild(unc2, 'identifier')?.text ?? null) : null;
  }

  if (prevSibling.type === 'identifier' || prevSibling.type === 'type_identifier') {
    return prevSibling.text;
  }

  return null;
}

// Detects `Function.apply(...)` calls: true when a sibling selector's text is
// the literal `Function` identifier preceding this call.
function isDartFunctionApplyCall(node: TreeSitterNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  for (let i = 0; i < parent.childCount; i++) {
    const sibling = parent.child(i);
    if (sibling && sibling !== node && sibling.text === 'Function') {
      return true;
    }
  }
  return false;
}

function handleDartTypeAlias(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'type_identifier') || findChild(node, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function extractDartInheritance(node: TreeSitterNode, name: string, ctx: ExtractorOutput): void {
  const superclass = node.childForFieldName('superclass');
  if (superclass) {
    const typeName =
      findChild(superclass, 'type_identifier') || findChild(superclass, 'identifier');
    if (typeName) {
      ctx.classes.push({ name, extends: typeName.text, line: node.startPosition.row + 1 });
    }
  }

  const interfaces = node.childForFieldName('interfaces');
  if (interfaces) {
    for (let i = 0; i < interfaces.childCount; i++) {
      const iface = interfaces.child(i);
      if (!iface) continue;
      const typeName =
        iface.type === 'type_identifier'
          ? iface
          : findChild(iface, 'type_identifier') || findChild(iface, 'identifier');
      if (typeName) {
        ctx.classes.push({ name, implements: typeName.text, line: node.startPosition.row + 1 });
      }
    }
  }
}
