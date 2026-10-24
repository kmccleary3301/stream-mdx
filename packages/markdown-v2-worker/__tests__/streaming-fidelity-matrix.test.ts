import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import type { Block, Patch, RestrictedComponentDescriptor, SyntaxExtensionDescriptor, WorkerOut } from "@stream-mdx/core";
import { ComponentRegistry } from "@stream-mdx/react";
import { stripCodeFence } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import { JSDOM } from "jsdom";

import { createWorkerHarness } from "./worker-test-harness";
import { projectFootnotePublication, publishedFootnoteLabels } from "./footnote-publication";
import { projectConsumerBlocks } from "./consumer-block-projection";
import type { ConsumerBlockProjection } from "./consumer-block-projection";
import syntaxDemo from "../../../apps/docs/lib/streaming-syntax-demo.tsx";

const {
  createStreamingSyntaxDemoRegistry,
  STREAMING_SYNTAX_DEMO,
  STREAMING_SYNTAX_DEMO_MARKDOWN,
  STREAMING_SYNTAX_DEMO_WORKER_COMPONENTS,
} = syntaxDemo;

type CreditProfile = (chunkIndex: number) => number;

type PartialSyntaxState = {
  consumedChars: number;
  sourceTail: string;
  closer: string;
  forbiddenMarkup?: string;
};

type SyntaxReplayOptions = {
  descriptor: SyntaxExtensionDescriptor;
  workerComponents: RestrictedComponentDescriptor[];
  componentRegistry: ComponentRegistry;
  partialStates?: readonly PartialSyntaxState[];
};

type Scenario = {
  name: string;
  doc: string;
  chunkSize: number;
  preAppendCredit: CreditProfile;
  postAppendCredit?: CreditProfile;
  postAppendEvery?: number;
};

const STABILITY_MARGIN_CHARS = 320;

const SYNTAX_DEMO_DOC = STREAMING_SYNTAX_DEMO_MARKDOWN;

const SYNTAX_DEMO_REPLAY: SyntaxReplayOptions = {
  descriptor: STREAMING_SYNTAX_DEMO,
  workerComponents: STREAMING_SYNTAX_DEMO_WORKER_COMPONENTS,
  componentRegistry: createStreamingSyntaxDemoRegistry(),
  partialStates: [
    {
      consumedChars: SYNTAX_DEMO_DOC.indexOf("==highlight==") + "==hi".length,
      sourceTail: "==hi",
      closer: "==",
    },
    {
      consumedChars: SYNTAX_DEMO_DOC.indexOf(":::note") + ":::no".length,
      sourceTail: ":::no",
      closer: ":::",
      forbiddenMarkup: 'data-syntax-container="note"',
    },
  ],
};

function ensureDom(): void {
  if (typeof window !== "undefined") return;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    navigator: { configurable: true, writable: true, value: dom.window.navigator },
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Node: { configurable: true, value: dom.window.Node },
  });
}

