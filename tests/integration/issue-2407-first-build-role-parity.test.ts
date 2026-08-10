/**
 * Integration test for #2407 / #2261: a project's first-ever build must apply
 * the same #2032 transitive-reachability dead-code downgrade that a
 * `--no-incremental` rebuild does, under either engine.
 *
 * `helper`'s only caller is `run`, and `run` is not a confirmed-live root —
 * it is not exported, not framework-dispatched, and nothing else calls it. So
 * `helper`'s single inbound `calls` edge is no evidence of liveness, and both
 * engines must report it `dead-unresolved` rather than reading fan-in = 1 as
 * `core`. `run` itself keeps the `leaf` verdict it gets from
 * `classifyUnreferencedNode`'s value-reference rescue (fanIn 0, fanOut > 0,
 * with a called sibling in the same file) — the reachability pass only
 * reconsiders fan-shape verdicts, never that branch.
 *
 * Root cause of the divergence: `getChangedFiles` probed only for the
 * *existence* of `file_hashes`, which `initSchema` creates on every DB open,
 * so a first build was labelled incremental and its roles were classified by
 * `classifyNodeRolesIncremental` — which deliberately omits the whole-graph
 * reachability pass. The native change detector has always treated an empty
 * table as "no prior build", so only the WASM/JS path was affected, and the
 * same source produced a different dead-code count per engine.
 *
 * Both builds here run with codegraph's DEFAULT `incremental` setting on
 * purpose. Passing `incremental: false` forces the full-build path directly
 * and would sail past the bug — which is exactly why the existing role tests
 * (all of which pass `incremental: false`) never caught it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// Deliberately plain, same-file JavaScript with no imports and no exports:
// the divergence is language-agnostic and needs no import resolution to
// reproduce, so nothing here depends on either engine's resolver.
const FIXTURE = `function helper() {
  return 1;
}

function run() {
  return helper();
}
`;

interface RoleRow {
  name: string;
  kind: string;
  role: string | null;
}

function readFunctionRoles(dbPath: string): RoleRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT name, kind, role FROM nodes WHERE kind = 'function' ORDER BY name")
      .all() as RoleRow[];
  } finally {
    db.close();
  }
}

async function buildFixture(engine: 'wasm' | 'native'): Promise<RoleRow[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2407-${engine}-`));
  try {
    fs.writeFileSync(path.join(tmpDir, 'mod.js'), FIXTURE);
    // No `incremental: false` — the first build must reach the full-build
    // path on its own. See the file header.
    await buildGraph(tmpDir, { engine, skipRegistry: true });
    return readFunctionRoles(path.join(tmpDir, '.codegraph', 'graph.db'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const EXPECTED: RoleRow[] = [
  { name: 'helper', kind: 'function', role: 'dead-unresolved' },
  { name: 'run', kind: 'function', role: 'leaf' },
];

describe('first-build role classification (#2407 / #2261) — WASM', () => {
  let roles: RoleRow[];

  beforeAll(async () => {
    roles = await buildFixture('wasm');
  });

  it('downgrades a function whose only caller is unreachable to dead-unresolved', () => {
    expect(roles).toEqual(EXPECTED);
  });
});

describe.skipIf(!isNativeAvailable())(
  'first-build role classification (#2407 / #2261) — native',
  () => {
    let roles: RoleRow[];

    beforeAll(async () => {
      roles = await buildFixture('native');
    });

    it('downgrades a function whose only caller is unreachable to dead-unresolved', () => {
      expect(roles).toEqual(EXPECTED);
    });
  },
);

describe.skipIf(!isNativeAvailable())(
  'first-build role-column parity across engines (#2407)',
  () => {
    it('assigns identical roles under both engines', async () => {
      const [wasmRoles, nativeRoles] = await Promise.all([
        buildFixture('wasm'),
        buildFixture('native'),
      ]);
      // Compared directly rather than each against EXPECTED: this is the
      // assertion the issue asked for — the existing engine-parity tests
      // compare extracted symbols and edges only, never the `role` column,
      // which is why a classification-only divergence went unnoticed.
      expect(wasmRoles).toEqual(nativeRoles);
    });
  },
);
