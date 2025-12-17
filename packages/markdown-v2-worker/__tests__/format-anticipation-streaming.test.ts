import assert from "node:assert";
import type { InlineNode, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

function flattenInline(nodes: InlineNode[], kinds: Set<string>, texts: string[]): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      texts.push(node.text);
      continue;
    }
    kinds.add(node.kind);
    if ("children" in node && Array.isArray((node as { children?: InlineNode[] }).children)) {
      flattenInline(((node as { children?: InlineNode[] }).children ?? []) as InlineNode[], kinds, texts);
    }
  }
}

async function runFormatAnticipationStreamingTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true, formatAnticipation: true },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not emit INITIALIZED");
  store.reset(init.blocks);

  // No closing '*' yet.
  const appendMessages = await harness.send({ type: "APPEND", text: "This is *italic" });
  const patchMessages = appendMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  assert.ok(patchMessages.length > 0, "expected PATCH response from append");
  for (const msg of patchMessages) {
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }

  const paragraph = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw.includes("italic"));
  assert.ok(paragraph, "expected streamed paragraph block");
  assert.strictEqual(paragraph.payload?.meta?.inlineStatus, "anticipated", "expected inlineStatus=anticipated while delimiter is incomplete");

  const inlineNodes: InlineNode[] = Array.isArray(paragraph.payload?.inline) ? (paragraph.payload?.inline as InlineNode[]) : [];
  const kinds = new Set<string>();
  const texts: string[] = [];
  flattenInline(inlineNodes, kinds, texts);

  assert(kinds.has("em"), "missing anticipated emphasis node");
  assert(texts.every((text) => !text.includes("*")), `raw '*' leaked into inline nodes: ${texts.join(" | ")}`);

  // Once the real closer arrives, status should flip to complete.
  const append2 = await harness.send({ type: "APPEND", text: " text*" });
  const patch2 = append2.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const msg of patch2) {
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }

  const paragraph2 = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw.includes("italic"));
  assert.ok(paragraph2, "expected paragraph block after second append");
  assert.strictEqual(paragraph2.payload?.meta?.inlineStatus, "complete", "expected inlineStatus=complete once delimiter is balanced");
}

await runFormatAnticipationStreamingTest();
console.log("format anticipation streaming test passed");

