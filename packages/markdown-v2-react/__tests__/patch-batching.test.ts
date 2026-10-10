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

  const semanticGroups = splitPatchBatch([lightA, lightB, heavySetProps, lightC, htmlPatch], 2);
  assert.strictEqual(semanticGroups.length, 1, "default semantic patches should stay in one correctness-preserving batch");
  assert.deepStrictEqual(semanticGroups[0], [lightA, lightB, heavySetProps, lightC, htmlPatch], "semantic batch order should be preserved");

  const enrichmentLightA: Patch = { ...lightA, meta: { kind: "enrichment" } };
  const enrichmentLightB: Patch = { ...lightB, meta: { kind: "enrichment" } };
  const enrichmentHeavySetProps: Patch = { ...heavySetProps, meta: { kind: "enrichment" } };
  const enrichmentLightC: Patch = { ...lightC, meta: { kind: "enrichment" } };
  const enrichmentHtmlPatch: Patch = { ...htmlPatch, patchMeta: { kind: "enrichment" } };

  const groups = splitPatchBatch([enrichmentLightA, enrichmentLightB, enrichmentHeavySetProps, enrichmentLightC, enrichmentHtmlPatch], 2);
  assert.strictEqual(groups.length, 4, "enrichment batches should be chunked based on light/heavy operations");
  assert.deepStrictEqual(groups[0], [enrichmentLightA, enrichmentLightB], "first chunk should include light pairs");
  assert.deepStrictEqual(groups[1], [enrichmentHeavySetProps], "heavy setProps should stand alone");
  assert.deepStrictEqual(groups[2], [enrichmentLightC], "light patch following heavy chunk should form its own batch");
  assert.deepStrictEqual(groups[3], [enrichmentHtmlPatch], "setHTML should form its own chunk");
}

runPatchBatchingSuite();
console.log("Patch batching test passed");
