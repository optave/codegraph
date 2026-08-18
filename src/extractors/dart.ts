import type {
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
  TypeMapEntry,
} from '../types.js';
import { findChild, nodeEndLine, setScopedTypeMapEntry, setTypeMapEntry } from './helpers.js';

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
    case 'constructor_param':
      handleDartConstructorParamTypeMap(node, ctx);
      break;
    case 'formal_parameter':
      handleDartFormalParamTypeMap(node, ctx);
      break;
    case 'initialized_variable_definition':
      handleDartLocalVarTypeMap(node, ctx);
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
      // Field declaration (not a bodyless signature) — seed typeMap from its
      // declared type, if any (#2319). `var x = Foo();` has no explicit type
      // node to read here — inferring one from the initializer is a separate,
      // out-of-scope problem — so this is a no-op for that shape.
      handleDartFieldDeclTypeMap(member, className, ctx.typeMap);
      // Field declarations — every real field-declaration shape (`final Foo
      // x;`, `Foo x;`, `late Foo x;`, `Foo? x;`) nests its identifier TWO
      // levels deep (`declaration -> initialized_identifier_list ->
      // initialized_identifier -> identifier`); Dart requires every field to
      // carry a var/final/const/late/type modifier, so `identifier` is never
      // a direct child of `declaration` itself — a direct-child scan here
      // silently found nothing for any real field, leaving `children` always
      // empty (#2475). Mirrors `handleDartFieldDeclTypeMap`'s identical
      // traversal, including its handling of a comma-separated multi-field
      // declaration (`final Foo a, b;` declares BOTH `a` and `b`).
      const identifierList = findChild(member, 'initialized_identifier_list');
      if (identifierList) {
        for (let j = 0; j < identifierList.childCount; j++) {
          const item = identifierList.child(j);
          if (item?.type !== 'initialized_identifier') continue;
          const nameNode = findChild(item, 'identifier');
          if (nameNode) {
            children.push({
              name: nameNode.text,
              kind: 'property',
              line: member.startPosition.row + 1,
            });
          }
        }
      }
    }
  }
}

/**
 * Seed a class-scoped typeMap entry for a Dart instance field, mirroring
 * `handleFieldDefTypeMap`'s convention in `src/extractors/javascript.ts`:
 * a primary class-scoped key (`ClassName.field`, confidence 0.9) so two
 * classes with identically-named fields of different types don't overwrite
 * each other's entry, plus lower-confidence bare-name fallbacks (`field`,
 * `this.field`, confidence 0.6) for callers the resolver can't attribute to
 * a specific class (e.g. no `callerName` in scope at all).
 *
 * Idiomatic Dart reads a field with a bare identifier — `_repo.findById()`
 * inside the SAME class means `this._repo` implicitly, unlike JS/TS, which
 * requires an explicit `this.` prefix for every field read. `dart.ts`'s
 * receiver extraction (`findDartSelectorReceiver`) normalises that implicit
 * shape by emitting the receiver text itself as `this.<name>` (matching the
 * JS/TS convention textually) WHENEVER the identifier isn't shadowed by a
 * same-named parameter of the enclosing function (see that function's own
 * doc comment for the shadowing case, #2319 second follow-up), so
 * `resolveReceiverTypeName` in `src/domain/graph/resolver/strategy.ts`
 * treats a bare Dart field receiver exactly like a JS/TS `this.field` one:
 * it strips the `this.` prefix and tries the class-scoped key
 * (`ClassName.field`) FIRST, before ever falling back to these
 * bare/`this.`-prefixed keys. That is what actually prevents two classes in
 * the same file from cross-contaminating each other's same-named field's
 * method resolution (#2319 first follow-up on PR #2477's Greptile finding —
 * see `findDartSelectorReceiver`'s own doc comment for the extraction-side
 * half of this fix). The bare/`this.`-prefixed keys seeded here remain as
 * the fallback for any caller the resolver can't scope to a class at all.
 *
 * `setTypeMapEntry`'s higher-confidence-wins merge means calling this
 * multiple times for the same field (e.g. once from the field declaration,
 * once from a `this.field` constructor-shorthand param that carries its own
 * inline type) is always safe — whichever call provides a type "wins" the
 * key, and identical types from both calls are a no-op.
 */
function seedDartFieldTypeMapEntry(
  typeMap: Map<string, TypeMapEntry>,
  className: string | null,
  fieldName: string,
  typeName: string,
): void {
  if (className) {
    setTypeMapEntry(typeMap, `${className}.${fieldName}`, typeName, 0.9);
    setTypeMapEntry(typeMap, fieldName, typeName, 0.6);
    setTypeMapEntry(typeMap, `this.${fieldName}`, typeName, 0.6);
  } else {
    // No enclosing class (shouldn't happen for a real Dart field — members
    // are always inside a class_body — kept for defensive symmetry with
    // handleFieldDefTypeMap's own "no enclosing class" branch).
    setTypeMapEntry(typeMap, fieldName, typeName, 0.9);
    setTypeMapEntry(typeMap, `this.${fieldName}`, typeName, 0.9);
  }
}

