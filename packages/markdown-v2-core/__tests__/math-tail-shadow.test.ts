import assert from "node:assert";

import { analyzeMathTailShadow, analyzeMathTailShadowReport } from "../src/streaming/math-tail-shadow";

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
  const report = analyzeMathTailShadowReport({
    raw: "$$\\left(x + y",
    surface: "math-block",
    decision: "raw",
    ops: [],
    validation: { valid: false, errors: ["left-right math repair is deferred"] },
    notes: ["unsupported \\left/\\right pair"],
    downgradeReason: "left-right math repair is deferred",
  });
  const analysis = report.analysis;
  assert.strictEqual(analysis.family, "left-right-local");
  assert.strictEqual(analysis.unsupportedReason, "left-right math repair is deferred");
  assert.strictEqual(analysis.selectedCandidate, "raw");
  assert.ok(report.candidates.some((entry) => entry.id === "null-right-candidate"));
  assert.strictEqual(report.preferredCandidateId, "raw-fallback");
}

function testLeftRightSupportedShadow() {
  const report = analyzeMathTailShadowReport({
    raw: "$$\\left(x + y",
    surface: "math-block",
    decision: "repair",
    ops: [{ kind: "append", text: "\\right." }, { kind: "close-delimiter", text: "$$" }],
    validation: { valid: true },
    notes: ["tail-local \\right. completion", "close display math delimiter"],
  });
  assert.strictEqual(report.analysis.family, "left-right-local");
  assert.strictEqual(report.analysis.unsupportedReason, undefined);
  assert.strictEqual(report.preferredCandidateId, "repair-candidate");
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

function testDisplayCheckpointCandidate() {
  const report = analyzeMathTailShadowReport({
    raw: "$$\na_n = \\frac{1}{n}\n+ \\sqrt{x\n$$",
    surface: "math-block",
    decision: "repair",
    candidateId: "checkpoint-candidate",
    ops: [{ kind: "insert-empty-group" }, { kind: "append", text: "}" }, { kind: "append", text: "\n" }, { kind: "close-delimiter", text: "$$" }],
    validation: { valid: true },
    notes: ["fill missing \\sqrt group", "close unmatched tail delimiters", "close display math delimiter"],
  });
  assert.ok(report.candidates.some((entry) => entry.id === "checkpoint-candidate"));
  assert.ok(report.analysis.comparison);
  assert.strictEqual(report.analysis.selectedCandidate, "checkpoint");
  assert.strictEqual(report.analysis.comparison?.differsFromLive, false);
}

testFixedArityRepairShadow();
testLeftRightUnsupportedShadow();
testLeftRightSupportedShadow();
testAlignmentStructuredShadow();
testDisplayCheckpointCandidate();
console.log("math tail shadow tests passed");
