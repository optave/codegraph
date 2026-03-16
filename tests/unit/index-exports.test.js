import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

describe('index.js re-exports', () => {
  it('all re-exports resolve without errors', async () => {
    // Dynamic import validates that every re-exported module exists and
    // all named exports are resolvable. If any source file is missing,
    // this will throw ERR_MODULE_NOT_FOUND.
    const mod = await import('../../src/index.js');
    expect(mod).toBeDefined();
    expect(typeof mod).toBe('object');
  });

  it('CJS wrapper resolves to the same exports', async () => {
    const require = createRequire(import.meta.url);
    const cjs = await require('../../src/index.cjs');
    const esm = await import('../../src/index.js');
    // Every named ESM export should be present in the CJS wrapper result
    for (const key of Object.keys(esm)) {
      if (key === 'default') continue;
      expect(cjs).toHaveProperty(key);
    }
  });
});
