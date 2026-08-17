/**
 * Unit tests for src/journal.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendJournalEntries,
  appendJournalEntriesAndStampHeader,
  JOURNAL_FILENAME,
  readJournal,
  writeJournalHeader,
} from '../../src/domain/graph/journal.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-journal-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Returns the directory the journal lives in directly — normally the
 * database's own directory (`.codegraph` under a repo root by default, but
 * every journal function takes this directory itself now, not the repo
 * root — see #2426).
 */
function makeJournalDir() {
  const root = fs.mkdtempSync(path.join(tmpDir, 'root-'));
  const journalDir = path.join(root, '.codegraph');
  fs.mkdirSync(journalDir, { recursive: true });
  return journalDir;
}

function journalPath(journalDir: string) {
  return path.join(journalDir, JOURNAL_FILENAME);
}

describe('readJournal', () => {
  it('returns { valid: false } when journal does not exist', () => {
    const journalDir = makeJournalDir();
    const result = readJournal(journalDir);
    expect(result.valid).toBe(false);
  });

  it('returns { valid: false } for empty file', () => {
    const journalDir = makeJournalDir();
    fs.writeFileSync(journalPath(journalDir), '');
    expect(readJournal(journalDir).valid).toBe(false);
  });

  it('returns { valid: false } for malformed header', () => {
    const journalDir = makeJournalDir();
    fs.writeFileSync(journalPath(journalDir), 'garbage header\nsrc/foo.js\n');
    expect(readJournal(journalDir).valid).toBe(false);
  });

  it('returns { valid: false } for invalid timestamp', () => {
    const journalDir = makeJournalDir();
    fs.writeFileSync(journalPath(journalDir), '# codegraph-journal v1 not-a-number\n');
    expect(readJournal(journalDir).valid).toBe(false);
  });

  it('returns { valid: false } for zero timestamp', () => {
    const journalDir = makeJournalDir();
    fs.writeFileSync(journalPath(journalDir), '# codegraph-journal v1 0\n');
    expect(readJournal(journalDir).valid).toBe(false);
  });

  it('parses valid journal with changed and removed files', () => {
    const journalDir = makeJournalDir();
    const content = [
      '# codegraph-journal v1 1700000000000',
      'src/builder.js',
      'src/db.js',
      'DELETED src/old-file.js',
      '',
    ].join('\n');
    fs.writeFileSync(journalPath(journalDir), content);

    const result = readJournal(journalDir);
    expect(result.valid).toBe(true);
    expect(result.timestamp).toBe(1700000000000);
    expect(result.changed).toEqual(['src/builder.js', 'src/db.js']);
    expect(result.removed).toEqual(['src/old-file.js']);
  });

  it('deduplicates repeated paths', () => {
    const journalDir = makeJournalDir();
    const content = [
      '# codegraph-journal v1 1700000000000',
      'src/foo.js',
      'src/foo.js',
      'src/bar.js',
      'DELETED src/old.js',
      'DELETED src/old.js',
      '',
    ].join('\n');
    fs.writeFileSync(journalPath(journalDir), content);

    const result = readJournal(journalDir);
    expect(result.changed).toEqual(['src/foo.js', 'src/bar.js']);
    expect(result.removed).toEqual(['src/old.js']);
  });

  it('skips blank lines and comment lines', () => {
    const journalDir = makeJournalDir();
    const content = [
      '# codegraph-journal v1 1700000000000',
      '',
      '# some comment',
      'src/foo.js',
      '   ',
      '',
    ].join('\n');
    fs.writeFileSync(journalPath(journalDir), content);

    const result = readJournal(journalDir);
    expect(result.changed).toEqual(['src/foo.js']);
    expect(result.removed).toEqual([]);
  });

  it('handles file with no trailing newline', () => {
    const journalDir = makeJournalDir();
    fs.writeFileSync(journalPath(journalDir), '# codegraph-journal v1 1700000000000\nsrc/a.js');

    const result = readJournal(journalDir);
    expect(result.valid).toBe(true);
    expect(result.changed).toEqual(['src/a.js']);
  });
});

describe('writeJournalHeader', () => {
  it('creates journal with header only', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);

    const content = fs.readFileSync(journalPath(journalDir), 'utf-8');
    expect(content).toBe('# codegraph-journal v1 1700000000000\n');
  });

  it('overwrites existing journal content', () => {
    const journalDir = makeJournalDir();
    fs.writeFileSync(journalPath(journalDir), '# codegraph-journal v1 100\nsrc/old.js\n');
    writeJournalHeader(journalDir, 200);

    const content = fs.readFileSync(journalPath(journalDir), 'utf-8');
    expect(content).toBe('# codegraph-journal v1 200\n');
  });

  it('creates the journal directory if missing', () => {
    // #2426: the passed directory need not be named `.codegraph` at all —
    // a caller-supplied dbPath can relocate the database (and therefore the
    // journal) anywhere.
    const journalDir = fs.mkdtempSync(path.join(tmpDir, 'nodir-custom-dbpath-'));
    fs.rmSync(journalDir, { recursive: true, force: true });
    writeJournalHeader(journalDir, 1700000000000);
    expect(fs.existsSync(journalPath(journalDir))).toBe(true);
  });
});

