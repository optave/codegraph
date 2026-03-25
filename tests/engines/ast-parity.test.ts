/**
 * AST node extraction parity tests (native vs WASM).
 *
 * Verifies that the native Rust engine extracts identical AST nodes
 * (call, new, throw, await, string, regex) to the WASM visitor for JS/TS.
 *
 * Skipped when the native engine is not installed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractSymbols, getParser } from '../../src/domain/parser.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

let native: ReturnType<typeof Object.create>;
let parsers: ReturnType<typeof Object.create>;

function wasmExtract(code: string, filePath: string) {
  const parser = getParser(parsers, filePath);
  if (!parser) return null;
  const tree = parser.parse(code);
  return extractSymbols(tree, filePath);
}

function nativeExtract(code: string, filePath: string) {
  // 4th arg = include_ast_nodes = true
  return native.parseFile(filePath, code, false, true);
}

interface AstNodeLike {
  kind: string;
  name: string;
  line: number;
  text?: string;
  receiver?: string;
}

/** Normalize AST nodes for comparison — strip text content (may differ in truncation). */
function normalizeAstNodes(nodes: AstNodeLike[]) {
  return (nodes || [])
    .map((n) => ({
      kind: n.kind,
      name: n.name,
      line: n.line,
      ...(n.receiver ? { receiver: n.receiver } : {}),
    }))
    .sort(
      (a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    );
}

/** Count nodes per kind. */
function countByKind(nodes: AstNodeLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes || []) {
    counts[n.kind] = (counts[n.kind] || 0) + 1;
  }
  return counts;
}

// ─── Test snippets ──────────────────────────────────────────────────────

const JS_SNIPPET = `
import fs from 'fs';
import path from 'path';

class MyError extends Error {
  constructor(msg) {
    super(msg);
  }
}

function greet(name) {
  console.log("Hello " + name);
  const result = fetch("/api/users");
  return result;
}

async function loadData(url) {
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data) {
    throw new MyError("no data");
  }
  return data;
}

const pattern = /^[a-z]+$/i;
const obj = new Map();
const value = "some string value";
`;

const TS_SNIPPET = `
interface Config {
  apiUrl: string;
  timeout: number;
}

async function request(config: Config): Promise<Response> {
  const url = config.apiUrl;
  const resp = await fetch(url, { signal: AbortSignal.timeout(config.timeout) });
  if (!resp.ok) {
    throw new Error(\`HTTP \${resp.status}\`);
  }
  return resp.json();
}

function processItems(items: string[]): void {
  items.forEach(item => {
    console.log(item);
    item.trim().toLowerCase();
  });
}
`;

const MULTI_CALL_SNIPPET = `
function nested() {
  const a = foo(bar(baz()));
  const b = obj.method(helper());
  console.log("test");
}
`;