/**
 * Extract the declared type name from a class-field `declaration` node
 * (`final UserRepository _repo;`, `UserRepository? _repo;`, `late Foo _f;`).
 * `type_identifier` is always a DIRECT child of `declaration` in this WASM
 * engine's tree-sitter-dart grammar (confirmed by parsing several field
 * variants — final/late/nullable/generic — with tree-sitter-dart; #2319); a
 * generic's type arguments (`List<User>`) are a separate `type_arguments`
 * sibling and a nullable `?` a separate token sibling, so reading only the
 * `type_identifier` node's own text already yields the simple base type name
 * with no further stripping needed (unlike TypeScript's `type_annotation`
 * shape, which `extractSimpleTypeName` in `javascript.ts` has to unwrap).
 * Returns null when there's no explicit type at all (`var x = Foo();`) —
 * inferring one from the initializer is a separate, out-of-scope problem.
 */
function extractDartDeclaredTypeName(declNode: TreeSitterNode): string | null {
  const typeNode = findChild(declNode, 'type_identifier');
  return typeNode ? typeNode.text : null;
}

/**
 * Seed typeMap entries for every field name declared by a class-field
 * `declaration` node, e.g. `final Foo a, b;` declares BOTH `a` and `b` at
 * type `Foo` (comma-separated multi-identifier fields, confirmed by parsing
 * with tree-sitter-dart; #2319). No-ops when the declaration has no explicit
 * type (see `extractDartDeclaredTypeName`) or isn't shaped like a field at
 * all (already filtered by the caller, which checks for a bodyless
 * signature first).
 */
function handleDartFieldDeclTypeMap(
  declNode: TreeSitterNode,
  className: string,
  typeMap: Map<string, TypeMapEntry>,
): void {
  const typeName = extractDartDeclaredTypeName(declNode);
  if (!typeName) return;
  const list = findChild(declNode, 'initialized_identifier_list');
  if (!list) return;
  for (let i = 0; i < list.childCount; i++) {
    const item = list.child(i);
    if (item?.type !== 'initialized_identifier') continue;
    // The identifier is the field's own name — always the FIRST `identifier`
    // child in document order, even when the declaration also carries an
    // initializer (`final Foo x = Foo();` has a SECOND `identifier` for the
    // `Foo` constructor call on the right-hand side; #2319).
    const nameNode = findChild(item, 'identifier');
    if (nameNode) seedDartFieldTypeMapEntry(typeMap, className, nameNode.text, typeName);
  }
}

/**
 * `this.field` constructor-shorthand parameter (`UserService(this._repo)`).
 * Normally this needs no typeMap seeding of its own — the field's own
 * declaration (`handleDartFieldDeclTypeMap`) already provides the type, and
 * the shorthand param only confirms initialization, not a new type.
 *
 * However, Dart's grammar permits an EXPLICIT inline type on a field-formal
 * parameter (`UserService(UserRepository this._repo)` — used e.g. to narrow
 * a covariant field's type at the constructor boundary; confirmed parseable,
 * producing a `type_identifier` sibling inside `constructor_param`, with
 * tree-sitter-dart; #2319). That IS a genuine explicit type annotation (not
 * initializer-based inference), and it's the ONLY source of type info when
 * the field's own declaration has no explicit type of its own (`var _repo;`)
 * — so it gets the same seeding treatment as a field declaration.
 * `setTypeMapEntry`'s higher-confidence-wins merge makes this safe to call
 * unconditionally alongside the field declaration's own seeding.
 */
function handleDartConstructorParamTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const typeNode = findChild(node, 'type_identifier');
  if (!typeNode) return;
  const nameNode = findChild(node, 'identifier');
  if (!nameNode) return;
  const className = findEnclosingDartClassName(node);
  seedDartFieldTypeMapEntry(ctx.typeMap, className, nameNode.text, typeNode.text);
}

