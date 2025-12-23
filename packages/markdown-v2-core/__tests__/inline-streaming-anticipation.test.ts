import assert from "node:assert";

import { prepareInlineStreamingContent } from "../src/streaming/inline-streaming";

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
}

function testMathBlockNewlineBoundary() {
  const display = prepareInlineStreamingContent("$$x\nmore", { formatAnticipation: { mathBlock: true }, math: true });
  assert.deepStrictEqual(display, { kind: "raw", status: "raw", reason: "incomplete-math" });
}

testWithoutAnticipation();
testWithAnticipation();
testComplete();
testMathAlwaysRaw();
testMathAnticipation();
testMathBlockNewlineBoundary();
console.log("inline streaming anticipation tests passed");
