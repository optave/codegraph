import fs from 'node:fs';
import path from 'node:path';
import { getDatabase } from '../db/better-sqlite3.js';
import { findDbPath } from '../db/index.js';
import { debug } from '../infrastructure/logger.js';
import { ConfigError, DbError } from '../shared/errors.js';

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function validateSnapshotName(name: string): void {
  if (!name || !NAME_RE.test(name)) {
    throw new ConfigError(
      `Invalid snapshot name "${name}". Use only letters, digits, hyphens, and underscores.`,
    );
  }
}

export function snapshotsDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'snapshots');
}

interface SnapshotSaveOptions {
  dbPath?: string;
  force?: boolean;
}

export function snapshotSave(
  name: string,
  options: SnapshotSaveOptions = {},
): { name: string; path: string; size: number } {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new DbError(`Database not found: ${dbPath}`, { file: dbPath });
  }

  const dir = snapshotsDir(dbPath);
  const dest = path.join(dir, `${name}.db`);

  if (!options.force && fs.existsSync(dest)) {
    throw new ConfigError(`Snapshot "${name}" already exists. Use --force to overwrite.`);
  }

  fs.mkdirSync(dir, { recursive: true });

  // VACUUM INTO a unique temp path on the same filesystem, then atomically
  // rename over the destination. This closes the TOCTOU window between
  // existsSync/unlinkSync/VACUUM INTO where two concurrent saves could
  // observe a missing file or interleave their VACUUM writes.
  const tmp = path.join(dir, `.${name}.db.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.unlinkSync(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* cleanup best-effort */
    }
    throw err;
  }

  const stat = fs.statSync(dest);
  debug(`Snapshot saved: ${dest} (${stat.size} bytes)`);
  return { name, path: dest, size: stat.size };
}

interface SnapshotDbPathOptions {
  dbPath?: string;
}

export function snapshotRestore(name: string, options: SnapshotDbPathOptions = {}): void {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  const dir = snapshotsDir(dbPath);
  const src = path.join(dir, `${name}.db`);

  if (!fs.existsSync(src)) {
    throw new DbError(`Snapshot "${name}" not found at ${src}`, { file: src });
  }

  // Remove WAL/SHM sidecars first so the old journal can't be replayed over
  // the restored DB. unlink then check ENOENT — avoids the existsSync/unlinkSync
  // race another process could wedge into.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    try {
      fs.unlinkSync(sidecar);
      debug(`Removed sidecar: ${sidecar}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // Copy to a temp path next to the DB, then rename atomically. Readers that
  // open dbPath during restore see either the pre-restore or post-restore
  // file, never a partially-written one.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.restore-tmp-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dbPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* cleanup best-effort */
    }
    throw err;
  }

  debug(`Restored snapshot "${name}" → ${dbPath}`);
}

interface SnapshotEntry {
  name: string;
  path: string;
  size: number;
  createdAt: Date;
}

export function snapshotList(options: SnapshotDbPathOptions = {}): SnapshotEntry[] {
  const dbPath = options.dbPath || findDbPath();
  const dir = snapshotsDir(dbPath);

  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const filePath = path.join(dir, f);
      const stat = fs.statSync(filePath);
      return {
        name: f.replace(/\.db$/, ''),
        path: filePath,
        size: stat.size,
        createdAt: stat.birthtime,
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function snapshotDelete(name: string, options: SnapshotDbPathOptions = {}): void {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  const dir = snapshotsDir(dbPath);
  const target = path.join(dir, `${name}.db`);

  try {
    fs.unlinkSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DbError(`Snapshot "${name}" not found at ${target}`, { file: target });
    }
    throw err;
  }
  debug(`Deleted snapshot: ${target}`);
}
