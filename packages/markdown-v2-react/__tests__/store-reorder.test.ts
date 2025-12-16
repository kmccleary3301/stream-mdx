import assert from "node:assert";
import type { Block, InlineNode } from "@stream-mdx/core";
import { createRendererStore } from "../src/renderer/store";

function textNode(text: string): InlineNode {
  return { kind: "text", text };
}

function createListBlock(): Block {
  return {
    id: "list-block",
    type: "list",
    isFinalized: true,
    payload: {
      raw: "- First\n- Second",
      meta: {
        ordered: false,
        items: [[textNode("First")], [textNode("Second")]],
      },
    },
  };
}

async function runStoreReorderTest(): Promise<void> {
  const store = createRendererStore([createListBlock()]);
  const originalChildren = [...store.getChildren("list-block")];
  assert.strictEqual(originalChildren.length, 2, "list must start with two items");
  originalChildren.forEach((id, idx) => {
    assert.ok(id.startsWith("list-block::item:"), `unexpected child id format at index ${idx}: ${id}`);
  });

  const touched = store.applyPatches([
    {
      op: "reorder",
      at: { blockId: "list-block", nodeId: "list-block" },
      from: 1,
      to: 0,
      count: 1,
    },
  ]);

  assert.ok(touched.has("list-block"), "parent list node should be marked dirty after reorder");

  const reordered = store.getChildren("list-block");
  assert.strictEqual(reordered.length, 2);
  assert.strictEqual(reordered[0], originalChildren[1], "first child should now be the original second");
  assert.strictEqual(reordered[1], originalChildren[0], "second child should now be the original first");
}

await runStoreReorderTest();
console.log("Renderer store reorder test passed");