function resolveDemoFixturePath(): string {
  const relativeFixturePath = path.join("apps", "docs", "app", "demo", "naive-bayes-classifier.mdx");
  let cursor = process.cwd();
  while (true) {
    const candidate = path.join(cursor, relativeFixturePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Unable to locate ${relativeFixturePath} from ${process.cwd()}`);
}

function applyPatchMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type !== "PATCH") continue;
    store.applyPatches(message.patches as Patch[]);
  }
}

function renderColdBlocks(blocks: ReadonlyArray<Block>, componentRegistry?: ComponentRegistry): string {
  const coldExport = [...blocks];
  const store = createRendererStore(coldExport);
  return renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, {
    blocks: coldExport,
    store,
    ...(componentRegistry ? { componentRegistry } : {}),
  }));
}

function assertFootnotePublication(blocks: ReadonlyArray<Block>, label: string): void {
  const published = publishedFootnoteLabels(blocks);
  const footerItems = blocks.find((block) => block.type === "footnotes")?.payload.meta?.items as Array<{ label: string; number: number }> | undefined;
  const footerNumbers = new Map((footerItems ?? []).map((item) => [item.label, item.number]));
  JSON.stringify(blocks, (_key, value) => {
    if (value?.kind === "footnote-ref" && typeof value.defined === "boolean") {
      assert.strictEqual(value.defined, published.has(value.label), `[${label}] footnote publication flag must match its actual footer label`);
    }
    return value;
  });
  const visible = blocks.filter((block) => block.type === "footnotes" || JSON.stringify(block).includes('"kind":"footnote-ref"'));
  if (visible.length === 0) return;
  const dom = new JSDOM(renderColdBlocks(visible));
  try {
    const ids = [...dom.window.document.querySelectorAll<HTMLElement>("[id]")].map((node) => node.id);
    assert.strictEqual(new Set(ids).size, ids.length, `[${label}] rendered footnote IDs must be unique`);
    for (const anchor of dom.window.document.querySelectorAll<HTMLAnchorElement>("sup.footnote-ref a, a.footnote-backref")) {
      assert.ok(dom.window.document.getElementById(anchor.hash.slice(1)), `[${label}] rendered footnote link must target an actual published occurrence or definition`);
    }
    for (const anchor of dom.window.document.querySelectorAll<HTMLAnchorElement>("sup.footnote-ref a")) {
      assert.ok(published.has(anchor.dataset.footnoteLabel ?? anchor.dataset.label ?? ""), `[${label}] unresolved references must not render premature links`);
      const number = footerNumbers.get(anchor.dataset.label ?? "");
      assert.strictEqual(anchor.hash, `#fn:${number}`, `[${label}] rendered reference must target its own label, not merely an existing definition`);
      assert.strictEqual(anchor.textContent, String(number), `[${label}] visible reference number must match its actual definition`);
    }
  } finally {
    dom.window.close();
  }
}

const COVERAGE_DOC = [
  "# Streaming Coverage Fixture",
  "",
  "- Parent list item",
  "  1. Nested ordered with *italic* emphasis",
  "  2. Nested ordered with **bold** marker handling",
  "- Sibling list item with inline MDX: <InlineChip tone=\"warm\">Hot</InlineChip>",
  "",
  "<Callout tone=\"info\">MDX block body with `inline code` and **formatting**.</Callout>",
  "",
  "| key | value | notes |",
  "| --- | --- | --- |",
  "| alpha | 1 | first row |",
  "| beta | 2 | second row |",
  "| gamma | 3 | third row |",
  "",
  "```ts",
  "export function stableCodeOrder(input: number): number {",
  "  const squared = input * input;",
  "  return squared + 1;",
  "}",
  "```",
  "",
  "Final paragraph with footnote[^cov].",
  "",
  "[^cov]: Coverage footnote content.",
].join("\n");

function normalizeTextForCompare(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\n+$/g, "");
}

function isStableAgainstTail(block: Block | ConsumerBlockProjection | undefined, consumedChars: number): boolean {
  if (!block) return false;
  const to = "payload" in block ? block.payload.range?.to : block.range?.to;
  return typeof to === "number" && to <= Math.max(0, consumedChars - STABILITY_MARGIN_CHARS);
}

