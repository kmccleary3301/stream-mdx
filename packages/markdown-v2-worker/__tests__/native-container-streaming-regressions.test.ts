import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";

import assert from "node:assert/strict";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness, projectConsumerBlocks, projectConsumerRoots, type WorkerHarness } from "./worker-test-harness";


async function runSession(harness: WorkerHarness, chunks: readonly string[]): Promise<RendererStore> {
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { html: true, mdx: true, math: true, tables: true, footnotes: true, callouts: true, codeHighlighting: "incremental" },
    mdx: { compileMode: "worker" },
  });
  assertNoErrors(initMessages);
  const initialized = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(initialized, "worker must initialize before applying patches");
  store.resetSnapshot(initialized.snapshot);
  for (const message of initMessages) if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });

  for (const chunk of chunks) {
    const messages = await harness.send({ type: "APPEND", text: chunk });
    assertNoErrors(messages);
    for (const message of messages) if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
  }

  const finalized = await harness.send({ type: "FINALIZE" });
  assertNoErrors(finalized);
  for (const message of finalized) if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
  assert.equal(finalized.at(-1)?.type, "FINALIZED", "the consumer must receive terminal FINALIZED after patches");
  return store;
}

function assertNoErrors(messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "ERROR") assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
  }
}

function chunksOfSize(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) chunks.push(text.slice(offset, offset + size));
  return chunks;
}

async function runNestedListTest(): Promise<void> {
  const source = "- one\n- two\n  - child one\n  - child two\n";
  const harness = await createWorkerHarness();
  const singleShot = await runSession(harness, [source]);
  const expected = projectConsumerBlocks(singleShot.getBlocks());
  for (const chunkSize of [1, 3, 14]) {
    const streamed = await runSession(harness, chunksOfSize(source, chunkSize));
    assert.deepEqual(projectConsumerBlocks(streamed.getBlocks()), expected, `nested consumer children must match single-shot at chunk size ${chunkSize}`);
  }
}

async function runMarkerAlignmentTest(): Promise<void> {
  const source = "> - one\n> - two\n>\n> para\n";
  const harness = await createWorkerHarness();
  const singleShot = await runSession(harness, [source]);
  const expected = projectConsumerRoots(singleShot.getBlocks());
  for (const chunkSize of [1, 3, 7]) {
    const streamed = await runSession(harness, chunksOfSize(source, chunkSize));
    assert.deepEqual(projectConsumerRoots(streamed.getBlocks()), expected, `root consumer blocks must match single-shot at chunk size ${chunkSize}`);
  }
}

await runNestedListTest();
await runMarkerAlignmentTest();
console.log("Native container streaming regressions passed");