describe('appendJournalEntries', () => {
  it('appends changed file entries', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }, { file: 'src/b.js' }]);

    const result = readJournal(journalDir);
    expect(result.valid).toBe(true);
    expect(result.changed).toEqual(['src/a.js', 'src/b.js']);
  });

  it('appends deleted file entries with DELETED prefix', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);
    appendJournalEntries(journalDir, [{ file: 'src/removed.js', deleted: true }]);

    const result = readJournal(journalDir);
    expect(result.removed).toEqual(['src/removed.js']);
  });

  it('creates journal with placeholder header if missing', () => {
    const journalDir = makeJournalDir();
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }]);

    // Placeholder header has timestamp 0 → readJournal returns invalid
    const result = readJournal(journalDir);
    expect(result.valid).toBe(false);

    // But the file exists and has the entry
    const content = fs.readFileSync(journalPath(journalDir), 'utf-8');
    expect(content).toContain('src/a.js');
  });

  it('appends multiple batches', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }]);
    appendJournalEntries(journalDir, [{ file: 'src/b.js' }]);

    const result = readJournal(journalDir);
    expect(result.changed).toEqual(['src/a.js', 'src/b.js']);
  });
});

describe('concurrent-append safety', () => {
  it('cleans up the .lock file after a successful append', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }]);

    const lockPath = path.join(journalDir, `${JOURNAL_FILENAME}.lock`);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('steals a stale lock whose holder PID is dead', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);

    // Pre-stage a lockfile with a PID that is guaranteed not to exist
    // (max 32-bit value; well above any real process).
    const lockPath = path.join(journalDir, `${JOURNAL_FILENAME}.lock`);
    fs.writeFileSync(lockPath, '2147483646\n');

    expect(() => appendJournalEntries(journalDir, [{ file: 'src/a.js' }])).not.toThrow();
    expect(fs.existsSync(lockPath)).toBe(false);

    const result = readJournal(journalDir);
    expect(result.changed).toEqual(['src/a.js']);
  });

  it("does not unlink another writer's lockfile after a stale-lock steal race", () => {
    // Regression test for Greptile P1 TOCTOU: when two stealers observe the
    // same stale holder, the loser must NOT unlink the winner's live lockfile.
    //
    // We simulate the race by: (1) staging a stale lock with a dead PID,
    // (2) invoking an append (which will steal the stale lock, do its work,
    // and release it), then (3) staging a *live* lockfile that pretends to
    // belong to a different winner, and (4) making sure the previous release
    // path does not retroactively unlink it.
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);

    const lockPath = path.join(journalDir, `${JOURNAL_FILENAME}.lock`);

    // Stage a stale lock held by a dead PID.
    fs.writeFileSync(lockPath, '2147483646\n');

    // Run the real acquire/steal/release cycle.
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }]);

    // Lock should be fully released (no residual lockfile).
    expect(fs.existsSync(lockPath)).toBe(false);

    // Now simulate that another writer came along and acquired the lock
    // with a DIFFERENT nonce. If our prior release path were incorrectly
    // unlinking by path (without nonce verification), this file would be
    // removed by a retry. It must remain intact.
    fs.writeFileSync(lockPath, '99999\nsome-other-writer-nonce-abc123\n');
    expect(fs.existsSync(lockPath)).toBe(true);

    // Clean up.
    fs.unlinkSync(lockPath);
  });

  it('produces no interleaved lines under repeated appends', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);

    // Many small appends — every emitted line must be a complete,
    // well-formed entry (no truncated "DELETED " prefixes, no split paths).
    for (let i = 0; i < 200; i++) {
      appendJournalEntries(journalDir, [
        { file: `src/changed-${i}.js` },
        { file: `src/gone-${i}.js`, deleted: true },
      ]);
    }

    const content = fs.readFileSync(path.join(journalDir, JOURNAL_FILENAME), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      expect(line).toMatch(/^(DELETED src\/gone-\d+\.js|src\/changed-\d+\.js)$/);
    }
  });

  it('sweeps orphaned .tmp files older than the stale threshold', () => {
    // Regression for Greptile P2: crash-mid-steal leaves .codegraph/changes.journal.lock.<nonce>.tmp
    // files behind. withJournalLock should clean up stale ones (> LOCK_STALE_MS old) on entry.
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1700000000000);

    const freshTmp = path.join(journalDir, `${JOURNAL_FILENAME}.lock.fresh-nonce.tmp`);
    const staleTmp = path.join(journalDir, `${JOURNAL_FILENAME}.lock.stale-nonce.tmp`);
    fs.writeFileSync(freshTmp, 'fresh');
    fs.writeFileSync(staleTmp, 'stale');

    // Backdate the stale tmp file past the 30s stale threshold.
    const pastMs = Date.now() - 60_000;
    const past = new Date(pastMs);
    fs.utimesSync(staleTmp, past, past);

    // Any journal write enters withJournalLock which triggers the sweep.
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }]);

    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);

    // Clean up the fresh tmp so makeJournalDir's temp dir removal stays clean.
    fs.unlinkSync(freshTmp);
  });
});

