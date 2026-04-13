import assert from "node:assert";

import { extractMixedContentSegments, extractMixedContentSegmentsWithLookahead } from "../src/mixed-content";

function parseInline(): any[] {
  return [];
}

function summarize(segments: ReturnType<typeof extractMixedContentSegments>) {
  return segments.map((segment) => ({ kind: segment.kind, value: segment.value }));
}

function testMdxExpressionLookaheadDoesNotChangeTextLocalization() {
  const input = "Prefix {expr and trailing prose";
  const withoutLookahead = extractMixedContentSegments(input, 0, parseInline, {
    mdx: { autoClose: false, maxNewlines: 2, componentAllowlist: ["InlineChip"] },
  });
  const withLookahead = extractMixedContentSegmentsWithLookahead(input, 0, parseInline, {
    mdx: { autoClose: true, maxNewlines: 2, componentAllowlist: ["InlineChip"] },
  });

  assert.deepStrictEqual(
    summarize(withLookahead.segments),
    summarize(withoutLookahead),
    "mixed-content localization should remain stable while mdx-expression lookahead adds only trace metadata",
  );
  const expressionDecision = withLookahead.lookahead.find((entry) => entry.providerId === "mdx-expression-provider");
  assert.ok(expressionDecision, "expected explicit mdx-expression provider decision");
  assert.strictEqual(expressionDecision?.decision, "terminate");
}

testMdxExpressionLookaheadDoesNotChangeTextLocalization();
console.log("mixed-content provider ownership tests passed");
