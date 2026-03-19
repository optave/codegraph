#!/usr/bin/env node

/**
 * Verify that all dynamic import() paths in src/ resolve to existing files.
 *
 * Catches stale paths left behind after moves/renames — the class of bug
 * that caused the ast-command crash (see roadmap 10.3).
 *
 * Exit codes:
 *   0 — all imports resolve
 *   1 — one or more broken imports found
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcDir = resolve(__dirname, '..', 'src');

// ── collect source files ────────────────────────────────────────────────
function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...walk(full));
    } else if (/\.[jt]sx?$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ── extract dynamic import specifiers ───────────────────────────────────
// Matches:  await import('...')  and  await import("...")
const DYNAMIC_IMPORT_RE = /await\s+import\(\s*(['"])(.+?)\1\s*\)/g;

function extractDynamicImports(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const imports = [];
  const lines = src.split('\n');

  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track block comments (/** ... */ and /* ... */)
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(line)) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    // Skip single-line comments
    if (/^\s*\/\//.test(line)) continue;

    let match;
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    while ((match = DYNAMIC_IMPORT_RE.exec(line)) !== null) {
      // Skip if the match is inside a trailing comment
      const before = line.slice(0, match.index);
      if (before.includes('//') || before.includes('/*')) continue;

      imports.push({ specifier: match[2], line: i + 1 });
    }
  }
  return imports;
}

// ── resolve a specifier to a file on disk ───────────────────────────────
function resolveSpecifier(specifier, fromFile) {
  // Skip bare specifiers (packages): 'node:*', '@scope/pkg', 'pkg'
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;

  const base = dirname(fromFile);
  const target = resolve(base, specifier);

  // Exact file exists
  if (existsSync(target) && statSync(target).isFile()) return null;

  // Try implicit extensions (.js, .ts, .mjs, .cjs)
  for (const ext of ['.js', '.ts', '.mjs', '.cjs']) {
    if (!extname(target) && existsSync(target + ext)) return null;
  }

  // Try index files (directory import)
  if (existsSync(target) && statSync(target).isDirectory()) {
    for (const idx of ['index.js', 'index.ts', 'index.mjs']) {
      if (existsSync(join(target, idx))) return null;
    }
  }

  // Not resolved — broken
  return specifier;
}

// ── main ────────────────────────────────────────────────────────────────
const files = walk(srcDir);
const broken = [];

for (const file of files) {
  const imports = extractDynamicImports(file);
  for (const { specifier, line } of imports) {
    const bad = resolveSpecifier(specifier, file);
    if (bad !== null) {
      const rel = file.replace(resolve(srcDir, '..') + '/', '').replace(/\\/g, '/');
      broken.push({ file: rel, line, specifier: bad });
    }
  }
}

if (broken.length === 0) {
  console.log(`✓ All dynamic imports in src/ resolve (${files.length} files scanned)`);
  process.exit(0);
} else {
  console.error(`✗ ${broken.length} broken dynamic import(s) found:\n`);
  for (const { file, line, specifier } of broken) {
    console.error(`  ${file}:${line}  →  ${specifier}`);
  }
  console.error('\nFix the import paths and re-run.');
  process.exit(1);
}
