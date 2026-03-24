import { briefData } from '../domain/analysis/brief.js';
import { outputResult } from './result-formatter.js';

interface BriefOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  config?: unknown;
}

interface BriefSymbol {
  name: string;
  role?: string;
  callerCount: number;
}

interface BriefResult {
  file: string;
  risk: string;
  symbols: BriefSymbol[];
  imports: string[];
  importedBy: string[];
  totalImporterCount: number;
}

export function brief(file: string, customDbPath: string | undefined, opts: BriefOpts = {}): void {
  const data = briefData(file, customDbPath as string, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  for (const r of data.results as BriefResult[]) {
    console.log(`${r.file} [${r.risk.toUpperCase()} RISK]`);

    // Symbols line
    if (r.symbols.length > 0) {
      const parts = r.symbols.map((s) => {
        const tags: string[] = [];
        if (s.role) tags.push(s.role);
        tags.push(`${s.callerCount} caller${s.callerCount !== 1 ? 's' : ''}`);
        return `${s.name} [${tags.join(', ')}]`;
      });
      console.log(`  Symbols: ${parts.join(', ')}`);
    }

    // Imports line
    if (r.imports.length > 0) {
      console.log(`  Imports: ${r.imports.join(', ')}`);
    }

    // Imported by line with transitive count
    if (r.importedBy.length > 0) {
      const transitive = r.totalImporterCount - r.importedBy.length;
      const suffix = transitive > 0 ? ` (+${transitive} transitive)` : '';
      console.log(`  Imported by: ${r.importedBy.join(', ')}${suffix}`);
    } else if (r.totalImporterCount > 0) {
      console.log(`  Imported by: ${r.totalImporterCount} transitive importers`);
    }
  }
}
