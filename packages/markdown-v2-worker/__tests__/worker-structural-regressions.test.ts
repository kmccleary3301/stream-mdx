import {
  AppendSourceDocument,
  createBlockCompatibilityExtension,
  createBlockSnapshot,
  InlineParser,
  prepareNestedBlockSnapshotFromNative,
  STREAM_MDX_SCHEMA_VERSION,
  type Block,
  type HtmlOptions,
  type NodeSnapshot,
  type Patch,
  type WorkerOut,
} from "@stream-mdx/core";
import { GFM, parser as baseMarkdownParser } from "@lezer/markdown";

import assert from "node:assert";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { JSDOM } from "jsdom";
import React, { createElement } from "react";
import { compileTrustedMdxDocument } from "../src/mdx-compile";
import { projectTrustedMdxServerDocument } from "../../markdown-v2-react/src/trusted-mdx/server";
import {
  MarkdownBlocksRenderer,
  TrustedMdxServerRegionProvider,
} from "../../markdown-v2-react/src/server";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeMarkdownInput } from "../src/engine/native-markdown-input";
import { HtmlContinuationExtension } from "../src/parser/html-extension";

import { createWorkerHarness } from "./worker-test-harness";
import type * as RegressionUtils from "../../../scripts/regression/utils";
// Root scripts are CommonJS (no package "type"); Node 22+ cannot bind their named exports from
// this ESM test, so load the seeded chunker through require.
const { buildSeededChunks } = createRequire(import.meta.url)("../../../scripts/regression/utils.ts") as typeof RegressionUtils;

const DOC_PLUGINS = {
  footnotes: true,
  html: true,
  mdx: true,
  tables: true,
  callouts: true,
  math: true,
} as const;

const nativeParser = baseMarkdownParser.configure([
  GFM,
  createBlockCompatibilityExtension(),
  HtmlContinuationExtension,
]);

function flatten(snapshot: NodeSnapshot): NodeSnapshot[] {
  return [snapshot, ...(snapshot.children ?? []).flatMap(flatten)];
}

async function loadFixture(name: string): Promise<string> {
  return await fs.readFile(new URL(`../../../tests/regression/fixtures/${name}`, import.meta.url), "utf8");
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type !== "PATCH") continue;
    store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

async function streamFixture(
  content: string,
  chunkSize: number,
  options: { contentPolicy?: "markdown" | "restricted" | "trusted-mdx"; html?: HtmlOptions } = {},
): Promise<ReadonlyArray<Block>> {
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += chunkSize) {
    chunks.push(content.slice(index, index + chunkSize));
  }
  return await streamFixtureChunks(content, chunks, options);
}

async function streamFixtureChunks(
  content: string,
  chunks: readonly string[],
  options: { contentPolicy?: "markdown" | "restricted" | "trusted-mdx"; html?: HtmlOptions } = {},
): Promise<ReadonlyArray<Block>> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
    contentPolicy: options.contentPolicy,
    html: options.html,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.resetSnapshot(init.snapshot);

  for (const chunk of chunks) {
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    applyPatchMessages(store, appendMessages);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  return store.getBlocks();
}


