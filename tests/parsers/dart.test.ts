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

    // Review finding: a comment between the signature and its body is its
    // own intervening SIBLING node (tree-sitter-dart's comment rule is an
    // `extra` production, not folded into an adjacent node), which the
    // naive "next sibling" lookup mistook for the body itself.
    it('skips a comment between the signature and its body', () => {
      const symbols = parseDart(`Foo makeWaldo()
// a comment between signature and body
{
  return Foo();
}`);
      const def = symbols.definitions.find((d) => d.name === 'makeWaldo');
      expect(def).toBeDefined();
      expect(def!.line).toBe(1);
      expect(def!.endLine).toBe(5);
    });

    it('skips multiple consecutive comments between the signature and its body', () => {
      const symbols = parseDart(`Foo makeWaldo()
// comment one
// comment two
{
  return Foo();
}`);
      const def = symbols.definitions.find((d) => d.name === 'makeWaldo');
      expect(def).toBeDefined();
      expect(def!.endLine).toBe(6);
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

  // #2319: Dart never populated typeMap at all, so receiver-typed method
  // calls (`_repo.findById(id)`, where `_repo`'s type comes from a typed
  // field declaration or a `this.field` constructor-shorthand param) could
  // never resolve.
  describe('#2319: typeMap seeding for field/parameter types', () => {
    it('seeds class-scoped and bare fallback keys for a typed final field', () => {
      const symbols = parseDart(`class UserService {
  final UserRepository _repo;
  UserService(this._repo);
}`);
      expect(symbols.typeMap.get('UserService._repo')).toEqual({
        type: 'UserRepository',
        confidence: 0.9,
      });
      expect(symbols.typeMap.get('_repo')).toEqual({
        type: 'UserRepository',
        confidence: 0.6,
      });
      expect(symbols.typeMap.get('this._repo')).toEqual({
        type: 'UserRepository',
        confidence: 0.6,
      });
    });

    it('seeds a non-final field declaration the same way', () => {
      const symbols = parseDart(`class A {
  UserRepository repo;
}`);
      expect(symbols.typeMap.get('A.repo')?.type).toBe('UserRepository');
    });

    it('seeds a late field declaration', () => {
      const symbols = parseDart(`class A {
  late UserRepository _repo;
}`);
      expect(symbols.typeMap.get('A._repo')?.type).toBe('UserRepository');
    });

    it('strips no extra characters for a nullable field type', () => {
      const symbols = parseDart(`class A {
  UserRepository? _repo;
}`);
      expect(symbols.typeMap.get('A._repo')?.type).toBe('UserRepository');
    });

    it('seeds the generic base type for a generic field', () => {
      const symbols = parseDart(`class A {
  List<User>? users;
}`);
      expect(symbols.typeMap.get('A.users')?.type).toBe('List');
    });

    it('seeds every identifier in a comma-separated multi-field declaration', () => {
      const symbols = parseDart(`class A {
  final Foo a, b;
}`);
      expect(symbols.typeMap.get('A.a')?.type).toBe('Foo');
      expect(symbols.typeMap.get('A.b')?.type).toBe('Foo');
    });

    it('seeds a field even when it carries an initializer', () => {
      const symbols = parseDart(`class A {
  final Foo x = Foo();
}`);
      expect(symbols.typeMap.get('A.x')?.type).toBe('Foo');
    });

    it('does not seed a field with no explicit type', () => {
      // `var x = Foo();` has no explicit type annotation on the declaration
      // itself — inferring one from the initializer is a separate,
      // out-of-scope problem (#2319).
      const symbols = parseDart(`class A {
  var x = Foo();
}`);
      expect(symbols.typeMap.has('A.x')).toBe(false);
      expect(symbols.typeMap.has('x')).toBe(false);
    });

    it('seeds from an inline-typed constructor-shorthand param', () => {
      // `UserRepository this._repo` — an explicit inline type on a
      // field-formal parameter is a genuine type annotation (not
      // initializer inference), and here it's the ONLY source of type info
      // since the class declares no field for `_repo` at all.
      const symbols = parseDart(`class UserService {
  UserService(UserRepository this._repo);
}`);
      expect(symbols.typeMap.get('UserService._repo')?.type).toBe('UserRepository');
    });

    it('needs no separate seeding for a plain this-shorthand param beyond the field', () => {
      const symbols = parseDart(`class UserService {
  final UserRepository _repo;
  UserService(this._repo);
}`);
      expect(symbols.typeMap.get('UserService._repo')).toEqual({
        type: 'UserRepository',
        confidence: 0.9,
      });
    });

    it('sets receiver on a bare field-access method call', () => {
      const symbols = parseDart(`class UserService {
  final UserRepository _repo;
  UserService(this._repo);
  User? getUser(String id) {
    return _repo.findById(id);
  }
}`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'findById', receiver: '_repo' }),
      );
    });

    it('sets receiver on a local-variable method call', () => {
      const symbols = parseDart(`void f() {
  var w = Foo();
  w.doSomething();
}`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'doSomething', receiver: 'w' }),
      );
    });

    it('does not attribute a receiver to the second call in a chain', () => {
      const symbols = parseDart(`void f() {
  obj.method1().method2();
}`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'method1', receiver: 'obj' }),
      );
      const method2 = symbols.calls.find((c) => c.name === 'method2');
      expect(method2).toBeDefined();
      expect(method2!.receiver).toBeUndefined();
    });

    it('does not set a receiver on a bare call', () => {
      const symbols = parseDart(`void f() {
  helper();
}`);
      const call = symbols.calls.find((c) => c.name === 'helper');
      expect(call).toBeDefined();
      expect(call!.receiver).toBeUndefined();
    });

    it('end-to-end: resolves the issue example receiver-typed field access', () => {
      const symbols = parseDart(`class UserService {
  final UserRepository _repo;

  UserService(this._repo);

  User? getUser(String id) {
    return _repo.findById(id);
  }
}`);
      expect(symbols.typeMap.get('_repo')?.type).toBe('UserRepository');
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'findById', receiver: '_repo' }),
      );
    });
  });
});
