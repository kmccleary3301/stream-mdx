import assert from "node:assert";

import type { InlineNode, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";

function ensureDom() {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
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

function inlineToPlainText(nodes: InlineNode[] | undefined): string {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text" && typeof node.text === "string") {
      out += node.text;
    } else if (typeof (node as { text?: unknown }).text === "string") {
      out += (node as { text: string }).text;
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      out += inlineToPlainText(node.children as InlineNode[]);
    }
  }
  return out;
}

async function runWorkerTableBoundaryStreamingTest(): Promise<void> {
  ensureDom();
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      footnotes: false,
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

  const doc = [
    "| key | value | notes |",
    "| --- | --- | --- |",
    "| alpha | 1 | first row |",
    "| beta | 2 | second row |",
    "| gamma | 3 | third row |",
    "",
  ].join("\n");

  for (let i = 0; i < doc.length; i++) {
    const credit = i % 5 === 0 ? 0.45 : i % 3 === 0 ? 0.72 : 1;
    applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: credit }));
    applyPatchMessages(store, await harness.send({ type: "APPEND", text: doc[i] ?? "" }));
  }

  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));

  const tables = store.getBlocks().filter((block) => block.type === "table");
  assert.strictEqual(tables.length, 1, "expected exactly one table block");
  const table = tables[0];
  assert.ok(table.isFinalized, "expected finalized table block");

  const meta = (table.payload.meta ?? {}) as {
    header?: InlineNode[][];
    rows?: InlineNode[][][];
  };

  const header = Array.isArray(meta.header) ? meta.header.map((cell) => inlineToPlainText(cell)) : [];
  const rows = Array.isArray(meta.rows) ? meta.rows.map((row) => row.map((cell) => inlineToPlainText(cell))) : [];

  assert.deepStrictEqual(header, ["key", "value", "notes"], "table header mismatch");
  assert.deepStrictEqual(
    rows,
    [
      ["alpha", "1", "first row"],
      ["beta", "2", "second row"],
      ["gamma", "3", "third row"],
    ],
    "table body cells mismatch",
  );
}

await runWorkerTableBoundaryStreamingTest();
console.log("worker table boundary streaming test passed");
