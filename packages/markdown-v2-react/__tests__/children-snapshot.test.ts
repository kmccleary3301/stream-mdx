import assert from "node:assert";
import type { Block, InlineNode, NodeSnapshot } from "@stream-mdx/core";
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

async function runChildrenSnapshotTest(): Promise<void> {
  const store = createRendererStore([createListBlock()]);
  const initial = store.getChildrenWithVersion("list-block");
  assert.strictEqual(initial.children.length, 2, "list should start with two items");

  const nextItem: NodeSnapshot = {
    id: "list-block::item:2",
    type: "list-item",
    props: {
      index: 2,
      ordered: false,
      inline: [textNode("Third")],
      text: "Third",
    },
    children: [],
  };

  store.applyPatches([
    {
      op: "insertChild",
      at: { blockId: "list-block", nodeId: "list-block" },
      index: 2,
      node: nextItem,
    },
  ]);

  const updated = store.getChildrenWithVersion("list-block");
  assert.strictEqual(updated.children.length, 3, "list should include the inserted item");
  assert.notStrictEqual(initial.children, updated.children, "children snapshot should update to a new array");
}

await runChildrenSnapshotTest();
console.log("Renderer store children snapshot test passed");