describe('AST node parity (native vs WASM)', () => {
  beforeAll(async () => {
    if (!isNativeAvailable()) return;
    const mod = await import('../../src/infrastructure/native.js');
    native = (mod as Record<string, unknown>).loadNative;
    if (typeof native === 'function') native = native();
    parsers = await createParsers();
  });

  it.skipIf(!isNativeAvailable())('JS: same AST node kinds and counts', () => {
    const wasmResult = wasmExtract(JS_SNIPPET, '/test/sample.js');
    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');

    expect(wasmResult).toBeTruthy();
    expect(nativeResult).toBeTruthy();

    // Native now includes call nodes in astNodes; WASM doesn't (calls are separate).
    // Compare non-call AST nodes for exact parity.
    const wasmNodes = normalizeAstNodes(
      (wasmResult?.astNodes || []).filter((n: AstNodeLike) => n.kind !== 'call'),
    );
    const nativeNodes = normalizeAstNodes(
      (nativeResult.astNodes || nativeResult.ast_nodes || []).filter(
        (n: AstNodeLike) => n.kind !== 'call',
      ),
    );

    expect(nativeNodes).toEqual(wasmNodes);
  });

  it.skipIf(!isNativeAvailable())('JS: native astNodes includes call kind', () => {
    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');
    const astNodes = nativeResult.astNodes || nativeResult.ast_nodes || [];
    const callNodes = astNodes.filter((n: AstNodeLike) => n.kind === 'call');

    // JS snippet has: console.log, fetch (×2), resp.json, Map (new is separate)
    expect(callNodes.length).toBeGreaterThan(0);

    // Verify call nodes have expected structure
    for (const node of callNodes) {
      expect(node.kind).toBe('call');
      expect(typeof node.name).toBe('string');
      expect(typeof node.line).toBe('number');
    }
  });

  it.skipIf(!isNativeAvailable())('JS: call receiver extraction', () => {
    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');
    const astNodes = nativeResult.astNodes || nativeResult.ast_nodes || [];
    const callNodes = astNodes.filter((n: AstNodeLike) => n.kind === 'call');

    // console.log() should have receiver "console"
    const consoleLog = callNodes.find((n: AstNodeLike) => n.name === 'console.log');
    expect(consoleLog).toBeTruthy();
    expect(consoleLog.receiver).toBe('console');

    // fetch() should have no receiver
    const fetchCall = callNodes.find((n: AstNodeLike) => n.name === 'fetch');
    expect(fetchCall).toBeTruthy();
    expect(fetchCall.receiver).toBeFalsy();
  });

  it.skipIf(!isNativeAvailable())('TS: same non-call AST node counts', () => {
    const wasmResult = wasmExtract(TS_SNIPPET, '/test/sample.ts');
    const nativeResult = nativeExtract(TS_SNIPPET, '/test/sample.ts');

    expect(wasmResult).toBeTruthy();
    expect(nativeResult).toBeTruthy();

    const wasmCounts = countByKind(
      (wasmResult?.astNodes || []).filter((n: AstNodeLike) => n.kind !== 'call'),
    );
    const nativeCounts = countByKind(
      (nativeResult.astNodes || nativeResult.ast_nodes || []).filter(
        (n: AstNodeLike) => n.kind !== 'call',
      ),
    );

    expect(nativeCounts).toEqual(wasmCounts);
  });

  it.skipIf(!isNativeAvailable())('JS: nested calls are not double-counted', () => {
    const nativeResult = nativeExtract(MULTI_CALL_SNIPPET, '/test/nested.js');
    const astNodes = nativeResult.astNodes || nativeResult.ast_nodes || [];
    const callNodes = astNodes.filter((n: AstNodeLike) => n.kind === 'call');

    // foo(bar(baz())) should produce 3 separate call nodes
    const names = callNodes.map((n: AstNodeLike) => n.name).sort();
    expect(names).toContain('foo');
    expect(names).toContain('bar');
    expect(names).toContain('baz');
    expect(names).toContain('console.log');
    expect(names).toContain('obj.method');
    expect(names).toContain('helper');

    // No duplicate lines for the nested chain
    const fooLine = callNodes.find((n: AstNodeLike) => n.name === 'foo')?.line;
    const barLine = callNodes.find((n: AstNodeLike) => n.name === 'bar')?.line;
    const bazLine = callNodes.find((n: AstNodeLike) => n.name === 'baz')?.line;
    // All on the same line but each as separate nodes
    expect(fooLine).toBe(barLine);
    expect(barLine).toBe(bazLine);
  });

  it.skipIf(!isNativeAvailable())('JS: native calls match legacy calls field count', () => {
    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');
    const astNodes = nativeResult.astNodes || nativeResult.ast_nodes || [];
    const nativeCallNodes = astNodes.filter((n: AstNodeLike) => n.kind === 'call');
    const legacyCalls = nativeResult.calls || [];

    // Native ast_nodes call count should match the legacy calls field
    expect(nativeCallNodes.length).toBe(legacyCalls.length);
  });

  it.skipIf(!isNativeAvailable())('empty file returns empty astNodes array (not undefined)', () => {
    const nativeResult = nativeExtract('// empty file\n', '/test/empty.js');
    const astNodes = nativeResult.astNodes || nativeResult.ast_nodes;

    // Should be an array (possibly empty), not undefined
    expect(Array.isArray(astNodes)).toBe(true);
  });
});
