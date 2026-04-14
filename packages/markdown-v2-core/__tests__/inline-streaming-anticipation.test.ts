import assert from "node:assert";

import { prepareInlineStreamingContent, prepareInlineStreamingLookahead } from "../src/streaming/inline-streaming";

function testWithoutAnticipation() {
  const italic = prepareInlineStreamingContent("*This is incomplete", { formatAnticipation: false });
  assert.deepStrictEqual(italic, { kind: "raw", status: "raw", reason: "incomplete-formatting" });
}

function testWithAnticipation() {
  const italic = prepareInlineStreamingContent("*This is incomplete", { formatAnticipation: true });
  assert.strictEqual(italic.kind, "parse");
  if (italic.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(italic.status, "anticipated");
  assert.strictEqual(italic.appended, "*");
  assert.strictEqual(italic.content, "*This is incomplete*");

  const bold = prepareInlineStreamingContent("**This is incomplete", { formatAnticipation: true });
  assert.strictEqual(bold.kind, "parse");
  if (bold.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(bold.appended, "**");
  assert.strictEqual(bold.content, "**This is incomplete**");

  const code = prepareInlineStreamingContent("`code", { formatAnticipation: true });
  assert.strictEqual(code.kind, "parse");
  if (code.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(code.appended, "`");
  assert.strictEqual(code.content, "`code`");

  const strike = prepareInlineStreamingContent("~~strike", { formatAnticipation: true });
  assert.strictEqual(strike.kind, "parse");
  if (strike.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(strike.appended, "~~");
  assert.strictEqual(strike.content, "~~strike~~");
}

function testComplete() {
  const result = prepareInlineStreamingContent("*done*", { formatAnticipation: true });
  assert.strictEqual(result.kind, "parse");
  if (result.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(result.status, "complete");
  assert.strictEqual(result.appended, "");
  assert.strictEqual(result.content, "*done*");
}

function testMathAlwaysRaw() {
  const result = prepareInlineStreamingContent("$x", { formatAnticipation: true });
  assert.deepStrictEqual(result, { kind: "raw", status: "raw", reason: "incomplete-math" });
}

function testMathAnticipation() {
  const inline = prepareInlineStreamingContent("$x", { formatAnticipation: { mathInline: true }, math: true });
  assert.strictEqual(inline.kind, "parse");
  if (inline.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(inline.status, "anticipated");
  assert.strictEqual(inline.appended, "$");
  assert.strictEqual(inline.content, "$x$");

  const display = prepareInlineStreamingContent("$$x", { formatAnticipation: { mathBlock: true }, math: true });
  assert.strictEqual(display.kind, "parse");
  if (display.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(display.status, "anticipated");
  assert.strictEqual(display.appended, "$$");
  assert.strictEqual(display.content, "$$x$$");

  const trimmedControlWord = prepareInlineStreamingContent("$x + \\gam", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(trimmedControlWord.kind, "parse");
  if (trimmedControlWord.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(trimmedControlWord.content, "$x + $");

  const danglingScript = prepareInlineStreamingContent("$x^", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(danglingScript.kind, "parse");
  if (danglingScript.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(danglingScript.content, "$x^{}$");

  const fracRepair = prepareInlineStreamingContent("$\\frac{a", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(fracRepair.kind, "parse");
  if (fracRepair.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(fracRepair.content, "$\\frac{a{}}$");

  const sqrtRepair = prepareInlineStreamingContent("$\\sqrt{x", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(sqrtRepair.kind, "parse");
  if (sqrtRepair.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(sqrtRepair.content, "$\\sqrt{x}$");
}

function testCurrencyLikeDollarDoesNotAnticipateMath() {
  const currency = prepareInlineStreamingContent("Bridgewater | $150 billion |", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(currency.kind, "parse");
  if (currency.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(currency.status, "complete");
  assert.strictEqual(currency.appended, "");
  assert.strictEqual(currency.content, "Bridgewater | $150 billion |");
}

function testMathBlockNewlineBoundary() {
  const display = prepareInlineStreamingContent("$$x\nmore", { formatAnticipation: { mathBlock: true }, math: true });
  assert.strictEqual(display.kind, "parse");
  if (display.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(display.status, "anticipated");
  assert.strictEqual(display.appended, "\n$$");
  assert.strictEqual(display.content, "$$x\nmore\n$$");
}

function testMathDisplayAnticipation() {
  const display = prepareInlineStreamingContent("$$\\frac{a", {
    formatAnticipation: { mathBlock: true },
    math: true,
  });
  assert.strictEqual(display.kind, "parse");
  if (display.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(display.status, "anticipated");
  assert.strictEqual(display.content, "$$\\frac{a{}}$$");

  const displayTrace = prepareInlineStreamingLookahead("$$\\sqrt{x", {
    formatAnticipation: { mathBlock: true },
    math: true,
  });
  assert.strictEqual(displayTrace.trace[0]?.surface, "math-block");
  assert.strictEqual(displayTrace.trace[0]?.validation?.valid, true);
}

function testUnsupportedMathRemainsRaw() {
  const supportedLeftRight = prepareInlineStreamingContent("$\\left(x + y", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(supportedLeftRight.kind, "parse");
  if (supportedLeftRight.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(supportedLeftRight.content, "$\\left(x + y)\\right.$");

  const unsupportedEnvironment = prepareInlineStreamingContent("$$\\begin{align}\nx", {
    formatAnticipation: { mathBlock: true },
    math: true,
  });
  assert.deepStrictEqual(unsupportedEnvironment, { kind: "raw", status: "raw", reason: "incomplete-math" });

  const supportedDisplayLeftRight = prepareInlineStreamingContent("$$\\left(x + y", {
    formatAnticipation: { mathBlock: true },
    math: true,
  });
  assert.strictEqual(supportedDisplayLeftRight.kind, "parse");
  if (supportedDisplayLeftRight.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(supportedDisplayLeftRight.content, "$$\\left(x + y)\\right.$$");

  const nestedUnsupportedLeftRight = prepareInlineStreamingContent("$$\\left( \\frac{\\left[a+b}{c}", {
    formatAnticipation: { mathBlock: true },
    math: true,
  });
  assert.deepStrictEqual(nestedUnsupportedLeftRight, { kind: "raw", status: "raw", reason: "incomplete-math" });
}

function testMathValidationTrace() {
  const result = prepareInlineStreamingLookahead("$\\frac{a", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(result.trace[0]?.surface, "math-inline");
  assert.strictEqual(result.trace[0]?.validation?.valid, true);

  const unsupported = prepareInlineStreamingLookahead("$\\left(x + y", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(unsupported.trace[0]?.surface, "math-inline");
  assert.strictEqual(unsupported.trace[0]?.validation?.valid, true);
  assert.strictEqual(unsupported.trace[0]?.decision, "repair");
  assert.strictEqual(unsupported.trace[0]?.featureFamily, "math-left-right-local");
}

function testMathConvergenceBehavior() {
  const anticipated = prepareInlineStreamingContent("$\\frac{a", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(anticipated.kind, "parse");
  if (anticipated.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(anticipated.status, "anticipated");
  assert.strictEqual(anticipated.content, "$\\frac{a{}}$");

  const completed = prepareInlineStreamingContent("$\\frac{a}{b}$", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(completed.kind, "parse");
  if (completed.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(completed.status, "complete");
  assert.strictEqual(completed.content, "$\\frac{a}{b}$");

  const leftRightPrefix = prepareInlineStreamingContent("$\\left(x + y", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(leftRightPrefix.kind, "parse");
  if (leftRightPrefix.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(leftRightPrefix.content, "$\\left(x + y)\\right.$");

  const supportedFinal = prepareInlineStreamingContent("$\\left(x + y\\right)$", {
    formatAnticipation: { mathInline: true },
    math: true,
  });
  assert.strictEqual(supportedFinal.kind, "parse");
  if (supportedFinal.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(supportedFinal.status, "complete");
  assert.strictEqual(supportedFinal.content, "$\\left(x + y\\right)$");
}

testWithoutAnticipation();
testWithAnticipation();
testComplete();
testMathAlwaysRaw();
testMathAnticipation();
testCurrencyLikeDollarDoesNotAnticipateMath();
testMathBlockNewlineBoundary();
testMathDisplayAnticipation();
testUnsupportedMathRemainsRaw();
testMathValidationTrace();
testMathConvergenceBehavior();
console.log("inline streaming anticipation tests passed");
