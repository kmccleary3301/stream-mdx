import assert from "node:assert";
import type { Block } from "@stream-mdx/core";
import { createRendererStore } from "../src/renderer/store";

const nestedListRaw = `- Alpha
  - Nested One
  - Nested Two
- Beta
  - Nested B1`;

const nestedListBlock: Block = {
  id: "nested-list",
  type: "list",
  isFinalized: true,
  payload: {
    raw: nestedListRaw,
    meta: { ordered: false },
    range: { from: 0, to: nestedListRaw.length },
  },
};

function assertDepth(store: ReturnType<typeof createRendererStore>, nodeId: string, expected: number) {
  const node = store.getNode(nodeId);
  assert.ok(node, `expected node ${nodeId} to exist`);
  assert.strictEqual(node?.props?.depth, expected, `expected depth ${expected} for node ${nodeId} but received ${node?.props?.depth}`);
}

async function main() {
  const store = createRendererStore([nestedListBlock]);

  assertDepth(store, "nested-list", 0);

  const topLevelItems = store.getChildren("nested-list");
  assert.strictEqual(topLevelItems.length, 2, "expected two top-level list items");

  const firstItemId = topLevelItems[0];
  const secondItemId = topLevelItems[1];
  assertDepth(store, firstItemId, 0);
  assertDepth(store, secondItemId, 0);

  const firstItemChildren = store.getChildren(firstItemId);
  const nestedListId = firstItemChildren.find((childId) => store.getNode(childId)?.type === "list");
  assert.ok(nestedListId, "expected nested list under first item");
  assertDepth(store, nestedListId!, 1);

  const nestedItems = store.getChildren(nestedListId!);
  nestedItems.forEach((itemId) => assertDepth(store, itemId, 1));

  store.applyPatches([
    {
      op: "reorder",
      at: { blockId: "nested-list", nodeId: "nested-list" },
      from: 1,
      to: 0,
      count: 1,
    },
  ]);

  const reorderedItems = store.getChildren("nested-list");
  assert.strictEqual(reorderedItems[0], secondItemId);
  assert.strictEqual(reorderedItems[1], firstItemId);
  reorderedItems.forEach((itemId) => assertDepth(store, itemId, 0));

  const nestedItemsAfterReorder = store.getChildren(nestedListId!);
  nestedItemsAfterReorder.forEach((itemId) => assertDepth(store, itemId, 1));

  console.log("List depth normalization test passed");
}

await main();
