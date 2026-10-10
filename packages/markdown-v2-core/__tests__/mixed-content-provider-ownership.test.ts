import assert from "node:assert";
import { parser as nativeParser } from "@lezer/markdown";

import { InlineParser } from "../src/inline-parser";
import type { ProtectedRange } from "../src/types";

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

function testNativeCodeRangesOwnExpressions() {
  const inlineParser = new InlineParser();
  for (const [code, expected] of [
    ["`{:js}{:js}`", "{:js}{:js}"],
    ["`` {:js} `literal` {:js} ``", "{:js} `literal` {:js}"],
    ["`` `<InlineChip />` {inside} ``", "`<InlineChip />` {inside}"],
    ["`line\n{:js}`", "line {:js}"],
  ]) {
    const input = `Prefix <em>HTML</em> ${code} suffix {outside} <InlineChip /> end`;
    const baseOffset = 73;
    const protectedRanges: ProtectedRange[] = [];
    const cursor = nativeParser.parse(input).cursor();
    do {
      if (cursor.name === "InlineCode") {
        protectedRanges.push({ from: baseOffset + cursor.from, to: baseOffset + cursor.to, kind: "code-inline" });
      }
    } while (cursor.next());
    const segments = extractMixedContentSegments(input, baseOffset, (value) => inlineParser.parse(value), { protectedRanges });
    assert.deepStrictEqual(segments.filter((segment) => segment.kind === "mdx").map((segment) => segment.value), ["{outside}", "<InlineChip />"]);
    assert.strictEqual(segments.find((segment) => segment.kind === "html")?.value, "<em>HTML</em>");
    const text = segments.filter((segment) => segment.kind === "text");
    assert.deepStrictEqual(text.flatMap((segment) => segment.inline ?? []).filter((node) => node.kind === "code"), [{ kind: "code", text: expected }]);
    assert.strictEqual(text.map((segment) => segment.value).join(""), `Prefix  ${code} suffix   end`);
    assert.deepStrictEqual(segments.find((segment) => segment.value === "{outside}")?.range, {
      from: baseOffset + input.indexOf("{outside}"),
      to: baseOffset + input.indexOf("{outside}") + "{outside}".length,
    });
    const localSegments = extractMixedContentSegments(input, undefined, (value) => inlineParser.parse(value), {
      protectedRanges: protectedRanges.map((range) => ({ ...range, from: range.from - baseOffset, to: range.to - baseOffset })),
    });
    assert.deepStrictEqual(summarize(localSegments), summarize(segments));
    assert.ok(localSegments.every((segment) => !("range" in segment)), "local protection must not expose synthetic document ranges");
  }
  const input = "Inline code with language hint: `{:js}{:js}`.";
  const from = input.indexOf("`");
  const segments = extractMixedContentSegments(input, 0, (value) => inlineParser.parse(value), {
    protectedRanges: [{ from, to: input.lastIndexOf("`") + 1, kind: "code-inline" }],
  });
  assert.deepStrictEqual(summarize(segments), [{ kind: "text", value: input }]);
  assert.deepStrictEqual(segments[0].inline, [
    { kind: "text", text: "Inline code with language hint: " },
    { kind: "code", text: "{:js}{:js}" },
    { kind: "text", text: "." },
  ]);
}

testNativeCodeRangesOwnExpressions();
testMdxExpressionLookaheadDoesNotChangeTextLocalization();
console.log("mixed-content provider ownership tests passed");
