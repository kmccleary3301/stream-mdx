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

type WorkerHarness = Awaited<ReturnType<typeof createWorkerHarness>>;

async function runFinalizeConsumerTest(harness: WorkerHarness): Promise<void> {
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

async function runTailHeadingFinalizeConsumerTest(harness: WorkerHarness): Promise<void> {
  const store = createRendererStore();
  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  }));

  const content = ["## Repeat", "", "## Repeat", "", "## Repeat"].join("\n");
  applyMessages(store, await harness.send({ type: "APPEND", text: content }));
  const before = store.getBlocks().filter((block) => block.type === "heading");
  assert.deepStrictEqual(
    before.map((block) => block.payload.meta?.headingId),
    ["repeat", "repeat-2", "repeat-3"],
    "duplicate heading slugs should remain deterministic before FINALIZE",
  );
  assert.ok(before[2] && !before[2].isFinalized, "expected the trailing heading to remain unfinished");
  const beforePrefix = projectConsumerBlocks(before.slice(0, 2));

  applyMessages(store, await harness.send({ type: "FINALIZE" }));
  const after = store.getBlocks();
  const afterHeadings = after.filter((block) => block.type === "heading");
  assert.ok(after.every((block) => block.isFinalized), "FINALIZE must settle every block");
  assert.deepStrictEqual(
    afterHeadings.map((block) => block.payload.meta?.headingId),
    ["repeat", "repeat-2", "repeat-3"],
    "FINALIZE must preserve duplicate heading slugs across the retained prefix and tail",
  );
  assert.deepStrictEqual(
    projectConsumerBlocks(afterHeadings.slice(0, 2)),
    beforePrefix,
    "FINALIZE must preserve the rendered semantics of finalized prefix headings",
  );
}

async function runClosedFenceConsumerTest(harness: WorkerHarness): Promise<void> {
  const store = createRendererStore();
  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "```ts\nconst value = 1;\n",
    prewarmLangs: [],
    docPlugins: { codeHighlighting: "none", footnotes: false, html: false, mdx: false, tables: false },
  }));
  applyMessages(store, await harness.send({ type: "APPEND", text: "```" }));
  const code = store.getBlocks().find((block) => block.type === "code");
  assert.ok(code);
  assert.equal(store.getCodeBlock(code.id)?.source.state, "open", "an unterminated closing line can still change");

  applyMessages(store, await harness.send({ type: "APPEND", text: "\n" }));
  assert.equal(store.getCodeBlock(code.id)?.source.state, "finalized", "a physical closing fence settles source before document EOF");
  assert.equal(store.getBlocks().find((block) => block.id === code.id)?.payload.raw, "```ts\nconst value = 1;\n```");

  applyMessages(store, await harness.send({ type: "FINALIZE" }));
  assert.equal(store.getCodeBlock(code.id)?.source.state, "finalized");
  assert.equal(store.getBlocks().find((block) => block.id === code.id)?.payload.raw, "```ts\nconst value = 1;\n```");
}

const harness = await createWorkerHarness();
await runClosedFenceConsumerTest(harness);
await runTailHeadingFinalizeConsumerTest(harness);

await runFinalizeConsumerTest(harness);
console.log("worker finalize consumer test passed");
