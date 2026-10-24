import assert from "node:assert";
import {
  clampLazyRange,
  compareLazyPriority,
  mergeLazyRequests,
} from "../src/lazy-tokenization";
import {
  enqueueLazyTokenization,
  selectNextLazyRequest,
  type LazyTokenizationQueue,
} from "../src/engine/lazy-tokenization";

function main() {
  assert.strictEqual(compareLazyPriority("visible", "prefetch") > 0, true, "visible priority should outrank prefetch");
  const clamped = clampLazyRange(-5, 12, 10);
  assert.deepStrictEqual(clamped, { startLine: 0, endLine: 10 });

  const existing = {
    blockId: "block-1",
    startLine: 4,
    endLine: 12,
    priority: "prefetch" as const,
    requestedAt: 100,
  };
  const next = {
    blockId: "block-1",
    startLine: 0,
    endLine: 20,
    priority: "visible" as const,
    requestedAt: 200,
  };
  const merged = mergeLazyRequests(existing, next);
  assert.strictEqual(merged.startLine, 0);
  assert.strictEqual(merged.endLine, 20);
  assert.strictEqual(merged.priority, "visible");
  assert.strictEqual(merged.requestedAt, 200);

  const laterPrefetch = mergeLazyRequests(merged, {
    blockId: "block-1",
    startLine: 10,
    endLine: 22,
    priority: "prefetch" as const,
    requestedAt: 300,
  });
  assert.strictEqual(laterPrefetch.priority, "visible");
  assert.strictEqual(laterPrefetch.startLine, 0);
  assert.strictEqual(laterPrefetch.endLine, 22);
  assert.strictEqual(laterPrefetch.requestedAt, 200);

  const queue: LazyTokenizationQueue = new Map();
  enqueueLazyTokenization(queue, true, { ...existing, startLine: 0, endLine: 600 });
  enqueueLazyTokenization(queue, true, next);
  enqueueLazyTokenization(queue, true, { ...existing, startLine: 10, endLine: 700, requestedAt: 300 });
  assert.strictEqual(selectNextLazyRequest(queue)?.priority, "visible", "a visible range must remain ahead of background work for the same block");
  assert.strictEqual(queue.get("block-1")?.get("prefetch")?.endLine, 700, "prefetch demand must remain queued after visible work is selected");


  console.log("lazy tokenization queue tests passed");
}

main();