/**
 * Seed a function-scoped typeMap entry (`${enclosingQualifier}::${name}`,
 * confidence 0.9) for a PLAIN typed function/method parameter — `void
 * run(MockRepository repo)` — mirroring `handleParamTypeMap`'s identical
 * convention in `src/extractors/javascript.ts` (`setScopedTypeMapEntry`,
 * #2235).
 *
 * No-ops for the `this.field`/`super.field` constructor-shorthand parameter
 * shape (detected by the presence of a `constructor_param` child): that
 * shape introduces no NEW local name distinct from the field it aliases —
 * `handleDartConstructorParamTypeMap` already seeds its type, keyed to the
 * FIELD, which is what a bare access to that name should keep resolving to.
 * Also no-ops for an untyped parameter (`var repo` / bare `repo`, implicit
 * `dynamic`) — there is no type to seed (mirrors `extractDartDeclaredTypeName`'s
 * identical "no explicit type" no-op for field declarations).
 *
 * This is the seeding half of the fix for a Greptile finding on PR #2477
 * (#2319 second follow-up): a method parameter that happens to share a
 * class field's name legally SHADOWS that field for the rest of its scope —
 * `void run(MockRepository _repo) { _repo.mockOnlyMethod(); }` inside a
 * class whose OWN field `_repo` is typed `Repository` must resolve against
 * the PARAMETER's type, not the field's. `findDartSelectorReceiver`'s
 * shadowing check (see its own doc comment) suppresses the `this.`-prefix
 * for a shadowed receiver so the class-scoped field lookup
 * (`resolveReceiverTypeName` in `src/domain/graph/resolver/strategy.ts`) is
 * skipped entirely for that call site — but skipping the prefix ALONE is not
 * sufficient: the field's own bare fallback key (seeded by
 * `seedDartFieldTypeMapEntry` at confidence 0.6, unconditionally, regardless
 * of any shadowing elsewhere in the file) would still match via
 * `resolveReceiverTypeName`'s final `typeMap.get(effectiveReceiver)` fallback
 * step. Seeding THIS function-scoped entry gives that same lookup cascade a
 * higher-priority (checked before the bare fallback), correctly-typed key to
 * find first — `${callerName}::${effectiveReceiver}` — resolving to the
 * parameter's own type instead (or to nothing, if that type itself doesn't
 * resolve to a real class — never to the field's type).
 */
function handleDartFormalParamTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (findChild(node, 'constructor_param')) return;
  const typeNode = findChild(node, 'type_identifier');
  if (!typeNode) return;
  const nameNode = findChild(node, 'identifier');
  if (!nameNode) return;
  const enclosingQualifier = findEnclosingDartFunctionQualifierForParam(node);
  setScopedTypeMapEntry(ctx.typeMap, enclosingQualifier, nameNode.text, typeNode.text, 0.9);
}

