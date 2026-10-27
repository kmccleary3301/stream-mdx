import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness, projectConsumerBlocks, type WorkerHarness } from "./worker-test-harness";

async function compile(harness: WorkerHarness, chunks: readonly string[]): Promise<unknown[]> {
  const store = createRendererStore();
  const apply = (messages: readonly WorkerOut[]) => {
    for (const message of messages) {
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      else if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
      else if (message.type === "ERROR") assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
    }
  };

  apply(await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { tables: true, math: true, html: true, footnotes: true, callouts: "github-alerts" },
    listIndentation: true,
  }));
  for (const chunk of chunks) apply(await harness.send({ type: "APPEND", text: chunk }));
  apply(await harness.send({ type: "FINALIZE" }));
  return projectConsumerBlocks(store.getBlocks());
}

async function assertEverySplit(harness: WorkerHarness, label: string, source: string): Promise<void> {
  const oneShot = await compile(harness, [source]);
  for (let split = 0; split <= source.length; split += 1) {
    const streamed = await compile(harness, [source.slice(0, split), source.slice(split)]);
    assert.deepEqual(streamed, oneShot, `${label}: finalized consumer projection differs at split ${split}`);
  }
}

const cases = [
  ["unclosed blockquote strong", "> **Yes, keep this as an experiment.**\n> **No, do not ship it as the default."],
  ["strong underscore", "> __bold__ after."],
  ["emphasis star", "> *italic* after."],
  ["emphasis underscore", "> _italic_ after."],
  ["inline code", "> `code` after."],
  ["double-backtick code", "> ``code ` text`` after."],
  ["strikethrough", "> ~~struck~~ after."],
] as const;

const harness = await createWorkerHarness();
for (const [label, source] of cases) await assertEverySplit(harness, label, source);
console.log("finalized delimiter split parity checks passed");
