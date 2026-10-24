import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "@stream-mdx/react/renderer/store";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createWorkerHarness, type WorkerHarness } from "./worker-test-harness";

function ensureDom(): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
    // React DOM reads the bare global navigator once a window exists (Node 20 has no global navigator).
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;
}

function applyPatchMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const msg of messages) {
    if (msg.type !== "PATCH") continue;
    store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
}

function renderConsumerOutput(blocks: Block[]) {
  const store = createRendererStore(blocks);
  const dom = new JSDOM(renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), store }),
  ));
  const document = dom.window.document;
  const output = {
    text: document.body.textContent ?? "",
    paragraphs: Array.from(document.querySelectorAll("p"), (paragraph) => paragraph.textContent ?? ""),
    links: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) => ({
      href: anchor.getAttribute("href"),
      text: anchor.textContent ?? "",
    })),
    footnoteReferences: Array.from(document.querySelectorAll<HTMLAnchorElement>("sup > a"), (anchor) => ({
      text: anchor.textContent ?? "",
      targetExists: Boolean(anchor.hash && document.getElementById(anchor.hash.slice(1))),
    })),
    footnotes: Array.from(document.querySelectorAll<HTMLLIElement>("section > ol > li"), (item) => ({
      text: item.textContent ?? "",
      backLinks: Array.from(item.querySelectorAll<HTMLAnchorElement>("a"), (anchor) => ({
        accessibleLabel: anchor.getAttribute("aria-label"),
        targetExists: Boolean(anchor.hash && document.getElementById(anchor.hash.slice(1))),
      })),
    })),
  };
  dom.window.close();
  return output;
}

function assertNoWorkerErrors(messages: WorkerOut[], phase: string): void {
  const error = messages.find((message): message is Extract<WorkerOut, { type: "ERROR" }> => message.type === "ERROR");
  if (error) assert.fail(`worker ${error.phase} failed during ${phase}: ${error.error.message}`);
}


async function runStreamingSession(harness: WorkerHarness, doc: string, chunkSize: number) {
  const store = createRendererStore();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: {
    footnotes: true,
    html: true,
    mdx: true,
    tables: true,
    callouts: true,
    math: true,
    formatAnticipation: true,
    liveCodeHighlighting: false,
  }, });
  assertNoWorkerErrors(initMessages, "INIT");
  const init = initMessages.find((message) => message.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.resetSnapshot(init.snapshot);
  for (let i = 0; i < doc.length; i += chunkSize) {
    const chunk = doc.slice(i, i + chunkSize);
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    assertNoWorkerErrors(appendMessages, "APPEND");
    applyPatchMessages(store, appendMessages);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  assertNoWorkerErrors(finalizeMessages, "FINALIZE");
  applyPatchMessages(store, finalizeMessages);
  const postFinalize = await harness.send({ type: "SET_CREDITS", credits: 1 });
  assertNoWorkerErrors(postFinalize, "SET_CREDITS");
  applyPatchMessages(store, postFinalize);

  const blocks = store.getBlocks();
  assert.ok(blocks.every((block) => block.isFinalized), "all blocks must be finalized after FINALIZE + credits flush");

  return renderConsumerOutput(blocks);
}

async function runClosedOwnerLifecycleTest(harness: WorkerHarness): Promise<void> {
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "First retained paragraph.\n\nSecond retained paragraph.",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true },
  });
  const init = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> =>
    message.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize the retained paragraphs");
  store.resetSnapshot(init.snapshot);

  const firstFinalize = await harness.send({ type: "FINALIZE" });
  assertNoWorkerErrors(firstFinalize, "initial FINALIZE");
  applyPatchMessages(store, firstFinalize);

  const appendMessages = await harness.send({ type: "APPEND", text: "\n\nThird paragraph after finalization." });
  assertNoWorkerErrors(appendMessages, "APPEND after FINALIZE");
  applyPatchMessages(store, appendMessages);

  const secondFinalize = await harness.send({ type: "FINALIZE" });
  assertNoWorkerErrors(secondFinalize, "FINALIZE after adding a later root");
  applyPatchMessages(store, secondFinalize);

  const blocks = store.getBlocks();
  assert.ok(blocks.every((block) => block.isFinalized), "every retained and appended paragraph must be finalized");
  assert.deepStrictEqual(renderConsumerOutput(blocks).paragraphs, [
    "First retained paragraph.",
    "Second retained paragraph.",
    "Third paragraph after finalization.",
  ], "finalizing a later root must preserve earlier closed paragraph content and boundaries");
}

async function runInitIdempotencyTest(): Promise<void> {
  ensureDom();

  const docWithFootnotes = [
    "# Alpha",
    "",
    "A reference [^first] and [guide][destination] appear here.",
    "",
    "- Bullet one",
    "- Bullet two",
    "",
    "> Blockquote with <em>inline html</em>.",
    "",
    "[destination]: /guide",
    "",
    "[^first]: First footnote.",
    "",
  ].join("\n");

  const plainDoc = [
    "# Plain",
    "",
    "No footnotes in this run.",
    "",
    "Another paragraph with `inline code`.",
    "",
  ].join("\n");

  const harness = await createWorkerHarness();

  const alphaRun1 = await runStreamingSession(harness, docWithFootnotes, 37);
  const plainRun1 = await runStreamingSession(harness, plainDoc, 11);
  const alphaRun2 = await runStreamingSession(harness, docWithFootnotes, 37);
  const plainRun2 = await runStreamingSession(harness, plainDoc, 11);

  assert.deepStrictEqual(alphaRun2, alphaRun1, "repeated INIT should preserve rendered content, footnotes, and links");
  assert.deepStrictEqual(plainRun2, plainRun1, "interleaved INIT sessions should not leak rendered content into later runs");
  assert.ok(alphaRun1.text.includes("A reference"), "the consumer must render the authored paragraph");
  assert.ok(alphaRun1.links.some((link) => link.href === "/guide" && link.text === "guide"),
    "the consumer must render the resolved reference link");
  assert.deepStrictEqual(alphaRun1.footnoteReferences, [{ text: "1", targetExists: true }],
    "the consumer must render a numbered footnote link with a published destination");
  assert.ok(alphaRun1.footnotes.some((item) => item.text.includes("First footnote.")),
    "the consumer must render the footnote definition");
  assert.ok(alphaRun1.footnotes.some((item) =>
    item.backLinks.some((link) => link.accessibleLabel !== null && link.targetExists)),
  "the rendered footnote must expose an accessible return link to its reference");
  assert.deepStrictEqual(plainRun1.footnoteReferences, [], "a later INIT must not inherit prior footnote references");
  assert.deepStrictEqual(plainRun1.footnotes, [], "a later INIT must not synthesize a prior footnote definition");
  assert.ok(!plainRun1.links.some((link) => link.href === "/guide"), "a later INIT must not inherit prior link definitions");
  await runClosedOwnerLifecycleTest(harness);
}

await runInitIdempotencyTest();
console.log("worker init idempotency regression test passed");
