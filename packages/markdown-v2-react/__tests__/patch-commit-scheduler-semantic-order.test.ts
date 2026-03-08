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
    ["semantic", "semantic"],
    "semantic batches must flush first and remain unsplit by frame budget or batch caps",
  );
  assert.strictEqual(firstFlush.remainingSemanticQueueSize, 0, "semantic queue should be fully drained in the first flush");
  assert.strictEqual(firstFlush.remainingEnrichmentQueueSize, 1, "enrichment work should remain queued after semantic flush");

  const secondFlush = flushes.find((flush, index) => index > 0 && flush.batches.some((batch) => batch.kind === "enrichment"));
  assert.ok(secondFlush, "expected a later enrichment flush");
  assert.ok(
    secondFlush?.batches.every((batch) => batch.kind === "enrichment"),
    "enrichment flush should not interleave semantic work after the semantic queue is drained",
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
