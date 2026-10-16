import assert from "node:assert";
import { readFile } from "node:fs/promises";

import type { Block, NodeSnapshot, Patch, WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { DEFAULT_COALESCE_CONFIG, coalescePatchesLinear, coalescePatchesQuadratic } from "../src/renderer/patch-coalescing";
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

function normalizePatches(patches: Patch[]): Patch[] {
  return JSON.parse(JSON.stringify(patches)) as Patch[];
}

function testConsecutiveAppendLines(): void {
  const patches: Patch[] = [
    {
      op: "appendLines",
      at: { blockId: "code-1" },
      startIndex: 0,
      lines: ["line1"],
      highlight: ["<span>line1</span>"],
    },
    {
      op: "appendLines",
      at: { blockId: "code-1" },
      startIndex: 1,
      lines: ["line2"],
    },
    {
      op: "appendLines",
      at: { blockId: "code-1" },
      startIndex: 2,
      lines: ["line3"],
      highlight: ["<span>line3</span>"],
    },
  ];

  const linear = coalescePatchesLinear(clonePatches(patches));
  assert.strictEqual(linear.length, 1, "appendLines run should coalesce to a single patch");
  assert.ok(linear[0].op === "appendLines", "merged code lines must retain their semantic patch type");
  assert.deepStrictEqual(linear[0].lines, ["line1", "line2", "line3"]);
  assert.deepStrictEqual(linear[0].highlight, ["<span>line1</span>", null, "<span>line3</span>"]);

  const quadratic = coalescePatchesQuadratic(clonePatches(patches));
  assert.deepStrictEqual(normalizePatches(linear), normalizePatches(quadratic), "linear implementation must match quadratic output");
}

function testAppendLinesStopsAtGap(): void {
  const patches: Patch[] = [
    {
      op: "appendLines",
      at: { blockId: "code-1" },
      startIndex: 0,
      lines: ["a"],
    },
    {
      op: "setProps",
      at: { blockId: "code-1" },
      props: { foo: "bar" },
    },
    {
      op: "appendLines",
      at: { blockId: "code-1" },
      startIndex: 1,
      lines: ["b"],
    },
  ];

  const linear = coalescePatchesLinear(clonePatches(patches));
  assert.strictEqual(linear.length, 3, "appendLines separated by non-coalesceable patch should not merge");

  const quadratic = coalescePatchesQuadratic(clonePatches(patches));
  assert.deepStrictEqual(normalizePatches(linear), normalizePatches(quadratic));
}

function testSetPropsMergesAndBatches(): void {
  const patches: Patch[] = [
    {
      op: "setProps",
      at: { blockId: "p-1", nodeId: "span-1" },
      props: { bold: true },
    },
    {
      op: "setProps",
      at: { blockId: "p-1", nodeId: "span-1" },
      props: { italic: true },
    },
    {
      op: "setProps",
      at: { blockId: "p-1", nodeId: "span-2" },
      props: { underline: true },
    },
  ];

  const linear = coalescePatchesLinear(clonePatches(patches));
  assert.strictEqual(linear.length, 1, "setProps run should batch into setPropsBatch");
  assert.strictEqual(linear[0].op, "setPropsBatch");

  const quadratic = coalescePatchesQuadratic(clonePatches(patches));
  assert.deepStrictEqual(normalizePatches(linear), normalizePatches(quadratic));
}

function testMixedOperationOrder(): void {
  const patches: Patch[] = [
    {
      op: "appendLines",
      at: { blockId: "code-1" },
      startIndex: 0,
      lines: ["a"],
    },
    {
      op: "finalize",
      at: { blockId: "code-1" },
    },
    {
      op: "appendLines",
      at: { blockId: "code-1" },
      startIndex: 1,
      lines: ["b"],
    },
  ];

  const linear = coalescePatchesLinear(clonePatches(patches));
  assert.strictEqual(linear.length, 3);
  assert.strictEqual(linear[1].op, "finalize", "non-coalesceable operations must stay in order");

  const quadratic = coalescePatchesQuadratic(clonePatches(patches));
  assert.deepStrictEqual(normalizePatches(linear), normalizePatches(quadratic));
}

function testMaxWindowRespected(): void {
  const patches: Patch[] = Array.from({ length: 60 }, (_, idx) => ({
    op: "appendLines" as const,
    at: { blockId: "code-1" },
    startIndex: idx,
    lines: [`line-${idx}`],
  }));

  const config = {
    ...DEFAULT_COALESCE_CONFIG,
    maxCoalesceWindow: 50,
  };

  const linear = coalescePatchesLinear(clonePatches(patches), config);
  const quadratic = coalescePatchesQuadratic(clonePatches(patches), config);

  assert.strictEqual(linear.length, quadratic.length, "linear coalescing must respect window limit");
  assert.deepStrictEqual(normalizePatches(linear), normalizePatches(quadratic));
}

function testFixtureParity(): void {
  const cases: Patch[][] = [
    [
      {
        op: "appendLines",
        at: { blockId: "code-1" },
        startIndex: 0,
        lines: ["one"],
      },
      {
        op: "appendLines",
        at: { blockId: "code-1" },
        startIndex: 1,
        lines: ["two"],
      },
      {
        op: "appendLines",
        at: { blockId: "code-1" },
        startIndex: 2,
        lines: ["three"],
      },
      {
        op: "setProps",
        at: { blockId: "p-1" },
        props: { text: "hello" },
      },
    ],
    [
      {
        op: "setProps",
        at: { blockId: "p-1" },
        props: { text: "one" },
      },
      {
        op: "setProps",
        at: { blockId: "p-1" },
        props: { text: "two" },
      },
      {
        op: "setProps",
        at: { blockId: "p-2" },
        props: { text: "three" },
      },
      {
        op: "setProps",
        at: { blockId: "p-3" },
        props: { text: "four" },
      },
    ],
  ];

  for (const sequence of cases) {
    const linear = coalescePatchesLinear(clonePatches(sequence));
    const quadratic = coalescePatchesQuadratic(clonePatches(sequence));
    assert.deepStrictEqual(normalizePatches(linear), normalizePatches(quadratic), "linear implementation must match quadratic for deterministic fixtures");
  }
}

function generateRandomPatches(count: number): Patch[] {
  const patches: Patch[] = [];
  let nextCodeIndex = 0;
  let listIndex = 0;
  for (let i = 0; i < count; i++) {
    const roll = i % 3;
    if (roll === 0) {
      patches.push({
        op: "appendLines",
        at: { blockId: "code-random" },
        startIndex: nextCodeIndex,
        lines: [`line-${i}`],
      });
      nextCodeIndex += i % 5 === 0 ? 2 : 1;
    } else if (roll === 1) {
      patches.push({
        op: "setProps",
        at: { blockId: `p-${i % 4}`, nodeId: `span-${i % 3}` },
        props: { value: i },
      });
    } else {
      patches.push({
        op: "insertChild",
        at: { blockId: "list-random" },
        index: listIndex,
        node: {
          id: `li-${i}`,
          type: "list-item",
          props: { text: `Item ${i}` },
          children: [],
        },
      });
      listIndex += i % 4 === 0 ? 2 : 1;
    }
  }
  return patches;
}

function testRandomEquivalence(): void {
  for (let i = 0; i < 25; i++) {
    const sequence = generateRandomPatches(30 + i);
    const linear = coalescePatchesLinear(clonePatches(sequence));
    const quadratic = coalescePatchesQuadratic(clonePatches(sequence));
    assert.deepStrictEqual(normalizePatches(linear), normalizePatches(quadratic), `linear vs quadratic mismatch for random sequence ${i}`);
  }
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

  const childIds = store.getChildren(codeBlock.id);
  assert.deepStrictEqual(
    childIds,
    expectedCodeLines.map((_, index) => `${codeBlock.id}::line:${index}`),
    `${fixtureName}: code child IDs and order must match source lines`,
  );
  const children = childIds.map((id) => {
    const child = store.getNode(id);
    assert.ok(child, `${fixtureName}: expected code child ${id}`);
    return { id: child.id, type: child.type, text: child.props?.text };
  });
  assert.deepStrictEqual(
    children,
    expectedCodeLines.map((text, index) => ({ id: `${codeBlock.id}::line:${index}`, type: "code-line", text })),
    `${fixtureName}: code child records must match source lines`,
  );
}

interface ConsumerTree extends NodeSnapshot {
  block?: Block;
  children: ConsumerTree[];
}

function readConsumerTree(store: RendererStore, id: string): ConsumerTree {
  const node = store.getNode(id);
  assert.ok(node, `expected consumer node ${id}`);
  return {
    id: node.id,
    type: node.type,
    meta: node.meta,
    range: node.range,
    props: node.props,
    block: node.block,
    children: store.getChildren(id).map((childId) => readConsumerTree(store, childId)),
  };
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
        { type: "heading", raw: "Huge Code Block" },
        { type: "code", raw: codeSource.slice(codeFenceStart, codeFenceEnd + "\n```".length) },
      ],
      expectedCodeLines: codeBody.split("\n"),
      expectedCodeLanguage: "js",
    },
    {
      name: "delimiter-boundary.md",
      chunks: delimiterChunks,
      expectedBlocks: [
        { type: "heading", raw: "Delimiter Boundary Splitter" },
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

    const rawStore = createRendererStore(initialized.blocks);
    const linearStore = createRendererStore(initialized.blocks);
    const quadraticStore = createRendererStore(initialized.blocks);
    let inputPatchCount = 0;
    let linearPatchCount = 0;
    let quadraticPatchCount = 0;
    for (const message of patchMessages) {
      const linear = coalescePatchesLinear(clonePatches(message.patches));
      const quadratic = coalescePatchesQuadratic(clonePatches(message.patches));
      inputPatchCount += message.patches.length;
      linearPatchCount += linear.length;
      quadraticPatchCount += quadratic.length;
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
    const rawTree = rawStore.getBlocks().map((block) => readConsumerTree(rawStore, block.id));
    for (const [name, store] of [["linear", linearStore], ["quadratic", quadraticStore]] as const) {
      assert.deepStrictEqual(store.getBlocks(), rawStore.getBlocks(), `${fixture.name}: ${name} block semantics differ`);
      assert.deepStrictEqual(
        store.getBlocks().map((block) => readConsumerTree(store, block.id)),
        rawTree,
        `${fixture.name}: ${name} consumer topology or properties differ`,
      );
    }
    console.log(JSON.stringify({ fixture: fixture.name, inputPatchCount, linearPatchCount, quadraticPatchCount }));
  }
}

export function runPatchCoalescingTests(): void {
  testConsecutiveAppendLines();
  testAppendLinesStopsAtGap();
  testSetPropsMergesAndBatches();
  testMixedOperationOrder();
  testMaxWindowRespected();
  testFixtureParity();
  testRandomEquivalence();
  testInsertBarrierPreservesDisjointRootProps();
  testControlledRedundantUpdatesMeetReductionMinimum();
  testLowRedundancyKeepsEveryConsumerChild();
}

runPatchCoalescingTests();
void testRealFixtureStreamReplay().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
