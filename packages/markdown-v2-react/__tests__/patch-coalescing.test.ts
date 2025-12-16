import assert from "node:assert";

import type { Patch } from "@stream-mdx/core";
import { DEFAULT_COALESCE_CONFIG, coalescePatchesLinear, coalescePatchesQuadratic } from "../src/renderer/patch-coalescing";
import { createRendererStore } from "../src/renderer/store";

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

function testStoreEquivalence(): void {
  const original = generateRandomPatches(60);
  const coalesced = coalescePatchesLinear(clonePatches(original));
  const storeOriginal = createRendererStore();
  const storeCoalesced = createRendererStore();
  const touchedOriginal = Array.from(storeOriginal.applyPatches(original)).sort();
  const touchedCoalesced = Array.from(storeCoalesced.applyPatches(coalesced)).sort();
  assert.deepStrictEqual(storeOriginal.getBlocks(), storeCoalesced.getBlocks(), "store state should match when applying original vs coalesced patches");
  assert.deepStrictEqual(touchedOriginal, touchedCoalesced, "affected node lists should match after coalescing");
}

export function runPatchCoalescingTests(): void {
  testConsecutiveAppendLines();
  testAppendLinesStopsAtGap();
  testSetPropsMergesAndBatches();
  testMixedOperationOrder();
  testMaxWindowRespected();
  testFixtureParity();
  testRandomEquivalence();
  testStoreEquivalence();
}

runPatchCoalescingTests();
