import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

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
    // React DOM reads the bare global navigator once a window exists (Node 20 has no global navigator).
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;

  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const snippet = buildSnippet(220);

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: {
    html: true,
    mdx: false,
    math: false,
    tables: false,
    callouts: false,
    lazyTokenization: { enabled: true, thresholdLines: 50 },
  }, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not initialize");
  store.resetSnapshot(init.snapshot);

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
  const codeState = store.getCodeBlock(codeBlock.id);
  assert.ok(codeState, "expected a native code owner");
  assert.strictEqual(codeState.source.lineCount, 220);
  const sourceLines = store.getCodeLines(codeBlock.id, 0, codeState.source.lineCount);
  assert.deepStrictEqual(sourceLines.map((line) => line.text), snippet.split("\n").slice(1, -1));
  assert.ok(sourceLines.every((line) => line.decoration === undefined), "source lines should start without highlight decorations");

  const line0Before = sourceLines[0];
  assert.ok(line0Before, "line 0 missing before tokenization");
  assert.strictEqual(line0Before.text, "line-0 value");
  assert.strictEqual(line0Before.decoration, undefined, "line 0 should not be highlighted before tokenization");

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

  const line0After = store.getCodeLines(codeBlock.id, 0, 1)[0];
  assert.ok(line0After, "line 0 missing after tokenization");
  assert.strictEqual(line0After.text, "line-0 value");
  assert.ok(line0After.decoration, "line 0 should be highlighted after tokenization");
  assert.strictEqual(line0After.decoration.tokens.spans.map((span) => span.t).join(""), line0After.text);

  const line25 = store.getCodeLines(codeBlock.id, 25, 26)[0];
  assert.ok(line25, "line 25 missing after tokenization");
  assert.strictEqual(line25.text, "line-25 value");
  assert.strictEqual(line25.decoration, undefined, "line 25 should remain unhighlighted outside requested range");

  const updatedBlock = store.getBlocks().find((block) => block.id === codeBlock.id);
  const tokenizedUntil = (updatedBlock?.payload.meta as Record<string, unknown> | undefined)?.lazyTokenizedUntil as number | undefined;
  assert.ok(typeof tokenizedUntil === "number" && tokenizedUntil >= 20, "lazyTokenizedUntil should advance after tokenization");

  // A viewer demand that arrives after the range is already decorated (for example, queued
  // behind another highlighting pass) must not tokenize those lines again.
  const repeatedMessages = await harness.send({
    type: "TOKENIZE_RANGE",
    blockId: codeBlock.id,
    startLine: 0,
    endLine: 20,
    priority: "visible",
  });
  const repeatedDecorations = repeatedMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .flatMap((msg) => msg.patches as Patch[])
    .filter((patch) => patch.op === "decorateCode");
  assert.deepStrictEqual(repeatedDecorations, [], "an already-decorated demanded range must not be re-tokenized");

  console.log("lazy tokenization range test passed");
}

await main();
