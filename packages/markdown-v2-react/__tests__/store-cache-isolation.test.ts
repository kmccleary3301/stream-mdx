import assert from "node:assert";

import type { Block, InlineNode } from "@stream-mdx/core";

import { createRendererStore } from "../src/renderer/store";

function createParagraphBlock(id: string, text: string): Block {
  return {
    id,
    type: "paragraph",
    isFinalized: true,
    payload: {
      raw: text,
      inline: [{ kind: "text", text }] satisfies InlineNode[],
      meta: {},
    },
  };
}

async function runStoreCacheIsolationTest(): Promise<void> {
  const sharedId = "shared-block";
  const storeA = createRendererStore([createParagraphBlock(sharedId, "alpha")]);
  const storeB = createRendererStore([createParagraphBlock(sharedId, "beta")]);

  const nodeA = storeA.getNode(sharedId);
  const nodeB = storeB.getNode(sharedId);
  assert.ok(nodeA, "expected store A node");
  assert.ok(nodeB, "expected store B node");
  assert.notStrictEqual(nodeA, nodeB, "stores must not share node snapshot cache entries");
  assert.strictEqual(nodeA?.block?.payload.raw, "alpha", "store A should retain its own block payload");
  assert.strictEqual(nodeB?.block?.payload.raw, "beta", "store B should retain its own block payload");

  const rootChildrenA = storeA.getChildren("__root__");
  const rootChildrenB = storeB.getChildren("__root__");
  assert.deepStrictEqual(rootChildrenA, [sharedId], "store A root must contain its own block id");
  assert.deepStrictEqual(rootChildrenB, [sharedId], "store B root must contain its own block id");
  assert.notStrictEqual(rootChildrenA, rootChildrenB, "stores must not share children snapshot cache entries");

  storeA.applyPatches(
    [
      {
        op: "setProps",
        at: { blockId: sharedId },
        props: {
          block: createParagraphBlock(sharedId, "alpha-updated"),
        },
      },
    ],
    { captureMetrics: false },
  );

  const nodeAAfter = storeA.getNode(sharedId);
  const nodeBAfter = storeB.getNode(sharedId);
  assert.strictEqual(nodeAAfter?.block?.payload.raw, "alpha-updated", "store A should apply local updates");
  assert.strictEqual(nodeBAfter?.block?.payload.raw, "beta", "store B must remain isolated from store A updates");
}

await runStoreCacheIsolationTest();
console.log("store cache isolation test passed");
