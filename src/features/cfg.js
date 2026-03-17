/**
 * Intraprocedural Control Flow Graph (CFG) construction from tree-sitter AST.
 *
 * Builds basic-block CFGs for individual functions, stored in cfg_blocks + cfg_edges tables.
 * Opt-in via `build --cfg`. Supports JS/TS/TSX, Python, Go, Rust, Java, C#, Ruby, PHP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CFG_RULES } from '../ast-analysis/rules/index.js';
import {
  makeCfgRules as _makeCfgRules,
  buildExtensionSet,
  buildExtToLangMap,
} from '../ast-analysis/shared.js';
import { walkWithVisitors } from '../ast-analysis/visitor.js';
import { createCfgVisitor } from '../ast-analysis/visitors/cfg-visitor.js';
import {
  deleteCfgForNode,
  getCfgBlocks,
  getCfgEdges,
  getFunctionNodeId,
  hasCfgTables,
  openReadonlyOrFail,
} from '../db/index.js';
import { debug, info } from '../infrastructure/logger.js';
import { paginateResult } from '../shared/paginate.js';
import { findNodes } from './shared/find-nodes.js';

// Re-export for backward compatibility
export { _makeCfgRules as makeCfgRules, CFG_RULES };

const CFG_EXTENSIONS = buildExtensionSet(CFG_RULES);

// ─── Core Algorithm: AST → CFG ──────────────────────────────────────────

/**
 * Build a control flow graph for a single function AST node.
 *
 * Thin wrapper around the CFG visitor — runs walkWithVisitors on the function
 * node and returns the first result. All CFG construction logic lives in
 * `ast-analysis/visitors/cfg-visitor.js`.
 *
 * @param {object} functionNode - tree-sitter function AST node
 * @param {string} langId - language identifier
 * @returns {{ blocks: object[], edges: object[], cyclomatic: number }} - CFG blocks, edges, and derived cyclomatic
 */
export function buildFunctionCFG(functionNode, langId) {
  const rules = CFG_RULES.get(langId);
  if (!rules) return { blocks: [], edges: [], cyclomatic: 0 };

  const visitor = createCfgVisitor(rules);
  const walkerOpts = {
    functionNodeTypes: new Set(rules.functionNodes),
    nestingNodeTypes: new Set(),
    getFunctionName: (node) => {
      const nameNode = node.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    },
  };

  const results = walkWithVisitors(functionNode, [visitor], langId, walkerOpts);
  const cfgResults = results.cfg || [];
  if (cfgResults.length === 0) return { blocks: [], edges: [], cyclomatic: 0 };

  const r = cfgResults.find((result) => result.funcNode === functionNode);
  if (!r) return { blocks: [], edges: [], cyclomatic: 0 };
  return { blocks: r.blocks, edges: r.edges, cyclomatic: r.cyclomatic };
}

// ─── Build-Time Helpers ─────────────────────────────────────────────────

async function initCfgParsers(fileSymbols) {
  let needsFallback = false;

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) {
      const ext = path.extname(relPath).toLowerCase();
      if (CFG_EXTENSIONS.has(ext)) {
        const hasNativeCfg = symbols.definitions
          .filter((d) => (d.kind === 'function' || d.kind === 'method') && d.line)
          .every((d) => d.cfg === null || d.cfg?.blocks?.length);
        if (!hasNativeCfg) {
          needsFallback = true;
          break;
        }
      }
    }
  }

  let parsers = null;
  let getParserFn = null;

  if (needsFallback) {
    const { createParsers } = await import('../domain/parser.js');
    parsers = await createParsers();
    const mod = await import('../domain/parser.js');
    getParserFn = mod.getParser;
  }

  return { parsers, getParserFn };
}

function getTreeAndLang(symbols, relPath, rootDir, extToLang, parsers, getParserFn) {
  const ext = path.extname(relPath).toLowerCase();
  let tree = symbols._tree;
  let langId = symbols._langId;

  const allNative = symbols.definitions
    .filter((d) => (d.kind === 'function' || d.kind === 'method') && d.line)
    .every((d) => d.cfg === null || d.cfg?.blocks?.length);

  if (!tree && !allNative) {
    if (!getParserFn) return null;
    langId = extToLang.get(ext);
    if (!langId || !CFG_RULES.has(langId)) return null;

    const absPath = path.join(rootDir, relPath);
    let code;
    try {
      code = fs.readFileSync(absPath, 'utf-8');
    } catch (e) {
      debug(`cfg: cannot read ${relPath}: ${e.message}`);
      return null;
    }

    const parser = getParserFn(parsers, absPath);
    if (!parser) return null;

    try {
      tree = parser.parse(code);
    } catch (e) {
      debug(`cfg: parse failed for ${relPath}: ${e.message}`);
      return null;
    }
  }

  if (!langId) {
    langId = extToLang.get(ext);
    if (!langId) return null;
  }

  return { tree, langId };
}

