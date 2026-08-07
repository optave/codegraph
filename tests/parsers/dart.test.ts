import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractDartSymbols } from '../../src/domain/parser.js';

describe('Dart parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseDart(code) {
    const parser = parsers.get('dart');
    if (!parser) throw new Error('Dart parser not available');
    const tree = parser.parse(code);
    return extractDartSymbols(tree, 'test.dart');
  }

  it('extracts class definitions', () => {
    const symbols = parseDart(`class User {
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class' }),
    );
  });

  it('extracts enum definitions', () => {
    const symbols = parseDart(`enum Color { red, green, blue }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'enum' }),
    );
  });

  it('extracts class inheritance', () => {
    const symbols = parseDart(`class Admin extends User {
}`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Admin', extends: 'User' }),
    );
  });

  it('extracts import statements', () => {
    const symbols = parseDart(`import 'dart:io';
import 'package:flutter/material.dart';`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts constructor calls', () => {
    const symbols = parseDart(`var user = User("Alice");`);
    // Bare (keyword-less) constructor call, #2082 — resolved via the
    // identifier immediately preceding the call's `selector` node.
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'User' }));
  });

  it('flags Function.apply as unresolved-dynamic', () => {
    const symbols = parseDart(`void g() {
  var r = Function.apply(callback, []);
}`);
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({
        name: '<dynamic:unresolved>',
        dynamic: true,
        dynamicKind: 'unresolved-dynamic',
      }),
    );
  });

  // #2082: bare (keyword-less) calls — modern Dart permits omitting `new`
  // for both plain function calls and constructor invocations.
  describe('#2082: bare (keyword-less) call extraction', () => {
    it('extracts a bare plain function call', () => {
      const symbols = parseDart(`void main() {
  helper();
}`);
      expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'helper' }));
    });

    it('extracts a bare constructor call assigned to a variable', () => {
      const symbols = parseDart(`void main() {
  var w = Foo();
}`);
      expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'Foo' }));
    });

    it('extracts a bare constructor call in a return statement', () => {
      const symbols = parseDart(`Foo makeWaldo() {
  return Foo();
}`);
      expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'Foo' }));
    });

    it('still resolves an explicit `new` constructor call alongside a bare one', () => {
      const symbols = parseDart(`void main() {
  var a = Foo();
  var b = new Foo();
}`);
      expect(symbols.calls.filter((c) => c.name === 'Foo')).toHaveLength(2);
    });

    it('resolves each call in a chained method-call sequence to its own name (not the last one)', () => {
      // Regression guard for the underlying root cause: web-tree-sitter
      // returns a fresh wrapper object from every `.child()` call, so a
      // `===` reference comparison between two accessors for the SAME node
      // is always false. Before switching to `.id` comparison, this caused
      // EVERY selector in a chain to resolve to whichever selector was
      // encountered last while scanning past it — obj.method1() would
      // silently resolve as "method2" instead of "method1".
      const symbols = parseDart(`void main() {
  obj.method1().method2();
}`);
      const names = symbols.calls.map((c) => c.name);
      expect(names).toContain('method1');
      expect(names).toContain('method2');
    });
  });

  // #2082: multi-line function/method endLine truncation — tree-sitter-dart
  // splits a function's signature and body into SIBLING nodes
  // (function_signature/method_signature + function_body), not a
  // parent-child relationship, so endLine must be measured through to the
  // sibling body, not just the signature node's own span.
  describe('#2082: multi-line function/method endLine', () => {
    it('spans a multi-line top-level function through its closing brace', () => {
      const symbols = parseDart(`Foo makeWaldo() {
  return Foo();
}`);
      const def = symbols.definitions.find((d) => d.name === 'makeWaldo');
      expect(def).toBeDefined();
      expect(def!.line).toBe(1);
      expect(def!.endLine).toBe(3);
    });

    it('spans a multi-line class method through its closing brace', () => {
      const symbols = parseDart(`class UserService {
  User getUser(String id) {
    return User(id);
  }
}`);
      const def = symbols.definitions.find((d) => d.name === 'UserService.getUser');
      expect(def).toBeDefined();
      expect(def!.line).toBe(2);
      expect(def!.endLine).toBe(4);
    });

    it('does not extend past the signature for an abstract method with no body', () => {
      const symbols = parseDart(`abstract class Shape {
  double area();
}`);
      const def = symbols.definitions.find((d) => d.name === 'Shape.area');
      expect(def).toBeDefined();
      expect(def!.endLine).toBe(2);
    });
  });

  // #2082: bodyless (semicolon-only) constructors — the idiomatic short
  // form Dart codebases use throughout (`Foo();`) — parse under a
  // `declaration` wrapper, not the `method_signature` a block-bodied
  // constructor uses, so they were silently dropped entirely.
  describe('#2082: bodyless constructor extraction', () => {
    it('extracts a semicolon-only constructor as a method definition', () => {
      const symbols = parseDart(`class Waldo {
  Waldo();
}`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Waldo.Waldo', kind: 'method' }),
      );
    });

    it('extracts a semicolon-only constructor with this-shorthand parameters', () => {
      const symbols = parseDart(`class User {
  final String id;
  User(this.id);
}`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'User.User', kind: 'method' }),
      );
    });

    it('still extracts a block-bodied constructor (pre-existing behavior)', () => {
      const symbols = parseDart(`class Waldo {
  Waldo() {
    print('hi');
  }
}`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Waldo.Waldo', kind: 'method' }),
      );
    });
  });
});
