/**
 * Unit tests for resolveThisDispatch in cha.ts.
 *
 * Covers issue #2062: resolveThisDispatch resolved `this`/`super`/bare
 * `super(...)` calls to a same-named class in a completely unrelated file
 * whenever the caller's own same-named ancestor had no explicit definition
 * of the dispatched method (e.g. an implicit default constructor). Two
 * independent files each defining their own unrelated `Shape` class is the
 * exact repro from the issue.
 */
import { describe, expect, it } from 'vitest';
import type { CallNodeLookup } from '../../src/domain/graph/builder/call-resolver.js';
import { type ChaContext, resolveThisDispatch } from '../../src/domain/graph/builder/cha.js';

type Candidate = { id: number; file: string; kind: string; line: number };

/** Build a CallNodeLookup backed by two maps: qualified-name → candidates
 * (byName), and bare-name+file → candidates (byNameAndFile). */
function makeLookup(
  byNameMap: Record<string, Candidate[]>,
  byNameAndFileMap: Record<string, Record<string, Candidate[]>> = {},
): CallNodeLookup {
  return {
    byName(name) {
      return byNameMap[name] ?? [];
    },
    byNameAndFile(name, file) {
      return byNameAndFileMap[name]?.[file] ?? [];
    },
    isBarrel() {
      return false;
    },
    resolveBarrel() {
      return null;
    },
    nodeId() {
      return undefined;
    },
  };
}

function makeChaCtx(parents: Record<string, string>): ChaContext {
  return {
    implementors: new Map(),
    parents: new Map(Object.entries(parents)),
    instantiatedTypes: new Set(),
  };
}

describe('resolveThisDispatch — cross-file name collision (issue #2062)', () => {
  it('does not resolve a bare super() to an unrelated same-named class in another file', () => {
    // hierarchy.ts's own Shape has no explicit constructor (implicit
    // default) — only super-dispatch.ts's unrelated Shape defines one.
    const lookup = makeLookup(
      { 'Shape.constructor': [{ id: 1, file: 'super-dispatch.ts', kind: 'method', line: 1 }] },
      { Shape: { 'hierarchy.ts': [{ id: 2, file: 'hierarchy.ts', kind: 'class', line: 2 }] } },
    );
    const chaCtx = makeChaCtx({ Circle: 'Shape' });

    const result = resolveThisDispatch(
      'constructor',
      'Circle.constructor',
      'super',
      chaCtx,
      lookup,
      'hierarchy.ts',
    );
    expect(result).toEqual([]);
  });

  it('resolves a legitimate cross-file super call when the base class is not declared in the caller file at all', () => {
    // dog.ts imports Animal from base.ts — Animal is genuinely absent from
    // dog.ts, so the cross-file match is legitimate heritage, not a
    // same-named collision.
    const lookup = makeLookup(
      { 'Animal.speak': [{ id: 5, file: 'base.ts', kind: 'method', line: 5 }] },
      { Animal: {} },
    );
    const chaCtx = makeChaCtx({ Dog: 'Animal' });

    const result = resolveThisDispatch('speak', 'Dog.speak', 'super', chaCtx, lookup, 'dog.ts');
    expect(result).toEqual([{ id: 5, file: 'base.ts', kind: 'method', line: 5 }]);
  });

  it('still prefers the same-file candidate when both same-file and cross-file candidates exist', () => {
    const sameFile = { id: 1, file: 'a.ts', kind: 'method', line: 1 };
    const crossFile = { id: 2, file: 'b.ts', kind: 'method', line: 2 };
    const lookup = makeLookup({ 'Foo.bar': [sameFile, crossFile] }, { Foo: {} });
    const chaCtx = makeChaCtx({});

    const result = resolveThisDispatch('bar', 'Foo.bar', 'this', chaCtx, lookup, 'a.ts');
    expect(result).toEqual([sameFile]);
  });

  it('continues walking past a collided class to find a real grandparent match', () => {
    // Base has an explicit `greet` method in the SAME file as the caller's
    // own Middle class; a same-named, unrelated Middle class elsewhere has
    // no bearing on this walk once Base (found in the caller's own file's
    // hierarchy) supplies a real match.
    const lookup = makeLookup(
      {
        'Middle.greet': [{ id: 9, file: 'unrelated.ts', kind: 'method', line: 9 }],
        'Base.greet': [{ id: 10, file: 'real.ts', kind: 'method', line: 10 }],
      },
      { Middle: { 'real.ts': [{ id: 11, file: 'real.ts', kind: 'class', line: 11 }] } },
    );
    const chaCtx = makeChaCtx({ Child: 'Middle', Middle: 'Base' });

    const result = resolveThisDispatch('greet', 'Child.greet', 'this', chaCtx, lookup, 'real.ts');
    expect(result).toEqual([{ id: 10, file: 'real.ts', kind: 'method', line: 10 }]);
  });

  it('falls back to the unfiltered match when callerFile is not provided', () => {
    // No file context available — cannot distinguish same-file collisions,
    // so the pre-#2062 behavior (return whatever byName found) still applies.
    const lookup = makeLookup({ 'Foo.bar': [{ id: 3, file: 'x.ts', kind: 'method', line: 3 }] });
    const chaCtx = makeChaCtx({});

    const result = resolveThisDispatch('bar', 'Foo.bar', 'this', chaCtx, lookup);
    expect(result).toEqual([{ id: 3, file: 'x.ts', kind: 'method', line: 3 }]);
  });

  it('returns [] for a plain function callerName with no dot', () => {
    const lookup = makeLookup({});
    const chaCtx = makeChaCtx({});
    expect(resolveThisDispatch('bar', 'plainFunction', 'this', chaCtx, lookup, 'x.ts')).toEqual([]);
  });
});
