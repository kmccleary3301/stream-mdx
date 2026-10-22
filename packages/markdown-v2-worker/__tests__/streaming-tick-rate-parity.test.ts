import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import DOMPurifyFactory from "dompurify";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

import { projectConsumerBlocks } from "./consumer-block-projection";

const SAMPLE_DOC = [
  "# Streaming Markdown Invariants",
  "",
  "This paragraph mixes *italic* text, ~~strike~~ formatting, and inline math $a + b = c$ to ensure inline parsing stabilizes.",
  "",
  "```ts",
  "export function square(value: number) {",
  "  return value * value;",
  "}",
  "```",
  "",
  "- First item with **bold** text",
  "- Second item with nested list:",
  "  - Inner child",
  "",
  "> Blockquote with `inline code`",
  "",
].join("\n");

const dompurifyShim = DOMPurifyFactory as unknown as { sanitize?: (html: string, config?: unknown) => string };
if (typeof dompurifyShim.sanitize !== "function") {
  dompurifyShim.sanitize = (html: string) => html;
}

function applyPatchMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type !== "PATCH") continue;
    store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

function assertStreamingInvariants(blocks: ReadonlyArray<Block>, label: string): void {
  const dirty = blocks.filter((block) => !block.isFinalized);
  assert.ok(dirty.length <= 1, `[${label}] expected at most one dirty block, found ${dirty.length}`);

  const duplicateParagraph = blocks.find(
    (block) => block.type === "paragraph" && typeof block.payload.raw === "string" && block.payload.raw.includes("Handling missing values"),
  );
  assert.strictEqual(duplicateParagraph, undefined, `[${label}] duplicate list tails should not create standalone paragraphs`);

  const footnotes = blocks.filter((block) => block.type === "footnotes");
  assert.ok(footnotes.length <= 1, `[${label}] only one synthesized footnotes block expected`);
}

async function streamDocument(chunkSize: number) {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  const init = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.resetSnapshot(init.snapshot);
  applyPatchMessages(store, initMessages);

  for (let idx = 0; idx < SAMPLE_DOC.length; idx += chunkSize) {
    const segment = SAMPLE_DOC.slice(idx, idx + chunkSize);
    const appendMessages = await harness.send({ type: "APPEND", text: segment });
    const patches = appendMessages.filter((message) => message.type === "PATCH");
    assert.ok(patches.length > 0, `missing PATCH payload at segment ${idx / chunkSize}`);
    applyPatchMessages(store, appendMessages);
  }

  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  const blocks = store.getBlocks();
  assertStreamingInvariants(blocks, `chunk=${chunkSize}`);
  return projectConsumerBlocks(blocks);
}

async function runTickRateParity(): Promise<void> {
  const fineGrained = await streamDocument(80);
  const coarse = await streamDocument(400);
  assert.deepStrictEqual(
    coarse,
    fineGrained,
    "tick-rate parity must include block identity, authored source, lifecycle, range, and rendered output",
  );
}

await runTickRateParity();
console.log("Streaming tick-rate parity test passed");
