/**
 * Regression test for issue #2005: docs/examples/MCP.md's fenced ```json
 * blocks (tool-call arguments and JSON-shaped tool responses) were
 * hand-transcribed with no automated check that they're even syntactically
 * valid JSON, which is very likely how they drifted out of sync with the
 * real MCP tool output in the first place (see #1873).
 *
 * This doesn't verify the examples match real tool output (that would
 * require running the MCP server against a fixture graph — a larger,
 * separately-tracked effort), only that every ```json block parses. That's
 * a cheap, mechanical floor: a hand-edited example that regresses to broken
 * JSON syntax (e.g. an unquoted placeholder like `{ ... }`) fails immediately
 * instead of drifting silently.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(__dirname, '../..');
const MCP_DOC_PATH = path.join(REPO_ROOT, 'docs/examples/MCP.md');

/** Extract the content of every ` ```json ` fenced block in a markdown doc. */
function jsonBlocks(doc: string): string[] {
  return [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
}

describe('docs/examples/MCP.md ```json blocks are valid JSON (#2005)', () => {
  const doc = readFileSync(MCP_DOC_PATH, 'utf-8');
  const blocks = jsonBlocks(doc);

  it('finds a non-trivial number of ```json blocks (extraction sanity check)', () => {
    expect(blocks.length).toBeGreaterThan(40);
  });

  blocks.forEach((block, i) => {
    it(`block ${i + 1}/${blocks.length} parses as valid JSON`, () => {
      expect(() => JSON.parse(block)).not.toThrow();
    });
  });
});
