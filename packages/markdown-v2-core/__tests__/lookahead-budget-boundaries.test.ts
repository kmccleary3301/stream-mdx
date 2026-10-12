import assert from "node:assert";

import { InlineParser } from "../src/inline-parser";
import { planInlineFormat, planRegexLookahead } from "../src/streaming/inline-format-policy";
import type { LookaheadBudgets, LookaheadRequest } from "../src/streaming/lookahead-contract";
import { planHtmlInline } from "../src/streaming/mixed-tag-policy";
import {
  buildLookaheadContainerContext,
  DEFAULT_LOOKAHEAD_BUDGETS,
  normalizeFormatAnticipation,
  prepareInlineStreamingLookahead,
  prepareSurfaceLookahead,
} from "../src/streaming/inline-streaming";

const anticipation = { inline: true, mathInline: true, mathBlock: true, regex: true };

function request(raw: string, budgets: Partial<LookaheadBudgets> = {}): LookaheadRequest {
  return {
    surface: "inline-format",
    raw,
    absoluteRange: { start: 0, end: raw.length },
    context: buildLookaheadContainerContext(),
    budgets: { ...DEFAULT_LOOKAHEAD_BUDGETS, maxProviderMs: Infinity, ...budgets },
  };
}

function testCharacterBoundary(): void {
  const atLimit = `*${"x".repeat(DEFAULT_LOOKAHEAD_BUDGETS.maxScanChars - 1)}`;
  const accepted = prepareInlineStreamingLookahead(atLimit, { formatAnticipation: anticipation });
  assert.strictEqual(accepted.prepared.kind, "parse");
  if (accepted.prepared.kind !== "parse") throw new Error("expected bounded emphasis preview");
  assert.strictEqual(accepted.prepared.content, `${atLimit}*`);
  assert.deepStrictEqual(new InlineParser({ maxCacheEntries: 0 }).parse(accepted.prepared.content, { cache: false }), [
    { kind: "em", children: [{ kind: "text", text: atLimit.slice(1) }] },
  ]);
  const exceeded = prepareInlineStreamingLookahead(`${atLimit}x`, { formatAnticipation: anticipation });
  assert.deepStrictEqual(exceeded.prepared, { kind: "raw", status: "raw", reason: "incomplete-formatting" });
  assert.strictEqual(exceeded.trace[0]?.termination?.reason, "budget-chars");
  assert.deepStrictEqual(exceeded.trace[0]?.ops, []);
}

