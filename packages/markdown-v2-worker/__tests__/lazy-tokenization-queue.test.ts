import assert from "node:assert";
import { clampLazyRange, compareLazyPriority, mergeLazyRequests } from "../src/lazy-tokenization";

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

  console.log("lazy tokenization queue tests passed");
}

main();
