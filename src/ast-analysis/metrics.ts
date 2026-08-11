/**
 * Pure metric computations extracted from complexity.js.
 *
 * Contains Halstead derived metrics, LOC metrics, and Maintainability Index —
 * all stateless math that can be reused by visitor-based and standalone paths.
 */

import type { HalsteadDerivedMetrics, LOCMetrics, TreeSitterNode } from '../types.js';

// ─── Halstead Derived Metrics ─────────────────────────────────────────────

/** Halstead delivered-bugs denominator (industry standard: V / 3000). */
const HALSTEAD_BUGS_DIVISOR = 3000;

/** Sum all values in a count map. */
function sumCounts(map: Map<string, number>): number {
  let total = 0;
  for (const c of map.values()) total += c;
  return total;
}

/**
 * Compute Halstead derived metrics from raw operator/operand counts.
 *
 * @param {Map<string, number>} operators - operator type/text → count
 * @param {Map<string, number>} operands  - operand text → count
 * @returns {{ n1: number, n2: number, bigN1: number, bigN2: number, vocabulary: number, length: number, volume: number, difficulty: number, effort: number, bugs: number }}
 */
export function computeHalsteadDerived(
  operators: Map<string, number>,
  operands: Map<string, number>,
): HalsteadDerivedMetrics {
  const n1 = operators.size;
  const n2 = operands.size;
  const bigN1 = sumCounts(operators);
  const bigN2 = sumCounts(operands);

  const vocabulary = n1 + n2;
  const length = bigN1 + bigN2;
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (bigN2 / n2) : 0;
  const effort = difficulty * volume;
  const bugs = volume / HALSTEAD_BUGS_DIVISOR;

  return {
    n1,
    n2,
    bigN1,
    bigN2,
    vocabulary,
    length,
    volume: +volume.toFixed(2),
    difficulty: +difficulty.toFixed(2),
    effort: +effort.toFixed(2),
    bugs: +bugs.toFixed(4),
  };
}

// ─── LOC Metrics ──────────────────────────────────────────────────────────

const LINE_COMMENT_PREFIX = ['//'];

// See native `line_comment_prefixes()`/`is_block_comment_lang()` in
// crates/codegraph-core/src/ast_analysis/complexity.rs for the source of
// truth this must stay byte-for-byte identical to (both engines must agree
// on which lines count as comments for the MI calculation).
//
// Only genuine single-line comment markers live here. `/*`/`*/`/a bare `*`
// continuation line are NOT prefixes to trust unconditionally — a bare `*`
// also opens a pointer-dereference assignment (`*ptr = 5;`) in every
// language below that supports one, so treating it as a comment signal on
// its own misclassified real code as a comment (issue #2287). Block-comment
// lines are instead recognized via explicit `/* ... */` state tracking in
// `computeLOCMetrics`, scoped to the languages NOT in `NO_BLOCK_COMMENT_LANGS`.
const LINE_COMMENT_PREFIXES = new Map<string, string[]>([
  ['javascript', LINE_COMMENT_PREFIX],
  ['typescript', LINE_COMMENT_PREFIX],
  ['tsx', LINE_COMMENT_PREFIX],
  ['go', LINE_COMMENT_PREFIX],
  ['rust', LINE_COMMENT_PREFIX],
  ['java', LINE_COMMENT_PREFIX],
  ['csharp', LINE_COMMENT_PREFIX],
  ['python', ['#']],
  ['ruby', ['#']],
  ['php', ['//', '#']],
  ['c', LINE_COMMENT_PREFIX],
  ['cpp', LINE_COMMENT_PREFIX],
  ['cuda', LINE_COMMENT_PREFIX],
  ['objc', LINE_COMMENT_PREFIX],
  ['kotlin', LINE_COMMENT_PREFIX],
  ['swift', LINE_COMMENT_PREFIX],
  ['scala', LINE_COMMENT_PREFIX],
  ['bash', ['#']],
  ['lua', ['--']],
  ['zig', LINE_COMMENT_PREFIX],
  ['groovy', LINE_COMMENT_PREFIX],
  ['r', ['#']],
]);

