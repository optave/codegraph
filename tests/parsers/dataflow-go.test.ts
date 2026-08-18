/**
 * Unit tests for extractDataflow() against parsed Go ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers } from '../../src/domain/parser.js';
import { extractDataflow } from '../../src/features/dataflow.js';

describe('extractDataflow — Go', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('go');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.go', [], 'go');
  }

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract(
        'package main\nfunc add(a int, b int) int {\n\treturn a + b\n}\n',
      );
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts multi-name parameters', () => {
      const data = parseAndExtract('package main\nfunc add(a, b int) int {\n\treturn a + b\n}\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a' }),
          expect.objectContaining({ funcName: 'add', paramName: 'b' }),
        ]),
      );
    });

    // Regression test for issue #2501: a single `parameter_declaration` node
    // shares one type across multiple comma-separated names (`a, b int` — both
    // `a` and `b` are `name`-field children of the SAME node). The outer
    // per-child loop used to increment its index once per node regardless of
    // how many names it yielded, so `a` and `b` both got paramIndex 0.
    it('gives grouped multi-name parameters each their own index', () => {
      const data = parseAndExtract('package main\nfunc f(a, b int, c string) {\n}\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'f', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'f', paramName: 'b', paramIndex: 1 }),
          expect.objectContaining({ funcName: 'f', paramName: 'c', paramIndex: 2 }),
        ]),
      );
    });

    it('still indexes a variadic parameter correctly after a grouped group', () => {
      const data = parseAndExtract('package main\nfunc f(a, b int, nums ...int) {\n}\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'f', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'f', paramName: 'b', paramIndex: 1 }),
          expect.objectContaining({ funcName: 'f', paramName: 'nums', paramIndex: 2 }),
        ]),
      );
    });
  });

  describe('returns', () => {
    it('captures return expressions', () => {
      const data = parseAndExtract('package main\nfunc double(x int) int {\n\treturn x * 2\n}\n');
      expect(data.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'double',
            referencedNames: expect.arrayContaining(['x']),
          }),
        ]),
      );
    });
  });

  describe('assignments', () => {
    it('tracks short var declaration from call', () => {
      const data = parseAndExtract(
        'package main\nfunc main() {\n\tresult := compute()\n\t_ = result\n}\n',
      );
      expect(data.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            varName: 'result',
            callerFunc: 'main',
            sourceCallName: 'compute',
          }),
        ]),
      );
    });
  });

  describe('argFlows', () => {
    it('detects parameter passed as argument', () => {
      const data = parseAndExtract(
        'package main\nfunc process(input string) {\n\ttransform(input)\n}\n',
      );
      expect(data.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callerFunc: 'process',
            calleeName: 'transform',
            argIndex: 0,
            argName: 'input',
            confidence: 1.0,
          }),
        ]),
      );
    });
  });
});
