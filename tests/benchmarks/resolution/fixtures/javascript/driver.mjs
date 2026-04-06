/**
 * Dynamic call-tracing driver for the JavaScript resolution fixture.
 *
 * Imports all modules via __tracer.instrumentExports(), exercises every
 * exported function/method, then dumps captured call edges to stdout.
 *
 * Run via: node --import ../tracer/loader-hook.mjs driver.mjs
 */

import * as _index from './index.js';
import * as _logger from './logger.js';
import * as _service from './service.js';
// Import raw modules then instrument them
import * as _validators from './validators.js';

const validators = globalThis.__tracer.instrumentExports(_validators, 'validators.js');
const logger = globalThis.__tracer.instrumentExports(_logger, 'logger.js');
const service = globalThis.__tracer.instrumentExports(_service, 'service.js');
const index = globalThis.__tracer.instrumentExports(_index, 'index.js');

// Exercise all call paths
try {
  // Direct function calls
  globalThis.__tracer.pushCall('__driver__', 'driver.mjs');

  // Call main() — exercises buildService, createUser, validate, deleteUser
  index.main();

  // Call directInstantiation() — exercises new UserService, createUser
  index.directInstantiation();

  // Direct validator calls
  validators.validate({ name: 'test' });
  validators.normalize({ name: '  test  ' });

  // Direct logger calls
  const log = new logger.Logger('test');
  log.info('test message');
  log.warn('test warning');
  log.error('test error');

  // Direct service calls
  const svc = service.buildService();
  svc.createUser({ name: 'Direct' });
  svc.deleteUser(99);

  globalThis.__tracer.popCall();
} catch {
  // Swallow errors — we only care about call edges
}

// Output edges as JSON
const edges = globalThis.__tracer.dump();
console.log(JSON.stringify({ edges }, null, 2));
