import assert from "node:assert";

import type { Block, Patch } from "@stream-mdx/core";
import { createRendererStore } from "../src/renderer/store";

function createParagraphBlock(id: string, text: string): Block {
  return {
    id,
    type: "paragraph",
    isFinalized: true,
    payload: {
      raw: text,
      inline: [{ kind: "text", text }],
    },
  };
}

async function runStoreResetBurstTest(): Promise<void> {
  let blockId = "paragraph-a";
  let block = createParagraphBlock(blockId, "initial");
  const store = createRendererStore([block]);

  const iterations = 25;
  const burstSize = 12;

  for (let i = 0; i < iterations; i += 1) {
    const patches: Patch[] = [];
    for (let j = 0; j < burstSize; j += 1) {
      patches.push({
        op: "setHTML",
        at: { blockId },
        html: `<p>burst-${i}-${j}</p>`,
        sanitized: true,
      });
    }
    store.applyPatches(patches);

    blockId = blockId === "paragraph-a" ? "paragraph-b" : "paragraph-a";
    block = createParagraphBlock(blockId, `reset-${i}`);
    store.reset([block]);

    const blocks = store.getBlocks();
    assert.strictEqual(blocks.length, 1, "expected single block after reset");
    assert.strictEqual(blocks[0].id, blockId, "expected reset block to be active");
  }
}

await runStoreResetBurstTest();
console.log("Renderer store reset burst test passed");