/**
 * Seed a function-scoped typeMap entry for `var svc = UserService(repo);`
 * (#2474).
 *
 * tree-sitter-dart's two grammar versions structure this differently, same
 * class of divergence `handleDartConstructorCall` already documents:
 *
 * - Native (crates.io tree-sitter-dart 0.2): a clean single `value:` field
 *   pointing straight at a `(call_expression function: (identifier)
 *   arguments: (...))`.
 * - WASM (npm tree-sitter-dart 1.x): confirmed by direct parse dump — this
 *   grammar has `value:` field markers on TWO different children of
 *   `initialized_variable_definition`: the bare callee `identifier`
 *   (`UserRepository`) AND the trailing `selector` node carrying the call's
 *   `argument_part` (`()`). `childForFieldName('value')` only ever returns
 *   the FIRST match — the bare identifier, never a `call_expression` node at
 *   all — so checking merely "does a `value` field exist" (as an earlier
 *   version of this function did) wrongly took the native branch and bailed
 *   out before ever reaching the correct lookup below. The fix is to gate on
 *   the value field's TYPE, not its presence: WASM's `value` identifier
 *   isn't a `call_expression`, so it falls through to a sibling scan for the
 *   `selector` node, then takes ITS immediately preceding sibling as the
 *   callee — exactly Layout C, the same shape `resolveDartSelectorCall`'s
 *   own doc comment documents for `var w = Foo();` / `helper();`.
 *
 * No-ops for any other initializer shape (a literal, a bare identifier
 * reference, an `await` expression, …) — there is no statically-knowable
 * constructor type to seed, mirroring `handleDartFieldDeclTypeMap`'s
 * identical "no explicit type" no-op.
 *
 * Also requires the callee to be capitalized (Greptile finding on this PR):
 * unlike JS/TS's `new` keyword, Dart lets a constructor call omit `new`
 * entirely, so `Foo()` and `foo()` are syntactically identical
 * `call_expression`s at this position — tree-sitter-dart gives no node-kind
 * signal to tell "constructor call" apart from "ordinary function call that
 * happens to return an object" (confirmed: even a genuine `UserRepository()`
 * constructor call parses its callee as a plain `identifier`, not
 * `type_identifier`, in this position). Without this gate, an ordinary
 * factory FUNCTION call (`var svc = makeService();`) would be seeded as if
 * `svc`'s type were the literal function name `makeService`. Gating on
 * capitalization matches Dart's own type-naming convention (enforced by the
 * language's default `camel_case_types` lint) and this file's own existing
 * precedent for the identical ambiguity in JS/TS (`/^[A-Z]/` in
 * `handleJsxElementRef` / `extractCallArgumentIdentifierRefs`) — deliberately
 * a plain ASCII `/^[A-Z]/` test, not a `toLowerCase()`-based Unicode
 * comparison, so the native/Rust mirror can use `is_ascii_uppercase()` and
 * agree byte-for-byte without the astral-plane/titlecase divergence risk
 * #2396 already found in the fuller Unicode-aware heuristic.
 *
 * Capitalization only narrows, not eliminates, the ambiguity: a legally
 * uppercase ordinary function (`OrderService MakeOrderService() {...}`) is
 * still indistinguishable from a constructor call here, and — confirmed via
 * a dual-engine integration test during review — wrongly guessing its name
 * as the type can cause a later receiver call through that local to lose its
 * edge (both `resolveByReceiver` in resolver/strategy.ts and
 * `resolve_call_targets_core` in build_edges.rs skip the untyped
 * direct-qualified fallback whenever ANY typeMap entry exists for the
 * receiver, right or wrong — a pre-existing, language-agnostic property of
 * the shared resolver, not something introduced here). Seeded at confidence
 * 0.7 rather than 1.0 — the same tier as JS/TS's own `Foo.create()` factory
 * heuristic in `handleCallExprTypeMap`, which carries the identical
 * capitalization-based uncertainty — so a more certain entry from elsewhere
 * wins any `dedup_type_map` tie. Closing the residual gap needs either a
 * shared-resolver change (fall through to the untyped fallback when the
 * type-aware tier finds nothing, across every language using this cascade)
 * or a same-file "is this name already a known ordinary function?"
 * cross-check — the latter requires refactoring this file's single-pass
 * `walkDartNode` into the two-pass design `dart.rs` and `javascript.ts`
 * already use, since a single-pass check would be declaration-order-
 * dependent and diverge from the (order-independent) native engine. Both
 * options are out of scope for this fix — tracked in #2568.
 *
 * Seeds unconditionally, regardless of whether this local happens to shadow
 * a same-named class field — `findDartSelectorReceiver` /
 * `findEnclosingDartShadowingLocalName` (#2478) is what decides, at each
 * call site, whether a bare receiver should resolve against this seeded
 * local-scoped entry or the field's own class-scoped one; this function
 * only needs to make the local's own type available for that later lookup
 * to find.
 */
function handleDartLocalVarTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (nameNode?.type !== 'identifier') return;

  const valueNode = node.childForFieldName('value');
  if (valueNode?.type === 'call_expression') {
    const fnNode = valueNode.childForFieldName('function');
    if (!fnNode || (fnNode.type !== 'identifier' && fnNode.type !== 'type_identifier')) return;
    if (!/^[A-Z]/.test(fnNode.text)) return;
    const enclosingQualifier = findEnclosingDartFunctionQualifierForBody(node);
    setScopedTypeMapEntry(ctx.typeMap, enclosingQualifier, nameNode.text, fnNode.text, 0.7);
    return;
  }

  // WASM grammar: `value` (if present at all) is the bare callee identifier,
  // not a call_expression — find the `selector` child carrying the call
  // (`argument_part`) instead, then take ITS immediately preceding sibling
  // as the callee, mirroring `resolveDartSelectorCall`'s identical Layout C
  // lookup.
  for (let i = 1; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type !== 'selector' || !findChild(child, 'argument_part')) continue;
    const callee = node.child(i - 1);
    if (
      callee &&
      (callee.type === 'identifier' || callee.type === 'type_identifier') &&
      callee.id !== nameNode.id &&
      /^[A-Z]/.test(callee.text)
    ) {
      const enclosingQualifier = findEnclosingDartFunctionQualifierForBody(node);
      setScopedTypeMapEntry(ctx.typeMap, enclosingQualifier, nameNode.text, callee.text, 0.7);
    }
    return;
  }
}

/**
 * Nearest enclosing class name for class-scoped typeMap keys — walks the
 * node's ancestor chain looking for the nearest `class_definition`, mirroring
 * `enclosing_type_map_class` in
 * `crates/codegraph-core/src/extractors/javascript.rs` (an ancestor-walk,
 * rather than javascript.ts's top-down `currentClass` threading, since
 * `walkDartNode` doesn't thread class context through its recursive walk —
 * matching this file's own existing `isInsideDartClass`, which already
 * walks ancestors the same way).
 */
