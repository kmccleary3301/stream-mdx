import { STREAM_MDX_SCHEMA_VERSION, type Block, type InlineNode, type NodeSnapshot, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { createMarkdownSnapshotCompiler } from "../src/direct-compile";
import { MarkdownEngine } from "../src/engine/engine";
import type { EngineExtensions } from "../src/engine/types";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRendererStore, type RendererStore } from "@stream-mdx/react/renderer/store";
import { projectConsumerBlocks } from "./consumer-block-projection";
import { createWorkerHarness, type WorkerHarness } from "./worker-test-harness";

async function runSession(
  harness: WorkerHarness,
  chunks: readonly string[],
  listIndentation: boolean,
): Promise<RendererStore> {
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { listIndentation },
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
async function runEngineSession(
  extensions: EngineExtensions,
  chunks: readonly string[],
  listIndentation: boolean,
): Promise<RendererStore> {
  const store = createRendererStore();
  const pendingMessages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ extensions, post: (message) => pendingMessages.push(message) });
  const send = async (message: WorkerIn): Promise<WorkerOut[]> => {
    await engine.handle(message);
    const received = pendingMessages.splice(0);
    assertNoErrors(received);
    return received;
  };
  const apply = (messages: readonly WorkerOut[]): void => {
    for (const message of messages) if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
  };

  const initializedMessages = await send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { listIndentation },
  });
  const initialized = initializedMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(initialized, "extended worker must initialize before applying patches");
  store.resetSnapshot(initialized.snapshot);
  apply(initializedMessages);
  for (const chunk of chunks) apply(await send({ type: "APPEND", text: chunk }));
  const finalized = await send({ type: "FINALIZE" });
  apply(finalized);
  assert.equal(finalized.at(-1)?.type, "FINALIZED");
  return store;
}


function assertNoErrors(messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "ERROR") assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
  }
}


function recoveredInline(nodes: readonly NodeSnapshot[]): InlineNode[] | undefined {
  for (const node of nodes) {
    const block = node.props?.block as Block | undefined;
    if (block?.payload.inline?.length) return block.payload.inline;
    const inline = node.props?.inline;
    if (Array.isArray(inline) && inline.length > 0 && inline.every((item) => typeof item === "object" && item !== null && "kind" in item)) {
      return inline as InlineNode[];
    }
    const nested = recoveredInline(node.children ?? []);
    if (nested) return nested;
  }
  return undefined;
}

function findRecoveredParagraph(nodes: readonly NodeSnapshot[]): NodeSnapshot | undefined {
  for (const node of nodes) {
    if (node.type === "paragraph") return node;
    const nested = findRecoveredParagraph(node.children ?? []);
    if (nested) return nested;
  }
  return undefined;
}
function findNestedBlock(nodes: readonly NodeSnapshot[], type: Block["type"]): Block | undefined {
  for (const node of nodes) {
    const block = node.props?.block as Block | undefined;
    if (block?.type === type) return block;
    const nested = findNestedBlock(node.children ?? [], type);
    if (nested) return nested;
  }
  return undefined;
}

function listItemRanges(nodes: readonly NodeSnapshot[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const node of nodes) {
    const block = node.props?.block as Block | undefined;
    if (block?.type === "list-item" && block.payload.range) ranges.push(block.payload.range);
    ranges.push(...listItemRanges(node.children ?? []));
  }
  return ranges;
}