function testCompleteContentIsNotCapped(): void {
  for (const raw of ["x".repeat(2048), `*${"x".repeat(2048)}*`, `$$${"x\n".repeat(10)}$$`]) {
    const result = prepareInlineStreamingLookahead(raw, { formatAnticipation: anticipation, context: { provisional: false } });
    assert.deepStrictEqual(result.prepared, { kind: "parse", status: "complete", content: raw, appended: "" });
  }
  const raw = `<kbd>${"x\n".repeat(1024)}</kbd>`;
  const html = prepareSurfaceLookahead("html-inline", raw, { allowTags: ["kbd"], context: { provisional: false } });
  assert.deepStrictEqual(html.prepared, { kind: "parse", status: "complete", content: raw });
  const mdxRaw = `<Chip>${"x\n".repeat(1024)}</Chip>`;
  assert.deepStrictEqual(prepareSurfaceLookahead("mdx-tag", mdxRaw, { allowComponents: ["Chip"], context: { provisional: false } }).prepared,
    { kind: "parse", status: "complete", content: mdxRaw });
  for (const complete of ["plain text", "*closed*", "$x$"]) {
    assert.deepStrictEqual(prepareInlineStreamingLookahead(complete, { formatAnticipation: anticipation }).prepared,
      { kind: "parse", status: "complete", content: complete, appended: "" });
  }
  for (const oversizedComplete of ["x".repeat(2048), `**${"x".repeat(2048)}**`]) {
    const result = prepareInlineStreamingLookahead(oversizedComplete, { formatAnticipation: anticipation });
    assert.deepStrictEqual(result.prepared, { kind: "raw", status: "raw", reason: "incomplete-formatting" });
    assert.deepStrictEqual(result.trace, [{
      providerId: "inline-format-provider", surface: "inline-format", decision: "raw", safety: "safe",
      featureFamily: "inline-core", contextSignature: result.container.containerSignature, ops: [], appended: "",
      validation: undefined, analysis: undefined,
      downgrade: { mode: "raw", reason: "lookahead budget-chars exhausted" },
      termination: { reason: "budget-chars", rearmWhen: "next-byte" },
      debug: { strategy: "raw-fallback", notes: ["lookahead budget-chars exhausted"] },
    }]);
  }
  for (const provisional of [false, true]) {
    assert.deepStrictEqual(prepareInlineStreamingLookahead("**unfinished $x", {
      formatAnticipation: anticipation, regexAppend: "}", context: { provisional },
    }).prepared, { kind: "parse", status: "anticipated", content: "**unfinished $x$**}", appended: "$**}" });
  }
  assert.deepStrictEqual(prepareSurfaceLookahead("html-inline", "<kbd>unfinished", {
    allowTags: ["kbd"], context: { provisional: false },
  }).prepared, { kind: "parse", status: "anticipated", content: "<kbd>unfinished</kbd>" });
  for (const provisional of [false, true]) {
    const result = prepareSurfaceLookahead("mdx-tag", '<InlineChip tone="warm">', {
      allowComponents: ["InlineChip"], context: { provisional },
    });
    assert.deepStrictEqual(result.prepared, {
      kind: "parse", status: "anticipated", content: '<InlineChip tone="warm"/>',
    });
    assert.strictEqual(result.trace[0]?.decision, "repair");
    assert.deepStrictEqual(result.trace[0]?.ops, [{ kind: "self-close-tag" }]);
  }
}

function testNewlineBoundary(): void {
  const accepted = prepareInlineStreamingLookahead("$$x\ny\nz", { formatAnticipation: anticipation });
  assert.strictEqual(accepted.prepared.kind, "parse");
  const exceeded = prepareInlineStreamingLookahead("$$x\ny\nz\nw", { formatAnticipation: anticipation });
  assert.strictEqual(exceeded.prepared.kind, "raw");
  assert.strictEqual(exceeded.trace[0]?.termination?.reason, "budget-newlines");
  for (const newline of ["\r", "\r\n", "\\\r"]) {
    const result = prepareInlineStreamingLookahead(`$$x${newline}y${newline}z${newline}w`, { formatAnticipation: anticipation });
    assert.strictEqual(result.prepared.kind, "raw");
    assert.strictEqual(result.trace[0]?.termination?.reason, "budget-newlines");
  }
}

function testSyntheticAndDepthLimits(): void {
  const atOpsLimit = prepareInlineStreamingLookahead(`$${"(".repeat(5)}x`, { formatAnticipation: anticipation });
  assert.strictEqual(atOpsLimit.prepared.kind, "parse");
  const excessOps = prepareInlineStreamingLookahead(`$${"(".repeat(6)}x`, { formatAnticipation: anticipation });
  assert.strictEqual(excessOps.prepared.kind, "raw");
  assert.strictEqual(excessOps.trace[0]?.termination?.reason, "budget-steps");
  const excessDepth = prepareInlineStreamingLookahead(`$${"(".repeat(9)}x`, { formatAnticipation: anticipation });
  assert.strictEqual(excessDepth.prepared.kind, "raw");
  assert.strictEqual(excessDepth.trace[0]?.termination?.reason, "budget-nesting");
  const combined = prepareInlineStreamingLookahead(`**$${"(".repeat(5)}x`, { formatAnticipation: anticipation });
  assert.strictEqual(combined.prepared.kind, "raw");
  assert.strictEqual(combined.trace[0]?.termination?.reason, "budget-steps");
}

