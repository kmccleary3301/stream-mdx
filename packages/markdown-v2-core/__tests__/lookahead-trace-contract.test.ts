import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { createContainerSignature, prepareInlineStreamingLookahead, prepareSurfaceLookahead } from "../src/streaming/inline-streaming";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/regression/fixtures");

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
  assert.strictEqual(result.trace[0]?.analysis?.math?.family, "left-right-local");
  assert.strictEqual(result.trace[0]?.featureFamily, "math-left-right-local");
  assert.ok(result.trace[0]?.analysis?.math?.candidates?.some((entry) => entry.id === "null-right-candidate"));
}

function testMathBlockFixtureTrace() {
  const source = fs.readFileSync(path.join(FIXTURES_DIR, "math-left-right-trace.md"), "utf8");
  const raw = source.slice(source.indexOf("$$")).trimEnd();
  const result = prepareInlineStreamingLookahead(raw, {
    formatAnticipation: { mathBlock: true },
    math: true,
    context: baseContext,
  });
  assert.strictEqual(result.trace[0]?.decision, "raw");
  assert.strictEqual(result.trace[0]?.featureFamily, "math-left-right-local");
  assert.strictEqual(result.trace[0]?.analysis?.math?.selectedCandidate, "raw");
  assert.strictEqual(result.trace[0]?.analysis?.math?.comparison?.preferredCandidate, "raw-fallback");
}

function testMathDisplayCheckpointTrace() {
  const raw = "$$\na_n = \\frac{1}{n}\n+ \\sqrt{x";
  const result = prepareInlineStreamingLookahead(raw, {
    formatAnticipation: { mathBlock: true },
    math: true,
    context: baseContext,
  });
  assert.strictEqual(result.trace[0]?.surface, "math-block");
  assert.strictEqual(result.trace[0]?.decision, "repair");
  assert.strictEqual(result.trace[0]?.analysis?.math?.selectedCandidate, "checkpoint");
  assert.strictEqual(result.trace[0]?.analysis?.math?.comparison?.preferredCandidate, "checkpoint-candidate");
  assert.strictEqual(result.prepared.kind, "parse");
  if (result.prepared.kind === "parse") {
    assert.strictEqual(result.prepared.content, "$$\na_n = \\frac{1}{n}\n$$");
  }
}

function testStructuredMathTraceFamilies() {
  const environment = prepareInlineStreamingLookahead("$$\\begin{matrix}\na & b", {
    formatAnticipation: { mathBlock: true },
    math: true,
    context: baseContext,
  });
  assert.strictEqual(environment.trace[0]?.surface, "math-block");
  assert.strictEqual(environment.trace[0]?.decision, "raw");
  assert.strictEqual(environment.trace[0]?.featureFamily, "math-environment-structured");
  assert.strictEqual(environment.trace[0]?.analysis?.math?.family, "environment-structured");
  assert.strictEqual(environment.trace[0]?.downgrade?.mode, "raw");
  assert.strictEqual(environment.trace[0]?.termination?.reason, "unsupported-syntax");

  const alignment = prepareInlineStreamingLookahead("$$\\begin{align}\na &= b", {
    formatAnticipation: { mathBlock: true },
    math: true,
    context: baseContext,
  });
  assert.strictEqual(alignment.trace[0]?.surface, "math-block");
  assert.strictEqual(alignment.trace[0]?.decision, "raw");
  assert.strictEqual(alignment.trace[0]?.featureFamily, "math-alignment-structured");
  assert.strictEqual(alignment.trace[0]?.analysis?.math?.family, "alignment-structured");
  assert.strictEqual(alignment.trace[0]?.analysis?.math?.selectedCandidate, "raw");
  assert.strictEqual(alignment.trace[0]?.termination?.reason, "unsupported-syntax");
}

testInlineFormatTrace();
testRegexTrace();
testHtmlInlineTrace();
testMdxTagTrace();
testMdxExpressionTrace();
testMathInlineTrace();
testMathBlockTrace();
testMathBlockFixtureTrace();
testMathDisplayCheckpointTrace();
testStructuredMathTraceFamilies();
console.log("lookahead trace contract tests passed");
