import assert from "node:assert";
import { readFile } from "node:fs/promises";

import { STREAM_MDX_SCHEMA_VERSION, type Block, type NodeSnapshot, type Patch, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { coalescePatchesLinear, coalescePatchesQuadratic } from "../src/renderer/patch-coalescing";
import { createRendererStore, type RendererStore } from "../src/renderer/store";

const hasStructuredClone = typeof globalThis.structuredClone === "function";

function deepClone<T>(value: T): T {
  if (hasStructuredClone) {
    return globalThis.structuredClone(value) as T;
  }
  return JSON.parse(JSON.stringify(value));
}

function clonePatches(patches: Patch[]): Patch[] {
  return patches.map((patch) => deepClone(patch));
}

interface ExpectedListItem {
  id: string;
  type: string;
  text: string;
}

function createSeededList(): Block {
  return {
    id: "list-seed",
    type: "list",
    isFinalized: false,
    payload: { raw: "", meta: { ordered: false, items: [] } },
  };
}

function createListItem(id: string, index: number, text: string): NodeSnapshot {
  return {
    id,
    type: "list-item",
    props: {
      index,
      ordered: false,
      inline: [{ kind: "text", text }],
      text,
    },
    children: [],
  };
}

function assertListMeaning(
  store: RendererStore,
  expectedTitle: string | undefined,
  expectedRole: string | undefined,
  expectedChildren: ExpectedListItem[],
): void {
  const root = store.getNode("list-seed");
  assert.ok(root, "expected the seeded list root");
  assert.strictEqual(root.props?.title, expectedTitle, "root title must match authored meaning");
  assert.strictEqual(root.props?.role, expectedRole, "root role must match authored meaning");

  const childIds = store.getChildren("list-seed");
  assert.deepStrictEqual(childIds, expectedChildren.map((child) => child.id), "list children must retain exact IDs and order");
  const children = childIds.map((id) => {
    const child = store.getNode(id);
    assert.ok(child, `expected child record ${id}`);
    return { id: child.id, type: child.type, text: child.props?.text };
  });
  assert.deepStrictEqual(children, expectedChildren, "list child records must retain exact types and text");
}

const coalescers = [
  { name: "linear", coalesce: coalescePatchesLinear },
  { name: "quadratic", coalesce: coalescePatchesQuadratic },
] as const;

function testInsertBarrierPreservesDisjointRootProps(): void {
  const at = { blockId: "list-seed", nodeId: "list-seed" };
  const patches: Patch[] = [
    { op: "setProps", at, props: { title: "must survive" } },
    { op: "insertChild", at, index: 0, node: createListItem("owned-child", 0, "Authored child") },
    { op: "setProps", at, props: { role: "list" } },
  ];
  const expectedChildren: ExpectedListItem[] = [{ id: "owned-child", type: "list-item", text: "Authored child" }];

  for (const { coalesce } of coalescers) {
    const rawStore = createRendererStore([createSeededList()]);
    const coalescedStore = createRendererStore([createSeededList()]);
    const coalesced = coalesce(clonePatches(patches));

    rawStore.applyPatches(clonePatches(patches), { coalesced: true });
    coalescedStore.applyPatches(coalesced, { coalesced: true });

    assertListMeaning(rawStore, "must survive", "list", expectedChildren);
    assertListMeaning(coalescedStore, "must survive", "list", expectedChildren);
  }
}

function testControlledRedundantUpdatesMeetReductionMinimum(): void {
  const at = { blockId: "list-seed", nodeId: "list-seed" };
  const patches: Patch[] = Array.from({ length: 60 }, (_, index) => ({
    op: "setProps",
    at,
    props: { title: `value-${index}` },
  }));

  for (const { name, coalesce } of coalescers) {
    const rawStore = createRendererStore([createSeededList()]);
    const coalescedStore = createRendererStore([createSeededList()]);
    const coalesced = coalesce(clonePatches(patches));
    const removed = patches.length - coalesced.length;

    assert.ok(removed / patches.length >= 0.1, `${name}: controlled redundancy must exceed the existing 10% minimum`);

    rawStore.applyPatches(clonePatches(patches), { coalesced: true });
    coalescedStore.applyPatches(coalesced, { coalesced: true });
    assertListMeaning(rawStore, "value-59", undefined, []);
    assertListMeaning(coalescedStore, "value-59", undefined, []);
  }
}

function testLowRedundancyKeepsEveryConsumerChild(): void {
  const at = { blockId: "list-seed", nodeId: "list-seed" };
  const expectedChildren: ExpectedListItem[] = Array.from({ length: 60 }, (_, index) => ({
    id: `native-child-${index}`,
    type: "list-item",
    text: `Native item ${index}`,
  }));
  const patches: Patch[] = [
    { op: "setProps", at, props: { title: "first" } },
    { op: "setProps", at, props: { title: "last" } },
    ...expectedChildren.map((child, index) => ({
      op: "insertChild" as const,
      at,
      index,
      node: createListItem(child.id, index, child.text),
    })),
  ];

  for (const { coalesce } of coalescers) {
    const rawStore = createRendererStore([createSeededList()]);
    const coalescedStore = createRendererStore([createSeededList()]);
    const coalesced = coalesce(clonePatches(patches));

    rawStore.applyPatches(clonePatches(patches), { coalesced: true });
    coalescedStore.applyPatches(coalesced, { coalesced: true });
    assertListMeaning(rawStore, "last", undefined, expectedChildren);
    assertListMeaning(coalescedStore, "last", undefined, expectedChildren);
  }
}

function assertFixtureMeaning(
  fixtureName: string,
  store: RendererStore,
  expectedBlocks: ReadonlyArray<{ type: string; raw: string }>,
  expectedCodeLines: string[],
  expectedCodeLanguage?: string,
): void {
  const blocks = store.getBlocks();
  assert.deepStrictEqual(
    blocks.map((block) => ({ type: block.type, raw: block.payload.raw })),
    expectedBlocks,
    `${fixtureName}: final block meaning must match authored source`,
  );
  assert.ok(blocks.every((block) => block.isFinalized), `${fixtureName}: finalized blocks must stay finalized`);

  const codeBlocks = blocks.filter((block) => block.type === "code");
  assert.strictEqual(codeBlocks.length, 1, `${fixtureName}: expected one authored code block`);
  const codeBlock = codeBlocks[0];
  assert.ok(codeBlock);
  if (expectedCodeLanguage !== undefined) {
    assert.strictEqual(codeBlock.payload.meta?.lang, expectedCodeLanguage, `${fixtureName}: code language must match source`);
  }

  const codeState = store.getCodeBlock(codeBlock.id);
  assert.ok(codeState, `${fixtureName}: expected an owned code block`);
  const codeLines = store.getCodeLines(codeBlock.id, 0, codeState.source.lineCount);
  assert.deepStrictEqual(
    codeLines.map((line) => line.text),
    expectedCodeLines,
    `${fixtureName}: owned code lines must match authored source`,
  );
}

async function testRealFixtureStreamReplay(): Promise<void> {
  const codeSource = await readFile(new URL("../../../tests/regression/fixtures/code-huge.md", import.meta.url), "utf8");
  const delimiterFile = await readFile(
    new URL("../../../tests/regression/fixtures/delimiter-boundary.md", import.meta.url),
    "utf8",
  );
  // Match regression splitMarkers: remove only markers, preserving adjacent newlines.
  const delimiterChunks = delimiterFile.split("<!--split-->");
  const codeFenceStart = codeSource.indexOf("```js\n");
  const codeBodyStart = codeFenceStart + "```js\n".length;
  const codeFenceEnd = codeSource.lastIndexOf("\n```");
  const codeBody = codeSource.slice(codeBodyStart, codeFenceEnd);
  const fixtures = [
    {
      name: "code-huge.md",
      chunks: Array.from({ length: Math.ceil(codeSource.length / 37) }, (_, index) =>
        codeSource.slice(index * 37, (index + 1) * 37),
      ),
      expectedBlocks: [
        { type: "heading", raw: "# Huge Code Block" },
        { type: "code", raw: codeSource.slice(codeFenceStart, codeFenceEnd + "\n```".length) },
      ],
      expectedCodeLines: codeBody.split("\n"),
      expectedCodeLanguage: "js",
    },
    {
      name: "delimiter-boundary.md",
      chunks: delimiterChunks,
      expectedBlocks: [
        { type: "heading", raw: "### Delimiter Boundary Splitter" },
        { type: "paragraph", raw: "*Italic start" },
        { type: "paragraph", raw: "then end*" },
        { type: "paragraph", raw: "**Bold start" },
        { type: "paragraph", raw: "then end**" },
        { type: "paragraph", raw: "~~Strike start" },
        { type: "paragraph", raw: "then end~~" },
        { type: "paragraph", raw: "`Inline code" },
        { type: "paragraph", raw: "end`" },
        { type: "code", raw: "```\ncode fence\n\nline two\n```" },
        { type: "paragraph", raw: "$" },
        { type: "paragraph", raw: "x + y" },
        { type: "paragraph", raw: "$" },
      ],
      expectedCodeLines: ["code fence", "", "line two"],
      expectedCodeLanguage: undefined,
    },
  ];
  const docPlugins = {
    footnotes: true,
    html: true,
    mdx: true,
    tables: true,
    callouts: true,
    math: true,
  } as const;

  for (const fixture of fixtures) {
    const messages: WorkerOut[] = [];
    const engine = new MarkdownEngine({ post: (message) => messages.push(deepClone(message)) });
    try {
      await engine.handle({
        type: "INIT",
        schemaVersion: STREAM_MDX_SCHEMA_VERSION,
        initialContent: "",
        prewarmLangs: [],
        docPlugins,
      });
      for (const chunk of fixture.chunks) await engine.handle({ type: "APPEND", text: chunk });
      await engine.handle({ type: "FINALIZE" });
    } finally {
      engine.dispose();
    }

    const initialized = messages.find(
      (message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED",
    );
    assert.ok(initialized, `${fixture.name}: engine must emit its initial store state`);
    const patchMessages = messages.filter(
      (message): message is Extract<WorkerOut, { type: "PATCH" }> => message.type === "PATCH",
    );

    const rawStore = createRendererStore();
    rawStore.resetSnapshot(initialized.snapshot);
    const linearStore = createRendererStore();
    linearStore.resetSnapshot(initialized.snapshot);
    const quadraticStore = createRendererStore();
    quadraticStore.resetSnapshot(initialized.snapshot);
    for (const message of patchMessages) {
      const linear = coalescePatchesLinear(clonePatches(message.patches));
      const quadratic = coalescePatchesQuadratic(clonePatches(message.patches));
      rawStore.applyPatches(clonePatches(message.patches), { coalesced: true });
      linearStore.applyPatches(linear, { coalesced: true });
      quadraticStore.applyPatches(quadratic, { coalesced: true });
    }

    for (const [name, store] of [
      ["raw", rawStore],
      ["linear", linearStore],
      ["quadratic", quadraticStore],
    ] as const) {
      assertFixtureMeaning(
        `${fixture.name} (${name})`,
        store,
        fixture.expectedBlocks,
        fixture.expectedCodeLines,
        fixture.expectedCodeLanguage,
      );
    }
    const rawBlocks = rawStore.getBlocks();
    assert.deepStrictEqual(rawBlocks, linearStore.getBlocks(), `${fixture.name}: linear cold blocks differ`);
    assert.deepStrictEqual(rawBlocks, quadraticStore.getBlocks(), `${fixture.name}: quadratic cold blocks differ`);

    const rawCodeBlock = rawBlocks.find((block) => block.type === "code");
    assert.ok(rawCodeBlock, `${fixture.name}: expected an authored code block`);
    const rawCodeState = rawStore.getCodeBlock(rawCodeBlock.id);
    assert.ok(rawCodeState, `${fixture.name}: expected an owned code block`);
    const rawCodeLines = rawStore.getCodeLines(rawCodeBlock.id, 0, rawCodeState.source.lineCount);
    for (const [name, store] of [["linear", linearStore], ["quadratic", quadraticStore]] as const) {
      const codeBlock = store.getBlocks().find((block) => block.type === "code");
      assert.ok(codeBlock, `${fixture.name}: ${name} expected an authored code block`);
      const codeState = store.getCodeBlock(codeBlock.id);
      assert.ok(codeState, `${fixture.name}: ${name} expected an owned code block`);
      assert.deepStrictEqual(
        {
          source: codeState.source,
          configurationRevision: codeState.configurationRevision,
          info: codeState.info,
          language: codeState.language,
          lines: {
            length: codeState.lines.length,
            completeLineCount: codeState.lines.completeLineCount,
            revision: codeState.lines.revision,
          },
        },
        {
          source: rawCodeState.source,
          configurationRevision: rawCodeState.configurationRevision,
          info: rawCodeState.info,
          language: rawCodeState.language,
          lines: {
            length: rawCodeState.lines.length,
            completeLineCount: rawCodeState.lines.completeLineCount,
            revision: rawCodeState.lines.revision,
          },
        },
        `${fixture.name}: ${name} public code state differs`,
      );
      assert.deepStrictEqual(
        store.getCodeLines(codeBlock.id, 0, codeState.source.lineCount),
        rawCodeLines,
        `${fixture.name}: ${name} owned code line records differ`,
      );
    }
  }
}

export function runPatchCoalescingTests(): void {
  testInsertBarrierPreservesDisjointRootProps();
  testControlledRedundantUpdatesMeetReductionMinimum();
  testLowRedundancyKeepsEveryConsumerChild();
}

runPatchCoalescingTests();
await testRealFixtureStreamReplay();
console.log("Patch coalescing consumer tests passed");
