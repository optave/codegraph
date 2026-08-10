import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import {
  findChild,
  findParentNode,
  MAX_WALK_DEPTH,
  nodeEndLine,
  pythonVisibility,
  setTypeMapEntry,
} from './helpers.js';

/** Built-in globals that start with uppercase but are not user-defined types. */
const BUILTIN_GLOBALS_PY: Set<string> = new Set([
  // Uppercase builtins that would false-positive on the factory heuristic
  'Exception',
  'BaseException',
  'ValueError',
  'TypeError',
  'KeyError',
  'IndexError',
  'AttributeError',
  'RuntimeError',
  'OSError',
  'IOError',
  'FileNotFoundError',
  'PermissionError',
  'NotImplementedError',
  'StopIteration',
  'GeneratorExit',
  'SystemExit',
  'KeyboardInterrupt',
  'ArithmeticError',
  'LookupError',
  'UnicodeError',
  'UnicodeDecodeError',
  'UnicodeEncodeError',
  'ImportError',
  'ModuleNotFoundError',
  'ConnectionError',
  'TimeoutError',
  'OverflowError',
  'ZeroDivisionError',
  'NameError',
  'SyntaxError',
  'RecursionError',
  'MemoryError',
  // Common standard library uppercase classes
  'Path',
  'PurePath',
  'OrderedDict',
  'Counter',
  'Decimal',
  'Fraction',
]);

/**
 * Extract symbols from Python files.
 */
export function extractPythonSymbols(tree: TreeSitterTree, filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkPythonNode(tree.rootNode, ctx);
  extractPythonTypeMap(tree.rootNode, ctx);
  markEntrypointCalls(tree.rootNode, filePath, ctx);
  return ctx;
}

/**
 * Flag every call that starts the program rather than being invoked by other
 * code in the repo, covering Python's two canonical conventions (#2392):
 *
 *  - a call inside an `if __name__ == "__main__":` guard, wherever the guard
 *    appears — the convention `data-ingestion-pipe` uses at `app/oio.py:1786`;
 *  - a module-level call in a `__main__.py`, whose module-level code is what
 *    `python -m pkg` runs — the documented container entrypoint on
 *    `data-retrieval-storage-svc`.
 *
 * Both cases additionally require module level: a call nested inside a
 * function that a `__main__.py` happens to define is invoked by that function,
 * not by the runtime.
 *
 * Implemented as a separate pass keyed on line, rather than a flag set during
 * the main walk, so the native extractor can mirror it exactly — it collects
 * the same qualifying-call lines from the same AST and marks the same calls,
 * leaving no room for the two engines to disagree about a given call site.
 */
function markEntrypointCalls(root: TreeSitterNode, filePath: string, ctx: ExtractorOutput): void {
  const lines = collectEntrypointCallLines(root, filePath);
  if (lines.size === 0) return;
  for (const call of ctx.calls) {
    if (lines.has(call.line)) call.entrypoint = true;
  }
}

/**
 * Lines of the call sites that qualify as program-entrypoint invocations.
 *
 * `guarded` propagates down the tree and is reset at every function/class
 * definition: code below a definition is invoked by that definition, not by
 * the runtime, so neither the `__main__.py` module-level context nor an
 * enclosing guard carries into it. A `__main__.py` therefore starts guarded at
 * the root, and a guard's *consequence* turns it on anywhere it appears — but
 * not the guard's `else:` branch, which is the imported-as-a-module path.
 *
 * `atModuleLevel` tracks a second, independent thing: whether we have crossed
 * *any* function/class boundary at all since the root, regardless of guard
 * status, and — unlike `guarded` — never turns back on once it's off. A guard
 * is only recognized while this holds. Without it, a guard syntactically
 * nested inside a function or class (never executed by the runtime — only
 * when/if that function is later called) would still flip `guarded` on for
 * its consequence, because at the point the guard is seen, `guarded` itself
 * is `false` either way — the guard sets it, it doesn't read it — so the two
 * situations ("truly at module level" vs. "nested inside a def, coincidentally
 * `false` too") are indistinguishable without this separate flag (review
 * finding on #2411).
 */