function findEnclosingDartClassName(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'class_definition') {
      const nameNode = current.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Qualified name (`ClassName.methodName`, or bare `functionName` for a
 * top-level/local function) of the function/method enclosing a `node` that
 * is itself a DESCENDANT of that function's OWN signature — e.g. a
 * `formal_parameter` inside its `formal_parameter_list`. Simple ancestor
 * walk to the nearest `function_signature`/`constructor_signature`: a
 * parameter is always nested INSIDE its own signature node (regardless of
 * whether that signature is itself further wrapped in a `method_signature`,
 * which only matters for `findEnclosingDartParamListForCall`'s opposite
 * direction — see that function's doc comment for why a CALL site can't use
 * this same simple ancestor walk). Mirrors `findEnclosingFunctionQualifier`
 * in `src/extractors/javascript.ts`, adapted to Dart's node names.
 */
function findEnclosingDartFunctionQualifierForParam(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'function_signature' || current.type === 'constructor_signature') {
      const fnName = extractDartFunctionName(current);
      if (!fnName) return null;
      const className = findEnclosingDartClassName(current);
      return className ? `${className}.${fnName}` : fnName;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Unwrap a `method_signature` node to the inner `function_signature`/
 * `constructor_signature`/`getter_signature`/`setter_signature` node that
 * actually carries the `formal_parameter_list` (and, for
 * `extractDartFunctionName`, the `name` field) — the same wrapper-unwrapping
 * `extractDartFunctionName` already does for name extraction, factored out
 * here so `findEnclosingDartParamListForCall` can reach the parameter list
 * too. Returns `node` itself unchanged when it isn't a `method_signature` —
 * a bare `function_signature`/`constructor_signature` (top-level and local
 * functions are never wrapped) already carries `formal_parameter_list`
 * directly.
 */
function findDartInnerSignatureNode(node: TreeSitterNode): TreeSitterNode {
  if (node.type !== 'method_signature') return node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (
      child &&
      (child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature')
    ) {
      return child;
    }
  }
  return node;
}

/**
 * Names bound by a `formal_parameter_list` — every plain parameter name,
 * whether required, optional-positional (`[...]`), or optional-named
 * (`{...}` — both shapes wrap their `formal_parameter` children in an
 * intervening `optional_formal_parameters` node, confirmed by parsing both
 * forms with tree-sitter-dart), EXCLUDING the `this.field`/`super.field`
 * constructor-shorthand shape (a `constructor_param`-wrapped
 * `formal_parameter`) — that shape aliases the field itself rather than
 * introducing a new, distinctly-typed local binding, so it must NOT count as
 * shadowing (per the Greptile finding on PR #2477 this function's caller,
 * `findDartSelectorReceiver`, fixes — see its doc comment).
 */
function collectDartParamNames(paramList: TreeSitterNode): ReadonlySet<string> {
  const names = new Set<string>();
  const addFormalParameter = (fp: TreeSitterNode): void => {
    if (findChild(fp, 'constructor_param')) return;
    const idNode = findChild(fp, 'identifier');
    if (idNode) names.add(idNode.text);
  };
  for (let i = 0; i < paramList.childCount; i++) {
    const child = paramList.child(i);
    if (!child) continue;
    if (child.type === 'formal_parameter') {
      addFormalParameter(child);
    } else if (child.type === 'optional_formal_parameters') {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner?.type === 'formal_parameter') addFormalParameter(inner);
      }
    }
  }
  return names;
}

/**
 * Parameter names in scope for a receiver identifier at a call site
 * (`node`, some descendant of the enclosing function/method's `function_body`
 * — a `selector`/`unconditional_assignable_selector` node in this file's
 * case) — used by `findDartSelectorReceiver` to decide whether a bare
 * identifier is shadowed by a same-named parameter rather than being a
 * genuine field access (#2319 second follow-up, Greptile finding on PR
 * #2477).
 *
 * Unlike `findEnclosingDartFunctionQualifierForParam` (a simple ancestor
 * walk), a CALL site can't reach its enclosing signature by walking
 * ancestors alone: tree-sitter-dart splits a function/method's signature
 * and body into SIBLING nodes under a shared parent (`method_signature` +
 * `function_body` under `class_body`, or `function_signature` +
 * `function_body` under `program`/a `local_function_declaration`'s
 * `lambda_expression` — confirmed by parsing top-level, class-method,
 * arrow-bodied, and nested-local-function variants with tree-sitter-dart;
 * the same split `dartFunctionEndLine` already documents and skips forward
 * across for `endLine` computation, e.g. `#2082`) — a call inside the body
 * has the `function_body` node as an ancestor, never the signature. This
 * walks up to that `function_body` ancestor, then scans ITS siblings
 * backward (skipping any intervening `comment` nodes, mirroring
 * `dartFunctionEndLine`'s identical forward skip) for the nearest
 * signature-shaped node.
 *
 * Returns `null` (safe default: no shadowing detected, `this.`-prefix kept)
 * when no enclosing `function_body` is found at all, or when the sibling
 * immediately preceding it isn't recognizably a signature — deliberately
 * conservative, matching this file's own established discipline of falling
 * through rather than guessing (see `findDartSelectorReceiver`'s own
 * chained-call/subscript-indexed cases).
 */
