import assert from "node:assert";

import { analyzeMathTailShadow } from "../src/streaming/math-tail-shadow";

function testFixedArityRepairShadow() {
  const analysis = analyzeMathTailShadow({
    raw: "$\\frac{a",
    surface: "math-inline",
    decision: "repair",
    ops: [
      { kind: "insert-empty-group" },
      { kind: "append", text: "}" },
      { kind: "close-delimiter", text: "$" },
    ],
    validation: { valid: true },
    notes: ["fill missing \\frac groups", "close unmatched tail delimiters", "close inline math delimiter"],
  });
  assert.strictEqual(analysis.family, "fixed-arity-local");
  assert.strictEqual(analysis.selectedCandidate, "repaired");
  assert.ok(analysis.obligations?.some((entry) => entry.kind === "missing-group"));
}

function testLeftRightUnsupportedShadow() {
  const analysis = analyzeMathTailShadow({
    raw: "$$\\left(x + y",
    surface: "math-block",
    decision: "raw",
    ops: [],
    validation: { valid: false, errors: ["left-right math repair is deferred"] },
    notes: ["unsupported \\left/\\right pair"],
    downgradeReason: "left-right math repair is deferred",
  });
  assert.strictEqual(analysis.family, "left-right-local");
  assert.strictEqual(analysis.unsupportedReason, "left-right math repair is deferred");
  assert.strictEqual(analysis.selectedCandidate, "raw");
}

function testAlignmentStructuredShadow() {
  const analysis = analyzeMathTailShadow({
    raw: "$$\\begin{align}a&=b",
    surface: "math-block",
    decision: "raw",
    ops: [],
    validation: { valid: false, errors: ["alignment math is deferred"] },
    notes: ["unsupported math environment"],
    downgradeReason: "alignment math is deferred",
  });
  assert.strictEqual(analysis.family, "alignment-structured");
  assert.ok(analysis.tokens?.some((entry) => entry.kind === "alignment-op" || entry.kind === "begin-env"));
}

testFixedArityRepairShadow();
testLeftRightUnsupportedShadow();
testAlignmentStructuredShadow();
console.log("math tail shadow tests passed");
