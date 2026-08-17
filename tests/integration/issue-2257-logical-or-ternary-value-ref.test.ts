/**
 * Integration test for #2257: a function referenced only as a logical-or/
 * nullish-coalescing fallback or ternary default (e.g.
 * `const fetchFn = options._fetchLatest || fetchLatestVersion`) produced no
 * `calls` edge at all — unlike the #1771 object-literal-property-value
 * pattern, which gets a real edge once invocation evidence is confirmed
 * (#1895). The function was only kept out of `roles --role dead` via
 * `classifyUnreferencedNode`'s `fanOut > 0` heuristic rescue, which does not
 * make the function a reachability ROOT (#2032) — so a callee reachable only
 * through it (e.g. `collectResponseBody`, called only by `fetchLatestVersion`
 * in `src/infrastructure/update-check.ts`) was wrongly flagged dead.
 *
 * Fix: `const x = a || b` / `const x = a ?? b` / `const x = cond ? a : b`
 * now extract a value-ref `calls` edge from the enclosing scope to each bare-
 * identifier operand/branch — but only when the declared variable `x` is
 * referenced again somewhere in its own enclosing block. That local,
 * position-scoped check (not a global name-based one, unlike #1895's
 * `invokedPropertyNames`) is what distinguishes `reachedViaFallback` (whose
 * variable is later passed to `useCallback`) from `deadViaUnusedFallback`
 * (whose variable is declared and never touched again) — both reference
 * their target identically, so only the liveness check tells them apart.
 *
 * Also covers #2438 (deferred from PR #2432's review): the liveness scan
 * ignored plain writes correctly, but didn't model a write as a KILL — a
 * read occurring after the variable has already been unconditionally
 * overwritten was still credited as evidence the fallback is consumed, even
 * though that read can only ever see the new value. Fixed by having the
 * per-statement scan stop once it passes a statement that unconditionally
 * overwrites the name (`killsBinding`/`kills_binding`), while still crediting
 * a genuine read on the killing statement's OWN right-hand side first. A
 * write nested inside a conditional must NOT kill, since the original value
 * can still reach a later read when the branch doesn't run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'factory.js': `
function reachedViaFallback(x) { calleeOfReachedFn(); return x; }
function calleeOfReachedFn() { return 42; }

function deadViaUnusedFallback(x) { return x + 2; }

function ternaryLeft() { return 1; }
function ternaryRight() { return 2; }

function useCallback(fn) { return fn(1); }

function shadowedFallback(x) { return x + 3; }
function unrelatedShadower() { return 99; }

function siblingUsed(x) { return x + 4; }

function readAroundNestedVar(x) { return x + 5; }
function hoistedInNestedFn(x) { return x + 6; }
function loopOwnBinding(x) { return x + 7; }
function loopBareTarget(x) { return x + 8; }

function killedThenRead(x) { return x + 9; }
function killedByVarRedeclare(x) { return x + 10; }
function survivesConditionalWrite(x) { return x + 11; }
function survivesSelfReadInKillStatement(x) { return x + 12; }
function somethingElse(x) { return x + 13; }
function killedByParenthesizedAssign(x) { return x + 14; }
function killedByLaterDeclaratorInSameStatement(x) { return x + 15; }
function killedBySequenceExprPriorPart(x) { return x + 16; }

// #2438: a plain top-level reassignment kills the fallback value before the
// later read runs — that read sees \`other\`, never \`killedThenRead\`.
export function killAssignBeforeRead(opts, other) {
  let fn = opts.custom || killedThenRead;
  fn = other;
  return fn();
}

// #2438: a \`var\` redeclaration in a later sibling statement is the same
// kind of unconditional overwrite as a plain assignment.
export function killViaVarRedeclare(opts, other) {
  var fn = opts.custom || killedByVarRedeclare;
  var fn = other;
  return fn();
}

// #2438: a write inside a conditional is NOT a guaranteed kill — the
// fallback can still reach the later read when \`cond\` is false.
export function conditionalWriteDoesNotKill(opts, other, cond) {
  let fn = opts.custom || survivesConditionalWrite;
  if (cond) {
    fn = other;
  }
  return fn();
}

// #2438: the killing statement's OWN right-hand side is scanned for a
// genuine read before the kill takes effect — \`fn\` on the right of its own
// reassignment still reads the pre-existing (possibly fallback) value.
export function selfReadWithinKillStatement(opts) {
  let fn = opts.custom || survivesSelfReadInKillStatement;
  fn = fn || somethingElse;
  return fn;
}

// #2438 (Greptile review): a kill wrapped in parentheses is exactly as
// unconditional as a bare assignment statement.
export function killViaParenthesizedAssign(opts, other) {
  let fn = opts.custom || killedByParenthesizedAssign;
  (fn = other);
  return fn();
}

// #2438 (Greptile review): within a single LATER statement, an earlier
// declarator's redeclaration kills the value before a later declarator's
// own initializer in that same statement runs.
export function killViaLaterDeclaratorInSameStatement(opts, other) {
  var fn = opts.custom || killedByLaterDeclaratorInSameStatement;
  var fn = other, result = fn();
  return result;
}

// #2438 (Greptile review): a sequence expression's parts execute in order —
// a kill earlier in the sequence must suppress a read later in the SAME
// sequence.
export function killViaSequenceExprPriorPart(opts, other) {
  let fn = opts.custom || killedBySequenceExprPriorPart;
  return (fn = other, fn());
}

// \`var\` is FUNCTION-scoped, so the nested block's \`var varScoped\` is the SAME
// binding as the outer one — the \`varScoped()\` read before it genuinely
// consumes the fallback, and must not be pruned as a nested-scope shadow.
export function nestedVarBlock(opts) {
  var varScoped = opts.z || readAroundNestedVar;
  {
    varScoped();
    var varScoped = somethingElse;
  }
}

// The inner function hoists its OWN \`var hoisted\` (from a deeper block), so
// \`hoisted()\` there reads that binding, never the outer fallback.
export function nestedFnHoistsVar(opts) {
  var hoisted = opts.z || hoistedInNestedFn;
  function inner(flag) {
    if (flag) { var hoisted = 1; }
    return hoisted();
  }
  return inner;
}

// A for-in/of head that BINDS the name kills the pre-loop value: the body's
// read is of the loop's own per-iteration binding, not the fallback.
export function loopDeclaringOwnBinding(opts, values) {
  const loopVar = opts.z || loopOwnBinding;
  for (let loopVar of values) { loopVar(); }
}

// Same for a bare (non-declaring) target — it reassigns before the body runs.
export function loopBareAssignTarget(opts, values) {
  let bare = opts.z || loopBareTarget;
  for (bare of values) { bare(); }
}

export function run(opts, cond) {
  const fetchFn = opts.custom || reachedViaFallback;
  const neverUsedAgain = opts.other || deadViaUnusedFallback;
  const picked = cond ? ternaryLeft : ternaryRight;

  const shadowTest = opts.x || shadowedFallback;
  function helper() {
    let shadowTest = unrelatedShadower();
    return shadowTest();
  }

  const siblingTest = opts.y || siblingUsed, siblingResult = siblingTest();

  return useCallback(fetchFn) + useCallback(picked) + helper() + siblingResult;
}
`,
};

const DEAD_ROLES = new Set(['dead-unresolved', 'dead-leaf', 'dead-entry', 'dead-ffi']);

function readNodesWithRoles(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, kind, role FROM nodes ORDER BY name').all() as Array<{
      name: string;
      kind: string;
      role: string | null;
    }>;
  } finally {
    db.close();
  }
}

function countCallEdgesTo(dbPath: string, targetName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM edges e
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND t.name = ?`,
      )
      .get(targetName) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function runShared(getDbPath: () => string) {
  it('creates a value-ref edge for a logical-or fallback whose variable is used again', () => {
    expect(countCallEdgesTo(getDbPath(), 'reachedViaFallback')).toBeGreaterThan(0);
  });

  it('does not create a value-ref edge when the variable is never referenced again', () => {
    expect(countCallEdgesTo(getDbPath(), 'deadViaUnusedFallback')).toBe(0);
  });

  it('creates value-ref edges for both ternary branches', () => {
    expect(countCallEdgesTo(getDbPath(), 'ternaryLeft')).toBeGreaterThan(0);
    expect(countCallEdgesTo(getDbPath(), 'ternaryRight')).toBeGreaterThan(0);
  });

  it('keeps a callee reachable only through the logical-or fallback alive (#2032)', () => {
    const nodes = readNodesWithRoles(getDbPath());
    const callee = nodes.find((n) => n.name === 'calleeOfReachedFn' && n.kind === 'function');
    expect(callee, 'calleeOfReachedFn node not found').toBeDefined();
    expect(DEAD_ROLES.has(callee!.role ?? '')).toBe(false);
  });

  it('classifies the unused-fallback function as dead', () => {
    const nodes = readNodesWithRoles(getDbPath());
    const dead = nodes.find((n) => n.name === 'deadViaUnusedFallback' && n.kind === 'function');
    expect(dead, 'deadViaUnusedFallback node not found').toBeDefined();
    expect(DEAD_ROLES.has(dead!.role ?? '')).toBe(true);
  });

  it('does not credit liveness from a same-named binding shadowed in a nested scope', () => {
    expect(countCallEdgesTo(getDbPath(), 'shadowedFallback')).toBe(0);
  });

  it('creates a value-ref edge when the variable is used by a sibling declarator in the same statement', () => {
    expect(countCallEdgesTo(getDbPath(), 'siblingUsed')).toBeGreaterThan(0);
  });

  // Greptile review, PR #2432: `var` is function-scoped, so a nested block's
  // `var` redeclaration is the SAME binding — it must not prune the block and
  // discard a genuine read of the fallback.
  it('still credits liveness from a read in a block that also redeclares the name via var', () => {
    expect(countCallEdgesTo(getDbPath(), 'readAroundNestedVar')).toBeGreaterThan(0);
  });

  // The flip side of the same `var` model: a nested function that hoists its
  // own `var` of that name — from ANY depth in its body — shadows the outer
  // variable for the whole function, so a read there is not evidence.
  it('does not credit liveness from a nested function that hoists its own var', () => {
    expect(countCallEdgesTo(getDbPath(), 'hoistedInNestedFn')).toBe(0);
  });

  // A for-of head binding the name kills the pre-loop value, whether it
  // declares a new binding or reassigns the existing one.
  it('does not credit liveness from a for-of loop that declares its own binding', () => {
    expect(countCallEdgesTo(getDbPath(), 'loopOwnBinding')).toBe(0);
  });

  it('does not credit liveness from a for-of body read of a bare loop target', () => {
    expect(countCallEdgesTo(getDbPath(), 'loopBareTarget')).toBe(0);
  });

  // #2438: a read after an unconditional overwrite must not be credited.
  it('does not credit liveness from a read that a prior unconditional assignment already killed', () => {
    expect(countCallEdgesTo(getDbPath(), 'killedThenRead')).toBe(0);
  });

  it('does not credit liveness from a read after a var redeclaration in a later statement', () => {
    expect(countCallEdgesTo(getDbPath(), 'killedByVarRedeclare')).toBe(0);
  });

  it('still credits liveness from a read after a write nested inside a conditional', () => {
    expect(countCallEdgesTo(getDbPath(), 'survivesConditionalWrite')).toBeGreaterThan(0);
  });

  it('still credits a genuine read on the right-hand side of the killing statement itself', () => {
    expect(countCallEdgesTo(getDbPath(), 'survivesSelfReadInKillStatement')).toBeGreaterThan(0);
  });

  // Greptile review, PR #2554: a kill wrapped in parentheses must be
  // recognized just like a bare assignment statement.
  it('does not credit liveness from a read after a parenthesized kill assignment', () => {
    expect(countCallEdgesTo(getDbPath(), 'killedByParenthesizedAssign')).toBe(0);
  });

  // Greptile review, PR #2554: an earlier declarator's kill within a LATER
  // statement must suppress a later declarator's read in that SAME statement.
  it('does not credit liveness from a later declarator reading a value an earlier declarator in the same statement killed', () => {
    expect(countCallEdgesTo(getDbPath(), 'killedByLaterDeclaratorInSameStatement')).toBe(0);
  });

  // Greptile review, PR #2554: a sequence expression's own internal ordering
  // must be respected — a kill earlier in the sequence suppresses a read
  // later in the SAME sequence.
  it('does not credit liveness from a read later in a sequence expression whose earlier part killed it', () => {
    expect(countCallEdgesTo(getDbPath(), 'killedBySequenceExprPriorPart')).toBe(0);
  });
}

describe('logical-or/ternary value-ref requires local usage evidence (#2257) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2257-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  runShared(() => path.join(tmpDir, '.codegraph', 'graph.db'));
});

describe.skipIf(!isNativeAvailable())(
  'logical-or/ternary value-ref requires local usage evidence (#2257) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2257-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    runShared(() => path.join(nativeTmpDir, '.codegraph', 'graph.db'));
  },
);