function buildVisitorCfgMap(tree, cfgRules, symbols, langId) {
  const needsVisitor =
    tree &&
    symbols.definitions.some(
      (d) =>
        (d.kind === 'function' || d.kind === 'method') &&
        d.line &&
        d.cfg !== null &&
        !d.cfg?.blocks?.length,
    );
  if (!needsVisitor) return null;

  const visitor = createCfgVisitor(cfgRules);
  const walkerOpts = {
    functionNodeTypes: new Set(cfgRules.functionNodes),
    nestingNodeTypes: new Set(),
    getFunctionName: (node) => {
      const nameNode = node.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    },
  };
  const walkResults = walkWithVisitors(tree.rootNode, [visitor], langId, walkerOpts);
  const cfgResults = walkResults.cfg || [];
  const visitorCfgByLine = new Map();
  for (const r of cfgResults) {
    if (r.funcNode) {
      const line = r.funcNode.startPosition.row + 1;
      if (!visitorCfgByLine.has(line)) visitorCfgByLine.set(line, []);
      visitorCfgByLine.get(line).push(r);
    }
  }
  return visitorCfgByLine;
}

function persistCfg(cfg, nodeId, insertBlock, insertEdge) {
  const blockDbIds = new Map();
  for (const block of cfg.blocks) {
    const result = insertBlock.run(
      nodeId,
      block.index,
      block.type,
      block.startLine,
      block.endLine,
      block.label,
    );
    blockDbIds.set(block.index, result.lastInsertRowid);
  }

  for (const edge of cfg.edges) {
    const sourceDbId = blockDbIds.get(edge.sourceIndex);
    const targetDbId = blockDbIds.get(edge.targetIndex);
    if (sourceDbId && targetDbId) {
      insertEdge.run(nodeId, sourceDbId, targetDbId, edge.kind);
    }
  }
}

// ─── Build-Time: Compute CFG for Changed Files ─────────────────────────

/**
 * Build CFG data for all function/method definitions and persist to DB.
 *
 * @param {object} db - open better-sqlite3 database (read-write)
 * @param {Map<string, object>} fileSymbols - Map<relPath, { definitions, _tree, _langId }>
 * @param {string} rootDir - absolute project root path
 * @param {object} [_engineOpts] - engine options (unused; always uses WASM for AST)
 */
export async function buildCFGData(db, fileSymbols, rootDir, _engineOpts) {
  const extToLang = buildExtToLangMap();
  const { parsers, getParserFn } = await initCfgParsers(fileSymbols);

  const insertBlock = db.prepare(
    `INSERT INTO cfg_blocks (function_node_id, block_index, block_type, start_line, end_line, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO cfg_edges (function_node_id, source_block_id, target_block_id, kind)
     VALUES (?, ?, ?, ?)`,
  );
  let analyzed = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      if (!CFG_EXTENSIONS.has(ext)) continue;

      const treeLang = getTreeAndLang(symbols, relPath, rootDir, extToLang, parsers, getParserFn);
      if (!treeLang) continue;
      const { tree, langId } = treeLang;

      const cfgRules = CFG_RULES.get(langId);
      if (!cfgRules) continue;

      const visitorCfgByLine = buildVisitorCfgMap(tree, cfgRules, symbols, langId);

      for (const def of symbols.definitions) {
        if (def.kind !== 'function' && def.kind !== 'method') continue;
        if (!def.line) continue;

        const nodeId = getFunctionNodeId(db, def.name, relPath, def.line);
        if (!nodeId) continue;

        let cfg = null;
        if (def.cfg?.blocks?.length) {
          cfg = def.cfg;
        } else if (visitorCfgByLine) {
          const candidates = visitorCfgByLine.get(def.line);
          const r = !candidates
            ? undefined
            : candidates.length === 1
              ? candidates[0]
              : (candidates.find((c) => {
                  const n = c.funcNode.childForFieldName('name');
                  return n && n.text === def.name;
                }) ?? candidates[0]);
          if (r) cfg = { blocks: r.blocks, edges: r.edges };
        }

        if (!cfg || cfg.blocks.length === 0) continue;

        deleteCfgForNode(db, nodeId);
        persistCfg(cfg, nodeId, insertBlock, insertEdge);
        analyzed++;
      }
    }
  });

  tx();

  if (analyzed > 0) {
    info(`CFG: ${analyzed} functions analyzed`);
  }
}

