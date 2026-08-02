import { findDbPath, resolveBusyTimeoutMs } from '../../db/index.js';
import type { Cycle } from '../../domain/graph/cycles.js';
import { findCycles } from '../../domain/graph/cycles.js';
import type { McpToolContext } from '../types.js';

export const name = 'find_cycles';

export async function handler(
  _args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<{ cycles: Cycle[]; count: number }> {
  const dbPath = findDbPath(ctx.dbPath);
  const Database = ctx.getDatabase();
  const db = new Database(dbPath, { readonly: true });
  db.pragma(`busy_timeout = ${resolveBusyTimeoutMs(dbPath)}`);
  try {
    const cycles = findCycles(db);
    return { cycles, count: cycles.length };
  } finally {
    db.close();
  }
}