function assertFinalizedPrefixMatchesBaseline(
  currentBlocks: ReadonlyArray<Block>,
  current: ReadonlyArray<ConsumerBlockProjection>,
  baseline: ReadonlyArray<Block>,
  consumedChars: number,
  label: string,
  componentRegistry?: ComponentRegistry,
): void {
  const dirtyIndices: number[] = [];
  const dirtyDetails: string[] = [];
  for (let index = 0; index < currentBlocks.length; index += 1) {
    const block = currentBlocks[index];
    if (block.isFinalized) continue;
    dirtyIndices.push(index);
    const range = block.payload.range;
    dirtyDetails.push(`${index}:${block.id}:${block.type}:range=${range ? `${range.from}-${range.to}` : "na"}`);
  }
  assert.ok(dirtyIndices.length <= 1, `[${label}] expected at most one dirty block, found ${dirtyIndices.length} (${dirtyDetails.join(", ")})`);
  if (dirtyIndices.length === 1) {
    assert.strictEqual(dirtyIndices[0], currentBlocks.length - 1, `[${label}] dirty block must be tail`);
  }

  const finalizedCount = dirtyIndices.length === 0 ? currentBlocks.length : dirtyIndices[0];
  assert.ok(finalizedCount <= baseline.length, `[${label}] finalized prefix length (${finalizedCount}) exceeds baseline length (${baseline.length})`);
  assertFootnotePublication(currentBlocks, label);
  const published = publishedFootnoteLabels(currentBlocks);
  const expectedBlocks: Block[] = [];
  const actualProjections: ConsumerBlockProjection[] = [];
  for (let index = 0; index < finalizedCount; index += 1) {
    const expected = baseline[index];
    const actual = current[index];
    if (!isStableAgainstTail(expected, consumedChars)) continue;
    assert.ok(expected && actual, `[${label}] missing stable cold block at index ${index}`);
    expectedBlocks.push(projectFootnotePublication(expected, published));
    actualProjections.push(actual);
  }
  assert.deepStrictEqual(
    actualProjections,
    projectConsumerBlocks(expectedBlocks, componentRegistry),
    `[${label}] finalized consumer output diverged from the single-shot baseline`,
  );
}

function assertPartialSyntaxIsUncommitted(
  blocks: ReadonlyArray<Block>,
  state: PartialSyntaxState,
  componentRegistry: ComponentRegistry,
  label: string,
): void {
  const matching = blocks.filter((block) => block.payload.raw?.includes(state.sourceTail));
  assert.ok(
    matching.every((block) => !block.isFinalized),
    `[${label}] partial ${state.sourceTail} must not be committed`,
  );
  for (const block of matching) {
    assert.ok(block.payload.raw?.endsWith(state.sourceTail), `[${label}] authored source must remain exact at the partial syntax boundary`);
    assert.equal(block.payload.raw?.endsWith(state.closer), false, `[${label}] anticipation must not author a closing delimiter`);
  }
  if (state.forbiddenMarkup) {
    const rendered = projectConsumerBlocks(blocks, componentRegistry);
    assert.equal(
      rendered.some((block) => block.markup.includes(state.forbiddenMarkup ?? "")),
      false,
      `[${label}] an incomplete registered container must not render`,
    );
  }
}
function assertFinalizedBlocksImmutable(
  current: ReadonlyArray<ConsumerBlockProjection>,
  consumedChars: number,
  seen: Map<string, ConsumerBlockProjection>,
  label: string,
): void {
  for (const block of current) {
    if (!block.isFinalized || !isStableAgainstTail(block, consumedChars)) continue;
    const previous = seen.get(block.id);
    if (previous === undefined) {
      seen.set(block.id, block);
      continue;
    }
    assert.deepStrictEqual(block, previous, `[${label}] finalized consumer block changed after publication (${block.id})`);
  }
}

function assertFinalizedTableMarkupShape(blocks: ReadonlyArray<ConsumerBlockProjection>, label: string): void {
  for (const block of blocks) {
    if (block.type !== "table" || !block.isFinalized) continue;
    const dom = new JSDOM(block.markup);
    const rows = [...dom.window.document.querySelectorAll("table tr")];
    const headerRow = dom.window.document.querySelector("table thead tr");
    assert.ok(headerRow && headerRow.querySelector("th"), `[${label}] finalized table must render its authored header cells`);
    const width = headerRow.children.length;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      assert.strictEqual(rows[rowIndex].children.length, width, `[${label}] rendered table row width mismatch at row ${rowIndex}`);
    }
    dom.window.close();
  }
}

