/**
 * Integration test for #2025: `resolveCallTargets`'s same-file bare-name
 * lookup (kind-filtered by #1888) still ran unconditionally before any
 * type-aware receiver resolution for a concrete-receiver call (`obj.x()`).
 * If a coincidentally same-named function/method existed elsewhere in the
 * file, it could pre-empt the receiver's real, type-checked target — #1888
 * only excluded non-callable kinds (class/interface/etc.), not a genuinely
 * callable but unrelated same-named function/method.
 *
 * Fix: `resolveCallTargets`/`resolve_call_targets_core` now try the
 * type-aware receiver resolution even when a kind-filtered bare match
 * already exists, and prefer it UNLESS it resolves to the exact same
 * declaration (same file + line) as the bare match — preserving #1517's
 * computed-key object-literal method resolution, which deliberately
 * double-emits a bare and a qualified node for the identical physical
 * declaration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = `function method() {
  return 'unrelated';
}

class Widget {
  method() {
    return 'the real one';
  }
}

const obj = new Widget();
obj.method();
`;

/** The line + name of whatever `method`-related target the caller's sole `calls` edge resolved to. */
function readMethodCallTarget(
  dbPath: string,
  callerName: string,
): { name: string; line: number } | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT t.name AS name, t.line AS line
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE s.name = ? AND e.kind = 'calls' AND (t.name = 'method' OR t.name = 'Widget.method')`,
      )
      .get(callerName) as { name: string; line: number } | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

describe.each(['wasm', 'native'] as const)(
  'concrete-receiver bare-name collision resolves to the type-aware target, not an unrelated same-named function (#2025, %s)',
  (engine) => {
    let tmpDir: string;

    beforeAll(async () => {
      if (engine === 'native' && !isNativeAvailable()) return;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2025-${engine}-`));
      fs.writeFileSync(path.join(tmpDir, 'widget.js'), FIXTURE);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it.skipIf(engine === 'native' && !isNativeAvailable())(
      'obj.method() resolves to Widget.method (line 6), not the unrelated top-level method (line 1)',
      () => {
        const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
        // The call site is at file/top-level scope (no enclosing function),
        // so the caller is the file node itself.
        const target = readMethodCallTarget(dbPath, 'widget.js');
        expect(
          target,
          'no calls edge from widget.js to a method-related target found',
        ).not.toBeNull();
        expect(target).toEqual({ name: 'Widget.method', line: 6 });
      },
    );
  },
);

// ── Same-physical-line collision (review finding on #2227) ─────────────────
//
// The unrelated bare declaration and the type-aware target can coincidentally
// start on the exact same physical source line — comparing candidates by
// file+line coordinates alone cannot distinguish that from #1517's deliberate
// same-line double-emission, so the reconciliation must also require the
// #1517 kind pairing (bare `method` + type-aware `function`) before treating
// same-file-and-line as proof of identity.
const SAME_LINE_FIXTURE = `function method() { return 'unrelated'; } class Widget { method() { return 'the real one'; } }

const obj = new Widget();
obj.method();
`;

describe.each(['wasm', 'native'] as const)(
  'concrete-receiver bare-name collision on the SAME physical line still resolves to the type-aware target (#2025 follow-up, %s)',
  (engine) => {
    let tmpDir: string;

    beforeAll(async () => {
      if (engine === 'native' && !isNativeAvailable()) return;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2025-sameline-${engine}-`));
      fs.writeFileSync(path.join(tmpDir, 'widget2.js'), SAME_LINE_FIXTURE);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it.skipIf(engine === 'native' && !isNativeAvailable())(
      'obj.method() resolves to Widget.method, not the unrelated function sharing its declaration line',
      () => {
        const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
        const target = readMethodCallTarget(dbPath, 'widget2.js');
        expect(
          target,
          'no calls edge from widget2.js to a method-related target found',
        ).not.toBeNull();
        expect(target?.name).toBe('Widget.method');
      },
    );
  },
);
