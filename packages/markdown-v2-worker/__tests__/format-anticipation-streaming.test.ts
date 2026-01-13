import assert from "node:assert";
import { PATCH_ROOT_ID, type InlineNode, type Patch, type WorkerOut } from "@stream-mdx/core";
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

function collectListItems(store: ReturnType<typeof createRendererStore>): Array<{ inline?: InlineNode[]; text?: string }> {
  const root = store.getNode(PATCH_ROOT_ID);
  if (!root) return [];
  const results: Array<{ inline?: InlineNode[]; text?: string }> = [];
  const stack = [root.id];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    const node = store.getNode(id);
    if (!node) continue;
    if (node.type === "list-item") {
      const inline = Array.isArray(node.props.inline) ? (node.props.inline as InlineNode[]) : undefined;
      const text = typeof node.props.text === "string" ? (node.props.text as string) : undefined;
      results.push({ inline, text });
    }
    for (const childId of node.children) {
      stack.push(childId);
    }
  }
  return results;
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

  // List items should also honor anticipation.
  const listMessages = await harness.send({ type: "APPEND", text: "\n- *List item" });
  const listPatches = listMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  assert.ok(listPatches.length > 0, "expected PATCH response from list item append");
  for (const msg of listPatches) {
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }

  const listItems = collectListItems(store);
  assert.ok(listItems.length > 0, "expected list item nodes after list append");
  const targetItem = listItems.find((item) => item.text?.includes("List item"));
  assert.ok(targetItem, "expected list item with streamed text");
  const listInlineNodes = Array.isArray(targetItem.inline) ? targetItem.inline : [];
  const listKinds = new Set<string>();
  const listTexts: string[] = [];
  flattenInline(listInlineNodes, listKinds, listTexts);
  assert(!listKinds.has("em"), "unexpected anticipation inside list item");
  assert(listTexts.some((text) => text.includes("*")), `expected raw '*' to remain inside list item: ${listTexts.join(" | ")}`);
}

async function runMathAnticipationStreamingTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: { mathInline: true },
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not emit INITIALIZED");
  store.reset(init.blocks);

  const appendMessages = await harness.send({ type: "APPEND", text: "Value $x" });
  const patchMessages = appendMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  assert.ok(patchMessages.length > 0, "expected PATCH response from append");
  for (const msg of patchMessages) {
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }

  const paragraph = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw.includes("$x"));
  assert.ok(paragraph, "expected streamed paragraph block");
  assert.strictEqual(paragraph.payload?.meta?.inlineStatus, "anticipated", "expected inlineStatus=anticipated for math");

  const inlineNodes: InlineNode[] = Array.isArray(paragraph.payload?.inline) ? (paragraph.payload?.inline as InlineNode[]) : [];
  const kinds = new Set<string>();
  const texts: string[] = [];
  flattenInline(inlineNodes, kinds, texts);

  assert(kinds.has("math-inline"), "missing anticipated inline math node");
  assert(texts.every((text) => !text.includes("$x")), `raw '$' leaked into inline nodes: ${texts.join(" | ")}`);
}

await runFormatAnticipationStreamingTest();
await runMathAnticipationStreamingTest();
console.log("format anticipation streaming test passed");
