import assert from "node:assert";

import { createContainerSignature, prepareInlineStreamingLookahead, prepareSurfaceLookahead } from "../src/streaming/inline-streaming";

const baseContext = {
  blockType: "paragraph",
  ancestorTypes: [],
  containerSignature: createContainerSignature({
    blockType: "paragraph",
    ancestorTypes: [],
    localTextField: "raw",
  }),
};

function testInlineFormatTrace() {
  const result = prepareInlineStreamingLookahead("*hello", {
    formatAnticipation: true,
    context: baseContext,
  });
  assert.strictEqual(result.trace[0]?.providerId, "inline-format-provider");
  assert.strictEqual(result.trace[0]?.surface, "inline-format");
  assert.strictEqual(result.trace[0]?.decision, "repair");
  assert.strictEqual(result.trace[0]?.featureFamily, "inline-core");
}

function testRegexTrace() {
  const result = prepareInlineStreamingLookahead("Ref {cite:5", {
    formatAnticipation: { regex: true },
    regexAppend: "}",
    context: baseContext,
  });
  const trace = result.trace.find((entry) => entry.providerId === "regex-provider");
  assert.ok(trace);
  assert.strictEqual(trace?.surface, "regex");
  assert.strictEqual(trace?.decision, "repair");
  assert.strictEqual(trace?.featureFamily, "regex-core");
}

function testHtmlInlineTrace() {
  const result = prepareSurfaceLookahead("html-inline", "<kbd>code", {
    allowTags: ["kbd"],
    context: {
      ...baseContext,
      insideHtml: true,
      segmentOrigin: "mixed-content",
      mixedSegmentKind: "html",
    },
  });
  assert.strictEqual(result.trace[0]?.providerId, "html-inline-provider");
  assert.strictEqual(result.trace[0]?.surface, "html-inline");
  assert.strictEqual(result.trace[0]?.decision, "repair");
  assert.strictEqual(result.trace[0]?.featureFamily, "html-inline-allowlist");
}

function testMdxTagTrace() {
  const result = prepareSurfaceLookahead("mdx-tag", "<InlineChip tone=\"warm\">", {
    allowComponents: ["InlineChip"],
    context: {
      ...baseContext,
      insideMdx: true,
      segmentOrigin: "mixed-content",
      mixedSegmentKind: "mdx",
    },
  });
  assert.strictEqual(result.trace[0]?.providerId, "mdx-tag-provider");
  assert.strictEqual(result.trace[0]?.surface, "mdx-tag");
  assert.strictEqual(result.trace[0]?.decision, "repair");
  assert.strictEqual(result.trace[0]?.featureFamily, "mdx-tag-shell");
}

function testMdxExpressionTrace() {
  const result = prepareSurfaceLookahead("mdx-expression", "{expr", {
    context: {
      ...baseContext,
      insideMdx: true,
      segmentOrigin: "mixed-content",
      mixedSegmentKind: "mdx",
    },
  });
  assert.strictEqual(result.trace[0]?.providerId, "mdx-expression-provider");
  assert.strictEqual(result.trace[0]?.surface, "mdx-expression");
  assert.strictEqual(result.trace[0]?.decision, "terminate");
  assert.strictEqual(result.trace[0]?.termination?.reason, "unsupported-syntax");
  assert.strictEqual(result.trace[0]?.featureFamily, "mdx-expression-conservative");
}

function testMathInlineTrace() {
  const result = prepareInlineStreamingLookahead("$\\frac{a", {
    formatAnticipation: { mathInline: true },
    math: true,
    context: baseContext,
  });
  assert.strictEqual(result.trace[0]?.surface, "math-inline");
  assert.strictEqual(result.trace[0]?.decision, "repair");
  assert.strictEqual(result.trace[0]?.validation?.valid, true);
  assert.ok(result.trace[0]?.analysis?.math);
  assert.strictEqual(result.trace[0]?.analysis?.math?.family, "fixed-arity-local");
  assert.strictEqual(result.trace[0]?.featureFamily, "math-fixed-arity-local");
}

function testMathBlockTrace() {
  const result = prepareInlineStreamingLookahead("$$\\left(x + y", {
    formatAnticipation: { mathBlock: true },
    math: true,
    context: baseContext,
  });
  assert.strictEqual(result.trace[0]?.surface, "math-block");
  assert.strictEqual(result.trace[0]?.decision, "raw");
  assert.strictEqual(result.trace[0]?.validation?.valid, false);
  assert.strictEqual(result.trace[0]?.termination?.reason, "unsupported-syntax");
  assert.strictEqual(result.trace[0]?.analysis?.math?.family, "left-right-local");
  assert.strictEqual(result.trace[0]?.featureFamily, "math-left-right-local");
}

testInlineFormatTrace();
testRegexTrace();
testHtmlInlineTrace();
testMdxTagTrace();
testMdxExpressionTrace();
testMathInlineTrace();
testMathBlockTrace();
console.log("lookahead trace contract tests passed");
