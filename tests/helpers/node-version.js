/**
 * Node >= 22.6 supports --experimental-strip-types, required for tests that
 * spawn child processes loading .ts source files directly.
 */
const [_major, _minor] = process.versions.node.split('.').map(Number);
export const canStripTypes = _major > 22 || (_major === 22 && _minor >= 6);
