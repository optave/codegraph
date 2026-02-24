#!/usr/bin/env node

/**
 * Embedding strategy benchmark — compares structured vs source strategies
 * against real search queries on the current project's graph.
 *
 * Prerequisites:
 *   - @huggingface/transformers installed
 *   - codegraph build already run (graph.db exists)
 *
 * Usage:
 *   node tests/search/embedding-benchmark.js
 *   node tests/search/embedding-benchmark.js --model minilm
 */

import path from 'node:path';
import { buildEmbeddings, DEFAULT_MODEL, MODELS, searchData } from '../../src/embedder.js';

const model = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : DEFAULT_MODEL;

const rootDir = '.';
const dbPath = path.resolve('.codegraph/graph.db');

// Queries with expected best-match symbol name
const QUERIES = [
  { q: 'parse source code with tree-sitter', expect: 'parseFilesAuto' },
  { q: 'find circular dependencies', expect: 'findCycles' },
  { q: 'build dependency graph from source files', expect: 'buildGraph' },
  { q: 'resolve import path to actual file', expect: 'resolveImportPath' },
  { q: 'cosine similarity between vectors', expect: 'cosineSim' },
  { q: 'export graph as DOT format', expect: 'exportDOT' },
  { q: 'semantic search with embeddings', expect: 'search' },
  { q: 'incremental file hashing', expect: 'hashFile' },
  { q: 'load configuration from file', expect: 'loadConfig' },
  { q: 'extract functions and classes from code', expect: 'extractJavaScript' },
  { q: 'impact analysis of code changes', expect: 'diffImpactData' },
  { q: 'start MCP server for AI agents', expect: 'startMCPServer' },
  { q: 'watch files for changes', expect: 'watchProject' },
  { q: 'reciprocal rank fusion for multi-query search', expect: 'multiSearchData' },
];

async function benchmark(strategy) {
  await buildEmbeddings(rootDir, model, dbPath, { strategy });

  let hits1 = 0;
  let hits3 = 0;
  let hits5 = 0;
  const details = [];

  for (const { q, expect: expected } of QUERIES) {
    const data = await searchData(q, dbPath, { minScore: 0.01, limit: 10 });
    if (!data) continue;

    const names = data.results.map((r) => r.name);
    const rank = names.indexOf(expected) + 1; // 0 = not found
    if (rank === 1) hits1++;
    if (rank >= 1 && rank <= 3) hits3++;
    if (rank >= 1 && rank <= 5) hits5++;

    const matchScore = rank > 0 ? data.results[rank - 1].similarity.toFixed(3) : 'miss';
    details.push({
      q: q.slice(0, 50),
      expected,
      rank: rank || '>10',
      actual: names[0],
      matchScore,
    });
  }

  return { strategy, hits1, hits3, hits5, total: QUERIES.length, details };
}

const modelConfig = MODELS[model];
console.log('=== Embedding Strategy Benchmark ===');
console.log(`Model: ${model} (${modelConfig.dim}d, ${modelConfig.contextWindow} token context)`);
console.log(`Queries: ${QUERIES.length}`);
console.log('');

const structured = await benchmark('structured');
const source = await benchmark('source');

// Summary table
console.log('');
console.log('=== RESULTS ===');
console.log('');
console.log(`${'Metric'.padEnd(12)}${'structured'.padEnd(16)}${'source'.padEnd(16)}delta`);
for (const [label, key] of [
  ['Hit@1', 'hits1'],
  ['Hit@3', 'hits3'],
  ['Hit@5', 'hits5'],
]) {
  const s = structured[key];
  const o = source[key];
  const sp = `${s}/${structured.total} (${((s / structured.total) * 100).toFixed(0)}%)`;
  const op = `${o}/${source.total} (${((o / source.total) * 100).toFixed(0)}%)`;
  const delta = s - o;
  const sign = delta > 0 ? '+' : '';
  console.log(`${label.padEnd(12)}${sp.padEnd(16)}${op.padEnd(16)}${sign}${delta}`);
}

// Per-query comparison
console.log('');
console.log(`${'Query'.padEnd(52)}${'Expected'.padEnd(22)}Struct  Source`);
for (let i = 0; i < QUERIES.length; i++) {
  const s = structured.details[i];
  const o = source.details[i];
  const sw =
    typeof s.rank === 'number' && (typeof o.rank !== 'number' || s.rank < o.rank) ? '*' : ' ';
  const ow =
    typeof o.rank === 'number' && (typeof s.rank !== 'number' || o.rank < s.rank) ? '*' : ' ';
  console.log(
    s.q.padEnd(52) +
      s.expected.padEnd(22) +
      String(s.rank).padEnd(4) +
      sw +
      '   ' +
      String(o.rank).padEnd(4) +
      ow,
  );
}
console.log('');
console.log('* = better rank for that query');