async function assertTrustedMdxFlowProjection(content: string, blocks: readonly Block[]): Promise<void> {
  const artifact = await compileTrustedMdxDocument(content);
  const Preview = ({ children }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("figure", { "data-preview": "true" }, children);
  const projection = await projectTrustedMdxServerDocument({
    source: content,
    blocks,
    artifact,
    components: { Preview },
  });
  const mdxBlocks = blocks.filter((block) => block.type === "mdx");
  const flowRegions = projection.regions.filter((region) => region.kind === "render" && region.nativeChildren === true);
  assert.deepStrictEqual(
    flowRegions.map((region) => region.ownerId),
    mdxBlocks.map((block) => block.id),
    "every completed flow root must map to one consumer-renderable MDX region",
  );

  const projectedChildSources = flowRegions.map((region) => {
    assert.strictEqual(region.kind, "render");
    if (region.kind !== "render") return [];
    const flowChildren = region.flowChildren;
    const nativeChildOwners = region.nativeChildOwners;
    assert.ok(flowChildren, `flow projection ${region.ownerId} must retain compiler-authored child spans`);
    assert.ok(nativeChildOwners, `flow projection ${region.ownerId} must assign native child owners`);
    assert.strictEqual(nativeChildOwners.length, flowChildren.length);
    assert.ok(nativeChildOwners.every((owner) => owner !== null), `Markdown flow children must have native owners for ${region.ownerId}`);
    return flowChildren.map((child) => content.slice(child.from, child.to));
  });
  assert.deepStrictEqual(projectedChildSources, [
    ["Inline **bold** with a list:", "- Alpha\n- Beta\n- Gamma"],
    ["| Model | Latency (ms) | Notes |\n| --- | --- | --- |\n| A | 12 | fast |\n| B | 24 | medium |"],
    ["> Blockquote inside MDX", "`inline code` and **strong** text"],
  ], "consumer projection must preserve each compiler-authored native Markdown child source");

  const markup = renderToStaticMarkup(
    React.createElement(
      TrustedMdxServerRegionProvider,
      { regions: projection.regions },
      React.createElement(MarkdownBlocksRenderer, { blocks }),
    ),
  );
  const previewBodies = Array.from(
    markup.matchAll(/<figure\b[^>]*data-preview="true"[^>]*>([\s\S]*?)<\/figure>/g),
    ([, body]) => body ?? "",
  );
  assert.strictEqual(previewBodies.length, 3, "all three flow roots must render through their compiler-authored Preview figures");
  assert.match(previewBodies[0] ?? "", /Inline <strong>bold<\/strong> with a list:/);
  assert.match(previewBodies[0] ?? "", /<ul\b/);
  assert.match(previewBodies[0] ?? "", /Alpha[\s\S]*Beta[\s\S]*Gamma/);
  assert.match(previewBodies[1] ?? "", /<table\b/);
  assert.match(previewBodies[1] ?? "", /Model[\s\S]*Latency[\s\S]*medium/);
  assert.match(previewBodies[2] ?? "", /<blockquote\b/);
  assert.match(previewBodies[2] ?? "", /<code\b[^>]*>inline code<\/code>/);
  assert.match(previewBodies[2] ?? "", /<strong>strong<\/strong> text/);
  assert.strictEqual(
    (markup.match(/<pre\b/g) ?? []).length,
    3,
    "all three authored fenced code blocks must remain visible beside the MDX flow roots",
  );
  assert.strictEqual(
    (markup.match(/<figure\b/g) ?? []).length,
    3,
    "all three Preview roots must render their authored figure element",
  );

}

async function runNativeCodeSourceOwnershipTest(): Promise<void> {
  const content = await loadFixture("code-huge.md");
  const codeFence = /```js\r?\n([\s\S]*?)\r?\n```/.exec(content);
  assert.ok(codeFence, "expected the authored JavaScript fence in the source fixture");
  const expectedCode = codeFence[1];
  const expectedLines = expectedCode.split(/\r\n|\r|\n/);
  const bodyStart = codeFence.index + codeFence[0].indexOf(expectedCode);
  const closingFenceStart = codeFence.index + codeFence[0].length - 3;
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: { ...DOC_PLUGINS, codeHighlighting: "final", outputMode: "html", lazyTokenization: { enabled: false } }, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.resetSnapshot(init.snapshot);

  const assertNativeSourceMatchesFixture = (phase: string) => {
    const block = store.getBlocks().find((candidate) => candidate.type === "code");
    if (!block) return;
    const owner = store.getCodeBlock(block.id);
    assert.ok(owner, `${phase}: expected a native code owner`);
    const rows = store.getCodeLines(block.id, 0, owner.source.lineCount);
    assert.strictEqual(rows.length, owner.source.lineCount, `${phase}: source range must expose every owned code line`);
    const ownerRange = owner.source.sourceRange;
    assert.ok(
      rows.every((line) => ownerRange.from <= line.sourceRange.from && line.sourceRange.to <= ownerRange.to),
      `${phase}: source owner must bound every authored line record`,
    );
    for (const line of rows) {
      const { from, to } = line.sourceRange;
      assert.ok(
        from >= bodyStart && to + line.ending.length <= closingFenceStart,
        `${phase}: native line range must remain within the authored fence body`,
      );
      assert.strictEqual(content.slice(from, to), line.text, `${phase}: native line text must match authored source`);
      assert.strictEqual(content.slice(to, to + line.ending.length), line.ending, `${phase}: native line ending must match authored source`);
    }
  };

  for (let index = 0; index < content.length; index += 37) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 37) });
    applyPatchMessages(store, appendMessages);
    assertNativeSourceMatchesFixture(`APPEND @${index}`);
    assert.deepStrictEqual(store.getInvariantViolations(), [], `renderer store must preserve source invariants during APPEND @${index}`);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  assertNativeSourceMatchesFixture("FINALIZE");
  const codeBlock = store.getBlocks().find((candidate) => candidate.type === "code");
  assert.ok(codeBlock, "expected finalized native code block");
  const owner = store.getCodeBlock(codeBlock.id);
  assert.ok(owner);
  assert.strictEqual(owner.source.state, "finalized");
  const rows = store.getCodeLines(codeBlock.id, 0, owner.source.lineCount);
  assert.deepStrictEqual(rows.map((line) => line.text), expectedLines, "final source lines must preserve the entire authored fixture body");
  assert.deepStrictEqual(store.getInvariantViolations(), []);
}

