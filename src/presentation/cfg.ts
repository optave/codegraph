import { cfgData, cfgToDOT, cfgToMermaid } from '../features/cfg.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface CfgCliOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  file?: string;
  kind?: string;
  format?: string;
  limit?: number;
  offset?: number;
}

interface CfgBlock {
  index: number;
  type: string;
  label?: string;
  startLine?: number;
  endLine?: number;
}

interface CfgEdge {
  source: number;
  target: number;
  kind: string;
}

interface CfgResultEntry {
  kind: string;
  name: string;
  file: string;
  line: number;
  summary: { blockCount: number; edgeCount: number };
  blocks: CfgBlock[];
  edges: CfgEdge[];
}

export function cfg(name: string, customDbPath: string | undefined, opts: CfgCliOpts = {}): void {
  const data = cfgData(name, customDbPath, opts);

  if (outputResult(data, 'results', opts)) return;

  if (data.warning) {
    console.log(`\u26A0  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  const format = opts.format || 'text';
  if (format === 'dot') {
    console.log(cfgToDOT(data));
    return;
  }
  if (format === 'mermaid') {
    console.log(cfgToMermaid(data));
    return;
  }

  // Text format
  for (const r of data.results as CfgResultEntry[]) {
    console.log(`\n${r.kind} ${r.name}  (${r.file}:${r.line})`);
    console.log('\u2500'.repeat(60));
    console.log(`  Blocks: ${r.summary.blockCount}  Edges: ${r.summary.edgeCount}`);

    if (r.blocks.length > 0) {
      console.log('\n  Blocks:');
      for (const b of r.blocks) {
        const loc = b.startLine
          ? ` L${b.startLine}${b.endLine && b.endLine !== b.startLine ? `-${b.endLine}` : ''}`
          : '';
        const label = b.label ? ` (${b.label})` : '';
        console.log(`    [${b.index}] ${b.type}${label}${loc}`);
      }
    }

    if (r.edges.length > 0) {
      console.log('\n  Edges:');
      for (const e of r.edges) {
        console.log(`    B${e.source} \u2192 B${e.target}  [${e.kind}]`);
      }
    }
  }
}
