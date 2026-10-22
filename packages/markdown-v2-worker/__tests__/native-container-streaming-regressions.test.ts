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

// An unregistered component opener retires root paragraph owners after a root native tail parse, so the next
// append re-parses the whole document. Earlier finalized blocks must keep their authored source.
async function runTailWindowThenDocumentReparseTest(): Promise<void> {
  const chunks = [
    "# Restricted native component streaming\n\n<Card label=\"open-stage\" co",
    "unt={17} enabled>\n\n**Native bold child: p9-open-native-strong**\n\nP9_T2_OPEN_CARD_STAGE This authored body is intentionally",
    " staged across many deterministic producer c",
    "hunks.\n</Card>\n\nAfter the card.\n",
  ];
  const harness = await createWorkerHarness();
  const expected = projectConsumerBlocks((await runSession(harness, [chunks.join("")])).getBlocks());
  const streamed = await runSession(harness, chunks);
  assert.deepEqual(projectConsumerBlocks(streamed.getBlocks()), expected, "document re-parse after a root tail parse must match single-shot");
}

// Inline HTML arriving later moves a nested paragraph off native paragraph ownership; the export must follow.
async function runNestedParagraphLeavesNativeOwnershipTest(): Promise<void> {
  const harness = await createWorkerHarness();
  for (const chunks of [
    ["> text ", "<kbd>Ctrl</kbd> x\n\nAfter\n"],
    ["> text ", "<kbd>Ctrl</kbd> x\n>\n> - item\n\nAfter\n"],
    ["- text ", "<kbd>Ctrl</kbd> x\n- next\n\nAfter\n"],
  ]) {
    const expected = projectConsumerBlocks((await runSession(harness, [chunks.join("")])).getBlocks());
    const streamed = await runSession(harness, chunks);
    assert.deepEqual(projectConsumerBlocks(streamed.getBlocks()), expected, `nested paragraph ownership change must match single-shot: ${JSON.stringify(chunks)}`);
  }
}

// Continuation indent belongs to the latest item: three spaces nest under "9." but not under "11.".
async function runOrderedMarkerWidthTest(): Promise<void> {
  const chunks = ["9. A\n10. B\n11. C\n   1. off", "set\n   2. store ", "kernel\n12. D\n\n"];
  const harness = await createWorkerHarness();
  const expected = projectConsumerBlocks((await runSession(harness, [chunks.join("")])).getBlocks());
  const streamed = await runSession(harness, chunks);
  assert.deepEqual(projectConsumerBlocks(streamed.getBlocks()), expected, "streamed list items must use the latest item's content indent");
}

// A nested list's window keeps its first item, so the list keeps its source start and earlier items survive
// when a later sibling becomes active.
async function runNestedListLaterSiblingTest(): Promise<void> {
  const chunks = ["Intro\n\n- A\n- B\n  - b1\n  - b2\n    - deep\n  - b3", " z\n-"];
  const harness = await createWorkerHarness();
  const expected = projectConsumerBlocks((await runSession(harness, [chunks.join("")])).getBlocks());
  const streamed = await runSession(harness, chunks);
  assert.deepEqual(projectConsumerBlocks(streamed.getBlocks()), expected, "nested list items before the active sibling must survive");
}

// Completing a footnote reference in an open root paragraph reruns document plugins over earlier blocks;
// whatever they replace there (here the quote's footnote-scan inline) must reach consumers.
async function runPluginReplacedBlockAfterParagraphAppendTest(): Promise<void> {
  const chunks = ["Intro[^a].\n\n> Quote H<sub>2</sub>O.\n>\n> - item", " `code`\n>\n> Tail.\n\nLater ref[^n", "] text"];
  const harness = await createWorkerHarness();
  const expected = projectConsumerBlocks((await runSession(harness, [chunks.join("")])).getBlocks());
  const streamed = await runSession(harness, chunks);
  assert.deepEqual(projectConsumerBlocks(streamed.getBlocks()), expected, "blocks replaced by document plugins must be patched");
}

// CommonMark: a `> >` line after a blank quote line opens a quote nested in the outer one.
async function runNestedQuoteAfterBlankQuoteLineTest(): Promise<void> {
  const chunks = ["Intro\n\n> W", " w.\n>\n> > q"];
  const harness = await createWorkerHarness();
  for (const session of [[chunks.join("")], chunks]) {
    const quote = projectConsumerBlocks((await runSession(harness, session)).getBlocks())[1];
    assert.deepEqual(
      quote?.children.map((child) => (child.type === "blockquote" ? [child.type, child.raw] : [child.type])),
      [["paragraph"], ["blockquote", "> q"]],
      `nested quote after a blank quote line (${session.length} chunks)`,
    );
  }
}

await runNestedListTest();
await runMarkerAlignmentTest();
await runTailWindowThenDocumentReparseTest();
await runNestedParagraphLeavesNativeOwnershipTest();
await runOrderedMarkerWidthTest();
await runNestedListLaterSiblingTest();
await runPluginReplacedBlockAfterParagraphAppendTest();
await runNestedQuoteAfterBlankQuoteLineTest();
console.log("Native container streaming regressions passed");
