import { getNodeId as getNodeIdQuery, type openDb } from '../../src/db/index.js';
import type { IncrementalStmts } from '../../src/domain/graph/builder/incremental.js';

/**
 * Build the `IncrementalStmts` bundle `rebuildFile` needs, matching
 * production's `prepareWatcherStatements` (`src/domain/graph/watcher.ts`)
 * exactly — shared by every watch-mode/incremental integration test instead
 * of each duplicating (and risking drifting out of sync with) the same set
 * of prepared statements.
 */
export function createIncrementalStmts(db: ReturnType<typeof openDb>): IncrementalStmts {
  return {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name,kind,file,line,end_line,parent_id,qualified_name,scope,visibility,content_hash,accessor_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ),
    markExported: db.prepare(
      'UPDATE nodes SET exported = 1 WHERE name = ? AND kind = ? AND file = ? AND line = ?',
    ),
    getNodeId: {
      get: (...params: unknown[]) => {
        const [name, kind, file, line] = params as [string, string, string, number];
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    insertEdge: db.prepare(
      'INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdges: db.prepare(
      'SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    findNodeInFile: db.prepare(
      "SELECT id, kind, file, line, accessor_kind AS accessorKind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file, kind, line, accessor_kind AS accessorKind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
    upsertFileHash: db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    ),
    deleteFileHash: db.prepare('DELETE FROM file_hashes WHERE file = ?'),
  };
}
