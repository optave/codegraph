/**
 * ESM loader: resolve .js → .ts fallback for incremental migration.
 */

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw err;

    const tsSpecifier = specifier.replace(/\.js$/, '.ts');
    try {
      return await nextResolve(tsSpecifier, context);
    } catch {
      throw err;
    }
  }
}
