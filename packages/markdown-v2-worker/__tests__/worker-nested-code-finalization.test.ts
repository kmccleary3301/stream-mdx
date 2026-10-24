import { STREAM_MDX_SCHEMA_VERSION, type Patch, type WorkerOut } from "@stream-mdx/core";

import assert from "node:assert";

import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";
import { projectConsumerBlocks } from "./consumer-block-projection";

function applyMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

async function renderNestedList(chunks: readonly string[], finalize: boolean): Promise<string> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const docPlugins = {
    footnotes: true,
    html: true,
    mdx: true,
    tables: true,
    callouts: true,
    math: true,
    formatAnticipation: true,
    codeHighlighting: "final",
    outputMode: "html",
    emitHighlightTokens: true,
    liveCodeHighlighting: false,
  };
  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: ["python"],
    docPlugins,
  } as never));
  for (const text of chunks) {
    applyMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));
    applyMessages(store, await harness.send({ type: "APPEND", text }));
  }
  if (finalize) {
    applyMessages(store, await harness.send({ type: "FINALIZE" }));
    applyMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));
  }
  const list = projectConsumerBlocks(store.getBlocks()).find(
    (block) => block.type === "list" && block.raw?.includes('print("nested code")'),
  );
  assert.ok(list, "expected the list containing nested code to be published");
  assert.ok(list.isFinalized, "the list must be finalized before its nested code is consumed");
  return list.markup;
}

async function runNestedCodeFinalizationTest(): Promise<void> {
  const source = [
    "-   ```python",
    '    print("nested code")',
    "    ```",
    "",
    "outside paragraph",
    "",
  ].join("\n");
  const splitAt = source.indexOf("\n\noutside paragraph");
  assert.notStrictEqual(splitAt, -1);
  const expected = await renderNestedList([source], true);
  const actual = await renderNestedList([source.slice(0, splitAt), source.slice(splitAt)], false);
  assert.match(expected, /class="line"[^>]*><span\b/, "single-shot finalization must publish Shiki spans");
  assert.strictEqual(actual, expected, "a finalized list must already contain the nested code's final highlighting");
}

await runNestedCodeFinalizationTest();
console.log("worker-nested-code-finalization test passed");
