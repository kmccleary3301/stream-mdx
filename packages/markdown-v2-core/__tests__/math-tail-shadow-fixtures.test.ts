import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { analyzeMathTailShadowReport } from "../src/streaming/math-tail-shadow";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/regression/fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function extractDisplayPrefix(source: string): string {
  const start = source.indexOf("$$");
  if (start === -1) throw new Error("missing display math opener");
  const end = source.indexOf("\n$$", start + 2);
  if (end !== -1) {
    return source.slice(start, end);
  }
  const fallbackEnd = source.indexOf("\n\n", start + 2);
  if (fallbackEnd === -1) throw new Error("missing display math boundary");
  return source.slice(start, fallbackEnd);
}

function extractInlinePrefix(source: string): string {
  const start = source.indexOf("$\\");
  if (start === -1) throw new Error("missing inline math opener");
  const end = source.indexOf("\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

function testLeftRightFixture() {
  const source = readFixture("math-left-right-null-right-supported.md");
  const raw = extractDisplayPrefix(source);
  const report = analyzeMathTailShadowReport({
    raw,
    surface: "math-block",
    decision: "repair",
    ops: [{ kind: "append", text: "\\right." }, { kind: "close-delimiter", text: "$$" }],
    validation: { valid: true },
    notes: ["tail-local \\right. completion", "close display math delimiter"],
  });
  assert.strictEqual(report.analysis.family, "left-right-local");
  assert.ok(report.candidates.some((entry) => entry.id === "null-right-candidate"));
  assert.strictEqual(report.preferredCandidateId, "repair-candidate");
}

function testDisplayLocalFixture() {
  const source = readFixture("math-display-local-multiline.md");
  const raw = extractDisplayPrefix(source);
  const report = analyzeMathTailShadowReport({
    raw,
    surface: "math-block",
    decision: "repair",
    candidateId: "checkpoint-candidate",
    ops: [{ kind: "insert-empty-group" }, { kind: "append", text: "}" }, { kind: "append", text: "\n" }, { kind: "close-delimiter", text: "$$" }],
    validation: { valid: true },
    notes: ["fill missing \\sqrt group", "close unmatched tail delimiters", "close display math delimiter"],
  });
  assert.ok(report.analysis.family === "display-local" || report.analysis.family === "fixed-arity-local");
  assert.ok(report.candidates.some((entry) => entry.id === "checkpoint-candidate"));
  assert.strictEqual(report.analysis.selectedCandidate, "checkpoint");
}

function testCheckpointVsRawFixture() {
  const source = readFixture("math-checkpoint-vs-raw.md");
  const inlineRaw = extractInlinePrefix(source);
  const displayRaw = extractDisplayPrefix(source.slice(source.indexOf("$$")));

  const inlineReport = analyzeMathTailShadowReport({
    raw: inlineRaw,
    surface: "math-inline",
    decision: "repair",
    ops: [{ kind: "insert-empty-group" }, { kind: "append", text: "}" }, { kind: "close-delimiter", text: "$" }],
    validation: { valid: true },
    notes: ["fill missing \\frac groups", "close unmatched tail delimiters", "close inline math delimiter"],
  });
  assert.strictEqual(inlineReport.analysis.family, "fixed-arity-local");
  assert.ok(inlineReport.candidates.some((entry) => entry.id === "checkpoint-candidate"));

  const displayReport = analyzeMathTailShadowReport({
    raw: displayRaw,
    surface: "math-block",
    decision: "raw",
    ops: [],
    validation: { valid: false, errors: ["math environments are deferred"] },
    notes: ["unsupported math environment"],
    downgradeReason: "math environments are deferred",
  });
  assert.strictEqual(displayReport.analysis.family, "environment-structured");
  assert.strictEqual(displayReport.preferredCandidateId, "raw-fallback");
}

function testAlignmentHardStopFixture() {
  const source = readFixture("math-alignment-hard-stop-negative.md");
  const raw = extractDisplayPrefix(source);
  const report = analyzeMathTailShadowReport({
    raw,
    surface: "math-block",
    decision: "raw",
    ops: [],
    validation: { valid: false, errors: ["alignment math is deferred"] },
    notes: ["unsupported math alignment family"],
    downgradeReason: "alignment math is deferred",
  });
  assert.strictEqual(report.analysis.family, "alignment-structured");
  assert.strictEqual(report.preferredCandidateId, "raw-fallback");
}

function testOptionalArgClassificationFixture() {
  const source = readFixture("math-optional-arg-classification.md");
  const raw = extractDisplayPrefix(source);
  const report = analyzeMathTailShadowReport({
    raw,
    surface: "math-block",
    decision: "raw",
    ops: [],
    validation: { valid: false, errors: ["optional argument math repair is deferred"] },
    notes: ["unsupported optional-argument ambiguity"],
    downgradeReason: "optional argument math repair is deferred",
  });
  assert.strictEqual(report.analysis.family, "optional-arg-local");
  assert.strictEqual(report.preferredCandidateId, "raw-fallback");
}

testLeftRightFixture();
testDisplayLocalFixture();
testCheckpointVsRawFixture();
testAlignmentHardStopFixture();
testOptionalArgClassificationFixture();
console.log("math tail shadow fixture tests passed");
