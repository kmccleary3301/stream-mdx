import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { projectConsumerBlocks } from "./consumer-block-projection";
import { createWorkerHarness } from "./worker-test-harness";

function ensureDom(): void {
  if (typeof window !== "undefined") return;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    navigator: { configurable: true, writable: true, value: dom.window.navigator },
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Node: { configurable: true, value: dom.window.Node },
  });
}

function applyPatchMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
}

async function createInitializedHarnessStore() {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
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
  }, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.resetSnapshot(init.snapshot);
  return { harness, store };
}


async function computeBaseline(doc: string): Promise<Block[]> {
  const { harness, store } = await createInitializedHarnessStore();
  applyPatchMessages(store, await harness.send({ type: "APPEND", text: doc }));
  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));
  return store.getBlocks();
}

async function runMixedSegmentCanonicalizationTest(): Promise<void> {
  ensureDom();

  const doc = [
    "# Canonicalization",
    "",
    "Paragraph with <em>inline html</em> and {renderInlineExpression()} then **formatting**.",
    "",
    "> Blockquote with <code>inline tag</code> and {quoteExpr}.",
    "",
    "Another paragraph with <span data-x=\"1\">attributes</span> and {trailingExpression}.",
    "",
  ].join("\n");

  const baseline = await computeBaseline(doc);

  const { harness, store } = await createInitializedHarnessStore();
  for (let i = 0; i < doc.length; i += 17) {
    applyPatchMessages(store, await harness.send({ type: "APPEND", text: doc.slice(i, i + 17) }));
  }

  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));

  const finalBlocks = store.getBlocks();

  assert.deepStrictEqual(
    projectConsumerBlocks(finalBlocks),
    projectConsumerBlocks(baseline),
    "chunked and single-shot cold exports must match in block identity, authored source, lifecycle, range, and rendered output",
  );
}

await runMixedSegmentCanonicalizationTest();
console.log("mixed segment canonicalization regression test passed");
