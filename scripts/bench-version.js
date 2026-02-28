/**
 * Compute the benchmark version string from git state.
 *
 * - If HEAD is exactly a release tag (v*): returns pkg.version (e.g. "2.4.0")
 * - Otherwise: returns "pkg.version-dev.N+hash" (e.g. "2.4.0-dev.12+c50f7f5")
 *   where N = commits since last release tag, hash = short commit SHA
 *
 * This prevents dev/dogfood benchmark runs from overwriting release data
 * in the historical benchmark reports (which deduplicate by version).
 */

import { execFileSync } from 'node:child_process';

export function getBenchmarkVersion(pkgVersion, cwd) {
	try {
		// Check if HEAD is exactly a release tag
		execFileSync('git', ['describe', '--tags', '--exact-match', '--match', 'v*'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return pkgVersion;
	} catch {
		// Not on a release tag — compute dev version
		try {
			const desc = execFileSync('git', ['describe', '--tags', '--match', 'v*', '--always'], {
				cwd,
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
			// desc is like "v2.4.0-12-gc50f7f5"
			const m = desc.match(/^v.+-(\d+)-g([0-9a-f]+)$/);
			if (m) return `${pkgVersion}-dev.${m[1]}+${m[2]}`;
		} catch {
			/* git not available or no tags */
		}
		return `${pkgVersion}-dev`;
	}
}
