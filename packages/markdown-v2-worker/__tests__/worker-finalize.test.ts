import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";
import { projectConsumerBlocks } from "./consumer-block-projection";

function applyMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

async function runFinalizeConsumerTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  }));

  const sample = ["## Heading", "", "Partial paragraph stream"].join("\n");
  applyMessages(store, await harness.send({ type: "APPEND", text: sample }));
  const before = store.getBlocks();
  assert.ok(before.some((block) => !block.isFinalized), "expected an unfinished cold export before FINALIZE");
  const beforeProjection = projectConsumerBlocks(before);

  applyMessages(store, await harness.send({ type: "FINALIZE" }));
  const after = store.getBlocks();
  assert.ok(after.every((block) => block.isFinalized), "FINALIZE must expose only finalized cold blocks");
  assert.ok(after.some((block) => block.type === "heading" && block.payload.raw === "## Heading"), "FINALIZE must retain the authored heading");
  assert.ok(after.some((block) => block.type === "paragraph" && block.payload.raw === "Partial paragraph stream"), "FINALIZE must retain the authored paragraph");
  const afterProjection = projectConsumerBlocks(after);
  assert.deepStrictEqual(
    afterProjection.map(({ isFinalized: _isFinalized, ...consumer }) => consumer),
    beforeProjection.map(({ isFinalized: _isFinalized, ...consumer }) => consumer),
    "FINALIZE must preserve block identity, authored source, range, and rendered output",
  );

  applyMessages(store, await harness.send({ type: "FINALIZE" }));
  assert.deepStrictEqual(
    projectConsumerBlocks(store.getBlocks()),
    afterProjection,
    "a repeated FINALIZE must leave the consumer export unchanged",
  );
}

await runFinalizeConsumerTest();
console.log("worker finalize consumer test passed");
