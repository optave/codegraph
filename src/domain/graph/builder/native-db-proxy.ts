/**
 * NativeDbProxy — wraps a NativeDatabase (rusqlite via napi-rs) to satisfy the
 * BetterSqlite3Database interface.  When the native addon is available, the
 * build pipeline uses this proxy as `ctx.db` so that every stage operates on a
 * single rusqlite connection — no dual-connection WAL corruption, no
 * open/close/reopen dance.
 *
 * When native is unavailable, the pipeline falls back to real better-sqlite3.
 */

import type { BetterSqlite3Database, NativeDatabase, SqliteStatement } from '../../../types.js';

const RUN_STUB = Object.freeze({ changes: 0, lastInsertRowid: 0 });

export class NativeDbProxy implements BetterSqlite3Database {
  readonly #ndb: NativeDatabase;
  /** Advisory lock path — set by the pipeline so closeDb() can release it. */
  __lockPath?: string;

  constructor(nativeDb: NativeDatabase) {
    this.#ndb = nativeDb;
  }

  prepare<TRow = unknown>(sql: string): SqliteStatement<TRow> {
    const ndb = this.#ndb;
    const stmt: SqliteStatement<TRow> = {
      all(...params: unknown[]): TRow[] {
        return ndb.queryAll(sql, params as Array<string | number | null>) as TRow[];
      },
      get(...params: unknown[]): TRow | undefined {
        return (ndb.queryGet(sql, params as Array<string | number | null>) ?? undefined) as
          | TRow
          | undefined;
      },
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
        // NOTE: changes and lastInsertRowid are not available via queryAll —
        // callers that rely on these values must use the native fast-paths directly.
        ndb.queryAll(sql, params as Array<string | number | null>);
        return RUN_STUB;
      },
      iterate(): IterableIterator<TRow> {
        throw new Error('iterate() is not supported via NativeDbProxy');
      },
      raw(): SqliteStatement<TRow> {
        return stmt; // no-op — .raw() is not used in the build pipeline
      },
    };
    return stmt;
  }

  exec(sql: string): this {
    this.#ndb.exec(sql);
    return this;
  }

  pragma(sql: string): unknown {
    return this.#ndb.pragma(sql);
  }

  close(): void {
    // No-op: the pipeline manages the NativeDatabase lifecycle directly.
    // closeDbPair() calls nativeDb.close() separately.
  }

  get open(): boolean {
    return this.#ndb.isOpen;
  }

  get name(): string {
    return this.#ndb.dbPath;
  }

  transaction<F extends (...args: any[]) => any>(
    fn: F,
  ): (...args: F extends (...a: infer A) => unknown ? A : never) => ReturnType<F> {
    const ndb = this.#ndb;
    return ((...args: unknown[]) => {
      // NOTE: nested transactions (savepoints) are not supported — ensure callers
      // do not invoke a transaction() wrapper from within an existing transaction.
      ndb.exec('BEGIN');
      try {
        const result = fn(...args);
        ndb.exec('COMMIT');
        return result;
      } catch (e) {
        try {
          ndb.exec('ROLLBACK');
        } catch {
          // Ignore rollback errors — the original error is more important
        }
        throw e;
      }
    }) as any;
  }
}
