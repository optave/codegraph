import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'update-incremental-report.ts');

// --experimental-strip-types works in Node 22.6+ through current 24.x; the
// renamed --strip-types was added then removed again across 24.x minor
// versions, so prefer the experimental name for compatibility.
const stripFlag = '--experimental-strip-types';

const SAMPLE_ENTRY = {
  version: '9.9.9',
  date: '2026-05-14',
  files: 100,
  wasm: { fullBuildMs: 1000, noopRebuildMs: 10, oneFileRebuildMs: 50 },
  native: { fullBuildMs: 500, noopRebuildMs: 5, oneFileRebuildMs: 25 },
  resolve: {
    imports: 200,
    nativeBatchMs: 2,
    jsFallbackMs: 4,
    perImportNativeMs: 0,
    perImportJsMs: 0,
  },
};

let tmpDir: string;
let reportPath: string;
let entryPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-incr-report-'));
  reportPath = path.join(tmpDir, 'INCREMENTAL-BENCHMARKS.md');
  entryPath = path.join(tmpDir, 'entry.json');
  fs.writeFileSync(entryPath, JSON.stringify(SAMPLE_ENTRY));
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runScript() {
  execFileSync('node', [stripFlag, scriptPath, entryPath], {
    env: { ...process.env, CODEGRAPH_INCREMENTAL_REPORT_PATH: reportPath },
    stdio: 'pipe',
  });
}

describe('update-incremental-report script', () => {
  it('preserves a manual NOTES_START/NOTES_END block across regeneration', () => {
    const NOTES = `<!-- NOTES_START -->
**Note (9.9.8):** Workers hung past the 10-minute timeout and were SIGKILL'd.
<!-- NOTES_END -->`;
    const initial = `# Codegraph Incremental Build Benchmarks

${NOTES}

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "9.9.8",
    "date": "2026-05-01",
    "files": 99,
    "wasm": null,
    "native": null,
    "resolve": { "imports": 100, "nativeBatchMs": 1, "jsFallbackMs": 2, "perImportNativeMs": 0, "perImportJsMs": 0 }
  }
]
-->
`;
    fs.writeFileSync(reportPath, initial);

    runScript();

    const out = fs.readFileSync(reportPath, 'utf8');
    expect(out).toContain('<!-- NOTES_START -->');
    expect(out).toContain('<!-- NOTES_END -->');
    expect(out).toContain("Workers hung past the 10-minute timeout and were SIGKILL'd");
    // Notes should appear before the data comment, after the latest summary
    expect(out.indexOf('<!-- NOTES_START -->')).toBeLessThan(
      out.indexOf('<!-- INCREMENTAL_BENCHMARK_DATA'),
    );
  });

  it('preserves multiple NOTES_START/NOTES_END blocks across regeneration', () => {
    const NOTES_A = `<!-- NOTES_START -->
**Note (9.9.8):** Workers hung past the 10-minute timeout and were SIGKILL'd.
<!-- NOTES_END -->`;
    const NOTES_B = `<!-- NOTES_START -->
**Note (9.9.7):** Build artifact corrupted during upload, metrics re-run manually.
<!-- NOTES_END -->`;
    const initial = `# Codegraph Incremental Build Benchmarks

${NOTES_A}

${NOTES_B}

<!-- INCREMENTAL_BENCHMARK_DATA
[]
-->
`;
    fs.writeFileSync(reportPath, initial);

    runScript();

    const out = fs.readFileSync(reportPath, 'utf8');
    // Both notes must survive regeneration — single-block preservation would
    // silently drop the second block (the same data-loss class this PR fixes).
    expect(out).toContain("Workers hung past the 10-minute timeout and were SIGKILL'd");
    expect(out).toContain('Build artifact corrupted during upload, metrics re-run manually');
    // Each block keeps its own pair of delimiters.
    expect(out.match(/<!--\s*NOTES_START\s*-->/g)?.length).toBe(2);
    expect(out.match(/<!--\s*NOTES_END\s*-->/g)?.length).toBe(2);
  });

  it('renders a Full Build (ms/file) column normalized against files, with its own trend (#2455)', () => {
    const initial = `# Codegraph Incremental Build Benchmarks

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "9.9.8",
    "date": "2026-05-01",
    "files": 800,
    "wasm": { "fullBuildMs": 16000, "noopRebuildMs": 20, "oneFileRebuildMs": 100 },
    "native": { "fullBuildMs": 5200, "noopRebuildMs": 10, "oneFileRebuildMs": 50 },
    "resolve": { "imports": 100, "nativeBatchMs": 5, "jsFallbackMs": 10, "perImportNativeMs": 0, "perImportJsMs": 0 }
  }
]
-->
`;
    fs.writeFileSync(reportPath, initial);
    // 9.9.9 doubles files (800 -> 1600) and roughly doubles native fullBuildMs
    // (5200 -> 10400) — same per-file cost, so raw ms doubles (+100%) but
    // ms/file should read as unchanged (~0%).
    fs.writeFileSync(
      entryPath,
      JSON.stringify({
        version: '9.9.9',
        date: '2026-05-14',
        files: 1600,
        wasm: { fullBuildMs: 32000, noopRebuildMs: 20, oneFileRebuildMs: 100 },
        native: { fullBuildMs: 10400, noopRebuildMs: 10, oneFileRebuildMs: 50 },
        resolve: {
          imports: 200,
          nativeBatchMs: 5,
          jsFallbackMs: 10,
          perImportNativeMs: 0,
          perImportJsMs: 0,
        },
      }),
    );

    runScript();
    const out = fs.readFileSync(reportPath, 'utf8');

    expect(out).toContain('Full Build (ms/file)');
    const nativeRow = out.match(/^\| 9\.9\.9 \| native \|.*$/m)?.[0];
    expect(nativeRow).toBeDefined();
    // Raw full build doubled (+100%)...
    expect(nativeRow).toContain('↑100%');
    // ...but ms/file (6.5) is unchanged from the prior release, so its own
    // trend cell reads "~" rather than another "↑100%".
    expect(nativeRow).toContain('6.5000 ~');

    const latestSection = out.slice(out.indexOf('### Latest results'));
    expect(latestSection).toContain('Full build (ms/file)');
    expect(latestSection).toContain('6.5000');
  });

  it('does not invent a NOTES block when none was present', () => {
    const initial = `# Codegraph Incremental Build Benchmarks

<!-- INCREMENTAL_BENCHMARK_DATA
[]
-->
`;
    fs.writeFileSync(reportPath, initial);

    runScript();

    const out = fs.readFileSync(reportPath, 'utf8');
    expect(out).not.toContain('NOTES_START');
    expect(out).not.toContain('NOTES_END');
  });
});