async function runFinalizedTableShapeTest(): Promise<void> {
  const blocks = await streamFixture(await loadFixture("table-boundary.md"), 29);
  const table = blocks.find((block) => block.type === "table");
  assert.ok(table, "expected finalized table block");
  const meta = (table?.payload.meta ?? {}) as { header?: unknown[][]; rows?: unknown[][][] };
  const headerColumns = Array.isArray(meta.header) ? meta.header.length : 0;
  assert.ok(headerColumns > 0, "expected table header columns");
  const rows = Array.isArray(meta.rows) ? meta.rows : [];
  assert.ok(rows.length > 0, "expected finalized table body rows");
  rows.forEach((row, rowIndex) => {
    assert.strictEqual(row.length, headerColumns, `finalized table row ${rowIndex} width mismatch`);
  });
}



function hasMathInline(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const kind = (node as { kind?: unknown }).kind;
    if (kind === "math-inline" || kind === "math-display") {
      return true;
    }
    if (hasMathInline((node as { children?: unknown }).children)) {
      return true;
    }
  }
  return false;
}

async function runCurrencyDoesNotTriggerStreamingMathTest(): Promise<void> {
  const content = await loadFixture("table-large.md");
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: DOC_PLUGINS, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.resetSnapshot(init.snapshot);

  for (let index = 0; index < content.length; index += 34) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 34) });
    applyPatchMessages(store, appendMessages);
    const provisionalParagraphs = store
      .getBlocks()
      .filter((block) => block.type === "paragraph" && !block.isFinalized && typeof block.payload.raw === "string");
    for (const block of provisionalParagraphs) {
      const raw = block.payload.raw as string;
      if (!raw.includes("$")) continue;
      assert.ok(!hasMathInline(block.payload.inline), `currency-like streaming paragraph must not produce math nodes: ${raw}`);
      const ranges = Array.isArray((block.payload.meta as { protectedRanges?: unknown } | undefined)?.protectedRanges)
        ? (((block.payload.meta as { protectedRanges?: unknown }).protectedRanges as Array<{ kind?: unknown }>) ?? [])
        : [];
      assert.ok(
        !ranges.some((range) => range?.kind === "math-inline"),
        `currency-like streaming paragraph must not carry inline math protected ranges: ${raw}`,
      );
    }
  }
}

