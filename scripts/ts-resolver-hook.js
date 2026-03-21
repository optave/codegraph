/**
 * Node.js module resolution hook for incremental TypeScript migration.
 *
 * Registered via --import. Uses the module.register() API (Node >= 20.6)
 * to install a resolve hook that falls back to .ts when .js is missing.
 */

import { register } from 'node:module';

register('./ts-resolver-loader.js', import.meta.url);
