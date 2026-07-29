#!/usr/bin/env node
/**
 * Updates per-language recall/precision floors in the resolution benchmark
 * threshold table after a stable release.
 *
 * Reads benchmark-result.json (the merged artifact produced by the
 * pre-publish-benchmark CI job, which stores per-language resolution metrics
 * under the `resolution` key). For each language whose actual precision or
 * recall exceeds the current floor, the floor is raised to
 * floor(actual * 100) / 100 — rounded down to 2 decimal places so the gate
 * stays slightly conservative.
 *
 * This is intentionally a one-way ratchet: floors are never lowered.
 *
 * Usage: node scripts/update-recall-floors.mjs <benchmark-result.json>
 */
import fs from 'node:fs';
import path from 'node:path';

const resultsPath = process.argv[2];
if (!resultsPath) {
  console.error('Usage: update-recall-floors.mjs <benchmark-result.json>');
  process.exit(1);
}

const THRESHOLD_FILE = path.join(
  import.meta.dirname,
  '../tests/benchmarks/resolution/resolution-benchmark.test.ts',
);

const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
// benchmark-result.json stores per-language resolution metrics under `.resolution`
// (merged in CI by the "Merge resolution into build result" step). Accept both
// the nested form and a bare per-language map for local use.
const results = raw.resolution ?? raw;

let content = fs.readFileSync(THRESHOLD_FILE, 'utf-8');

/** Format a floor value: keep at least one decimal place, no trailing zeros. */
function fmt(n) {
  const s = String(Math.floor(n * 100) / 100);
  return s.includes('.') ? s : `${s}.0`;
}

/** Escape regex metacharacters so a language key (e.g. a future "c++") is matched literally. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let updatedCount = 0;

for (const [lang, metrics] of Object.entries(results)) {
  if (typeof metrics?.precision !== 'number' || typeof metrics?.recall !== 'number') continue;

  // Match lines of the form `  lang: { precision: X, recall: Y },` (bare identifier
  // keys) or `  'lang-with-hyphens': { precision: X, recall: Y },` (keys that aren't
  // valid bare identifiers, e.g. "pts-javascript", are quoted in the source).
  const pattern = new RegExp(
    `(  '?${escapeRegExp(lang)}'?: \\{ precision: )([\\d.]+)(, recall: )([\\d.]+)( \\})`,
  );
  const match = content.match(pattern);
  if (!match) continue;

  const currentPrecision = parseFloat(match[2]);
  const currentRecall = parseFloat(match[4]);

  const newPrecision = Math.max(currentPrecision, Math.floor(metrics.precision * 100) / 100);
  const newRecall = Math.max(currentRecall, Math.floor(metrics.recall * 100) / 100);

  if (newPrecision === currentPrecision && newRecall === currentRecall) continue;

  content = content.replace(pattern, `$1${fmt(newPrecision)}$3${fmt(newRecall)}$5`);
  console.log(
    `  ${lang}: precision ${fmt(currentPrecision)} → ${fmt(newPrecision)}, recall ${fmt(currentRecall)} → ${fmt(newRecall)}`,
  );
  updatedCount++;
}

if (updatedCount > 0) {
  fs.writeFileSync(THRESHOLD_FILE, content);
  console.log(`\nBumped ${updatedCount} language threshold(s).`);
} else {
  console.log('No thresholds improved — nothing to update.');
}
