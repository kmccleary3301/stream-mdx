import assert from "node:assert";

import { LOOKAHEAD_FEATURE_REGISTRY, LOOKAHEAD_SUPPORT_MATRIX, LOOKAHEAD_SUPPORT_MATRIX_BY_SURFACE } from "../src/streaming/lookahead-contract";

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
  assert.strictEqual(bySurface.get("math-block")?.smokePromoted, true);

  assert.strictEqual(bySurface.get("html-block")?.status, "hard-stop-only");
  assert.strictEqual(bySurface.get("mdx-tag")?.status, "bounded");
  assert.strictEqual(bySurface.get("html-inline")?.smokePromoted, true);
}

function testSupportMatrixLookupMatchesListEntries() {
  for (const entry of LOOKAHEAD_SUPPORT_MATRIX) {
    assert.deepStrictEqual(LOOKAHEAD_SUPPORT_MATRIX_BY_SURFACE[entry.surface], entry);
  }
}

function testFeatureRegistryCoversCurrentAndPostV1Families() {
  const ids = new Set(LOOKAHEAD_FEATURE_REGISTRY.map((entry) => entry.id));
  assert.ok(ids.has("math-left-right-local"));
  assert.ok(ids.has("math-environment-structured"));
  assert.ok(ids.has("math-alignment-structured"));
  assert.ok(ids.has("mdx-expression-conservative"));

  const leftRight = LOOKAHEAD_FEATURE_REGISTRY.find((entry) => entry.id === "math-left-right-local");
  assert.strictEqual(leftRight?.status, "bounded");
  assert.strictEqual(leftRight?.smoke, "eligible");

  const leftRightBlock = LOOKAHEAD_FEATURE_REGISTRY.find((entry) => entry.id === "math-left-right-local-block");
  assert.strictEqual(leftRightBlock?.status, "bounded");
  assert.strictEqual(leftRightBlock?.smoke, "promoted");

  const displayLocal = LOOKAHEAD_FEATURE_REGISTRY.find((entry) => entry.id === "math-display-local");
  assert.strictEqual(displayLocal?.status, "bounded");
  assert.strictEqual(displayLocal?.smoke, "promoted");

  const env = LOOKAHEAD_FEATURE_REGISTRY.find((entry) => entry.id === "math-environment-structured");
  assert.strictEqual(env?.status, "hard-stop-only");
  assert.strictEqual(env?.smoke, "never");
}

testSupportMatrixCoversEverySurfaceExactlyOnce();
testSupportMatrixPoliciesMatchCurrentV1Contract();
testSupportMatrixLookupMatchesListEntries();
testFeatureRegistryCoversCurrentAndPostV1Families();
console.log("lookahead support matrix tests passed");
