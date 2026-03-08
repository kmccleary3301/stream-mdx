import assert from "node:assert";
import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { JSDOM } from "jsdom";
import { createWorkerHarness } from "./worker-test-harness";

function buildSnippet(lineCount: number): string {
  const lines = Array.from({ length: lineCount }, (_, idx) => `line-${idx} value`);
  return ["```js", ...lines, "```"].join("\n");
}

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;

  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const snippet = buildSnippet(220);

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      html: true,
      mdx: false,
      math: false,
      tables: false,
      callouts: false,
      lazyTokenization: { enabled: true, thresholdLines: 50 },
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not initialize");
  store.reset(init.blocks);

  const appendMessages = await harness.send({ type: "APPEND", text: snippet });
  appendMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  finalizeMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const codeBlock = store.getBlocks().find((block) => block.type === "code");
  assert.ok(codeBlock, "expected code block");
  const lazyFlag = (codeBlock.payload.meta as Record<string, unknown> | undefined)?.lazyTokenization;
  assert.strictEqual(lazyFlag, true, "lazy tokenization flag should be set");

  const line0Before = store.getNode(`${codeBlock.id}::line:0`)?.props?.html as string | undefined;
  assert.ok(line0Before, "line 0 missing before tokenization");
  assert.ok(!line0Before.includes("<span"), "line 0 should not be highlighted before tokenization");

  const rangeMessages = await harness.send({
    type: "TOKENIZE_RANGE",
    blockId: codeBlock.id,
    startLine: 0,
    endLine: 20,
    priority: "visible",
  });
  rangeMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const line0After = store.getNode(`${codeBlock.id}::line:0`)?.props?.html as string | undefined;
  assert.ok(line0After, "line 0 missing after tokenization");
  assert.ok(line0After.includes("<span"), "line 0 should be highlighted after tokenization");

  const line25 = store.getNode(`${codeBlock.id}::line:25`)?.props?.html as string | undefined;
  assert.ok(line25, "line 25 missing after tokenization");
  assert.ok(!line25.includes("<span"), "line 25 should remain unhighlighted outside requested range");

  const updatedBlock = store.getBlocks().find((block) => block.id === codeBlock.id);
  const tokenizedUntil = (updatedBlock?.payload.meta as Record<string, unknown> | undefined)?.lazyTokenizedUntil as number | undefined;
  assert.ok(typeof tokenizedUntil === "number" && tokenizedUntil >= 20, "lazyTokenizedUntil should advance after tokenization");

  console.log("lazy tokenization range test passed");
}

await main();
