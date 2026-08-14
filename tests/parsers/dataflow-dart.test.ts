/**
 * Unit tests for extractDataflow() against parsed Dart ASTs.
 *
 * tree-sitter-dart puts a function's body in a SIBLING node
 * (function_body) rather than nesting it inside function_signature/
 * method_signature (#2182) — these tests exercise the body-sibling walk
 * mechanism (src/ast-analysis/visitor.ts) directly through dataflowDart,
 * for both top-level functions and class methods (method_signature has no
 * name field of its own; its name/params come from a nested
 * function_signature, while its body is its own sibling — see b2.ts's
 * extractDartFunctionName/getDartParamListNode doc comments).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, getParser } from '../../src/domain/parser.js';
import { extractDataflow } from '../../src/features/dataflow.js';

describe('extractDataflow — Dart', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code: string) {
    const parser = getParser(parsers, 'test.dart');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.dart', [], 'dart');
  }

  describe('parameters', () => {
    it('extracts parameters from a top-level function', () => {
      const data = parseAndExtract(
        'int add(int a, int b) {\n  var sum = a + b;\n  return sum;\n}\n',
      );
      expect(data!.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts parameters from a class method exactly once (no double-count via the nested signature)', () => {
      const data = parseAndExtract(
        'class Calculator {\n  int add(int a, int b) {\n    return a + b;\n  }\n}\n',
      );
      const addParams = (data!.parameters as any[]).filter((p) => p.funcName === 'add');
      expect(addParams).toHaveLength(2);
      expect(addParams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts optional and named parameter groups', () => {
      const data = parseAndExtract(
        'int greet(String name, {int times = 1, bool loud = false}) {\n  return times;\n}\n',
      );
      expect(data!.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'greet', paramName: 'name' }),
          expect.objectContaining({ funcName: 'greet', paramName: 'times' }),
          expect.objectContaining({ funcName: 'greet', paramName: 'loud' }),
        ]),
      );
    });

    it('gives each name in a named-parameter group its own paramIndex (#2358)', () => {
      const data = parseAndExtract(
        'int greet(String name, {int times = 1, bool loud = false}) {\n  return times;\n}\n',
      );
      expect(data!.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'greet', paramName: 'name', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'greet', paramName: 'times', paramIndex: 1 }),
          expect.objectContaining({ funcName: 'greet', paramName: 'loud', paramIndex: 2 }),
        ]),
      );
    });

    it('gives each name in an optional-positional parameter group its own paramIndex', () => {
      const data = parseAndExtract('int f(int a, [int b, int c]) {\n  return a;\n}\n');
      expect(data!.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'f', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'f', paramName: 'b', paramIndex: 1 }),
          expect.objectContaining({ funcName: 'f', paramName: 'c', paramIndex: 2 }),
        ]),
      );
    });
  });

  describe('returns', () => {
    it('captures a return expression from a top-level function body (sibling of function_signature)', () => {
      const data = parseAndExtract(
        'int multiply(int x, int y) {\n  var result = x * y;\n  return result;\n}\n',
      );
      expect(data!.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'multiply',
            referencedNames: expect.arrayContaining(['result']),
          }),
        ]),
      );
    });

    it('captures a return expression from a class method body (sibling of method_signature)', () => {
      const data = parseAndExtract(
        'class Calculator {\n  int add(int a, int b) {\n    var sum = a + b;\n    return sum;\n  }\n}\n',
      );
      expect(data!.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'add',
            referencedNames: expect.arrayContaining(['sum']),
          }),
        ]),
      );
    });

    it('captures returns from two sibling functions independently (no scope bleed across body-sibling walks)', () => {
      const data = parseAndExtract(
        'int helper(int z) {\n  return z;\n}\nint caller(int a) {\n  return a;\n}\n',
      );
      expect(data!.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'helper', referencedNames: ['z'] }),
          expect.objectContaining({ funcName: 'caller', referencedNames: ['a'] }),
        ]),
      );
    });

    // Issue #2356: tree-sitter-dart represents an arrow-bodied function's
    // function_body as containing the expression DIRECTLY — no
    // return_statement node at all — so returnNode's exact-type match never
    // fires for these, independent of the #2182 sibling-body architecture.
    it('captures an implicit return from a top-level arrow-bodied function (no return_statement in the grammar)', () => {
      const data = parseAndExtract('int multiply(int x, int y) => x * y;\n');
      expect(data!.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'multiply',
            referencedNames: expect.arrayContaining(['x', 'y']),
          }),
        ]),
      );
    });

    it('captures an implicit return from an arrow-bodied class method', () => {
      const data = parseAndExtract('class Calculator {\n  int add(int a, int b) => a + b;\n}\n');
      expect(data!.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'add',
            referencedNames: expect.arrayContaining(['a', 'b']),
          }),
        ]),
      );
    });

    it('does not double-count a block-bodied function as an implicit return', () => {
      const data = parseAndExtract('int multiply(int x, int y) {\n  return x * y;\n}\n');
      const multiplyReturns = (data!.returns as any[]).filter((r) => r.funcName === 'multiply');
      expect(multiplyReturns).toHaveLength(1);
    });
  });

  // Issue #2357: tree-sitter-dart has no call_expression node type at all,
  // and its documented postfix_expression wrapper never actually appears in
  // a parsed tree either — a call is a flat sequence of siblings (a base
  // expression followed by a chain of `selector` siblings, one of which
  // wraps an argument_part when it's a call). callNode/resolveCallParts and
  // the argument-wrapper config were entirely unset, so argFlows (and any
  // call-derived dataflow) was always empty regardless of the sibling-body
  // and return fixes above.
  describe('calls', () => {
    it('tracks a bare call argument flow (helper(x) as a return expression)', () => {
      const data = parseAndExtract('int square(int x) {\n  return helper(x);\n}\n');
      expect(data!.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callerFunc: 'square', calleeName: 'helper', argName: 'x' }),
        ]),
      );
    });

    it('tracks a bare statement-level call argument flow', () => {
      const data = parseAndExtract('int square(int x) {\n  helper(x);\n  return x;\n}\n');
      expect(data!.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callerFunc: 'square', calleeName: 'helper', argName: 'x' }),
        ]),
      );
    });

    it('tracks a method-call argument flow, resolving the callee via the preceding property selector', () => {
      const data = parseAndExtract(
        'class Obj {\n  int method(int x) => x;\n}\nint square(Obj obj, int x) {\n  return obj.method(x);\n}\n',
      );
      expect(data!.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callerFunc: 'square', calleeName: 'method', argName: 'x' }),
        ]),
      );
    });

    it('does not misidentify a non-call postfix expression (x++) as a call', () => {
      const data = parseAndExtract('int inc(int x) {\n  x++;\n  return x;\n}\n');
      expect(data!.argFlows).toEqual([]);
    });
  });

  describe('assignments', () => {
    it('tracks a call-sourced variable assignment (var x = helper(y))', () => {
      const data = parseAndExtract('int square(int y) {\n  var x = helper(y);\n  return x;\n}\n');
      expect(data!.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ varName: 'x', callerFunc: 'square', sourceCallName: 'helper' }),
        ]),
      );
    });

    it('does not record a plain (non-call-sourced) variable declaration as an assignment', () => {
      const data = parseAndExtract(
        'int add(int a, int b) {\n  var sum = a + b;\n  return sum;\n}\n',
      );
      expect(data!.assignments).toEqual([]);
    });
  });
});
