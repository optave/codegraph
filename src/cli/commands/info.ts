import { debug } from '../../infrastructure/logger.js';
import { toErrorMessage } from '../../shared/errors.js';
import type { BetterSqlite3Database, NativeAddon } from '../../types.js';
import type { CliContext, CommandDefinition, CommandOpts } from '../types.js';

/** Max interface names to print by name in the CHA-zero-implementor nudge before falling back to a count. */
const CHA_NUDGE_MAX_NAMED = 3;

/**
 * Build the CHA-zero-implementor nudge line for `codegraph info`, or `null`
 * when there's nothing to report.
 *
 * `raw` is the `cha_zero_implementor_interfaces` build_meta snapshot — a
 * JSON array of interface/base-class names that had ZERO instantiated
 * implementors as of the last FULL build (written by
 * `persistChaZeroImplementorSnapshot` in `domain/graph/builder/stages/finalize.ts`,
 * and its sibling call site in `native-orchestrator.ts`'s all-Rust fast
 * path). This compares that snapshot against a FRESH `buildChaContextFromDb`
 * call against this same `db`. Any name present in the snapshot that now has
 * at least one instantiated implementor has gained one since that full
 * build: the one caller-discovery gap `findChaSiblingCallerFiles`
 * (`domain/graph/builder/incremental.ts`) cannot close by searching existing
 * edges alone (issue #2315) — a caller typed against that interface may
 * still be missing its dispatch edge to the new implementor until a full
 * (non-incremental) rebuild runs.
 *
 * `db` must still be open when this is called — it re-queries `nodes`/`edges`.
 * `buildChaContextFromDb` is passed in (rather than dynamically imported
 * here) so `printBuildMetadata` only pays for one dynamic import of
 * `cha.js` and reads `CHA_ZERO_IMPLEMENTOR_META_KEY` from the same module.
 */
function buildChaZeroImplementorNudge(
  db: BetterSqlite3Database,
  raw: string | null,
  buildChaContextFromDb: typeof import('../../domain/graph/builder/cha.js').buildChaContextFromDb,
): string | null {
  if (!raw) return null;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(raw);
  } catch (e) {
    debug(`cha_zero_implementor_interfaces build_meta is not valid JSON: ${toErrorMessage(e)}`);
    return null;
  }
  if (!Array.isArray(snapshot) || snapshot.length === 0) return null;

  const chaCtx = buildChaContextFromDb(db);
  const nowImplemented = snapshot.filter((name): name is string => {
    if (typeof name !== 'string') return false;
    const implementorNames = chaCtx.implementors.get(name);
    return implementorNames?.some((cls) => chaCtx.instantiatedTypes.has(cls)) ?? false;
  });
  if (nowImplemented.length === 0) return null;

  const plural = nowImplemented.length > 1;
  const named =
    nowImplemented.length <= CHA_NUDGE_MAX_NAMED
      ? nowImplemented.join(', ')
      : `${nowImplemented.length} interfaces`;
  return (
    `  \u26A0 ${named} gained ${plural ? 'their' : 'its'} first instantiated implementor since ` +
    `the last full build; existing callers may be missing dispatch edges. ` +
    `Consider: codegraph build --no-incremental`
  );
}

/** Print the "Native version" diagnostic line (reconciles npm package vs. loaded binary version). */
function printNativeVersionInfo(
  native: NativeAddon,
  getNativePackageVersion: () => string | null,
): void {
  const binaryVersion =
    typeof native.engineVersion === 'function' ? native.engineVersion() : 'unknown';
  const pkgVersion = getNativePackageVersion();
  const knownBinaryVersion = binaryVersion !== 'unknown' ? binaryVersion : null;
  if (pkgVersion && knownBinaryVersion && pkgVersion !== knownBinaryVersion) {
    console.log(
      `  Native version: ${pkgVersion} (binary built as ${knownBinaryVersion}, engine loaded OK)`,
    );
  } else {
    console.log(`  Native version: ${pkgVersion ?? binaryVersion}`);
  }
}