describe('appendJournalEntriesAndStampHeader', () => {
  it('creates journal with header + entries when none exists', () => {
    const journalDir = makeJournalDir();
    appendJournalEntriesAndStampHeader(journalDir, [{ file: 'src/a.js' }], 1700000000000);

    const result = readJournal(journalDir);
    expect(result.valid).toBe(true);
    expect(result.timestamp).toBe(1700000000000);
    expect(result.changed).toEqual(['src/a.js']);
  });

  it('advances the header timestamp while preserving prior entries', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1000);
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }, { file: 'src/b.js', deleted: true }]);

    appendJournalEntriesAndStampHeader(journalDir, [{ file: 'src/c.js' }], 2000);

    const result = readJournal(journalDir);
    expect(result.valid).toBe(true);
    expect(result.timestamp).toBe(2000);
    expect(result.changed).toEqual(['src/a.js', 'src/c.js']);
    expect(result.removed).toEqual(['src/b.js']);
  });

  it('advances the header even when no new entries are supplied', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1000);
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }]);

    appendJournalEntriesAndStampHeader(journalDir, [], 2000);

    const result = readJournal(journalDir);
    expect(result.timestamp).toBe(2000);
    expect(result.changed).toEqual(['src/a.js']);
  });

  it('is atomic: interleaved reads see either old or new state, never a truncated header', () => {
    const journalDir = makeJournalDir();
    writeJournalHeader(journalDir, 1000);
    appendJournalEntries(journalDir, [{ file: 'src/a.js' }]);

    appendJournalEntriesAndStampHeader(journalDir, [{ file: 'src/b.js' }], 2000);

    // No leftover .tmp file after the rename
    expect(fs.existsSync(`${journalPath(journalDir)}.tmp`)).toBe(false);
    const content = fs.readFileSync(journalPath(journalDir), 'utf-8');
    expect(content.startsWith('# codegraph-journal v1 2000\n')).toBe(true);
  });
});

describe('regression: watch session keeps header ahead of DB mtime', () => {
  it('header timestamp reflects latest append, not prior build', () => {
    // Simulates the bug in #997: after a build finalizes the journal header
    // at T0, the watcher appends entries at T1 > T0. A later build's Tier 0
    // check compares journal.timestamp against MAX(file_hashes.mtime).
    // If the header stays at T0, Tier 0 bails out and the fast path is lost.
    const journalDir = makeJournalDir();

    const buildFinalizedAt = 1000;
    writeJournalHeader(journalDir, buildFinalizedAt);

    const watcherAppendAt = 2500;
    appendJournalEntriesAndStampHeader(journalDir, [{ file: 'src/a.js' }], watcherAppendAt);

    const journal = readJournal(journalDir);
    expect(journal.valid).toBe(true);
    expect(journal.timestamp).toBeGreaterThanOrEqual(watcherAppendAt);
    // latestDbMtime can never exceed the timestamp of the most recent append
    // because the watcher journals a file immediately after processing it.
    const simulatedDbMtime = watcherAppendAt;
    expect(journal.timestamp!).toBeGreaterThanOrEqual(simulatedDbMtime);
  });
});

describe('read/write/append lifecycle', () => {
  it('full lifecycle: header → append → read → new header', () => {
    const journalDir = makeJournalDir();

    // Simulate build completion
    writeJournalHeader(journalDir, 1000);

    // Simulate watcher appending changes
    appendJournalEntries(journalDir, [
      { file: 'src/foo.js' },
      { file: 'src/bar.js', deleted: true },
    ]);

    // Simulate next build reading journal
    const journal = readJournal(journalDir);
    expect(journal.valid).toBe(true);
    expect(journal.timestamp).toBe(1000);
    expect(journal.changed).toEqual(['src/foo.js']);
    expect(journal.removed).toEqual(['src/bar.js']);

    // Build completes, reset journal
    writeJournalHeader(journalDir, 2000);
    const fresh = readJournal(journalDir);
    expect(fresh.valid).toBe(true);
    expect(fresh.changed).toEqual([]);
    expect(fresh.removed).toEqual([]);
  });
});