async function runFinalizedMdxStateTest(): Promise<void> {
  const cases: Array<{ fixture: string; chunkSize: number; minMdxCount: number }> = [
    { fixture: "mdx-transitions.mdx", chunkSize: 31, minMdxCount: 3 },
    { fixture: "mdx-transitions.mdx", chunkSize: 5, minMdxCount: 3 },
    { fixture: "mdx-multi-status.mdx", chunkSize: 10, minMdxCount: 2 },
    { fixture: "mdx-multi-status.mdx", chunkSize: 24, minMdxCount: 2 },
  ];

  for (const { fixture, chunkSize, minMdxCount } of cases) {
    const content = await loadFixture(fixture);
    const blocks = await streamFixture(content, chunkSize, { contentPolicy: "trusted-mdx" });
    const mdxBlocks = blocks.filter((block) => block.type === "mdx");
    assert.ok(mdxBlocks.length >= minMdxCount, `expected at least ${minMdxCount} mdx blocks for ${fixture} @${chunkSize}, got ${mdxBlocks.length}`);
    if (fixture === "mdx-transitions.mdx") {
      await assertTrustedMdxFlowProjection(content, blocks);
    }

    const rootRanges = blocks.flatMap((block) => {
      const range = block.payload.range;
      return range ? [{ block, range }] : [];
    });
    for (let index = 1; index < rootRanges.length; index += 1) {
      const previous = rootRanges[index - 1]!;
      const current = rootRanges[index]!;
      assert.ok(
        previous.range.to <= current.range.from,
        `root blocks must keep disjoint authored source order: ${previous.block.id} then ${current.block.id}`,
      );
    }
    for (const block of mdxBlocks) {
      assert.ok(block.isFinalized, `mdx block must be finalized: ${block.id}`);
      const range = block.payload.range;
      assert.ok(range, `mdx block must retain its authored source range: ${block.id}`);
      assert.strictEqual(content.slice(range.from, range.to), block.payload.raw, `mdx block source must match its authored range: ${block.id}`);
    }
  }
}

async function runMdxTransitionsRendererStoreInvariantTest(): Promise<void> {
  const content = await loadFixture("mdx-transitions.mdx");
  const authoredCode = Array.from(content.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g), (match) => {
    const from = match.index + match[0].indexOf(match[1]);
    return {
      from,
      closingFenceFrom: match.index + match[0].length - 3,
      text: match[1],
    };
  });
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: DOC_PLUGINS, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.resetSnapshot(init.snapshot);

  const assertCodeSourcesMatchAuthoredRanges = (phase: string) => {
    for (const block of store.getBlocks().filter((candidate) => candidate.type === "code")) {
      const owner = store.getCodeBlock(block.id);
      assert.ok(owner, `${phase}: expected a native code owner for ${block.id}`);
      const ownerRange = owner.source.sourceRange;
      const rows = store.getCodeLines(block.id, 0, owner.source.lineCount);
      assert.strictEqual(rows.length, owner.source.lineCount, `${phase}: native source range must expose each line`);
      assert.ok(
        rows.every((line) => ownerRange.from <= line.sourceRange.from && line.sourceRange.to <= ownerRange.to),
        `${phase}: native code owner must bound its line records`,
      );
      for (const line of rows) {
        const { from, to } = line.sourceRange;
        assert.ok(
          authoredCode.some((range) => from >= range.from && to + line.ending.length <= range.closingFenceFrom),
          `${phase}: native line range must remain within an authored code body`,
        );
        assert.strictEqual(content.slice(from, to), line.text, `${phase}: native line must preserve authored source text`);
        assert.strictEqual(
          content.slice(to, to + line.ending.length),
          line.ending,
          `${phase}: native line must preserve its authored line ending`,
        );
      }
    }
  };

  for (let index = 0; index < content.length; index += 31) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 31) });
    applyPatchMessages(store, appendMessages);
    assertCodeSourcesMatchAuthoredRanges(`APPEND @${index}`);
    assert.deepStrictEqual(store.getInvariantViolations(), [], `renderer store must preserve all invariants during MDX transition chunk @${index}`);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  assertCodeSourcesMatchAuthoredRanges("FINALIZE");
  const codeBlocks = store.getBlocks().filter((block) => block.type === "code");
  const finalizedSourceLines = codeBlocks.map((block, index) => {
    const owner = store.getCodeBlock(block.id);
    assert.ok(owner, `finalized code fence ${index} must retain its native owner`);
    assert.strictEqual(owner.source.state, "finalized");
    return store.getCodeLines(block.id, 0, owner.source.lineCount).map((line) => line.text);
  });
  assert.deepStrictEqual(
    finalizedSourceLines,
    authoredCode.map((fence) => fence.text.split(/\r\n|\r|\n/)),
    "every authored code fence must retain its finalized native source lines",
  );
  assert.deepStrictEqual(store.getInvariantViolations(), [], "renderer store must preserve all invariants through MDX transition finalization");
}

