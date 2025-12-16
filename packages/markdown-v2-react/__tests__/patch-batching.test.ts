import assert from "node:assert";
import type { Patch } from "@stream-mdx/core";
import { isHeavyPatch, splitPatchBatch } from "../src/renderer/patch-batching";

function createLightPatch(id: string): Patch {
  return {
    op: "setProps",
    at: { blockId: id, nodeId: id },
    props: { text: `node-${id}` },
  };
}

const heavySetProps: Patch = {
  op: "setProps",
  at: { blockId: "code-1", nodeId: "code-1" },
  props: {
    block: {
      id: "code-1",
      type: "code",
      isFinalized: true,
      payload: { raw: "console.log('hi')" },
    },
  },
};

const htmlPatch: Patch = {
  op: "setHTML",
  at: { blockId: "html-1" },
  html: "<div>hi</div>",
  policy: "test",
};

function runPatchBatchingSuite(): void {
  assert.ok(isHeavyPatch(heavySetProps), "block-level setProps should be treated as heavy");
  assert.ok(isHeavyPatch(htmlPatch), "setHTML patches must always be classified heavy");

  const lightA = createLightPatch("p-1");
  const lightB = createLightPatch("p-2");
  const lightC = createLightPatch("p-3");

  const groups = splitPatchBatch([lightA, lightB, heavySetProps, lightC, htmlPatch], 2);
  assert.strictEqual(groups.length, 4, "mixed batches should be chunked based on light/heavy operations");
  assert.deepStrictEqual(groups[0], [lightA, lightB], "first chunk should include light pairs");
  assert.deepStrictEqual(groups[1], [heavySetProps], "heavy setProps should stand alone");
  assert.deepStrictEqual(groups[2], [lightC], "light patch following heavy chunk should form its own batch");
  assert.deepStrictEqual(groups[3], [htmlPatch], "setHTML should form its own chunk");
}

runPatchBatchingSuite();
console.log("Patch batching test passed");
