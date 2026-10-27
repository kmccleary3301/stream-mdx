import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownBlocksRenderer } from "../../markdown-v2-react/src/server";
import { createWorkerHarness, type WorkerHarness } from "./worker-test-harness";

const repro = "> **Yes, seriously consider it as a spike branch.**\n> **No, do not choose it as the current best mainline plan.";
const closedStrongRepro = `${repro}**`;
const lazyContinuation = "> **Yes, seriously consider it as a spike branch.**\n**No, do not choose it as the current best mainline plan.**";
const expectedText = "Yes, seriously consider it as a spike branch.\n**No, do not choose it as the current best mainline plan.";
const expectedClosedText = "Yes, seriously consider it as a spike branch.\nNo, do not choose it as the current best mainline plan.";

async function render(harness: WorkerHarness, chunks: readonly string[], selector = "blockquote > p"): Promise<string> {
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

  const blocks = store.getBlocks();
  const markup = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks, store }));
  const dom = new JSDOM(markup);
  const paragraph = dom.window.document.querySelector(selector);
  assert.ok(paragraph, `expected paragraph selector ${selector} must render`);
  const text = paragraph.textContent ?? "";
  dom.window.close();
  return text;
}

async function assertEverySplit(
  harness: WorkerHarness,
  source: string,
  expected: string,
  selector = "blockquote > p",
): Promise<void> {
  const oneShot = await render(harness, [source], selector);
  assert.equal(oneShot, expected, "one-shot rendering must match the expected paragraph text");
  for (let split = 0; split <= source.length; split += 1) {
    const streamed = await render(harness, [source.slice(0, split), source.slice(split)], selector);
    assert.doesNotMatch(streamed, /\n> /, `physical blockquote markers must stay stripped at split ${split}`);
  }
}

const harness = await createWorkerHarness();
await assertEverySplit(harness, repro, expectedText);
await assertEverySplit(harness, closedStrongRepro, expectedClosedText);
const indentedGreaterThan = "a\n    > b";
for (let split = 0; split <= indentedGreaterThan.length; split += 1) {
  const text = await render(harness, [indentedGreaterThan.slice(0, split), indentedGreaterThan.slice(split)], "p");
  assert.equal(text.replace(/\s+/g, " ").trim(), "a > b", `literal indented greater-than must survive split ${split}`);
}

const indentedGreaterThanGap = "a **bold**\n    > **b**";
for (let split = 0; split <= indentedGreaterThanGap.length; split += 1) {
  const text = await render(harness, [indentedGreaterThanGap.slice(0, split), indentedGreaterThanGap.slice(split)], "p");
  assert.equal(text.replace(/\s+/g, " ").trim(), "a bold > b", `literal gap greater-than must survive split ${split}`);
}

const indentedGreaterThanBeforeHtml = await render(harness, ["a\n    > <span>b</span>"], "p");
assert.equal(
  indentedGreaterThanBeforeHtml.replace(/\s+/g, " ").trim(),
  "a > b",
  "a source gap before inline HTML must preserve a literal indented greater-than",
);
const nestedLazyContinuation = "> > first nested line\n>\n> outer continuation\nlazy continuation";
await assertEverySplit(harness, nestedLazyContinuation, "first nested line", "blockquote blockquote > p");
await assertEverySplit(harness, nestedLazyContinuation, "outer continuation\nlazy continuation", "blockquote > blockquote + p");
const lazyText = await render(harness, [lazyContinuation]);
assert.equal(lazyText, expectedClosedText, "lazy continuation lines have no quote marker to reinsert");

console.log("blockquote marker rendering parity checks passed");