function assertNoEmptyRenderedNestedLists(blocks: ReadonlyArray<ConsumerBlockProjection>, label: string): void {
  for (const block of blocks) {
    if (block.type !== "list") continue;
    const dom = new JSDOM(block.markup);
    for (const nestedList of dom.window.document.querySelectorAll("li > ul, li > ol")) {
      assert.ok(nestedList.querySelector("li"), `[${label}] rendered nested lists must contain a list item (${block.id})`);
    }
    dom.window.close();
  }
}

function assertFinalizedCodeTextMatchesBaseline(
  current: ReadonlyArray<ConsumerBlockProjection>,
  baseline: ReadonlyArray<Block>,
  label: string,
): void {
  const baselineById = new Map(baseline.filter((block) => block.type === "code").map((block) => [block.id, block]));
  for (const block of current) {
    if (block.type !== "code" || !block.isFinalized) continue;
    const expected = baselineById.get(block.id);
    assert.ok(expected, `[${label}] missing baseline code block for ${block.id}`);
    if (!expected) continue;
    const expectedText = normalizeTextForCompare(stripCodeFence(expected.payload.raw ?? "").code);
    const dom = new JSDOM(block.markup);
    const actualText = normalizeTextForCompare(dom.window.document.querySelector("pre code")?.textContent ?? "");
    dom.window.close();
    assert.strictEqual(actualText, expectedText, `[${label}] rendered finalized code text diverged for ${block.id}`);
  }
}

async function createInitializedHarnessStore(syntax?: SyntaxReplayOptions) {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    ...(syntax
      ? {
          contentPolicy: "restricted" as const,
          contentComponents: syntax.workerComponents,
          syntax: syntax.descriptor,
        }
      : {}),
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true, formatAnticipation: true, liveCodeHighlighting: false },
  });
  const init = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(init, "worker failed to emit INITIALIZED");
  store.resetSnapshot(init.snapshot);
  applyPatchMessages(store, initMessages);
  return { harness, store };
}

async function computeBaseline(doc: string, syntax?: SyntaxReplayOptions): Promise<Block[]> {
  const { harness, store } = await createInitializedHarnessStore(syntax);
  applyPatchMessages(store, await harness.send({ type: "APPEND", text: doc }));
  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: 1 }));
  return store.getBlocks();
}

