/**
 * ESM resolve/load hooks for .js → .ts fallback during gradual migration.
 *
 * - resolve: when a .js specifier resolves to a path that doesn't exist,
 *   check if a .ts version exists and redirect to it.
 * - load: for .ts files, delegate to Node's native loader (works on
 *   Node >= 22.6 with --experimental-strip-types); fall back to reading
 *   the file as module source for older versions.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Only intercept ERR_MODULE_NOT_FOUND for .js specifiers
    if (err.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
      const tsSpecifier = specifier.replace(/\.js$/, '.ts');
      try {
        return await nextResolve(tsSpecifier, context);
      } catch {
        // .ts also not found — throw the original error
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);

  // On Node >= 22.6 with --experimental-strip-types, Node handles .ts natively
  try {
    return await nextLoad(url, context);
  } catch (err) {
    if (err.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw err;
  }

  // Fallback: read the file and return as module source.
  // TypeScript-only syntax will cause a parse error — callers should ensure
  // .ts files contain only erasable type annotations on Node < 22.6.
  const source = await readFile(fileURLToPath(url), 'utf-8');
  return { format: 'module', source, shortCircuit: true };
}