function collectEntrypointCallLines(root: TreeSitterNode, filePath: string): Set<number> {
  const lines = new Set<number>();

  const visit = (
    node: TreeSitterNode,
    depth: number,
    guarded: boolean,
    atModuleLevel: boolean,
  ): void => {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'call' && guarded) lines.add(node.startPosition.row + 1);

    const leavesRuntimeScope =
      node.type === 'function_definition' || node.type === 'class_definition';
    const childGuarded = leavesRuntimeScope ? false : guarded;
    const childAtModuleLevel = atModuleLevel && !leavesRuntimeScope;
    const guardConsequence =
      atModuleLevel &&
      node.type === 'if_statement' &&
      isMainGuardCondition(node.childForFieldName('condition'))
        ? node.childForFieldName('consequence') || findChild(node, 'block')
        : null;
    // Matched by source position, not object identity: the tree-sitter
    // bindings hand back a fresh wrapper object per accessor call, so
    // `child === guardConsequence` is never true even for the same node.
    const guardStart = guardConsequence
      ? `${guardConsequence.startPosition.row}:${guardConsequence.startPosition.column}`
      : null;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      const isGuardBody =
        guardStart !== null &&
        `${child.startPosition.row}:${child.startPosition.column}` === guardStart;
      visit(child, depth + 1, isGuardBody ? true : childGuarded, childAtModuleLevel);
    }
  };

  visit(root, 0, filePath.endsWith('__main__.py'), true);
  return lines;
}

/** True for the `__name__ == "__main__"` test of an `if` statement. */
function isMainGuardCondition(condition: TreeSitterNode | null): boolean {
  if (condition?.type !== 'comparison_operator') return false;
  const text = condition.text.replace(/\s+/g, '');
  return text === '__name__=="__main__"' || text === '"__main__"==__name__';
}

function walkPythonNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_definition':
      handlePyFunctionDef(node, ctx);
      break;
    case 'class_definition':
      handlePyClassDef(node, ctx);
      break;
    case 'decorated_definition':
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walkPythonNode(child, ctx);
      }
      return;
    case 'call':
      handlePyCall(node, ctx);
      break;
    case 'import_statement':
      handlePyImport(node, ctx);
      break;
    case 'expression_statement':
      handlePyExpressionStmt(node, ctx);
      break;
    case 'import_from_statement':
      handlePyImportFrom(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkPythonNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handlePyFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const decorators: string[] = [];
  if (node.previousSibling && node.previousSibling.type === 'decorator') {
    decorators.push(node.previousSibling.text);
  }
  const parentClass = findPythonParentClass(node);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
  const kind = parentClass ? 'method' : 'function';
  const fnChildren = extractPythonParameters(node, parentClass !== null);
  ctx.definitions.push({
    name: fullName,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    decorators,
    children: fnChildren.length > 0 ? fnChildren : undefined,
    visibility: pythonVisibility(nameNode.text),
  });
}

function handlePyClassDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const clsChildren = extractPythonClassProperties(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: clsChildren.length > 0 ? clsChildren : undefined,
  });
  const superclasses = node.childForFieldName('superclasses') || findChild(node, 'argument_list');
  if (superclasses) {
    for (let i = 0; i < superclasses.childCount; i++) {
      const child = superclasses.child(i);
      if (child && child.type === 'identifier') {
        ctx.classes.push({
          name: nameNode.text,
          extends: child.text,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

function handlePyCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  let callName: string | null = null;
  let receiver: string | undefined;
  if (fn.type === 'identifier') callName = fn.text;
  else if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    if (attr) callName = attr.text;
    const obj = fn.childForFieldName('object');
    if (obj) receiver = obj.text;
  }
  if (callName) {
    const call: Call = { name: callName, line: node.startPosition.row + 1 };
    if (receiver) call.receiver = receiver;
    ctx.calls.push(call);
  }
}

/**
 * `import a.b`, `import a.b as ab`, `import a, b` — the module-binding form.
 *
 * Each module in the statement becomes its own `Import`, whose `source` is the
 * module path and whose single name is the local binding it introduces. That
 * split matters twice over: `source` previously carried the *alias* for
 * `import lib as L`, which can never resolve to a file, and a multi-module
 * `import a, b` collapsed into one record that named only `a` as its source
 * (#2387).
 *
 * The binding names a module object rather than a symbol, so it is also
 * recorded in `namespaceBindings` — that is what lets `L.strip_block()` resolve
 * `strip_block` inside the module `L` refers to. For the unaliased dotted form
 * the binding is recorded under its full dotted spelling (`a.b`), because that
 * is the receiver text a call site writes (`a.b.func()`).
 */
function handlePyImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const line = node.startPosition.row + 1;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    let source: string | undefined;
    let local: string | undefined;
    if (child.type === 'dotted_name') {
      source = child.text;
      local = child.text;
    } else if (child.type === 'aliased_import') {
      source = child.childForFieldName('name')?.text;
      local = child.childForFieldName('alias')?.text ?? source;
    }
    if (!source || !local) continue;
    ctx.imports.push({
      source,
      names: [local],
      namespaceBindings: [local],
      line,
      pythonImport: true,
    });
  }
}

function handlePyExpressionStmt(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (node.parent && node.parent.type === 'module') {
    const assignment = findChild(node, 'assignment');
    if (assignment) {
      const left = assignment.childForFieldName('left');
      if (left && left.type === 'identifier' && /^[A-Z_][A-Z0-9_]*$/.test(left.text)) {
        ctx.definitions.push({
          name: left.text,
          kind: 'constant',
          line: node.startPosition.row + 1,
          endLine: nodeEndLine(node),
        });
      }
    }
  }
}

function handlePyImportFrom(node: TreeSitterNode, ctx: ExtractorOutput): void {
  let source = '';
  const names: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'dotted_name' || child.type === 'relative_import') {
      if (!source) source = child.text;
      else names.push(child.text);
    }
    if (child.type === 'aliased_import') {
      const n = child.childForFieldName('name') || child.child(0);
      if (n) names.push(n.text);
    }
    if (child.type === 'wildcard_import') names.push('*');
  }
  if (source)
    ctx.imports.push({ source, names, line: node.startPosition.row + 1, pythonImport: true });
}

// ── Python-specific helpers ─────────────────────────────────────────────────

function extractPythonParameters(fnNode: TreeSitterNode, isMethod: boolean): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramsNode = fnNode.childForFieldName('parameters') || findChild(fnNode, 'parameters');
  if (!paramsNode) return params;
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;
    const param = extractSinglePyParam(child);
    if (!param) continue;
    if (isMethod && (param.name === 'self' || param.name === 'cls')) continue;
    params.push(param);
  }
  return params;
}

/** Extract a single parameter declaration from a parameter node. */
function extractSinglePyParam(child: TreeSitterNode): SubDeclaration | null {
  const t = child.type;
  if (t === 'identifier') {
    return { name: child.text, kind: 'parameter', line: child.startPosition.row + 1 };
  }
  if (t === 'typed_parameter' || t === 'default_parameter' || t === 'typed_default_parameter') {
    const nameNode = child.childForFieldName('name') || child.child(0);
    if (nameNode && nameNode.type === 'identifier') {
      return { name: nameNode.text, kind: 'parameter', line: child.startPosition.row + 1 };
    }
  }
  if (t === 'list_splat_pattern' || t === 'dictionary_splat_pattern') {
    return extractSplatParam(child);
  }
  return null;
}

/** Extract the identifier name from a *args or **kwargs splat pattern. */
function extractSplatParam(node: TreeSitterNode): SubDeclaration | null {
  for (let j = 0; j < node.childCount; j++) {
    const inner = node.child(j);
    if (inner && inner.type === 'identifier') {
      return { name: inner.text, kind: 'parameter', line: node.startPosition.row + 1 };
    }
  }
  return null;
}

/** Extract class-level assignment properties from expression statements. */
function extractClassAssignment(
  child: TreeSitterNode,
  seen: Set<string>,
  props: SubDeclaration[],
): void {
  const assignment = findChild(child, 'assignment');
  if (!assignment) return;
  const left = assignment.childForFieldName('left');
  if (left?.type !== 'identifier' || seen.has(left.text)) return;
  seen.add(left.text);
  props.push({
    name: left.text,
    kind: 'property',
    line: child.startPosition.row + 1,
    visibility: pythonVisibility(left.text),
  });
}

/** If node is an __init__ method, walk its body for self.x assignments. */
function extractInitProperties(
  node: TreeSitterNode,
  seen: Set<string>,
  props: SubDeclaration[],
): void {
  const fnName = node.childForFieldName('name');
  if (fnName?.text !== '__init__') return;
  const initBody = node.childForFieldName('body') || findChild(node, 'block');
  if (initBody) walkInitBody(initBody, seen, props);
}