function testMixedTagBudgetFallback(): void {
  for (const [surface, tag] of [["html-inline", "kbd"], ["mdx-tag", "Chip"]] as const) {
    const raw = `<${tag}>${"x".repeat(512)}`;
    const result = prepareSurfaceLookahead(surface, raw, { allowTags: [tag], allowComponents: [tag] });
    assert.deepStrictEqual(result.prepared, { kind: "raw", status: "raw", content: raw });
    assert.strictEqual(result.trace[0]?.termination?.reason, "budget-chars");
  }
  const raw = "<kbd>".repeat(9) + "x";
  const result = prepareSurfaceLookahead("html-inline", raw, { allowTags: ["kbd"] });
  assert.deepStrictEqual(result.prepared, { kind: "raw", status: "raw", content: raw });
  assert.strictEqual(result.trace[0]?.termination?.reason, "budget-nesting");
}

function testRegexBudgetFallback(): void {
  const result = prepareInlineStreamingLookahead("x".repeat(513), { formatAnticipation: anticipation, regexAppend: "}" });
  assert.deepStrictEqual(result.prepared, { kind: "raw", status: "raw", reason: "incomplete-formatting" });
  assert.strictEqual(result.trace[0]?.termination?.reason, "budget-chars");
  const resultWithExcessAppend = prepareInlineStreamingLookahead("ref", {
    formatAnticipation: anticipation, regexAppend: "x".repeat(513),
  });
  assert.strictEqual(resultWithExcessAppend.prepared.kind, "raw");
  assert.strictEqual(resultWithExcessAppend.trace[1]?.termination?.reason, "budget-chars");
  assert.strictEqual(planRegexLookahead("}", request("ref", { maxSyntheticOps: 0 }), []).terminationReason, "budget-steps");
}

function testDeterministicProviderLimits(): void {
  const normalized = normalizeFormatAnticipation(anticipation);
  assert.strictEqual(planInlineFormat(request("*x", { maxProviderMs: 0 }), normalized, true).terminationReason, "budget-steps");
  assert.strictEqual(planInlineFormat(request("$\\left(x", { maxValidationFailures: 0 }), normalized, true).terminationReason,
    "validation-failed");
  assert.strictEqual(planHtmlInline(request("<kbd>x", { maxSyntheticOps: 0 }), ["kbd"]).terminationReason, "budget-steps");
  // Complete content does not enter the speculative provider, even with a zero time budget.
  assert.strictEqual(planInlineFormat(request("*x*", { maxProviderMs: 0 }), normalized, true).decision,
    "accept-as-is");
}

function testOversizedMalformedCandidates(): void {
  for (const [surface, raw] of [
    ["html-inline", `<kbd ${"x".repeat(100_000)}`],
    ["mdx-tag", `<Chip ${"x".repeat(100_000)}`],
    ["mdx-expression", `{${"x".repeat(100_000)}`],
  ] as const) {
    const result = prepareSurfaceLookahead(surface, raw, { allowTags: ["kbd"], allowComponents: ["Chip"] });
    assert.deepStrictEqual(result.prepared, { kind: "raw", content: raw, status: "raw" });
    assert.strictEqual(result.trace[0]?.termination?.reason, "budget-chars");
  }
  const raw = `**${"x".repeat(100_000)}`;
  const result = prepareInlineStreamingLookahead(raw, { formatAnticipation: anticipation });
  assert.strictEqual(result.prepared.kind, "raw");
  assert.strictEqual(result.trace[0]?.termination?.reason, "budget-chars");
}

testCharacterBoundary();
testCompleteContentIsNotCapped();
testNewlineBoundary();
testSyntheticAndDepthLimits();
testMixedTagBudgetFallback();
testRegexBudgetFallback();
testDeterministicProviderLimits();
testOversizedMalformedCandidates();
console.log("lookahead-budget-boundaries tests passed");
