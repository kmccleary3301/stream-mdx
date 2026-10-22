import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import type { Block, Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import type { RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { JSDOM } from "jsdom";

import { projectConsumerBlocks } from "./consumer-block-projection";
import { compileMarkdownSnapshotDirect } from "../src/direct-compile";
import { createWorkerHarness } from "./worker-test-harness";
import { MarkdownEngine } from "../src/engine/engine";

function applyMessages(store: RendererStore, messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
    else if (message.type === "ERROR") assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
  }
}

function renderDocument(store: RendererStore): string {
  const coldExport = store.getBlocks();
  return renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: coldExport, store }));
}

function assertQuoteRendersFootnoteReference(blocks: readonly Block[], label: string): void {
  const quote = blocks.find((block) => block.type === "blockquote");
  assert.ok(quote, `${label}: output must contain the quote`);
  assert.match(projectConsumerBlocks([quote])[0].markup, /<sup class="footnote-ref">/, `${label}: quote paragraph must render a footnote reference`);
}

// Numbering reaches a quoted paragraph at finalize, with and without a root paragraph owner before it.
async function runNestedFootnoteReferenceAtFinalize(): Promise<void> {
  const docPlugins = { formatAnticipation: true };
  for (const before of ["", "Intro [^late]\n\n"]) {
    const body = `${before}> nested [^late]`;
    const definition = "\n\n[^late]: Footnote body";
    const label = before ? "after a root owner" : "quote only";

    const direct = await compileMarkdownSnapshotDirect({ text: `${body}${definition}`, init: { docPlugins } });
    assertQuoteRendersFootnoteReference(direct.blocks, `single-shot ${label}`);

    const harness = await createWorkerHarness();
    const store = createRendererStore();
    applyMessages(store, await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: body, prewarmLangs: [], docPlugins }));
    applyMessages(store, await harness.send({ type: "APPEND", text: definition }));
    applyMessages(store, await harness.send({ type: "FINALIZE" }));
    assertQuoteRendersFootnoteReference(store.getBlocks(), `streamed ${label}`);
  }
}

async function runDefaultMixedReferencesAndNestedFootnotes(): Promise<void> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  const store = createRendererStore();
  const literal = "Keep < and { literally";
  const mixedInitial = "First [^late] <span>inside [^late]</span> with <Badge>preview";
  const initialSource = `${literal}\n\n${mixedInitial}`;
  const appended = " output</Badge> [guide][manual]\n\n> nested [^late]";
  const init: WorkerIn = {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: initialSource,
    prewarmLangs: [],
    docPlugins: { formatAnticipation: true },
  };
  try {
    await engine.handle(init);
    applyMessages(store, messages.splice(0));
    assert.ok(store.getBlocks().some((block) => block.payload.raw === literal), "literal angle/brace characters must remain available in cold output");
    assert.ok(store.getBlocks().some((block) => block.payload.raw === mixedInitial), "mixed authored source must remain available before continuation");

    await engine.handle({ type: "APPEND", text: appended });
    applyMessages(store, messages.splice(0));
    const completedMixed = `${mixedInitial} output</Badge> [guide][manual]`;
    const mixed = store.getBlocks().find((block) => block.payload.raw === completedMixed);
    assert.ok(mixed, "completed mixed paragraph must retain its exact authored source slice");

    await engine.handle({ type: "APPEND", text: "\n\n[manual]: /guide\n" });
    applyMessages(store, messages.splice(0));
    await engine.handle({ type: "APPEND", text: '  "Guide title"' });
    applyMessages(store, messages.splice(0));
    await engine.handle({ type: "APPEND", text: "\n\n[^late]: Footnote body" });
    applyMessages(store, messages.splice(0));
    await engine.handle({ type: "FINALIZE" });
    applyMessages(store, messages.splice(0));

    const finalBlocks = store.getBlocks();
    const finalMixed = finalBlocks.find((block) => block.payload.raw === completedMixed);
    assert.ok(finalMixed, "FINALIZE must preserve the mixed paragraph's authored source slice");
    const projection = projectConsumerBlocks([finalMixed])[0];
    assert.equal(projection.raw, completedMixed);
    const document = new JSDOM(renderDocument(store)).window.document;
    const bodyText = document.body.textContent ?? "";
    assert.ok(bodyText.includes("Keep < and { literally"), "rendered output must preserve literal angle and brace characters");
    assert.ok(bodyText.includes("preview output"), "rendered output must preserve mixed paragraph text");
    const guide = document.querySelector<HTMLAnchorElement>('a[href="/guide"]');
    assert.equal(guide?.textContent, "guide", "late canonical link definitions must reach rendered links");
    assert.equal(guide?.title, "Guide title", "continued reference titles must reach rendered links");
    const references = [...document.querySelectorAll<HTMLAnchorElement>("sup.footnote-ref a")];
    assert.equal(references.length, 3, "plain, HTML-owned, and nested references must all render");
    assert.deepEqual(references.map((reference) => reference.textContent), ["1", "1", "1"], "all occurrences must use the canonical footnote number");
    assert.ok(document.querySelector("blockquote sup.footnote-ref a"), "nested quote footnote references must remain visible");
    document.defaultView?.close();
  } finally {
    engine.dispose();
  }
}

