/**
 * Unit tests for presentation/result-formatter.js — output dispatch logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the config resolver so it doesn't touch disk. outputResult resolves
// its fallback display config via resolveDbConfig(customDbPath) — not a bare
// loadConfig() off process.cwd() — since #2222.
const resolveDbConfigMock = vi.fn(() => ({ display: { maxColWidth: 40 } }));
vi.mock('../../src/db/index.js', () => ({
  resolveDbConfig: resolveDbConfigMock,
}));

const { outputResult } = await import('../../src/presentation/result-formatter.js');

describe('outputResult', () => {
  let logSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    resolveDbConfigMock.mockClear();
    resolveDbConfigMock.mockReturnValue({ display: { maxColWidth: 40 } });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns false when no format option is set', () => {
    const result = outputResult({ items: [1, 2] }, 'items', {});
    expect(result).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('handles json option', () => {
    const data = { results: [{ name: 'foo' }] };
    const result = outputResult(data, 'results', { json: true });
    expect(result).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output).toEqual(data);
  });

  it('handles ndjson option', () => {
    const data = { results: [{ name: 'a' }] };
    const result = outputResult(data, 'results', { ndjson: true });
    expect(result).toBe(true);
    // printNdjson is now co-located — verify it emitted the NDJSON line via console.log
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ name: 'a' });
  });

  it('handles csv option with array data', () => {
    const data = {
      items: [
        { name: 'a', count: 1 },
        { name: 'b', count: 2 },
      ],
    };
    const result = outputResult(data, 'items', { csv: true });
    expect(result).toBe(true);
    // Header row + 2 data rows
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy.mock.calls[0][0]).toContain('name');
    expect(logSpy.mock.calls[0][0]).toContain('count');
  });

  it('csv returns false when field is not an array', () => {
    const result = outputResult({ scalar: 42 }, 'scalar', { csv: true });
    expect(result).toBe(false);
  });

  it('handles table option', () => {
    const data = { items: [{ file: 'a.js', lines: 10 }] };
    const result = outputResult(data, 'items', { table: true });
    expect(result).toBe(true);
    expect(logSpy).toHaveBeenCalled();
    // Should contain table formatting (box-drawing chars)
    const output = logSpy.mock.calls[0][0];
    expect(output).toContain('\u2500');
  });

  it('resolves the fallback display config from customDbPath, not process.cwd() (#2222)', () => {
    const data = { items: [{ file: 'a.js', lines: 10 }] };
    outputResult(data, 'items', { table: true }, '/some/other/repo');
    expect(resolveDbConfigMock).toHaveBeenCalledWith('/some/other/repo');
  });

  it('does not call resolveDbConfig when opts.display is already provided', () => {
    const data = { items: [{ file: 'a.js', lines: 10 }] };
    outputResult(data, 'items', { table: true, display: { maxColWidth: 3 } }, '/some/other/repo');
    expect(resolveDbConfigMock).not.toHaveBeenCalled();
  });

  it('uses the resolved config\u2019s maxColWidth to truncate table cells', () => {
    resolveDbConfigMock.mockReturnValue({ display: { maxColWidth: 5 } });
    const data = { items: [{ name: 'ThisIsALongSymbolName' }] };
    outputResult(data, 'items', { table: true }, '/some/other/repo');
    const output = logSpy.mock.calls[0][0];
    expect(output).not.toContain('ThisIsALongSymbolName');
    expect(output).toContain('This\u2026'); // truncEnd: (maxColWidth - 1) chars + ellipsis
  });

  it('csv escapes commas and quotes in values', () => {
    const data = { items: [{ text: 'hello, world', quoted: 'say "hi"' }] };
    outputResult(data, 'items', { csv: true });
    const dataRow = logSpy.mock.calls[1][0];
    expect(dataRow).toContain('"hello, world"');
    expect(dataRow).toContain('"say ""hi"""');
  });

  it('flattens nested objects for csv/table output', () => {
    const data = { items: [{ meta: { score: 5, file: 'a.js' } }] };
    outputResult(data, 'items', { csv: true });
    const header = logSpy.mock.calls[0][0];
    expect(header).toContain('meta.score');
    expect(header).toContain('meta.file');
  });
});
