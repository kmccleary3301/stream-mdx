import assert from "node:assert";

import type { Block } from "@stream-mdx/core";

import { PatchCommitScheduler, type PatchFlushResult } from "../src/renderer/patch-commit-scheduler";
import { createRendererStore } from "../src/renderer/store";

function createParagraphBlock(id: string, text: string): Block {
  return {
    id,
    type: "paragraph",
    isFinalized: true,
    payload: {
      raw: text,
      inline: [{ kind: "text", text }],
      meta: {},
    },
  };
}

async function main() {
  const blockId = "paragraph-1";
  const store = createRendererStore([createParagraphBlock(blockId, "initial")]);
  const flushes: PatchFlushResult[] = [];
  let tick = 0;

  const scheduler = new PatchCommitScheduler({
    store,
    onFlush: (result) => {
      flushes.push(result);
    },
    options: {
      raf: null,
      cancelRaf: null,
      batch: "microtask",
      frameBudgetMs: 1,
      maxBatchesPerFlush: 1,
      lowPriorityFrameBudgetMs: 1,
      maxLowPriorityBatchesPerFlush: 1,
      timeoutMs: 0,
      now: () => {
        tick += 1;
        return tick;
      },
    },
  });

  scheduler.enqueue({
    patches: [
      {
        op: "setProps",
        at: { blockId, nodeId: blockId },
        props: { block: createParagraphBlock(blockId, "semantic-one") },
      },
    ],
  });
  scheduler.enqueue({
    patches: [
      {
        op: "setProps",
        at: { blockId, nodeId: blockId },
        props: { block: createParagraphBlock(blockId, "semantic-two") },
      },
    ],
  });
  scheduler.enqueue({
    patches: [
      {
        op: "setProps",
        at: { blockId, nodeId: blockId },
        props: { enrichmentMarker: "low-priority" },
        meta: { kind: "enrichment" },
      },
    ],
    meta: { kind: "enrichment", priority: "low" },
  });

  await scheduler.awaitIdle();

  assert.ok(flushes.length >= 2, "expected semantic and enrichment work to flush separately under budget pressure");

  const firstFlush = flushes[0];
  assert.ok(firstFlush, "expected first flush result");
  assert.strictEqual(firstFlush.semanticQueueDepthBefore, 2, "first flush should start with both semantic batches queued");
  assert.strictEqual(firstFlush.enrichmentQueueDepthBefore, 1, "first flush should observe queued enrichment work");
  assert.deepStrictEqual(
    firstFlush.batches.map((batch) => batch.kind),
    ["semantic"],
    "each semantic batch remains atomic within its cooperative slice",
  );
  assert.strictEqual(firstFlush.remainingSemanticQueueSize, 1, "semantic work should yield when the frame budget expires");
  assert.strictEqual(firstFlush.remainingEnrichmentQueueSize, 1, "enrichment work should wait behind pending semantic work");
  const secondFlush = flushes[1];
  assert.ok(secondFlush, "the next scheduled slice should resume semantic work");
  assert.deepStrictEqual(secondFlush.batches.map((batch) => batch.kind), ["semantic"]);
  assert.strictEqual(secondFlush.remainingSemanticQueueSize, 0, "semantic work should drain before enrichment");
  assert.strictEqual(secondFlush.remainingEnrichmentQueueSize, 1);

  const enrichmentFlush = flushes.find((flush, index) => index > 1 && flush.batches.some((batch) => batch.kind === "enrichment"));
  assert.ok(enrichmentFlush, "expected a later enrichment flush");
  assert.ok(
    enrichmentFlush?.batches.every((batch) => batch.kind === "enrichment"),
    "enrichment work should not interleave with semantic work",
  );

  assert.strictEqual(store.getNode(blockId)?.block?.payload.raw, "semantic-two", "semantic FIFO order must be preserved");
  assert.strictEqual(
    store.getNode(blockId)?.props?.enrichmentMarker,
    "low-priority",
    "enrichment patch should still land after semantic work drains",
  );
}

await main();
console.log("patch-commit-scheduler-semantic-order test passed");
