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
  });
});