async function runScenario(scenario: Scenario, baseline: Block[], syntax?: SyntaxReplayOptions): Promise<void> {
  const { harness, store } = await createInitializedHarnessStore(syntax);
  const componentRegistry = syntax?.componentRegistry;
  const seenFinalized = new Map<string, ConsumerBlockProjection>();

  for (let index = 0, chunkIndex = 0; index < scenario.doc.length; index += scenario.chunkSize, chunkIndex += 1) {
    const preCredit = scenario.preAppendCredit(chunkIndex);
    applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: preCredit }));

    const chunk = scenario.doc.slice(index, index + scenario.chunkSize);
    applyPatchMessages(store, await harness.send({ type: "APPEND", text: chunk }));

    if (scenario.postAppendCredit && scenario.postAppendEvery && chunkIndex % scenario.postAppendEvery === 0) {
      applyPatchMessages(store, await harness.send({ type: "SET_CREDITS", credits: scenario.postAppendCredit(chunkIndex) }));
    }

    const blocks = store.getBlocks();
    const published = publishedFootnoteLabels(blocks);
    const consumerBlocks = projectConsumerBlocks(blocks.map((block) => projectFootnotePublication(block, published)), componentRegistry);
    const stepLabel = `${scenario.name}:chunk=${chunkIndex}`;
    const consumedChars = Math.min(scenario.doc.length, index + scenario.chunkSize);
    const partialState = syntax?.partialStates?.find((state) => state.consumedChars === consumedChars);
    if (partialState && componentRegistry) {
      assertPartialSyntaxIsUncommitted(blocks, partialState, componentRegistry, stepLabel);
    }
    assertFinalizedPrefixMatchesBaseline(blocks, consumerBlocks, baseline, consumedChars, stepLabel, componentRegistry);
    assertFinalizedBlocksImmutable(consumerBlocks, consumedChars, seenFinalized, stepLabel);
    assertFinalizedTableMarkupShape(consumerBlocks, stepLabel);
    assertNoEmptyRenderedNestedLists(consumerBlocks, stepLabel);
  }

  applyPatchMessages(store, await harness.send({ type: "FINALIZE" }));
  const finalBlocks = store.getBlocks();
  const published = publishedFootnoteLabels(finalBlocks);
  const finalConsumerBlocks = projectConsumerBlocks(finalBlocks.map((block) => projectFootnotePublication(block, published)), componentRegistry);
  assertFootnotePublication(finalBlocks, `${scenario.name}:final`);
  assert.strictEqual(finalBlocks.length, baseline.length, `[${scenario.name}] block count mismatch`);
  assert.deepStrictEqual(
    finalConsumerBlocks,
    projectConsumerBlocks(baseline.map((block) => projectFootnotePublication(block, published)), componentRegistry),
    `[${scenario.name}] chunked final consumer output must match complete compilation`,
  );

  const footnoteVisible = (blocks: ReadonlyArray<Block>) => blocks.filter(
    (block) => block.type === "footnotes" || JSON.stringify(block).includes('"kind":"footnote-ref"'),
  );
  assert.strictEqual(
    renderColdBlocks(footnoteVisible(finalBlocks), componentRegistry),
    renderColdBlocks(footnoteVisible(baseline), componentRegistry),
    `[${scenario.name}] finalized footnote SSR must exactly match complete compilation`,
  );
  assertFinalizedTableMarkupShape(finalConsumerBlocks, `${scenario.name}:final`);
  assertNoEmptyRenderedNestedLists(finalConsumerBlocks, `${scenario.name}:final`);
  assertFinalizedCodeTextMatchesBaseline(finalConsumerBlocks, baseline, `${scenario.name}:final`);

  const afterFinalizeCredits = await harness.send({ type: "SET_CREDITS", credits: 1 });
  applyPatchMessages(store, afterFinalizeCredits);
  const afterCredits = store.getBlocks();
  const afterPublished = publishedFootnoteLabels(afterCredits);
  assert.deepStrictEqual(
    projectConsumerBlocks(afterCredits.map((block) => projectFootnotePublication(block, afterPublished)), componentRegistry),
    finalConsumerBlocks,
    `[${scenario.name}] credits after FINALIZE must not change consumer-visible output`,
  );
}

