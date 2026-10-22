import assert from "node:assert";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import React from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { compileTrustedMdxDocument } from "../src/mdx-compile";
import { projectTrustedMdxServerDocument } from "../../markdown-v2-react/src/trusted-mdx/server";
import {
  MarkdownBlocksRenderer,
  TrustedMdxServerRegionProvider,
} from "../../markdown-v2-react/src/server";

import { applyPatchBatch, createInitialSnapshot, type Block, type HtmlOptions, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";

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
): Promise<Block[]> {
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
): Promise<Block[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
    contentPolicy: options.contentPolicy,
    html: options.html,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.reset(init.blocks);

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

async function runAppendLinesTailGuardTest(): Promise<void> {
  const content = await loadFixture("code-huge.md");
  const harness = await createWorkerHarness();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");

  const snapshot = createInitialSnapshot(init.blocks);
  let appendLinesCount = 0;

  const applyMessages = (messages: WorkerOut[]) => {
    for (const message of messages) {
      if (message.type !== "PATCH") continue;
      for (const patch of message.patches as Patch[]) {
        if (patch.op === "appendLines") {
          const parentId = patch.at.nodeId ?? patch.at.blockId;
          const parent = snapshot.nodes.get(parentId);
          assert.ok(parent, `missing code parent for appendLines: ${parentId}`);
          assert.strictEqual(parent?.type, "code", "appendLines target must remain a code node");
          assert.strictEqual(patch.startIndex, parent?.children.length ?? -1, "appendLines must be a strict tail append");
          appendLinesCount += 1;
        }
        snapshot.blocks = applyPatchBatch(snapshot, [patch]);
      }
    }
  };

  for (let index = 0; index < content.length; index += 37) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 37) });
    applyMessages(appendMessages);
  }

  applyMessages(await harness.send({ type: "FINALIZE" }));
  assert.ok(appendLinesCount > 0, "expected appendLines patches to be emitted for streaming code");
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


async function runStreamingTableDeferralTest(): Promise<void> {
  const content = await loadFixture("table-boundary.md");
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.reset(init.blocks);

  for (let index = 0; index < content.length; index += 29) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 29) });
    applyPatchMessages(store, appendMessages);
    const partialTable = store.getBlocks().find((block) => block.type === "table" && !block.isFinalized);
    assert.ok(!partialTable, "table blocks must not materialize while still streaming");
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  assert.ok(store.getBlocks().some((block) => block.type === "table"), "expected table block after finalization");
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

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.reset(init.blocks);

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

    for (const block of mdxBlocks) {
      assert.ok(block.isFinalized, `mdx block must be finalized: ${block.id}`);
    }
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
      initialContent: "",
      prewarmLangs: [],
      docPlugins: DOC_PLUGINS,
      contentPolicy: "trusted-mdx",
    });
    const init = messages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
    assert.ok(init, "worker failed to initialize trusted MDX footnote document");
    store.reset(init.blocks);
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


async function runMdxTransitionsRendererStoreInvariantTest(): Promise<void> {
  const content = await loadFixture("mdx-transitions.mdx");
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
    contentPolicy: "trusted-mdx",
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.reset(init.blocks);

  for (let index = 0; index < content.length; index += 31) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 31) });
    for (const message of appendMessages) {
      if (message.type !== "PATCH") continue;
      const patches = message.patches as Patch[];

      const appendIndices = new Map<string, number>();
      const setPropsIndices = new Map<string, number>();
      patches.forEach((patch, patchIndex) => {
        const targetId = patch.at.nodeId ?? patch.at.blockId;
        if (patch.op === "appendLines") {
          appendIndices.set(targetId, patchIndex);
        } else if (patch.op === "setProps") {
          const blockCandidate = (patch.props as { block?: unknown } | undefined)?.block;
          if (blockCandidate && typeof blockCandidate === "object") {
            setPropsIndices.set(targetId, patchIndex);
          }
        }
      });

      for (const [targetId, appendIndex] of appendIndices) {
        const setPropsIndex = setPropsIndices.get(targetId);
        if (setPropsIndex !== undefined) {
          assert.ok(
            appendIndex < setPropsIndex,
            `appendLines must precede block setProps for ${targetId} (append=${appendIndex}, setProps=${setPropsIndex})`,
          );
        }
      }

      store.applyPatches(patches, { captureMetrics: false });
      const violations = store
        .getInvariantViolations()
        .filter((message) => message.includes("appendLines guard rejected"));
      assert.deepStrictEqual(violations, [], `renderer store rejected appendLines during mdx-transitions chunk @${index}`);
    }
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  const finalViolations = store
    .getInvariantViolations()
    .filter((message) => message.includes("appendLines guard rejected"));
  assert.deepStrictEqual(finalViolations, [], "renderer store rejected appendLines during mdx-transitions finalize");
}



await runAppendLinesTailGuardTest();
await runStreamingTableDeferralTest();
await runCurrencyDoesNotTriggerStreamingMathTest();
await runFinalizedTableShapeTest();
await runHtmlBackslashAttributeOwnershipTest();
await runFinalizedMdxStateTest();
await runSeededMdxTransitionsProjectionTest();
await runTrustedMdxFootnotePhaseTest();
await runMdxTransitionsRendererStoreInvariantTest();
console.log("worker structural regressions test passed");
