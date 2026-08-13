import type { EnterNodeResult, TreeSitterNode, Visitor, VisitorContext } from '../../types.js';
import {
  computeHalsteadDerived,
  computeLOCMetrics,
  computeMaintainabilityIndex,
} from '../metrics.js';

type AnyRules = any;

interface ComplexityAcc {
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  operators: Map<string, number> | null;
  operands: Map<string, number> | null;
  halsteadSkipDepth: number;
}

interface PerFunctionResult {
  funcNode: TreeSitterNode;
  funcName: string | null;
  metrics: ReturnType<typeof collectResult>;
}

/**
 * Extract a leaf's Halstead/logical-operator comparison key: `.text` (the
 * literal operator symbol) when `byText` is set — needed for grammars where
 * every binary operator shares one generic node type (e.g. tree-sitter-julia's
 * `operator`, issue #2312) — otherwise `.type` (every other grammar, where
 * the node type already equals the operator's literal text, so behavior is
 * unchanged).
 */
function operatorKey(node: TreeSitterNode, byText: boolean): string {
  return byText ? node.text : node.type;
}

function classifyHalstead(node: TreeSitterNode, hRules: AnyRules, acc: ComplexityAcc): void {
  const type = node.type;
  if (hRules.skipTypes.has(type)) acc.halsteadSkipDepth++;
  if (acc.halsteadSkipDepth > 0) return;

  if (hRules.compoundOperators.has(type) && acc.operators) {
    acc.operators.set(type, (acc.operators.get(type) || 0) + 1);
  }
  if (node.childCount === 0) {
    const opKey = operatorKey(node, !!hRules.operatorLeafTypesByText);
    if (hRules.operatorLeafTypes.has(opKey) && acc.operators) {
      acc.operators.set(opKey, (acc.operators.get(opKey) || 0) + 1);
    } else if (hRules.operandLeafTypes.has(type) && acc.operands) {
      const text = node.text;
      acc.operands.set(text, (acc.operands.get(text) || 0) + 1);
    }
  }
}

/**
 * Effective parent: skip over consecutive nodes whose type is in
 * `cRules.transparentWrapperTypes` (e.g. Solidity's `statement`/`expression`
 * supertype-alias wrapper nodes, issue #2312) to find the nearest
 * structurally-meaningful ancestor. Degenerates to plain `.parent` for every
 * language that leaves `transparentWrapperTypes` unset.
 */
function effectiveParent(node: TreeSitterNode, cRules: AnyRules): TreeSitterNode | null {
  let p = node.parent;
  while (p && cRules.transparentWrapperTypes?.has(p.type)) {
    p = p.parent;
  }
  return p;
}

/**
 * Detect Pattern D else-if: node's immediate parent is a transparent wrapper
 * (e.g. Solidity's `statement`, reached via the SAME field name — `body` —
 * for both the then- and else-branch, with no dedicated `else_clause` node
 * and no `alternative` field) whose preceding sibling is the bare `else`
 * keyword token. Mirrors Pattern A's role but for grammars that dropped the
 * wrapping node entirely (issue #2312).
 */
function isPatternDElseIf(node: TreeSitterNode, cRules: AnyRules): boolean {
  if (!cRules.elseKeywordType || !cRules.transparentWrapperTypes?.size) return false;
  const wrapper = node.parent;
  if (!wrapper || !cRules.transparentWrapperTypes.has(wrapper.type)) return false;
  // Skip comment nodes when walking backward: `else /* note */ if (...)`
  // still counts as an else-if even though a comment sibling sits between
  // the `else` token and the wrapper (Greptile review, PR #2472).
  let sib = wrapper.previousSibling;
  while (sib && cRules.commentTypes?.has(sib.type)) {
    sib = sib.previousSibling;
  }
  return sib?.type === cRules.elseKeywordType;
}

/**
 * Detect whether a branch node is an else-if that the DFS walk would NOT
 * increment nesting for.  Returns true for:
 *  - Pattern A (JS/C#/Rust): if_statement whose parent is else_clause
 *  - Pattern C (Go/Java): if_statement that is the alternative of parent if
 *  - Pattern D (Solidity): if_statement reached via a transparent wrapper
 *    whose preceding sibling is the bare else keyword
 *
 * Pattern B (Python elif_clause) is not an issue because elif_clause is
 * never in nestingNodes.
 */
function isElseIfNonNesting(node: TreeSitterNode, type: string, cRules: AnyRules): boolean {
  if (type !== cRules.ifNodeType) return false;

  if (cRules.elseViaAlternative) {
    // Pattern C
    return (
      node.parent?.type === cRules.ifNodeType &&
      node.parent?.childForFieldName('alternative')?.id === node.id
    );
  }
  if (cRules.elseNodeType) {
    // Pattern A
    return node.parent?.type === cRules.elseNodeType;
  }
  return isPatternDElseIf(node, cRules);
}

