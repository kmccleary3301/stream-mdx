import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";

import { projectConsumerBlocks } from "./consumer-block-projection";
import { createWorkerHarness } from "./worker-test-harness";

function coldBlocks(messages: WorkerOut[]): Block[] {
  const store = createRendererStore();
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
  return store.getBlocks();
}

async function testHtmlContentRemainsInColdParagraph(): Promise<void> {
  const source = "Prefix <kbd>code";
  const harness = await createWorkerHarness();
  const blocks = coldBlocks(await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: source,
    prewarmLangs: [],
    docPlugins: { html: true, formatAnticipation: { inline: true, html: true } },
  }));
  const paragraph = blocks.find((block) => block.type === "paragraph" && block.payload.raw === source);
  assert.ok(paragraph, "HTML source must remain available as a cold paragraph export");
  const projection = projectConsumerBlocks([paragraph])[0];
  assert.ok(projection.markup.includes("Prefix"), "rendered HTML content must preserve the paragraph prefix");
  assert.ok(projection.markup.includes("code"), "rendered HTML content must preserve authored text after the tag");
}

async function testRegisteredRestrictedComponentRemainsInColdParagraph(): Promise<void> {
  const source = 'Prefix <InlineChip tone="warm"> suffix';
  const harness = await createWorkerHarness();
  const blocks = coldBlocks(await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: source,
    prewarmLangs: [],
    contentPolicy: "restricted",
    contentComponents: [{ name: "InlineChip" }],
    docPlugins: { mdx: true, formatAnticipation: { inline: true, mdx: true } },
  }));
  const paragraph = blocks.find((block) => block.type === "paragraph" && block.payload.raw === source);
  assert.ok(paragraph, "restricted registered-component source must remain available as a cold paragraph export");
  const projection = projectConsumerBlocks([paragraph])[0];
  assert.ok(projection.markup.includes("Prefix"), "rendered paragraph must preserve its prefix");
  assert.ok(projection.markup.includes("suffix"), "rendered paragraph must preserve text after the component tag");
}

await testHtmlContentRemainsInColdParagraph();
await testRegisteredRestrictedComponentRemainsInColdParagraph();
console.log("mixed lookahead consumer tests passed");
