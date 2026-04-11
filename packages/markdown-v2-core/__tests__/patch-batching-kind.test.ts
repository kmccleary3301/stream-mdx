import assert from "node:assert";

import type { Patch } from "../src/types";
import { getPatchKind, splitPatchBatch } from "../src/perf/patch-batching";

function testSemanticDefaultClassification(): void {
  const patches: Patch[] = [
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
      op: "appendLines",
      at: { blockId: "code-1", nodeId: "code-1" },
      startIndex: 0,
      lines: ["const x = 1;"],
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

function testSemanticBatchesDoNotMixWithEnrichment(): void {
  const patches: Patch[] = [
    {
      op: "setProps",
      at: { blockId: "p-1", nodeId: "p-1" },
      props: { text: "semantic-a" },
    },
    {
      op: "setProps",
      at: { blockId: "code-1", nodeId: "code-1" },
      props: { highlightedHtml: "<pre><code>a</code></pre>" },
      meta: { kind: "enrichment" },
    },
    {
      op: "setProps",
      at: { blockId: "p-2", nodeId: "p-2" },
      props: { text: "semantic-b" },
    },
  ];

  const groups = splitPatchBatch(patches, 32);
  assert.strictEqual(groups.length, 3, "semantic patches should flush as atomic units around enrichment work");
  assert.strictEqual(getPatchKind(groups[1]?.[0] as Patch), "enrichment");
}

function testConsecutiveSemanticPatchesStayAtomic(): void {
  const patches: Patch[] = [
    {
      op: "setProps",
      at: { blockId: "list-1", nodeId: "list-1" },
      props: { ordered: true },
      meta: { kind: "semantic", tx: 20, parseEpoch: 20, blockEpoch: 19 },
    },
    {
      op: "insertChild",
      at: { blockId: "list-1", nodeId: "list-1" },
      index: 1,
      node: { id: "list-1::item:1", type: "list-item" },
      meta: { kind: "semantic", tx: 20, parseEpoch: 20, blockEpoch: 19 },
    },
  ];

  const groups = splitPatchBatch(patches, 32);
  assert.strictEqual(groups.length, 1, "consecutive semantic patches from one tx must stay in one atomic batch");
  assert.strictEqual(groups[0]?.length, 2, "semantic batch should preserve both patches together");
}

testSemanticDefaultClassification();
testExplicitEnrichmentClassification();
testSemanticBatchesDoNotMixWithEnrichment();
testConsecutiveSemanticPatchesStayAtomic();
console.log("patch-batching-kind test passed");
