import assert from "node:assert";

import type { Patch } from "../src/types";
import { getPatchKind } from "../src/perf/patch-batching";

function testSemanticDefaultClassification(): void {
  const patches: Patch[] = [
    {
      op: "appendInputSource",
      at: { blockId: "__root__" },
      generation: 1,
      from: 0,
      text: "x",
    },
    {
      op: "insertChild",
      at: { blockId: "list-1" },
      index: 0,
      node: { id: "item-1", type: "list-item" },
    },
    {
      op: "setProps",
      at: { blockId: "p-1", nodeId: "p-1" },
      props: { text: "hello" },
    },
    {
      op: "deleteChild",
      at: { blockId: "list-1", nodeId: "list-1" },
      index: 0,
    },
    {
      op: "replaceChild",
      at: { blockId: "list-1", nodeId: "list-1" },
      index: 0,
      node: { id: "item-2", type: "list-item" },
    },
    {
      op: "finalize",
      at: { blockId: "paragraph-1", nodeId: "paragraph-1" },
    },
    {
      op: "reorder",
      at: { blockId: "list-1", nodeId: "list-1" },
      from: 0,
      to: 1,
      count: 1,
    },
    {
      op: "setPropsBatch",
      entries: [
        {
          at: { blockId: "p-1", nodeId: "p-1" },
          props: { text: "batched semantic" },
        },
      ],
    },
    {
      op: "setHTML",
      at: { blockId: "html-1", nodeId: "html-1" },
      html: "<div>semantic html</div>",
    },
  ];

  for (const patch of patches) {
    assert.strictEqual(getPatchKind(patch), "semantic", `expected ${patch.op} to default to semantic`);
  }
}

function testExplicitEnrichmentClassification(): void {
  const semanticPatch: Patch = {
    op: "setProps",
    at: { blockId: "code-1", nodeId: "code-1" },
    props: { block: { id: "code-1", type: "code", isFinalized: true, payload: { raw: "```js\nx\n```" } } },
  };
  const enrichmentPatch: Patch = {
    op: "setProps",
    at: { blockId: "code-1", nodeId: "code-1" },
    props: { highlightedHtml: "<pre><code><span>x</span></code></pre>" },
    meta: { kind: "enrichment" },
  };
  const enrichmentBatch: Patch = {
    op: "setPropsBatch",
    entries: [
      {
        at: { blockId: "code-1", nodeId: "code-1" },
        props: { highlightedHtml: "<pre><code><span>a</span></code></pre>" },
      },
    ],
    meta: { kind: "enrichment" },
  };
  const reservedHtmlEnrichment: Patch = {
    op: "setHTML",
    at: { blockId: "html-1", nodeId: "html-1" },
    html: "<div>decorated</div>",
    patchMeta: { kind: "enrichment" },
  };

  assert.strictEqual(getPatchKind(semanticPatch), "semantic");
  assert.strictEqual(getPatchKind(enrichmentPatch), "enrichment");
  assert.strictEqual(getPatchKind(enrichmentBatch), "enrichment");
  assert.strictEqual(getPatchKind(reservedHtmlEnrichment), "enrichment");
}


function testParagraphOperationsStaySemantic(): void {
  const paragraph = {
    paragraphOwnerId: "paragraph-1",
    generation: 1,
    revision: 2,
    state: "open" as const,
    processedTo: 0,
    completeSpanCount: 0,
    spanCount: 0,
    sourceRange: { from: 0, to: 0 },
  };
  const append: Patch = {
    op: "appendParagraph",
    at: { blockId: "paragraph-1" },
    paragraphOwnerId: "paragraph-1",
    generation: 1,
    expectedRevision: 1,
    revision: 2,
    sourceAppend: "",
    fromSpan: 0,
    spans: [],
    paragraph,
    meta: { kind: "enrichment" },
  };
  const update: Patch = {
    op: "updateParagraphSpans",
    at: { blockId: "paragraph-1" },
    paragraphOwnerId: "paragraph-1",
    generation: 1,
    expectedRevision: 1,
    revision: 2,
    updates: [],
    paragraph,
    meta: { kind: "enrichment" },
  };

  assert.strictEqual(getPatchKind(append), "semantic");
  assert.strictEqual(getPatchKind(update), "semantic");

}

testParagraphOperationsStaySemantic();

testSemanticDefaultClassification();
testExplicitEnrichmentClassification();
console.log("patch-batching-kind test passed");
