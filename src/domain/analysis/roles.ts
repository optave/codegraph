import { openReadonlyOrFail, resolveBusyTimeoutMs } from '../../db/index.js';
import { buildFileConditionSQL } from '../../db/query-builder.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { DEAD_ROLE_PREFIX } from '../../shared/kinds.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import type { NodeRow } from '../../types.js';

export interface DynamicCallCount {
  dynamic_kind: string;
  count: number;
}

/**
 * Return a count of flagged dynamic call sink edges, grouped by kind.
 *
 * Only Track B (flag-only) edges ever have a persisted `dynamic_kind` — a
 * Track A call that resolved successfully becomes an ordinary edge with
 * `dynamic_kind=NULL` and is intentionally invisible here. See the
 * `DynamicKind` doc comment in `types.ts` (issue #2270) for the full
 * rationale.
 */
export function dynamicCallsData(customDbPath: string): DynamicCallCount[] {
  const db = openReadonlyOrFail(customDbPath, resolveBusyTimeoutMs(customDbPath));
  try {
    return db
      .prepare(
        `SELECT dynamic_kind, COUNT(*) AS count
         FROM edges
         WHERE dynamic_kind IS NOT NULL
         GROUP BY dynamic_kind
         ORDER BY count DESC`,
      )
      .all() as DynamicCallCount[];
  } finally {
    db.close();
  }
}

export function rolesData(
  customDbPath: string,
  opts: {
    noTests?: boolean;
    role?: string | null;
    file?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const db = openReadonlyOrFail(customDbPath, resolveBusyTimeoutMs(customDbPath));
  try {
    const noTests = opts.noTests || false;
    const filterRole = opts.role || null;

    const baseConditions = ['role IS NOT NULL'];
    const baseParams: (string | number)[] = [];
    {
      const fc = buildFileConditionSQL(opts.file || '', 'file');
      if (fc.sql) {
        // Strip leading ' AND ' since we're using conditions array
        baseConditions.push(fc.sql.replace(/^ AND /, ''));
        baseParams.push(...fc.params);
      }
    }

    const conditions = [...baseConditions];
    const params = [...baseParams];
    if (filterRole) {
      if (filterRole === DEAD_ROLE_PREFIX) {
        conditions.push('role LIKE ?');
        params.push(`${DEAD_ROLE_PREFIX}%`);
      } else {
        conditions.push('role = ?');
        params.push(filterRole);
      }
    }

    // NOTE: cachedStmt cannot be applied here because the SQL varies per call —
    // the WHERE clause is built dynamically from `conditions` (role filter, file
    // filter). A future optimisation could use a fixed SQL with CASE/COALESCE to
    // absorb optional filters, or maintain a small Map<string, StmtCache> keyed
    // by the unique condition combination (there are only ~4 variants). For now
    // the dynamic prepare is acceptable given the low call frequency of `roles`.
    let rows = db
      .prepare(
        `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY role, file, line`,
      )
      .all(...params) as NodeRow[];

    if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

    // Issue #2390: total classified-symbol count ignoring the --role filter
    // (but respecting the file filter and noTests, same as the row query
    // above), so the CLI can tell "this role has no matches" apart from "the
    // graph has no classified symbols at all" and stop recommending a rebuild
    // when the graph is actually fine. Only queried when a role filter is
    // active — otherwise it's identical to `rows.length` and free to reuse.
    let totalClassified = rows.length;
    if (filterRole) {
      let totalRows = db
        .prepare(`SELECT file FROM nodes WHERE ${baseConditions.join(' AND ')}`)
        .all(...baseParams) as Pick<NodeRow, 'file'>[];
      if (noTests) totalRows = totalRows.filter((r) => !isTestFile(r.file));
      totalClassified = totalRows.length;
    }

    // Issue #2390 follow-up: `totalClassified` above is still scoped by
    // `--file`/`--no-tests`, so a filter combination that excludes every
    // classified symbol from that scope (e.g. a file with none, or a role
    // that only exists in test files under `-T`) falls through to zero there
    // too — even though the graph is perfectly healthy outside that scope.
    // Only in that doubly-empty case do we need a fully unscoped (no role, no
    // file, no noTests) count to tell "this scope is empty" apart from "the
    // graph was never classified at all."
    let totalClassifiedUnscoped: number | undefined;
    if (totalClassified === 0 && (filterRole || opts.file || noTests)) {
      totalClassifiedUnscoped = (
        db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE role IS NOT NULL').get() as { c: number }
      ).c;
    }

    const summary: Record<string, number> = {};
    for (const r of rows) {
      // SQL guarantees role IS NOT NULL
      const role = r.role as string;
      summary[role] = (summary[role] || 0) + 1;
    }

    const hc = new Map();
    const symbols = rows.map((r) => normalizeSymbol(r, db, hc));
    const base = {
      count: symbols.length,
      totalClassified,
      totalClassifiedUnscoped,
      summary,
      symbols,
    };
    return paginateResult(base, 'symbols', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