// ─── Query-Time Functions ───────────────────────────────────────────────

const CFG_DEFAULT_KINDS = ['function', 'method'];

/**
 * Load CFG data for a function from the database.
 *
 * @param {string} name - Function name (partial match)
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts] - Options
 * @returns {{ function: object, blocks: object[], edges: object[], summary: object }}
 */
export function cfgData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    if (!hasCfgTables(db)) {
      return {
        name,
        results: [],
        warning:
          'No CFG data found. Rebuild with `codegraph build` (CFG is now included by default).',
      };
    }

    const nodes = findNodes(
      db,
      name,
      { noTests, file: opts.file, kind: opts.kind },
      CFG_DEFAULT_KINDS,
    );
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results = nodes.map((node) => {
      const cfgBlocks = getCfgBlocks(db, node.id);
      const cfgEdges = getCfgEdges(db, node.id);

      return {
        name: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        blocks: cfgBlocks.map((b) => ({
          index: b.block_index,
          type: b.block_type,
          startLine: b.start_line,
          endLine: b.end_line,
          label: b.label,
        })),
        edges: cfgEdges.map((e) => ({
          source: e.source_index,
          sourceType: e.source_type,
          target: e.target_index,
          targetType: e.target_type,
          kind: e.kind,
        })),
        summary: {
          blockCount: cfgBlocks.length,
          edgeCount: cfgEdges.length,
        },
      };
    });

    return paginateResult({ name, results }, 'results', opts);
  } finally {
    db.close();
  }
}

// ─── Export Formats ─────────────────────────────────────────────────────

/**
 * Convert CFG data to DOT format for Graphviz rendering.
 */
export function cfgToDOT(cfgResult) {
  const lines = [];

  for (const r of cfgResult.results) {
    lines.push(`digraph "${r.name}" {`);
    lines.push('  rankdir=TB;');
    lines.push('  node [shape=box, fontname="monospace", fontsize=10];');

    for (const block of r.blocks) {
      const label = blockLabel(block);
      const shape = block.type === 'entry' || block.type === 'exit' ? 'ellipse' : 'box';
      const style =
        block.type === 'condition' || block.type === 'loop_header'
          ? ', style=filled, fillcolor="#ffffcc"'
          : '';
      lines.push(`  B${block.index} [label="${label}", shape=${shape}${style}];`);
    }

    for (const edge of r.edges) {
      const style = edgeStyle(edge.kind);
      lines.push(`  B${edge.source} -> B${edge.target} [label="${edge.kind}"${style}];`);
    }

    lines.push('}');
  }

  return lines.join('\n');
}

/**
 * Convert CFG data to Mermaid format.
 */
export function cfgToMermaid(cfgResult) {
  const lines = [];

  for (const r of cfgResult.results) {
    lines.push(`graph TD`);
    lines.push(`  subgraph "${r.name}"`);

    for (const block of r.blocks) {
      const label = blockLabel(block);
      if (block.type === 'entry' || block.type === 'exit') {
        lines.push(`    B${block.index}(["${label}"])`);
      } else if (block.type === 'condition' || block.type === 'loop_header') {
        lines.push(`    B${block.index}{"${label}"}`);
      } else {
        lines.push(`    B${block.index}["${label}"]`);
      }
    }

    for (const edge of r.edges) {
      const label = edge.kind;
      lines.push(`    B${edge.source} -->|${label}| B${edge.target}`);
    }

    lines.push('  end');
  }

  return lines.join('\n');
}

function blockLabel(block) {
  const loc =
    block.startLine && block.endLine
      ? ` L${block.startLine}${block.endLine !== block.startLine ? `-${block.endLine}` : ''}`
      : '';
  const label = block.label ? ` (${block.label})` : '';
  return `${block.type}${label}${loc}`;
}

function edgeStyle(kind) {
  if (kind === 'exception') return ', color=red, fontcolor=red';
  if (kind === 'branch_true') return ', color=green, fontcolor=green';
  if (kind === 'branch_false') return ', color=red, fontcolor=red';
  if (kind === 'loop_back') return ', style=dashed, color=blue';
  if (kind === 'loop_exit') return ', color=orange';
  if (kind === 'return') return ', color=purple';
  if (kind === 'break') return ', color=orange, style=dashed';
  if (kind === 'continue') return ', color=blue, style=dashed';
  return '';
}
