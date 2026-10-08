import assert from "node:assert";
import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type === "INITIALIZED") {
      store.reset(msg.blocks);
    } else if (msg.type === "PATCH") {
      store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
    }
  }
}

async function runMultiInstanceEngineTest(): Promise<void> {
  const messages1: WorkerOut[] = [];
  const messages2: WorkerOut[] = [];

  const engine1 = new MarkdownEngine({
    post: (msg) => messages1.push(msg),
  });

  const engine2 = new MarkdownEngine({
    post: (msg) => messages2.push(msg),
  });

  const store1 = createRendererStore();
  const store2 = createRendererStore();

  // Engine 1 has footnotes enabled, Engine 2 does not
  await engine1.handle({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true },
  });

  await engine2.handle({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: false },
  });

  // Interleave chunks to verify state isolation
  await engine1.handle({ type: "APPEND", text: "Text with footnote[^1].\n\n" });
  await engine2.handle({ type: "APPEND", text: "# Engine 2 Header\n\n" });

  await engine1.handle({ type: "APPEND", text: "[^1]: Footnote description.\n" });
  await engine2.handle({ type: "APPEND", text: "- Item A\n- Item B[^1]\n\n[^1]: Footnote note.\n\n| H1 | H2 |\n| --- | --- |\n| D1 | D2 |\n" });
  await engine1.handle({ type: "FINALIZE" });
  await engine2.handle({ type: "FINALIZE" });

  applyPatchMessages(store1, messages1);
  applyPatchMessages(store2, messages2);

  const blocks1 = store1.getBlocks();
  const blocks2 = store2.getBlocks();
  const hasFootnotes1 = blocks1.some((b) => b.type === "footnotes");
  assert.strictEqual(hasFootnotes1, true, "engine1 should have synthesized a footnotes block");
  const hasHeader1 = blocks1.some((b) => b.type === "heading");
  assert.strictEqual(hasHeader1, false, "engine1 should not contain engine2's heading");

  // Assert engine 2 output has heading, list, table, but NO footnotes
  const hasFootnotes2 = blocks2.some((b) => b.type === "footnotes");
  assert.strictEqual(hasFootnotes2, false, "engine2 should not have synthesized a footnotes block");
  const heading2 = blocks2.find((b) => b.type === "heading");
  assert.ok(heading2, "engine2 should contain heading");
  assert.strictEqual(heading2.payload.raw?.trim(), "Engine 2 Header");
  const list2 = blocks2.find((b) => b.type === "list");
  assert.ok(list2, "engine2 should contain list");

  const table2 = blocks2.find((b) => b.type === "table");
  assert.ok(table2, "engine2 should contain table");

  // Verify finalized state on all blocks in both engines
  assert.ok(blocks1.every((b) => b.isFinalized), "all engine1 blocks should be finalized");
  assert.ok(blocks2.every((b) => b.isFinalized), "all engine2 blocks should be finalized");

  // Verify cleanup on dispose
  engine1.dispose();
  engine2.dispose();
}

runMultiInstanceEngineTest()
  .then(() => {
    console.log("multi-instance engine test passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