async function runStreamingFidelityMatrixTest(): Promise<void> {
  ensureDom();
  const fixturePath = resolveDemoFixturePath();
  const fixtureRaw = await fs.readFile(fixturePath, "utf8");
  const fullDoc = fixtureRaw.replace(/^---[\s\S]*?---\s*/, "");
  const lowSpeedWindowChars = 3072;
  const lowSpeedDoc = fullDoc.slice(0, Math.min(fullDoc.length, lowSpeedWindowChars));

  const fullBaseline = await computeBaseline(fullDoc);
  const lowSpeedBaseline = await computeBaseline(lowSpeedDoc);
  const coverageBaseline = await computeBaseline(COVERAGE_DOC);
  const syntaxBaseline = await computeBaseline(SYNTAX_DEMO_DOC, SYNTAX_DEMO_REPLAY);
  const syntaxColdDom = new JSDOM(renderColdBlocks(syntaxBaseline, SYNTAX_DEMO_REPLAY.componentRegistry));
  try {
    assert.equal(
      syntaxColdDom.window.document.querySelector('[data-syntax-highlight="true"]')?.textContent,
      "highlight",
      "the demo syntax extension renders its inline rule in the cold output",
    );
    assert.equal(
      syntaxColdDom.window.document.querySelector('[data-syntax-container="note"]')?.getAttribute("data-note-title"),
      "Demo note",
      "the demo syntax extension renders its registered container in the cold output",
    );
    assert.equal(
      syntaxColdDom.window.document.querySelector('[data-syntax-container="note"]')?.getAttribute("data-component-status"),
      "closed",
      "the cold registered container receives its authored closer",
    );
  } finally {
    syntaxColdDom.window.close();
  }

  const scenarios: Array<{ scenario: Scenario; baseline: Block[]; syntax?: SyntaxReplayOptions }> = [
    {
      scenario: { name: "full-steady-89", doc: fullDoc, chunkSize: 89, preAppendCredit: () => 1 },
      baseline: fullBaseline,
    },
    {
      scenario: {
        name: "full-oscillating-233",
        doc: fullDoc,
        chunkSize: 233,
        preAppendCredit: (chunkIndex) => [1, 0.72, 0.48, 0.22, 0.65][chunkIndex % 5],
        postAppendCredit: (chunkIndex) => [0.35, 1, 0.55, 1][chunkIndex % 4],
        postAppendEvery: 2,
      },
      baseline: fullBaseline,
    },
    {
      scenario: {
        name: "prefix-low-speed-1",
        doc: lowSpeedDoc,
        chunkSize: 1,
        preAppendCredit: (chunkIndex) => (chunkIndex % 7 === 0 ? 0.3 : chunkIndex % 5 === 0 ? 0.55 : 1),
        postAppendCredit: (chunkIndex) => (chunkIndex % 3 === 0 ? 1 : 0.4),
        postAppendEvery: 3,
      },
      baseline: lowSpeedBaseline,
    },
    {
      scenario: {
        name: "coverage-low-speed-1-full",
        doc: COVERAGE_DOC,
        chunkSize: 1,
        preAppendCredit: (chunkIndex) => (chunkIndex % 9 === 0 ? 0.25 : chunkIndex % 4 === 0 ? 0.55 : 1),
        postAppendCredit: (chunkIndex) => (chunkIndex % 2 === 0 ? 1 : 0.45),
        postAppendEvery: 2,
      },
      baseline: coverageBaseline,
    },
    {
      scenario: { name: "coverage-steady-37", doc: COVERAGE_DOC, chunkSize: 37, preAppendCredit: () => 1 },
      baseline: coverageBaseline,
    },
    {
      scenario: {
        name: "demo-syntax-every-character",
        doc: SYNTAX_DEMO_DOC,
        chunkSize: 1,
        preAppendCredit: () => 1,
      },
      baseline: syntaxBaseline,
      syntax: SYNTAX_DEMO_REPLAY,
    },
  ];

  for (const chunkSize of [3, 5, 7, 11, 89, 233]) {
    scenarios.push({
      scenario: { name: `coverage-steady-${chunkSize}`, doc: COVERAGE_DOC, chunkSize, preAppendCredit: () => 1 },
      baseline: coverageBaseline,
    });
    scenarios.push({
      scenario: {
        name: `coverage-jitter-${chunkSize}`,
        doc: COVERAGE_DOC,
        chunkSize,
        preAppendCredit: (chunkIndex) => {
          const values = [1, 0.78, 0.52, 0.28, 0.61];
          return values[(chunkIndex + chunkSize) % values.length];
        },
        postAppendCredit: (chunkIndex) => {
          const values = [0.4, 1, 0.55, 0.85];
          return values[(chunkIndex + chunkSize) % values.length];
        },
        postAppendEvery: 2,
      },
      baseline: coverageBaseline,
    });
  }

  for (const entry of scenarios) {
    await runScenario(entry.scenario, entry.baseline, entry.syntax);
  }
}

await runStreamingFidelityMatrixTest();
console.log("streaming fidelity matrix regression test passed");
