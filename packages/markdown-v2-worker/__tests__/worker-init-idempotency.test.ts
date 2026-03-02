import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";

function ensureDom(): void {
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

function normalizeBlocks(blocks: ReadonlyArray<Block>) {
  return blocks.map((block) => ({
    id: block.id,
    type: block.type,
    isFinalized: block.isFinalized,
    raw: block.payload.raw ?? "",
    range: block.payload.range ? { ...block.payload.range } : null,
    meta: block.payload.meta ? JSON.parse(JSON.stringify(block.payload.meta)) : null,
  }));
}

async function runStreamingSession(harness: Awaited<ReturnType<typeof createWorkerHarness>>, doc: string, chunkSize: number) {
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
      formatAnticipation: true,
      liveCodeHighlighting: false,
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.reset(init.blocks);

  for (let i = 0; i < doc.length; i += chunkSize) {
    const appendMessages = await harness.send({ type: "APPEND", text: doc.slice(i, i + chunkSize) });
    applyPatchMessages(store, appendMessages);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  const postFinalize = await harness.send({ type: "SET_CREDITS", credits: 1 });
  applyPatchMessages(store, postFinalize);

  const blocks = store.getBlocks();
  assert.ok(blocks.every((block) => block.isFinalized), "all blocks must be finalized after FINALIZE + credits flush");

  return normalizeBlocks(blocks);
}

async function runInitIdempotencyTest(): Promise<void> {
  ensureDom();

  const docWithFootnotes = [
    "# Alpha",
    "",
    "A reference [^first] appears here.",
    "",
    "[^first]: First footnote.",
    "",
    "- Bullet one",
    "- Bullet two",
    "",
    "> Blockquote with <em>inline html</em>.",
    "",
  ].join("\n");

  const plainDoc = [
    "# Plain",
    "",
    "No footnotes in this run.",
    "",
    "Another paragraph with `inline code`.",
    "",
  ].join("\n");

  const harness = await createWorkerHarness();

  const alphaRun1 = await runStreamingSession(harness, docWithFootnotes, 37);
  const plainRun1 = await runStreamingSession(harness, plainDoc, 11);
  const alphaRun2 = await runStreamingSession(harness, docWithFootnotes, 37);
  const plainRun2 = await runStreamingSession(harness, plainDoc, 11);

  assert.deepStrictEqual(alphaRun2, alphaRun1, "repeated INIT should produce identical final snapshot for same markdown input");
  assert.deepStrictEqual(plainRun2, plainRun1, "interleaved INIT sessions should not leak state into subsequent runs");

  const plainFootnotes = plainRun1.filter((block) => block.type === "footnotes");
  assert.strictEqual(plainFootnotes.length, 0, "plain document must not synthesize footnotes from prior INIT state");
}

await runInitIdempotencyTest();
console.log("worker init idempotency regression test passed");
