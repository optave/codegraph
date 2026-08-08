import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import {
  extractBodyMembers,
  findParentNode,
  MAX_WALK_DEPTH,
  nodeEndLine,
  rustVisibility,
  setTypeMapEntry,
} from './helpers.js';

/**
 * Extract symbols from Rust files.
 */
export function extractRustSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
    returnTypeMap: new Map(),
    callAssignments: [],
  };

  walkRustNode(tree.rootNode, ctx);
  extractRustTypeMap(tree.rootNode, ctx);
  extractRustReturnTypeMap(tree.rootNode, ctx);
  // Must run after typeMap is populated — resolves `receiver.method()` call
  // assignments against locally-typed receivers (mirrors javascript.ts's ordering).
  extractRustCallAssignments(tree.rootNode, ctx);
  return ctx;
}

function walkRustNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_item':
      handleRustFuncItem(node, ctx);
      break;
    case 'struct_item':
      handleRustStructItem(node, ctx);
      break;
    case 'enum_item':
      handleRustEnumItem(node, ctx);
      break;
    case 'const_item':
      handleRustConstItem(node, ctx);
      break;
    case 'trait_item':
      handleRustTraitItem(node, ctx);
      break;
    case 'impl_item':
      handleRustImplItem(node, ctx);
      break;
    case 'use_declaration':
      handleRustUseDecl(node, ctx);
      break;
    case 'call_expression':
      handleRustCallExpr(node, ctx);
      break;
    case 'macro_invocation':
      handleRustMacroInvocation(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkRustNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleRustFuncItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip default-impl functions already emitted by handleRustTraitItem
  if (node.parent?.parent?.type === 'trait_item') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const implType = findCurrentImpl(node);
  const fullName = implType ? `${implType}.${nameNode.text}` : nameNode.text;
  const kind = implType ? 'method' : 'function';
  const params = extractRustParameters(node.childForFieldName('parameters'));
  ctx.definitions.push({
    name: fullName,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: rustVisibility(node),
  });
}

function handleRustStructItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const fields = extractStructFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: fields.length > 0 ? fields : undefined,
    visibility: rustVisibility(node),
  });
  seedRustStructFieldTypes(node, nameNode.text, ctx);
}

/**
 * Seed `${StructName}.${fieldName}` → field-type entries in ctx.typeMap so
 * `self.field.method()` inside the struct's own impl methods resolves via the
 * class-scoped receiver lookup — mirrors JS's `this.field` class-scoped typing
 * (issues #1323, #1458) and fixes #1876's `self.field` false negatives.
 */
function seedRustStructFieldTypes(
  structNode: TreeSitterNode,
  structName: string,
  ctx: ExtractorOutput,
): void {
  if (!ctx.typeMap) return;
  const body = structNode.childForFieldName('body');
  if (!body) return;
  for (let i = 0; i < body.childCount; i++) {
    const field = body.child(i);
    if (field?.type !== 'field_declaration') continue;
    const fieldName = field.childForFieldName('name');
    const typeNode = field.childForFieldName('type');
    if (!fieldName || !typeNode) continue;
    const typeName = extractRustTypeName(typeNode);
    if (typeName) setTypeMapEntry(ctx.typeMap, `${structName}.${fieldName.text}`, typeName, 0.9);
  }
}

function handleRustEnumItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const variants = extractEnumVariants(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: variants.length > 0 ? variants : undefined,
  });
}

function handleRustConstItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'constant',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleRustTraitItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'trait',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
  const body = node.childForFieldName('body');
  if (body) extractTraitMethods(body, nameNode.text, ctx);
}

/** Extract method signatures/definitions from a trait body. */
function extractTraitMethods(body: TreeSitterNode, traitName: string, ctx: ExtractorOutput): void {
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (child && (child.type === 'function_signature_item' || child.type === 'function_item')) {
      const methName = child.childForFieldName('name');
      if (methName) {
        ctx.definitions.push({
          name: `${traitName}.${methName.text}`,
          kind: 'method',
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          bodyless: !child.childForFieldName('body'),
        });
      }
    }
  }
}

function handleRustImplItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const typeNode = node.childForFieldName('type');
  const traitNode = node.childForFieldName('trait');
  if (typeNode && traitNode) {
    ctx.classes.push({
      name: typeNode.text,
      implements: traitNode.text,
      line: node.startPosition.row + 1,
    });
  }
}

function handleRustUseDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const argNode = node.child(1);
  if (!argNode) return;
  const usePaths = extractRustUsePath(argNode);
  for (const imp of usePaths) {
    ctx.imports.push({
      source: imp.source,
      names: imp.names,
      line: node.startPosition.row + 1,
      rustUse: true,
    });
  }
}

function handleRustCallExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  const call = extractRustCallInfo(fn, node.startPosition.row + 1);
  if (call) ctx.calls.push(call);
}

/** Extract call info from a Rust call function node. */
function extractRustCallInfo(fn: TreeSitterNode, line: number): Call | null {
  if (fn.type === 'identifier') return { name: fn.text, line };
  if (fn.type === 'field_expression') {
    const field = fn.childForFieldName('field');
    if (!field) return null;
    const value = fn.childForFieldName('value');
    const call: Call = { name: field.text, line };
    if (value) call.receiver = value.text;
    return call;
  }
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name');
    if (!name) return null;
    const path = fn.childForFieldName('path');
    const call: Call = { name: name.text, line };
    if (path) call.receiver = path.text;
    return call;
  }
  return null;
}

function handleRustMacroInvocation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const macroNode = node.child(0);
  if (macroNode) {
    ctx.calls.push({ name: `${macroNode.text}!`, line: node.startPosition.row + 1 });
  }
  // Macro arguments (`println!("{}", user.display_name())`) are an opaque
  // `token_tree` to tree-sitter-rust — macros can have arbitrary token syntax, so
  // the grammar never parses their contents into call_expression/field_expression
  // nodes the way it does everywhere else. walkRustNode's generic recursion still
  // visits every token inside, but none of them match `call_expression`, so a real
  // call embedded in a macro argument (the common `println!`/`format!`/`write!`/
  // `assert!` case) was silently invisible to call-edge resolution. Scan the flat
  // token sequence directly for the two call shapes tree-sitter still tokenizes
  // recognizably — bare `ident(...)` and single-hop method `ident.ident(...)` — and
  // record them the same way handleRustCallExpr would (#2214).
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'token_tree') scanMacroTokensForCalls(child, ctx);
  }
}

function scanMacroTokensForCalls(tokenTree: TreeSitterNode, ctx: ExtractorOutput): void {
  const children: TreeSitterNode[] = [];
  for (let i = 0; i < tokenTree.childCount; i++) {
    const child = tokenTree.child(i);
    if (child) children.push(child);
  }
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (!c) continue;
    if (c.type === 'token_tree') {
      scanMacroTokensForCalls(c, ctx);
      continue;
    }
    if (c.type !== 'identifier') continue;

    // `receiver . method ( ... )` — single-hop method call.
    const dot = children[i + 1];
    const methodName = children[i + 2];
    const argsAfterMethod = children[i + 3];
    if (
      dot?.type === '.' &&
      methodName?.type === 'identifier' &&
      argsAfterMethod?.type === 'token_tree' &&
      argsAfterMethod.text.startsWith('(')
    ) {
      ctx.calls.push({
        name: methodName.text,
        line: methodName.startPosition.row + 1,
        receiver: c.text,
      });
      i += 3;
      continue;
    }

    // Bare `name ( ... )` — free-function call.
    const argsAfterBare = children[i + 1];
    if (argsAfterBare?.type === 'token_tree' && argsAfterBare.text.startsWith('(')) {
      ctx.calls.push({ name: c.text, line: c.startPosition.row + 1 });
      i += 1;
    }
  }
}

const RUST_IMPL_TYPES = ['impl_item'] as const;
function findCurrentImpl(node: TreeSitterNode): string | null {
  return findParentNode(node, RUST_IMPL_TYPES, 'type');
}

// ── Child extraction helpers ────────────────────────────────────────────────

