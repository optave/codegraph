import type { TreeSitterNode } from '../types.js';

/**
 * Find a node's next sibling whose type is in `bodyTypes`, skipping over
 * intervening `comment` nodes. Needed for grammars (e.g. tree-sitter-dart's
 * function_signature/function_body split, #2082/#2182) where a function's
 * body lives as a SIBLING of its signature/declaration node rather than as
 * a child of it — every consumer that walks only a matched node's own
 * subtree would otherwise silently see zero body content.
 *
 * Returns null if no sibling exists, or if the next non-comment sibling's
 * type isn't in `bodyTypes` (e.g. tree-sitter-dart's bare `;` for an
 * abstract method signature with no body at all).
 */
export function findBodySiblingNode(
  node: TreeSitterNode,
  bodyTypes: Set<string>,
): TreeSitterNode | null {
  const parent = node.parent;
  if (!parent) return null;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i)?.id === node.id) {
      let j = i + 1;
      let next = parent.child(j);
      while (next && next.type === 'comment') {
        j++;
        next = parent.child(j);
      }
      return next && bodyTypes.has(next.type) ? next : null;
    }
  }
  return null;
}