function classifyBranchNode(
  node: TreeSitterNode,
  type: string,
  nestingLevel: number,
  cRules: AnyRules,
  acc: ComplexityAcc,
): void {
  if (cRules.elseNodeType && type === cRules.elseNodeType) {
    const firstChild = node.namedChild(0);
    if (firstChild && firstChild.type === cRules.ifNodeType) {
      return;
    }
    acc.cognitive++;
    return;
  }

  if (cRules.elifNodeType && type === cRules.elifNodeType) {
    acc.cognitive++;
    acc.cyclomatic++;
    return;
  }

  let isElseIf = false;
  if (type === cRules.ifNodeType) {
    if (cRules.elseViaAlternative) {
      isElseIf =
        node.parent?.type === cRules.ifNodeType &&
        node.parent?.childForFieldName('alternative')?.id === node.id;
    } else if (cRules.elseNodeType) {
      isElseIf = node.parent?.type === cRules.elseNodeType;
    } else {
      isElseIf = isPatternDElseIf(node, cRules);
    }
  }

  if (isElseIf) {
    acc.cognitive++;
    acc.cyclomatic++;
    return;
  }

  acc.cognitive += 1 + nestingLevel;
  acc.cyclomatic++;

  if (cRules.switchLikeNodes?.has(type)) {
    acc.cyclomatic--;
  }
}

function classifyLogicalOp(node: TreeSitterNode, cRules: AnyRules, acc: ComplexityAcc): void {
  const byText = !!cRules.logicalOperatorsByText;
  const opNode = node.child(1);
  if (!opNode) return;
  const op = operatorKey(opNode, byText);
  if (!cRules.logicalOperators.has(op)) return;
  acc.cyclomatic++;
  // effectiveParent walks through transparent wrapper nodes (e.g. Solidity's
  // `expression`) that would otherwise hide a same-operator chain's real
  // parent binary_expression (issue #2312).
  const parent = effectiveParent(node, cRules);
  const parentOp = parent?.child(1);
  const sameSequence =
    parent != null &&
    cRules.logicalNodeTypes.has(parent.type) &&
    !!parentOp &&
    operatorKey(parentOp, byText) === op;
  if (!sameSequence) acc.cognitive++;
}

function classifyPlainElse(
  node: TreeSitterNode,
  type: string,
  cRules: AnyRules,
  acc: ComplexityAcc,
): void {
  if (
    cRules.elseViaAlternative &&
    type !== cRules.ifNodeType &&
    node.parent?.type === cRules.ifNodeType &&
    node.parent?.childForFieldName('alternative')?.id === node.id
  ) {
    acc.cognitive++;
    return;
  }
  // Pattern D plain else (Solidity): a non-if block whose immediate parent
  // is a transparent wrapper preceded by the bare else keyword.
  if (type !== cRules.ifNodeType && isPatternDElseIf(node, cRules)) {
    acc.cognitive++;
  }
}

function collectResult(
  funcNode: TreeSitterNode | { text: string },
  acc: ComplexityAcc,
  hRules: AnyRules | null | undefined,
  langId: string | null,
): {
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  halstead: ReturnType<typeof computeHalsteadDerived> | null;
  loc: ReturnType<typeof computeLOCMetrics>;
  mi: number;
} {
  const halstead =
    hRules && acc.operators && acc.operands
      ? computeHalsteadDerived(acc.operators, acc.operands)
      : null;
  const loc = computeLOCMetrics(funcNode as TreeSitterNode, langId ?? undefined);
  const volume = halstead ? halstead.volume : 0;
  const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
  const mi = computeMaintainabilityIndex(volume, acc.cyclomatic, loc.sloc, commentRatio);

  return {
    cognitive: acc.cognitive,
    cyclomatic: acc.cyclomatic,
    maxNesting: acc.maxNesting,
    halstead,
    loc,
    mi,
  };
}

function resetAccumulators(hRules: AnyRules | null | undefined): ComplexityAcc {
  return {
    cognitive: 0,
    cyclomatic: 1,
    maxNesting: 0,
    operators: hRules ? new Map() : null,
    operands: hRules ? new Map() : null,
    halsteadSkipDepth: 0,
  };
}

/** Classify a single node for all complexity metrics (Halstead, branching, logical ops, etc.). */
function classifyNode(
  node: TreeSitterNode,
  nestingLevel: number,
  cRules: AnyRules,
  hRules: AnyRules | null | undefined,
  acc: ComplexityAcc,
): void {
  const type = node.type;

  if (hRules) classifyHalstead(node, hRules, acc);
  if (nestingLevel > acc.maxNesting) acc.maxNesting = nestingLevel;
  if (cRules.logicalNodeTypes.has(type)) classifyLogicalOp(node, cRules, acc);
  if (type === cRules.optionalChainType) acc.cyclomatic++;
  const isBranchNode = cRules.branchNodes.has(type) && node.childCount > 0;
  if (isBranchNode) {
    classifyBranchNode(node, type, nestingLevel, cRules, acc);
  }
  classifyPlainElse(node, type, cRules, acc);
  // Mirrors the Rust walk()'s unconditional `return` after a branch-node
  // match, which makes `is_case` unreachable for a node type listed in both
  // branch_nodes and case_nodes (e.g. Kotlin's when_entry, Scala's
  // case_clause). Without the `!isBranchNode` guard, such node types would
  // be double-counted: once via classifyBranchNode above, again here.
  if (!isBranchNode && cRules.caseNodes.has(type) && node.childCount > 0) acc.cyclomatic++;
}