function extractRustParameters(paramListNode: TreeSitterNode | null): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  if (!paramListNode) return params;
  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (!param) continue;
    if (param.type === 'self_parameter') {
      // Skip self — matches native engine behaviour
    } else if (param.type === 'parameter') {
      const pattern = param.childForFieldName('pattern');
      if (pattern) {
        params.push({ name: pattern.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function extractStructFields(structNode: TreeSitterNode): SubDeclaration[] {
  return extractBodyMembers(
    structNode,
    ['body', 'field_declaration_list'],
    'field_declaration',
    'property',
  );
}

function extractEnumVariants(enumNode: TreeSitterNode): SubDeclaration[] {
  return extractBodyMembers(enumNode, ['body', 'enum_variant_list'], 'enum_variant', 'constant');
}

function extractRustTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractRustTypeMapDepth(node, ctx, 0);
}

/** True if `name` matches a struct defined in this file (walkRustNode runs before this). */
function isKnownUnitStruct(name: string, ctx: ExtractorOutput): boolean {
  return ctx.definitions.some((d) => d.kind === 'struct' && d.name === name);
}

function extractRustTypeMapDepth(node: TreeSitterNode, ctx: ExtractorOutput, depth: number): void {
  if (depth >= MAX_WALK_DEPTH) return;

  // let x: MyType = ...
  if (node.type === 'let_declaration') {
    const pattern = node.childForFieldName('pattern');
    const typeNode = node.childForFieldName('type');
    if (pattern && pattern.type === 'identifier' && typeNode) {
      const typeName = extractRustTypeName(typeNode);
      if (typeName && ctx.typeMap) setTypeMapEntry(ctx.typeMap, pattern.text, typeName, 0.9);
    } else if (pattern && pattern.type === 'identifier' && !typeNode) {
      // let x = TypeName;  — a bare capitalized identifier value binds a
      // unit-struct instance (e.g. `let v = NameValidator;` for `struct
      // NameValidator;`), not a reference to another variable (#1876).
      // Requiring a same-file `struct` definition excludes unit enum variants
      // like `None`/`Ok` (Option/Result, always in scope) and any custom
      // fieldless variant brought into scope via `use Enum::Variant` — those
      // also parse as a bare capitalized identifier but are values, not types
      // (Greptile review). A struct defined elsewhere in the crate is missed,
      // same as every other same-file-only heuristic in this extractor.
      const valueNode = node.childForFieldName('value');
      if (
        valueNode?.type === 'identifier' &&
        /^[A-Z]/.test(valueNode.text) &&
        ctx.typeMap &&
        isKnownUnitStruct(valueNode.text, ctx)
      ) {
        setTypeMapEntry(ctx.typeMap, pattern.text, valueNode.text, 0.7);
      }
    }
  }

  // fn foo(x: MyType) — parameter node has pattern + type fields
  if (node.type === 'parameter') {
    const pattern = node.childForFieldName('pattern');
    const typeNode = node.childForFieldName('type');
    if (pattern && typeNode) {
      const name = pattern.type === 'identifier' ? pattern.text : null;
      if (name && name !== 'self' && name !== '&self' && name !== '&mut self') {
        const typeName = extractRustTypeName(typeNode);
        if (typeName && ctx.typeMap) setTypeMapEntry(ctx.typeMap, name, typeName, 0.9);
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractRustTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractRustTypeName(typeNode: TreeSitterNode): string | null {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === 'type_identifier' || t === 'identifier') return typeNode.text;
  if (t === 'scoped_type_identifier') return typeNode.text;
  // Reference: &MyType or &mut MyType → MyType
  if (t === 'reference_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      const child = typeNode.child(i);
      if (child && (child.type === 'type_identifier' || child.type === 'scoped_type_identifier')) {
        return child.text;
      }
    }
  }
  // For every OTHER generic type (Vec<T>, HashMap<K, V>, a user-defined
  // Container<T>, ...), keep the original nominal-base-name behavior — impl
  // blocks' own qualified names use the source-literal generic syntax too
  // (`impl<T> Container<T>` extracts as "Container<T>", not "Container"), so a
  // concretely-instantiated receiver ("Container<User>") could never match it
  // either way; but CHA/RTA's instantiated-types matching (buildChaContext in
  // cha.ts) DOES compare bare typeMap entries against trait-implementor names,
  // so keeping other generics parameterized here would silently break that
  // unrelated, currently-working nominal match (Greptile review, PR #2371).
  // Option/Result are the only shapes this fix actually needs full text for — a
  // Some(x)/Ok(x) if-let/while-let binding's real type is the type ARGUMENT, not
  // the wrapper, and unwrapOptionResultType() in build-edges.ts needs that
  // argument text to compute it.
  if (t === 'generic_type') {
    const text = typeNode.text;
    const base = text.split('<')[0]?.trim() ?? text;
    return isOptionOrResultBase(base) ? text : base;
  }
  return null;
}

/**
 * True when `base` names Option/Result, bare (`Option`) or fully qualified
 * (`std::option::Option`, `core::result::Result`) — both spellings are valid
 * Rust and equally common in a `-> ReturnType` position. Mirrors
 * `is_option_or_result_base` in `rust_lang.rs` and is checked identically at
 * unwrap time by `unwrapOptionResultType` in `build-edges.ts` (#2214, Greptile
 * review on PR #2371 — a qualified spelling was silently treated as an
 * unrelated generic, dropping the type argument a Some(x)/Ok(x) binding needs).
 */
export function isOptionOrResultBase(base: string): boolean {
  return (
    base === 'Option' || base === 'Result' || base.endsWith('::Option') || base.endsWith('::Result')
  );
}

/**
 * If `pattern` is a single-argument `Some(x)`/`Ok(x)` tuple-struct pattern,
 * return its inner `x` pattern — so `if let Some(x) = expr`/`if let Ok(x) = expr`
 * (and the `while let`/`let-else` equivalents) can be treated as a call-assignment
 * binding `x`, the same way `let x = expr;` already is. Returns `pattern`
 * unchanged for any other shape (a bare identifier, `None`, `Err(_)`, or any
 * other variant this isn't confident unwrapping). Mirrors
 * `unwrap_option_result_pattern` in `rust_lang.rs`.
 */
function unwrapOptionResultPattern(pattern: TreeSitterNode): TreeSitterNode {
  if (pattern.type !== 'tuple_struct_pattern') return pattern;
  const typeNode = pattern.childForFieldName('type');
  if (!typeNode) return pattern;
  const variant = typeNode.text;
  if (variant !== 'Some' && variant !== 'Ok') return pattern;
  for (let i = 0; i < pattern.namedChildCount; i++) {
    const child = pattern.namedChild(i);
    if (child && child.id !== typeNode.id) return child;
  }
  return pattern;
}

// ── Return-type map extraction (Phase 8.2 parity, #1876) ────────────────────

/**
 * Populate ctx.returnTypeMap with declared `-> ReturnType` return types for
 * free functions and impl methods, resolving `Self` to the enclosing impl's
 * type name. Consumed by build-edges.ts's `propagateReturnTypesAcrossFiles`
 * (Phase 8.2) — the same generic cross-file mechanism the JS/TS extractor
 * feeds — so a local var typed from a cross-file call's return value
 * (`let service = build_service();`) resolves without any Rust-specific
 * propagation logic.
 */
function extractRustReturnTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractRustReturnTypeMapDepth(node, ctx, 0);
}

function extractRustReturnTypeMapDepth(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  depth: number,
): void {
  if (depth >= MAX_WALK_DEPTH) return;
  // Skip default-impl functions inside traits, matching handleRustFuncItem —
  // their return type is not tied to a concrete implementing type.
  if (node.type === 'function_item' && node.parent?.parent?.type !== 'trait_item') {
    storeRustReturnType(node, ctx);
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractRustReturnTypeMapDepth(child, ctx, depth + 1);
  }
}

/** Extract the return type of a function/method node and store it in ctx.returnTypeMap. */
function storeRustReturnType(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (!ctx.returnTypeMap) return;
  const nameNode = node.childForFieldName('name');
  const returnTypeNode = node.childForFieldName('return_type');
  if (!nameNode || !returnTypeNode) return;
  const rawType = extractRustTypeName(returnTypeNode);
  if (!rawType) return;
  const implType = findCurrentImpl(node);
  // `-> Self` inside an impl block returns the concrete implementing type.
  const typeName = rawType === 'Self' && implType ? implType : rawType;
  const fullName = implType ? `${implType}.${nameNode.text}` : nameNode.text;
  const existing = ctx.returnTypeMap.get(fullName);
  if (!existing || existing.confidence < 1.0) {
    ctx.returnTypeMap.set(fullName, { type: typeName, confidence: 1.0 });
  }
}

// ── Call-assignment extraction (Phase 8.2 parity, #1876) ─────────────────────

/**
 * Record `let x = callee(...);` bindings into ctx.callAssignments so
 * build-edges.ts's cross-file return-type propagation can type `x` from
 * `callee`'s declared return type. Handles three call shapes:
 *   - bare function call (`build_service()`) — calleeName only, resolved
 *     against the file's imports by the generic propagation pass.
 *   - associated-function call (`Type::assoc_fn()`) — the type is already
 *     spelled out in the call syntax, so receiverTypeName is the literal
 *     path text (no typeMap lookup needed).
 *   - method call on a locally-typed receiver (`x.method()`) — receiverTypeName
 *     is resolved from ctx.typeMap at extraction time, mirroring the
 *     JS/TS extractor's member_expression case.
 */
function extractRustCallAssignments(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractRustCallAssignmentsDepth(node, ctx, 0);
}

function extractRustCallAssignmentsDepth(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  depth: number,
): void {
  if (depth >= MAX_WALK_DEPTH) return;
  // `let_declaration` covers `let x = expr;` (and `let Some(x) = expr else {...};`
  // let-else); `let_condition` is the `if let`/`while let` condition node (#2214) —
  // both have `pattern`/`value` fields shaped identically.
  if (node.type === 'let_declaration' || node.type === 'let_condition') {
    recordRustCallAssignment(node, ctx);
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractRustCallAssignmentsDepth(child, ctx, depth + 1);
  }
}

function recordRustCallAssignment(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (!ctx.callAssignments) return;
  const rawPattern = node.childForFieldName('pattern');
  const value = node.childForFieldName('value');
  if (!rawPattern || value?.type !== 'call_expression') return;
  const pattern = unwrapOptionResultPattern(rawPattern);
  const unwrapGeneric = pattern.id !== rawPattern.id;
  if (pattern.type !== 'identifier') return;
  // A bare fieldless-variant/unit-struct pattern (`if let None = expr`, `if let
  // NameValidator = expr`) is syntactically identical to a variable binding —
  // tree-sitter has no way to distinguish them by grammar alone. By Rust
  // convention a real binding is snake_case, so an uppercase-leading name is a
  // pattern match against a value, not a new variable — recording it as one
  // would fabricate a call-assignment for a variable that doesn't exist (#2214).
  if (/^[A-Z]/.test(pattern.text)) return;
  const fn = value.childForFieldName('function');
  if (!fn) return;
  const varName = pattern.text;

  if (fn.type === 'identifier') {
    ctx.callAssignments.push({ varName, calleeName: fn.text, unwrapGeneric });
    return;
  }
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name');
    const path = fn.childForFieldName('path');
    if (name && path) {
      ctx.callAssignments.push({
        varName,
        calleeName: name.text,
        receiverTypeName: path.text,
        unwrapGeneric,
      });
    }
    return;
  }
  if (fn.type === 'field_expression') {
    const field = fn.childForFieldName('field');
    const receiver = fn.childForFieldName('value');
    if (field && receiver?.type === 'identifier') {
      const receiverEntry = ctx.typeMap?.get(receiver.text);
      const receiverTypeName =
        typeof receiverEntry === 'string' ? receiverEntry : receiverEntry?.type;
      // Preserve the raw receiver identifier even when its type isn't known yet
      // at extraction time (e.g. `service` in `service.get_user(1)`, whose type
      // only becomes known via cross-file return-type propagation) so injection
      // can retry resolution once the receiver's own call-assignment has itself
      // been injected earlier in the same pass (#2214).
      const receiverVarName = receiverTypeName === undefined ? receiver.text : undefined;
      ctx.callAssignments.push({
        varName,
        calleeName: field.text,
        receiverTypeName,
        receiverVarName,
        unwrapGeneric,
      });
    }
  }
}

/** Collect names from a scoped_use_list's list node. */
function collectScopedNames(listNode: TreeSitterNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'self') {
      names.push(child.text);
    } else if (child.type === 'use_as_clause') {
      const name = (child.childForFieldName('alias') || child.childForFieldName('name'))?.text;
      if (name) names.push(name);
    }
  }
  return names;
}

function extractRustUsePath(node: TreeSitterNode | null): { source: string; names: string[] }[] {
  if (!node) return [];

  switch (node.type) {
    case 'use_list': {
      const results: { source: string; names: string[] }[] = [];
      for (let i = 0; i < node.childCount; i++) {
        results.push(...extractRustUsePath(node.child(i)));
      }
      return results;
    }
    case 'scoped_use_list': {
      const pathNode = node.childForFieldName('path');
      const listNode = node.childForFieldName('list');
      const prefix = pathNode ? pathNode.text : '';
      if (!listNode) return [{ source: prefix, names: [] }];
      return [{ source: prefix, names: collectScopedNames(listNode) }];
    }
    case 'use_as_clause': {
      const name = node.childForFieldName('alias') || node.childForFieldName('name');
      return [{ source: node.text, names: name ? [name.text] : [] }];
    }
    case 'use_wildcard': {
      const pathNode = node.childForFieldName('path');
      return [{ source: pathNode ? pathNode.text : '*', names: ['*'] }];
    }
    case 'scoped_identifier':
    case 'identifier': {
      const text = node.text;
      const lastName = text.split('::').pop() ?? text;
      return [{ source: text, names: [lastName] }];
    }
    default:
      return [];
  }
}
