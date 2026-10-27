import { STREAM_MDX_SCHEMA_VERSION, type Block, type InlineNode, type NodeSnapshot, type WorkerOut } from "@stream-mdx/core";

import assert from "node:assert/strict";
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

  const paritySource = "-       **split-safe** [docs](https://example.com)\n\n        -       nested";
  const expected = projectConsumerBlocks((await runSession(harness, [paritySource], true)).getBlocks());
  for (let split = 1; split < paritySource.length; split += 1) {
    const actual = projectConsumerBlocks((await runSession(harness, [paritySource.slice(0, split), paritySource.slice(split)], true)).getBlocks());
    assert.deepEqual(actual, expected, `list recovery must match one-shot output at source split ${split}`);
  }
}

await runListIndentationRecoveryTests();
console.log("list indentation recovery tests passed");