async function runListIndentationRecoveryTests(): Promise<void> {
  const harness = await createWorkerHarness();

  const sameLineOverIndented = `why did you do this?\n\n-       for (const step of rest.steps) {\n-           if (step.request.body) {\n-               step.request.body = "<redacted>";\n-           }\n-       }`;
  const disabled = projectConsumerBlocks((await runSession(harness, [sameLineOverIndented], false)).getBlocks());
  assert.match(disabled[1]?.markup ?? "", /<pre(?:\s|>)/, "the recovery mode must remain opt-in");
  const recovered = await runSession(harness, [sameLineOverIndented], true);
  const recoveredMarkup = projectConsumerBlocks(recovered.getBlocks()).map((block) => block.markup).join("");
  assert.doesNotMatch(recoveredMarkup, /<pre(?:\s|>)/);
  assert.match(recoveredMarkup, /for \(const step of rest\.steps\) \{/);
  assert.doesNotMatch(recoveredMarkup, /> {1,}for \(const step of rest\.steps\)/);
  assert.match(recoveredMarkup, /if \(step\.request\.body\) \{/);
  assert.match(recoveredMarkup, /step\.request\.body = .*redacted/);

  const inlineSource = "-       **important** [docs](https://example.com) use `inline code`, not ~~plain text~~";
  const inlineStore = await runSession(harness, [inlineSource], true);
  const inlineProjection = projectConsumerBlocks(inlineStore.getBlocks()).map((block) => block.markup).join("");
  assert.match(inlineProjection, /<strong>important<\/strong>/);
  assert.match(inlineProjection, /<a href="https:\/\/example\.com"[^>]*>docs<\/a>/);
  assert.match(inlineProjection, /<code[^>]*>inline code<\/code>/);
  assert.match(inlineProjection, /<del>plain text<\/del>/);
  assert.doesNotMatch(inlineProjection, /\*\*important\*\*/);
  const list = inlineStore.getBlocks()[0];
  const prepared = list?.payload.meta?.preparedNested as { children?: NodeSnapshot[] } | undefined;
  const recoveredPrepared = recovered.getBlocks()[1]?.payload.meta?.preparedNested as { children?: NodeSnapshot[] } | undefined;
  const recoveredText = recoveredInline(recoveredPrepared?.children ?? [])?.find((node) => node.kind === "text");
  const recoveredTextStart = sameLineOverIndented.indexOf("for (const step");
  assert.deepEqual(recoveredText?.sourceRange, {
    from: recoveredTextStart,
    to: recoveredTextStart + "for (const step of rest.steps) {".length,
  });

  const separatedBlocks = "-       **first block**\n\n        [second block](https://example.com)";
  const separatedMarkup = projectConsumerBlocks((await runSession(harness, [separatedBlocks], true)).getBlocks()).map((block) => block.markup).join("");
  assert.match(separatedMarkup, /<strong>first block<\/strong>/);
  assert.match(separatedMarkup, /<a href="https:\/\/example\.com"[^>]*>second block<\/a>/);

  const nestedSource = "-       first block\n\n        -       nested block";
  const nestedMarkup = projectConsumerBlocks((await runSession(harness, [nestedSource], true)).getBlocks()).map((block) => block.markup).join("");
  assert.doesNotMatch(nestedMarkup, /<pre>/);
  assert.match(nestedMarkup, /nested block/);

  const fencedSource = "- ```ts\n  const value = 1;\n  ```";
  const fencedStore = await runSession(harness, [fencedSource], true);
  const fencedBlocks = fencedStore.getBlocks();
  const fencedMarkup = projectConsumerBlocks(fencedBlocks).map((block) => block.markup).join("");
  assert.match(fencedMarkup, /<pre(?:\s|>)/);
  assert.match(fencedMarkup, /language-ts/);
  const fencedPrepared = fencedBlocks[0]?.payload.meta?.preparedNested as { children?: NodeSnapshot[] } | undefined;
  const fencedCode = findNestedBlock(fencedPrepared?.children ?? [], "code");
  assert.match(`${fencedCode?.payload.raw ?? ""}${String(fencedCode?.payload.meta?.code ?? "")}`, /const value = 1;/);

  const belowMarkerSource = "-\n      const value = 1;";
  const belowMarkerStore = await runSession(harness, [belowMarkerSource], true);
  const belowMarkerBlocks = belowMarkerStore.getBlocks();
  const belowMarkerMarkup = projectConsumerBlocks(belowMarkerBlocks).map((block) => block.markup).join("");
  assert.match(belowMarkerMarkup, /<pre(?:\s|>)/);
  const belowMarkerPrepared = belowMarkerBlocks[0]?.payload.meta?.preparedNested as { children?: NodeSnapshot[] } | undefined;
  const belowMarkerCode = findNestedBlock(belowMarkerPrepared?.children ?? [], "code");
  assert.match(`${belowMarkerCode?.payload.raw ?? ""}${String(belowMarkerCode?.payload.meta?.code ?? "")}`, /const value = 1;/);

  const sameLineCodeSource = "-     const value = 1;";
  const sameLineCodeStore = await runSession(harness, [sameLineCodeSource], true);
  const sameLineCodeBlocks = sameLineCodeStore.getBlocks();
  const sameLineCodeMarkup = projectConsumerBlocks(sameLineCodeBlocks).map((block) => block.markup).join("");
  assert.match(sameLineCodeMarkup, /<pre(?:\s|>)/);
  const sameLineCodePrepared = sameLineCodeBlocks[0]?.payload.meta?.preparedNested as { children?: NodeSnapshot[] } | undefined;
  const sameLineCode = findNestedBlock(sameLineCodePrepared?.children ?? [], "code");
  assert.match(`${sameLineCode?.payload.raw ?? ""}${String(sameLineCode?.payload.meta?.code ?? "")}`, /const value = 1;/);
  const rangeParagraph = findRecoveredParagraph(prepared?.children ?? []);
  assert.ok(rangeParagraph?.range, "recovered blocks must retain source ranges");
  assert.ok(rangeParagraph.range.from >= 0 && rangeParagraph.range.to <= inlineSource.length);
  assert.ok(inlineSource.slice(rangeParagraph.range.from, rangeParagraph.range.to).includes("**important**"));

  const orderedContinuationSource = [
    " 5. Implement the replay stage:",
    "   - clear only the owned region",
    "   - replay from the semantic source",
    " 6. Keep the snapshot fallback available.",
    " 7. Add the rich-block policy:",
    "   - hold previews while live",
    " 8. Add detail overlays",
  ].join("\n");
  const strictMarkup = projectConsumerBlocks(
    (await runSession(harness, [orderedContinuationSource], false)).getBlocks(),
  ).map((block) => block.markup).join("");
  assert.match(strictMarkup, /<ol[^>]*start="5"[^>]*><li[^>]*>Implement the replay stage:<\/li><\/ol>/);
  assert.match(strictMarkup, /6\. Keep the snapshot fallback available\./);
  assert.doesNotMatch(strictMarkup, /<ol start="6"/);

  const orderedContinuationStore = await runSession(harness, [orderedContinuationSource], true);
  const orderedContinuationBlocks = orderedContinuationStore.getBlocks();
  const orderedContinuationMarkup = projectConsumerBlocks(orderedContinuationBlocks)
    .map((block) => block.markup)
    .join("");
  assert.match(orderedContinuationMarkup, /<ol[^>]*start="5"/);
  assert.equal((orderedContinuationMarkup.match(/<ol\b/g) ?? []).length, 1);
  assert.match(
    orderedContinuationMarkup,
    /<\/ul><\/div><\/li><li[^>]*>Keep the snapshot fallback available\.<\/li><li[^>]*>Add the rich-block policy:/,
  );
  const firstItemStart = orderedContinuationMarkup.indexOf("Implement the replay stage:");
  const secondItemStart = orderedContinuationMarkup.indexOf("Keep the snapshot fallback available.");
  assert.ok(firstItemStart >= 0 && secondItemStart > firstItemStart);
  const firstItemMarkup = orderedContinuationMarkup.slice(
    orderedContinuationMarkup.lastIndexOf("<li", firstItemStart),
    secondItemStart,
  );
  assert.match(firstItemMarkup, /<ul(?:\s|>)/);
  assert.match(firstItemMarkup, /clear only the owned region/);
  assert.match(firstItemMarkup, /replay from the semantic source/);
  assert.match(orderedContinuationMarkup, /<li[^>]*>Add the rich-block policy:[\s\S]*<ul(?:\s|>)/);
  assert.match(orderedContinuationMarkup, /<li[^>]*>Add detail overlays<\/li>/);
  assert.doesNotMatch(orderedContinuationMarkup, /6\. Keep the snapshot|7\. Add the rich-block/);

  const orderedPrepared = orderedContinuationBlocks[0]?.payload.meta?.preparedNested as {
    children?: NodeSnapshot[];
  } | undefined;
  const orderedText = recoveredInline(orderedPrepared?.children ?? [])?.find(
    (node) => node.kind === "text" && node.text === "Implement the replay stage:",
  );
  const orderedTextStart = orderedContinuationSource.indexOf("Implement the replay stage:");
  assert.deepEqual(orderedText?.sourceRange, {
    from: orderedTextStart,
    to: orderedTextStart + "Implement the replay stage:".length,
  });
  const orderedItemStarts = [
    "5. Implement the replay stage:",
    "- clear only the owned region",
    "- replay from the semantic source",
    "6. Keep the snapshot fallback available.",
    "7. Add the rich-block policy:",
    "- hold previews while live",
    "8. Add detail overlays",
  ].map((markerText) => orderedContinuationSource.indexOf(markerText));
  const orderedItemRanges = listItemRanges(orderedPrepared?.children ?? []);
  for (const markerStart of orderedItemStarts) {
    assert.ok(
      orderedItemRanges.some((range) => range.from <= markerStart && markerStart < range.to),
      `recovered list-item ranges must cover authored marker at ${markerStart}`,
    );
  }

  const orderedExpected = projectConsumerBlocks(orderedContinuationBlocks);
  for (let split = 1; split < orderedContinuationSource.length; split += 1) {
    const actual = projectConsumerBlocks(
      (await runSession(
        harness,
        [orderedContinuationSource.slice(0, split), orderedContinuationSource.slice(split)],
        true,
      )).getBlocks(),
    );
    assert.deepEqual(actual, orderedExpected, `ordered continuation must match at source split ${split}`);
  }
  const fullCorpusSource = await readFile(
    new URL("./list-indentation-recovery.fixture.md", import.meta.url),
    "utf8",
  );
  const fullCorpusStore = await runSession(harness, [fullCorpusSource], true);
  const scopeStart = fullCorpusSource.indexOf(" 1. Implement the ledger");
  const scopeEnd = fullCorpusSource.indexOf("Execution rules:");
  assert.ok(scopeStart >= 0 && scopeEnd > scopeStart, "full corpus must contain the Scope list");
  const scopeLists = fullCorpusStore.getBlocks().filter((block) => {
    const range = block.payload.range;
    return block.type === "list"
      && range !== undefined
      && range.from >= scopeStart
      && range.to <= scopeEnd;
  });
  assert.equal(scopeLists.length, 1, "full corpus Scope must remain one root ordered list");
  const scopeList = scopeLists[0]!;
  assert.equal(scopeList.payload.meta?.ordered, true);
  assert.equal(scopeList.payload.meta?.start ?? 1, 1);
  const scopePrepared = scopeList.payload.meta?.preparedNested as {
    children?: NodeSnapshot[];
  } | undefined;
  const scopeItems = (scopePrepared?.children ?? []).filter((node) => node.type === "list-item");
  assert.equal(scopeItems.length, 10, "full corpus Scope must contain ordered items 1 through 10");
  const nestedBulletCounts = new Map([
    [4, { title: "Implement the replay stage:", count: 4 }],
    [6, { title: "Add the rich-block policy:", count: 3 }],
    [8, { title: "Add the required invariants:", count: 9 }],
  ]);
  for (let index = 0; index < scopeItems.length; index += 1) {
    const item = scopeItems[index]!;
    const nestedLists = (item.children ?? []).filter((child) => child.type === "list");
    const expectedNestedList = nestedBulletCounts.get(index);
    if (!expectedNestedList) {
      assert.equal(nestedLists.length, 0, `ordered item ${index + 1} must not have nested bullets`);
      continue;
    }
    assert.ok(
      String(item.props?.text ?? "").includes(expectedNestedList.title),
      `ordered item ${index + 1} must match its expected parent text`,
    );
    assert.equal(nestedLists.length, 1, `ordered item ${index + 1} must own its bullet list`);
    const nestedItems = (nestedLists[0]!.children ?? []).filter((child) => child.type === "list-item");
    assert.equal(nestedItems.length, expectedNestedList.count, `ordered item ${index + 1} bullet count`);
  }
  const noOpExtensions = {
    inline: [{ name: "no-op-inline", lezer: {}, toInline: () => undefined }],
    documentPlugins: [{ name: "no-op-document", process: () => undefined }],
  } satisfies EngineExtensions;
  const compileOptions = {
    text: orderedContinuationSource,
    init: { docPlugins: { listIndentation: true }, prewarmLangs: [] },
  };
  const plainCompiled = await createMarkdownSnapshotCompiler({ extensionId: "list-continuation-plain" }).compile(compileOptions);
  const extendedCompiled = await createMarkdownSnapshotCompiler({
    extensions: noOpExtensions,
    extensionId: "list-continuation-extensions",
  }).compile(compileOptions);
  assert.deepEqual(
    projectConsumerBlocks(extendedCompiled.blocks),
    projectConsumerBlocks(plainCompiled.blocks),
    "direct snapshot compilation must be unchanged by no-op inline and document extensions",
  );
  const extendedStream = await runEngineSession(noOpExtensions, [orderedContinuationSource.slice(0, 96), orderedContinuationSource.slice(96)], true);
  assert.deepEqual(
    projectConsumerBlocks(extendedStream.getBlocks()),
    projectConsumerBlocks(orderedContinuationBlocks),
    "worker streaming with no-op inline and document extensions must match the unextended result",
  );
}

await runListIndentationRecoveryTests();
console.log("list indentation recovery tests passed");