/**
 * Compute the effective nesting level for complexity classification.
 *
 * In file-level mode, funcDepth starts at 0 for the active function.
 * In function-level mode, funcDepth starts at 1 for the root function
 * (since enterFunction always increments it). Subtract 1 so the root
 * function contributes 0 nesting and each nested level adds +1, matching
 * the Rust engine's behavior.
 */
function computeEffectiveNesting(
  contextNesting: number,
  funcDepth: number,
  nestingAdjust: number,
  fileLevelWalk: boolean,
): number {
  const funcNesting = fileLevelWalk ? funcDepth : Math.max(0, funcDepth - 1);
  return contextNesting + funcNesting - nestingAdjust;
}

/**
 * If this node is an else-if that the walker treats as a nesting node but
 * the DFS engine would NOT increment nesting for, track it so children see
 * the correct (non-inflated) nesting level.
 */
function trackElseIfNestingAdjust(
  node: TreeSitterNode,
  cRules: AnyRules,
  nestingAdjust: number,
  adjustNodeIds: Set<number>,
): number {
  if (cRules.nestingNodes.has(node.type) && isElseIfNonNesting(node, node.type, cRules)) {
    adjustNodeIds.add(node.id);
    return nestingAdjust + 1;
  }
  return nestingAdjust;
}

export function createComplexityVisitor(
  cRules: AnyRules,
  hRules?: AnyRules | null,
  options: { fileLevelWalk?: boolean; langId?: string | null } = {},
): Visitor {
  const { fileLevelWalk = false, langId = null } = options;

  let acc = resetAccumulators(hRules);
  let activeFuncNode: TreeSitterNode | null = null;
  let activeFuncName: string | null = null;
  let funcDepth = 0;
  const results: PerFunctionResult[] = [];

  // The walker increments context.nestingLevel for ALL nodes in nestingNodeTypes
  // (including if_statement). But the DFS engine does NOT increment nesting for
  // else-if if_statement nodes. Track a correction counter so children of else-if
  // nodes see the correct (non-inflated) nesting level.
  let nestingAdjust = 0;
  const adjustNodeIds = new Set<number>();

  return {
    name: 'complexity',
    functionNodeTypes: cRules.functionNodes,
    bodySiblingTypes: cRules.bodySiblingTypes ?? undefined,

    enterFunction(
      funcNode: TreeSitterNode,
      funcName: string | null,
      _context: VisitorContext,
    ): void {
      if (fileLevelWalk && !activeFuncNode) {
        acc = resetAccumulators(hRules);
        activeFuncNode = funcNode;
        activeFuncName = funcName;
        funcDepth = 0;
        nestingAdjust = 0;
        adjustNodeIds.clear();
      } else {
        funcDepth++;
      }
    },

    exitFunction(
      funcNode: TreeSitterNode,
      _funcName: string | null,
      _context: VisitorContext,
    ): void {
      if (fileLevelWalk && funcNode === activeFuncNode) {
        results.push({
          funcNode,
          funcName: activeFuncName,
          metrics: collectResult(funcNode, acc, hRules, langId),
        });
        activeFuncNode = null;
        activeFuncName = null;
      } else {
        funcDepth--;
      }
    },

    enterNode(node: TreeSitterNode, context: VisitorContext): EnterNodeResult | undefined {
      if (fileLevelWalk && !activeFuncNode) return;

      const nestingLevel = computeEffectiveNesting(
        context.nestingLevel,
        funcDepth,
        nestingAdjust,
        fileLevelWalk,
      );
      classifyNode(node, nestingLevel, cRules, hRules, acc);
      nestingAdjust = trackElseIfNestingAdjust(node, cRules, nestingAdjust, adjustNodeIds);
    },

    exitNode(node: TreeSitterNode): void {
      if (adjustNodeIds.has(node.id)) {
        nestingAdjust--;
        adjustNodeIds.delete(node.id);
      }
      if (hRules?.skipTypes.has(node.type)) acc.halsteadSkipDepth--;
    },

    finish(): PerFunctionResult[] | ReturnType<typeof collectResult> {
      if (fileLevelWalk) return results;
      return collectResult({ text: '' } as TreeSitterNode, acc, hRules, langId);
    },
  };
}
