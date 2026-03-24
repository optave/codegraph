interface CoChangePartner {
  jaccard: number;
  commitCount: number;
  file: string;
}

interface CoChangeData {
  error?: string;
  file: string;
  partners: CoChangePartner[];
  meta?: { analyzedAt?: string; since?: string };
}

export function formatCoChange(data: CoChangeData): string {
  if (data.error) return data.error;
  if (data.partners.length === 0) return `No co-change partners found for ${data.file}`;

  const lines: string[] = [`\nCo-change partners for ${data.file}:\n`];
  for (const p of data.partners) {
    const pct = `${(p.jaccard * 100).toFixed(0)}%`.padStart(4);
    const commits = `${p.commitCount} commits`.padStart(12);
    lines.push(`  ${pct}  ${commits}  ${p.file}`);
  }
  if (data.meta?.analyzedAt) {
    lines.push(`\n  Analyzed: ${data.meta.analyzedAt} | Window: ${data.meta.since || 'all'}`);
  }
  return lines.join('\n');
}

interface CoChangePair {
  jaccard: number;
  commitCount: number;
  fileA: string;
  fileB: string;
}

interface CoChangeTopData {
  error?: string;
  pairs: CoChangePair[];
  meta?: { analyzedAt?: string; since?: string };
}

export function formatCoChangeTop(data: CoChangeTopData): string {
  if (data.error) return data.error;
  if (data.pairs.length === 0) return 'No co-change pairs found.';

  const lines: string[] = ['\nTop co-change pairs:\n'];
  for (const p of data.pairs) {
    const pct = `${(p.jaccard * 100).toFixed(0)}%`.padStart(4);
    const commits = `${p.commitCount} commits`.padStart(12);
    lines.push(`  ${pct}  ${commits}  ${p.fileA}  <->  ${p.fileB}`);
  }
  if (data.meta?.analyzedAt) {
    lines.push(`\n  Analyzed: ${data.meta.analyzedAt} | Window: ${data.meta.since || 'all'}`);
  }
  return lines.join('\n');
}
