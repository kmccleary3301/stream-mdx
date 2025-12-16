import assert from "node:assert";
import type { Block } from "@stream-mdx/core";
import { PatchCommitScheduler } from "../src/renderer/patch-commit-scheduler";
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
  const initial = createParagraphBlock("paragraph-1", "Hello world");
  const store = createRendererStore([initial]);

  let flushCount = 0;
  let lastTotalPatches = 0;
  let lastAppliedPatches = 0;

  const scheduler = new PatchCommitScheduler({
    store,
    onFlush: (result) => {
      flushCount += 1;
      lastTotalPatches = result.totalPatches;
      lastAppliedPatches = result.totalAppliedPatches;
    },
    options: {
      raf: null,
      cancelRaf: null,
      frameBudgetMs: 100,
      timeoutMs: 0,
      now: () => Date.now(),
    },
  });

  const updated = createParagraphBlock("paragraph-1", "Updated content");

  scheduler.enqueue({
    patches: [
      {
        op: "setProps",
        at: { blockId: updated.id },
        props: { block: updated },
      },
    ],
  });

  const beforeFlush = store.getNode(updated.id)?.block?.payload.raw;
  assert.strictEqual(beforeFlush, "Hello world", "store should not mutate before flush");

  scheduler.flushAll();
  await scheduler.awaitIdle();

  assert.strictEqual(flushCount, 1, "flush callback should fire exactly once");
  assert.strictEqual(lastTotalPatches, 1, "scheduler should report single applied patch");
  assert.strictEqual(lastAppliedPatches, 1, "scheduler should track applied patch count after coalescing");
  const afterFlush = store.getNode(updated.id)?.block?.payload.raw;
  assert.strictEqual(afterFlush, "Updated content", "block raw text should reflect applied patch");

  scheduler.pause();
  scheduler.enqueue({
    patches: [
      {
        op: "setProps",
        at: { blockId: updated.id },
        props: { block: createParagraphBlock("paragraph-1", "Paused update") },
      },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.strictEqual(flushCount, 1, "no additional flushes should occur while scheduler is paused");
  scheduler.resume();
  await scheduler.awaitIdle();
  assert.strictEqual(flushCount, 2, "flush should resume after scheduler is unpaused");
  assert.strictEqual(store.getNode(updated.id)?.block?.payload.raw, "Paused update", "store should incorporate patches after resume");

  const history = scheduler.getHistory();
  assert.ok(history.length >= 2, "history should retain previous flushes");
  scheduler.setHistoryLimit(1);
  assert.strictEqual(scheduler.getHistory().length, 1, "history limit should trim older entries");
  scheduler.clearHistory();
  assert.strictEqual(scheduler.getHistory().length, 0, "clearHistory should remove all recorded flushes");

  console.log("Patch commit scheduler test passed");
}

await main();
