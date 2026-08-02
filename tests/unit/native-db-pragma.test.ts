/**
 * Regression tests for issue #2019: `NativeDatabase.pragma()` hardcoded a
 * `String` read of the result column, so any PRAGMA whose result has INTEGER
 * affinity (the overwhelming majority — `busy_timeout`, `page_count`,
 * `user_version`, etc.) threw "Invalid column type Integer" instead of
 * returning the value. Only TEXT-affinity pragmas like `journal_mode`
 * happened to work.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getNative, isNativeAvailable } from '../../src/infrastructure/native.js';
import type { NativeDatabase } from '../../src/types.js';

const hasNativeDb =
  isNativeAvailable() && typeof getNative().NativeDatabase?.prototype?.pragma === 'function';

describe.skipIf(!hasNativeDb)('NativeDatabase.pragma (issue #2019)', () => {
  let nativeDb: NativeDatabase;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-pragma-'));
    dbPath = path.join(tmpDir, 'test.db');
    const NativeDB = getNative().NativeDatabase;
    nativeDb = NativeDB.openReadWrite(dbPath, 424242);
  });

  afterEach(() => {
    nativeDb.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('returns an INTEGER-affinity pragma result instead of throwing (busy_timeout)', () => {
    expect(nativeDb.pragma('busy_timeout')).toBe(424242);
  });

  it('returns an INTEGER-affinity pragma result instead of throwing (page_count)', () => {
    const pageCount = nativeDb.pragma('page_count');
    expect(typeof pageCount).toBe('number');
    expect(pageCount as number).toBeGreaterThanOrEqual(0);
  });

  it('returns an INTEGER-affinity pragma result instead of throwing (user_version)', () => {
    expect(nativeDb.pragma('user_version')).toBe(0);
  });

  it('still returns a TEXT-affinity pragma result (journal_mode)', () => {
    expect(typeof nativeDb.pragma('journal_mode')).toBe('string');
  });

  it('returns null when the pragma produces no output', () => {
    expect(nativeDb.pragma('optimize')).toBeNull();
  });
});
