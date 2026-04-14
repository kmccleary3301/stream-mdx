import assert from "node:assert";

import { LOOKAHEAD_SUPPORT_MATRIX } from "../src/streaming/lookahead-contract";

function testSupportMatrixCoversEverySurfaceExactlyOnce() {
  const surfaces = LOOKAHEAD_SUPPORT_MATRIX.map((entry) => entry.surface);
  const unique = new Set(surfaces);
  assert.strictEqual(unique.size, surfaces.length, "support matrix should not contain duplicate surfaces");
  assert.deepStrictEqual([...unique].sort(), [
    "html-block",
    "html-inline",
    "inline-format",
    "math-block",
    "math-inline",
    "mdx-expression",
    "mdx-tag",
    "regex",
  ]);
}

function testSupportMatrixPoliciesMatchCurrentV1Contract() {
  const bySurface = new Map(LOOKAHEAD_SUPPORT_MATRIX.map((entry) => [entry.surface, entry]));

  assert.strictEqual(bySurface.get("mdx-expression")?.status, "hard-stop-only");
  assert.strictEqual(bySurface.get("mdx-expression")?.smokeEligible, false);

  assert.strictEqual(bySurface.get("math-inline")?.status, "bounded");
  assert.strictEqual(bySurface.get("math-block")?.status, "bounded");
  assert.strictEqual(bySurface.get("math-inline")?.smokePromoted, true);
  assert.strictEqual(bySurface.get("math-block")?.smokePromoted, false);

  assert.strictEqual(bySurface.get("html-block")?.status, "hard-stop-only");
  assert.strictEqual(bySurface.get("mdx-tag")?.status, "bounded");
  assert.strictEqual(bySurface.get("html-inline")?.smokePromoted, true);
}

testSupportMatrixCoversEverySurfaceExactlyOnce();
testSupportMatrixPoliciesMatchCurrentV1Contract();
console.log("lookahead support matrix tests passed");