/** Print the top "Codegraph Diagnostics" block: version, platform, native/active engine info. */
function printEngineInfo(
  ctx: CliContext,
  engine: string,
  activeName: string,
  activeVersion: string | null,
  nativeAvailable: boolean,
  loadNative: () => NativeAddon | null,
  getNativePackageVersion: () => string | null,
): void {
  console.log('\nCodegraph Diagnostics');
  console.log('====================');
  console.log(`  Version       : ${ctx.program.version()}`);
  console.log(`  Node.js       : ${process.version}`);
  console.log(`  Platform      : ${process.platform}-${process.arch}`);
  console.log(`  Native engine : ${nativeAvailable ? 'available' : 'unavailable'}`);
  const native = nativeAvailable ? loadNative() : null;
  if (native) {
    printNativeVersionInfo(native, getNativePackageVersion);
  }
  console.log(`  Engine flag   : --engine ${engine}`);
  console.log(`  Active engine : ${activeName}${activeVersion ? ` (v${activeVersion})` : ''}`);
  console.log();
}

/**
 * Print the "Build metadata" block read from the graph DB, if one exists. Never throws.
 * Exported for direct testing of its own busy_timeout pragma (issue #2020).
 */
export async function printBuildMetadata(
  ctx: CliContext,
  opts: CommandOpts,
  activeName: string,
): Promise<void> {
  try {
    const { findDbPath, getBuildMeta, resolveBusyTimeoutMs } = await import('../../db/index.js');
    const { buildChaContextFromDb, CHA_ZERO_IMPLEMENTOR_META_KEY } = await import(
      '../../domain/graph/builder/cha.js'
    );
    const Database = (await import('better-sqlite3')).default;
    const dbPath = findDbPath(opts.db as string | undefined);
    const fs = await import('node:fs');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      db.pragma(`busy_timeout = ${resolveBusyTimeoutMs(dbPath)}`);
      const buildEngine = getBuildMeta(db, 'engine');
      const buildVersion = getBuildMeta(db, 'codegraph_version');
      const builtAt = getBuildMeta(db, 'built_at');
      const chaZeroImplementorRaw = getBuildMeta(db, CHA_ZERO_IMPLEMENTOR_META_KEY);
      // Computed while `db` is still open: buildChaZeroImplementorNudge re-queries it.
      const chaNudge = buildChaZeroImplementorNudge(
        db,
        chaZeroImplementorRaw,
        buildChaContextFromDb,
      );
      db.close();

      if (buildEngine || buildVersion || builtAt) {
        console.log('Build metadata');
        console.log(
          '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
        );
        if (buildEngine) console.log(`  Engine        : ${buildEngine}`);
        if (buildVersion) console.log(`  Version       : ${buildVersion}`);
        if (builtAt) console.log(`  Built at      : ${builtAt}`);

        if (buildVersion && buildVersion !== ctx.program.version()) {
          console.log(
            `  \u26A0 DB was built with v${buildVersion}, current is v${ctx.program.version()}. Consider: codegraph build --no-incremental`,
          );
        }
        if (buildEngine && buildEngine !== activeName) {
          console.log(
            `  \u26A0 DB was built with ${buildEngine} engine, active is ${activeName}. Consider: codegraph build --no-incremental`,
          );
        }
        if (chaNudge) console.log(chaNudge);
        console.log();
      }
    }
  } catch (e) {
    /* diagnostics must never crash */
    debug(`DB build-metadata diagnostics failed: ${toErrorMessage(e)}`);
  }
}

export const command: CommandDefinition = {
  name: 'info',
  description: 'Show codegraph engine info and diagnostics',
  options: [['-d, --db <path>', 'Path to graph.db']],
  async execute(_args, opts, ctx) {
    const { getNativePackageVersion, isNativeAvailable, loadNative } = await import(
      '../../infrastructure/native.js'
    );
    const { getActiveEngine } = await import('../../domain/parser.js');

    const engine = ctx.program.opts().engine;
    const { name: activeName, version: activeVersion } = getActiveEngine({ engine });
    const nativeAvailable = isNativeAvailable();

    printEngineInfo(
      ctx,
      engine,
      activeName,
      activeVersion,
      nativeAvailable,
      loadNative,
      getNativePackageVersion,
    );

    await printBuildMetadata(ctx, opts, activeName);
  },
};