async function runNativeNestedSnapshotMappingTest(): Promise<void> {
  const nativeNestedSourceText = [
    "lead 😀",
    "> **Quoted paragraph**",
    "> continuation",
    ">",
    "> Authored space\u0020",
    "> after",
    ">",
    "> 3. [x] item",
    ">",
    ">    list paragraph",
    ">    continuation",
    ">",
    ">    | Name | Count |",
    ">    | :--- | ---: |",
    ">    | alpha | 2 |",
    "",
  ].join("\r\n");
  const nativeNestedDocument = new AppendSourceDocument();
  nativeNestedDocument.append(nativeNestedSourceText);
  const nativeNestedSource = nativeNestedDocument.snapshot();
  const nativeNestedInput = new NativeMarkdownInput(nativeNestedSource);
  const nativeNestedTree = nativeNestedInput.parse(nativeParser);
  let nativeQuote = nativeNestedTree.topNode.firstChild;
  while (nativeQuote && nativeQuote.type.name !== "Blockquote") nativeQuote = nativeQuote.nextSibling;
  assert.ok(nativeQuote, "canonical native parsing must preserve the quoted container");
  const nativeNestedBlock: Block = {
    id: "direct-native-container",
    type: "blockquote",
    isFinalized: true,
    payload: {
      raw: "",
      range: { from: nativeQuote.from, to: nativeQuote.to },
    },
  };
  const nativeNestedPrepared = prepareNestedBlockSnapshotFromNative(
    nativeNestedBlock,
    nativeQuote,
    {
      input: nativeNestedInput,
      source: nativeNestedSource,
      mapOffset: (offset) => offset,
      mapRange: (from, to) => ({ from, to }),
    },
    new InlineParser(),
    nativeParser,
  );
  nativeNestedBlock.payload.meta = { preparedNested: nativeNestedPrepared };
  const nativeNestedNodes = flatten(createBlockSnapshot(nativeNestedBlock));
  const nativeParagraph = nativeNestedNodes.find((node) =>
    node.type === "paragraph" && String(node.props?.text).includes("Quoted paragraph"));
  assert.ok(nativeParagraph, "native lowering must retain the quoted paragraph");
  assert.equal(
    String(nativeParagraph.props?.text).replace(/\r\n/g, "\n"),
    "Quoted paragraph\ncontinuation",
    "native quoted paragraph meaning must exclude CRLF artifacts",
  );
  const nativeParagraphBlock = nativeParagraph.props?.block as Block;
  const nativeParagraphRange = nativeParagraphBlock.payload.range!;
  assert.equal(
    nativeParagraphBlock.payload.raw,
    nativeNestedSource.read(nativeParagraphRange.from, nativeParagraphRange.to),
    "native paragraph raw must equal its physical UTF-16 source range",
  );
  assert.ok(nativeParagraphBlock.payload.raw.includes("**Quoted paragraph**"), "native paragraph source must retain authored emphasis");
  const nativeAuthoredSpaceParagraph = nativeNestedNodes.find((node) =>
    node.type === "paragraph" && String(node.props?.text).includes("Authored space"));
  assert.ok(nativeAuthoredSpaceParagraph, "native lowering must retain the authored-space paragraph");
  assert.equal(
    String(nativeAuthoredSpaceParagraph.props?.text),
    "Authored space \nafter",
    "native semantic projection must preserve authored spaces while excluding CRLF artifacts",
  );
  const nativeAuthoredSpaceBlock = nativeAuthoredSpaceParagraph.props?.block as Block;
  assert.ok(
    nativeAuthoredSpaceBlock.payload.raw.includes("Authored space \r\n"),
    "native physical paragraph source must retain authored space and CRLF",
  );

  const nativeList = nativeNestedNodes.find((node) => node.type === "list");
  assert.ok(nativeList, "native lowering must retain the nested ordered list");
  assert.equal(nativeList.props?.ordered, true, "quoted list must remain ordered");
  assert.equal(nativeList.props?.start, 3, "quoted ordered list must retain its authored start");
  assert.equal(nativeList.props?.loose, true, "quoted list must retain loose-list meaning");
  const nativeTaskItem = nativeList.children?.find((node) => node.type === "list-item");
  assert.ok(nativeTaskItem, "native lowering must retain the task list item");
  assert.equal(nativeTaskItem.props?.task, true, "quoted list item must retain task semantics");
  assert.equal(nativeTaskItem.props?.checked, true, "quoted task item must retain its checked state");
  assert.equal(nativeTaskItem.props?.text, "item", "quoted task item text must exclude its task marker");
  assert.equal(nativeTaskItem.children?.some((node) => node.type === "table"), true, "quoted task item must retain its nested typed table");
  const nativeListParagraph = nativeTaskItem.children?.find((node) => node.type === "paragraph");
  assert.ok(nativeListParagraph, "native lowering must retain the list paragraph");
  assert.equal(
    String(nativeListParagraph.props?.text).replace(/\r\n/g, "\n"),
    "list paragraph\ncontinuation",
    "native list paragraph meaning must exclude CRLF artifacts",
  );
  const nativeListParagraphBlock = nativeListParagraph.props?.block as Block;
  const nativeListParagraphRange = nativeListParagraphBlock.payload.range!;
  assert.equal(
    nativeListParagraphBlock.payload.raw,
    nativeNestedSource.read(nativeListParagraphRange.from, nativeListParagraphRange.to),
    "native list paragraph raw must equal its physical UTF-16 source range",
  );
  assert.ok(nativeListParagraphBlock.payload.raw.includes("\r\n"), "native list paragraph raw must retain authored CRLF");
  assert.notEqual(nativeListParagraphBlock.payload.raw, nativeListParagraph.props?.text, "physical source must remain distinct from rendered text");

  const nativeTable = nativeNestedNodes.find((node) => node.type === "table");
  assert.ok(nativeTable, "native lowering must retain the nested typed table");
  assert.deepEqual(
    (nativeTable.props?.block as Block).payload.meta?.align,
    ["left", "right"],
    "native table alignment must preserve authored column alignment",
  );
  const nativeTableHeader = nativeTable.children?.find((node) => node.type === "table-header");
  assert.deepEqual(
    nativeTableHeader?.children?.map((cell) => cell.props?.text),
    ["Name", "Count"],
    "native table header must preserve both typed cell values",
  );
  const nativeTableRows = nativeTable.children?.find((node) => node.type === "table-body")?.children;
  assert.deepEqual(
    nativeTableRows?.[0]?.children?.map((cell) => cell.props?.text),
    ["alpha", "2"],
    "native table body must preserve typed row cell values",
  );
}
async function runNativeHtmlFamilyScopeTest(): Promise<void> {
  const chunks = [
    '<div title="Native scope">\n\n| Name | Value |\n| --- | --- |\n',
    "| alpha | one |\n",
    "| beta | two |\n\nParagraph **inside**.\n",
    "\n</div>\n",
  ];
  const source = chunks.join("");
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initialized = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { html: true, tables: true, mdx: false, math: false, callouts: false, footnotes: false },
  });
  const init = initialized.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> =>
    message.type === "INITIALIZED");
  assert.ok(init, "HTML family consumer requires an actual worker baseline");
  store.resetSnapshot(init.snapshot);

  const assertRenderedMeaning = (requireHtmlScope: boolean) => {
    const html = renderToStaticMarkup(createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), store }));
    const dom = new JSDOM(html);
    try {
      const document = dom.window.document;
      const rows = (parent: ParentNode) => [...parent.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent));
      const expectedRows = [["alpha", "one"], ["beta", "two"]];
      assert.deepEqual(rows(document), expectedRows, "native table rendering must neither lose nor duplicate rows");
      if (requireHtmlScope) {
        const scope = document.querySelector('div[title="Native scope"]');
        assert.ok(scope, "authored HTML scope must survive finalization");
        assert.deepEqual(rows(scope), expectedRows, "the table must render inside its authored HTML scope");
        const paragraph = scope.querySelector("p");
        assert.equal(paragraph?.textContent, "Paragraph inside.", "the paragraph must render in its authored HTML scope");
        assert.equal(paragraph?.querySelector("strong")?.textContent, "inside", "authored HTML rendering must retain inline meaning");
      }
    } finally {
      dom.window.close();
    }
  };

  for (const text of chunks) {
    applyPatchMessages(store, await harness.send({ type: "APPEND", text }));
    assert.deepEqual(store.getInvariantViolations(), [], "HTML append must preserve renderer store invariants");
  }
  assertRenderedMeaning(false);
  const finalized = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalized);
  assert.deepEqual(store.getInvariantViolations(), [], "HTML finalization must preserve renderer store invariants");
  assert.ok(finalized.some((message) => message.type === "FINALIZED"), "HTML family consumer requires actual completion");
  assertRenderedMeaning(true);
}