function findEnclosingDartParamListForCall(node: TreeSitterNode): TreeSitterNode | null {
  const sig = findEnclosingDartSignatureFromBody(node);
  if (!sig) return null;
  const inner = findDartInnerSignatureNode(sig);
  return findChild(inner, 'formal_parameter_list');
}

/**
 * Whether `name` is shadowed by a LOCAL VARIABLE declared earlier in an
 * ancestor block of `node` — e.g. `_repo` in:
 *
 *   void run() {
 *     var _repo = MockRepository();
 *     _repo.mockOnlyMethod();   // shadowed: resolves the LOCAL, not the field
 *   }
 *
 * (#2478, the local-variable counterpart to `collectDartParamNames`'s
 * parameter-shadowing check.) A parameter is trivially in scope for the
 * WHOLE function body with no ordering to consider, but a local variable's
 * scope is block-bounded and position-dependent: a same-named local
 * declared in a DIFFERENT (sibling) block, or later in the SAME block, must
 * NOT be treated as shadowing.
 *
 * Walks up from `node` one enclosing `block` at a time. At each level, the
 * child of that block on the path up from `node` is the "entry statement"
 * — only that block's siblings BEFORE the entry statement's own index are
 * checked: a local variable declared AFTER it in the same block is not yet
 * in scope there, and one declared inside a DIFFERENT branch of an
 * `if`/`for` lives in a sibling block this walk never visits at all, so it
 * can't falsely match either. This verifies the ordering directly from the
 * tree rather than assuming Dart's compiler already rejects a forward
 * reference.
 *
 * Stops at the enclosing `function_body` boundary, mirroring
 * `findEnclosingDartParamListForCall`'s identical discipline against
 * crossing into an outer function/class scope.
 *
 * Deliberately does NOT walk into nested descendant blocks the call site
 * itself isn't inside (e.g. a local declared inside an `if` whose block
 * doesn't contain the call) — those are simply never visited by the
 * ancestor walk, so this cannot over-detect shadowing there. Nor does it
 * chase the rare, unusual-style comma-separated multi-declarator local
 * (`var a, b = Foo();`) — tree-sitter-dart's grammar folds the second
 * declarator into an oddly-shaped `initialized_identifier` sibling rather
 * than a second `initialized_variable_definition`, and this only reads the
 * primary `name` field. Missing that rare shape is a conservative
 * under-detection (falls through to the pre-existing `this.`-prefixed
 * behavior), not a wrong one — matching this file's own "don't guess"
 * convention for every other case `findDartSelectorReceiver` leaves
 * unhandled.
 */
function findEnclosingDartShadowingLocalName(node: TreeSitterNode, name: string): boolean {
  let current: TreeSitterNode | null = node;
  while (current) {
    const ancestor: TreeSitterNode | null = current.parent;
    if (!ancestor) return false;
    if (ancestor.type === 'block') {
      let idx = -1;
      for (let i = 0; i < ancestor.childCount; i++) {
        if (ancestor.child(i)?.id === current.id) {
          idx = i;
          break;
        }
      }
      for (let i = idx - 1; i >= 0; i--) {
        const sibling = ancestor.child(i);
        if (sibling?.type !== 'local_variable_declaration') continue;
        const decl = findChild(sibling, 'initialized_variable_definition');
        const nameNode = decl?.childForFieldName('name');
        if (nameNode?.text === name) return true;
      }
    }
    if (ancestor.type === 'function_body') return false;
    current = ancestor;
  }
  return false;
}

/**
 * The `method_signature`/`function_signature`/`constructor_signature` node
 * enclosing `node`, where `node` is some descendant of that function's
 * `function_body` — the shared traversal behind both
 * `findEnclosingDartParamListForCall` (needs the parameter list) and
 * `findEnclosingDartFunctionQualifierForBody` (needs the qualified name;
 * #2474, local-variable constructor-call typeMap seeding). See the former's
 * original doc comment (still accurate) for why this can't be a simple
 * ancestor walk like `findEnclosingDartFunctionQualifierForParam`:
 * tree-sitter-dart splits a function/method's signature and body into
 * SIBLING nodes under a shared parent, so a descendant of the body has
 * `function_body` as an ancestor, never the signature itself.
 *
 * Returns `null` when no enclosing `function_body` is found at all, or when
 * the sibling immediately preceding it isn't recognizably a signature —
 * deliberately conservative, matching this file's own established
 * discipline of falling through rather than guessing.
 */
