import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import { JSDOM } from "jsdom";

import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import type { RendererStore } from "@stream-mdx/react/renderer/store";

import { projectConsumerBlocks } from "./consumer-block-projection";
import { createWorkerHarness } from "./worker-test-harness";

function applyPatchMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

function listMarkup(store: RendererStore, needle: string): string {
  const projection = projectConsumerBlocks(store.getBlocks()).find(
    (block) => block.type === "list" && block.raw?.includes(needle),
  );
  assert.ok(projection, `expected a cold list export containing ${JSON.stringify(needle)}`);
  return projection.markup;
}

async function runListAnticipationTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
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
    },
  });
  const init = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(init, "worker did not emit INITIALIZED");
  store.resetSnapshot(init.snapshot);

  const targetText = "Handling missing values in nested list emphasis";
  const partialNestedList = ["1. Root item", `   - **${targetText}`].join("\n");
  applyPatchMessages(store, await harness.send({ type: "APPEND", text: partialNestedList }));

  let markup = listMarkup(store, targetText);
  let hasStrong = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = new JSDOM(markup).window.document;
    hasStrong = [...document.querySelectorAll("strong")].some((element) => element.textContent?.includes(targetText));
    if (hasStrong || attempt === 2) break;
    applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));
    markup = listMarkup(store, targetText);
  }

  const text = new JSDOM(markup).window.document.body.textContent ?? "";
  assert.ok(
    hasStrong || text.includes(`**${targetText}`),
    `nested list emphasis must be rendered or its authored delimiters preserved, got: ${text}`,
  );
  if (hasStrong) {
    assert.ok(!text.includes("**"), `rendered strong content must not expose raw delimiters, got: ${text}`);
  }
}

await runListAnticipationTest();
console.log("list-item format anticipation test passed");