async function runHtmlBackslashAttributeOwnershipTest(): Promise<void> {
  const paragraphText = "Native paragraph inside the authored div.";
  const content = `<div title="C:\\">\n\n${paragraphText}\n\n</div>\n`;
  const blocks = await streamFixture(content, 11, {
    contentPolicy: "markdown",
    html: { allowedTags: { div: ["title"] } },
  });
  const markup = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks }));
  const dom = new JSDOM(markup);
  try {
    const wrapper = [...dom.window.document.querySelectorAll("div[title]")]
      .find((node) => node.getAttribute("title") === "C:\\");
    const paragraph = [...dom.window.document.querySelectorAll("p")]
      .find((node) => node.textContent === paragraphText);
    assert.ok(wrapper, "the authored HTML div must render");
    assert.ok(paragraph, "the blank-line-separated native paragraph must render");
    assert.ok(wrapper.contains(paragraph), "the native paragraph must remain inside the authored div");
  } finally {
    dom.window.close();
  }
}


async function runSeededMdxTransitionsProjectionTest(): Promise<void> {
  const content = await loadFixture("mdx-transitions.mdx");
  const chunks = buildSeededChunks(content, {
    id: "S2_typical",
    label: "Typical streaming",
    updateIntervalMs: 16,
    charRateCps: 1200,
    maxChunkChars: 256,
  }, "mdx-transitions:S2_typical:seed-2");
  const blocks = await streamFixtureChunks(content, chunks, { contentPolicy: "trusted-mdx" });
  await assertTrustedMdxFlowProjection(content, blocks);
}


async function runTrustedMdxFootnotePhaseTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initialize = async () => {
    const messages = await harness.send({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent: "",
      prewarmLangs: [],
      docPlugins: DOC_PLUGINS,
      contentPolicy: "trusted-mdx",
    });
    const init = messages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
    assert.ok(init, "worker failed to initialize trusted MDX footnote document");
    store.resetSnapshot(init.snapshot);
  };
  await initialize();

  const initialContent = [
    "Earlier[^early].",
    "",
    "[^early]: Earlier definition.",
    "",
    "<Preview>",
    "Native child[^late].",
    "</Preview>",
    "",
    "",
  ].join("\n");
  const fullContent = `${initialContent}[^late]: Later definition.\n`;
  applyPatchMessages(store, await harness.send({ type: "APPEND", text: initialContent }));
  const previousBlocks = store.getBlocks();
  const previousRoot = previousBlocks.find((block) => block.type === "mdx");
  assert.ok(previousRoot, "expected completed trusted MDX flow root before its later definition");
  assert.ok(previousRoot.isFinalized, "native child root must be complete before its later definition arrives");
  const Preview = ({ children }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("section", { "data-preview": "true" }, children);
  const render = async (source: string, blocks: readonly Block[]) => {
    const artifact = await compileTrustedMdxDocument(source);
    const projection = await projectTrustedMdxServerDocument({
      source,
      blocks,
      artifact,
      components: { Preview },
    });
    return renderToStaticMarkup(
      React.createElement(
        TrustedMdxServerRegionProvider,
        { regions: projection.regions },
        React.createElement(MarkdownBlocksRenderer, { blocks }),
      ),
    );
  };

  const beforeDefinition = await render(initialContent, previousBlocks);
  assert.match(beforeDefinition, /Native child\[\^late\]/, "unresolved native-child reference should remain literal");
  assert.doesNotMatch(beforeDefinition, /id="fnref:2"/, "unresolved native-child reference must not publish an anchor");

  applyPatchMessages(store, await harness.send({ type: "APPEND", text: fullContent.slice(initialContent.length) }));
  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  const firstDocumentBlocks = store.getBlocks();
  const firstDocumentRoot = firstDocumentBlocks.find((block) => block.type === "mdx");
  assert.strictEqual(firstDocumentRoot?.id, previousRoot.id, "later definition should update the same completed MDX root");
  const afterDefinition = await render(fullContent, firstDocumentBlocks);
  assert.match(afterDefinition, /Native child<sup class="footnote-ref"><a[^>]*>2<\/a><\/sup>/);
  assert.match(afterDefinition, /href="#fn:2"/, "native reference should target its numbered footnote item");
  assert.match(afterDefinition, /<li id="fn:2">Later definition\./, "later definition should publish the matching numbered item");
  assert.match(afterDefinition, /href="#fnref:2"[^>]*class="footnote-backref"/, "numbered item should backlink to the native reference");
  assert.strictEqual(
    await render(initialContent, previousBlocks),
    beforeDefinition,
    "updating the completed root must not mutate its previously emitted snapshot",
  );

  await initialize();
  const resetContent = "<Preview>\nNative child[^late].\n</Preview>\n\n[^late]: Reset definition.\n";
  applyPatchMessages(store, await harness.send({ type: "APPEND", text: resetContent }));
  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  const resetMarkup = await render(resetContent, store.getBlocks());
  assert.match(resetMarkup, /Native child<sup class="footnote-ref"><a[^>]*>1<\/a><\/sup>/);
  assert.match(resetMarkup, /<li id="fn:1">Reset definition\./, "INIT must assign numbering from the new document context");
  assert.doesNotMatch(resetMarkup, /fnref:2|fn:2/, "previous document numbering must not leak across INIT");
}


await runNativeNestedSnapshotMappingTest();
await runNativeCodeSourceOwnershipTest();
await runCurrencyDoesNotTriggerStreamingMathTest();
await runFinalizedTableShapeTest();
await runHtmlBackslashAttributeOwnershipTest();
await runFinalizedMdxStateTest();
await runSeededMdxTransitionsProjectionTest();
await runTrustedMdxFootnotePhaseTest();
await runMdxTransitionsRendererStoreInvariantTest();
await runNativeHtmlFamilyScopeTest();
console.log("worker structural regressions test passed");