function findEnclosingDartSignatureFromBody(node: TreeSitterNode): TreeSitterNode | null {
  let current: TreeSitterNode | null = node.parent;
  while (current) {
    if (current.type === 'function_body') {
      const parent = current.parent;
      if (!parent) return null;
      let idx = -1;
      for (let i = 0; i < parent.childCount; i++) {
        if (parent.child(i)?.id === current.id) {
          idx = i;
          break;
        }
      }
      for (let i = idx - 1; i >= 0; i--) {
        const sibling = parent.child(i);
        if (!sibling) continue;
        if (sibling.type === 'comment') continue;
        if (
          sibling.type === 'method_signature' ||
          sibling.type === 'function_signature' ||
          sibling.type === 'constructor_signature'
        ) {
          return sibling;
        }
        return null;
      }
      return null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Qualified name (`ClassName.methodName`, or bare `functionName`) of the
 * function/method enclosing `node`, a descendant of that function's
 * `function_body` — e.g. a local variable declaration inside the body
 * (#2474). Mirrors `findEnclosingDartFunctionQualifierForParam`'s return
 * shape, but for a body descendant rather than a parameter — see
 * `findEnclosingDartSignatureFromBody` for why these need different
 * traversals.
 */
function findEnclosingDartFunctionQualifierForBody(node: TreeSitterNode): string | null {
  const sig = findEnclosingDartSignatureFromBody(node);
  if (!sig) return null;
  const fnName = extractDartFunctionName(sig);
  if (!fnName) return null;
  const className = findEnclosingDartClassName(sig);
  return className ? `${className}.${fnName}` : fnName;
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
        // A `comment` can appear as its own intervening sibling BETWEEN the
        // signature and its body (confirmed by parsing a signature followed
        // by a same-line-or-not `//` comment then `{ ... }` — Greptile
        // review on #2082), since tree-sitter-dart's comment rule is an
        // `extra` production that can surface anywhere in the tree, not
        // just a token folded into an adjacent node. Skip past any number
        // of them to find the real next sibling.
        let j = i + 1;
        let next = parent.child(j);
        while (next && next.type === 'comment') {
          j++;
          next = parent.child(j);
        }
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
  const resolved = resolveDartSelectorCall(node);
  if (!resolved) return;
  const { methodName, receiver } = resolved;

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

  ctx.calls.push(receiver ? { name: methodName, line, receiver } : { name: methodName, line });
}

interface DartSelectorCall {
  methodName: string;
  receiver?: string;
}

// A `.method` access (`unconditional_assignable_selector`) and a null-aware
// `?.method` access (`conditional_assignable_selector`) are otherwise
// identical for call-resolution purposes — both wrap a plain `identifier`
// naming the method — so every lookup below tries either wrapper (#2476).
function findDartAssignableSelector(node: TreeSitterNode): TreeSitterNode | null {
  return (
    findChild(node, 'unconditional_assignable_selector') ||
    findChild(node, 'conditional_assignable_selector')
  );
}

// Look for the identifier this selector belongs to, plus (for a genuine
// `.method` access) its receiver, for typeMap-based call resolution (#2319).
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
//      wrapping call_expression — #2082). This is a bare call, not a
//      receiver+method pair — the identifier IS the callee's own name, so
//      no receiver is produced.
// A/B both apply identically to a null-aware `?.method` access — confirmed
// by parsing `a?.b();`, which produces the exact same Layout B shape as
// `a.b();` with `conditional_assignable_selector` in place of
// `unconditional_assignable_selector` (#2476).
function resolveDartSelectorCall(node: TreeSitterNode): DartSelectorCall | null {
  const unconditional = findDartAssignableSelector(node);
  if (unconditional) {
    const id = findChild(unconditional, 'identifier');
    if (!id) return null;
    const receiver = findDartSelectorReceiver(node);
    return receiver ? { methodName: id.text, receiver } : { methodName: id.text };
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
    const unc2 = findDartAssignableSelector(prevSibling);
    const id2 = unc2 ? findChild(unc2, 'identifier') : null;
    if (!id2) return null;
    const receiver = findDartSelectorReceiver(prevSibling);
    return receiver ? { methodName: id2.text, receiver } : { methodName: id2.text };
  }

  if (prevSibling.type === 'identifier' || prevSibling.type === 'type_identifier') {
    return { methodName: prevSibling.text };
  }

  return null;
}

/**
 * Receiver for a `.method` access: the sibling immediately preceding the
 * selector node that itself carries the `.method` access (`methodSelector`
 * — either `node` for Layout A, or `node`'s previous sibling for Layout B),
 * but ONLY when that sibling is a plain identifier/type_identifier — e.g.
 * `_repo` in `_repo.findById(id)` (confirmed by parsing this exact shape
 * with tree-sitter-dart, matching the issue's own example; #2319).
 *
 * A plain `identifier` sibling is normally emitted as `this.<name>`, NOT the
 * bare name — even though idiomatic Dart never writes an explicit `this.`
 * for a same-class field access. This normalises Dart's implicit-`this`
 * field shape to look textually identical to JS/TS's explicit `this.field`
 * shape, which lets `resolveReceiverTypeName` (`src/domain/graph/resolver/
 * strategy.ts`) apply its EXISTING `this.`-prefix-stripping, class-scoped-
 * key-first lookup to Dart too, with no resolver changes needed. Without
 * this, two classes in the same file each declaring a same-named field of a
 * different type would collide on the resolver's bare fallback key — a
 * Greptile finding on PR #2477 (#2319 first follow-up); see
 * `seedDartFieldTypeMapEntry`'s doc comment for the seeding-side half.
 *
 * EXCEPT when the identifier is SHADOWED by a same-named parameter of the
 * enclosing function/method (checked via `findEnclosingDartParamListForCall`
 * + `collectDartParamNames`) — Dart legally allows a parameter to shadow a
 * same-named class field of a DIFFERENT type for the rest of its scope
 * (`void run(MockRepository _repo) { _repo.mockOnlyMethod(); }` inside a
 * class whose own `_repo` field is typed `Repository`), and the naive
 * unconditional prefixing above would incorrectly activate the class-scoped
 * lookup for the FIELD's type instead of the parameter's — a second Greptile
 * finding on PR #2477 (#2319 second follow-up). In that case this returns
 * the BARE name instead, which skips the class-scoped lookup entirely
 * (`resolveReceiverTypeName` only tries it when a `this.`/`self.` prefix was
 * present and stripped) and falls through to
 * `handleDartFormalParamTypeMap`'s function-scoped typeMap entry for the
 * parameter's own type instead — see that function's doc comment for why
 * the bare fallback key ALONE (i.e. simply not prefixing, with no
 * function-scoped seeding) is NOT sufficient to avoid resolving against the
 * field's type.
 *
 * A shadowing LOCAL VARIABLE declaration (`var _repo = MockRepository();
 * _repo.mockOnlyMethod();` inside a class whose own `_repo` field is a
 * different type) is detected the same way, via
 * `findEnclosingDartShadowingLocalName` (#2478) — see that function's doc
 * comment for why block-scoping and declaration order can be checked
 * directly from the tree without needing full control-flow analysis.
 *

 * A `type_identifier` sibling (a class/type name used as a static-call
 * receiver, e.g. `MyClass.staticMethod()`) is deliberately left UNPREFIXED —
 * it never denotes a field access, so there is no class-scoped key for it
 * to benefit from, and prefixing it could only add a spurious lookup.
 *
 * Deliberately conservative, mirroring `resolveDartSelectorCall`'s own
 * fall-through-to-null discipline: a chained call's intermediate receiver
 * (`obj.method1().method2()` — `method2`'s receiver is `method1()`'s return
 * value, a `selector` node, not a plain identifier) or a subscript-indexed
 * receiver (`list[0].foo()` — an `unconditional_assignable_selector`
 * wrapping an `index_selector`, also not a plain identifier) yields no
 * receiver at all rather than guessing one. An explicit `this.field.method()`
 * receiver chain is a further case this does not (yet) unwrap — the field
 * name sits behind an intervening property-read `selector`, not a bare
 * identifier — left unhandled since idiomatic Dart accesses same-class
 * fields with a bare identifier, the shape this DOES handle.
 */
function findDartSelectorReceiver(methodSelector: TreeSitterNode): string | undefined {
  const parent = methodSelector.parent;
  if (!parent) return undefined;
  let prevSibling: TreeSitterNode | null = null;
  for (let i = 0; i < parent.childCount; i++) {
    const sibling = parent.child(i);
    if (sibling?.id === methodSelector.id) break;
    prevSibling = sibling;
  }
  if (prevSibling?.type === 'identifier') {
    const paramList = findEnclosingDartParamListForCall(methodSelector);
    if (paramList && collectDartParamNames(paramList).has(prevSibling.text)) {
      return prevSibling.text;
    }
    if (findEnclosingDartShadowingLocalName(methodSelector, prevSibling.text)) {
      return prevSibling.text;
    }
    return `this.${prevSibling.text}`;
  }
  if (prevSibling?.type === 'type_identifier') {
    return prevSibling.text;
  }
  return undefined;
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