function extractPythonClassProperties(classNode: TreeSitterNode): SubDeclaration[] {
  const props: SubDeclaration[] = [];
  const seen = new Set<string>();
  const body = classNode.childForFieldName('body') || findChild(classNode, 'block');
  if (!body) return props;

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;

    if (child.type === 'expression_statement') {
      extractClassAssignment(child, seen, props);
    } else if (child.type === 'function_definition') {
      extractInitProperties(child, seen, props);
    } else if (child.type === 'decorated_definition') {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner && inner.type === 'function_definition') {
          extractInitProperties(inner, seen, props);
        }
      }
    }
  }
  return props;
}

function walkInitBody(bodyNode: TreeSitterNode, seen: Set<string>, props: SubDeclaration[]): void {
  for (let i = 0; i < bodyNode.childCount; i++) {
    const stmt = bodyNode.child(i);
    if (stmt?.type !== 'expression_statement') continue;
    const assignment = findChild(stmt, 'assignment');
    if (!assignment) continue;
    const left = assignment.childForFieldName('left');
    if (left?.type !== 'attribute') continue;
    const obj = left.childForFieldName('object');
    const attr = left.childForFieldName('attribute');
    if (obj && obj.text === 'self' && attr && attr.type === 'identifier' && !seen.has(attr.text)) {
      seen.add(attr.text);
      props.push({
        name: attr.text,
        kind: 'property',
        line: stmt.startPosition.row + 1,
        visibility: pythonVisibility(attr.text),
      });
    }
  }
}

function extractPythonTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractPythonTypeMapDepth(node, ctx, 0);
}

/** Handle typed_parameter or typed_default_parameter for type map. */
function handlePyTypedParam(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const isDefault = node.type === 'typed_default_parameter';
  const nameNode = isDefault ? node.childForFieldName('name') : node.child(0);
  const typeNode = node.childForFieldName('type');
  if (nameNode?.type !== 'identifier' || !typeNode) return;
  if (nameNode.text === 'self' || nameNode.text === 'cls') return;
  const typeName = extractPythonTypeName(typeNode);
  if (typeName && ctx.typeMap) setTypeMapEntry(ctx.typeMap, nameNode.text, typeName, 0.9);
}

/** Handle assignment for constructor/factory type inference. */
function handlePyAssignmentType(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (left?.type !== 'identifier' || !right || right.type !== 'call') return;

  const fn = right.childForFieldName('function');
  if (!fn) return;
  if (fn.type === 'identifier') {
    const name = fn.text;
    if (name[0] && name[0] !== name[0].toLowerCase()) {
      if (ctx.typeMap) setTypeMapEntry(ctx.typeMap, left.text, name, 1.0);
    }
  } else if (fn.type === 'attribute') {
    const obj = fn.childForFieldName('object');
    if (obj?.type !== 'identifier') return;
    const objName = obj.text;
    if (objName[0] && objName[0] !== objName[0].toLowerCase() && !BUILTIN_GLOBALS_PY.has(objName)) {
      if (ctx.typeMap) setTypeMapEntry(ctx.typeMap, left.text, objName, 0.7);
    }
  }
}

function extractPythonTypeMapDepth(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  depth: number,
): void {
  if (depth >= MAX_WALK_DEPTH) return;

  if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter') {
    handlePyTypedParam(node, ctx);
  } else if (node.type === 'assignment') {
    handlePyAssignmentType(node, ctx);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractPythonTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractPythonTypeName(typeNode: TreeSitterNode): string | null {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === 'identifier') return typeNode.text;
  if (t === 'attribute') return typeNode.text; // module.Type
  // Generic: List[int] → subscript → value is identifier
  if (t === 'subscript') {
    const value = typeNode.childForFieldName('value');
    return value ? value.text : null;
  }
  // None type, string, etc → skip
  if (t === 'none' || t === 'string') return null;
  return null;
}

const PY_CLASS_TYPES = ['class_definition'] as const;
function findPythonParentClass(node: TreeSitterNode): string | null {
  return findParentNode(node, PY_CLASS_TYPES);
}
