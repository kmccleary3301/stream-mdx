import assert from "node:assert";

import { createContainerSignature, prepareInlineStreamingLookahead } from "../src/streaming/inline-streaming";

function testInlineProviderRepairPlan() {
  const result = prepareInlineStreamingLookahead("*hello", {
    formatAnticipation: true,
    context: {
      blockType: "paragraph",
      ancestorTypes: [],
      containerSignature: createContainerSignature({
        blockType: "paragraph",
        ancestorTypes: [],
        localTextField: "raw",
      }),
    },
  });

  assert.strictEqual(result.prepared.kind, "parse");
  if (result.prepared.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(result.prepared.content, "*hello*");
  assert.strictEqual(result.trace.length, 1);
  assert.strictEqual(result.trace[0]?.providerId, "inline-format-provider");
  assert.strictEqual(result.trace[0]?.decision, "repair");
  assert.deepStrictEqual(result.trace[0]?.ops, [{ kind: "close-delimiter", text: "*" }]);
  assert.ok(result.trace[0]?.contextSignature);
}

function testRegexProviderRepairPlan() {
  const result = prepareInlineStreamingLookahead("Ref {cite:5", {
    formatAnticipation: { regex: true },
    regexAppend: "}",
    context: {
      blockType: "paragraph",
      ancestorTypes: [],
      containerSignature: createContainerSignature({
        blockType: "paragraph",
        ancestorTypes: [],
        localTextField: "raw",
      }),
    },
  });

  assert.strictEqual(result.prepared.kind, "parse");
  if (result.prepared.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(result.prepared.content, "Ref {cite:5}");
  assert.strictEqual(result.trace.length, 2);
  assert.strictEqual(result.trace[1]?.providerId, "regex-provider");
  assert.strictEqual(result.trace[1]?.decision, "repair");
  assert.deepStrictEqual(result.trace[1]?.ops, [{ kind: "append", text: "}" }]);
}

function testProviderDoesNotInventRegexRepairWithoutMatch() {
  const result = prepareInlineStreamingLookahead("Ref {cite:5}", {
    formatAnticipation: { regex: true },
    regexAppend: null,
  });

  assert.strictEqual(result.prepared.kind, "parse");
  if (result.prepared.kind !== "parse") throw new Error("expected parse result");
  assert.strictEqual(result.prepared.content, "Ref {cite:5}");
  assert.strictEqual(result.trace[1]?.providerId, "regex-provider");
  assert.strictEqual(result.trace[1]?.decision, "accept-as-is");
  assert.deepStrictEqual(result.trace[1]?.ops, []);
}

function testContainerSignatureShape() {
  const signature = createContainerSignature({
    blockType: "list-item",
    ancestorTypes: ["list", "list-item"],
    listDepth: 2,
    blockquoteDepth: 1,
    insideHtml: false,
    insideMdx: true,
    segmentOrigin: "mixed-content",
    mixedSegmentKind: "mdx",
    provisional: true,
    localTextField: "list-item-paragraph",
  });

  assert.strictEqual(
    signature,
    "list-item|list>list-item|l2|bq1|html0|mdx1|mixed-content|mdx|p1|list-item-paragraph",
  );
}

testInlineProviderRepairPlan();
testRegexProviderRepairPlan();
testProviderDoesNotInventRegexRepairWithoutMatch();
testContainerSignatureShape();
console.log("lookahead orchestrator tests passed");
