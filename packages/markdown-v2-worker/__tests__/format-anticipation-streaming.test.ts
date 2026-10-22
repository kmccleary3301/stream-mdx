import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import { projectConsumerBlocks } from "./consumer-block-projection";
import { createWorkerHarness } from "./worker-test-harness";

function applyMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

function markupForRaw(store: RendererStore, rawPart: string): string {
  const projection = projectConsumerBlocks(store.getBlocks()).find((block) => block.raw?.includes(rawPart));
  assert.ok(projection, `expected cold export containing ${JSON.stringify(rawPart)}`);
  return projection.markup;
}

async function runFormatAnticipationStreamingTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true, formatAnticipation: true },
  }));

  applyMessages(store, await harness.send({ type: "APPEND", text: "This is *italic" }));
  const partialParagraph = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw.includes("italic"));
  assert.ok(partialParagraph, "expected a cold paragraph export for streamed emphasis");
  const partialMarkup = markupForRaw(store, "italic");
  assert.match(partialMarkup, /<em>italic<\/em>/, "an incomplete emphasis delimiter must render its anticipated emphasis");

  applyMessages(store, await harness.send({ type: "APPEND", text: " text*" }));
  const completeParagraph = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw.includes("italic"));
  assert.ok(completeParagraph, "expected the paragraph after its emphasis delimiter closes");
  assert.equal(completeParagraph.payload.raw, "This is *italic text*");
  assert.match(markupForRaw(store, "italic"), /<em>italic text<\/em>/, "closed emphasis must remain rendered around the full authored phrase");

  applyMessages(store, await harness.send({ type: "APPEND", text: "\n- *List item" }));
  const listBlock = store.getBlocks().find((block) => block.type === "list" && block.payload.raw.includes("List item"));
  assert.ok(listBlock, "expected the streamed list source in the cold export");
  assert.match(markupForRaw(store, "List item"), /<em>List item<\/em>/, "incomplete list-item emphasis must be visible in rendered output");
}

async function runMathAnticipationStreamingTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true, formatAnticipation: { mathInline: true } },
  }));

  applyMessages(store, await harness.send({ type: "APPEND", text: "Value $x" }));
  const paragraph = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw.includes("$x"));
  assert.ok(paragraph, "expected the streamed math source in the cold paragraph export");
  const markup = markupForRaw(store, "$x");
  assert.match(markup, /class="[^"]*math-inline/, "anticipated inline math must reach the rendered output as math");
  assert.match(markup, /data-tex="x"/, "anticipated inline math must retain its authored TeX value");
}

async function runMathBlockAnticipationStreamingTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true, formatAnticipation: { mathBlock: true } },
  }));

  applyMessages(store, await harness.send({ type: "APPEND", text: "$$\nR_{\\rho\\sigma}" }));
  const paragraph = store.getBlocks().find((block) => block.type === "paragraph" && block.payload.raw.includes("R_{\\rho\\sigma}"));
  assert.ok(paragraph, "expected the streamed display-math source in the cold paragraph export");
  const markup = markupForRaw(store, "R_{");
  assert.match(markup, /class="[^"]*math-display/, "anticipated display math must reach the rendered output as display math");
  assert.match(markup, /R_/, "anticipated display math must preserve its authored expression");
}

await runFormatAnticipationStreamingTest();
await runMathAnticipationStreamingTest();
await runMathBlockAnticipationStreamingTest();
console.log("format anticipation streaming test passed");
