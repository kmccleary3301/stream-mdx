import assert from "node:assert";

import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";

function ensureDom() {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
    // React DOM reads the bare global navigator once a window exists (Node 20 has no global navigator).
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
}

function collectSubtreeNodeIds(store: ReturnType<typeof createRendererStore>, rootId: string): string[] {
  const result: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId) continue;
    result.push(nodeId);
    const children = store.getChildren(nodeId);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  return result;
}

async function runMdxSegmentBoundaryStreamingTest(): Promise<void> {
  ensureDom();
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    contentPolicy: "trusted-mdx",
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: true,
      liveCodeHighlighting: false,
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.reset(init.blocks);

  const chunks = [
    '- Item with prefix <InlineChip tone="warm">',
    "Hot",
    "</InlineChip> and suffix",
    "\n",
  ];

  for (const chunk of chunks) {
    applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));
    applyPatchMessages(store, await harness.send({ type: "APPEND", text: chunk }));
  }

  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));

  const blocks = store.getBlocks();
  const listBlock = blocks.find((block) => block.type === "list");
  assert.ok(listBlock, "expected finalized list block");
  assert.ok(listBlock?.isFinalized, "expected list block to be finalized");
  if (!listBlock) return;

  const subtreeIds = collectSubtreeNodeIds(store, listBlock.id);
  const listItems = subtreeIds
    .map((id) => store.getNode(id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .filter((node) => node.type === "list-item");
  assert.strictEqual(listItems.length, 1, "expected one list item");

  const inline = listItems[0]?.props?.inline as Array<{ kind: string; raw?: string; text?: string }> | undefined;
  const mdxOwners = inline?.filter((node) => node.kind === "trusted-mdx-inline") ?? [];
  assert.strictEqual(mdxOwners.length, 1, "expected one trusted MDX inline owner");
  assert.strictEqual(
    mdxOwners[0]?.raw,
    '<InlineChip tone="warm">Hot</InlineChip>',
    "expected paired MDX source in the native inline owner",
  );

  const inlineText = inline?.filter((node) => node.kind === "text").map((node) => node.text ?? "").join("\n") ?? "";
  assert.ok(!inlineText.includes("</InlineChip>"), "closing MDX tag should not leak into native text runs");
}

await runMdxSegmentBoundaryStreamingTest();
console.log("mdx segment boundary streaming test passed");