async function runDefaultOriginalRootReclassification(): Promise<void> {
  const setextMessages: WorkerOut[] = [];
  const setextEngine = new MarkdownEngine({ post: (message) => setextMessages.push(message) });
  const setextStore = createRendererStore();
  try {
    const original = "Prior line\nTitle";
    await setextEngine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: original, prewarmLangs: [] });
    applyMessages(setextStore, setextMessages.splice(0));
    const priorOwner = setextStore.getBlocks().find((block) => block.type === "paragraph");
    await setextEngine.handle({ type: "APPEND", text: "\n---" });
    applyMessages(setextStore, setextMessages.splice(0));
    const heading = setextStore.getBlocks().find((block) => block.type === "heading");
    assert.ok(heading, "default Setext parsing must expose a heading in the cold export");
    assert.equal(heading.payload.range?.from, 0);
    assert.equal(heading.payload.range?.to, original.length + "\n---".length);
    assert.notEqual(heading.id, priorOwner?.id, "the reclassified consumer block must replace its prior identity");
    const singleShot = await compileMarkdownSnapshotDirect({ text: `${original}\n---` });
    const singleShotHeading = singleShot.blocks.find((block) => block.type === "heading");
    assert.ok(singleShotHeading, "single-shot parsing must produce the same heading");
    assert.equal(
      projectConsumerBlocks([heading])[0].markup,
      projectConsumerBlocks([singleShotHeading])[0].markup,
      "the reclassified root must render as its single-shot heading",
    );
    await setextEngine.handle({ type: "FINALIZE" });
    applyMessages(setextStore, setextMessages.splice(0));
  } finally {
    setextEngine.dispose();
  }

  const tableMessages: WorkerOut[] = [];
  const tableEngine = new MarkdownEngine({ post: (message) => tableMessages.push(message) });
  const tableStore = createRendererStore();
  try {
    await tableEngine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "| head |\r\n", prewarmLangs: [] });
    applyMessages(tableStore, tableMessages.splice(0));
    await tableEngine.handle({ type: "APPEND", text: "| --- |" });
    applyMessages(tableStore, tableMessages.splice(0));
    const table = tableStore.getBlocks().find((block) => block.type === "table");
    assert.ok(table, "default parsing must expose an ambiguous source reclassified as a table");
    assert.equal(table.payload.range?.from, 0, "table reclassification must retain the original source range");
    const tableMarkup = projectConsumerBlocks([table])[0].markup;
    assert.ok(tableMarkup.includes("<table"), "reclassified table must render as a table");
    assert.ok(tableMarkup.includes("head"), "rendered table must preserve its authored header");
    await tableEngine.handle({ type: "FINALIZE" });
    applyMessages(tableStore, tableMessages.splice(0));
  } finally {
    tableEngine.dispose();
  }
}

await runNestedFootnoteReferenceAtFinalize();
await runDefaultMixedReferencesAndNestedFootnotes();
await runDefaultOriginalRootReclassification();
console.log("native paragraph default bridge consumer tests passed");
