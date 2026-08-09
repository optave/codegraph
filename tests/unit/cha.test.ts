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
import {
  type ChaContext,
  resolveChaTargets,
  resolveThisDispatch,
} from '../../src/domain/graph/builder/cha.js';

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

function makeChaCtx(
  parents: Record<string, string>,
  parentsByFile: Record<string, string> = {},
): ChaContext {
  return {
    implementors: new Map(),
    implementorsByFile: new Map(),
    parents: new Map(Object.entries(parents)),
    parentsByFile: new Map(Object.entries(parentsByFile)),
    instantiatedTypes: new Set(),
  };
}

/** Build a ChaContext for resolveChaTargets tests (implementors-focused). */
function makeChaTargetsCtx(opts: {
  implementors?: Record<string, string[]>;
  implementorsByFile?: Record<string, string[]>;
  parents?: Record<string, string>;
  parentsByFile?: Record<string, string>;
  instantiatedTypes?: string[];
}): ChaContext {
  return {
    implementors: new Map(Object.entries(opts.implementors ?? {})),
    implementorsByFile: new Map(Object.entries(opts.implementorsByFile ?? {})),
    parents: new Map(Object.entries(opts.parents ?? {})),
    parentsByFile: new Map(Object.entries(opts.parentsByFile ?? {})),
    instantiatedTypes: new Set(opts.instantiatedTypes ?? []),
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
    const chaCtx = makeChaCtx({ Circle: 'Shape' }, { 'Circle|hierarchy.ts': 'Shape' });

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
    const chaCtx = makeChaCtx({ Dog: 'Animal' }, { 'Dog|dog.ts': 'Animal' });

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
    const chaCtx = makeChaCtx({ Child: 'Middle', Middle: 'Base' }, { 'Middle|real.ts': 'Base' });

    const result = resolveThisDispatch('greet', 'Child.greet', 'this', chaCtx, lookup, 'real.ts');
    expect(result).toEqual([{ id: 10, file: 'real.ts', kind: 'method', line: 10 }]);
  });

  it('does not misdirect the walk through a colliding class whose bare-name parent belongs to a different file', () => {
    // Two files each declare an unrelated `Middle` class with a DIFFERENT
    // parent: real.ts's Middle extends Base (which has `greet`); other.ts's
    // Middle extends Unrelated (which also has `greet`, incorrectly). The
    // global bare-name `parents` map is first-write-wins and here points to
    // other.ts's Middle -> Unrelated — if the walk blindly followed it after
    // rejecting the collision, it would wrongly resolve to Unrelated.greet
    // instead of the caller's real ancestor, Base.greet.
    const lookup = makeLookup(
      {
        'Middle.greet': [{ id: 9, file: 'other.ts', kind: 'method', line: 9 }],
        'Base.greet': [{ id: 10, file: 'real.ts', kind: 'method', line: 10 }],
        'Unrelated.greet': [{ id: 12, file: 'other.ts', kind: 'method', line: 12 }],
      },
      { Middle: { 'real.ts': [{ id: 11, file: 'real.ts', kind: 'class', line: 11 }] } },
    );
    const chaCtx = makeChaCtx(
      // Bare-name map deliberately points the wrong way (as if other.ts's
      // Middle -> Unrelated were recorded first project-wide).
      { Child: 'Middle', Middle: 'Unrelated' },
      { 'Middle|real.ts': 'Base' },
    );

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

describe('resolveChaTargets — cross-file same-name collision (issue #2237, part 1)', () => {
  it('does not merge two unrelated same-named interfaces declared in different files', () => {
    // file1.ts declares its own Handler + HandlerA implements Handler.
    // file2.ts independently declares an UNRELATED Handler + HandlerB implements Handler.
    // Dispatching from a caller in file1.ts must reach only HandlerA, never HandlerB.
    const lookup = makeLookup({
      'HandlerA.run': [{ id: 1, file: 'file1.ts', kind: 'method', line: 1 }],
      'HandlerB.run': [{ id: 2, file: 'file2.ts', kind: 'method', line: 2 }],
    });
    const chaCtx = makeChaTargetsCtx({
      implementors: { Handler: ['HandlerA', 'HandlerB'] },
      implementorsByFile: { 'Handler|file1.ts': ['HandlerA'] },
      instantiatedTypes: ['HandlerA', 'HandlerB'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup, 'file1.ts');
    expect(result).toEqual([{ id: 1, file: 'file1.ts', kind: 'method', line: 1 }]);
  });

  it('falls back to the bare implementors map when the caller file has no local declaration', () => {
    // Legitimate cross-file dispatch (issue #2078): the caller's file never
    // declares IWorker locally at all, so there is no scoped bucket to
    // prefer — all implementors declared anywhere must still be reachable.
    const lookup = makeLookup({
      'ConcreteWorker.doWork': [{ id: 1, file: 'concrete.ts', kind: 'method', line: 1 }],
      'MockWorker.doWork': [{ id: 2, file: 'mock.ts', kind: 'method', line: 2 }],
    });
    const chaCtx = makeChaTargetsCtx({
      implementors: { IWorker: ['ConcreteWorker', 'MockWorker'] },
      instantiatedTypes: ['ConcreteWorker', 'MockWorker'],
    });

    const result = resolveChaTargets('IWorker', 'doWork', chaCtx, lookup, 'dispatcher.ts');
    expect(result).toEqual([
      { id: 1, file: 'concrete.ts', kind: 'method', line: 1 },
      { id: 2, file: 'mock.ts', kind: 'method', line: 2 },
    ]);
  });

  it('falls back to the bare implementors map when callerFile is not provided', () => {
    const lookup = makeLookup({
      'HandlerA.run': [{ id: 1, file: 'file1.ts', kind: 'method', line: 1 }],
    });
    const chaCtx = makeChaTargetsCtx({
      implementors: { Handler: ['HandlerA'] },
      implementorsByFile: { 'Handler|file1.ts': ['HandlerA'] },
      instantiatedTypes: ['HandlerA'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup);
    expect(result).toEqual([{ id: 1, file: 'file1.ts', kind: 'method', line: 1 }]);
  });

  it('falls back to the bare map for a deeper hop with no scoped entry of its own', () => {
    // Handler is ambiguous (two files) and scoped at the root, but
    // AbstractHandler (one hop down) has no implementorsByFile entry of its
    // own — its children must still resolve via the bare map so a
    // legitimate multi-file transitive hierarchy below the disambiguated
    // root keeps working.
    const lookup = makeLookup({
      'ConcreteHandler.run': [{ id: 1, file: 'concrete.ts', kind: 'method', line: 1 }],
    });
    const chaCtx = makeChaTargetsCtx({
      implementors: {
        Handler: ['AbstractHandler'],
        AbstractHandler: ['ConcreteHandler'],
      },
      implementorsByFile: { 'Handler|file1.ts': ['AbstractHandler'] },
      instantiatedTypes: ['ConcreteHandler'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup, 'file1.ts');
    expect(result).toEqual([{ id: 1, file: 'concrete.ts', kind: 'method', line: 1 }]);
  });

  it('preserves file identity through the method lookup when two files declare the same implementor class name (Greptile finding on PR #2399)', () => {
    // Both file1.ts and file2.ts independently declare their own HandlerA
    // implementing their own (unrelated) Handler interface, each with its
    // own `run` method. Scoping the root to file1.ts must also carry that
    // file identity into the qualified-method lookup — otherwise
    // lookup.byName('HandlerA.run') returns both files' methods.
    const lookup = makeLookup(
      {
        'HandlerA.run': [
          { id: 1, file: 'file1.ts', kind: 'method', line: 1 },
          { id: 2, file: 'file2.ts', kind: 'method', line: 2 },
        ],
      },
      {
        'HandlerA.run': {
          'file1.ts': [{ id: 1, file: 'file1.ts', kind: 'method', line: 1 }],
        },
      },
    );
    const chaCtx = makeChaTargetsCtx({
      implementors: { Handler: ['HandlerA'] },
      implementorsByFile: { 'Handler|file1.ts': ['HandlerA'] },
      instantiatedTypes: ['HandlerA'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup, 'file1.ts');
    expect(result).toEqual([{ id: 1, file: 'file1.ts', kind: 'method', line: 1 }]);
  });

  it('preserves file identity through the ancestor walk when two files declare the same class with different parents (Greptile finding on PR #2399)', () => {
    // file1.ts's ConcreteHandler extends RealBase; an unrelated file2.ts also
    // declares its own ConcreteHandler extending a different OtherBase. The
    // bare parents map is first-write-wins and here (deliberately) points
    // the wrong way, as if file2's edge were recorded first project-wide —
    // the file-scoped parentsByFile entry for file1 must still win.
    const lookup = makeLookup({
      'RealBase.run': [{ id: 1, file: 'file1.ts', kind: 'method', line: 1 }],
      'OtherBase.run': [{ id: 2, file: 'file2.ts', kind: 'method', line: 2 }],
    });
    const chaCtx = makeChaTargetsCtx({
      implementors: { Handler: ['ConcreteHandler'] },
      implementorsByFile: { 'Handler|file1.ts': ['ConcreteHandler'] },
      parents: { ConcreteHandler: 'OtherBase' },
      parentsByFile: { 'ConcreteHandler|file1.ts': 'RealBase' },
      instantiatedTypes: ['ConcreteHandler'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup, 'file1.ts');
    expect(result).toEqual([{ id: 1, file: 'file1.ts', kind: 'method', line: 1 }]);
  });
});

describe('resolveChaTargets — inherited (non-overriding) method walk (issue #2237, part 2)', () => {
  it('walks up to the declaring ancestor when the instantiated class inherits without overriding', () => {
    // ConcreteHandler is instantiated and implements Handler transitively via
    // AbstractHandler, but never defines its own `run` — only AbstractHandler
    // does. A direct qualified lookup on ConcreteHandler.run must fall
    // through to AbstractHandler.run instead of missing the edge entirely.
    const lookup = makeLookup({
      'AbstractHandler.run': [{ id: 1, file: 'abstract.ts', kind: 'method', line: 1 }],
    });
    const chaCtx = makeChaTargetsCtx({
      implementors: { Handler: ['ConcreteHandler'] },
      parents: { ConcreteHandler: 'AbstractHandler' },
      instantiatedTypes: ['ConcreteHandler'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup);
    expect(result).toEqual([{ id: 1, file: 'abstract.ts', kind: 'method', line: 1 }]);
  });

  it('prefers the concrete class own override over an ancestor default when both exist', () => {
    const lookup = makeLookup({
      'ConcreteHandler.run': [{ id: 1, file: 'concrete.ts', kind: 'method', line: 1 }],
      'AbstractHandler.run': [{ id: 2, file: 'abstract.ts', kind: 'method', line: 2 }],
    });
    const chaCtx = makeChaTargetsCtx({
      implementors: { Handler: ['ConcreteHandler'] },
      parents: { ConcreteHandler: 'AbstractHandler' },
      instantiatedTypes: ['ConcreteHandler'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup);
    expect(result).toEqual([{ id: 1, file: 'concrete.ts', kind: 'method', line: 1 }]);
  });

  it('returns [] when neither the class nor any ancestor declares the method', () => {
    const lookup = makeLookup({});
    const chaCtx = makeChaTargetsCtx({
      implementors: { Handler: ['ConcreteHandler'] },
      parents: { ConcreteHandler: 'AbstractHandler' },
      instantiatedTypes: ['ConcreteHandler'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup);
    expect(result).toEqual([]);
  });

  it('does not infinite-loop on a cyclic parents chain', () => {
    const lookup = makeLookup({});
    const chaCtx = makeChaTargetsCtx({
      implementors: { Handler: ['A'] },
      parents: { A: 'B', B: 'A' },
      instantiatedTypes: ['A'],
    });

    const result = resolveChaTargets('Handler', 'run', chaCtx, lookup);
    expect(result).toEqual([]);
  });
});
