import assert from "node:assert";
import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

function countOrderedListItems(content: string): number {
  const lines = content.split("\n");
  const completeLines = content.endsWith("\n") ? lines : lines.slice(0, -1);
  let count = 0;
  for (const line of completeLines) {
    if (/^\s*\d+\.\s+/.test(line)) {
      count += 1;
    }
  }
  return count;
}

function countListItems(store: ReturnType<typeof createRendererStore>, listId: string): number {
  const childIds = store.getChildren(listId);
  let count = 0;
  for (const childId of childIds) {
    if (store.getNode(childId)?.type === "list-item") {
      count += 1;
    }
  }
  return count;
}

async function applyWorkerMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): Promise<void> {
  for (const message of messages) {
    if (message.type === "INITIALIZED") {
      store.reset(message.blocks);
    }
    if (message.type === "PATCH") {
      store.applyPatches(message.patches as Patch[], { captureMetrics: false });
    }
  }
}

async function runStreamingListItemsProgressive(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  await applyWorkerMessages(store, initMessages);

  const content = [
    "## Example list\n",
    "1. Alpha\n",
    "2. Beta\n",
    "3. Gamma\n",
    "4. Delta\n",
    "5. Epsilon\n",
    "\n",
    "Trailing paragraph after the list.\n",
  ].join("");

  const chunkSize = 12;
  let current = "";

  for (let offset = 0; offset < content.length; offset += chunkSize) {
    const chunk = content.slice(offset, offset + chunkSize);
    current += chunk;
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    await applyWorkerMessages(store, appendMessages);

    const expected = countOrderedListItems(current);
    if (expected === 0) {
      continue;
    }
    const listBlock = store.getBlocks().find((block) => block.type === "list");
    assert.ok(listBlock, `expected list block after streaming ${offset + chunk.length} bytes`);
    const listItemCount = countListItems(store, listBlock.id);
    assert.ok(
      listItemCount >= expected,
      `expected at least ${expected} list items after streaming ${offset + chunk.length} bytes, saw ${listItemCount}`,
    );
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  await applyWorkerMessages(store, finalizeMessages);

  const finalList = store.getBlocks().find((block) => block.type === "list");
  assert.ok(finalList, "expected list block after finalize");
  const finalCount = countListItems(store, finalList.id);
  assert.strictEqual(finalCount, 5, `expected 5 list items after finalize, saw ${finalCount}`);
}

await runStreamingListItemsProgressive();
console.log("Streaming list items progressive test passed");
