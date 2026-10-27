import assert from "node:assert/strict";

import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness, projectConsumerBlocks, type WorkerHarness } from "./worker-test-harness";

const SOURCE = String.raw`line one
line two $x$ and $5 and $10 $$display$$ [drive](C:\repo\.t3\file.png) ![image](C:\repo\.t3\image.png) [reference][asset]

[asset]: C:\repo\.t3\reference.png`;
const INIT = {
  type: "INIT" as const,
  schemaVersion: STREAM_MDX_SCHEMA_VERSION,
  initialContent: "",
  bootstrap: true,
  docPlugins: { softBreaks: "hard" as const },
  mathOptions: { singleDollar: "currency-safe" as const },
  linkDestinations: { windowsDrivePaths: "preserve" as const },
};

function assertNoErrors(messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "ERROR") assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
  }
}

function applyMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
  }
}

async function runSession(harness: WorkerHarness, initialContent: string, chunks: string[]): Promise<RendererStore> {
  const store = createRendererStore();
  const initMessages = await harness.send({ ...INIT, initialContent });
  assertNoErrors(initMessages);
  const initialized = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(initialized, "worker emits an initial snapshot");
  store.resetSnapshot(initialized.snapshot);
  applyMessages(store, initMessages);

  for (const text of chunks) {
    const appendMessages = await harness.send({ type: "APPEND", text });
    assertNoErrors(appendMessages);
    applyMessages(store, appendMessages);
  }

  const finalMessages = await harness.send({ type: "FINALIZE" });
  assertNoErrors(finalMessages);
  applyMessages(store, finalMessages);
  assert.equal(finalMessages.at(-1)?.type, "FINALIZED");
  return store;
}

const harness = await createWorkerHarness();
const oneShot = await runSession(harness, SOURCE, []);
const expected = projectConsumerBlocks(oneShot.getBlocks());
for (let split = 1; split < SOURCE.length; split++) {
  const streamed = await runSession(harness, "", [SOURCE.slice(0, split), SOURCE.slice(split)]);
  assert.deepEqual(projectConsumerBlocks(streamed.getBlocks()), expected, `streaming diverged at UTF-16 split ${split}`);
}

const paragraph = oneShot.getBlocks().find((block) => block.type === "paragraph");
assert.ok(paragraph, "expected paragraph output");
const inline = paragraph.payload.inline ?? [];
assert.ok(inline.some((node) => node.kind === "br"), "soft prose breaks reach the worker parser");
assert.ok(inline.some((node) => node.kind === "math-inline" && node.tex === "x"));
assert.ok(inline.some((node) => node.kind === "math-display" && node.tex === "display"));
assert.ok(inline.some((node) => node.kind === "link" && node.href === String.raw`C:\repo\.t3\file.png`));
assert.ok(inline.some((node) => node.kind === "image" && node.src === String.raw`C:\repo\.t3\image.png`));
assert.ok(inline.some((node) => node.kind === "link" && node.href === String.raw`C:\repo\.t3\reference.png`));
assert.ok(inline.some((node) => node.kind === "text" && node.text.includes("$5 and $10")), "currency text stays literal");

console.log("Worker parser option streaming tests passed");