/**
 * Languages that do NOT use Javadoc-style block comments (issue #2058,
 * #2287). Inverted (exclusion) rather than an inclusion set so an unlisted
 * language string falls back to full C-style/block-comment support — the
 * same fallback `computeLOCMetrics` already gives an unlisted language for
 * its line-comment prefix (`LINE_COMMENT_PREFIX`, `//`), matching the native
 * mirror's own pre-fix catch-all default of full C-style support.
 */
const NO_BLOCK_COMMENT_LANGS = new Set(['python', 'ruby', 'bash', 'lua', 'zig', 'r']);

/**
 * Compute LOC metrics from a function node's source text.
 *
 * Tracks Javadoc-style block-comment state across lines rather than
 * trusting a bare opening/continuation/closing marker unconditionally: a
 * line is only a block-comment continuation while a genuine block-opening
 * line has been seen and the block hasn't closed yet. Without this,
 * `*ptr = 5;` (a pointer-dereference assignment, valid in every
 * block-comment language here) was wrongly counted as a Javadoc-style
 * continuation line (issue #2287).
 *
 * @param {object} functionNode - tree-sitter node
 * @param {string} [language] - Language ID (falls back to C-style, block-comment-supporting behavior)
 * @returns {{ loc: number, sloc: number, commentLines: number }}
 */
export function computeLOCMetrics(functionNode: TreeSitterNode, language?: string): LOCMetrics {
  const text = functionNode.text;
  const lines = text.split('\n');
  const loc = lines.length;
  const linePrefixes = (language && LINE_COMMENT_PREFIXES.get(language)) || LINE_COMMENT_PREFIX;
  const supportsBlockComments = !language || !NO_BLOCK_COMMENT_LANGS.has(language);

  let commentLines = 0;
  let blankLines = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inBlockComment) {
      commentLines++;
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }

    if (trimmed === '') {
      blankLines++;
      continue;
    }

    if (linePrefixes.some((p) => trimmed.startsWith(p))) {
      commentLines++;
      continue;
    }

    if (supportsBlockComments && trimmed.startsWith('/*')) {
      commentLines++;
      // Search after the opening 2 chars so a 2-char close can't overlap the
      // opening `/*` itself (e.g. "/*/" is NOT a closed empty comment).
      if (!trimmed.slice(2).includes('*/')) inBlockComment = true;
    }
  }

  const sloc = Math.max(1, loc - blankLines - commentLines);
  return { loc, sloc, commentLines };
}

// ─── Maintainability Index ────────────────────────────────────────────────

/**
 * SEI Maintainability Index formula coefficients.
 * Original: MI = 171 - 5.2*ln(V) - 0.23*G - 16.2*ln(LOC) + 50*sin(sqrt(2.4*CM))
 * Microsoft normalization: max(0, min(100, MI * 100/171))
 */
const MI_BASE = 171;
const MI_VOLUME_COEFF = 5.2;
const MI_CYCLOMATIC_COEFF = 0.23;
const MI_LOC_COEFF = 16.2;
const MI_COMMENT_AMPLITUDE = 50;
const MI_COMMENT_SCALE = 2.4;
const MI_NORMALIZE_SCALE = 100;

/**
 * Compute normalized Maintainability Index (0-100 scale).
 *
 * @param {number} volume - Halstead volume
 * @param {number} cyclomatic - Cyclomatic complexity
 * @param {number} sloc - Source lines of code
 * @param {number} [commentRatio] - Comment ratio (0-1), optional
 * @returns {number} Normalized MI (0-100)
 */
export function computeMaintainabilityIndex(
  volume: number,
  cyclomatic: number,
  sloc: number,
  commentRatio?: number,
): number {
  const safeVolume = Math.max(volume, 1);
  const safeSLOC = Math.max(sloc, 1);

  let mi =
    MI_BASE -
    MI_VOLUME_COEFF * Math.log(safeVolume) -
    MI_CYCLOMATIC_COEFF * cyclomatic -
    MI_LOC_COEFF * Math.log(safeSLOC);

  if (commentRatio != null && commentRatio > 0) {
    mi += MI_COMMENT_AMPLITUDE * Math.sin(Math.sqrt(MI_COMMENT_SCALE * commentRatio));
  }

  const normalized = Math.max(0, Math.min(MI_NORMALIZE_SCALE, (mi * MI_NORMALIZE_SCALE) / MI_BASE));
  return +normalized.toFixed(1);
}
