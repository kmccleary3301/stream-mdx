import assert from "node:assert";

import { prepareInlineStreamingLookahead } from "../src/streaming/inline-streaming";

type MathCase = {
  name: string;
  raw: string;
  mode: "mathInline" | "mathBlock";
  expectedFamily:
    | "fixed-arity-local"
    | "left-right-local"
    | "display-local"
    | "environment-structured";
  acceptedFamilies?: readonly (
    | "fixed-arity-local"
    | "left-right-local"
    | "display-local"
    | "environment-structured"
  )[];
  expectedSelected: "repaired" | "checkpoint" | "raw";
};

const cases: MathCase[] = [
  {
    name: "fixed-arity local inline frac",
    raw: "$\\frac{a",
    mode: "mathInline",
    expectedFamily: "fixed-arity-local",
    expectedSelected: "repaired",
  },
  {
    name: "left-right local null-right",
    raw: "$$\\left(x + y",
    mode: "mathBlock",
    expectedFamily: "left-right-local",
    expectedSelected: "raw",
  },
  {
    name: "display-local checkpoint",
    raw: "$$\na_n = \\frac{1}{n}\n+ \\sqrt{x",
    mode: "mathBlock",
    expectedFamily: "display-local",
    acceptedFamilies: ["display-local", "fixed-arity-local"],
    expectedSelected: "checkpoint",
  },
  {
    name: "environment hard-stop",
    raw: "$$\\begin{matrix}\na & b",
    mode: "mathBlock",
    expectedFamily: "environment-structured",
    expectedSelected: "raw",
  },
];

for (const testCase of cases) {
  const result = prepareInlineStreamingLookahead(testCase.raw, {
    formatAnticipation: { [testCase.mode]: true },
    math: true,
  });
  const analysis = result.trace[0]?.analysis?.math;
  assert.ok(analysis, `${testCase.name}: missing math analysis`);
  if (testCase.acceptedFamilies) {
    assert.ok(testCase.acceptedFamilies.includes(analysis?.family as MathCase["expectedFamily"]), `${testCase.name}: wrong family`);
  } else {
    assert.strictEqual(analysis?.family, testCase.expectedFamily, `${testCase.name}: wrong family`);
  }
  assert.strictEqual(analysis?.selectedCandidate, testCase.expectedSelected, `${testCase.name}: wrong selected candidate`);
  assert.strictEqual(analysis?.comparison?.differsFromLive, false, `${testCase.name}: live/shadow divergence`);
}

console.log("math live/shadow parity tests passed");
